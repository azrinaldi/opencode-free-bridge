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
    // (busy) the moment the call returns — no timing window to race.
    assert.equal(rotator.describe().busy, true, "hold rotation must occupy the single-flight");

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
});
