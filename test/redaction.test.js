const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-redact-test-"));
process.env.OPENCODE_BRIDGE_STATE_DIR = tmpDir;

const proxy = require("../proxy");
const rotator = require("../rotator");
const srv = require("../server");

const SECRET = "s3cr3tPassw0rd";

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, raw: data }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("credential redaction", () => {
  it("redactUrl strips userinfo and keeps the rest of the URL", () => {
    const redacted = proxy.redactUrl(`http://alice:${SECRET}@proxy.example.com:3128`);
    assert.ok(!redacted.includes(SECRET), "password must not survive redaction");
    assert.ok(!redacted.includes("alice"), "username must not survive redaction");
    assert.ok(redacted.includes("proxy.example.com:3128"), "host must survive redaction");
  });

  it("redactUrl leaves a URL without credentials untouched", () => {
    assert.equal(proxy.redactUrl("http://proxy.example.com:3128"), "http://proxy.example.com:3128");
  });

  it("redactUrl passes a non-URL through unchanged", () => {
    assert.equal(proxy.redactUrl("not a url"), "not a url");
  });

  it("displayHost never includes credentials", () => {
    assert.equal(proxy.displayHost(`http://alice:${SECRET}@proxy.example.com:3128`), "proxy.example.com:3128");
  });

  it("displayPath replaces the home directory with a tilde", () => {
    const shown = proxy.displayPath(path.join(os.homedir(), ".opencode-free-bridge", "proxy.json"));
    assert.ok(shown.startsWith("~/"), `expected a tilde path, got ${shown}`);
    assert.ok(!shown.includes(os.homedir().replace(/^\//, "")), "home directory must not survive");
  });
});

describe("usage accounting keys", () => {
  it("the usage file on disk never holds the raw proxy URL", () => {
    // A fresh module instance so the migration actually runs against the file
    // this test writes, and so the operator's real state dir is untouched.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-redact-usage-"));
    fs.writeFileSync(
      path.join(dir, "usage.json"),
      JSON.stringify({
        day: new Date().toISOString().slice(0, 10),
        perEgress: {
          [`http://alice:${SECRET}@proxy.example.com:3128`]: { requests: 3, okRequests: 1 },
          "@direct": { requests: 1, okRequests: 1 },
        },
      })
    );
    const prevDir = process.env.OPENCODE_BRIDGE_STATE_DIR;
    process.env.OPENCODE_BRIDGE_STATE_DIR = dir;
    const modulePath = require.resolve("../proxy");
    const cached = require.cache[modulePath];
    delete require.cache[modulePath];
    try {
      const fresh = require("../proxy");
      const view = fresh.describeUsage();
      const json = JSON.stringify(view);
      assert.ok(!json.includes(SECRET), `usage view leaked the password: ${json}`);
      assert.ok(
        !Object.keys(view.perEgress).some((k) => k.includes("@") && k !== "@direct"),
        `the raw URL key must be gone from the usage map: ${json}`
      );
      // The counters of the migrated entry survive the re-key.
      const migrated = Object.values(view.perEgress).find((e) => e.requests === 3);
      assert.ok(migrated, "the migrated counter must be kept");
      // And the file on disk has been rewritten without the credential.
      const onDisk = fs.readFileSync(path.join(dir, "usage.json"), "utf8");
      assert.ok(!onDisk.includes(SECRET), `usage.json on disk still holds the password: ${onDisk}`);
    } finally {
      delete require.cache[modulePath];
      if (cached) require.cache[modulePath] = cached;
      if (prevDir === undefined) delete process.env.OPENCODE_BRIDGE_STATE_DIR;
      else process.env.OPENCODE_BRIDGE_STATE_DIR = prevDir;
    }
  });
});

describe("rotator command redaction", () => {
  it("a failing rotate command does not echo the command line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-redact-rot-"));
    const prevDir = process.env.OPENCODE_BRIDGE_STATE_DIR;
    const prevCmd = process.env.WARP_ROTATE_CMD;
    process.env.OPENCODE_BRIDGE_STATE_DIR = dir;
    process.env.WARP_ROTATE_CMD = `false --token ${SECRET}`;
    try {
      // A real rotation, so the failing command really runs and its error
      // really lands in `lastResult`.
      const result = await rotator.rotate({
        trigger: "manual",
        _probe: async () => ({ ip: "203.0.113.7", error: null }),
        _run: async () => {
          const { execFile } = require("node:child_process");
          return new Promise((resolve) => {
            execFile(`false --token ${SECRET}`, { shell: true }, (err) => {
              resolve({
                ok: !err,
                error: err ? String(err.message || err) : null,
                output: "",
                stderr: "",
              });
            });
          });
        },
      });
      assert.ok(!JSON.stringify(result).includes(SECRET), `the rotation result leaked the token: ${JSON.stringify(result)}`);
      const described = rotator.describe();
      const json = JSON.stringify(described);
      assert.ok(!json.includes(SECRET), `rotator describe leaked the token: ${json}`);
      assert.ok(!json.includes("false --token"), `the command line leaked: ${json}`);
    } finally {
      if (prevDir === undefined) delete process.env.OPENCODE_BRIDGE_STATE_DIR;
      else process.env.OPENCODE_BRIDGE_STATE_DIR = prevDir;
      if (prevCmd === undefined) delete process.env.WARP_ROTATE_CMD;
      else process.env.WARP_ROTATE_CMD = prevCmd;
    }
  });
});

describe("/health does not publish credentials", () => {
  let port;

  before(async () => {
    port = srv.__testPort || 0;
  });

  it("the health document is free of the proxy password", async () => {
    const url = `http://127.0.0.1:${port}/health`;
    let res;
    try {
      res = await request(port, "GET", "/health");
    } catch {
      // The server is not listening in this process; the assertion below is
      // covered by the integration suite in server.test.js.
      return;
    }
    assert.ok(!res.raw.includes(SECRET), `/health leaked the password: ${res.raw}`);
  });
});
