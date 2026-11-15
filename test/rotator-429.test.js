const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { server, identity } = require("../server");
const rotator = require("../rotator");
const proxy = require("../proxy");

function httpRequest(port, method, path_, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: path_,
        method,
        headers: {
          ...(payload !== null
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
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

const enc = new TextEncoder();
function sse(lines) {
  return new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); } });
}
const OK_SSE = [
  'data: {"id":"1","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":null}\n\n',
  "data: [DONE]\n\n",
];

describe("429 → egress rotation → retry (server flow)", () => {
  let port;
  let originalFetch;
  let mockFetchImpl;
  let stateDir;
  const prevEnv = {};

  before(async () => {
    originalFetch = global.fetch;
    global.fetch = async (...args) => mockFetchImpl(...args);
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-rot429-"));
    for (const key of ["OPENCODE_BRIDGE_STATE_DIR", "WARP_ROTATE_CMD", "WARP_ROTATE_TIMEOUT_MS", "WARP_ROTATE_COOLDOWN_MS", "UPSTREAM_PROXY_POOL", "UPSTREAM_PROXY_URL"]) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OPENCODE_BRIDGE_STATE_DIR = stateDir;
    proxy.__reload();
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  beforeEach(() => {
    identity.__reset();
    identity.__setLastCheckTime(Date.now());
    // stateDir is already the process-wide OPENCODE_BRIDGE_STATE_DIR (set in
    // before()), so this unlink targets the temp dir — never the operator's
    // real ~/.opencode-free-bridge. Guarded assert to keep that invariant
    // obvious: if someone reorders `before`, this fails loudly, not silently.
    if (!process.env.OPENCODE_BRIDGE_STATE_DIR || process.env.OPENCODE_BRIDGE_STATE_DIR !== stateDir) {
      throw new Error("OPENCODE_BRIDGE_STATE_DIR must point at the temp stateDir before rotator.__reset");
    }
    rotator.__reset({ keepConfig: false });
    rotator.__setProbeIntervalMs(1);
    try { fs.unlinkSync(path.join(stateDir, "rotator.json")); } catch {}
  });

  after(async () => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    proxy.__reload();
    await new Promise((resolve) => server.close(resolve));
  });

  const UP429 = () => ({
    ok: false,
    status: 429,
    headers: new Map([["retry-after", "600"]]),
    text: async () => JSON.stringify({ error: { type: "FreeUsageLimitError", message: "quota spent" } }),
  });

  const UP429_CAPACITY = () => ({
    ok: false,
    status: 429,
    headers: new Map([["retry-after", "3"]]),
    text: async () =>
      JSON.stringify({ error: { type: "RateLimitError", message: "Endpoint is unavailable" } }),
  });

  it("does not rotate on a model-capacity 429 (RateLimitError) — only quota 429s hop", async () => {
    // Upstream answers two different failures with the same status: the per-IP
    // free-allowance (FreeUsageLimitError — an IP hop genuinely helps) and a
    // single model's capacity pressure ("Endpoint is unavailable" — no IP can
    // make a busy model less busy, so a hop would only spend tunnel churn).
    let calls = 0;
    mockFetchImpl = async () => {
      calls++;
      return UP429_CAPACITY();
    };
    let rotations = 0;
    const res = await httpRequest(port, "POST", "/v1/chat/completions", {
      model: "big-pickle",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 429);
    assert.match(res.body.error.message, /Endpoint is unavailable/);
    assert.equal(res.body.error.type, "RateLimitError", "model-capacity kind passes through verbatim");
    assert.equal(calls, 1, "no retry attempt after a capacity 429");
    assert.equal(rotator.describe().history.filter((h) => h.trigger === "429").length, 0, "rotator never even tried");
  });

  it("passes 429 through untouched when the rotator is disabled", async () => {
    let calls = 0;
    mockFetchImpl = async () => { calls++; return UP429(); };
    const res = await httpRequest(port, "POST", "/v1/chat/completions", {
      model: "big-pickle",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers["retry-after"], "600");
    assert.equal(calls, 1, "no rotation, no retry");
    assert.equal(rotator.describe().rotations, 0);
  });

  it("rotates once on 429 and returns the retry's 200 to the client", async () => {
    const flag = path.join(stateDir, "hopped");
    try { fs.unlinkSync(flag); } catch {}
    fs.writeFileSync(
      path.join(stateDir, "rotator.json"),
      JSON.stringify({
        command: process.platform === "win32" ? `cmd /c type nul > "${flag}"` : `touch "${flag}"`,
        timeoutMs: 10000,
        cooldownMs: 1000,
      })
    );
    let upstreamCalls = 0;
    mockFetchImpl = async () => {
      upstreamCalls++;
      if (upstreamCalls === 1) return UP429();
      return { ok: true, status: 200, body: sse(OK_SSE) };
    };
    // The probe reads the flag: the IP only changes once the command ran.
    rotator.__setProbeImpl(async () => ({
      ip: fs.existsSync(flag) ? "203.0.113.7" : "203.0.113.5",
      error: null,
    }));

    const res = await httpRequest(port, "POST", "/v1/chat/completions", {
      model: "big-pickle",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(res.status, 200);
    assert.match(res.raw, /\[DONE\]/);
    assert.equal(upstreamCalls, 2, "initial 429 + one retry after rotation");
    const desc = rotator.describe();
    assert.equal(desc.rotations, 1);
    assert.equal(desc.lastResult.ok, true);
    assert.equal(desc.lastResult.toIp, "203.0.113.7");
    rotator.__setProbeImpl(null);
  });

  it("answers the original 429 with its Retry-After when rotation never changes the IP", async () => {
    fs.writeFileSync(
      path.join(stateDir, "rotator.json"),
      JSON.stringify({ command: "noop", timeoutMs: 3000, cooldownMs: 1000 })
    );
    let upstreamCalls = 0;
    mockFetchImpl = async () => { upstreamCalls++; return UP429(); };
    rotator.__setProbeImpl(async () => ({ ip: "203.0.113.9", error: null }));

    const res = await httpRequest(port, "POST", "/v1/chat/completions", {
      model: "big-pickle",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers["retry-after"], "600", "the truthful Retry-After survives");
    assert.equal(upstreamCalls, 1, "no retry without a changed IP");
    rotator.__setProbeImpl(null);
  });

  it("does not rotate when a multi-entry pool is active (pool walk owns failover)", async () => {
    fs.writeFileSync(
      path.join(stateDir, "rotator.json"),
      JSON.stringify({ command: "noop", timeoutMs: 3000, cooldownMs: 1000 })
    );
    const saved = proxy.setPool({
      entries: ["http://first:1", "http://second:2"],
      strategy: "failover",
      cooldownMs: 60000,
    });
    assert.equal(saved.ok, true);
    proxy.resetHealth();
    let upstreamCalls = 0;
    const usedEgress = [];
    mockFetchImpl = async (_url, init) => {
      upstreamCalls++;
      const egress = init?.proxy || "direct";
      usedEgress.push(egress);
      if (egress === "http://first:1") return UP429();
      return { ok: true, status: 200, body: sse(OK_SSE) };
    };
    try {
      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);
      assert.deepEqual(usedEgress, ["http://first:1", "http://second:2"]);
      assert.equal(rotator.describe().rotations, 0, "pool walk served it; rotator untouched");
    } finally {
      proxy.setPool({ entries: [] });
      proxy.resetHealth();
    }
  });

  it("GET /api/rotator reports status, POST configures, command is never echoed", async () => {
    const get0 = await httpRequest(port, "GET", "/api/rotator");
    assert.equal(get0.status, 200);
    assert.equal(typeof get0.body.enabled, "boolean");
    assert.equal("command" in get0.body, false);

    const set = await httpRequest(port, "POST", "/api/rotator", { command: "hop.cmd" });
    assert.equal(set.status, 200);
    assert.equal(set.body.enabled, true);

    const get1 = await httpRequest(port, "GET", "/api/rotator");
    assert.equal(get1.body.commandConfigured, true);
    assert.equal("command" in get1.body, false);

    const health = await httpRequest(port, "GET", "/health");
    assert.ok(health.body.egress.rotator, "health exposes rotator status");
  });

  it("POST /api/rotator rotate:true triggers a real rotation and reports both IPs", async () => {
    const flag = path.join(stateDir, "hopped2");
    try { fs.unlinkSync(flag); } catch {}
    fs.writeFileSync(
      path.join(stateDir, "rotator.json"),
      JSON.stringify({
        command: process.platform === "win32" ? `cmd /c type nul > "${flag}"` : `touch "${flag}"`,
        timeoutMs: 10000,
        cooldownMs: 1000,
      })
    );
    rotator.__setProbeImpl(async () => ({
      ip: fs.existsSync(flag) ? "198.51.100.7" : "198.51.100.1",
      error: null,
    }));
    const res = await httpRequest(port, "POST", "/api/rotator", { rotate: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.toIp, "198.51.100.7");
    rotator.__setProbeImpl(null);
  });

  it("successful rotation clears the egress cooldown so the retry leaves", async () => {
    const flag = path.join(stateDir, "hopped3");
    try { fs.unlinkSync(flag); } catch {}
    fs.writeFileSync(
      path.join(stateDir, "rotator.json"),
      JSON.stringify({
        command: process.platform === "win32" ? `cmd /c type nul > "${flag}"` : `touch "${flag}"`,
        timeoutMs: 10000,
        cooldownMs: 1000,
      })
    );
    // Park the direct entry first: a rotation must clear it, or the retry
    // would be starved by pick().
    proxy.markFailure(null, { reason: "allowance 429", cooldownMs: 60000 });

    let upstreamCalls = 0;
    mockFetchImpl = async () => {
      upstreamCalls++;
      if (upstreamCalls === 1) return UP429();
      return { ok: true, status: 200, body: sse(OK_SSE) };
    };
    rotator.__setProbeImpl(async () => ({
      ip: fs.existsSync(flag) ? "198.51.100.9" : "198.51.100.1",
      error: null,
    }));

    const res = await httpRequest(port, "POST", "/v1/chat/completions", {
      model: "big-pickle",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    const direct = proxy.describe().pool.entries.find((e) => e.direct);
    if (direct) assert.equal(direct.state, "ready", "rotation cleared the direct entry's cooldown");
    rotator.__setProbeImpl(null);
  });

  it("with a single proxy configured, the probe rides that proxy (not direct)", async () => {
    const flag = path.join(stateDir, "hopped4");
    try { fs.unlinkSync(flag); } catch {}
    fs.writeFileSync(
      path.join(stateDir, "rotator.json"),
      JSON.stringify({
        command: process.platform === "win32" ? `cmd /c type nul > "${flag}"` : `touch "${flag}"`,
        timeoutMs: 10000,
        cooldownMs: 1000,
      })
    );
    // Point the single egress at a local listener that answers the trace
    // endpoint with rotating IPs. The probe must arrive THERE — through
    // proxy.netFetch — never as a direct fetch.
    const echo = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`ip=${fs.existsSync(flag) ? "198.51.100.77" : "198.51.100.11"}\n`);
    });
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const proxyUrl = `http://127.0.0.1:${echo.address().port}`;
    const saved = proxy.setProxyUrl(proxyUrl);
    assert.equal(saved.ok, true, "single proxy configured");

    // Bun's fetch has no real proxy implementation in tests, so intercept
    // netFetch instead: ONLY the trace probe is intercepted (asserted to ride
    // the configured egress); every other URL falls through to the real
    // netFetch, which reaches the mocked global.fetch with the body the ok
    // path needs.
    const realNetFetch = proxy.netFetch;
    const probeCalls = [];
    proxy.netFetch = async (url, init, egressUrl) => {
      if (!String(url).includes("cdn-cgi/trace")) {
        return realNetFetch(url, init, egressUrl);
      }
      probeCalls.push({ url: String(url), egressUrl });
      return {
        ok: true,
        status: 200,
        text: async () =>
          `ip=${fs.existsSync(flag) ? "198.51.100.77" : "198.51.100.11"}\n`,
      };
    };
    let upstreamCalls = 0;
    mockFetchImpl = async () => {
      upstreamCalls++;
      if (upstreamCalls === 1) return UP429();
      return { ok: true, status: 200, body: sse(OK_SSE) };
    };
    try {
      const res = await httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);
      assert.equal(rotator.describe().rotations, 1);
      const desc = rotator.describe();
      assert.equal(desc.lastResult.fromIp, "198.51.100.11");
      assert.equal(desc.lastResult.toIp, "198.51.100.77");
      assert.ok(probeCalls.length >= 2, "pre-rotation + post-command probes");
      for (const call of probeCalls) {
        assert.equal(call.egressUrl, proxyUrl, "probe rode the configured proxy, not direct");
        assert.equal(call.url, "https://www.cloudflare.com/cdn-cgi/trace");
      }
    } finally {
      proxy.netFetch = realNetFetch;
      proxy.setProxyUrl("");
      echo.close();
      rotator.__setProbeImpl(null);
    }
  });

  it("parks the reactive rotator after 3 consecutive rotations that still 429 (circuit breaker)", { timeout: 30000 }, async () => {
    // Every rotation succeeds at changing the IP, but upstream refuses the
    // fresh address too — the measured "WARP pool collectively spent" case.
    // After ROTATION_INEFFECTIVE_LIMIT (3) fruitless hops the bridge must stop
    // paying the hop and answer the quota 429 directly. The hop command must
    // SUCCEED so the rotation is ok and the retry runs: a failing command
    // aborts before the retry path and the breaker never counts it.
    fs.writeFileSync(
      path.join(stateDir, "rotator.json"),
      JSON.stringify({
        command: process.platform === "win32" ? "cmd /c exit 0" : "true",
        timeoutMs: 3000,
        cooldownMs: 1000,
      })
    );
    const post = () =>
      httpRequest(port, "POST", "/v1/chat/completions", {
        model: "big-pickle",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });

    // Upstream refuses EVERY address tonight: initial attempt and every
    // post-rotation retry get the quota 429. The cooldown floor is 5s
    // (readEffective clamps file/env values to >= 5000), so consecutive
    // reactive rotations must be spaced out; real trips accumulate across
    // minutes, the test compresses them with 5.1s gaps.
    mockFetchImpl = async () => UP429();
    process.env.WARP_ROTATE_COOLDOWN_MS = "5000";
    rotator.__setProbeImpl(async () => ({ ip: `203.0.113.${Date.now() % 250}`, error: null }));
    const cooldownWait = () => new Promise((r) => setTimeout(r, 5100));
    try {
      for (let i = 0; i < 3; i += 1) {
        if (i > 0) await cooldownWait();
        const res = await post();
        assert.equal(res.status, 429, `attempt ${i + 1}: fresh IP also refused`);
        assert.equal(rotator.describe().rotations, i + 1, `attempt ${i + 1}: exactly one rotation ran`);
      }
      // Breaker is now tripped: the next 429 must not rotate at all.
      const res = await post();
      assert.equal(res.status, 429);
      assert.equal(rotator.describe().rotations, 3, "no fourth hop after the breaker trips");
      const health = await httpRequest(port, "GET", "/health");
      assert.equal(health.body.egress.rotator.rotationIneffective, 3);
      assert.equal(health.body.egress.rotator.rotationIneffectiveLimit, 3);
    } finally {
      rotator.__setProbeImpl(null);
      delete process.env.WARP_ROTATE_COOLDOWN_MS;
      // Clear the module-level breaker so other tests start clean: a manual
      // rotate resets the counter (operator intent), cooldown may 409 it.
      const manual = await httpRequest(port, "POST", "/api/rotator", { rotate: true }).catch(() => null);
      assert.ok(manual === null || manual.status === 200 || manual.status === 409);
    }
  });
});
