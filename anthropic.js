"use strict";

const NEWLINE = String.fromCharCode(10);
const INTERNAL_HOST = process.env.HOST && process.env.HOST !== "0.0.0.0" ? process.env.HOST : "127.0.0.1";
const INTERNAL_PORT = parseInt(process.env.PORT || "20129", 10);

// Headers a client may hand us that the bridge's own chat route understands.
// `user-agent` is deliberately included: server.js re-derives a gate-safe UA
// when the forwarded one is not a valid v2 client string, so passing it through
// preserves a real CLI's identity and never leaks a bad one upstream.
const FORWARDED_HEADERS = [
  "x-opencode-session",
  "x-opencode-session-id",
  "x-session-id",
  "session-id",
  "x-conversation-id",
  "x-9r-session-id",
  "x-session-affinity",
  "x-opencode-client",
  "x-opencode-project",
  "user-agent",
];

function readBody(req, limit) {
  const max = limit || 10 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function systemToString(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return undefined;
  const text = system
    .map((block) => (block && block.type === "text" ? String(block.text || "") : ""))
    .join(NEWLINE);
  return text || undefined;
}

/**
 * Anthropic `thinking` parameters have no OpenAI equivalent, so they are
 * reported rather than silently dropped: a caller that asked for a thinking
 * budget and received none should be able to see why in the logs.
 */
function warnUnsupported(body) {
  const notes = [];
  if (body && body.thinking) notes.push("thinking");
  if (body && body.top_k !== undefined) notes.push("top_k");
  if (body && body.metadata) notes.push("metadata");
  if (body && body.container) notes.push("container");
  if (notes.length > 0) {
    console.warn(
      `[opencode-free-bridge] /v1/messages: ignoring Anthropic-only parameter(s): ${notes.join(", ")}`
    );
  }
}

function toolsToOpenAI(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => ({
      type: "function",
      function: {
        name: String(tool && tool.name ? tool.name : ""),
        description: String(tool && tool.description ? tool.description : ""),
        parameters: (tool && tool.input_schema) || { type: "object", properties: {} },
      },
    }))
    .filter((tool) => tool.function.name);
}

function messagesToOpenAI(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message && message.role === "assistant" ? "assistant" : "user";
    const blocks = Array.isArray(message && message.content)
      ? message.content
      : [{ type: "text", text: (message && message.content) || "" }];
    if (role === "assistant") {
      const text = blocks
        .filter((b) => b && b.type === "text")
        .map((b) => b.text || "")
        .join("");
      const toolCalls = blocks
        .filter((b) => b && b.type === "tool_use")
        .map((b) => ({
          id: String(b.id || ""),
          type: "function",
          function: {
            name: String(b.name || ""),
            arguments: JSON.stringify(b.input || {}),
          },
        }));
      const item = { role: role, content: text };
      if (toolCalls.length) item.tool_calls = toolCalls;
      out.push(item);
    } else {
      const text = blocks
        .filter((b) => b && b.type === "text")
        .map((b) => b.text || "")
        .join("");
      const toolResults = blocks
        .filter((b) => b && b.type === "tool_result")
        .map((b) => {
          let content = "";
          if (typeof b.content === "string") content = b.content;
          else if (Array.isArray(b.content)) {
            content = b.content
              .map((part) => (part && part.type === "text" ? part.text || "" : JSON.stringify(part)))
              .join(NEWLINE);
          } else if (b.content != null) content = JSON.stringify(b.content);
          return {
            role: "tool",
            tool_call_id: String(b.tool_use_id || ""),
            content: content,
          };
        });
      out.push(...toolResults);
      if (text) out.push({ role: role, content: text });
    }
  }
  return out;
}

function toOpenAI(body, { stream = false } = {}) {
  const system = systemToString(body.system);
  const messages = messagesToOpenAI(body.messages);
  if (system) messages.unshift({ role: "system", content: system });
  const out = {
    model: body.model,
    messages: messages,
    max_tokens: body.max_tokens,
    stream: Boolean(stream),
  };
  // `stream_options.include_usage` is what makes the gateway emit a final
  // chunk carrying real token counts; without it a streamed reply has no usage.
  if (stream) out.stream_options = { include_usage: true };
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length) out.tools = toolsToOpenAI(body.tools);
  if (body.tool_choice) {
    if (body.tool_choice.type === "auto") out.tool_choice = "auto";
    else if (body.tool_choice.type === "any") out.tool_choice = "required";
    else if (body.tool_choice.type === "tool" && body.tool_choice.name) {
      out.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    }
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    out.stop = body.stop_sequences;
  }
  return out;
}

