const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-proxy-test-"));
process.env.OPENCODE_BRIDGE_STATE_DIR = tmpDir;
delete process.env.UPSTREAM_PROXY_URL;

const proxy = require("../proxy");
const panel = require("../panel");
const srv = require("../server");

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
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: data }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function emptyStateDir() {
  // Describes run in order and each one's `after` cleans up, so this recreates
  // the directory instead of assuming an earlier suite left it in place.
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true });
}

describe("egress proxy", () => {
  beforeEach(() => {
    emptyStateDir();
    proxy.__reload();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts http and https proxies with optional percent-encoded credentials", () => {
    assert.deepEqual(proxy.parseProxyUrl("http://127.0.0.1:8080"), { ok: true, url: "http://127.0.0.1:8080" });
    assert.deepEqual(proxy.parseProxyUrl(" https://proxy.example.com:3128 "), {
      ok: true,
      url: "https://proxy.example.com:3128",
    });
    // Credentials keep their encoding: Bun decodes them for Proxy-Authorization.
    assert.equal(proxy.parseProxyUrl("http://us%40er:p%3Ass@host:8080").url, "http://us%40er:p%3Ass@host:8080");
    assert.equal(proxy.parseProxyUrl("http://user@host:8080").url, "http://user@host:8080");
    // Empty means direct egress, which is how the panel clears the setting.
    assert.deepEqual(proxy.parseProxyUrl("   "), { ok: true, url: "" });
  });

  it("refuses SOCKS and malformed URLs with a reason instead of failing inside a request", () => {
    const socks = proxy.parseProxyUrl("socks5://127.0.0.1:1080");
    assert.equal(socks.ok, false);
    assert.match(socks.error, /SOCKS5/);

    for (const bad of ["not a url", "http://", "http://host:8080/some/path", "ftp://host:21"]) {
      const parsed = proxy.parseProxyUrl(bad);
      assert.equal(parsed.ok, false, `${bad} must be refused`);
      assert.ok(parsed.error);
    }
  });

  it("persists the proxy to disk with owner-only permissions and never echoes credentials", () => {
    const saved = proxy.setProxyUrl("http://user:secret@10.0.0.5:8080");
    assert.equal(saved.ok, true);
    assert.equal(saved.mode, "proxy");
    assert.equal(saved.proxy, "10.0.0.5:8080");
    assert.equal(saved.hasCredentials, true);
    assert.equal(JSON.stringify(saved).includes("secret"), false, "describe() must not leak the password");

    const file = proxy.configFile();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).url, "http://user:secret@10.0.0.5:8080");

    // A fresh process reads the same file.
    proxy.__reload();
    assert.equal(proxy.getProxyUrl(), "http://user:secret@10.0.0.5:8080");
    assert.equal(proxy.describe().source, "file");
  });

  it("clearing the URL returns to direct egress and removes the file", () => {
    proxy.setProxyUrl("http://127.0.0.1:8080");
    const cleared = proxy.setProxyUrl("");
    assert.equal(cleared.ok, true);
    assert.equal(cleared.mode, "direct");
    assert.equal(proxy.getProxyUrl(), "");
    assert.equal(fs.existsSync(proxy.configFile()), false);
  });

  it("ignores a corrupt config file instead of refusing to boot", () => {
    fs.writeFileSync(proxy.configFile(), "{not json", "utf8");
    proxy.__reload();
    assert.equal(proxy.getProxyUrl(), "");
    assert.match(proxy.describe().error, /proxy\.json/);
  });

  it("lets UPSTREAM_PROXY_URL win and refuses runtime edits while it is set", () => {
    process.env.UPSTREAM_PROXY_URL = "http://env-proxy:9000";
    proxy.__reload();
    try {
      assert.equal(proxy.getProxyUrl(), "http://env-proxy:9000");
      assert.equal(proxy.describe().locked, true);
      const attempt = proxy.setProxyUrl("http://other:1");
      assert.equal(attempt.ok, false);
      assert.match(attempt.error, /UPSTREAM_PROXY_URL/);
      assert.equal(proxy.getProxyUrl(), "http://env-proxy:9000");
    } finally {
      delete process.env.UPSTREAM_PROXY_URL;
      proxy.__reload();
    }
  });

  it("injects proxy: into every fetch init, and only when one is configured", () => {
    assert.deepEqual(proxy.withProxy({ headers: { a: "b" } }), { headers: { a: "b" } });

    proxy.setProxyUrl("http://127.0.0.1:8080");
    assert.equal(proxy.withProxy({ signal: "s" }).proxy, "http://127.0.0.1:8080");
    // A caller that pins its own proxy keeps it.
    assert.equal(proxy.withProxy({ proxy: "http://pinned:1" }).proxy, "http://pinned:1");

    let seen = null;
    const original = global.fetch;
    global.fetch = async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({}) };
    };
    try {
      proxy.netFetch("https://example.com/x", { method: "GET" });
    } finally {
      global.fetch = original;
    }
    assert.equal(seen.init.proxy, "http://127.0.0.1:8080");
    assert.equal(seen.init.method, "GET");
  });

  // `testProxy` refuses to run on Node because Node's fetch silently ignores
  // the `proxy` init option: the probe would report "ok" while the request went
  // out directly. That refusal is the correct behaviour, so the live-probe
  // assertions only apply where the option is actually honoured.
  const PROBE_RUNTIME = typeof Bun !== "undefined";

  it("refuses to probe on a runtime whose fetch ignores the proxy option", async () => {
    if (PROBE_RUNTIME) return;
    const verdict = await proxy.testProxy("http://127.0.0.1:8080");
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /Bun/);
  });

  it("reports a proxy that cannot reach upstream, and the exit IP when it can", async () => {
    if (!PROBE_RUNTIME) return;
    const original = global.fetch;
    try {
      global.fetch = async (url, init) => {
        if (String(url).includes("cdn-cgi/trace")) return { ok: true, text: async () => "ip=203.0.113.9\nloc=SG\n" };
        assert.equal(init.proxy, "http://127.0.0.1:8080");
        return { ok: true, status: 200 };
      };
      const ok = await proxy.testProxy("http://127.0.0.1:8080");
      assert.equal(ok.ok, true);
      assert.equal(ok.apiStatus, 200);
      assert.equal(ok.exitIp, "203.0.113.9");

      global.fetch = async (url) => {
        if (String(url).includes("cdn-cgi/trace")) throw new Error("tunnel refused");
        return { ok: false, status: 403 };
      };
      const refused = await proxy.testProxy("http://127.0.0.1:8080");
      assert.equal(refused.ok, false);
      assert.equal(refused.apiStatus, 403);
      assert.match(refused.error, /403/);
    } finally {
      global.fetch = original;
    }
  });
});

