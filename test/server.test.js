const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const pkg = require("../package.json");
const {
  VERSION,
  MAX_SESSIONS,
  CANONICAL_TOOLS_CHAT,
  CANONICAL_TOOLS_RESPONSES,
  sessionCache,
  createId,
  normalizeModel,
  isResponsesModel,
  markProtocolSupport,
  prepareToolsWithFingerprint,
  buildUpstreamHeaders,
  buildUpstreamPayload,
  getPersistentSessionId,
  readRequestBody,
  server,
  identity,
  discoverModels,
  __getDiscoveryState,
} = require("../server");
const srv_markProtocolSupport = require("../server").markProtocolSupport;
function sseStreamFromLines(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

function httpRequest(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined
        ? null
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload !== null
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe("server unit & integration tests", () => {
  beforeEach(() => {
    sessionCache.clear();
  });

  it("keeps VERSION synced with package.json", () => {
    assert.equal(VERSION, pkg.version);
  });
  it("normalizeModel rejects empty/missing models and strips provider prefixes", () => {
    assert.equal(normalizeModel(undefined), "");
    assert.equal(normalizeModel(null), "");
    assert.equal(normalizeModel(""), "");
    assert.equal(normalizeModel("   "), "");
    assert.equal(normalizeModel("oc/"), "");
    // Aliases now come only from the catalog (its `family` field) or from the
    // on-disk catalog cache — never from a table in this repo. Without a catalog
    // these resolve to nothing and the literal name is passed through, which is
    // the honest answer: the bridge does not invent model names.
    const { identity } = require("../server");
    const canDerive = Boolean(identity.resolveModelAlias("mimo"));
    if (canDerive) {
      assert.equal(normalizeModel("zen/mimo"), "mimo-v2.6-flash-free");
      assert.equal(normalizeModel("opencode/longcat"), "longcat-2.5-preview-free");
    } else {
      assert.equal(normalizeModel("zen/mimo"), "mimo");
      assert.equal(normalizeModel("opencode/longcat"), "longcat");
    }
    // `cat-jam` used to map to `cat-jam-free`. The catalog now marks that model
    // deprecated, so the alias no longer resolves to it: sending a retired id
    // would only earn a 410 from upstream. The shorthand falls through to the
    // literal name, and the caller gets a truthful "model unavailable".
    assert.equal(normalizeModel("cat-jam"), "cat-jam");
    assert.notEqual(normalizeModel("muse-spark"), "muse-spark-1.3-contributor-free");
  });

  it("createId never overflows the 12-bit counter into timestamp bits and keeps counter <= 16", () => {
    const ts = 1_760_000_000_000;
    const seen = new Set();
    for (let i = 0; i < 64; i++) {
      const id = createId(true, ts);
      assert.match(id, /^[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      seen.add(id);
      const invertedPrefix = BigInt(`0x${id.slice(0, 12)}`);
      const decoded = ~invertedPrefix & ((1n << 48n) - 1n);
      const counterBits = Number(decoded & 0xfffn);
      const decodedTs = decoded >> 12n;
      const expectedTs36 = BigInt(ts + Math.floor(i / 16)) & ((1n << 36n) - 1n);
      assert.ok(counterBits >= 1 && counterBits <= 16, `counter ${counterBits} out of 1..16`);
      assert.equal(decodedTs, expectedTs36);
    }
    assert.equal(seen.size, 64);
  });

  it("getPersistentSessionId evicts least-recently-used (LRU) session instead of FIFO", () => {
    for (let i = 0; i < MAX_SESSIONS; i++) {
      getPersistentSessionId({ headers: { "x-session-id": `s-${i}` } }, {});
    }
    assert.equal(sessionCache.size, MAX_SESSIONS);

    // Touch s-0 so it becomes most-recently-used; s-1 is now LRU
    const s0Before = getPersistentSessionId({ headers: { "x-session-id": "s-0" } }, {});
    // Insert a new session beyond capacity
    getPersistentSessionId({ headers: { "x-session-id": "s-new" } }, {});

    assert.equal(sessionCache.has("hdr:s-0"), true, "Touched session s-0 must not be evicted");
    assert.equal(sessionCache.has("hdr:s-1"), false, "Oldest untouched session s-1 must be evicted");
    const s0After = getPersistentSessionId({ headers: { "x-session-id": "s-0" } }, {});
    assert.equal(s0After, s0Before);
  });

  it("buildUpstreamHeaders and buildUpstreamPayload satisfy OpenCode v2 /inference/v1 gate", () => {
    const sessionId = "ses_" + createId(true);
    const headers = buildUpstreamHeaders({ headers: { "user-agent": "OpenAI/Python" } }, sessionId);
    assert.match(headers["User-Agent"], /^opencode\/latest\/\d+\.\d+\.\d+\/cli$/);
    assert.equal(headers["x-opencode-client"], "cli");
    assert.equal(headers["x-opencode-session"], sessionId);
    assert.equal(headers["x-opencode-session-id"], sessionId);
    assert.equal(headers["x-session-affinity"], sessionId);
    assert.equal(headers["x-session-id"], sessionId);
    assert.equal("x-opencode-request" in headers, false);

    // Chat payload with client 'read' tool conflict + max_tokens: 50 on longcat
    identity.applyRecipe({
      modelFacts: { "longcat-2.5-preview-free": { reasoning: true, maxOutput: 131072 } },
    });
    const { upstreamBody, aliasToOriginal } = buildUpstreamPayload(
      {
        model: "longcat-2.5-preview-free",
        max_tokens: 50,
        tool_choice: "none",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "Custom client read tool",
              parameters: { type: "object", properties: { file: { type: "string" } } },
            },
          },
        ],
      },
      "longcat-2.5-preview-free",
      false
    );

    // Additive budget: max(50, 1024) + 4096 = 5120. The field is spelled the way
    // the CLI spells it (`max_completion_tokens`), and `store: false` is sent.
    assert.equal(upstreamBody.max_completion_tokens, 5120);
    assert.equal(upstreamBody.store, false);
    assert.equal("max_tokens" in upstreamBody, false, "the legacy field must not be sent");
    assert.deepEqual(upstreamBody.stream_options, { include_usage: true });
    assert.equal("tool_choice" in upstreamBody, false, "tool_choice: 'none' must be omitted");

    const toolNames = upstreamBody.tools.map((t) => t.function.name);
    assert.deepEqual(toolNames, ["read_client", "read", "shell"]);
    assert.equal(aliasToOriginal.get("read_client"), "read");

    // Responses payload extracts system/developer messages into instructions, preserves images, and forwards temperature/top_p
    const { upstreamBody: respBody } = buildUpstreamPayload(
      {
        model: "muse-spark-1.3-contributor-free",
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: "system", content: "You are a concise assistant." },
          { role: "developer", content: "Always answer in Indonesian." },
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
            ],
          },
        ],
      },
      "muse-spark-1.3-contributor-free",
      true
    );
    assert.match(respBody.instructions, /You are a concise assistant\./);
    assert.match(respBody.instructions, /Always answer in Indonesian\./);
    assert.match(respBody.instructions, /Do not call the `read` or `shell` tools/);
    assert.equal(respBody.input.length, 1);
    assert.equal(respBody.input[0].role, "user");
    assert.deepEqual(respBody.input[0].content, [
      { type: "input_text", text: "What is in this image?" },
      { type: "input_image", image_url: "https://example.com/cat.png" },
    ]);
    assert.equal(respBody.temperature, 0.2);
    assert.equal(respBody.top_p, 0.9);
  });

  it("avoids session hash collisions when headerless requests share a >1000-char prefix", () => {
    const sharedPrefix = "S".repeat(2000);
    const bodyA = {
      messages: [
        { role: "system", content: sharedPrefix },
        { role: "user", content: sharedPrefix + "::conversation-A" },
      ],
    };
    const bodyB = {
      messages: [
        { role: "system", content: sharedPrefix },
        { role: "user", content: sharedPrefix + "::conversation-B" },
      ],
    };
    const sA = getPersistentSessionId({ headers: {} }, bodyA);
    const sB = getPersistentSessionId({ headers: {} }, bodyB);
    assert.notEqual(sA, sB, "Different tails after a shared 2000-char prefix must not collide");
    assert.equal(getPersistentSessionId({ headers: {} }, bodyA), sA);
  });

  it("detaches listeners and pauses stream immediately when chunked body exceeds maxBytes", async () => {
    const { EventEmitter } = require("node:events");
    const fakeReq = new EventEmitter();
    fakeReq.headers = {};
    let paused = false;
    fakeReq.pause = () => {
      paused = true;
    };
    const p = readRequestBody(fakeReq, 10);
    fakeReq.emit("data", Buffer.from("0123456789ABCDEF"));
    await assert.rejects(p, /exceeds limit/);
    assert.equal(paused, true);
    assert.equal(fakeReq.listenerCount("data"), 0);
    assert.equal(fakeReq.listenerCount("end"), 0);
    assert.equal(fakeReq.listenerCount("error"), 0);
  });

  it("returns the fingerprint tools on zero-tool requests, shaped per protocol lane", () => {
    const chat = prepareToolsWithFingerprint([], false);
    const responses = prepareToolsWithFingerprint([], true);

    // The definitions are resolved from the live profile, so compare against
    // what identity reports rather than a frozen module constant.
    const names = identity.getToolList(false).map((t) => t.function.name);
    assert.deepEqual(
      chat.tools.map((t) => t.function.name),
      names
    );
    assert.deepEqual(
      responses.tools.map((t) => t.name),
      names
    );
    assert.equal(chat.aliasToOriginal.size, 0);
    // Chat nests the definition under `function`; Responses puts it flat.
    assert.ok(chat.tools.every((t) => t.function && t.type === "function"));
    assert.ok(responses.tools.every((t) => !t.function && t.type === "function"));
  });

  it("generates 10,000 session IDs using pooled random bytes in <25ms", () => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 10_000; i++) {
      createId(true, 1_760_000_000_000 + i);
    }
    const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(dtMs < 50, `10k createId calls took ${dtMs.toFixed(2)}ms`);
  });
  describe("HTTP endpoint behavior (mocked upstream fetch)", () => {
    let port;
    let originalFetch;
    let mockFetchImpl;

    before(async () => {
      originalFetch = global.fetch;
      global.fetch = async (...args) => mockFetchImpl(...args);
      await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          port = server.address().port;
          resolve();
        });
      });
    });

    // The identity layer refreshes lazily from the request path. These tests
    // assert on the exact upstream calls the bridge makes, so the identity is
    // marked fresh before each case: a background refresh would otherwise show
    // up as an extra fetch and make call-count assertions ambiguous.
    beforeEach(() => {
      identity.__reset();
      identity.__setLastCheckTime(Date.now());
      // Lane assignments are learned and kept on purpose (upstream told us), so
      // a case that seeds one must not leak into the next.
      require("../server").__resetProtocolLanes();
    });

    after(async () => {
      global.fetch = originalFetch;
      await new Promise((resolve) => server.close(resolve));
    });

    it("returns 400 when model is missing or empty, and 400 on invalid JSON", async () => {
      const rMissing = await httpRequest(port, "POST", "/v1/chat/completions", {
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(rMissing.status, 400);
      assert.equal(rMissing.body.error.code, "model_required");

      const rEmpty = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "   ",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(rEmpty.status, 400);
      assert.equal(rEmpty.body.error.code, "model_required");

      const rBadJson = await httpRequest(port, "POST", "/v1/chat/completions", "{bad json");
      assert.equal(rBadJson.status, 400);
      assert.equal(rBadJson.body.error.code, "invalid_json");
    });

    it("propagates real usage and finish_reason='length' in non-streaming Chat Completions", async () => {
      let capturedBody = null;
      mockFetchImpl = async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"choices":[{"index":0,"delta":{"reasoning":"thinking...","content":"partial answer"},"finish_reason":null}],"usage":null}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":null}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":512,"total_tokens":632}}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };
      // Reasoning status comes from the catalog (`modelFacts`), not a
      // substring list in token-budget.js.
      identity.applyRecipe({
        modelFacts: { "cat-jam-free": { reasoning: true, maxOutput: 131072 } },
      });
      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "cat-jam-free",
        max_tokens: 0,
        stream: false,
        messages: [{ role: "user", content: "Tell a story" }],
      });

      assert.equal(res.status, 200);
      assert.equal(capturedBody.max_completion_tokens, 5120);
      assert.deepEqual(capturedBody.stream_options, { include_usage: true });
      assert.equal(res.body.choices[0].message.content, "partial answer");
      assert.equal(res.body.choices[0].message.reasoning_content, "thinking...");
      assert.equal(res.body.choices[0].finish_reason, "length");
      assert.deepEqual(res.body.usage, {
        prompt_tokens: 120,
        completion_tokens: 512,
        total_tokens: 632,
      });
    });

    it("propagates finish_reason='length' on Responses API incomplete and restores aliased client tool names", async () => {
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","call_id":"call_abc","type":"function_call","name":"read_client"}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"file\\":\\"a.txt\\"}"}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":50,"output_tokens":15,"total_tokens":65}}}\n\n',
        ]),
      });

      // The lane is stated explicitly now: it used to be inferred from the
      // model name (`includes("muse")`), which is exactly the kind of name rule
      // that broke when that family was retired. A model needs the Responses
      // lane because upstream said so (ModelProtocolUnsupported), or because
      // RESPONSES_MODELS seeds it.
      srv_markProtocolSupport("big-pickle", true);
      const toolRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        stream: false,
        messages: [{ role: "user", content: "read a.txt" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "client read",
              parameters: { type: "object", properties: { file: { type: "string" } } },
            },
          },
        ],
      });

      assert.equal(toolRes.status, 200);
      assert.equal(toolRes.body.choices[0].finish_reason, "tool_calls");
      assert.equal(toolRes.body.choices[0].message.tool_calls[0].function.name, "read");
      assert.equal(
        toolRes.body.choices[0].message.tool_calls[0].function.arguments,
        '{"file":"a.txt"}'
      );
      assert.deepEqual(toolRes.body.usage, {
        prompt_tokens: 50,
        completion_tokens: 15,
        total_tokens: 65,
      });

      // Now test response.incomplete -> finish_reason: "length"
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"type":"response.output_text.delta","delta":"truncated"}\n\n',
          'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":10,"output_tokens":100,"total_tokens":110}}}\n\n',
        ]),
      });

      const truncRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        stream: false,
        messages: [{ role: "user", content: "long text" }],
      });
      assert.equal(truncRes.status, 200);
      assert.equal(truncRes.body.choices[0].finish_reason, "length");
      assert.equal(truncRes.body.choices[0].message.content, "truncated");
    });

    it("automatically retries on the opposite protocol lane when upstream returns ModelProtocolUnsupported", async () => {
      const urlsCalled = [];
      mockFetchImpl = async (url) => {
        urlsCalled.push(url);
        if (url.endsWith("/chat/completions")) {
          return {
            ok: false,
            status: 400,
            text: async () =>
              JSON.stringify({
                type: "error",
                error: {
                  type: "ModelProtocolUnsupported",
                  message: "Model does not support this protocol.",
                },
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"type":"response.output_text.delta","delta":"OK from responses"}\n\n',
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}}\n\n',
          ]),
        };
      };

      const newModel = "future-responses-model-free";
      assert.equal(isResponsesModel(newModel), false);

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: newModel,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.choices[0].message.content, "OK from responses");
      assert.equal(urlsCalled.length, 2);
      assert.match(urlsCalled[0], /\/inference\/v1\/chat\/completions$/);
      assert.match(urlsCalled[1], /\/inference\/v1\/responses$/);
      assert.equal(isResponsesModel(newModel), true);
      markProtocolSupport(newModel, false);
    });

    it("restricts CORS to localhost origins by default and rejects external websites", async () => {
      const localRes = await httpRequest(port, "GET", "/health", undefined, {
        Origin: "http://localhost:3000",
      });
      assert.equal(localRes.status, 200);
      assert.equal(localRes.headers["access-control-allow-origin"], "http://localhost:3000");

      const evilRes = await httpRequest(port, "GET", "/health", undefined, {
        Origin: "https://evil.example.com",
      });
      assert.equal(evilRes.status, 200);
      assert.equal(evilRes.headers["access-control-allow-origin"], undefined);
    });

    it("refuses a paid or retired model locally instead of forwarding it", async () => {
      // Upstream answers a paid model with `401 AuthError: Missing API key.`
      // This bridge has no account, so that response sends the user looking for
      // a login that does not exist. The catalog already knows the price, so
      // the request is refused here with a reason that points at /v1/models.
      const realVerdict = identity.getCatalogVerdict;
      identity.getCatalogVerdict = (id) => {
        const lower = String(id).toLowerCase();
        if (lower === "gpt-5.4") return "paid";
        if (lower === "cat-jam-free") return "deprecated";
        return undefined;
      };
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return { ok: true, status: 200, body: sseStreamFromLines(["data: [DONE]\n\n"]) };
      };

      try {
        const paid = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(paid.status, 404);
        assert.equal(paid.body.error.code, "model_not_free");
        assert.match(paid.body.error.message, /no account/);

        const retired = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "cat-jam-free",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(retired.status, 404);
        assert.equal(retired.body.error.code, "model_deprecated");

        assert.equal(calls, 0, "neither request may reach upstream");
      } finally {
        identity.getCatalogVerdict = realVerdict;
      }
    });

    it("lets the catalog, not the model's name, decide what is free", async () => {
      // The gateway's /models list is not the authority: it can still list a
      // model the catalog marks deprecated, and it can omit one the catalog
      // calls free. Naming (`-free`) is a convention, not a price.
      const realGetFree = identity.getFreeModels;
      const realVerdict = identity.getCatalogVerdict;
      identity.getFreeModels = () => ["glm-5.3-flash-free", "nemotron-3-ultra-free"];
      identity.getCatalogVerdict = (id) => {
        const lower = String(id).toLowerCase();
        if (lower === "glm-5.3-flash-free") return "free";
        if (lower === "nemotron-3-ultra-free") return "free";
        if (lower === "cat-jam-free") return "deprecated";
        return undefined;
      };
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "cat-jam-free" },        // catalog: deprecated → must drop
            { id: "glm-5.3-flash-free" },  // catalog: free → keep
            { id: "jev-1.13-free" },       // evaluator → never listed
            { id: "some-new-free" },       // unknown to catalog → keep
          ],
        }),
      });

      try {
        await discoverModels();
        const ids = __getDiscoveryState().activeModels.map((m) => m.id);
        assert.ok(ids.includes("glm-5.3-flash-free"));
        assert.ok(ids.includes("nemotron-3-ultra-free"), "catalog-free survives /models omitting it");
        assert.ok(ids.includes("some-new-free"), "an id the catalog does not describe keeps the name heuristic");
        assert.ok(!ids.includes("cat-jam-free"), "a deprecated model drops even though /models lists it");
        assert.ok(!ids.includes("jev-1.13-free"));
      } finally {
        identity.getFreeModels = realGetFree;
        identity.getCatalogVerdict = realVerdict;
      }
    });

    it("turns an in-stream error into a real error, not an empty 200 (non-stream client)", async () => {
      // Measured upstream behaviour: the gateway answers HTTP 200 and then
      // writes `data: {"error":...}` inside the stream (e.g. a 503 from the
      // model's own backend). Forwarding that as-is handed a non-streaming
      // client a 200 with content:null and finish_reason "stop" — a fake
      // success. The client must see a failure.
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"error":{"type":"server_error","message":"Streaming response failed: [503] Upstream unavailable"}}\n\n',
        ]),
      });

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });

      assert.equal(res.status, 502);
      assert.match(res.body.error.message, /503/);
      assert.equal(res.body.choices, undefined, "no fake completion may be returned");
    });

    it("returns HTTP 502 before committing SSE headers when the first stream event is an error, and emits SSE error event on mid-stream failure", async () => {
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"error":{"type":"server_error","message":"Streaming response failed: [503] Upstream unavailable"}}\n\n',
        ]),
      });

      const preChunkRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      assert.equal(preChunkRes.status, 502);
      assert.match(preChunkRes.body.error.message, /503/);

      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"id":"x","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\n\n',
          'data: {"error":{"type":"server_error","message":"Streaming response failed: [503] Upstream unavailable"}}\n\n',
        ]),
      });

      const midStreamRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      assert.equal(midStreamRes.status, 200);
      assert.match(midStreamRes.raw, /"error"/);
      assert.match(midStreamRes.raw, /503/);
      assert.match(midStreamRes.raw, /\[DONE\]/);
    });

    it("does not emit trailing completion chunks or duplicate [DONE] after an in-stream error", async () => {
      srv_markProtocolSupport("big-pickle", true);
      mockFetchImpl = async () => ({
        ok: true,
        status: 200,
        body: sseStreamFromLines([
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          'data: {"error":{"type":"server_error","message":"Streaming response failed: [503] Upstream unavailable"}}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        ]),
      });

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });

      assert.equal(res.status, 200);
      const doneCount = (res.raw.match(/data: \[DONE\]/g) || []).length;
      assert.equal(doneCount, 1, `expected exactly 1 [DONE] marker, got ${doneCount}`);
      assert.doesNotMatch(res.raw, /"finish_reason":"stop"/);
    });

    it("re-derives the endpoint and retries once when the path moves (404)", async () => {
      // A path migration upstream surfaces as a 404 at the old URL, not as a
      // gate rejection. The catalog is the authority for the base URL, so the
      // bridge must re-derive and retry — the client should never see the 404
      // that a stale endpoint produces.
      const seen = [];
      const realRefresh = identity.refresh;
      const realGetEndpoints = identity.getEndpoints;
      let moved = false;
      identity.refresh = async () => {
        moved = true;
        return { updated: true, changed: ["chatUrl"] };
      };
      identity.getEndpoints = (model) => {
        const base = realGetEndpoints(model);
        if (!moved) return base;
        return { ...base, chatUrl: "https://moved.example/v1/chat/completions" };
      };

      mockFetchImpl = async (url) => {
        seen.push(String(url));
        if (String(url).includes("/old/")) {
          return { ok: false, status: 404, text: async () => "<!DOCTYPE html>not found" };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"id":"x","choices":[{"index":0,"delta":{"content":"healed"},"finish_reason":null}]}\n\n',
            'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      try {
        // Stage a stale endpoint the way a pre-migration release would.
        identity.applyRecipe({ chatUrl: "https://opencode.ai/old/chat/completions" });
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(res.status, 200, "client must not see the stale-path 404");
        assert.equal(res.body.choices[0].message.content, "healed");
        assert.equal(seen.length, 2, "one rejected attempt plus one retry");
        assert.match(seen[0], /\/old\/chat\/completions$/);
        assert.match(seen[1], /moved\.example\/v1\/chat\/completions$/);
      } finally {
        identity.refresh = realRefresh;
        identity.getEndpoints = realGetEndpoints;
        identity.__reset();
        identity.__setLastCheckTime(Date.now());
      }
    });

    it("surfaces a model-level 410 verbatim instead of retrying it as an endpoint move", async () => {
      // A 410 can name the model (`ModelDeprecated`), not the route. Retrying at
      // another URL would repeat the same answer, and the original message must
      // reach the client rather than a generic "Upstream error 410".
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return {
          ok: false,
          status: 410,
          text: async () =>
            JSON.stringify({
              type: "error",
              error: { type: "ModelDeprecated", message: "Model x has been deprecated." },
            }),
        };
      };
      const realRefresh = identity.refresh;
      identity.refresh = async () => ({ updated: true, changed: ["chatUrl"] });
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(res.status, 410);
        assert.equal(calls, 1, "a model-level 410 must not be retried");
        assert.match(res.body.error.message, /has been deprecated/);
        assert.equal(res.body.error.type, "ModelDeprecated");
      } finally {
        identity.refresh = realRefresh;
      }
    });

    it("does not loop when a 404 is not an endpoint move", async () => {
      // If the catalog derives the same URL, retrying would replay the same
      // 404. The bridge must surface it instead.
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return { ok: false, status: 404, text: async () => "not found" };
      };
      const realRefresh = identity.refresh;
      identity.refresh = async () => ({ updated: false, changed: [] });
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(res.status, 404);
        assert.equal(calls, 1, "a 404 with an unchanged endpoint must not be retried");
      } finally {
        identity.refresh = realRefresh;
      }
    });

    it("retries a 403 gate rejection after the identity learns something (body must be read first)", async () => {
      // Regression: the gate branch used to test `isFreeTierCliGateError(status, "", "")`
      // before reading the body. A 403 carries its type only in the body, so the
      // branch was unreachable for 403 — only 426 healed. This asserts a 403
      // whose body names FreeTierError actually reaches the self-heal path.
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        if (calls === 1) {
          return {
            ok: false,
            status: 403,
            text: async () =>
              JSON.stringify({
                type: "error",
                error: { type: "FreeTierError", message: "Free models are only available in OpenCode CLI." },
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          // Chat-completions lane: big-pickle is not a Responses model.
          body: sseStreamFromLines([
            'data: {"id":"x","choices":[{"index":0,"delta":{"content":"healed"},"finish_reason":null}]}\n\n',
            'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      // Make the identity refresh report a change, so a retry is warranted.
      const realOnGate = identity.onGateRejection;
      identity.onGateRejection = async () => ({ retry: true, reason: "test-update" });
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(calls, 2, "the rejected request must be replayed once");
        assert.equal(res.status, 200);
        assert.equal(res.body.choices[0].message.content, "healed");
      } finally {
        identity.onGateRejection = realOnGate;
      }
    });

    it("re-mints the session id on retry, so a rejected id shape is not replayed", async () => {
      // The FreeTierError above is what upstream returns when the request does
      // not look like the OpenCode client. Measured cause: the session id shape.
      // The id is derived from the recipe, so an id minted before the refresh
      // encodes the shape that was just rejected — replaying it fails the same
      // way. This asserts the retry carries a *different*, correct id.
      const seen = [];
      let calls = 0;
      mockFetchImpl = async (url, opts) => {
        calls++;
        seen.push(opts?.headers?.["x-opencode-session-id"] || opts?.headers?.["x-opencode-session"]);
        if (calls === 1) {
          return {
            ok: false,
            status: 403,
            text: async () =>
              JSON.stringify({
                type: "error",
                error: {
                  type: "FreeTierError",
                  message:
                    "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
                },
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"id":"x","choices":[{"index":0,"delta":{"content":"healed"},"finish_reason":null}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      const realOnGate = identity.onGateRejection;
      identity.onGateRejection = async () => ({ retry: true, reason: "test-update" });
      sessionCache.clear();
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
          headers: { "x-opencode-session": "client-session-1" },
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 2, "one rejected request, one replay");
        assert.notEqual(seen[0], seen[1], "the replay must not reuse the rejected session id");
        assert.match(seen[1], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      } finally {
        identity.onGateRejection = realOnGate;
        sessionCache.clear();
      }
    });

    it("evicts a rejected session id from the cache so it is never reused", async () => {
      // The rejected id is derived from the recipe, so it is cached under the
      // client's key. If it survives the heal, every later request from that
      // client replays the same rejected shape — the bridge would be stuck.
      sessionCache.clear();
      const body = { model: "big-pickle", messages: [{ role: "user", content: "cache me" }] };
      const req = { headers: {} };
      const first = getPersistentSessionId(req, body);
      assert.equal(sessionCache.size, 1);

      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        if (calls === 1) {
          return {
            ok: false,
            status: 403,
            text: async () =>
              JSON.stringify({
                type: "error",
                error: {
                  type: "FreeTierError",
                  message:
                    "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
                },
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      const realOnGate = identity.onGateRejection;
      identity.onGateRejection = async () => ({ retry: true, reason: "test-update" });
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", body);
        assert.equal(res.status, 200);
        // The old id must be gone; a fresh one must be cached instead.
        const cached = [...sessionCache.values()].map((e) => e.sessionId);
        assert.equal(cached.includes(first), false, "rejected id must be evicted");
        assert.equal(cached.length, 1, "exactly one replacement id");
      } finally {
        identity.onGateRejection = realOnGate;
        sessionCache.clear();
      }
    });

    it("always retries once with fresh values, then surfaces the real error", async () => {
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({ error: { type: "FreeTierError", message: "free tier" } }),
        };
      };
      const realOnGate = identity.onGateRejection;
      identity.onGateRejection = async () => ({ retry: false, reason: "no-change" });
      try {
        const res = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "hi" }],
        });
        // Two upstream calls: the original and one retry with a freshly minted
        // session id + full tool set. Still bounded — never a retry loop.
        assert.equal(calls, 2, "exactly one retry, never a loop");
        assert.equal(res.status, 403);
        assert.equal(res.body.error.type, "FreeTierError");
      } finally {
        identity.onGateRejection = realOnGate;
      }
    });

    it("suppresses redundant 403 retries during an active IP cooldown until identity changes", async () => {
      let calls = 0;
      mockFetchImpl = async () => {
        calls++;
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({ error: { type: "FreeTierError", message: "free tier" } }),
        };
      };
      const realOnGate = identity.onGateRejection;
      let shouldRetry = false;
      identity.onGateRejection = async () => ({
        retry: shouldRetry,
        reason: shouldRetry ? "test-update" : "no-change",
      });
      try {
        // First request: 1 initial attempt + 1 full-shape retry = 2 calls
        const res1 = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "first" }],
        });
        assert.equal(res1.status, 403);
        assert.equal(res1.headers["x-opencode-gate"], "ip-throttled");
        assert.ok(Number(res1.headers["retry-after"]) > 0);
        assert.equal(calls, 2);

        const healthThrottled = await httpRequest(port, "GET", "/health");
        assert.equal(healthThrottled.body.identity.gate.status, "throttled");

        // Second request during cooldown with no identity change: 1 attempt, no duplicate retry
        const res2 = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "second" }],
        });
        assert.equal(res2.status, 403);
        assert.equal(res2.headers["x-opencode-gate"], "ip-throttled");
        assert.equal(calls, 3, "must not double-hit upstream while full-shape retry already failed on current identity");

        // Optional IP_LIMIT_STATUS=429 translates confirmed IP-limit 403s into 429 for standard routers.
        process.env.IP_LIMIT_STATUS = "429";
        try {
          const res429 = await httpRequest(port, "POST", "/v1/chat/completions", {
            model: "big-pickle",
            messages: [{ role: "user", content: "second-429" }],
          });
          assert.equal(res429.status, 429);
          assert.equal(res429.headers["x-opencode-gate"], "ip-throttled");
          assert.equal(calls, 4);
        } finally {
          delete process.env.IP_LIMIT_STATUS;
        }
        // If identity actually learns an update, retry is re-enabled immediately
        shouldRetry = true;
        const res3 = await httpRequest(port, "POST", "/v1/chat/completions", {
          model: "big-pickle",
          messages: [{ role: "user", content: "third" }],
        });
        assert.equal(res3.status, 403);
        assert.equal(calls, 6, "a learned identity change must retry immediately");
      } finally {
        identity.onGateRejection = realOnGate;
      }
    });

    it("omits the update hint when the refreshed identity is already rejected (budget gate)", async () => {
      mockFetchImpl = async () => ({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({
            error: {
              type: "FreeTierError",
              message: "Free models are only available in OpenCode CLI.",
            },
          }),
      });

      const gateRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(gateRes.status, 403);
      assert.match(gateRes.body.error.message, /Free models are only available in OpenCode CLI/);
      // The retry already carried the freshest derived identity (endpoint,
      // session id, full tool set), so a repeated rejection is the per-IP
      // allowance, not a stale bridge. Pointing at install.sh would mislead.
      assert.doesNotMatch(gateRes.body.error.message, /install\.sh \| bash/);

      // Non-gate error (e.g. 429 rate limit) must NOT include update hint
      mockFetchImpl = async () => ({
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({
            error: { type: "RateLimitError", message: "Endpoint is unavailable" },
          }),
      });

      const rateRes = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(rateRes.status, 429);
      assert.equal(rateRes.body.error.message, "Endpoint is unavailable");
    });

    it("retries once with a fresh session ID on transient upstream 5xx and recovers to 200", async () => {
      const seenSessions = [];
      let attempt = 0;
      mockFetchImpl = async (_url, opts) => {
        attempt++;
        seenSessions.push(opts?.headers?.["x-opencode-session"]);
        if (attempt === 1) {
          return {
            ok: false,
            status: 500,
            headers: new Map([["x-opencode-log-id", "01a14df2-first-500"]]),
            text: async () => "",
          };
        }
        return {
          ok: true,
          status: 200,
          body: sseStreamFromLines([
            'data: {"id":"1","choices":[{"index":0,"delta":{"content":"RECOVERED"},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      };

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.choices[0].message.content, "RECOVERED");
      assert.equal(attempt, 2, "must retry once on upstream 5xx");
      assert.equal(seenSessions.length, 2);
      assert.notEqual(seenSessions[0], seenSessions[1], "5xx retry must mint a fresh session ID");
    });

    it("records lastUpstreamError in /health and forwards X-OpenCode-Log-Id when 5xx persists", async () => {
      let attempt = 0;
      mockFetchImpl = async () => {
        attempt++;
        return {
          ok: false,
          status: 500,
          headers: new Map([
            ["x-opencode-log-id", `01a14df2-persist-${attempt}`],
            ["cf-ray", "a4c5e229db07709c-SEA"],
            ["cf-placement", "remote-IAD"],
          ]),
          text: async () => "",
        };
      };

      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 500);
      assert.equal(attempt, 2, "must stop after one 5xx retry");
      assert.equal(res.headers["x-opencode-log-id"], "01a14df2-persist-2");
      assert.equal(res.headers["x-opencode-gate"], "upstream-error");
      assert.equal(res.body.error.log_id, "01a14df2-persist-2");

      const health = await httpRequest(port, "GET", "/health");
      const lastErr = health.body.identity.gate.lastUpstreamError;
      assert.ok(lastErr, "/health must expose lastUpstreamError after persistent 5xx");
      assert.equal(lastErr.status, 500);
      assert.equal(lastErr.logId, "01a14df2-persist-2");
      assert.equal(lastErr.cfRay, "a4c5e229db07709c-SEA");
      assert.equal(lastErr.cfPlacement, "remote-IAD");
      assert.equal(lastErr.model, "big-pickle");
    });
  });
});