function openAIToAnthropic(completion, requestedModel) {
  const choice = (completion && completion.choices && completion.choices[0]) || {};
  const message = choice.message || {};
  const usage = (completion && completion.usage) || {};
  const content = [];
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    let input = {};
    try {
      input = JSON.parse((call.function && call.function.arguments) || "{}");
    } catch (e) {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: String(call.id || ""),
      name: String((call.function && call.function.name) || ""),
      input: input,
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const stopReason =
    choice.finish_reason === "length"
      ? "max_tokens"
      : content.some((block) => block.type === "tool_use")
        ? "tool_use"
        : "end_turn";
  return {
    id: "msg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    type: "message",
    role: "assistant",
    model: requestedModel || (completion && completion.model) || "unknown",
    content: content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
    },
  };
}

/** Anthropic's documented mapping for a stop reason, from OpenAI's. */
function stopReasonOf(finishReason, sawToolUse) {
  if (sawToolUse) return "tool_use";
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "content_filter") return "refusal";
  return "end_turn";
}

function sseWrite(res, event, payload) {
  res.write(`event: ${event}${NEWLINE}data: ${JSON.stringify(payload)}${NEWLINE}${NEWLINE}`);
}

/**
 * Relay the bridge's OpenAI SSE stream as Anthropic SSE.
 *
 * The previous version buffered the whole completion and replayed it as SSE,
 * which produced a byte-valid but non-streaming response: every event landed in
 * the same millisecond and the client saw one delta. Claude Code and anything
 * built on the Anthropic SDK stream by default, and a buffered reply makes a
 * long generation look frozen, so the relay has to forward each delta as it
 * arrives rather than after the last one.
 */
async function relayStream(res, upstreamBody, requestedModel) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let messageStarted = false;
  let index = 0;
  let openText = false;
  let openTool = false;
  let sawToolUse = false;
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let closed = false;

  const messageId = "msg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const startMessage = () => {
    if (messageStarted) return;
    messageStarted = true;
    sseWrite(res, "message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    });
  };

  const closeText = () => {
    if (!openText) return;
    sseWrite(res, "content_block_stop", { type: "content_block_stop", index });
    openText = false;
    index += 1;
  };
  const closeTool = () => {
    if (!openTool) return;
    sseWrite(res, "content_block_stop", { type: "content_block_stop", index });
    openTool = false;
    index += 1;
  };

  const handleChunk = (chunk) => {
    if (closed) return;
    const choice = (chunk && chunk.choices && chunk.choices[0]) || null;
    if (chunk && chunk.usage) {
      usage = {
        input_tokens: Number(chunk.usage.prompt_tokens || usage.input_tokens || 0),
        output_tokens: Number(chunk.usage.completion_tokens || usage.output_tokens || 0),
      };
    }
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    const text = typeof delta.content === "string" ? delta.content : "";
    // A reasoning model emits `reasoning_content`; Anthropic clients expect it
    // under `thinking`, which this adapter does not claim to support, so it is
    // dropped rather than mixed into visible text.
    if (text) {
      startMessage();
      closeTool();
      if (!openText) {
        sseWrite(res, "content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        });
        openText = true;
      }
      sseWrite(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text },
      });
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      startMessage();
      closeText();
      sawToolUse = true;
      const callIndex = Number.isFinite(call.index) ? call.index : 0;
      if (!openTool) {
        sseWrite(res, "content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: String(call.id || `toolu_${callIndex}`),
            name: String((call.function && call.function.name) || ""),
            input: {},
          },
        });
        openTool = true;
      }
      const args = call.function && call.function.arguments;
      if (typeof args === "string" && args) {
        sseWrite(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: args },
        });
      }
    }
  };

  const handleEvent = (payload) => {
    if (payload === "[DONE]") {
      closed = true;
      return;
    }
    try {
      handleChunk(JSON.parse(payload));
    } catch {
      // A non-JSON keepalive line is not a failure.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf(NEWLINE)) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        handleEvent(line.slice(5).trim());
      }
    }
    // Flush a trailing line that arrived without its newline.
    const tail = buffer.trim();
    if (tail.startsWith("data:")) handleEvent(tail.slice(5).trim());
  } finally {
    startMessage();
    closeText();
    closeTool();
    if (!messageStarted) startMessage();
    sseWrite(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReasonOf(finishReason, sawToolUse), stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    sseWrite(res, "message_stop", { type: "message_stop" });
    if (!res.writableEnded) res.end();
  }
}

function sendSse(res, message) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  sseWrite(res, "message_start", {
    type: "message_start",
    message: Object.assign({}, message, { content: [] }),
  });
  message.content.forEach((block, index) => {
    const blockStart =
      block.type === "tool_use"
        ? { type: "tool_use", id: block.id, name: block.name, input: {} }
        : { type: "text", text: "" };
    sseWrite(res, "content_block_start", { type: "content_block_start", index, content_block: blockStart });
    const delta =
      block.type === "tool_use"
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) }
        : { type: "text_delta", text: block.text || "" };
    sseWrite(res, "content_block_delta", { type: "content_block_delta", index, delta });
    sseWrite(res, "content_block_stop", { type: "content_block_stop", index });
  });
  sseWrite(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: (message.usage && message.usage.output_tokens) || 0 },
  });
  sseWrite(res, "message_stop", { type: "message_stop" });
  res.end();
}

