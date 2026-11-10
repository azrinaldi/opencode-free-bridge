#!/usr/bin/env bun
const dns = require("dns");
// `ipv6first` only exists from Node 22, and an unsupported order throws
// ERR_INVALID_ARG_VALUE at module load — which kills the bridge before it
// listens instead of merely changing a preference. Fall back in order.
const DNS_RESULT_ORDER = (() => {
  const wanted = String(process.env.DNS_RESULT_ORDER || "ipv4first").trim().toLowerCase();
  for (const order of [wanted, "ipv4first", "verbatim"]) {
    try {
      dns.setDefaultResultOrder(order);
      if (order !== wanted) {
        console.warn(
          `[opencode-free-bridge] DNS_RESULT_ORDER=${wanted} is not supported by this Node (${process.versions.node}); using ${order}`
        );
      }
      return order;
    } catch {}
  }
  return null;
})();
const http = require("http");
const crypto = require("crypto");
let VERSION = "1.5.0";
try {
  VERSION = require("./package.json").version || VERSION;
} catch {}
const { effectiveMaxTokens } = require("./token-budget");
const { handleAnthropicMessages, handleCountTokens } = require("./anthropic");

/**
 * Load a sibling module, or a fallback when the file is not on disk yet.
 *
 * This exists because of a real upgrade path: 2.1.0's self-updater had no
 * `proxy.js`/`panel.js` in its file list, so updating that install to 2.2.0
 * wrote a `server.js` that required modules the updater never fetched. A hard
 * `require` turned that into a crash loop (`Cannot find module './proxy'`)
 * after the restart, with no way back except reinstalling. A missing optional
 * module must degrade to direct egress, never prevent the process from booting.
 *
 * Only a missing *own* module is tolerated. If `proxy.js` exists but requires
 * something absent, that is a broken install and the error must surface.
 */
function loadLocalModule(name, fallback) {
  try {
    return require(`./${name}`);
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND" || !String(err.message).includes(`'./${name}'`)) throw err;
    return fallback;
  }
}

const PROXY_FALLBACK = {
  getProxyUrl: () => "",
  withProxy: (init) => init,
  netFetch: (url, init) => fetch(url, init),
  describe: () => ({
    mode: "direct",
    proxy: null,
    hasCredentials: false,
    source: "none",
    locked: false,
    configPath: null,
    error: "proxy.js belum terpasang; egress langsung. Jalankan ulang install.sh.",
  }),
  setProxyUrl: () => ({
    ok: false,
    error: "proxy.js belum terpasang. Jalankan ulang install.sh atau tunggu perbaikan otomatis.",
  }),
  testProxy: async () => ({ ok: false, error: "proxy.js belum terpasang." }),
};

const PANEL_FALLBACK = {
  renderPanel: () =>
    "<!doctype html><meta charset=\"utf-8\"><title>opencode-free-bridge</title>" +
    "<body style=\"font:16px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem\">" +
    "<h1>Instalasi belum lengkap</h1>" +
    "<p><code>proxy.js</code> dan <code>panel.js</code> tidak ditemukan di direktori ini. " +
    "Bridge tetap berjalan dengan egress langsung. Jalankan ulang " +
    "<code>install.sh</code> untuk memasang panel.</p></body>",
};

// Egress proxy and the panel that configures it. Loaded before anything else
// touches the network so the first request already honours a saved proxy.
let proxy = loadLocalModule("proxy", PROXY_FALLBACK);
let panel = loadLocalModule("panel", PANEL_FALLBACK);

/**
 * Local modules this server requires by relative path. The self-updater uses
 * this to refuse an update that would install a `server.js` whose imports are
 * not part of the release, and boot uses it to repair a half-installed tree.
 */
