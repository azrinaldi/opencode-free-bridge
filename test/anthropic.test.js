"use strict";
// Contract tests for the Anthropic Messages adapter.
//
// These pin the behaviours a PR against this endpoint got wrong: the request
// translation, the tool round-trip, the stop-reason mapping, and — the one that
// matters most — that a streamed reply is forwarded as it arrives instead of
// being buffered and replayed as a single delta at the end.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-anthropic-test-"));
process.env.OPENCODE_BRIDGE_STATE_DIR = tmpDir;

const a = require("../anthropic");

test("system blocks flatten into one system message", () => {
  assert.equal(a.systemToString("plain"), "plain");
  assert.equal(
    a.systemToString([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]),
    "one\ntwo"
  );
  assert.equal(a.systemToString(undefined), undefined);
});

test("tools map input_schema to OpenAI parameters", () => {
  const tools = a.toolsToOpenAI([
    {
      name: "get_weather",
      description: "Get weather",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    },
    { description: "no name, must drop" },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].function.name, "get_weather");
  assert.deepEqual(tools[0].function.parameters.properties.city, { type: "string" });
});

test("tool_use and tool_result round-trip through the OpenAI shape", () => {
  const messages = a.messagesToOpenAI([
    { role: "user", content: "weather in Jakarta?" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Jakarta" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "31C" }],
    },
  ]);
  const assistant = messages.find((m) => m.role === "assistant");
  assert.equal(assistant.tool_calls[0].id, "tu_1");
  assert.equal(assistant.tool_calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { city: "Jakarta" });
  const tool = messages.find((m) => m.role === "tool");
  assert.equal(tool.tool_call_id, "tu_1");
  assert.equal(tool.content, "31C");
});

test("toOpenAI sets stream and asks upstream for usage when streaming", () => {
  const off = a.toOpenAI({ model: "m", messages: [], max_tokens: 8 });
  assert.equal(off.stream, false);
  assert.equal(off.stream_options, undefined);

  const on = a.toOpenAI({ model: "m", messages: [], max_tokens: 8 }, { stream: true });
  assert.equal(on.stream, true);
  // Without include_usage the gateway never sends a final chunk with token
  // counts, so a streamed reply would report zero usage.
  assert.deepEqual(on.stream_options, { include_usage: true });
});

test("stop reasons follow Anthropic's vocabulary", () => {
  assert.equal(a.stopReasonOf("stop", false), "end_turn");
  assert.equal(a.stopReasonOf("length", false), "max_tokens");
  assert.equal(a.stopReasonOf("stop", true), "tool_use");
  assert.equal(a.stopReasonOf("content_filter", false), "refusal");
});

test("a non-streaming completion becomes an Anthropic message", () => {
  const message = a.openAIToAnthropic(
    {
      model: "big-pickle",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "checking",
            tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"Jakarta"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    "big-pickle"
  );
  assert.equal(message.type, "message");
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.usage.input_tokens, 10);
  const tool = message.content.find((b) => b.type === "tool_use");
  assert.deepEqual(tool.input, { city: "Jakarta" });
});

test("count_tokens estimates conservatively instead of returning 404", () => {
  const n = a.estimateInputTokens({
    model: "m",
    system: "x".repeat(400),
    messages: [{ role: "user", content: "y".repeat(400) }],
    tools: [{ name: "t", description: "d".repeat(200), input_schema: { type: "object" } }],
  });
  // 4 chars per token is the conservative heuristic; the exact number is the
  // tokenizer's job, which this bridge does not have.
  assert.ok(n >= 200, `expected at least 200 tokens for ~1000 chars, got ${n}`);
});

// ---------------------------------------------------------------- streaming ---

/** Boot a fake bridge chat route that streams SSE the way the real one does. */
function fakeChatRoute(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => handler(req, res, raw));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("a streamed reply is forwarded as it arrives, not buffered to the end", async () => {
  // The defect this guards: the adapter buffered the whole completion and
  // replayed it as SSE, so every event landed in the same millisecond with one
  // delta. A short delay between chunks makes buffering measurable.
  const { server, port } = await fakeChatRoute(async (req, res, raw) => {
    const body = JSON.parse(raw);
    assert.equal(body.stream, true, "the adapter must ask upstream to stream");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const piece of ["Hel", "lo ", "there"]) {
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`
      );
      await new Promise((r) => setTimeout(r, 120));
    }
    res.write(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });

  const originalPort = process.env.PORT;
  const originalHost = process.env.HOST;
  process.env.PORT = String(port);
  delete process.env.HOST;
  // Re-resolve the module so it picks up the fake port.
  delete require.cache[require.resolve("../anthropic")];
  const adapter = require("../anthropic");

  try {
    const arrivals = [];
    const payload = JSON.stringify({
      model: "big-pickle",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    await new Promise((resolve, reject) => {
      const out = http.createServer((q, s) => adapter.handleAnthropicMessages(q, s));
      out.listen(0, "127.0.0.1", () => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: out.address().port,
            path: "/v1/messages",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res2) => {
            const started = Date.now();
            res2.on("data", (chunk) => {
              for (const line of chunk.toString().split("\n")) {
                if (line.startsWith("event: content_block_delta")) {
                  arrivals.push(Date.now() - started);
                }
              }
            });
            res2.on("end", () => {
              out.close();
              resolve();
            });
          }
        );
        req.on("error", (e) => {
          out.close();
          reject(e);
        });
        req.end(payload);
      });
    });

    // Three deltas, spread over ~360ms of upstream delay. A buffering adapter
    // puts all three in the same millisecond.
    assert.ok(arrivals.length >= 3, `expected >=3 deltas, got ${arrivals.length}`);
    const spread = arrivals[arrivals.length - 1] - arrivals[0];
    assert.ok(spread > 100, `deltas arrived together (spread ${spread}ms) — the reply was buffered`);
  } finally {
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalHost !== undefined) process.env.HOST = originalHost;
    server.close();
    delete require.cache[require.resolve("../anthropic")];
  }
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