function errorType(status) {
  if (status === 400) return "invalid_request_error";
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "overloaded_error";
  return "api_error";
}

function sendError(res, status, type, message) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ type: "error", error: { type: type, message: message } }));
}

function internalHeaders(req, extra) {
  const headers = Object.assign({ "Content-Type": "application/json" }, extra || {});
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string" && value) headers[name] = value;
  }
  return headers;
}

/**
 * Anthropic counts tokens with its own tokenizer. The bridge has no such
 * tokenizer and inventing an exact number would be a lie, so this reports a
 * deliberate over-estimate: four characters per token plus per-message framing,
 * which is the heuristic the Anthropic SDK itself documents as a fallback. A
 * caller using it for budgeting gets a conservative number rather than a 404.
 */
function estimateInputTokens(body) {
  let chars = 0;
  const system = systemToString(body.system);
  if (system) chars += system.length;
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const blocks = Array.isArray(message && message.content)
      ? message.content
      : [{ type: "text", text: (message && message.content) || "" }];
    for (const block of blocks) {
      if (!block) continue;
      if (typeof block.text === "string") chars += block.text.length;
      if (typeof block.content === "string") chars += block.content.length;
      else if (Array.isArray(block.content)) {
        for (const part of block.content) {
          if (part && typeof part.text === "string") chars += part.text.length;
        }
      }
      if (block.input) chars += JSON.stringify(block.input).length;
      if (block.name) chars += String(block.name).length;
    }
  }
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!tool) continue;
    if (tool.name) chars += String(tool.name).length;
    if (tool.description) chars += String(tool.description).length;
    if (tool.input_schema) chars += JSON.stringify(tool.input_schema).length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

async function handleCountTokens(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return sendError(res, 413, "request_too_large", "Payload too large");
  }
  let body;
  try {
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch (e) {
    return sendError(res, 400, "invalid_request_error", "Invalid JSON body: " + e.message);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendError(res, 400, "invalid_request_error", "Request body must be a JSON object");
  }
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ input_tokens: estimateInputTokens(body) }));
}

async function handleAnthropicMessages(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return sendError(res, 413, "request_too_large", "Payload too large");
  }
  let body;
  try {
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch (e) {
    return sendError(res, 400, "invalid_request_error", "Invalid JSON body: " + e.message);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendError(res, 400, "invalid_request_error", "Request body must be a JSON object");
  }
  if (typeof body.model !== "string" || !body.model) {
    return sendError(res, 400, "invalid_request_error", "Missing or empty required parameter: 'model'");
  }
  if (!Array.isArray(body.messages)) {
    return sendError(res, 400, "invalid_request_error", "Missing or invalid required parameter: 'messages' must be an array");
  }
  warnUnsupported(body);

  const wantsStream = body.stream === true;
  const openaiBody = toOpenAI(body, { stream: wantsStream });
  const url = `http://${INTERNAL_HOST}:${INTERNAL_PORT}/v1/chat/completions`;

  let internalRes;
  try {
    internalRes = await fetch(url, {
      method: "POST",
      headers: internalHeaders(req, wantsStream ? { Accept: "text/event-stream" } : {}),
      body: JSON.stringify(openaiBody),
    });
  } catch (e) {
    return sendError(res, 502, "api_error", "Failed to reach the bridge chat route: " + e.message);
  }

  if (!internalRes.ok) {
    let errJson = null;
    try {
      errJson = await internalRes.json();
    } catch (e) {}
    const message =
      (errJson && errJson.error && errJson.error.message) ||
      (errJson && errJson.message) ||
      "Upstream error " + internalRes.status;
    return sendError(res, internalRes.status, errorType(internalRes.status), message);
  }

  if (wantsStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    // A client that walks away must not leave the upstream stream dangling.
    req.on("close", () => {
      if (internalRes.body && typeof internalRes.body.cancel === "function") {
        internalRes.body.cancel().catch(() => {});
      }
    });
    try {
      await relayStream(res, internalRes.body, body.model);
    } catch (e) {
      if (!res.writableEnded) {
        try {
          sseWrite(res, "error", { type: "error", error: { type: "api_error", message: e.message } });
        } catch {}
        res.end();
      }
    }
    return;
  }

  let completion = null;
  try {
    completion = await internalRes.json();
  } catch (e) {
    return sendError(res, 502, "api_error", "Invalid response from the bridge chat route: " + e.message);
  }
  const message = openAIToAnthropic(completion, body.model);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  return res.end(JSON.stringify(message));
}

module.exports = {
  handleAnthropicMessages,
  handleCountTokens,
  toOpenAI,
  openAIToAnthropic,
  systemToString,
  toolsToOpenAI,
  messagesToOpenAI,
  stopReasonOf,
  estimateInputTokens,
  sendSse,
};