function localRequires(source) {
  const names = new Set();
  // Strip comments first: the doc comment above names `require("./x")` as an
  // example, and scanning it produced a bogus `x.js` dependency.
  const text = String(source || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // `require("./x")` and the tolerant `loadLocalModule("x", …)` loader both
  // name a file that must be present for this server to work.
  for (const re of [/\brequire\(\s*["']\.\/([A-Za-z0-9._-]+)["']\s*\)/g, /\bloadLocalModule\(\s*["']([A-Za-z0-9._-]+)["']/g]) {
    let match;
    while ((match = re.exec(text))) {
      if (match[1].endsWith(".json")) continue;
      const name = match[1].endsWith(".js") ? match[1] : `${match[1]}.js`;
      names.add(name);
    }
  }
  return [...names];
}

/**
 * Fetch files that `server.js` requires but that are not on disk.
 *
 * 2.1.0 shipped a self-updater whose file list predated `proxy.js`/`panel.js`,
 * so an update to 2.2.0 wrote a server that could not boot. That install now
 * starts with the fallbacks above; this repairs it on the next boot instead of
 * leaving the panel permanently unavailable. Best-effort: a failure keeps the
 * fallback, never blocks startup.
 */
async function repairMissingModules(dir = __dirname) {
  const fs = require("fs");
  const path = require("path");
  const required = new Set(localRequires(fs.readFileSync(path.join(dir, "server.js"), "utf8")));
  for (const name of ["proxy.js", "panel.js"]) required.add(name);
  const missing = [...required].filter((f) => !fs.existsSync(path.join(dir, f)));
  const repaired = [];
  const failed = [];
  for (const file of missing) {
    try {
      const res = await fetch(`${UPDATE_BASE_URL}/${file}?cb=${Date.now()}`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text || text.length < 20) throw new Error("empty response");
      new Function(text.replace(/^#!.*\n/, ""));
      const tmp = path.join(dir, `.${file}.repair.${process.pid}`);
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, path.join(dir, file));
      repaired.push(file);
    } catch (err) {
      failed.push(`${file}: ${err.message}`);
    }
  }
  if (repaired.length && path.resolve(dir) === path.resolve(__dirname)) {
    proxy = loadLocalModule("proxy", PROXY_FALLBACK);
    panel = loadLocalModule("panel", PANEL_FALLBACK);
    console.log(`[opencode-free-bridge] Repaired missing module(s): ${repaired.join(", ")}`);
  } else if (repaired.length) {
    console.log(`[opencode-free-bridge] Repaired missing module(s): ${repaired.join(", ")}`);
  }
  if (failed.length) {
    console.warn(
      `[opencode-free-bridge] Could not repair ${failed.join(", ")}; ` +
        "running with direct egress. Re-run install.sh to fix this install."
    );
  }
  return { repaired, failed };
}

const PORT = parseInt(process.env.PORT || "20129", 10);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || "120000", 10);
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
const GATE_RETRY_COOLDOWN_MS = parseInt(
  process.env.GATE_RETRY_COOLDOWN_MS || "30000",
  10
);
const CORS_ORIGIN = process.env.CORS_ORIGIN !== undefined ? process.env.CORS_ORIGIN : "";
// Optional egress relay. When set, every upstream inference request is sent to
// this relay URL instead of directly to opencode.ai, with the real origin and
// path carried in x-relay-target / x-relay-path (the same header contract
// 9Router's Cloudflare/Vercel/Deno/Netlify relays speak). The relay performs
// the final fetch, so upstream sees the relay's egress IP. Empty = direct.
const UPSTREAM_RELAY_URL = (process.env.UPSTREAM_RELAY_URL || "").trim();

/**
 * Origin-only label for `/health`. The configured relay URL may carry
 * credentials or a token in the query string; those must not be handed to any
 * client that can reach the local health endpoint.
 */
function relayLabel(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "configured";
  }
}

// Wire endpoints. These are *defaults*; the live values come from identity.js,
// which resolves them from the upstream provider catalog (`opencode.api` in
// models.opencode.ai/api.json) at refresh time. Reading them per request means
// a /zen/v1 → /inference/v1 style migration applies without a restart.
const OPENCODE_RESPONSES_URL =
  process.env.OPENCODE_RESPONSES_URL || "https://opencode.ai/inference/v1/responses";
const OPENCODE_CHAT_URL =
  process.env.OPENCODE_CHAT_URL || "https://opencode.ai/inference/v1/chat/completions";
const OPENCODE_MODELS_URL =
  process.env.OPENCODE_MODELS_URL || "https://opencode.ai/inference/v1/models";
const OPENCODE_RELEASES_ATOM_URL =
  process.env.OPENCODE_RELEASES_ATOM_URL || "https://github.com/anomalyco/opencode/releases.atom";
const UPDATE_HINT =
  "Update opencode-free-bridge: curl -fsSL https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/install.sh | bash";
// Self-update (like the CLI's `update: auto`): poll this repo's package.json and
// replace the installed files when a newer release exists. Enabled by default;
// AUTO_UPDATE=0 disables it. Files are syntax-checked before being swapped in,
// and the swap is rename-per-file, so a partial download can never leave a
// broken install.
const UPDATE_BASE_URL =
  process.env.OPENCODE_BRIDGE_UPDATE_BASE ||
  "https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main";
const AUTO_UPDATE = process.env.AUTO_UPDATE !== "0" && process.env.AUTO_UPDATE !== "false";
const UPDATE_FILES = [
  "package.json",
  "identity.js",
  "token-budget.js",
  "verify.js",
  "gate-drill.js",
  "transport-fingerprint.js",
  "transport-baseline.json",
  "tunnel-doctor.sh",
  "proxy.js",
  "panel.js",
  "egress-proxy.js",
  "anthropic.js",
  "server.js",
  "THIRD_PARTY_NOTICES.md",
];
let updateInFlight = null;
let lastUpdateCheck = 0;
const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Compare two `x.y.z` versions. Returns true when `remote` is newer.
 */
function isNewerVersion(current, remote) {
  const a = String(current).split(".").map(Number);
  const b = String(remote).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const av = Number.isFinite(a[i]) ? a[i] : 0;
    const bv = Number.isFinite(b[i]) ? b[i] : 0;
    if (bv !== av) return bv > av;
  }
  return false;
}

/**
 * The CLI's `update: auto`, in miniature: check this repo's published
 * package.json, and when it is newer, download every shipped file into a temp
 * file, syntax-check the JS, then rename them into place and exit so the
 * service manager restarts us. Any failure leaves the running install intact.
 *
 * Deliberately *not* on the request path: it runs alongside model discovery,
 * at most once per UPDATE_CHECK_TTL_MS.
 */
async function checkAndApplyUpdate() {
  if (!AUTO_UPDATE) return { updated: false, reason: "disabled" };
  if (updateInFlight) return updateInFlight;
  if (Date.now() - lastUpdateCheck < UPDATE_CHECK_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  const fs = require("fs");
  const path = require("path");
  if (
    process.env.AUTO_UPDATE !== "1" &&
    process.env.AUTO_UPDATE !== "force" &&
    !process.env.OPENCODE_BRIDGE_UPDATE_BASE &&
    fs.existsSync(path.join(__dirname, ".git"))
  ) {
    return { updated: false, reason: "git-checkout" };
  }
  updateInFlight = (async () => {
    lastUpdateCheck = Date.now();
    const tmpFiles = [];
    const cb = Date.now();
    try {
      const pkgRes = await proxy.netFetch(`${UPDATE_BASE_URL}/package.json?cb=${cb}`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(8000),
      });
      if (!pkgRes.ok) throw new Error(`HTTP ${pkgRes.status} fetching package.json`);
      const remotePkg = await pkgRes.json();
      const remoteVersion = String(remotePkg?.version || "").trim();
      if (!/^\d+\.\d+\.\d+$/.test(remoteVersion)) throw new Error("invalid remote version");
      if (!isNewerVersion(VERSION, remoteVersion)) {
        return { updated: false, reason: "up-to-date" };
      }

      for (const file of UPDATE_FILES) {
        const res = await proxy.netFetch(`${UPDATE_BASE_URL}/${file}?cb=${cb}`, {
          headers: { "Cache-Control": "no-cache" },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${file}`);
        const text = await res.text();
        if (!text || text.length < 20) throw new Error(`empty response for ${file}`);
        if (file.endsWith(".js")) {
          try {
            new Function(text.replace(/^#!.*\n/, ""));
          } catch (err) {
            throw new Error(`syntax check failed for ${file}: ${err.message}`);
          }
        } else if (file.endsWith(".json")) {
          try {
            JSON.parse(text);
          } catch (err) {
            throw new Error(`invalid JSON in ${file}: ${err.message}`);
          }
        } else if (file.endsWith(".sh")) {
          // `new Function` cannot parse bash. Check the shebang here and let
          // `bash -n` parse it below, once it is on disk.
          if (!/^#!.*\b(ba)?sh\b/.test(text)) throw new Error(`${file} is not a shell script`);
        }
        const tmpPath = path.join(__dirname, `.${file}.tmp.${process.pid}`);
        fs.writeFileSync(tmpPath, text, "utf8");
        if (file.endsWith(".sh")) {
          let parsed = true;
          try {
            require("child_process").execFileSync("bash", ["-n", tmpPath], {
              stdio: "ignore",
              timeout: 5000,
            });
          } catch (err) {
            // No bash on this host is not a syntax failure; the shebang check
            // above is all we can do there. Anything else is a real rejection.
            if (!err || err.code !== "ENOENT") {
              try {
                fs.unlinkSync(tmpPath);
              } catch {}
              parsed = false;
              throw new Error(`syntax check failed for ${file}: ${err.message}`);
            }
          }
          if (parsed) fs.chmodSync(tmpPath, 0o755);
        }
        tmpFiles.push({ tmpPath, targetPath: path.join(__dirname, file) });
      }

      // A release can add a module that an older `UPDATE_FILES` list does not
      // name. 2.1.0 -> 2.2.0 did exactly that: the new server.js required
      // ./proxy and ./panel, the old updater never fetched them, and the
      // restart crash-looped. Read the *incoming* server.js and stage every
      // local module it imports, so the file list in the running process can
      // never be the reason a valid release fails to boot.
      const incoming = tmpFiles.find((f) => path.basename(f.targetPath) === "server.js");
      if (incoming) {
        const declared = new Set(tmpFiles.map((f) => path.basename(f.targetPath)));
        for (const file of localRequires(fs.readFileSync(incoming.tmpPath, "utf8"))) {
          if (declared.has(file) || fs.existsSync(path.join(__dirname, file))) continue;
          const res = await proxy.netFetch(`${UPDATE_BASE_URL}/${file}?cb=${cb}`, {
            headers: { "Cache-Control": "no-cache" },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching required module ${file}`);
          const text = await res.text();
          if (!text || text.length < 20) throw new Error(`empty response for required module ${file}`);
          try {
            new Function(text.replace(/^#!.*\n/, ""));
          } catch (err) {
            throw new Error(`syntax check failed for required module ${file}: ${err.message}`);
          }
          const tmpPath = path.join(__dirname, `.${file}.tmp.${process.pid}`);
          fs.writeFileSync(tmpPath, text, "utf8");
          tmpFiles.push({ tmpPath, targetPath: path.join(__dirname, file) });
          declared.add(file);
          console.log(`[opencode-free-bridge] Staged newly required module ${file}`);
        }
      }

      for (const { tmpPath, targetPath } of tmpFiles) fs.renameSync(tmpPath, targetPath);
      console.log(
        `[opencode-free-bridge] Self-updated ${VERSION} → ${remoteVersion}; exiting for service restart.`
      );
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
      return { updated: true, version: remoteVersion };
    } catch (err) {
      for (const { tmpPath } of tmpFiles) {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {}
      }
      console.warn(`[opencode-free-bridge] Self-update skipped: ${err.message}`);
      return { updated: false, error: err.message };
    } finally {
      updateInFlight = null;
    }
  })();
  return updateInFlight;
}

function isFreeTierCliGateError(status, errType, errMsg) {
  if (errType === "FreeTierError" || errType === "UpgradeRequired") return true;
  // 426 is the version-floor handshake: upstream names the minimum client
  // version it will accept. Treat it as a gate signal so the identity layer can
  // adopt that floor and retry.
  if (status === 426) return true;
  if (status !== 403 && status !== 401) return false;
  const m = String(errMsg || "").toLowerCase();
  return (
    m.includes("freetiererror") ||
    m.includes("free tier") ||
    m.includes("free models") ||
    m.includes("opencode cli") ||
    m.includes("only available in opencode") ||
    m.includes("upgrade required") ||
    m.includes("or newer is required")
  );
}
const identity = require("./identity");

/**
 * Wire endpoints for this request. Environment variables pin them; otherwise
 * the values derived from the upstream provider catalog are used, falling back
 * to the shipped defaults until the first successful refresh. Resolved per
 * call, so a catalog change applies on the next request.
 */
function resolveEndpoints(modelId = null) {
  const derived = identity.getEndpoints(modelId);
  return {
    responsesUrl: process.env.OPENCODE_RESPONSES_URL || derived.responsesUrl || OPENCODE_RESPONSES_URL,
    chatUrl: process.env.OPENCODE_CHAT_URL || derived.chatUrl || OPENCODE_CHAT_URL,
    modelsUrl: process.env.OPENCODE_MODELS_URL || derived.modelsUrl || OPENCODE_MODELS_URL,
  };
}

// The identity (user-agent, session-id format, header set) is owned by
// identity.js, which derives it from opencode's public source and refreshes it
// lazily — on request, never on a timer. `currentUserAgent` mirrors it for the
// few call sites that need a plain string.
let currentUserAgent = process.env.OPENCODE_USER_AGENT || identity.getUserAgent();

function syncUserAgent() {
  if (!process.env.OPENCODE_USER_AGENT) currentUserAgent = identity.getUserAgent();
  return currentUserAgent;
}

/**
 * Send an inference request to `url`, optionally through the configured egress
 * relay. The relay contract is the one 9Router's deployable relays speak:
 * POST <relay> with `x-relay-target: <origin>` and `x-relay-path: <path>`, and
 * the relay replays method/headers/body at that origin. The origin and path
 * never travel in the URL, so a relay deployed at a bare workers.dev hostname
 * works unchanged.
 *
 * The request body is serialized once by the caller and passed as a string, so
 * every retry path can replay it.
 *
 * A configured egress proxy applies to whichever URL is finally fetched, so a
 * relay deployment can itself be dialled through the proxy.
 *
 * `egressUrl` pins the egress for this call. The chat handler picks one egress
 * per request and reuses it across retries, so a retry that must stay on the IP
 * that answered does not silently move to a different one mid-conversation.
 * Without it, a pool picks per call.
 */
function upstreamFetch(url, init, egressUrl = null) {
  if (!UPSTREAM_RELAY_URL) return proxy.netFetch(url, init, egressUrl);
  const parsed = new URL(url);
  const headers = { ...(init.headers || {}) };
  headers["x-relay-target"] = parsed.origin;
  headers["x-relay-path"] = parsed.pathname + parsed.search;
  return proxy.netFetch(UPSTREAM_RELAY_URL, { ...init, headers }, egressUrl);
}

/**
 * Send a request through the chosen egress, and move to the next pool entry when
 * the egress itself is unreachable.
 *
 * A dead proxy is not an upstream refusal: nothing reached upstream, so retrying
 * on another entry costs one connection, while returning a 500 to the client
 * wastes the request entirely. This is the failure mode a pool exists to absorb.
 *
 * With one proxy (or none) there is nothing to fail over to, so the transport
 * error is rethrown for the caller's existing handling.
 */
async function egressFetch(url, init, state) {
  try {
    const res = await upstreamFetch(url, init, state.egressUrl);
    state.transportFailures = 0;
    return res;
  } catch (err) {
    const pool = proxy.describe().pool;
    const canFailover = pool && pool.active && pool.enabled > 1;
    if (!canFailover || !state.egressUrl) throw err;

    proxy.markFailure(state.egressUrl, { reason: `transport: ${err.message}`.slice(0, 200) });
    const next = proxy.pick({ exclude: state.egressUrl });
    if (!next.url || next.url === state.egressUrl) throw err;

    console.warn(
      `[opencode-free-bridge] Egress ${
        proxy.displayHost(state.egressUrl) || "direct"
      } unreachable (${err.message}); retrying through ${proxy.displayHost(next.url) || "direct"}`
    );
    state.egress = next;
    state.egressUrl = next.url;
    state.transportFailures = (state.transportFailures || 0) + 1;
    // One hop only. A pool where every entry is down must surface the error
    // instead of walking the whole list inside a single client request.
    return upstreamFetch(url, init, state.egressUrl);
  }
}

/**
 * Cooldown implied by an upstream `Retry-After` header, in milliseconds.
 *
 * A spent free-tier allowance answers 429 with `Retry-After` set to the seconds
 * until the daily reset (observed ~77415s). Honouring it means a spent egress
 * stays out of rotation until the allowance actually returns, instead of being
 * retried every few minutes and burning a request on each attempt.
 *
 * Returns null when the header is missing or unparseable, so callers fall back
 * to their previous fixed cooldown. Delta-seconds is the form upstream sends;
 * an HTTP-date is also accepted because the header allows it.
 */
function retryAfterMs(res) {
  const raw = res?.headers?.get?.("retry-after");
  if (!raw) return null;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) {
    const secs = parseInt(text, 10);
    return secs > 0 ? secs * 1000 : null;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  const delta = at - Date.now();
  return delta > 0 ? delta : null;
}
/**
 * Record a refusal against the egress that produced it.
 *
 * An empty URL is the `direct` pool entry, which is a real egress, so this
 * cannot test truthiness: only a missing state means "nothing to record".
 */
function recordEgressFailure(state, { reason, cooldownMs = null } = {}) {
  const url = state && state.egressUrl;
  if (url === null || url === undefined) return;
  const pool = proxy.describe().pool;
  if (!pool || !pool.active) return;
  proxy.markFailure(url, { reason, cooldownMs });
}

function isValidV2UserAgent(ua) {
  const match = String(ua || "")
    .trim()
    .match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  return Boolean(match) && parseInt(match[1], 10) >= 2;
}

/**
 * A User-Agent the free-tier gate accepts, or the identity's own.
 *
 * Measured (clean egress, `read` tool present): a request without a
 * `User-Agent`, with a bare `opencode`, or with `Mozilla/5.0 …` / `curl/8.18.0`
 * is refused with the same 403 FreeTierError that a blocked IP gets. Only the
 * `opencode/<channel>/<semver>/<name>` shape passes, and the version is not
 * checked for freshness (`opencode/9.9.9` was accepted).
 *
 * `OPENCODE_USER_AGENT` is an operator override, so it is honoured — but an
 * override that the gate would reject is reported instead of silently
 * producing a 403 that looks like an allowance problem.
 */
function gateSafeUserAgent() {
  const override = process.env.OPENCODE_USER_AGENT;
  if (override && /^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/i.test(String(override).trim())) {
    return String(override).trim();
  }
  if (override) {
    console.warn(
      "[opencode-free-bridge] OPENCODE_USER_AGENT does not match the shape the free-tier gate accepts " +
        "(opencode/<channel>/<semver>/<name>); using the derived identity instead"
    );
  }
  const derived = syncUserAgent();
  if (/^opencode\//i.test(derived)) return derived;
  // Last resort: the derived identity itself is malformed. Keep the request
  // shaped as an opencode client rather than sending something the gate refuses.
  return "opencode/latest/0.0.0/cli";
}

// --- ID Generator (matches OpenCode v2 CLI format) ---
// The shape (charset, total length, multiplier, prefix) comes from identity.js,
// which derives it from opencode's own `packages/schema/src/identifier.ts`.
// Kept as a thin wrapper here so existing call sites and tests keep working.
function createId(descending, timestamp = Date.now()) {
  return identity.createId(descending, timestamp);
}

// Live model list, discovered from upstream at boot and refreshed hourly.
// No hardcoded fallback: an empty list honestly means "upstream not reached
// yet", so gateways/harnesses apply their own fallback instead of being
// served a stale lie.
let activeModels = [];
let cachedModelsPayload = '{"object":"list","data":[]}';
let lastDiscoveryTime = 0;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // Auto-refresh every 1 hour
// Single-flight: concurrent /v1/models hits after TTL expiry share one upstream
// fetch instead of stampeding (50 parallel GETs = 1 upstream call, not 50).
let discoveryInFlight = null;
// CLI version feed is slow (5s timeout) and changes rarely: cache 6h, refresh
// in parallel so model discovery never waits on it.
let lastCliVersionCheckTime = 0;
const CLI_VERSION_TTL_MS = 6 * 60 * 60 * 1000;

function rebuildDiscoveryPayloads() {
  cachedModelsPayload = JSON.stringify({ object: "list", data: activeModels });
}
rebuildDiscoveryPayloads();

function isLocalOrigin(origin) {
  if (typeof origin !== "string" || !origin) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin.trim());
}

const LOOPBACK_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

/** Hostname from a `Host` header, without the port. IPv6 literals keep brackets off. */
function hostnameOf(hostHeader) {
  const raw = String(hostHeader || "").trim();
  if (!raw) return "";
  const v6 = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (v6) return v6[1];
  return raw.replace(/:\d+$/, "");
}

/**
 * Admin-surface gate: the panel and `/api/proxy` can change where every
 * outbound request goes, so they must not be reachable from a foreign page or
 * a rebound DNS name.
 *
 * The bridge is a local tool with no authentication. Two browser attacks
 * matter here:
 *
 *   - CSRF: any page the operator visits could POST to 127.0.0.1 and point the
 *     egress at an attacker's proxy. A form POST cannot set
 *     `Content-Type: application/json`, so requiring it removes the simple
 *     request; the Origin/Sec-Fetch-Site checks below cover the rest.
 *   - DNS rebinding: an attacker domain resolving to 127.0.0.1 makes the
 *     browser send `Host: evil.example`, which a loopback-only listener would
 *     otherwise accept.
 *
 * `PANEL_ALLOWED_HOSTS` (comma-separated) adds names for a reverse proxy or a
 * deliberate LAN deployment. A bind address other than a wildcard is allowed
 * automatically, so `HOST=192.168.1.5` keeps its own panel working.
 */
function allowedAdminHosts() {
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const extra of String(process.env.PANEL_ALLOWED_HOSTS || "").split(",")) {
    const trimmed = extra.trim().toLowerCase();
    if (trimmed) hosts.add(trimmed);
  }
  const bound = String(HOST || "").toLowerCase();
  const wildcard = !bound || bound === "0.0.0.0" || bound === "::" || bound === "[::]";
  if (!wildcard) hosts.add(bound);
  if (wildcard) {
    // A wildcard bind is usually reached by one of this machine's own
    // addresses (LAN IP, VPS public IP). Those are safe to accept and make
    // `HOST=0.0.0.0` usable without configuration; a rebound attacker domain
    // is still not in this set. Domain names go in PANEL_ALLOWED_HOSTS.
    const os = require("os");
    for (const list of Object.values(os.networkInterfaces())) {
      for (const addr of list || []) {
        if (addr && addr.address) hosts.add(String(addr.address).toLowerCase());
      }
    }
  }
  return hosts;
}

function adminRequestError(req) {
  const host = hostnameOf(req.headers?.host).toLowerCase();
  if (!host) return "Header Host wajib ada.";
  if (!allowedAdminHosts().has(host)) {
    return `Host ${host} tidak diizinkan. Panel hanya menerima host lokal; tambahkan ke PANEL_ALLOWED_HOSTS bila ini memang disengaja.`;
  }

  const site = String(req.headers?.["sec-fetch-site"] || "").toLowerCase();
  if (site === "cross-site") {
    return "Permintaan lintas-situs ditolak. Buka panel langsung dari host ini.";
  }

  // An Origin must match the Host this request was sent to (which covers the
  // panel itself and an SSH/tunnel forward that keeps the browser's origin),
  // or be explicitly allow-listed in CORS_ORIGIN. A loopback origin on a
  // *different* port is another local service, not this panel, so it is not
  // trusted automatically.
  const origin = String(req.headers?.origin || "").trim();
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return `Origin ${origin} tidak valid.`;
    }
    const configured = String(CORS_ORIGIN || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (originHost !== host && !configured.includes(origin)) {
      return `Origin ${origin} tidak diizinkan.`;
    }
  }
  return null;
}


/**
 * Kept for callers and tests that expect the old name. Consults the handshake
 * and derives the rest of the recipe from opencode's source.
 *
 * This is a *poll*: it bypasses the identity freshness guard so the release
 * check happens on its own schedule, but adoption still follows UPDATE_MODE.
 * In `reactive` mode a release that has not moved the gate is recorded (and
 * reported by /health as `identity.available`) without being adopted — forcing
 * it here would silently turn `reactive` into `always` every 6h.
 *
 * The `lastCliVersionCheckTime` guard keeps the handshake read at most once per
 * CLI_VERSION_TTL_MS even when called repeatedly.
 */
async function refreshCliVersion() {
  const now = Date.now();
  if (now - lastCliVersionCheckTime < CLI_VERSION_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  const result = await identity.refresh({ recheck: true });
  syncUserAgent();
  lastCliVersionCheckTime = now;
  return result;
}

// Auto-discovery from OpenCode upstream gateway.
// Single-flight: concurrent callers share one in-flight fetch.
// The CLI-version feed refreshes in parallel (fire-and-forget) so a slow
// 5s feed never delays the model list.
async function discoverModels() {
  if (discoveryInFlight) return discoveryInFlight;
  discoveryInFlight = (async () => {
    refreshCliVersion().catch(() => {});
    checkAndApplyUpdate().catch(() => {});
    try {
    const res = await proxy.netFetch(resolveEndpoints().modelsUrl, {
      headers: {
        "Authorization": "Bearer public",
        "User-Agent": currentUserAgent,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = json.data || [];

    // The gateway is the live source of truth: its /models entries carry the
    // price applied right now (`cost.text.input/output.price`), and an id it
    // stopped serving disappears from the list. The provider catalog still
    // supplies families, reasoning flags and endpoints, but its `status` field
    // lags — it kept `minimax-m3.1-flash-free` marked deprecated after upstream
    // was already serving it free. So the gateway's price is reconciled into the
    // verdicts first, and only an unknown price falls back to the catalog's
    // ruling (or, before the first catalog read, to the `-free` suffix).
    const promoted = identity.applyGatewayPricing(items);
    if (promoted.length > 0) {
      console.log(
        `[opencode-free-bridge] Gateway price list re-ruled: ${promoted.slice(0, 6).join(", ")}${promoted.length > 6 ? ` (+${promoted.length - 6})` : ""}`
      );
    }
    const ownedBy = new Map(items.map((i) => [String(i.id || "").toLowerCase(), i]));
    const kept = [];
    const seen = new Set();
    const keep = (id) => {
      const lower = String(id).toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      kept.push(id);
    };
    // Only ids the gateway is serving right now are advertised: a catalog-free
    // model missing from /models is retired, and advertising it sends clients
    // into a 404 that burns their per-IP burst quota.
    for (const item of items) {
      const id = String(item.id || "");
      const lower = id.toLowerCase();
      if (lower.startsWith("jev-")) continue; // systemone evaluator models
      const verdict = identity.getCatalogVerdict(lower);
      if (verdict === "free") {
        keep(id);
        continue;
      }
      if (verdict) continue; // paid or deprecated, and the gateway agrees
      // No ruling at all: the catalog has not been read yet in this process.
      // Guess from the name, then correct itself on the next refresh.
      if (!lower.endsWith("-free") && !lower.includes("-contributor") && lower !== "big-pickle") continue;
      keep(id);
    }

    const freeItems = kept.map((id) => ({
      id,
      object: "model",
      owned_by: ownedBy.get(String(id).toLowerCase())?.owned_by || "opencode",
    }));

    if (freeItems.length > 0) {
      activeModels = freeItems;
      rebuildDiscoveryPayloads();
      lastDiscoveryTime = Date.now();
      console.log(`[opencode-free-bridge] Auto-discovered ${activeModels.length} free models from upstream gateway.`);
      return;
    }
    } catch (err) {
      console.warn(`[opencode-free-bridge] Auto-discovery warning: ${err.message}. Model list stays empty until upstream answers.`);
    }
  })();
  try {
    return await discoveryInFlight;
  } finally {
    discoveryInFlight = null;
  }
}

function normalizeModel(rawModel) {
  if (typeof rawModel !== "string") return "";
  const stripped = rawModel.trim().replace(/^(opencode\/|oc\/|zen\/|9router\/|openai\/)/i, "").trim();
  if (!stripped) return "";
  // A name that is already a real model id is passed through untouched; only a
  // shorthand is resolved. The catalog's families are consulted first, so a
  // revision that retired keeps resolving to a live sibling without a bridge
  // release; the static table below remains for names the catalog does not
  // group (and for the case where the catalog has not been read yet).
  const lower = stripped.toLowerCase();
  const verdict = identity.getCatalogVerdict(lower);
  // This bridge is free-tier only: it sends `Authorization: Bearer public` and
  // has no way to authenticate a paid request. A paid id would therefore only
  // earn a 401/402 upstream, so it is not passed through — an alias that points
  // at one is allowed to fall through to a free sibling instead.
  if (verdict === "free") return stripped;
  const derived = identity.resolveModelAlias(lower);
  if (derived) return derived;
  // No static table behind this. A shorthand either derives from the catalog's
  // own `family` field or it is passed through as a literal model id. Anything
  // else would be a name this bridge invented, and an invented name can outlive
  // the model it points at.
  return stripped;
}

// Protocol routing: which models want /responses instead of /chat/completions.
//
// The shipped default is empty on purpose. It used to seed two `muse-spark`
// ids, both of which the catalog now marks deprecated, plus a `includes("muse")`
// fallback — a name rule for a model family that no longer exists. Every live
// free model speaks the chat lane (catalog: `@ai-sdk/openai-compatible`), and a
// model that needs the other lane is learned from upstream's own
// `ModelProtocolUnsupported` reply, which is a fact rather than a guess.
// `RESPONSES_MODELS` still seeds the set when upstream ships a Responses-only
// model before the bridge has met it.
const responsesModelSet = new Set(
  (process.env.RESPONSES_MODELS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const chatModelSet = new Set();

function isResponsesModel(modelId) {
  const lower = String(modelId || "").trim().toLowerCase();
  if (!lower) return false;
  if (chatModelSet.has(lower)) return false;
  if (responsesModelSet.has(lower)) return true;
  return false;
}

/** Test hook: forget learned lane assignments (they persist by design). */
function __resetProtocolLanes() {
  chatModelSet.clear();
  responsesModelSet.clear();
  for (const m of (process.env.RESPONSES_MODELS || "").split(",")) {
    const id = m.trim().toLowerCase();
    if (id) responsesModelSet.add(id);
  }
}

function markProtocolSupport(modelId, useResponses) {
  const lower = String(modelId || "").trim().toLowerCase();
  if (!lower) return;
  if (useResponses) {
    responsesModelSet.add(lower);
    chatModelSet.delete(lower);
  } else {
    chatModelSet.add(lower);
    responsesModelSet.delete(lower);
  }
}

// --- Tool fingerprint (dynamic) -------------------------------------------
//
// Upstream /inference/v1 validates the `tools` array in the request body, and
// this is the layer that has moved most often: first the array had to exist,
// then it had to contain specific tool names, then (per 9router#4837) the exact
// schemas. Hardcoding those definitions here meant a code change every time.
//
// The definitions now come from identity.js, which derives them at the release
// commit SHA named by the update handshake:
//   1. source        — `read.ts` / `shell.ts` at that immutable commit
//   2. DEFAULT_TOOLS — shipped fallback, used until a source read succeeds
//
// The names below are kept for the call sites and tests that predate the
// change; they are read from the live profile, not frozen at load time.
function getFingerprintNames(scope = null, modelId = null) {
  // Only the names actually sent upstream. A capture carries ~10 tools but
  // `TOOL_PROFILE_SCOPE=core` sends a subset; treating the unsent ones as
  // fingerprints would alias an unrelated client tool (`glob` → `glob_client`)
  // for no reason. The model matters too: the release swaps `edit`+`write` for
  // `patch` on GPT models, so the fingerprint set follows the same rule.
  return identity.getToolList(false, scope, modelId).map((t) => t.function.name);
}

function getFingerprintDefinitions() {
  return identity.getTools();
}

function getCanonicalTools(flat, scope = null, modelId = null) {
  return identity.getToolList(flat, scope, modelId);
}

/**
 * Stable JSON for schema comparison. Key order must not affect equality: two
 * definitions that differ only in property order are the same schema.
 */
function stableStringify(val) {
  if (!val || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(stableStringify).join(",") + "]";
  const keys = Object.keys(val).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(val[k])).join(",") + "}";
}

const EMPTY_MAP = Object.freeze(new Map());
const paramSigCache = new WeakMap();
function getParamSig(params) {
  if (!params || typeof params !== "object") return stableStringify(params);
  let sig = paramSigCache.get(params);
  if (sig === undefined) {
    sig = stableStringify(params);
    paramSigCache.set(params, sig);
  }
  return sig;
}

function buildIpThrottleHeaders(freeTierMsg, diagnostic = null) {
  if (!freeTierMsg) return { "Content-Type": "application/json" };
  const retryAfterSec = Math.max(1, Math.ceil((GATE_RETRY_COOLDOWN_MS || 30000) / 1000));
  const headers = {
    "Content-Type": "application/json",
    "Retry-After": String(retryAfterSec),
    // `shape-ok` means the request carried every anchor the gate checks, so the
    // refusal is about this egress. `shape-rejected` means the bridge produced
    // a request the gate refuses — a bridge bug that returns the identical
    // upstream error. Callers that alert on this can tell the two apart.
    "X-OpenCode-Gate": diagnostic && diagnostic.shapeOk === false ? "shape-rejected" : "ip-throttled",
  };
  if (diagnostic && diagnostic.logId) headers["X-OpenCode-Log-Id"] = diagnostic.logId;
  return headers;
}

function resolveIpThrottleStatus(upstreamStatus, freeTierMsg) {
  if (freeTierMsg && process.env.IP_LIMIT_STATUS === "429") return 429;
  return upstreamStatus;
}

/**
 * Is this client-supplied tool already byte-identical to the fingerprint we
 * would inject? If so it can be passed through untouched.
 */
function isExactFingerprintDef(tool, key) {
  const want = identity.getTools()[key];
  if (!want || !tool || typeof tool !== "object") return false;
  const def = tool.function && typeof tool.function === "object" ? tool.function : tool;
  return (
    def.description === want.description &&
    getParamSig(def.parameters) === getParamSig(want.parameters)
  );
}

function buildPlaceholderNote(appendedNames) {
  if (!Array.isArray(appendedNames) || appendedNames.length === 0) return "";
  const list = appendedNames.map((n) => `\`${n}\``).join(" or ");
  return appendedNames.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

function getToolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (typeof tool.name === "string") return tool.name.trim();
  if (tool.function && typeof tool.function.name === "string") return tool.function.name.trim();
  return "";
}

// Client tools whose name alone makes upstream answer 429 FreeUsageLimitError.
// Measured on 2026-11-03 against the live gateway with an otherwise passing
// request: a tool called `run_code` is refused, while the same schema under
// `run-code`, `runcode`, `run_program` or `code_exec` answers 200, and
// `run_code_client` is refused too, so the match is on the substring. The
// refusal carries the quota wording, which makes it look like a spent
// allowance; it is a name filter. `prepareToolsWithFingerprint` renames such a
// tool on the way out and restores the client's name on the way back.
const BLOCKED_TOOL_NAME_PATTERNS = [/run_code/i];
const BLOCKED_TOOL_ALIAS = "run_program";

function isBlockedToolName(name) {
  return BLOCKED_TOOL_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Merge the client's tools with the fingerprint tools the gate requires.
 *
 * Three cases per required tool:
 *   - client already sends it verbatim  → keep the client's copy
 *   - client sends the same name with a different schema → rename the client's
 *     copy (`read_client`) so both survive, and map responses back
 *   - client does not send it at all   → append the fingerprint definition
 *
 * The definitions are resolved per call from identity.js, so a profile update
 * takes effect on the next request without a restart.
 */
function prepareToolsWithFingerprint(clientTools = [], flat = false, scope = null, modelId = null) {
  const fingerprintNames = getFingerprintNames(scope, modelId);
  const canonical = getCanonicalTools(flat, scope, modelId);
  const canonicalByName = new Map(
    canonical.map((t) => [flat ? t.name : t.function.name, t])
  );

  if (!Array.isArray(clientTools) || clientTools.length === 0) {
    return {
      tools: canonical,
      appended: fingerprintNames,
      placeholderNote: buildPlaceholderNote(fingerprintNames),
      aliasToOriginal: EMPTY_MAP,
      originalToAlias: EMPTY_MAP,
    };
  }

  const aliasToOriginal = new Map();
  const originalToAlias = new Map();
  const normalized = [];
  const takenNames = new Set(clientTools.map(getToolName).filter(Boolean));
  const presentExactFingerprints = new Set();

  for (const t of clientTools) {
    const name = getToolName(t);
    if (!name) continue;
    const def = t.function && typeof t.function === "object" ? t.function : t;
    const description = def.description || "";
    const parameters = def.parameters || { type: "object", properties: {} };

    if (isBlockedToolName(name)) {
      let alias = BLOCKED_TOOL_ALIAS;
      for (let i = 2; takenNames.has(alias); i++) {
        alias = `${BLOCKED_TOOL_ALIAS}${i}`;
      }
      takenNames.add(alias);
      aliasToOriginal.set(alias, name);
      originalToAlias.set(name, alias);
      normalized.push(
        flat
          ? { type: "function", name: alias, description, parameters }
          : { type: "function", function: { name: alias, description, parameters } }
      );
      continue;
    }

    if (fingerprintNames.includes(name)) {
      if (presentExactFingerprints.has(name)) continue;
      if (isExactFingerprintDef(t, name)) {
        presentExactFingerprints.add(name);
        normalized.push(
          flat
            ? { type: "function", name, description, parameters, strict: false }
            : { type: "function", function: { name, description, parameters } }
        );
        continue;
      }
      // Client defined its own tool under a name the gate fingerprints: alias
      // it so the exact fingerprint can still be injected alongside.
      if (originalToAlias.has(name)) continue;
      let alias = `${name}_client`;
      for (let i = 2; takenNames.has(alias); i++) {
        alias = `${name}_client${i}`;
      }
      takenNames.add(alias);
      aliasToOriginal.set(alias, name);
      originalToAlias.set(name, alias);
      normalized.push(
        flat
          ? { type: "function", name: alias, description, parameters }
          : { type: "function", function: { name: alias, description, parameters } }
      );
      continue;
    }

    normalized.push(
      flat
        ? { type: "function", name, description, parameters }
        : { type: "function", function: { name, description, parameters } }
    );
  }

  const appended = [];
  for (const name of fingerprintNames) {
    if (presentExactFingerprints.has(name)) continue;
    const def = canonicalByName.get(name);
    if (!def) continue;
    normalized.push(def);
    appended.push(name);
  }

  return {
    tools: normalized,
    appended,
    placeholderNote:
      appended.length === fingerprintNames.length
        ? buildPlaceholderNote(fingerprintNames)
        : buildPlaceholderNote(appended),
    aliasToOriginal,
    originalToAlias,
  };
}

function prepareResponsesTools(clientTools = [], modelId = null) {
  return prepareToolsWithFingerprint(clientTools, true, null, modelId).tools;
}

function prepareChatTools(clientTools = [], modelId = null) {
  return prepareToolsWithFingerprint(clientTools, false, null, modelId).tools;
}

function restoreClientToolName(name, aliasToOriginal) {
  if (!name || !aliasToOriginal || aliasToOriginal.size === 0) return name;
  return aliasToOriginal.get(name) || name;
}

function extractContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text" && typeof p.text === "string") return p.text;
        if (p?.text) return String(p.text);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content ? JSON.stringify(content) : "";
}

// First-N-chars text without ever serializing the whole value: strings are
// sliced directly, arrays join only text parts up to the limit, objects fall
// back to a bounded stringify. Used for the headerless session signature so
// a multi-MB system prompt is never JSON.stringified just for a hash.
function shortText(content, limit = 1000) {
  if (typeof content === "string") return content.slice(0, limit);
  if (Array.isArray(content)) {
    let out = "";
    for (const p of content) {
      if (out.length >= limit) break;
      if (typeof p === "string") out += p;
      else if (p?.type === "text" && typeof p.text === "string") out += p.text;
      else if (p?.text) out += String(p.text);
    }
    return out.slice(0, limit);
  }
  if (!content) return "";
  try {
    return JSON.stringify(content).slice(0, limit);
  } catch {
    return String(content).slice(0, limit);
  }
}

function messageSignatureSample(content, limit = 1000) {
  if (typeof content === "string") {
    const len = content.length;
    if (len <= limit) return `${len}:${content}`;
    const half = Math.floor(limit / 2);
    return `${len}:${content.slice(0, half)}..${content.slice(len - half)}`;
  }
  if (Array.isArray(content)) {
    const head = shortText(content, Math.floor(limit / 2));
    const last = content[content.length - 1];
    const tail = shortText(last ? [last] : [], Math.floor(limit / 2));
    return `${content.length}:${head}..${tail}`;
  }
  return shortText(content, limit);
}

function transformResponsesContent(content, role = "user") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const hasNonText = content.some(
      (p) =>
        p &&
        typeof p === "object" &&
        (p.type === "image_url" || p.type === "input_image" || p.type === "input_file")
    );
    if (!hasNonText) return extractContent(content);
    const textType = role === "assistant" ? "output_text" : "input_text";
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") {
        parts.push({ type: textType, text: p });
      } else if (p && typeof p === "object") {
        if (p.type === "text" || p.type === "input_text" || p.type === "output_text") {
          parts.push({ type: textType, text: String(p.text ?? "") });
        } else if (p.type === "image_url") {
          const imageUrl = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
          if (imageUrl) parts.push({ type: "input_image", image_url: imageUrl });
        } else if (p.type === "input_image" || p.type === "input_file") {
          parts.push(p);
        } else if (p.text) {
          parts.push({ type: textType, text: String(p.text) });
        }
      }
    }
    return parts;
  }
  return extractContent(content);
}

// Convert OpenAI messages to OpenCode input format (for Responses API)
function transformToResponsesInput(messages = [], originalToAlias = null) {
  const input = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (m.role === "system" || m.role === "developer") {
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id || "call_unknown",
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      if (m.content) {
        input.push({
          role: "assistant",
          content: transformResponsesContent(m.content, "assistant"),
        });
      }
      for (const tc of m.tool_calls) {
        const fn = tc.function || {};
        const rawName = fn.name || "unknown";
        const mappedName =
          originalToAlias && originalToAlias.has(rawName) ? originalToAlias.get(rawName) : rawName;
        input.push({
          type: "function_call",
          call_id: tc.id || `call_${crypto.randomBytes(8).toString("hex")}`,
          name: mappedName,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
        });
      }
      continue;
    }
    const role = m.role || "user";
    input.push({ role, content: transformResponsesContent(m.content, role) });
  }
  return input;
}

/**
 * The harness environment block the real CLI appends to every system prompt.
 *
 * Measured against the live gateway on 2026-10-25: a request whose system
 * prompt does not contain this block is answered with `429 FreeUsageLimitError`,
 * byte-for-byte the message the gateway uses for an exhausted allowance. The
 * trigger is the `<env>` block with a `Working directory:` line, not the prompt
 * length and not the model: a 12 KB generic prompt is refused, a 65-byte
 * `<env>Working directory: /tmp</env>` is accepted, and the same split holds
 * for big-pickle and mimo. That made a *shape* problem look like a quota
 * problem — the CLI answered while the bridge did not, in the same minute.
 *
 * The CLI builds this from its own session context, so the values here are the
 * bridge's honest equivalents: its working directory and whether that is a git
 * repository. Reproducing the block is what makes the bridge's request
 * indistinguishable from the CLI's on this gate.
 *
 * Cached per working directory: the values cannot change while the process runs
 * (the bridge never chdir's), and probing them costs a `git` subprocess —
 * measured at 2.5 ms, which is real money on every request.
 */
let harnessEnvBlockCache = { cwd: null, block: "" };
function buildHarnessEnvBlock() {
  const cwd = process.cwd();
  if (harnessEnvBlockCache.cwd === cwd && harnessEnvBlockCache.block) {
    return harnessEnvBlockCache.block;
  }
  let isRepo = "no";
  try {
    const { execFileSync } = require("child_process");
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    isRepo = "yes";
  } catch {}
  const block = [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${cwd}`,
    `  Workspace root folder: ${cwd}`,
    `  Is directory a git repo: ${isRepo}`,
    "  Platform: " + process.platform,
    "</env>",
  ].join("\n");
  harnessEnvBlockCache = { cwd, block };
  return block;
}
/**
 * Append the harness env block to a system prompt unless the client already
 * sent one. A client that forwards the CLI's own prompt (or any prompt with an
 * `<env>` block) keeps it verbatim — only the missing anchor is added.
 */
function withHarnessEnvBlock(systemText) {
  const text = typeof systemText === "string" ? systemText : "";
  if (/<env>[\s\S]*?Working directory:/.test(text)) return text;
  const block = buildHarnessEnvBlock();
  return text.trim() ? `${text.replace(/\s+$/, "")}\n\n${block}` : block;
}
function extractSystemInstructions(messages = [], explicitInstructions = "", placeholderNote = "") {
  const parts = [];
  if (typeof explicitInstructions === "string" && explicitInstructions.trim()) {
    parts.push(explicitInstructions.trim());
  }
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== "system" && m.role !== "developer")) continue;
    const text = extractContent(m.content).trim();
    if (text) parts.push(text);
  }
  if (placeholderNote) {
    parts.push(placeholderNote);
  }
  return withHarnessEnvBlock(parts.join("\n\n"));
}

function transformChatMessages(messages = [], originalToAlias = null, placeholderNote = "") {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (
      originalToAlias &&
      originalToAlias.size > 0 &&
      m.role === "assistant" &&
      Array.isArray(m.tool_calls)
    ) {
      out.push({
        ...m,
        tool_calls: m.tool_calls.map((tc) => {
          const fnName = tc?.function?.name;
          if (fnName && originalToAlias.has(fnName)) {
            return { ...tc, function: { ...tc.function, name: originalToAlias.get(fnName) } };
          }
          return tc;
        }),
      });
    } else {
      out.push(m);
    }
  }

  if (placeholderNote) {
    const first = out[0];
    if (first?.role === "system" || first?.role === "developer") {
      if (typeof first.content === "string") {
        out[0] = { ...first, content: `${first.content}\n\n${placeholderNote}` };
      } else if (Array.isArray(first.content)) {
        out[0] = { ...first, content: [...first.content, { type: "text", text: `\n\n${placeholderNote}` }] };
      } else {
        out.unshift({ role: "system", content: placeholderNote });
      }
    } else {
      out.unshift({ role: "system", content: placeholderNote });
    }
  }

  // The gateway refuses a request whose system prompt lacks the harness `<env>`
  // block with the same `429 FreeUsageLimitError` it uses for an exhausted
  // allowance. See buildHarnessEnvBlock. A client that already forwarded the
  // CLI's prompt keeps its own block; only the missing anchor is added.
  const sysIndex = out.findIndex((m) => m?.role === "system" || m?.role === "developer");
  if (sysIndex === -1) {
    out.unshift({ role: "system", content: buildHarnessEnvBlock() });
  } else {
    const sys = out[sysIndex];
    if (typeof sys.content === "string") {
      out[sysIndex] = { ...sys, content: withHarnessEnvBlock(sys.content) };
    } else if (Array.isArray(sys.content)) {
      const text = extractContent(sys.content);
      if (!/<env>[\s\S]*?Working directory:/.test(text)) {
        out[sysIndex] = {
          ...sys,
          content: [...sys.content, { type: "text", text: `\n\n${buildHarnessEnvBlock()}` }],
        };
      }
    } else {
      out[sysIndex] = { ...sys, content: buildHarnessEnvBlock() };
    }
  }
  return out;
}

function buildUpstreamPayload(body, targetModel, useResponses, scope = null) {
  const requestedTokens =
    body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  const maxTokens = effectiveMaxTokens(requestedTokens, targetModel, body);
  const { tools, placeholderNote, aliasToOriginal, originalToAlias } = prepareToolsWithFingerprint(
    body.tools,
    useResponses,
    scope,
    targetModel
  );
  if (useResponses) {
    const upstreamBody = {
      model: targetModel,
      input: transformToResponsesInput(body.messages, originalToAlias),
      stream: true,
      max_output_tokens: maxTokens,
      tools,
      tool_choice: "auto",
    };
    const instructions = extractSystemInstructions(
      body.messages,
      body.instructions,
      placeholderNote
    );
    if (instructions) {
      upstreamBody.instructions = instructions;
    }
    if (typeof body.temperature === "number") upstreamBody.temperature = body.temperature;
    if (typeof body.top_p === "number") upstreamBody.top_p = body.top_p;
    return { upstreamBody, aliasToOriginal };
  }

  // Field names and order match the CLI's own request: `max_completion_tokens`
  // (not the legacy `max_tokens`), `store: false`, and `tools` before `stream`.
  // Upstream accepts both spellings today, but sending the CLI's exact shape
  // removes a difference that costs nothing to erase.
  const upstreamBody = {
    model: targetModel,
    messages: transformChatMessages(body.messages, originalToAlias, placeholderNote),
    tools,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: maxTokens,
    store: false,
  };
  if (typeof body.temperature === "number") upstreamBody.temperature = body.temperature;
  if (typeof body.top_p === "number") upstreamBody.top_p = body.top_p;
  if (body.stop !== undefined) upstreamBody.stop = body.stop;
  if (body.response_format !== undefined) upstreamBody.response_format = body.response_format;
  if (body.reasoning_effort !== undefined) upstreamBody.reasoning_effort = body.reasoning_effort;

  // Upstream v2 rejects tool_choice: "none" with 403 FreeTierError.
  if (body.tool_choice && body.tool_choice !== "none") {
    if (
      typeof body.tool_choice === "object" &&
      body.tool_choice.function?.name &&
      originalToAlias.has(body.tool_choice.function.name)
    ) {
      upstreamBody.tool_choice = {
        ...body.tool_choice,
        function: {
          ...body.tool_choice.function,
          name: originalToAlias.get(body.tool_choice.function.name),
        },
      };
    } else {
      upstreamBody.tool_choice = body.tool_choice;
    }
  }

  return { upstreamBody, aliasToOriginal };
}

/**
 * Mint a fresh session id after the identity changed.
 *
 * The id is derived from the recipe, so an id minted *before* a refresh encodes
 * the shape the gate just rejected. The self-heal path therefore has to replace
 * it — replaying the stale id would send the same rejected request and fail
 * identically. The cache entry is dropped for the same reason: otherwise the
 * next request from this client would get the stale id back.
 */
function regenerateSessionId(req, body, staleId) {
  for (const [key, entry] of sessionCache) {
    if (entry.sessionId === staleId) sessionCache.delete(key);
  }
  return getPersistentSessionId(req, body);
}

/**
 * The project id the CLI would send from this checkout.
 *
 * Measured against a real CLI capture: the header equals
 * `sha1("git-remote:github.com/<owner>/<repo>")` — the remote URL with scheme
 * and `.git` stripped. With no remote the CLI hashes the directory path
 * (`sha1("directory:<abs path>")`), and an `opencode` file in the directory
 * overrides both. Derived once and cached: a checkout does not move.
 */
let cachedProjectId = null;
function getProjectId() {
  if (cachedProjectId) return cachedProjectId;
  try {
    const fs = require("fs");
    const path = require("path");
    const crypto = require("crypto");
    const cwd = process.cwd();

    // An `opencode` file wins, exactly as it does in the CLI.
    const marker = path.join(cwd, "opencode");
    if (fs.existsSync(marker)) {
      const value = fs.readFileSync(marker, "utf8").trim();
      if (value) return (cachedProjectId = value);
    }

    // Git remote, normalised the way the CLI's `url()` helper does it.
    let remote = "";
    try {
      const { execFileSync } = require("child_process");
      remote = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim();
    } catch {}
    if (remote) {
      const normalized = remote
        .replace(/^[a-z]+:\/\//i, "")   // drop scheme
        .replace(/^git@([^:]+):/i, "$1/") // scp-style
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");
      if (normalized) {
        return (cachedProjectId = crypto
          .createHash("sha1")
          .update(`git-remote:${normalized}`)
          .digest("hex"));
      }
    }

    return (cachedProjectId = crypto
      .createHash("sha1")
      .update(`directory:${cwd}`)
      .digest("hex"));
  } catch {
    return (cachedProjectId = "global");
  }
}

function buildUpstreamHeaders(req, sessionId) {
  const downstreamUa = req?.headers?.["user-agent"] || "";
  const ua = isValidV2UserAgent(downstreamUa) ? downstreamUa : gateSafeUserAgent();
  const client = req?.headers?.["x-opencode-client"];
  // `x-opencode-project` is not a constant: the CLI derives it as
  // `sha1("git-remote:" + host + path)` for a repo, `sha1("directory:" + path)`
  // otherwise, or the contents of an `opencode` file in the directory. Sending
  // the literal "global" is a shape the CLI never emits, so it is derived here
  // the same way — from this bridge's own checkout. A client that supplies the
  // header still wins.
  const project = req?.headers?.["x-opencode-project"] || getProjectId();
  // The gate header set is derived by identity.js from upstream's own request
  // builder, so a header added upstream starts being sent on the next request
  // after a refresh. Values this bridge cannot derive are reported, not sent
  // empty: an empty required header is worse than an absent one.
  const { headers: gateHeaders } = identity.buildGateHeaders({
    userAgent: ua,
    client: client === "desktop" || client === "cli" ? client : "cli",
    project: String(project),
    sessionId,
  });
  return {
    "Authorization": "Bearer public",
    "Content-Type": "application/json",
    // The CLI sends `*/*` here (it always streams via the body, not the Accept
    // header). Matching it costs nothing and removes a difference the gate
    // could one day start looking at.
    "Accept": "*/*",
    // W3C trace context, which the CLI emits on every request. The values are
    // random per request — measured: they carry no relation to the session id —
    // so this generates them the same way rather than deriving them. Both
    // headers describe one 128-bit trace with a 64-bit span; `b3` adds the
    // parent span id.
    ...buildTraceHeaders(),
    ...gateHeaders,
  };
}

/** A fresh W3C trace context, shaped like the CLI's. */
function buildTraceHeaders() {
  const traceId = crypto.randomBytes(16).toString("hex");
  const spanId = crypto.randomBytes(8).toString("hex");
  const parentSpanId = crypto.randomBytes(8).toString("hex");
  return {
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

/**
 * Upstream can answer HTTP 200 and then report a failure *inside* the stream
 * (`data: {"error":{...}}`, e.g. "Streaming response failed: [503] ...").
 * Left unhandled, a non-streaming client is handed a 200 with `content: null`
 * and `finish_reason: "stop"` — a fake success. Returns the error text when the
 * event is an error, otherwise null.
 */
function extractStreamError(ev) {
  const err = ev?.error;
  if (!err) return null;
  if (typeof err === "string") return err;
  return err.message || err.type || JSON.stringify(err);
}

function extractResponsesFinishReason(ev, hasToolCalls) {
  const status = ev?.response?.status;
  const reason = ev?.response?.incomplete_details?.reason;
  if (ev?.type === "response.incomplete" || status === "incomplete") {
    if (reason === "content_filter") return "content_filter";
    return "length";
  }
  if (hasToolCalls) return "tool_calls";
  return "stop";
}

// Persistent session cache — preserves upstream prompt/KV cache across turns (LRU)
const sessionCache = new Map();
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 3 * 3600 * 1000;
let lastFailedGateRetryTime = 0;
let lastFailedGateRetryEpoch = -1;
// Last IP-level abuse block seen from upstream, if any. Kept apart from the
// retry cooldown because the two have different causes and different advice:
// the cooldown is a per-IP allowance window, the block is the gateway refusing
// this network outright.
let lastIpAbuseAt = 0;
// The last gate rejection's correlation id and the shape audit that was true
// when it happened. `x-opencode-log-id` is the only handle upstream gives for
// a rejected request, so it is recorded rather than discarded — it is what a
// support request or a bug report needs to be actionable.
let lastGateDiagnostic = null;
let lastUpstreamError = null;

/**
 * Which gate anchors the *actual* outgoing request carried.
 *
 * The gate requires a tool named `read` and an `opencode/*` User-Agent with a
 * session header (see GATE_ANCHOR_TOOL_NAMES / GATE_ANCHOR_HEADER_NAMES in
 * identity.js). When a 403 comes back, these are what distinguishes "this
 * bridge sent an unacceptable shape" from "upstream refuses this egress".
 * Reporting the distinction is the whole point: both produce an identical
 * FreeTierError body.
 */
function auditGateShape(upstreamBody, headers) {
  const tools = Array.isArray(upstreamBody?.tools) ? upstreamBody.tools : [];
  const toolNames = tools.map((t) => t?.function?.name || t?.name).filter(Boolean);
  // Header names are compared case-insensitively: the audit must not report a
  // missing anchor just because the same header arrived with different casing.
  const headerKey = (name) =>
    Object.keys(headers || {}).find((k) => k.toLowerCase() === name);
  const hasHeader = (name) => headerKey(name) !== undefined;
  const ua = String(headers?.[headerKey("user-agent")] || "");
  const sessionHeaders = ["x-opencode-session", "x-session-affinity", "x-session-id"].filter(
    hasHeader
  );
  return {
    hasReadTool: toolNames.includes("read"),
    toolCount: toolNames.length,
    userAgentOk: /^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/i.test(ua),
    userAgent: ua,
    sessionHeaders,
  };
}

function upstreamLogIdOf(upstreamRes) {
  return typeof upstreamRes?.headers?.get === "function"
    ? upstreamRes.headers.get("x-opencode-log-id")
    : null;
}

/**
 * Answer an upstream IP-level abuse block.
 *
 * Terminal by construction: the block is keyed to the egress network, so the
 * identity layer is not consulted, no session id is re-minted, and the request
 * is not replayed — measured (and confirmed by upstream's own issue tracker)
 * as a network flag that no client shape can clear. The refusal reaches the
 * client verbatim; `X-OpenCode-Gate: ip-abuse` lets callers and `verify.js`
 * tell it apart from the shape gate without parsing the message.
 */
function respondIpAbuse(res, status, errType, errMsg, logId, model) {
  lastIpAbuseAt = Date.now();
  lastGateDiagnostic = {
    at: lastIpAbuseAt,
    kind: "ip-abuse",
    status,
    logId: logId || null,
    message: errMsg,
    model,
  };
  console.warn(
    `[opencode-free-bridge] Upstream IP-abuse block (${status}): ${errMsg} — not refreshing or retrying; the gateway keys this to this network's IP, so no identity change can clear it` +
      (logId ? ` [x-opencode-log-id: ${logId}]` : "")
  );
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-OpenCode-Gate": "ip-abuse",
    ...(logId ? { "X-OpenCode-Log-Id": logId } : {}),
  });
  return res.end(
    JSON.stringify({
      error: {
        message: errMsg,
        type: errType || "FreeTierError",
        code: status,
      },
    })
  );
}

const origSessionCacheClear = sessionCache.clear.bind(sessionCache);
sessionCache.clear = () => {
  lastFailedGateRetryTime = 0;
  lastFailedGateRetryEpoch = -1;
  lastIpAbuseAt = 0;
  lastUpstreamError = null;
  return origSessionCacheClear();
};

function getPersistentSessionId(req, body) {
  const headers = req?.headers || {};
  const rawHeaderKey =
    headers["x-opencode-session"] ||
    headers["x-opencode-session-id"] ||
    headers["x-session-id"] ||
    headers["session-id"] ||
    headers["x-conversation-id"] ||
    headers["x-9r-session-id"];
  const headerKey = Array.isArray(rawHeaderKey)
    ? String(rawHeaderKey[0] || "").slice(0, 256)
    : rawHeaderKey
      ? String(rawHeaderKey).slice(0, 256)
      : "";
  // Fast path (common case): a session header is present, so no message
  // hashing is needed at all. The conv-signature hash below only runs for
  // headerless clients, and slices BEFORE stringify so a huge system prompt
  // never gets serialized just to take its first 1000 chars.
  let lookupKey = headerKey ? "hdr:" + headerKey : null;
  if (!lookupKey) {
    const msgs = body && Array.isArray(body.messages) ? body.messages : [];
    if (msgs.length > 0) {
      const sig =
        messageSignatureSample(msgs[0]?.content, 1000) +
        "::" +
        messageSignatureSample(msgs[1]?.content, 1000);
      if (sig !== "::") {
        lookupKey =
          "conv:" + crypto.createHash("sha256").update(sig).digest("hex").slice(0, 20);
      }
    }
  }
  const now = Date.now();
  if (lookupKey && sessionCache.has(lookupKey)) {
    const entry = sessionCache.get(lookupKey);
    if (now - entry.lastSeen < SESSION_TTL_MS) {
      // Re-insert to update Map insertion order for O(1) LRU eviction
      sessionCache.delete(lookupKey);
      entry.lastSeen = now;
      sessionCache.set(lookupKey, entry);
      return entry.sessionId;
    }
    sessionCache.delete(lookupKey);
  }
  const newSessionId = identity.createSessionId(true);
  if (lookupKey) {
    if (sessionCache.size >= MAX_SESSIONS) {
      for (const [k, v] of sessionCache) {
        if (now - v.lastSeen >= SESSION_TTL_MS) sessionCache.delete(k);
      }
      if (sessionCache.size >= MAX_SESSIONS) {
        const lruKey = sessionCache.keys().next().value;
        if (lruKey !== undefined) sessionCache.delete(lruKey);
      }
    }
    sessionCache.set(lookupKey, { sessionId: newSessionId, lastSeen: now });
  }
  return newSessionId;
}

/**
 * `/api/proxy` — read and change the egress proxy; `/api/proxy/test` — prove a
 * candidate reaches upstream before it is trusted.
 *
 * The panel is the only caller, so the contract stays small: JSON in, JSON out,
 * one error field. Credentials are accepted on write and never echoed on read.
 */
async function handleProxyApi(req, res, pathname) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  if (pathname === "/api/proxy" && (req.method === "GET" || req.method === "HEAD")) {
    return send(200, proxy.describe());
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(405, { error: "Gunakan GET untuk status atau POST untuk mengubah." });
  }

  let payload = {};
  try {
    const text = await readRequestBody(req, 128 * 1024);
    payload = text ? JSON.parse(text) : {};
  } catch (err) {
    return send(err.statusCode === 413 ? 413 : 400, { error: `Body tidak valid: ${err.message}` });
  }
  if (!payload || typeof payload !== "object") {
    return send(400, { error: "Body harus berupa objek JSON." });
  }

  // Pool management. `entries` replaces the whole pool; `pool: []` clears it.
  // Kept apart from the single-proxy `url` field so one request cannot mean two
  // different things, and so an operator can keep a single proxy configured as a
  // fallback while experimenting with a pool.
  const hasPool = Object.prototype.hasOwnProperty.call(payload, "entries") ||
    Object.prototype.hasOwnProperty.call(payload, "pool");
  if (hasPool && pathname === "/api/proxy") {
    const spec = Object.prototype.hasOwnProperty.call(payload, "entries")
      ? { entries: payload.entries, strategy: payload.strategy, cooldownMs: payload.cooldownMs, maxCooldownMs: payload.maxCooldownMs }
      : payload.pool;
    const result = proxy.setPool(spec);
    if (!result.ok) return send(400, { error: result.error });
    console.log(
      `[opencode-free-bridge] Egress pool: ${result.pool.enabled}/${result.pool.size} aktif, strategi ${result.pool.strategy}`
    );
    return send(200, result);
  }

  if (pathname === "/api/proxy/test" && Array.isArray(payload.entries)) {
    const { entries } = payload;
    if (entries.length === 0) return send(400, { error: "Daftar entries kosong." });
    // Probe without installing: the caller is evaluating candidates.
    const results = [];
    for (const [index, entry] of entries.entries()) {
      const parsed = proxy.parsePoolEntry(entry, index);
      if (!parsed.ok) {
        results.push({ id: `#${index + 1}`, host: null, ok: false, error: parsed.error });
        continue;
      }
      const verdict = await proxy.testProxy(parsed.entry.url, { probeUrl: resolveEndpoints().modelsUrl });
      results.push({
        id: parsed.entry.id,
        label: parsed.entry.label,
        host: proxy.displayHost(parsed.entry.url),
        ok: verdict.ok,
        apiStatus: verdict.apiStatus || null,
        exitIp: verdict.exitIp || null,
        latencyMs: verdict.latencyMs || null,
        error: verdict.error || null,
      });
    }
    const anyOk = results.some((r) => r.ok);
    return send(anyOk ? 200 : 502, { ok: anyOk, entries: results });
  }

  if (pathname === "/api/proxy/test" && typeof payload.url === "string") {
    const result = await proxy.testProxy(payload.url, { probeUrl: resolveEndpoints().modelsUrl });
    return send(result.ok ? 200 : 502, result);
  }

  if (typeof payload.url === "string") {
    const result = proxy.setProxyUrl(payload.url);
    if (!result.ok) return send(400, { error: result.error });
    console.log(
      `[opencode-free-bridge] Egress ${result.mode === "proxy" ? `via proxy ${result.proxy}` : "direct"}`
    );
    return send(200, result);
  }

  return send(400, { error: "Body harus berisi 'url' (satu proxy) atau 'entries' (pool)." });
}

function readRequestBody(req, maxBytes = MAX_BODY_BYTES) {
  // Early reject: if the client declares a huge body, refuse without reading
  // a single byte instead of buffering up to the limit first.
  const declared = parseInt(req?.headers?.["content-length"] || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = new Error(`Request body exceeds limit of ${maxBytes} bytes`);
    err.statusCode = 413;
    err.code = "payload_too_large";
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let done = false;
    const cleanup = () => {
      if (typeof req.off === "function") {
        req.off("error", onError);
        req.off("data", onData);
        req.off("end", onEnd);
      } else if (typeof req.removeListener === "function") {
        req.removeListener("error", onError);
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
      }
    };

    const onError = (err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        done = true;
        chunks.length = 0;
        cleanup();
        if (typeof req.pause === "function") req.pause();
        const err = new Error(`Request body exceeds limit of ${maxBytes} bytes`);
        err.statusCode = 413;
        err.code = "payload_too_large";
        reject(err);
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    req.on("error", onError);
    req.on("data", onData);
    req.on("end", onEnd);
  });
}

// --- HTTP Server ---
function handleRequest(req, res) {
  req.on("error", (err) => {
    console.warn("[opencode-free-bridge] request stream error:", err.message);
  });
  res.on("error", (err) => {
    console.warn("[opencode-free-bridge] response stream error:", err.message);
  });

  const reqOrigin = req.headers?.origin || "";
  const configuredOrigin = process.env.CORS_ORIGIN !== undefined ? process.env.CORS_ORIGIN : CORS_ORIGIN;
  if (configuredOrigin === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (configuredOrigin) {
    const allowed = configuredOrigin.split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.includes(reqOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", reqOrigin);
      res.setHeader("Vary", "Origin");
    }
  } else if (isLocalOrigin(reqOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", reqOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, X-Session-Id, Session-Id, X-Conversation-Id, X-9r-Session-Id, X-OpenCode-Session, X-OpenCode-Session-Id, X-Session-Affinity, X-OpenCode-Client, X-OpenCode-Project"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const rawUrl = req.url || "/";
  const qIdx = rawUrl.indexOf("?");
  const rawPath = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  const pathname = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.replace(/\/+$/, "") : rawPath;

  // Panel: the human-facing page. JSON consumers keep using /health, which is
  // why "/" is no longer an alias for the health document.
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "" || pathname === "/")) {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(req.method === "HEAD" ? undefined : denied);
    }
    const html = panel.renderPanel(proxy.describe(), { version: VERSION, port: PORT });
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(html),
      "X-Frame-Options": "DENY",
    });
    return res.end(req.method === "HEAD" ? undefined : html);
  }

  if (pathname === "/api/proxy" || pathname === "/api/proxy/test") {
    const denied = adminRequestError(req);
    if (denied) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: denied }));
    }
    // Only JSON can change the setting. `text/plain` is a CORS "simple
    // request", so accepting it would let any page POST here without a
    // preflight; refusing it is the structural half of the CSRF defence.
    if (req.method === "POST") {
      const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        res.writeHead(415, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Content-Type harus application/json." }));
      }
    }
    // `handleProxyApi` is async; an unexpected throw must become a 500 instead
    // of an unhandled rejection that leaves the socket hanging.
    handleProxyApi(req, res, pathname).catch((err) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: `Kesalahan internal: ${err.message}` }));
    });
    return;
  }

  // Health check
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const idState = identity.getState();
    const proxyState = proxy.describe();
    let usageView = null;
    try {
      usageView = proxy.describeUsage();
    } catch {}
    const gateThrottled =
      lastFailedGateRetryTime > 0 &&
      Date.now() - lastFailedGateRetryTime < GATE_RETRY_COOLDOWN_MS &&
      lastFailedGateRetryEpoch === (idState.epoch || 0);
    return res.end(
      JSON.stringify({
        status: "ok",
        provider: "opencode-free-bridge",
        version: VERSION,
        runtime: typeof Bun !== "undefined" ? `bun/${Bun.version}` : `node/${process.versions.node}`,
        discoveredModels: activeModels.length,
        // Egress in force. `mode` is what actually carries the request: the
        // pool when one is configured, otherwise a single proxy, otherwise the
        // relay, otherwise direct. `proxy.mode` only reports the configured
        // shape, so a relay-only deployment still reads as `relay` here.
        // Credentials are never included; every host in `proxy` is host:port.
        egress: {
          mode:
            proxyState.mode === "pool"
              ? "pool"
              : proxyState.mode === "proxy"
                ? "proxy"
                : UPSTREAM_RELAY_URL
                  ? "relay"
                  : "direct",
          ...(UPSTREAM_RELAY_URL ? { relay: relayLabel(UPSTREAM_RELAY_URL) } : {}),
          proxy: proxyState,
          // Per-egress wire traffic and token accounting (usage.json). The
          // phone entry here is the mobile-data cost of the bridge today.
          ...(usageView ? { usage: usageView } : {}),
        },
        identity: {
          userAgent: idState.userAgent,
          updateMode: idState.updateMode,
          sourceTag: idState.lastSourceTag,
          versionFloor: idState.versionFloor,
          lastCheckAgeMs: idState.lastCheckTime ? Date.now() - idState.lastCheckTime : null,
          ttlMs: idState.ttlMs,
          lastError: idState.lastRefreshError,
          release: idState.release,
          // Set in reactive mode when a release exists that has not been adopted
          // because the gate has not moved. `null` once adopted.
          available: idState.available,
          // The header names in force, and any the recipe asks for that this
          // bridge cannot fill — a non-empty `unsentHeaders` means a manual
          // mapping is needed before the next gate move is followed.
          headers: idState.headers,
          unsentHeaders: idState.unsentHeaders,
          // The values derived from upstream sources: the wire endpoints (from
          // the provider catalog) and the tool allowlist (from the release's
          // tool plugin sources). Visible because they are the layers that
          // change without a bridge release.
          endpoints: idState.endpoints,
          toolNames: idState.toolNames,
          tools: idState.tools,
          gate: {
            status: lastIpAbuseAt > 0 ? "ip-blocked" : gateThrottled ? "throttled" : "open",
            // The gateway keys an abuse block to the egress network, so there is
            // no known expiry to advertise. `ipBlockedSince` is the last time
            // upstream returned that refusal.
            ipBlockedSince: lastIpAbuseAt || null,
            throttledUntil: gateThrottled
              ? lastFailedGateRetryTime + GATE_RETRY_COOLDOWN_MS
              : null,
            cooldownMs: GATE_RETRY_COOLDOWN_MS,
            // The shape anchors the gate checks. Reported so a deployment can
            // confirm it is sending them without waiting for a 403.
            anchors: {
              tools: identity.GATE_ANCHOR_TOOL_NAMES.slice(),
              headers: identity.GATE_ANCHOR_HEADER_NAMES.slice(),
            },
            // The most recent gate rejection: what was sent, what was missing,
            // and upstream's own correlation id. `shapeOk: false` means the
            // bridge produced a request the gate refuses — not an IP problem.
            lastRejection: lastGateDiagnostic,
            lastUpstreamError,
          },
        },
      })
    );
  }

  // Model list (triggers async re-discovery when the hourly TTL expired)
  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    if (activeModels.length === 0) {
      discoverModels()
        .catch(() => {})
        .finally(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(cachedModelsPayload);
        });
      return;
    }
    if (Date.now() - lastDiscoveryTime > DISCOVERY_TTL_MS) {
      discoverModels().catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(cachedModelsPayload);
  }

  // Anthropic Messages API. Relays through this bridge's own chat route, so the
  // Anthropic path inherits the gate anchors, session minting, egress pool and
  // self-healing retries instead of duplicating them.
  if (req.method === "POST" && (pathname === "/v1/messages" || pathname === "/messages")) {
    handleAnthropicMessages(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
    });
    return;
  }
  if (
    req.method === "POST" &&
    (pathname === "/v1/messages/count_tokens" || pathname === "/messages/count_tokens")
  ) {
    handleCountTokens(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
    });
    return;
  }
  // Chat completions
  if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
    (async () => {
      let bodyText;
      try {
        bodyText = await readRequestBody(req);
      } catch (err) {
        if (err.statusCode === 413) {
          res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
          res.end(
            JSON.stringify({
              error: {
                message: err.message,
                type: "invalid_request_error",
                code: "payload_too_large",
              },
            })
          );
          res.once("finish", () => {
            if (typeof req.destroy === "function") req.destroy();
          });
          return;
        }
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "Failed to read request body", type: "invalid_request_error" },
            })
          );
        }
        return;
      }

      let body;
      try {
        body = JSON.parse(bodyText);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("Request body must be a JSON object");
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message: `Invalid JSON body: ${err.message}`,
              type: "invalid_request_error",
              code: "invalid_json",
            },
          })
        );
      }

      const targetModel = normalizeModel(body.model);
      if (!targetModel) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message: "Missing or empty required parameter: 'model'",
              type: "invalid_request_error",
              param: "model",
              code: "model_required",
            },
          })
        );
      }

      // Free tier only: this bridge sends `Authorization: Bearer public` and
      // cannot authenticate anything else, so a model the catalog prices above
      // zero can only fail upstream. Say that here — an upstream 401 ("no
      // session") sends the user hunting for a login that does not exist.
      const modelVerdict = identity.getCatalogVerdict(targetModel);
      if (modelVerdict && modelVerdict !== "free") {
        const isRetired = modelVerdict === "deprecated";
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message: isRetired
                ? `Model '${targetModel}' has been retired upstream. Free models are listed at /v1/models.`
                : `Model '${targetModel}' is not on the free tier, and this bridge has no account to run it with. Free models are listed at /v1/models.`,
              type: "invalid_request_error",
              param: "model",
              code: isRetired ? "model_deprecated" : "model_not_free",
            },
          })
        );
      }

      if (!Array.isArray(body.messages)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              message: "Missing or invalid required parameter: 'messages' must be an array",
              type: "invalid_request_error",
              param: "messages",
              code: "messages_required",
            },
          })
        );
      }

      const clientStream = Boolean(body.stream);

      // Lazy identity check: no timer runs in the background. The first request
      // after the TTL kicks off a refresh in the background and proceeds with
      // the current mask; the next request uses the refreshed one.
      identity.ensureFresh();
      syncUserAgent();

      let useResponses = isResponsesModel(targetModel);
      const sessionId = getPersistentSessionId(req, body);
      let retryHeaders = null;
      const upstreamHeaders = buildUpstreamHeaders(req, sessionId);

      const abortController = new AbortController();
      let timedOut = false;
      let clientDisconnected = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error("Upstream request timed out"));
      }, UPSTREAM_TIMEOUT_MS);

      const onClose = () => {
        if (!res.writableEnded) {
          clientDisconnected = true;
          abortController.abort(new Error("Client disconnected"));
        }
      };
      res.on("close", onClose);

      let reader = null;
      try {
        let { upstreamBody, aliasToOriginal } = buildUpstreamPayload(body, targetModel, useResponses);
        let liveEndpoints = resolveEndpoints(targetModel);
        let upstreamUrl = useResponses ? liveEndpoints.responsesUrl : liveEndpoints.chatUrl;

        // One egress per client request. Everything below — the protocol-lane
        // retry, the endpoint-migration retry, the 5xx retry, and the gate retry
        // — reuses it, because upstream ties a retry to the address that saw the
        // first attempt. Only two things move it: an unreachable proxy (the
        // request never left) and a gate rejection that names this egress as the
        // problem. Both are handled where they happen and update this state.
        const egressState = { egress: proxy.pick(), egressUrl: null, transportFailures: 0 };
        egressState.egressUrl = egressState.egress.url;
        const egressUrl = () => egressState.egressUrl;

        let upstreamRes = await egressFetch(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(upstreamBody),
          signal: abortController.signal,
        }, egressState);

        // If a newly released model requires the opposite protocol lane, learn it
        // and transparently retry once on the matching lane.
        if (!upstreamRes.ok && upstreamRes.status === 400) {
          const errText = await upstreamRes.text();
          let errJson;
          try {
            errJson = JSON.parse(errText);
          } catch {
            errJson = { message: errText };
          }
          const errType = errJson.error?.type || "";
          const errMsg = errJson.error?.message || errJson.message || "";
          if (
            errType === "ModelProtocolUnsupported" ||
            errMsg.includes("ModelProtocolUnsupported") ||
            errMsg.includes("does not support this protocol")
          ) {
            useResponses = !useResponses;
            markProtocolSupport(targetModel, useResponses);
            ({ upstreamBody, aliasToOriginal } = buildUpstreamPayload(body, targetModel, useResponses));
            upstreamUrl = useResponses ? liveEndpoints.responsesUrl : liveEndpoints.chatUrl;
            upstreamRes = await upstreamFetch(upstreamUrl, {
              method: "POST",
              headers: upstreamHeaders,
              body: JSON.stringify(upstreamBody),
              signal: abortController.signal,
            }, egressUrl());
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({
                error: {
                  message: errMsg || "Upstream error 400",
                  type: errType || "upstream_error",
                  code: 400,
                },
              })
            );
          }
        }

        // Endpoint migration. The provider catalog is the authority for the wire
        // base URL, so an upstream path move (the /zen/v1 → /inference/v1 move)
        // shows up as a 404/410 at the old path — not as a gate rejection. A 404
        // is otherwise indistinguishable from "this route does not exist", so
        // re-derive from the catalog and retry once, but only when the derived
        // URL actually differs. Replaying the same URL on a 404 would loop.
        // A body can only be read once. When an earlier branch has already
        // consumed it, the generic error path below must reuse the text instead
        // of reading an empty stream and reporting "Upstream error <status>".
        let consumedErrorText = null;
        if (!upstreamRes.ok && (upstreamRes.status === 404 || upstreamRes.status === 410)) {
          const staleUrl = upstreamUrl;
          let moveText = "";
          try {
            moveText = await upstreamRes.text();
          } catch {}
          consumedErrorText = moveText;
          // A 410 can also be about the *model*, not the route
          // (`{"error":{"type":"ModelDeprecated"}}`). Retrying such a request at
          // another URL would just repeat the same model-level answer, so the
          // endpoint heal only applies when the error does not name a model.
          let moveErrType = "";
          try {
            const j = JSON.parse(moveText);
            moveErrType = j?.error?.type || j?.type || "";
          } catch {}
          const modelLevelError = /model(deprecated|unavailable|protocolunsupported)/i.test(
            moveErrType
          );
          if (!modelLevelError) {
            await identity.refresh({ force: true }).catch(() => null);
            liveEndpoints = resolveEndpoints(targetModel);
            const derivedUrl = useResponses ? liveEndpoints.responsesUrl : liveEndpoints.chatUrl;
            if (derivedUrl && derivedUrl !== staleUrl) {
              console.warn(
                `[opencode-free-bridge] Upstream endpoint moved (${upstreamRes.status}): ${staleUrl} → ${derivedUrl}; retrying once`
              );
              upstreamUrl = derivedUrl;
              upstreamRes = await upstreamFetch(upstreamUrl, {
                method: "POST",
                headers: upstreamHeaders,
                body: JSON.stringify(upstreamBody),
                signal: abortController.signal,
              }, egressUrl());
              // The text above belonged to the response we just replaced. Reading
              // it for the new response would report the old error verbatim.
              consumedErrorText = null;
            }
          }
        }

        // Spent allowance on a pooled egress. A 429 means transport and request
        // shape were both accepted and only this IP's quota is gone, so the one
        // useful action is to spend the retry on a different IP instead of
        // replaying an identical request at an address upstream just refused.
        //
        // This walks the pool rather than failing over once. A single retry was
        // not enough: two spent IPs at the front handed the client a 429 while
        // the rest of the pool was healthy. The client should only see 429 when
        // every enabled member has been refused in this request — at that point
        // there is genuinely nothing left to try, and saying so is correct.
        if (!upstreamRes.ok && upstreamRes.status === 429) {
          const poolState = proxy.describe().pool;
          const canFailover = poolState && poolState.active && poolState.enabled > 1;
          recordEgressFailure(egressState, {
            reason: "allowance 429",
            cooldownMs: retryAfterMs(upstreamRes) ?? (poolState ? poolState.cooldownMs * 4 : null),
          });

          if (canFailover) {
            // Every egress already refused for *this* request. `pick()` skips
            // cooling entries, but a just-recorded failure is cooling too, so
            // this also prevents revisiting one. The cap guards a pool whose
            // entries resolve to the same URL.
            const tried = new Set();
            if (egressState.egressUrl !== null && egressState.egressUrl !== undefined) {
              tried.add(egressState.egressUrl);
            }
            const MAX = Math.max(2, poolState.enabled);

            for (let attempt = 0; attempt < MAX; attempt += 1) {
              // pick() excludes one entry, not a list. Pass the one we just
              // refused; it is also in cooldown now, so this is redundant
              // rather than load-bearing — which is the point.
              const next = proxy.pick({ exclude: egressState.egressUrl });
              // `cooling` means pick() found no ready candidate at all: every
              // member is already parked by an earlier request. Walking the pool
              // then spends one request per entry on an upstream that has
              // already refused each of them, which is exactly how an egress
              // that served nothing today still accumulates failures and gets
              // stamped with a fresh 429. Nothing healthy is left to try, so
              // fail fast and let Retry-After carry the wait instead.
              if (next.cooling) {
                console.warn(
                  `[opencode-free-bridge] Pool has no ready egress (${poolState.enabled} enabled, all cooling); not walking it`
                );
                break;
              }
              const key = next.url === null || next.url === undefined ? "@direct" : next.url;
              if (tried.has(key)) break;
              tried.add(key);

              console.warn(
                `[opencode-free-bridge] Egress ${
                  proxy.displayHost(egressState.egressUrl) || "direct"
                } is out of allowance (429); trying ${
                  proxy.displayHost(next.url) || "direct"
                } (${tried.size}/${poolState.enabled})`
              );
              egressState.egress = next;
              egressState.egressUrl = next.url;
              upstreamRes = await egressFetch(upstreamUrl, {
                method: "POST",
                headers: upstreamHeaders,
                body: JSON.stringify(upstreamBody),
                signal: abortController.signal,
              }, egressState);
              consumedErrorText = null;

              if (upstreamRes.status !== 429) break;

              // Still spent. Record with this response's own Retry-After so the
              // entry leaves rotation for the real reset window.
              recordEgressFailure(egressState, {
                reason: "allowance 429",
                cooldownMs: retryAfterMs(upstreamRes) ?? poolState.cooldownMs * 4,
              });
            }

            if (upstreamRes.status === 429) {
              console.warn(
                `[opencode-free-bridge] All ${tried.size} pooled egress(es) refused this request; exhausted the pool, returning 429`
              );
            }
          }
        }

        // Transient 5xx self-heal: upstream Workers intermittently drop empty-body
        // HTTP 500/502/503/504 responses (e.g. cf-placement: remote-IAD) during
        // free-inference degradation. Retry once with fresh trace/session headers.
        if (!upstreamRes.ok && upstreamRes.status >= 500 && upstreamRes.status < 600) {
          const first5xx = upstreamRes.status;
          const firstLogId =
            typeof upstreamRes.headers?.get === "function"
              ? upstreamRes.headers.get("x-opencode-log-id")
              : null;
          try {
            await upstreamRes.text();
          } catch {}
          const retry5xxSid = regenerateSessionId(req, body, sessionId);
          const retry5xxHeaders = buildUpstreamHeaders(req, retry5xxSid);
          console.warn(
            `[opencode-free-bridge] Upstream returned ${first5xx}` +
              (firstLogId ? ` [x-opencode-log-id: ${firstLogId}]` : "") +
              `; retrying once with fresh session`
          );
          upstreamRes = await upstreamFetch(upstreamUrl, {
            method: "POST",
            headers: retry5xxHeaders,
            body: JSON.stringify(upstreamBody),
            signal: abortController.signal,
          }, egressUrl());
          consumedErrorText = null;
        }

        // Self-healing identity. A gate rejection is identified by the error
        // *body*, not the status line: a 403 is only the gate when its type or
        // message says so, while 426 is the version-floor handshake by itself.
        // The body must therefore be read before the decision — passing empty
        // strings here made this branch unreachable for 403.
        if (!upstreamRes.ok) {
          let errText = consumedErrorText ?? "";
          if (consumedErrorText === null) {
            try {
              errText = await upstreamRes.text();
            } catch {
              errText = "";
            }
          }
          let errJson = null;
          try {
            errJson = JSON.parse(errText);
          } catch {
            errJson = null;
          }
          const errType = errJson?.error?.type || errJson?.type || "";
          const rawMsg =
            errJson?.error?.message ||
            errJson?.message ||
            errText ||
            `Upstream error ${upstreamRes.status}`;

          // Terminal branch. Upstream names an IP-level abuse block in the
          // message, and that is a different failure from the shape gate: the
          // gateway has flagged this network, so refreshing the recipe, minting
          // a new session id, or replaying the request cannot change the
          // answer. Measured against the gateway's own reports: the official
          // CLI gets the same refusal from the same IP. Return it verbatim and
          // leave the identity layer untouched.
          if (identity.isIpAbuseRejection(upstreamRes.status, rawMsg)) {
            // The block is keyed to this network's IP, so this egress is the
            // problem: park it so the next request leaves through another entry.
            recordEgressFailure(egressState, { reason: "ip-abuse block" });
            return respondIpAbuse(
              res,
              upstreamRes.status,
              errType,
              rawMsg,
              upstreamLogIdOf(upstreamRes),
              targetModel
            );
          }

          if (!isFreeTierCliGateError(upstreamRes.status, errType, rawMsg)) {
            const upstreamLogId =
              typeof upstreamRes.headers?.get === "function"
                ? upstreamRes.headers.get("x-opencode-log-id")
                : null;
            const cfRay =
              typeof upstreamRes.headers?.get === "function"
                ? upstreamRes.headers.get("cf-ray")
                : null;
            const cfPlacement =
              typeof upstreamRes.headers?.get === "function"
                ? upstreamRes.headers.get("cf-placement")
                : null;
            if (upstreamRes.status >= 500) {
              lastUpstreamError = {
                at: Date.now(),
                status: upstreamRes.status,
                logId: upstreamLogId,
                cfRay,
                cfPlacement,
                message: rawMsg,
                model: targetModel,
              };
              console.warn(
                `[opencode-free-bridge] Upstream server error (${upstreamRes.status}) on model ${targetModel}: ${rawMsg}` +
                  (upstreamLogId ? ` [x-opencode-log-id: ${upstreamLogId}]` : "") +
                  (cfRay ? ` [cf-ray: ${cfRay}]` : "") +
                  (cfPlacement ? ` [cf-placement: ${cfPlacement}]` : "")
              );
            }
            const errHeaders = { "Content-Type": "application/json" };
            if (upstreamLogId) errHeaders["X-OpenCode-Log-Id"] = upstreamLogId;
            if (upstreamRes.status >= 500) errHeaders["X-OpenCode-Gate"] = "upstream-error";
            // A capacity 429 reaches this passthrough, not the gate branch:
            // isFreeTierCliGateError() only claims 403/401/426, so FreeUsageLimitError
            // with status 429 falls through to here. Without the real Retry-After
            // the client retries immediately into a pool that is still spent, and
            // every retry re-stamps the entries. Upstream sends the free-allowance
            // reset as an absolute boundary (measured: ~46ks, i.e. next midnight
            // UTC), so passing it through is what makes the wait truthful.
            if (upstreamRes.status === 429) {
              const upstreamRetryAfter = retryAfterMs(upstreamRes);
              if (upstreamRetryAfter) {
                errHeaders["Retry-After"] = String(Math.max(1, Math.ceil(upstreamRetryAfter / 1000)));
              }
              errHeaders["X-OpenCode-Gate"] = "ip-throttled";
            }
            res.writeHead(upstreamRes.status, errHeaders);
            return res.end(
              JSON.stringify({
                error: {
                  message: rawMsg,
                  type: errType || "upstream_error",
                  code: upstreamRes.status,
                  ...(upstreamLogId ? { log_id: upstreamLogId } : {}),
                },
              })
            );
          }

          const gateStatus = upstreamRes.status;
          const verdict = await identity
            .onGateRejection(gateStatus, errType, rawMsg, false)
            .catch(() => ({ retry: false, reason: "refresh-error" }));

          // Always retry once on a gate rejection, even when the refresh learned
          // nothing new. Two inputs to the gate are *minted per request* rather
          // than read from the recipe — the session id and the tool set — so a
          // retry with fresh values is a genuinely different request. Measured
          // upstream behaviour: a session id this bridge did not mint (or one
          // minted by a rejected recipe) is refused with FreeTierError even
          // when every header matches, while the same request with a freshly
          // minted id is accepted.
          syncUserAgent();
          // Re-mint the session id. The one minted before this request was
          // produced by the recipe the gate just rejected; replaying it would
          // send the same rejected shape and fail identically. The cached
          // entry is dropped so the next request also gets a correct id.
          const retrySessionId = regenerateSessionId(req, body, sessionId);
          const currentEpoch = identity.getState().epoch || 0;
          const skipCooldownRetry =
            !verdict.retry &&
            lastFailedGateRetryTime > 0 &&
            Date.now() - lastFailedGateRetryTime < GATE_RETRY_COOLDOWN_MS &&
            lastFailedGateRetryEpoch === currentEpoch;

          if (!skipCooldownRetry) {
            // A gate rejection on a pooled egress is the one case where the
            // bridge can act on it locally: the allowance is per IP, so a
            // different entry is a different allowance. Failed over before the
            // retry so the retry is a genuinely different request in both shape
            // and egress. The old entry is put in cooldown; with a single proxy
            // (or none) `pick()` hands back the same egress and this is a no-op.
            const pooled = proxy.describe().pool;
            const canFailover = pooled && pooled.active && pooled.enabled > 1;
            if (canFailover && egressState.egressUrl) {
              proxy.markFailure(egressState.egressUrl, {
                reason: `gate ${gateStatus}`,
                cooldownMs: gateStatus === 429 ? (retryAfterMs(upstreamRes) ?? pooled.cooldownMs * 4) : null,
              });
              const next = proxy.pick({ exclude: egressState.egressUrl });
              if (next.url && next.url !== egressState.egressUrl) {
                console.warn(
                  `[opencode-free-bridge] Gate refused egress ${
                    proxy.displayHost(egressState.egressUrl) || "direct"
                  } (${gateStatus}); moving to ${proxy.displayHost(next.url) || "direct"} for the retry`
                );
                egressState.egress = next;
                egressState.egressUrl = next.url;
              }
            }
            console.warn(
              `[opencode-free-bridge] Upstream CLI gate rejected request (${gateStatus}, ${verdict.reason || "unknown"}); refreshing identity and retrying once with full tool set`
            );
            ({ upstreamBody, aliasToOriginal } = buildUpstreamPayload(
              body,
              targetModel,
              useResponses,
              "full"
            ));
            // Re-resolve the endpoint *after* the refresh: a catalog change is one
            // of the things the refresh can learn, and the retry must go to the
            // new URL — reusing the pre-refresh value would defeat the derivation.
            liveEndpoints = resolveEndpoints(targetModel);
            upstreamUrl = useResponses ? liveEndpoints.responsesUrl : liveEndpoints.chatUrl;
            retryHeaders = buildUpstreamHeaders(req, retrySessionId);
            upstreamRes = await upstreamFetch(upstreamUrl, {
              method: "POST",
              headers: retryHeaders,
              body: JSON.stringify(upstreamBody),
              signal: abortController.signal,
            }, egressUrl());
          } else {
            console.warn(
              `[opencode-free-bridge] Upstream CLI gate rejected request (${gateStatus}); skipping retry because a full-shape retry already failed <${Math.round(GATE_RETRY_COOLDOWN_MS / 1000)}s ago on the current identity (IP cooldown active)`
            );
          }

          if (!upstreamRes.ok) {
            // The retry already used the freshest derived identity (endpoint,
            // session id, full tool set) — so a repeated FreeTierError is not a
            // shape problem this bridge can learn its way out of. Measured
            // 403 FreeTierError has more than one cause, and the message alone
            // cannot distinguish them:
            //
            //   1. transport fingerprint — measured: Node and curl are refused
            //      100% while Bun succeeds 100% from the same IP in the same
            //      minute. The CLI ships as a Bun binary, so only Bun matches.
            //   2. per-IP allowance — also returned as 403. Measured: after a
            //      few dozen probes the real CLI v2.0.32 gets the identical 403
            //      from the same IP that answered 200 an hour earlier, and so
            //      does the bridge. The transport had not changed.
            //
            // A 429 FreeUsageLimitError is unambiguous: transport passed and
            // the quota is spent. Observed on a fresh IP while 403 was being
            // returned elsewhere, which is how the two were told apart.
            //
            // Only the runtime can be checked locally, so report that and name
            // both possibilities instead of asserting the wrong one.
            // Read the retry's own body before logging. The first attempt's
            // message describes a shape this bridge has already replaced, so
            // reporting it here would describe a request nobody sent.
            let retryText = errText;
            let retryJson = errJson;
            if (!skipCooldownRetry) {
              retryText = "";
              try {
                retryText = await upstreamRes.text();
              } catch {}
              retryJson = null;
              try {
                retryJson = JSON.parse(retryText);
              } catch {}
            }
            const retryType = retryJson?.error?.type || retryJson?.type || errType || "upstream_error";
            const retryMsg =
              retryJson?.error?.message || retryJson?.message || retryText || rawMsg;
            // Report the *retry* status, not the first attempt's: they differ
            // whenever upstream answers the refreshed shape differently (a 426
            // floor handshake followed by a 429 capacity answer is common), and
            // logging the old status misattributes the final verdict.
            const retryStatus = upstreamRes.status;
            // The retry can reveal the block even when the first attempt still
            // carried the shape message (upstream mixes the two while a flag is
            // being applied). That is still terminal: answer it verbatim and do
            // not run the shape audit or append an update hint.
            if (identity.isIpAbuseRejection(retryStatus, retryMsg)) {
              if (!skipCooldownRetry) {
                lastFailedGateRetryTime = Date.now();
                lastFailedGateRetryEpoch = identity.getState().epoch || 0;
              }
              recordEgressFailure(egressState, { reason: "ip-abuse block" });
              return respondIpAbuse(
                res,
                retryStatus,
                retryType,
                retryMsg,
                upstreamLogIdOf(upstreamRes),
                targetModel
              );
            }
            const retryFreeTierMsg = /freetiererror|free tier|free models|only available in opencode/i.test(retryMsg);
            const onNode = typeof Bun === "undefined";
            // A 429 means transport and shape both passed and only capacity is
            // exhausted. Calling that a gate rejection would send the user to
            // re-check headers that upstream already accepted.
            const capacity = retryStatus === 429;
            if (capacity) {
              lastFailedGateRetryTime = 0;
            } else if (!skipCooldownRetry && isFreeTierCliGateError(retryStatus, retryType, retryMsg)) {
              lastFailedGateRetryTime = Date.now();
              lastFailedGateRetryEpoch = identity.getState().epoch || 0;
            }
            // The egress that produced *this* refusal is spent: record it so the
            // next request picks a different entry instead of relearning the
            // same throttle. A 429 is an unambiguous allowance answer, so it
            // earns a longer cooldown than a 403 whose cause the bridge cannot
            // fully separate from a shape problem.
            recordEgressFailure(egressState, {
              reason: capacity ? "allowance 429" : `gate ${retryStatus}`,
              cooldownMs: capacity ? (retryAfterMs(upstreamRes) ?? proxy.describe().pool.cooldownMs * 4) : null,
            });

            // The gate answers the same `403 FreeTierError` for a blocked egress
            // and for a request whose shape it refuses, so the status line and
            // message cannot tell the two apart. What can: whether the request
            // that was actually sent carried the anchors the gate checks. Audit
            // that here instead of asserting a cause. Measured anchors: a tool
            // named `read`, and an `opencode/*` User-Agent with a session header.
            const shape = auditGateShape(upstreamBody, retryHeaders || upstreamHeaders);
            const shapeOk = shape.hasReadTool && shape.userAgentOk && shape.sessionHeaders.length > 0;
            const missing = [];
            if (!shape.hasReadTool) missing.push("tool `read`");
            if (!shape.userAgentOk) missing.push("an `opencode/*` User-Agent");
            if (shape.sessionHeaders.length === 0) missing.push("a session header");
            // Correlation id for this rejection. Upstream returns it on every
            // response, accepted or refused; it is the only handle a support
            // request or a bug report can quote.
            const upstreamLogId = upstreamLogIdOf(upstreamRes);
            lastGateDiagnostic = {
              at: Date.now(),
              kind: "free-tier-gate",
              status: retryStatus,
              logId: upstreamLogId,
              shape,
              shapeOk,
              missing,
              model: targetModel,
            };

            const verdictText = capacity
              ? "upstream accepted the transport and the request shape and answered with capacity pressure; the free-tier allowance or the model's capacity is exhausted. Retry later or switch model"
              : retryFreeTierMsg
                ? onNode
                  ? "this process is on Node, whose TLS ClientHello differs from the CLI's (measured: Node 0/6, Bun 6/6 from the same IP). Run the bridge with Bun — `bun server.js` — before suspecting an allowance limit"
                  : shapeOk
                    ? "the request carried every anchor the gate checks, so this is the egress: the per-IP free-tier allowance is spent or upstream refuses this network. The real CLI gets the same 403 from the same IP when it is"
                    : `this bridge produced a shape the gate refuses — missing ${missing.join(", ")}. That is a bridge bug, not an IP allowance: the same 403 is returned for both, which is why it is audited here`
                : `no further identity change to apply; ${UPDATE_HINT}`;
            console.warn(
              `[opencode-free-bridge] Upstream CLI gate rejected ${
                skipCooldownRetry
                  ? "the request (no retry: cooldown active)"
                  : "the retry with the refreshed identity"
              } (${retryStatus}${
                retryStatus !== gateStatus ? `, first attempt ${gateStatus}` : ""
              }): ${retryMsg} — ${verdictText}` +
                (upstreamLogId ? ` [x-opencode-log-id: ${upstreamLogId}]` : "")
            );
            const outStatus = resolveIpThrottleStatus(upstreamRes.status, retryFreeTierMsg && !capacity);
            res.writeHead(
              outStatus,
              buildIpThrottleHeaders(retryFreeTierMsg && !capacity, {
                shapeOk,
                logId: upstreamLogId,
              })
            );
            return res.end(
              JSON.stringify({
                error: {
                  // Point at an update only when the shape is plausibly stale.
                  // A budget rejection already carries the newest identity, so
                  // an "update the bridge" hint would send the user the wrong way.
                  message: retryFreeTierMsg ? retryMsg : `${retryMsg} (${UPDATE_HINT})`,
                  type: retryType,
                  code: outStatus,
                },
              })
            );
          }
        }

        lastFailedGateRetryTime = 0;
        lastIpAbuseAt = 0;
        // This egress carried a request upstream accepted, so its failure
        // history is stale: clear it so the next pick treats it as healthy.
        proxy.markSuccess(egressState.egressUrl);
        const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
        const created = Math.floor(Date.now() / 1000);
        reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // ==========================================
        // PATH A: Client requested streaming (SSE)
        // ==========================================
        if (clientStream) {
          let sseHeadersSent = false;
          const writeSse = (payload) => {
            if (!sseHeadersSent) {
              sseHeadersSent = true;
              res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              });
            }
            res.write(payload);
          };
          const emitStreamError = (errMessage, errType) => {
            console.warn(`[opencode-free-bridge] Upstream failed inside the stream: ${errMessage}`);
            reader.cancel().catch(() => {});
            if (!sseHeadersSent) {
              sseHeadersSent = true;
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: {
                    message: errMessage,
                    type: errType || "upstream_error",
                    code: 502,
                  },
                })
              );
              return;
            }
            writeSse(
              `data: ${JSON.stringify({
                error: {
                  message: errMessage,
                  type: errType || "upstream_error",
                  code: 502,
                },
              })}\n\n`
            );
            writeSse("data: [DONE]\n\n");
          };

          if (useResponses) {
            const toolIndexMap = new Map();
            let nextToolIndex = 0;
            let hasToolCalls = false;
            let upstreamFinishReason = null;
            let streamUsage = null;
            let streamAbortedByError = false;

            const handleResponsesStreamLine = (line) => {
              if (streamAbortedByError) return;
              if (!line.startsWith("data: ")) return;
              const rawJson = line.slice(6).trim();
              if (!rawJson || rawJson === "[DONE]") return;
              try {
                const ev = JSON.parse(rawJson);
                const inStreamError = extractStreamError(ev);
                if (inStreamError) {
                  streamAbortedByError = true;
                  emitStreamError(inStreamError, ev?.error?.type);
                  return;
                }
                if (ev.type === "response.output_text.delta" && ev.delta) {
                  writeSse(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [{ index: 0, delta: { content: ev.delta }, finish_reason: null }],
                    })}\n\n`
                  );
                } else if (
                  (ev.type === "response.reasoning_summary_text.delta" ||
                    ev.type === "response.reasoning_text.delta" ||
                    ev.type === "response.reasoning.delta") &&
                  ev.delta
                ) {
                  writeSse(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [{ index: 0, delta: { reasoning_content: ev.delta }, finish_reason: null }],
                    })}\n\n`
                  );
                } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
                  hasToolCalls = true;
                  const key =
                    ev.output_index !== undefined
                      ? String(ev.output_index)
                      : ev.item.call_id || ev.item.id || String(nextToolIndex);
                  let toolIdx = toolIndexMap.get(key);
                  if (toolIdx === undefined) {
                    toolIdx = nextToolIndex++;
                    toolIndexMap.set(key, toolIdx);
                    if (ev.item.call_id) toolIndexMap.set(ev.item.call_id, toolIdx);
                    if (ev.item.id) toolIndexMap.set(ev.item.id, toolIdx);
                    if (ev.output_index !== undefined) toolIndexMap.set(String(ev.output_index), toolIdx);
                  }
                  const restoredName = restoreClientToolName(ev.item.name, aliasToOriginal);
                  writeSse(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: toolIdx,
                                id: ev.item.call_id || ev.item.id || `call_${toolIdx}`,
                                type: "function",
                                function: { name: restoredName, arguments: "" },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    })}\n\n`
                  );
                } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
                  const key = ev.output_index !== undefined ? String(ev.output_index) : ev.item_id || ev.call_id;
                  const toolIdx = key !== undefined && toolIndexMap.has(key) ? toolIndexMap.get(key) : 0;
                  writeSse(
                    `data: ${JSON.stringify({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: targetModel,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [{ index: toolIdx, function: { arguments: ev.delta } }],
                          },
                          finish_reason: null,
                        },
                      ],
                    })}\n\n`
                  );
                } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
                  upstreamFinishReason = extractResponsesFinishReason(ev, hasToolCalls);
                  if (ev.response?.usage) {
                    streamUsage = {
                      prompt_tokens: ev.response.usage.input_tokens || 0,
                      completion_tokens: ev.response.usage.output_tokens || 0,
                      total_tokens: ev.response.usage.total_tokens || 0,
                    };
                  }
                }
              } catch {}
            };

            await consumeSseLines(reader, decoder, handleResponsesStreamLine);
            if (streamAbortedByError) {
              if (!res.writableEnded) res.end();
              return;
            }

            const finalFinishReason = upstreamFinishReason || (hasToolCalls ? "tool_calls" : "stop");
            writeSse(
              `data: ${JSON.stringify({
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: targetModel,
                choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason }],
              })}\n\n`
            );
            if (body.stream_options?.include_usage && streamUsage) {
              writeSse(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: targetModel,
                  choices: [],
                  usage: streamUsage,
                })}\n\n`
              );
            }
            writeSse("data: [DONE]\n\n");
            return res.end();
          } else {
            // Chat Completions API SSE stream
            const hasAliases = aliasToOriginal.size > 0;
            let streamAbortedByError = false;
            const handleChatStreamLine = (line) => {
              if (streamAbortedByError) return;
              if (!line.startsWith("data: ")) return;
              const raw = line.slice(6).trim();
              if (!raw) return;
              if (raw === "[DONE]") {
                writeSse("data: [DONE]\n\n");
                return;
              }
              // A failure inside the stream is not a completion. If no chunk has
              // been sent yet, return HTTP 502 JSON so any router or harness can
              // fail over; if chunks were already sent, emit an SSE error event.
              if (raw.includes('"error"')) try {
                const maybe = JSON.parse(raw);
                const streamErr = extractStreamError(maybe);
                if (streamErr) {
                  streamAbortedByError = true;
                  emitStreamError(streamErr, maybe?.error?.type);
                  return;
                }
              } catch {}
              // Zero-parse fast path: when no client tools are aliased and the chunk
              // carries no `"reasoning":` field to normalize, forward raw SSE bytes directly.
              if (!hasAliases && !raw.includes('"reasoning"')) {
                writeSse(`data: ${raw}\n\n`);
                return;
              }
              try {
                const chunk = JSON.parse(raw);
                const delta = chunk.choices?.[0]?.delta;
                if (delta && delta.reasoning && !delta.reasoning_content) {
                  delta.reasoning_content = delta.reasoning;
                }
                if (hasAliases && Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    if (tc.function?.name) {
                      tc.function.name = restoreClientToolName(tc.function.name, aliasToOriginal);
                    }
                  }
                }
                writeSse(`data: ${JSON.stringify(chunk)}\n\n`);
              } catch {
                writeSse(`data: ${raw}\n\n`);
              }
            };

            await consumeSseLines(reader, decoder, handleChatStreamLine);
            if (!res.writableEnded) {
              if (!sseHeadersSent) writeSse("data: [DONE]\n\n");
              res.end();
            }
            return;
          }
        }

        // ==========================================
        // PATH B: Client requested non-streaming (JSON)
        // ==========================================
        let assistantText = "";
        let reasoningText = "";
        const toolCalls = [];
        const nonStreamToolMap = new Map();
        let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let upstreamFinishReason = null;
        let streamError = null;

        const handleNonStreamLine = (line) => {
          if (!line.startsWith("data: ")) return;
          const rawJson = line.slice(6).trim();
          if (!rawJson || rawJson === "[DONE]") return;

          try {
            const ev = JSON.parse(rawJson);

            // A 200 followed by an in-stream error is a failure, not an empty
            // completion. Without this the client would receive content: null
            // with finish_reason "stop".
            const inStreamError = extractStreamError(ev);
            if (inStreamError) {
              streamError = inStreamError;
              return;
            }

            if (useResponses) {
              if (ev.type === "response.output_text.delta" && ev.delta) {
                assistantText += ev.delta;
              } else if (
                (ev.type === "response.reasoning_summary_text.delta" ||
                  ev.type === "response.reasoning_text.delta" ||
                  ev.type === "response.reasoning.delta") &&
                ev.delta
              ) {
                reasoningText += ev.delta;
              } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
                const key =
                  ev.output_index !== undefined
                    ? String(ev.output_index)
                    : ev.item.call_id || ev.item.id || String(toolCalls.length);
                const tc = {
                  id: ev.item.call_id || ev.item.id || `call_${toolCalls.length}`,
                  type: "function",
                  function: {
                    name: restoreClientToolName(ev.item.name, aliasToOriginal),
                    arguments: "",
                  },
                };
                toolCalls.push(tc);
                nonStreamToolMap.set(key, tc);
                if (ev.item.call_id) nonStreamToolMap.set(ev.item.call_id, tc);
                if (ev.item.id) nonStreamToolMap.set(ev.item.id, tc);
                if (ev.output_index !== undefined) nonStreamToolMap.set(String(ev.output_index), tc);
              } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
                const key =
                  ev.output_index !== undefined ? String(ev.output_index) : ev.item_id || ev.call_id;
                const targetTc =
                  key !== undefined && nonStreamToolMap.has(key)
                    ? nonStreamToolMap.get(key)
                    : toolCalls[toolCalls.length - 1];
                if (targetTc) targetTc.function.arguments += ev.delta;
              } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
                upstreamFinishReason = extractResponsesFinishReason(ev, toolCalls.length > 0);
                if (ev.response?.usage) {
                  usage = {
                    prompt_tokens: ev.response.usage.input_tokens || 0,
                    completion_tokens: ev.response.usage.output_tokens || 0,
                    total_tokens: ev.response.usage.total_tokens || 0,
                  };
                }
              }
            } else {
              // Chat completions format parsing
              const choice = ev.choices?.[0];
              if (choice?.finish_reason) {
                upstreamFinishReason = choice.finish_reason;
              }
              const delta = choice?.delta;
              if (delta?.content) assistantText += delta.content;
              if (delta?.reasoning) reasoningText += delta.reasoning;
              else if (delta?.reasoning_content) reasoningText += delta.reasoning_content;
              if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? toolCalls.length;
                  if (!toolCalls[idx]) {
                    toolCalls[idx] = {
                      id: tc.id || `call_${idx}`,
                      type: "function",
                      function: {
                        name: restoreClientToolName(tc.function?.name || "", aliasToOriginal),
                        arguments: "",
                      },
                    };
                  } else {
                    if (tc.id && toolCalls[idx].id.startsWith("call_")) {
                      toolCalls[idx].id = tc.id;
                    }
                    if (tc.function?.name && !toolCalls[idx].function.name) {
                      toolCalls[idx].function.name = restoreClientToolName(
                        tc.function.name,
                        aliasToOriginal
                      );
                    }
                  }
                  if (tc.function?.arguments) {
                    toolCalls[idx].function.arguments += tc.function.arguments;
                  }
                }
              }
              if (ev.usage && typeof ev.usage === "object") {
                usage = {
                  prompt_tokens: ev.usage.prompt_tokens || 0,
                  completion_tokens: ev.usage.completion_tokens || 0,
                  total_tokens: ev.usage.total_tokens || 0,
                };
              }
            }
          } catch {}
        };

        await consumeSseLines(reader, decoder, handleNonStreamLine);

        if (streamError) {
          console.warn(`[opencode-free-bridge] Upstream failed inside the stream: ${streamError}`);
          res.writeHead(502, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: { message: streamError, type: "upstream_error", code: 502 },
            })
          );
        }

        const validToolCalls = toolCalls.filter(Boolean);
        const messageObj = { role: "assistant", content: assistantText || null };
        if (reasoningText) messageObj.reasoning_content = reasoningText;
        if (validToolCalls.length > 0) messageObj.tool_calls = validToolCalls;

        let finishReason = upstreamFinishReason || "stop";
        if (
          validToolCalls.length > 0 &&
          finishReason !== "length" &&
          finishReason !== "content_filter"
        ) {
          finishReason = "tool_calls";
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            id: completionId,
            object: "chat.completion",
            created,
            model: targetModel,
            choices: [
              {
                index: 0,
                message: messageObj,
                finish_reason: finishReason,
              },
            ],
            usage,
          })
        );
      } catch (err) {
        if (reader) {
          reader.cancel().catch(() => {});
        }
        if (clientDisconnected || res.writableEnded) {
          return;
        }
        if (timedOut) {
          if (!res.headersSent) {
            res.writeHead(504, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({
                error: {
                  message: `Upstream request timed out after ${UPSTREAM_TIMEOUT_MS}ms`,
                  type: "timeout_error",
                  code: 504,
                },
              })
            );
          }
          return res.end();
        }
        console.error("[opencode-free-bridge] exception:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: { message: err.message || "Internal server error", type: "server_error" },
            })
          );
        }
        return res.end();
      } finally {
        clearTimeout(timeoutId);
        res.off("close", onClose);
      }
    })();
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
}

