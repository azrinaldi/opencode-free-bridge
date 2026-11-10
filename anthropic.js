"use strict";

const NEWLINE = String.fromCharCode(10);

const INTERNAL_HOST = process.env.HOST && process.env.HOST !== "0.0.0.0" ? process.env.HOST : "127.0.0.1";
const INTERNAL_PORT = parseInt(process.env.PORT || "20129", 10);

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

function toOpenAI(body) {
  const system = systemToString(body.system);
  const messages = messagesToOpenAI(body.messages);
  if (system) messages.unshift({ role: "system", content: system });
  const out = {
    model: body.model,
    messages: messages,
    max_tokens: body.max_tokens,
    stream: false,
  };
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

function sendSse(res, message) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  res.write(
    "event: message_start" + NEWLINE + "data: " +
      JSON.stringify({ type: "message_start", message: Object.assign({}, message, { content: [] }) }) +
      NEWLINE + NEWLINE
  );
  message.content.forEach((block, index) => {
    const blockStart =
      block.type === "tool_use"
        ? { type: "tool_use", id: block.id, name: block.name, input: {} }
        : { type: "text", text: "" };
    res.write(
      "event: content_block_start" + NEWLINE + "data: " +
        JSON.stringify({ type: "content_block_start", index: index, content_block: blockStart }) +
        NEWLINE + NEWLINE
    );
    const delta =
      block.type === "tool_use"
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) }
        : { type: "text_delta", text: block.text || "" };
    res.write(
      "event: content_block_delta" + NEWLINE + "data: " +
        JSON.stringify({ type: "content_block_delta", index: index, delta: delta }) +
        NEWLINE + NEWLINE
    );
    res.write(
      "event: content_block_stop" + NEWLINE + "data: " +
        JSON.stringify({ type: "content_block_stop", index: index }) +
        NEWLINE + NEWLINE
    );
  });
  res.write(
    "event: message_delta" + NEWLINE + "data: " +
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: (message.usage && message.usage.output_tokens) || 0 },
      }) +
      NEWLINE + NEWLINE
  );
  res.write("event: message_stop" + NEWLINE + 'data: {"type":"message_stop"}' + NEWLINE + NEWLINE);
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

  const wantsStream = body.stream === true;
  const openaiBody = toOpenAI(body);

  const headers = { "Content-Type": "application/json" };
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string" && value) headers[name] = value;
  }

  let internalRes;
  try {
    internalRes = await fetch("http://" + INTERNAL_HOST + ":" + INTERNAL_PORT + "/v1/chat/completions", {
      method: "POST",
      headers: headers,
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

  let completion = null;
  try {
    completion = await internalRes.json();
  } catch (e) {
    return sendError(res, 502, "api_error", "Invalid response from the bridge chat route: " + e.message);
  }

  const message = openAIToAnthropic(completion, body.model);
  if (wantsStream) return sendSse(res, message);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  return res.end(JSON.stringify(message));
}

module.exports = {
  handleAnthropicMessages: handleAnthropicMessages,
  toOpenAI: toOpenAI,
  openAIToAnthropic: openAIToAnthropic,
  systemToString: systemToString,
  toolsToOpenAI: toolsToOpenAI,
  messagesToOpenAI: messagesToOpenAI,
  sendSse: sendSse,
};
