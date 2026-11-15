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
    // Hold the rotator busy while the request runs: a rotate whose command
    // sleeps long enough. Windows `ping -n` / POSIX `sleep`.
    const holdCmd = process.platform === "win32"
      ? "ping -n 6 127.0.0.1 > nul"
      : "sleep 5";
    fs.writeFileSync(path.join(stateDir, "rotator.json"), JSON.stringify({ command: holdCmd, timeoutMs: 8000, cooldownMs: 1000 }));
    const hold = rotator.rotate({ egressUrl: null, trigger: "manual" });
    assert.equal(rotator.describe().busy, true, "hold rotation must occupy the single-flight");

    const res = await post();
    assert.equal(res.status, 503);
    assert.equal(res.headers["retry-after"], "10");
    assert.match(res.body.error.message, /rotasi WARP|di-hop/i);
    assert.equal(res.body.error.code, 503);

    await hold;
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