describe("proxy HTTP surface", () => {
  let port;
  let server;

  before(async () => {
    await new Promise((resolve) => {
      server = srv.server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("serves the panel at / and keeps /health as JSON", async () => {
    const page = await request(port, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.raw, /<title>Proxy egress/);
    assert.match(page.raw, /id="proxy-url"/);
    assert.match(page.raw, /id="save"/);
    assert.match(page.raw, /aria-live="polite"/);

    const health = await request(port, "GET", "/health");
    assert.equal(health.status, 200);
    const body = JSON.parse(health.raw);
    assert.equal(body.status, "ok");
    assert.ok(body.egress.proxy);
    assert.equal(body.egress.proxy.mode, "direct");
  });

  it("round-trips the setting through /api/proxy without returning credentials", async () => {
    emptyStateDir();
    proxy.__reload();

    const saved = await request(port, "POST", "/api/proxy", { url: "http://u:p@127.0.0.1:3128" });
    assert.equal(saved.status, 200);
    const savedBody = JSON.parse(saved.raw);
    assert.equal(savedBody.mode, "proxy");
    assert.equal(savedBody.proxy, "127.0.0.1:3128");
    assert.equal(saved.raw.includes('"p"'), false);

    const read = await request(port, "GET", "/api/proxy");
    assert.equal(read.status, 200);
    assert.equal(JSON.parse(read.raw).mode, "proxy");

    const health = JSON.parse((await request(port, "GET", "/health")).raw);
    assert.equal(health.egress.proxy.mode, "proxy");
    assert.equal(health.egress.proxy.proxy, "127.0.0.1:3128");

    const cleared = await request(port, "POST", "/api/proxy", { url: "" });
    assert.equal(cleared.status, 200);
    assert.equal(JSON.parse(cleared.raw).mode, "direct");

    const bad = await request(port, "POST", "/api/proxy", { url: "socks5://127.0.0.1:1080" });
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.raw).error, /SOCKS5/);

    const noUrl = await request(port, "POST", "/api/proxy", { proxy: "x" });
    assert.equal(noUrl.status, 400);
  });

  it("answers /api/proxy/test with the probe verdict", async () => {
    if (typeof Bun === "undefined") return;
    const original = global.fetch;
    try {
      global.fetch = async (url) => {
        if (String(url).includes("cdn-cgi/trace")) return { ok: true, text: async () => "ip=198.51.100.7\n" };
        return { ok: true, status: 200 };
      };
      const res = await request(port, "POST", "/api/proxy/test", { url: "http://127.0.0.1:3128" });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.raw);
      assert.equal(body.ok, true);
      assert.equal(body.exitIp, "198.51.100.7");
    } finally {
      global.fetch = original;
    }
  });

  it("refuses cross-site writes and non-JSON bodies (CSRF)", async () => {
    emptyStateDir();
    proxy.__reload();

    // A foreign page can send text/plain without a preflight; the bridge must
    // refuse it on content type alone.
    const formPost = await request(port, "POST", "/api/proxy", { url: "http://attacker.example:8080" }, {
      "Content-Type": "text/plain",
    });
    assert.equal(formPost.status, 415);
    assert.equal(proxy.getProxyUrl(), "");

    const crossSite = await request(port, "POST", "/api/proxy", { url: "http://attacker.example:8080" }, {
      Origin: "https://evil.example",
      "Sec-Fetch-Site": "cross-site",
    });
    assert.equal(crossSite.status, 403);
    assert.equal(proxy.getProxyUrl(), "");

    const foreignHost = await request(port, "GET", "/api/proxy", undefined, {
      Host: "evil.example",
    });
    assert.equal(foreignHost.status, 403);

    // The panel itself must not render for a rebound name either.
    const panelViaForeignHost = await request(port, "GET", "/", undefined, { Host: "evil.example" });
    assert.equal(panelViaForeignHost.status, 403);

    // The same-origin panel still works.
    const sameOrigin = await request(port, "POST", "/api/proxy", { url: "http://127.0.0.1:3128" }, {
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin",
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(proxy.getProxyUrl(), "http://127.0.0.1:3128");
    proxy.setProxyUrl("");
  });
});

describe("panel document", () => {
  it("escapes config values so a crafted proxy string cannot inject markup", () => {
    const html = panel.renderPanel(
      { mode: "proxy", proxy: '<img src=x onerror="alert(1)">', source: "file", configPath: "/tmp/x", error: null },
      { version: "2.0.3", port: 20129 }
    );
    assert.equal(html.includes("<img src=x"), false);
    assert.match(html, /&lt;img src=x/);
  });

  it("ships no dead controls: every button has a matching listener", () => {
    const html = panel.renderPanel({ mode: "direct" });
    for (const id of ["save", "test", "direct"]) {
      assert.match(html, new RegExp(`id="${id}"`), `button ${id} missing`);
    }
    assert.match(html, /\$\("save"\)/);
    assert.match(html, /saveBtn\.addEventListener\("click"/);
    assert.match(html, /testBtn\.addEventListener\("click"/);
    assert.match(html, /directBtn\.addEventListener\("click"/);
    assert.match(html, /form\.addEventListener\("submit"/);
  });
});

describe("egress pool", () => {
  beforeEach(() => {
    emptyStateDir();
    delete process.env.UPSTREAM_PROXY_POOL;
    delete process.env.UPSTREAM_PROXY_STRATEGY;
    proxy.__reload();
    proxy.resetHealth();
  });

  after(() => {
    delete process.env.UPSTREAM_PROXY_POOL;
    delete process.env.UPSTREAM_PROXY_STRATEGY;
  });

  it("parses a pool from URLs, label=url lines, and objects", () => {
    const spec = proxy.parsePoolSpec("http://a:1, med2=http://b:2");
    assert.equal(spec.errors.length, 0);
    assert.deepEqual(spec.entries.map((e) => [e.label, e.url]), [
      ["a:1", "http://a:1"],
      ["med2", "http://b:2"],
    ]);

    const fromObject = proxy.parsePoolEntry({ id: "x", label: "Laptop", url: "http://c:3", weight: 5 }, 0);
    assert.equal(fromObject.ok, true);
    assert.equal(fromObject.entry.weight, 5);
    // A weight only has to be relative, and an omitted one is 1.
    assert.equal(proxy.parsePoolEntry("http://d:4", 0).entry.weight, 1);
  });

  it("refuses a malformed or duplicated entry instead of installing half a pool", () => {
    assert.match(proxy.parsePoolSpec("socks5://a:1").errors[0], /SOCKS5/);
    assert.equal(proxy.parsePoolEntry({}, 3).ok, false);

    const dup = proxy.setPool(["http://a:1", "http://a:1"]);
    assert.equal(dup.ok, false);
    assert.match(dup.error, /ganda/);
    assert.equal(proxy.describe().pool.active, false);
  });

  it("persists the pool with 0600 and reports host:port only", () => {
    const saved = proxy.setPool({
      entries: ["http://u:secret@a:1", { label: "b", url: "http://b:2", weight: 3 }],
      strategy: "failover",
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.mode, "pool");
    assert.equal(saved.pool.size, 2);
    assert.equal(saved.pool.strategy, "failover");
    assert.equal(saved.raw ?? JSON.stringify(saved).includes("secret"), false);
    assert.equal(JSON.stringify(saved).includes("secret"), false, "describe() must not leak credentials");

    const file = proxy.configFile();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.pool.length, 2);
    assert.equal(onDisk.strategy, "failover");

    // A fresh process reads the same pool.
    proxy.__reload();
    assert.equal(proxy.getPool().length, 2);
    assert.equal(proxy.describe().pool.enabled, 2);
  });

  it("rotates round-robin across enabled entries", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2", "http://c:3"], strategy: "round-robin" });
    const picked = [proxy.pick(), proxy.pick(), proxy.pick(), proxy.pick()].map((p) => p.url);
    assert.deepEqual(picked, ["http://a:1", "http://b:2", "http://c:3", "http://a:1"]);
  });

  it("stays on the first healthy entry in failover mode", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"], strategy: "failover" });
    assert.equal(proxy.pick().url, "http://a:1");
    assert.equal(proxy.pick().url, "http://a:1");
    proxy.markFailure("http://a:1", { reason: "gate 429" });
    assert.equal(proxy.pick().url, "http://b:2");
  });

  it("skips a cooling entry and returns to it once the cooldown ends", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"], strategy: "round-robin" });
    const cooldown = proxy.markFailure("http://a:1", { reason: "allowance 429", cooldownMs: 60000 });
    assert.equal(cooldown.failures, 1);
    assert.ok(cooldown.cooldownUntil > Date.now());

    const state = proxy.describe();
    const a = state.pool.entries.find((e) => e.host === "a:1");
    assert.equal(a.state, "cooling");
    assert.equal(state.pool.ready, 1);

    // Every pick now lands on the healthy entry.
    assert.deepEqual([proxy.pick(), proxy.pick(), proxy.pick()].map((p) => p.url), [
      "http://b:2",
      "http://b:2",
      "http://b:2",
    ]);

    // Time moves on: a's cooldown is over, so it is a candidate again.
    const later = Date.now() + 61000;
    assert.equal(proxy.describe(later).pool.ready, 2);
  });

  it("backs off further on each consecutive failure, capped, and resets on success", () => {
    proxy.setPool({ entries: ["http://a:1"], cooldownMs: 1000, maxCooldownMs: 4000 });
    const first = proxy.markFailure("http://a:1");
    const second = proxy.markFailure("http://a:1");
    const third = proxy.markFailure("http://a:1");
    assert.equal(first.backoffMs, 1000);
    assert.equal(second.backoffMs, 2000);
    assert.equal(third.backoffMs, 4000);
    // Capped: the fourth failure does not exceed maxCooldownMs.
    assert.equal(proxy.markFailure("http://a:1").backoffMs, 4000);

    proxy.markSuccess("http://a:1");
    assert.equal(proxy.describe().pool.entries[0].state, "ready");
    assert.equal(proxy.describe().pool.entries[0].failures, 0);
    assert.equal(proxy.markFailure("http://a:1").backoffMs, 1000);
  });

  it("clears a long cooldown when the egress address has rotated", async () => {
    // The free allowance is keyed to the address upstream sees, not to the
    // proxy URL. A phone on mobile data rotates that address several times a
    // day, so a 13-hour Retry-After must not outlive the IP that earned it.
    if (typeof Bun === "undefined") return;
    proxy.setPool({
      entries: [{ id: "phone", url: "http://127.0.0.1:9911" }],
      strategy: "priority-failover",
      cooldownMs: 60_000,
      maxCooldownMs: 1_800_000,
    });
    // 13 hours: the real Retry-After measured on a spent allowance.
    proxy.markFailure("http://127.0.0.1:9911", { reason: "allowance 429", cooldownMs: 47_000_000 });
    assert.equal(proxy.describe().pool.entries[0].state, "cooling");

    const original = global.fetch;
    try {
      let exit = "203.0.113.9";
      global.fetch = async (url) => {
        if (String(url).includes("cdn-cgi/trace")) return { ok: true, text: async () => `ip=${exit}\n` };
        return { ok: true, status: 200 };
      };
      // First tick learns the address that earned the cooldown.
      await proxy.recoveryProbeTick();
      assert.equal(proxy.describe().pool.entries[0].state, "cooling", "same IP must stay parked");

      // The phone rotates: a different address means a fresh allowance.
      exit = "198.51.100.7";
      await proxy.recoveryProbeTick();
      const entry = proxy.describe().pool.entries[0];
      assert.equal(entry.state, "ready", "an address change must clear the old cooldown");
      assert.equal(entry.failures, 0);
    } finally {
      global.fetch = original;
    }
  });
  it("still sends through the least-cooling entry when every entry is throttled", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    proxy.markFailure("http://a:1", { reason: "gate 429", cooldownMs: 9000 });
    proxy.markFailure("http://b:2", { reason: "gate 429", cooldownMs: 3000 });
    const picked = proxy.pick();
    assert.equal(picked.cooling, true);
    // b recovers first, so it is the one used.
    assert.equal(picked.url, "http://b:2");
  });

  it("honours exclude so a retry can leave the egress that just failed", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    assert.equal(proxy.pick({ exclude: "http://a:1" }).url, "http://b:2");
    // Excluding everything falls back to the pool instead of returning nothing.
    assert.ok(proxy.pick({ exclude: "http://a:1" }).url);
  });

  it("injects the picked entry as proxy: and never overrides a caller's own", () => {
    proxy.setPool({ entries: ["http://a:1"] });
    assert.equal(proxy.withProxy({}).proxy, "http://a:1");
    assert.equal(proxy.withProxy({ proxy: "http://pinned:9" }).proxy, "http://pinned:9");
    // An explicit egress wins over the pool's rotation.
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    assert.equal(proxy.withProxy({}, "http://c:3").proxy, "http://c:3");
  });

  it("reads UPSTREAM_PROXY_POOL from the environment and locks runtime edits", () => {
    process.env.UPSTREAM_PROXY_POOL = "one=http://a:1,two=http://b:2";
    process.env.UPSTREAM_PROXY_STRATEGY = "failover";
    proxy.__reload();
    try {
      assert.equal(proxy.getPool().length, 2);
      assert.equal(proxy.describe().pool.strategy, "failover");
      assert.equal(proxy.describe().locked, true);
      const attempt = proxy.setPool(["http://c:3"]);
      assert.equal(attempt.ok, false);
      assert.match(attempt.error, /UPSTREAM_PROXY_POOL/);
    } finally {
      delete process.env.UPSTREAM_PROXY_POOL;
      delete process.env.UPSTREAM_PROXY_STRATEGY;
      proxy.__reload();
    }
  });

  it("clearing the pool falls back to direct egress", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    const cleared = proxy.setPool({ entries: [] });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.mode, "direct");
    assert.equal(proxy.getPool().length, 0);
    assert.equal(proxy.pick().url, "");
  });

  it("keeps a single proxy configured when a pool is cleared", () => {
    proxy.setProxyUrl("http://single:9");
    proxy.setPool({ entries: ["http://a:1"] });
    assert.equal(proxy.describe().mode, "pool");

    proxy.setPool({ entries: [] });
    assert.equal(proxy.describe().mode, "proxy");
    assert.equal(proxy.getProxyUrl(), "http://single:9");
  });
});

