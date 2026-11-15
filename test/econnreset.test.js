const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const proxy = require("../proxy");
const rotator = require("../rotator");
const { server } = require("../server");

/**
 * A WARP hop drops the tunnel for ~10s, so a client request whose socket is
 * mid-flight through the TUN dies with ECONNRESET. The bridge must recognize
 * that as the rotator working (warn + retryable 503), not a bridge fault
 * (generic 500 "exception"). These tests pin the classification at the catch
 * block: busy rotator → 503 with Retry-After; idle rotator → old behavior.
 */
describe("ECONNRESET during a WARP hop", () => {
  let port;
  let originalFetch;
  let mockFetchImpl;
  let stateDir;
  const prevEnv = {};

  before(async () => {
    originalFetch = global.fetch;
    global.fetch = async (...args) => mockFetchImpl(...args);
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-reset-"));
    for (const key of ["OPENCODE_BRIDGE_STATE_DIR", "WARP_ROTATE_CMD", "WARP_ROTATE_TIMEOUT_MS", "WARP_ROTATE_COOLDOWN_MS"]) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OPENCODE_BRIDGE_STATE_DIR = stateDir;
    proxy.__reload();
    rotator.__reload?.();
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    global.fetch = originalFetch;
    rotator.__reset({ keepConfig: false });
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function post() {
    return new Promise((resolve, reject) => {
      const req = require("node:http").request(
        { host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify({ model: "big-pickle", stream: false, messages: [{ role: "user", content: "hi" }] }));
    });
  }

  // The idle test runs FIRST: the busy test resets rotator state at its end,
  // and bun's scheduler may interleave sibling tests, so anything the busy
  // test holds (inFlight) must not be disturbed by a later sibling. Idle has
  // no cross-test expectations beyond "busy is false", which its own reset
  // guarantees.
  it("keeps the generic 500 when ECONNRESET happens with no rotation busy", async () => {
    rotator.__reset({ keepConfig: true });
    assert.equal(rotator.describe().busy, false);
    mockFetchImpl = async () => {
      const err = new TypeError("The socket connection was closed unexpectedly.");
      err.code = "ECONNRESET";
      throw err;
    };
    const res = await post();
    assert.equal(res.status, 500);
    assert.equal(res.body.error.type, "server_error");
    assert.match(res.body.error.message, /closed unexpectedly/);
  });

  it("answers 503 + Retry-After when the socket dies while a rotation is busy", { timeout: 15000 }, async () => {
    mockFetchImpl = async () => {
      const err = new TypeError("The socket connection was closed unexpectedly.");
      err.code = "ECONNRESET";
      throw err;
    };
    // Hold the rotator busy deterministically: a rotate whose probe never
    // resolves until we release it. Real command execution is CI-flaky (a
    // skip for any reason makes busy false and the test asserts the wrong
    // branch), so the hold rides the probe seam instead.
    rotator.__reset({ keepConfig: true });
    let releaseProbe;
    const gate = new Promise((resolve) => (releaseProbe = resolve));
    rotator.__setProbeImpl(async () => {
      await gate;
      return { ip: "203.0.113.9", error: null };
    });
    // A configured command is required or rotate() skips with "disabled"
    // before setting inFlight. The command never runs: the probe gate holds
    // the rotation.
    fs.writeFileSync(
      path.join(stateDir, "rotator.json"),
      JSON.stringify({ command: "true", timeoutMs: 8000, cooldownMs: 1000 })
    );
    const hold = rotator.rotate({ egressUrl: null, trigger: "manual" });
    // rotate() runs synchronously up to its first await, so inFlight is set
    // (busy) the moment the call returns. Poll anyway, and if it never comes
    // up, fail with the awaited hold entry so the skip reason is visible in
    // CI annotations instead of a bare false !== true.
    let busySeen = rotator.describe().busy;
    if (!busySeen) {
      for (let i = 0; i < 20 && !busySeen; i++) {
        await new Promise((r) => setTimeout(r, 50));
        busySeen = rotator.describe().busy;
      }
    }
    if (!busySeen) {
      const entry = await Promise.race([hold, new Promise((r) => setTimeout(() => r({ timeout: true }), 500))]);
      rotator.__setProbeImpl(null);
      assert.fail("hold rotation never became busy; entry: " + JSON.stringify(entry));
    }

    const res = await post();
    assert.equal(res.status, 503);
    assert.equal(res.headers["retry-after"], "10");
    assert.match(res.body.error.message, /rotasi WARP|di-hop/i);
    assert.equal(res.body.error.code, 503);

    releaseProbe();
    await hold;
    rotator.__setProbeImpl(null);
    rotator.__reset({ keepConfig: true });
  });

  it("answers the same 503 for a fresh dial refused while the tunnel is down", { timeout: 15000 }, async () => {
    mockFetchImpl = async () => {
      const err = new TypeError("Unable to connect. Is the computer able to access the url?");
      err.code = "ConnectionRefused";
      throw err;
    };
    rotator.__reset({ keepConfig: true });
    let releaseProbe;
    const gate = new Promise((resolve) => (releaseProbe = resolve));
    rotator.__setProbeImpl(async () => {
      await gate;
      return { ip: "203.0.113.9", error: null };
    });
    fs.writeFileSync(
      path.join(stateDir, "rotator.json"),
      JSON.stringify({ command: "true", timeoutMs: 8000, cooldownMs: 1000 })
    );
    const hold = rotator.rotate({ egressUrl: null, trigger: "manual" });
    let busySeen = rotator.describe().busy;
    if (!busySeen) {
      for (let i = 0; i < 20 && !busySeen; i++) {
        await new Promise((r) => setTimeout(r, 50));
        busySeen = rotator.describe().busy;
      }
    }
    if (!busySeen) {
      const entry = await Promise.race([hold, new Promise((r) => setTimeout(() => r({ timeout: true }), 500))]);
      rotator.__setProbeImpl(null);
      assert.fail("hold rotation never became busy; entry: " + JSON.stringify(entry));
    }

    const res = await post();
    assert.equal(res.status, 503);
    assert.equal(res.headers["retry-after"], "10");
    assert.match(res.body.error.message, /rotasi WARP|di-hop/i);

    releaseProbe();
    await hold;
    rotator.__setProbeImpl(null);
    rotator.__reset({ keepConfig: true });
  });
});