async function consumeSseLines(reader, decoder, onLine) {
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        let start = 0;
        for (let i = 0; i < buffer.length; i++) {
          if (buffer.charCodeAt(i) === 10) {
            const line =
              i > start && buffer.charCodeAt(i - 1) === 13
                ? buffer.slice(start, i - 1)
                : buffer.slice(start, i);
            onLine(line);
            start = i + 1;
          }
        }
        if (start < buffer.length) {
          const tail = buffer.endsWith("\r") ? buffer.slice(start, -1) : buffer.slice(start);
          onLine(tail);
        }
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer.charCodeAt(i) === 10) {
        const line =
          i > start && buffer.charCodeAt(i - 1) === 13
            ? buffer.slice(start, i - 1)
            : buffer.slice(start, i);
        onLine(line);
        start = i + 1;
      }
    }
    buffer = start === 0 ? buffer : buffer.slice(start);
  }
}

const server = http.createServer(handleRequest);

// Only auto-start when executed directly (`node server.js`), so unit tests can
// require("./server") without binding the default port or starting timers.
// The transport fingerprint is a property of the HTTP runtime, not of this code.
// Measured from one IP in one minute with identical headers and body: the real
// CLI and this bridge on Bun both answer 200, while this bridge on Node and curl
// answer 403. The CLI ships as a Bun binary, and the gate inspects its
// ClientHello. Node therefore cannot serve live traffic, so it is refused at
// startup rather than left running and failing every request.
const ON_BUN = typeof Bun !== "undefined";
const ALLOW_NODE = process.env.ALLOW_NODE === "1";