describe("egress pool: direct entry", () => {
  beforeEach(() => {
    emptyStateDir();
    delete process.env.UPSTREAM_PROXY_POOL;
    proxy.__reload();
    proxy.resetHealth();
  });

  it("accepts { direct: true } and reports it distinctly", () => {
    const saved = proxy.setPool({ entries: [{ direct: true, label: "petafora" }, "http://a:1"] });
    assert.equal(saved.ok, true);
    assert.deepEqual(
      saved.pool.entries.map((e) => [e.label, e.host, e.state]),
      [
        ["petafora", "direct", "ready"],
        ["a:1", "a:1", "ready"],
      ]
    );
  });

  it("returns an empty egress for the direct entry, so the fetch goes out unproxied", () => {
    proxy.setPool({ entries: [{ direct: true }, "http://a:1"], strategy: "failover" });
    const first = proxy.pick();
    assert.equal(first.url, "");
    assert.equal(first.source, "direct");

    // withProxy must leave the init alone for a direct egress even when an
    // explicit empty target is passed.
    assert.deepEqual(proxy.withProxy({ headers: { a: "b" } }, ""), { headers: { a: "b" } });
  });

  it("keeps direct and a proxy independent in health", () => {
    proxy.setPool({ entries: [{ direct: true }, "http://a:1"], strategy: "round-robin" });
    proxy.markFailure("", { reason: "gate 429" });
    const state = proxy.describe();
    const directEntry = state.pool.entries.find((e) => e.host === "direct");
    const proxyEntry = state.pool.entries.find((e) => e.host === "a:1");
    assert.equal(directEntry.failures, 1);
    assert.equal(proxyEntry.failures, 0);
    // The healthy proxy is the only candidate now.
    assert.equal(proxy.pick().url, "http://a:1");
  });

  it("refuses a second direct entry as a duplicate", () => {
    const result = proxy.setPool([{ direct: true }, { direct: true, label: "again" }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /direct/);
  });
});

describe("egress pool: health survives a restart", () => {
  beforeEach(() => {
    emptyStateDir();
    delete process.env.UPSTREAM_PROXY_POOL;
    proxy.__reload();
    proxy.resetHealth();
  });

  it("remembers a cooling entry across a reload when the record names its address", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    // A cooldown that names the address that earned it stays parked: that exit
    // IP is still the one upstream refused.
    proxy.noteExitIp("http://a:1", "203.0.113.9");
    proxy.markFailure("http://a:1", { reason: "allowance 429", cooldownMs: 60000 });

    // A fresh process reads the pool and the health file; only the pool config
    // is operator intent, so losing health here would re-burn a spent IP.
    proxy.__flushHealth();
    proxy.__restart();

    const state = proxy.describe();
    const a = state.pool.entries.find((e) => e.host === "a:1");
    assert.equal(a.state, "cooling");
    assert.equal(a.failures, 1);
    assert.ok(a.cooldownMsLeft > 50000, `expected cooldown to survive, got ${a.cooldownMsLeft}`);
    assert.equal(state.pool.ready, 1);
    assert.equal(proxy.pick().url, "http://b:2");
  });

  it("drops a long cooldown whose record cannot name the address that earned it", () => {
    // The allowance is keyed to the exit address, and a phone on mobile data
    // rotates it several times a day. A 13-hour Retry-After restored from an
    // older health file with no `exitIp` is unverifiable — trusting it kept a
    // healthy phone parked all day while the same URL answered 200.
    proxy.setPool({ entries: ["http://a:1"] });
    proxy.markFailure("http://a:1", { reason: "allowance 429", cooldownMs: 47_000_000 });
    proxy.__flushHealth();
    const raw = JSON.parse(fs.readFileSync(proxy.healthFile(), "utf8"));
    for (const e of raw.entries) delete e.exitIp;
    fs.writeFileSync(proxy.healthFile(), JSON.stringify(raw));
    proxy.__restart();
    const entry = proxy.describe().pool.entries[0];
    assert.equal(entry.state, "ready", "an unverifiable park must not survive a restart");
    assert.equal(entry.cooldownMsLeft, 0);
  });

  it("restores the failure count so backoff continues instead of restarting", () => {
    proxy.setPool({ entries: ["http://a:1"], cooldownMs: 1000, maxCooldownMs: 8000 });
    proxy.markFailure("http://a:1");
    proxy.markFailure("http://a:1");
    proxy.__restart();
    // Third consecutive failure doubles from 4000, not from the base 1000.
    assert.equal(proxy.markFailure("http://a:1").backoffMs, 4000);
  });

  it("forgets a spent entry once it succeeds, so the file does not keep stale cooldowns", () => {
    proxy.setPool({ entries: ["http://a:1"] });
    proxy.markFailure("http://a:1", { cooldownMs: 60000 });
    proxy.markSuccess("http://a:1");
    // `markSuccess` is coalesced; write deterministically before reloading so
    // this asserts persisted state rather than the timer.
    proxy.__flushHealth();
    proxy.__restart();
    const state = proxy.describe();
    assert.equal(state.pool.entries[0].state, "ready");
    assert.equal(state.pool.entries[0].failures, 0);
  });

  it("writes health with 0600 and never stores the proxy URL or its credentials", () => {
    proxy.setPool({ entries: ["http://user:secret@a:1"] });
    proxy.markFailure("http://user:secret@a:1", { reason: "allowance 429" });
    const raw = fs.readFileSync(proxy.healthFile(), "utf8");
    assert.equal(fs.statSync(proxy.healthFile()).mode & 0o777, 0o600);
    // A second copy of every proxy token would be a second thing to leak. The
    // record is keyed by an opaque hash of the egress identity, and the label
    // carries only what `describe()` already exposes (host:port).
    assert.equal(raw.includes("secret"), false);
    assert.equal(raw.includes("user:"), false);
    assert.equal(raw.includes("http://"), false);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.entries.length, 1);
    assert.match(parsed.entries[0].id, /^[0-9a-f]{16}$/);
  });

  it("ignores a corrupt health file instead of losing the pool", () => {
    proxy.setPool({ entries: ["http://a:1"] });
    proxy.markFailure("http://a:1");
    fs.writeFileSync(proxy.healthFile(), "{ not json");
    proxy.__restart();
    assert.equal(proxy.describe().mode, "pool");
    assert.equal(proxy.describe().pool.entries[0].state, "ready");
    assert.equal(fs.existsSync(proxy.healthFile()), false);
  });

  it("drops health for an entry that leaves the pool", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    proxy.markFailure("http://a:1", { cooldownMs: 60000 });
    proxy.setPool({ entries: ["http://b:2"] });
    const raw = JSON.parse(fs.readFileSync(proxy.healthFile(), "utf8"));
    assert.deepEqual(raw.entries.map((e) => e.label), ["b:2"]);
  });

  it("keeping the pool saved does not forget the cooldown it already learned", () => {
    proxy.setPool({ entries: ["http://a:1", "http://b:2"] });
    proxy.markFailure("http://a:1", { reason: "allowance 429", cooldownMs: 60000 });
    // Saving again is what the panel does on every strategy change.
    const saved = proxy.setPool({ entries: ["http://a:1", "http://b:2"], strategy: "failover" });
    assert.equal(saved.ok, true);
    assert.equal(saved.pool.entries.find((e) => e.host === "a:1").state, "cooling");
  });
});
