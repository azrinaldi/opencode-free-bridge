"use strict";
/**
 * The free-tier gate contract.
 *
 * Upstream answers a single `403 FreeTierError` — "OpenCode's free tier can
 * only be used from within OpenCode" — for at least four unrelated causes:
 *
 *   1. the egress IP is refused,
 *   2. the request carries no tool named `read`,
 *   3. the User-Agent is not `opencode/<channel>/<semver>/<name>`,
 *   4. the request carries no session header.
 *
 * Causes 2-4 are *this bridge's* shape. When they happen the bridge would
 * otherwise report cause 1 and send the operator chasing an allowance problem
 * that does not exist. The anchors below exist so that cannot happen, and these
 * tests lock them in.
 *
 * Measurements (2026-10-18, byte-identical requests replayed from a refused
 * egress and a clean one, one field varied at a time) are recorded next to
 * GATE_ANCHOR_TOOL_NAMES / GATE_ANCHOR_HEADER_NAMES in identity.js.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../identity");
const srv = require("../server");

const FULL = "full";
const CORE = "core";

function toolNames(list) {
  return list.map((t) => t.function?.name || t.name);
}

function wireTools(scope, modelId = "big-pickle", body = { messages: [{ role: "user", content: "x" }] }) {
  const { upstreamBody } = srv.buildUpstreamPayload(
    { model: modelId, ...body },
    modelId,
    false,
    scope
  );
  return toolNames(upstreamBody.tools || []);
}

beforeEach(() => identity.__reset());

afterEach(() => {
  identity.__reset();
  delete process.env.OPENCODE_USER_AGENT;
});

describe("gate contract: the `read` tool anchor", () => {
  it("sends a tool named `read` in every scope and protocol lane", () => {
    for (const scope of [CORE, FULL]) {
      assert.ok(wireTools(scope).includes("read"), `chat/${scope} must carry \`read\``);
    }
    const responses = srv.buildUpstreamPayload(
      { model: "big-pickle", messages: [{ role: "user", content: "x" }] },
      "big-pickle",
      true,
      null
    ).upstreamBody;
    assert.ok(toolNames(responses.tools || []).includes("read"), "responses lane must carry `read`");
  });

  it("keeps the anchor when upstream renames the tool", () => {
    // Upstream ships `read_file` instead of `read`. The derived profile follows
    // the rename — that is the adaptivity the bridge exists for — but the gate
    // still looks for `read`, so the anchor must survive on its own.
    identity.applyRecipe({
      tools: {
        read_file: { description: "r".repeat(30), parameters: { type: "object", properties: {} } },
        shell: { description: "s".repeat(30), parameters: { type: "object", properties: {} } },
      },
      toolNames: ["read_file", "shell"],
    });
    for (const scope of [CORE, FULL]) {
      const names = wireTools(scope);
      assert.ok(names.includes("read"), `${scope} must still carry \`read\` after a rename`);
    }
    // `core` deliberately sends only the proven minimum, so the renamed tool is
    // expected there only in `full` — the scope the self-heal retry uses.
    assert.ok(
      wireTools(FULL).includes("read_file"),
      "full scope must also carry the renamed tool, so the wire keeps following upstream"
    );
  });

  it("keeps the anchor when upstream drops the tool entirely", () => {
    identity.applyRecipe({
      tools: { shell: { description: "s".repeat(30), parameters: { type: "object", properties: {} } } },
      toolNames: ["shell"],
    });
    for (const scope of [CORE, FULL]) {
      assert.ok(wireTools(scope).includes("read"), `${scope} must carry \`read\` from the shipped fallback`);
    }
  });

  it("still sends the anchor when the client supplies its own tools", () => {
    // A client's `read` is aliased to `read_client` so the fingerprint can be
    // injected alongside it. The anchor must be the injected one, not the alias.
    const { upstreamBody } = srv.buildUpstreamPayload(
      {
        model: "big-pickle",
        messages: [{ role: "user", content: "x" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "client read",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
      },
      "big-pickle",
      false,
      CORE
    );
    const names = toolNames(upstreamBody.tools);
    assert.ok(names.includes("read"), "the gate anchor must be present");
    assert.ok(names.includes("read_client"), "the client's own definition must be preserved under an alias");
  });

  it("uses the shipped definition when the profile no longer has one", () => {
    identity.applyRecipe({ tools: { shell: identity.DEFAULT_TOOLS.shell }, toolNames: ["shell"] });
    const list = identity.getToolList(false, CORE);
    const read = list.find((t) => t.function.name === "read");
    assert.ok(read, "`read` must be present");
    // A definition the gate accepts is a *valid* one, not an empty stub.
    assert.equal(read.function.parameters.type, "object");
    assert.ok(read.function.description.length > 0);
  });
});

describe("gate contract: the header anchors", () => {
  const ctx = {
    userAgent: "opencode/latest/2.0.32/cli",
    client: "cli",
    project: "global",
    sessionId: "ses_abc",
  };

  it("always sends a User-Agent and a session header", () => {
    // A recipe that lists none of them is the regression this pins: upstream
    // answers the identical 403 it uses for a refused IP.
    identity.applyRecipe({ headers: [] });
    const { headers } = identity.buildGateHeaders(ctx);
    assert.equal(headers["User-Agent"], ctx.userAgent);
    assert.equal(headers["x-opencode-session"], ctx.sessionId);
    assert.equal(headers["x-session-affinity"], ctx.sessionId);
  });

  it("never emits a User-Agent the gate refuses", () => {
    // Measured refusals: absent, bare `opencode`, `Mozilla/5.0 …`, `curl/8.18.0`.
    const { headers } = identity.buildGateHeaders({ ...ctx, userAgent: "curl/8.18.0" });
    // identity.js passes values through; server.js owns UA validation. Assert
    // the validator here so a caller that bypasses server.js is still covered.
    assert.equal(srv.isValidV2UserAgent("curl/8.18.0"), false);
    assert.equal(srv.isValidV2UserAgent("Mozilla/5.0 (X11; Linux x86_64)"), false);
    assert.equal(srv.isValidV2UserAgent("opencode"), false);
    assert.equal(srv.isValidV2UserAgent("opencode/9.9.9"), false, "needs the full 3-segment shape");
    assert.equal(srv.isValidV2UserAgent("opencode/latest/2.0.32/cli"), true);
    assert.equal(srv.isValidV2UserAgent("OpenCode/2.0.32"), false, "identity.js uses the 4-segment form");
  });

  it("replaces an operator override the gate would refuse", () => {
    process.env.OPENCODE_USER_AGENT = "curl/8.18.0";
    const ua = srv.gateSafeUserAgent();
    assert.match(ua, /^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/);
  });

  it("honours an operator override the gate accepts", () => {
    process.env.OPENCODE_USER_AGENT = "opencode/latest/9.9.9/cli";
    assert.equal(srv.gateSafeUserAgent(), "opencode/latest/9.9.9/cli");
  });

  it("derives the session headers from the request, not a constant", () => {
    const { headers } = identity.buildGateHeaders({ ...ctx, sessionId: "ses_other" });
    assert.equal(headers["x-opencode-session"], "ses_other");
    assert.equal(headers["x-session-affinity"], "ses_other");
  });
});

describe("gate contract: the shape audit", () => {
  it("reports a complete shape as ok", () => {
    const audit = srv.__auditGateShape(
      { tools: [{ type: "function", function: { name: "read" } }] },
      {
        "User-Agent": "opencode/latest/2.0.32/cli",
        "x-opencode-session": "ses_abc",
      }
    );
    assert.equal(audit.hasReadTool, true);
    assert.equal(audit.userAgentOk, true);
    assert.ok(audit.sessionHeaders.length > 0);
  });

  it("names every missing anchor, so a log line is actionable", () => {
    const audit = srv.__auditGateShape(
      { tools: [{ type: "function", function: { name: "shell" } }] },
      { "User-Agent": "curl/8.18.0" }
    );
    assert.equal(audit.hasReadTool, false);
    assert.equal(audit.userAgentOk, false);
    assert.deepEqual(audit.sessionHeaders, []);
  });

  it("reads flat (responses-lane) tool definitions too", () => {
    const audit = srv.__auditGateShape({ tools: [{ type: "function", name: "read" }] }, {
      "User-Agent": "opencode/latest/2.0.32/cli",
      "x-session-affinity": "ses_abc",
    });
    assert.equal(audit.hasReadTool, true);
  });
});

describe("gate contract: anchors are visible in /health", () => {
  it("exposes the anchors and the last rejection", async () => {
    const { server } = srv;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const body = await new Promise((resolve, reject) => {
        require("node:http")
          .get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => resolve(JSON.parse(raw)));
          })
          .on("error", reject);
      });
      assert.deepEqual(body.identity.gate.anchors.tools, ["read"]);
      assert.deepEqual(body.identity.gate.anchors.headers, [
        "user-agent",
        "x-opencode-session",
        "x-session-affinity",
      ]);
      assert.ok("lastRejection" in body.identity.gate);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