function refuseNodeRuntime() {
  const lines = [
    "",
    "  opencode-free-bridge requires Bun.",
    "",
    "  This process is Node, whose TLS transport the free-tier gate refuses:",
    "  measured 0/6 requests answered on Node vs 6/6 on Bun, from the same IP,",
    "  in the same minute, with byte-identical headers and body.",
    "",
    "  The CLI ships as a Bun binary, so only Bun reproduces its transport.",
    "",
    "  Install Bun:   curl -fsSL https://bun.sh/install | bash",
    "  Then run:      bun server.js",
    "",
    "  For offline work (tests, drills, inspecting /v1/models) set ALLOW_NODE=1.",
    "  Live chat requests will still be refused with 403 by upstream.",
    "",
  ];
  console.error(lines.join("\n"));
}

if (require.main === module) {
  if (!ON_BUN && !ALLOW_NODE) {
    refuseNodeRuntime();
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`[opencode-free-bridge] v${VERSION} listening on http://${HOST}:${PORT}`);
    if (!ON_BUN) {
      console.log(
        "[opencode-free-bridge] WARNING: ALLOW_NODE=1 — running on Node. Real chat requests will " +
          "be refused by the free-tier gate with 403. This mode is for offline work against a " +
          "mocked upstream, not for live traffic."
      );
    }
  });
  // Repair a half-installed tree (an older self-updater that did not know about
  // proxy.js/panel.js) after the socket is open, so a slow or absent network
  // never delays startup. The panel reads the current binding per request, so
  // it starts working as soon as the repair lands.
  repairMissingModules().catch(() => {});
  // Discovery runs in background: /v1/models is live as soon as upstream
  // answers. Boot never blocks on network.
  discoverModels().catch(() => {});
  // Model list rotates on upstream's schedule, so it keeps a timer. The
  // IDENTITY does not: it is refreshed lazily from the request path (see
  // identity.ensureFresh), so an idle bridge makes no network calls at all.
  setInterval(discoverModels, DISCOVERY_TTL_MS).unref();
  // Priority-failover recovery: probe one cooling entry per minute so the
  // highest-priority egress (the renewable phone IP) returns to the top of the
  // pool as soon as it answers again, instead of only after its cooldown.
  setInterval(() => proxy.recoveryProbeTick().catch(() => {}), 60_000).unref();
}

module.exports = {
  VERSION,
  // Kept for callers and tests written against the old frozen constants. These
  // are live views of the resolved profile, not snapshots.
  get FINGERPRINT_TOOL_NAMES() {
    return getFingerprintNames();
  },
  get FINGERPRINT_TOOL_DEFINITIONS() {
    return getFingerprintDefinitions();
  },
  get CANONICAL_TOOLS_CHAT() {
    return getCanonicalTools(false);
  },
  get CANONICAL_TOOLS_RESPONSES() {
    return getCanonicalTools(true);
  },
  MAX_SESSIONS,
  SESSION_TTL_MS,
  sessionCache,
  createId,
  isValidV2UserAgent,
  normalizeModel,
  isResponsesModel,
  markProtocolSupport,
  __resetProtocolLanes,
  extractContent,
  transformToResponsesInput,
  transformChatMessages,
  prepareToolsWithFingerprint,
  prepareResponsesTools,
  prepareChatTools,
  restoreClientToolName,
  buildUpstreamPayload,
  isNewerVersion,
  checkAndApplyUpdate,
  resolveEndpoints,
  buildUpstreamHeaders,
  getProjectId,
  extractResponsesFinishReason,
  extractStreamError,
  getPersistentSessionId,
  discoverModels,
  handleRequest,
  server,
  shortText,
  messageSignatureSample,
  transformResponsesContent,
  extractSystemInstructions,
  isLocalOrigin,
  isFreeTierCliGateError,
  consumeSseLines,
  readRequestBody,
  refreshCliVersion,
  identity,
  __getUserAgent: () => currentUserAgent,
  __syncUserAgent: syncUserAgent,
  __getGateDiagnostic: () => lastGateDiagnostic,
  __getLastUpstreamError: () => lastUpstreamError,
  __auditGateShape: auditGateShape,
  __retryAfterMs: retryAfterMs,
  gateSafeUserAgent,
  DISCOVERY_TTL_MS,
  CLI_VERSION_TTL_MS,
  __setLastDiscoveryTime: (v) => { lastDiscoveryTime = v; },
  __setActiveModels: (m) => {
    activeModels = Array.isArray(m) ? m : [];
    rebuildDiscoveryPayloads();
  },
  __getDiscoveryState: () => ({ inFlight: !!discoveryInFlight, lastDiscoveryTime, activeModels }),
  __setLastCliVersionCheckTime: (v) => { lastCliVersionCheckTime = v; },
  __getCliVersionState: () => ({ lastCliVersionCheckTime }),
  __setLastUpdateCheck: (v) => { lastUpdateCheck = v; },
  __localRequires: localRequires,
  __repairMissingModules: repairMissingModules,
  __adminRequestError: adminRequestError,
};
