#!/usr/bin/env bun
/**
 * rotator.js: reactive WARP-style egress rotation for the bridge.
 *
 * The free allowance is keyed to the IP upstream sees. When that IP's quota is
 * spent (429 FreeUsageLimitError), one useful action exists: leave through a
 * different address. A proxy pool does that by walking entries; a WARP-style
 * tunnel (Cloudflare WARP TUN mode, or any rotator that changes the machine's
 * egress) does it by re-handshaking the tunnel. This module drives the second
 * shape:
 *
 *   1. probe the current exit IP through the SAME egress the requests use
 *      (direct only when no egress is configured — the TUN-mode case, where
 *      "direct" already leaves through WARP),
 *   2. run the operator's rotate command (e.g. a script that reconnects the
 *      tunnel, or drives the OpenCode Unlimited "hop"),
 *   3. poll the exit IP until it differs from the pre-rotation one,
 *   4. on success, clear the egress cooldown (proxy.markSuccess) so the next
 *      request leaves immediately through the fresh address.
 *
 * Failure is always reported, never guessed: if the IP did not change before
 * the deadline, rotate() says so and the caller must answer the client the
 * original upstream refusal (with its Retry-After) instead of retrying into
 * the same spent address.
 *
 * Config lives in `<state dir>/rotator.json` (0600) like proxy.json; env
 * overrides lock the panel the same way UPSTREAM_PROXY_URL locks the proxy
 * panel:
 *
 *   WARP_ROTATE_CMD         command line to run for one hop (required to enable)
 *   WARP_ROTATE_TIMEOUT_MS  whole-rotation deadline (default 45000)
 *   WARP_ROTATE_COOLDOWN_MS min gap between rotations (default 75000)
 *   WARP_ROTATE_PROBE_URL   ip-echo endpoint (default cloudflare cdn-cgi/trace)
 *   ROTATE_PROVIDER         "warp" (default) or "tor"; legacy command-only
 *                           configs keep warp behavior
 *   TOR_CONTROL_HOST        Tor control host (default 127.0.0.1)
 *   TOR_CONTROL_PORT        Tor control port (default 9051)
 *   TOR_CONTROL_PASSWORD    password for AUTHENTICATE (quoted in protocol)
 *   TOR_CONTROL_COOKIE      path to Tor's cookie auth file (hex sent)
 *
 * Disabled by default: no command and no Tor control config means rotate()
 * reports `enabled: false`, and the server falls through to the plain 429.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const CONFIG_FILE_NAME = "rotator.json";

const ENV_CMD = "WARP_ROTATE_CMD";
const ENV_TIMEOUT = "WARP_ROTATE_TIMEOUT_MS";
const ENV_COOLDOWN = "WARP_ROTATE_COOLDOWN_MS";
const ENV_PROBE_URL = "WARP_ROTATE_PROBE_URL";
const ENV_PROVIDER = "ROTATE_PROVIDER";
const ENV_TOR_HOST = "TOR_CONTROL_HOST";
const ENV_TOR_PORT = "TOR_CONTROL_PORT";
const ENV_TOR_PASSWORD = "TOR_CONTROL_PASSWORD";
const ENV_TOR_COOKIE = "TOR_CONTROL_COOKIE";

const PROVIDERS = new Set(["warp", "tor"]);

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_COOLDOWN_MS = 75_000;

const DEFAULT_PROBE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const PROBE_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 8_000;
const MAX_ROTATIONS_PER_HOUR = 20;

function stateDir() {
  const raw = process.env.OPENCODE_BRIDGE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".opencode-free-bridge");
}

function configFile() {
  return path.join(stateDir(), CONFIG_FILE_NAME);
}

function envInt(name, fallback, { min = 1_000, max = 30 * 60_000 } = {}) {
  const raw = parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

function readConfigObject() {
  try {
    const text = fs.readFileSync(configFile(), "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(config) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    // 0600: the command may embed a token or path an operator treats as
    // sensitive; the panel never echoes it back either.
    fs.writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Gagal menulis ${configFile()}: ${err.message}` };
  }
}

/**
 * Effective config. Env wins over the file so an operator can force a value
 * without panel access, mirroring UPSTREAM_PROXY_URL's lock semantics.
 */
function readEffective() {
  const file = readConfigObject();
  const envCmd = String(process.env[ENV_CMD] ?? "").trim();
  const cmd = envCmd || String(file.command ?? "").trim();
  const envProvider = String(process.env[ENV_PROVIDER] ?? "").trim().toLowerCase();
  const fileProvider = String(file.provider ?? "").trim().toLowerCase();
  const provider = PROVIDERS.has(envProvider)
    ? envProvider
    : PROVIDERS.has(fileProvider)
      ? fileProvider
      : "warp";
  const torHost = String(process.env[ENV_TOR_HOST] ?? "").trim() ||
    String(file.controlHost ?? "").trim() || "127.0.0.1";
  const envPort = parseInt(process.env[ENV_TOR_PORT] ?? "", 10);
  const filePort = parseInt(file.controlPort, 10);
  const controlPort = Number.isFinite(envPort) && envPort >= 1 && envPort <= 65535
    ? envPort
    : Number.isFinite(filePort) && filePort >= 1 && filePort <= 65535
      ? filePort
      : 9051;
  const controlPassword = String(process.env[ENV_TOR_PASSWORD] ?? "").trim() ||
    String(file.controlPassword ?? "");
  const controlCookiePath = String(process.env[ENV_TOR_COOKIE] ?? "").trim() ||
    String(file.controlCookiePath ?? "").trim();
  const torConfigured = provider === "tor" && Boolean(controlPassword || controlCookiePath);
  return {
    provider,
    command: cmd,
    locked: Boolean(envCmd),
    torLocked: Boolean(process.env[ENV_TOR_HOST] || process.env[ENV_TOR_PORT] ||
      process.env[ENV_TOR_PASSWORD] || process.env[ENV_TOR_COOKIE]),
    torHost,
    controlPort,
    controlPassword,
    controlCookiePath,
    torConfigured,
    enabled: provider === "warp" ? Boolean(cmd) : Boolean(cmd || torConfigured),
    timeoutMs: envInt(ENV_TIMEOUT, Number(file.timeoutMs) > 0 ? Number(file.timeoutMs) : DEFAULT_TIMEOUT_MS),
    cooldownMs: envInt(
      ENV_COOLDOWN,
      Number(file.cooldownMs) > 0 ? Number(file.cooldownMs) : DEFAULT_COOLDOWN_MS,
      { min: 5_000, max: 60 * 60_000 }
    ),
    probeUrl: String(process.env[ENV_PROBE_URL] ?? "").trim() || String(file.probeUrl ?? "").trim() || DEFAULT_PROBE_URL,
  };
}

// ------------------------------------------------------------ runtime state --

let inFlight = null; // single-flight: one rotation at a time, process-wide
let lastRotationAt = 0;
let coolingUntil = 0;
let lastResult = null; // { at, ok, changed, fromIp, toIp, error, durationMs }
let rotationCount = 0;
let rotationStamps = []; // hourly cap bookkeeping

function pruneStamps(now) {
  const horizon = now - 60 * 60_000;
  while (rotationStamps.length > 0 && rotationStamps[0] < horizon) rotationStamps.shift();
}

function withinHourlyCap(now) {
  pruneStamps(now);
  return rotationStamps.length < MAX_ROTATIONS_PER_HOUR;
}

/** Public status. Never includes the command string; only presence. */
function describe() {
  const cfg = readEffective();
  const now = Date.now();
  return {
    provider: cfg.provider,
    enabled: cfg.enabled,
    locked: cfg.locked || (cfg.provider === "tor" && cfg.torLocked),
    commandConfigured: Boolean(cfg.command),
    controlConfigured: cfg.torConfigured,
    controlHost: cfg.torHost,
    controlPort: cfg.controlPort,
    timeoutMs: cfg.timeoutMs,
    cooldownMs: cfg.cooldownMs,
    coolingUntil: coolingUntil > now ? coolingUntil : 0,
    coolingForMs: coolingUntil > now ? coolingUntil - now : 0,
    busy: Boolean(inFlight),
    lastRotationAt: lastRotationAt || null,
    rotations: rotationCount,
    rotationsLastHour: (pruneStamps(now), rotationStamps.length),
    maxPerHour: MAX_ROTATIONS_PER_HOUR,
    lastResult,
    history: history.slice(-20),
    probeUrl: cfg.probeUrl,
  };
}

/**
 * Read the current exit IP, through `egressUrl` when one is given.
 *
 * The probe MUST leave through the same egress the inference requests use:
 * with a proxy pinned to a WARP tunnel, a direct probe would read the host's
 * own address and never observe the hop. `proxy.netFetch` carries the
 * `proxy:` option (HTTP/HTTPS only — the same constraint the bridge already
 * has), and with no egress configured it fetches direct, which is the TUN-mode
 * case: "direct" already leaves through WARP.
 */
async function probeExitIp(probeUrl, timeoutMs = PROBE_TIMEOUT_MS, egressUrl = null) {
  // Bun/undici can reuse an existing connection after a hop, which makes the
  // probe report the pre-hop IP and the rotator think the hop failed. Force a
  // fresh connection and bypass caches on every probe so `changed` reflects
  // the new tunnel address.
  const init = {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Connection": "close", "Cache-Control": "no-cache", "Pragma": "no-cache" },
  };
  let res;
  try {
    if (egressUrl) {
      // Late-require: keeps rotator.js loadable (and the server booting with
      // the tolerant fallback) even before proxy.js exists on disk.
      res = await require("./proxy").netFetch(probeUrl, init, egressUrl);
    } else {
      res = await fetch(probeUrl, init);
    }
  } catch (err) {
    return { ip: null, error: err.message };
  }
  try {
    if (!res.ok) return { ip: null, error: `probe HTTP ${res.status}` };
    const text = await res.text();
    // cdn-cgi/trace has `ip=…`; plain JSON ip-echo services return {"ip":"…"};
    // bare-echo services (icanhazip.com and friends) return just the address.
    const traceMatch = text.match(/^ip=(.+)$/m);
    if (traceMatch) return { ip: traceMatch[1].trim(), error: null };
    try {
      const j = JSON.parse(text);
      if (typeof j.ip === "string" && j.ip) return { ip: j.ip, error: null };
    } catch {}
    const bare = text.trim();
    if (bare && !/\s/.test(bare) && /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,45})$/.test(bare)) {
      return { ip: bare, error: null };
    }
    return { ip: null, error: "probe tidak memuat alamat IP" };
  } catch (err) {
    return { ip: null, error: err.message };
  }
}

/**
 * Remove the operator's command from a text.
 *
 * Two shapes have to be covered: the `Command failed: <command line>` message
 * that `execFile` builds, and any place where the command line appears
 * verbatim inside the command's own output. The first keeps the program name
 * (it tells the operator what failed); the second is dropped whole.
 */
function redactCommand(message) {
  const text = String(message || "");
  const marker = "Command failed:";
  const at = text.indexOf(marker);
  if (at === -1) return text.slice(0, 300);
  const head = text.slice(0, at + marker.length);
  const rest = text.slice(at + marker.length).trim();
  const program = (rest.split(/\s+/)[0] || "").replace(/[^\w.\/-]/g, "");
  return program ? `${head} ${program}` : head.trim();
}

/**
 * Scrub a text that may repeat the command line.
 *
 * The command is where an operator keeps secrets (`warp-cli --token …`), and
 * it can surface in three ways: as the `Command failed:` message, inside the
 * command's own stdout, or inside its stderr. All three are redacted here, so
 * the guarantee does not depend on which path the text took.
 */
function scrubCommandText(text, command) {
  if (text === null || text === undefined) return text;
  let out = redactCommand(text);
  const cmd = String(command || "").trim();
  if (cmd) {
    out = out.split(cmd).join("<command>");
    // The individual arguments are worth scrubbing too: an error message may
    // quote only the flag and its value.
    for (const arg of cmd.split(/\s+/)) {
      if (arg.length < 8) continue;
      if (/^--?[a-z0-9-]+$/i.test(arg)) continue;
      out = out.split(arg).join("<redacted>");
    }
  }
  return typeof out === "string" ? out.slice(0, 300) : out;
}

function runCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    // execFile with shell: the command is operator-authored configuration, the
    // same trust level as the pool URLs a shell would split anyway. Windows
    // needs shell for anything touching warp-cli/PowerShell helpers.
    execFile(command, { shell: true, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        error: err ? scrubCommandText(err.message || err, command) : null,
        output: scrubCommandText(String(stdout || "").slice(-500), command),
        stderr: scrubCommandText(String(stderr || "").slice(-500), command),
      });
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seam for tests: inject a fake probe without monkey-patching fetch. */
let probeExitIpImpl = null;

// Tests inject a fake probe and must not wait 2s between polls; rotate() reads
// this module-level value so a test can shrink the gap without touching prod.
let probeIntervalMs = PROBE_INTERVAL_MS;

/**
 * One rotation. Resolves:
 *   { ok, changed, fromIp, toIp, error, durationMs, skipped, trigger }
 * `ok: true` guarantees the exit IP is different from when the call started.
 * `skipped` explains a refusal to even try (disabled, cooling, busy, capped).
 * `trigger` records who asked: "manual" (panel/API) or "429" (reactive).
 */
const HISTORY_LIMIT = 50;
let history = []; // newest last; { at, ok, changed, fromIp, toIp, skipped, error, durationMs, trigger }

async function rotate({ now = Date.now(), _probe = null, _run = runCommand, _control = null, egressUrl = null, trigger = "manual", ignoreCooldown = false } = {}) {
  const cfg = readEffective();
  const probe = _probe || probeExitIpImpl || probeExitIp;
  const started = now;

  const skip = (reason, error) => {
    const entry = {
      at: Date.now(),
      ok: false,
      changed: false,
      fromIp: null,
      toIp: null,
      skipped: reason,
      error: error || null,
      durationMs: Date.now() - started,
      trigger,
    };
    history.push(entry);
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    return entry;
  };

  if (!cfg.enabled) return skip("disabled", cfg.provider === "tor" ? "Perintah rotasi atau konfigurasi kontrol Tor belum diatur." : "Perintah rotasi belum diatur.");
  if (inFlight) return skip("busy", "Rotasi lain sedang berjalan.");
  // ignoreCooldown is the caller vouching that the wait protects nothing: the
  // reactive hook passes it when the previous hop's fresh address was already
  // refused (proven spent), and the manual API passes it for explicit operator
  // intent. Single-flight (busy) and the hourly cap still apply — this flag
  // only waives the pacing wait, never the concurrency or volume guards.
  if (!ignoreCooldown && coolingUntil > now) {
    return skip("cooling", `Rotasi berikutnya boleh ${Math.ceil((coolingUntil - now) / 1000)}s lagi.`);
  }
  if (!withinHourlyCap(now)) {
    return skip("capped", `Batas ${MAX_ROTATIONS_PER_HOUR} rotasi/jam tercapai; menunggu jendela.`);
  }

  inFlight = (async () => {
    const before = await probe(cfg.probeUrl, PROBE_TIMEOUT_MS, egressUrl);
    const fromIp = before.ip;

    let run = { ok: true, error: null, output: null, stderr: null };
    if (cfg.command) {
      run = await _run(cfg.command, cfg.timeoutMs);
      if (!run.ok) {
        return {
          ok: false,
          changed: false,
          fromIp,
          toIp: null,
          skipped: null,
          error: `Perintah rotasi gagal: ${scrubCommandText(run.error, cfg.command)}`,
          output: scrubCommandText(run.output, cfg.command),
          stderr: scrubCommandText(run.stderr, cfg.command),
          durationMs: Date.now() - started,
        };
      }
    }

    if (cfg.provider === "tor" && cfg.torConfigured) {
      let controlFn = _control;
      if (!controlFn) {
        try {
          controlFn = require("./tor-control").newnym;
        } catch (err) {
          return {
            ok: false,
            changed: false,
            fromIp,
            toIp: null,
            skipped: null,
            error: `Modul tor-control.js belum terpasang. Jalankan ulang install.sh: ${err.message}`,
            durationMs: Date.now() - started,
          };
        }
      }
      const control = await controlFn({
        host: cfg.torHost,
        port: cfg.controlPort,
        password: cfg.controlPassword || null,
        cookiePath: cfg.controlCookiePath || null,
        timeoutMs: Math.min(cfg.timeoutMs, 10_000),
      });
      if (!control.ok) {
        return {
          ok: false,
          changed: false,
          fromIp,
          toIp: null,
          skipped: null,
          error: `Rotasi sirkuit Tor gagal: ${control.error}`,
          output: run.output,
          stderr: run.stderr,
          durationMs: Date.now() - started,
        };
      }
    }

    // Poll until the exit IP differs. Some rotators finish before the tunnel
    // re-handshakes, so the first probe right after the command often still
    // shows the old address; that is not a failure, it is a wait. The probe
    // endpoint must answer with the same address family every time (the
    // default cdn-cgi/trace serves v4 and v6 from one URL), so success
    // demands a same-family difference: v4→v6 is a probe artifact, not a hop.
    const family = (ip) => (ip.includes(":") ? "v6" : "v4");
    const deadline = started + cfg.timeoutMs;
    let lastProbeError = null;
    while (Date.now() < deadline) {
      await sleep(probeIntervalMs);
      const after = await probe(cfg.probeUrl, PROBE_TIMEOUT_MS, egressUrl);
      if (after.ip) {
        lastProbeError = null;
        if (!fromIp || (family(after.ip) === family(fromIp) && after.ip !== fromIp)) {
          return {
            ok: true,
            changed: Boolean(fromIp),
            fromIp,
            toIp: after.ip,
            skipped: null,
            error: null,
            durationMs: Date.now() - started,
          };
        }
      } else {
        lastProbeError = after.error;
      }
    }
    return {
      ok: false,
      changed: false,
      fromIp,
      toIp: null,
      skipped: null,
      error: `IP tidak berubah sebelum tenggat (${cfg.timeoutMs} ms)${lastProbeError ? `; probe terakhir: ${lastProbeError}` : ""}`,
      durationMs: Date.now() - started,
    };
  })();

  try {
    const result = await inFlight;
    lastResult = {
      at: Date.now(),
      ok: result.ok,
      changed: result.changed,
      fromIp: result.fromIp,
      toIp: result.toIp,
      skipped: result.skipped,
      error: result.error,
      durationMs: result.durationMs,
    };
    history.push({ ...lastResult, trigger });
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    if (result.skipped) return result;

    rotationCount += 1;
    rotationStamps.push(Date.now());
    lastRotationAt = Date.now();
    coolingUntil = Date.now() + cfg.cooldownMs;
    if (result.ok) {
      console.log(
        `[opencode-free-bridge] Rotator: egress rotated ${result.fromIp || "?"} -> ${result.toIp} in ${result.durationMs} ms`
      );
    } else {
      console.warn(
        `[opencode-free-bridge] Rotator: rotation failed after ${result.durationMs} ms: ${result.error}`
      );
    }
    return result;
  } finally {
    inFlight = null;
  }
}

/** Write config from the panel. Empty command clears it (disable). */
function setConfig({ command, timeoutMs, cooldownMs, probeUrl, provider, controlHost, controlPort, controlPassword, controlCookiePath } = {}) {
  if (process.env[ENV_CMD] && process.env[ENV_CMD].trim()) {
    return { ok: false, error: `Rotator dikunci oleh ${ENV_CMD}; ubah environment service untuk mengganti perintah.` };
  }
  const envTorFields = [ENV_TOR_HOST, ENV_TOR_PORT, ENV_TOR_PASSWORD, ENV_TOR_COOKIE].filter(
    (name) => process.env[name] && String(process.env[name]).trim()
  );
  if (envTorFields.length && (controlHost !== undefined || controlPort !== undefined ||
      controlPassword !== undefined || controlCookiePath !== undefined)) {
    return { ok: false, error: `Konfigurasi kontrol Tor dikunci oleh ${envTorFields.join(", ")}; ubah environment service.` };
  }
  if (process.env[ENV_PROVIDER] && String(process.env[ENV_PROVIDER]).trim()) {
    return { ok: false, error: `Provider dikunci oleh ${ENV_PROVIDER}; ubah environment service.` };
  }
  const config = readConfigObject();
  if (provider !== undefined) {
    const p = String(provider ?? "").trim().toLowerCase();
    if (!PROVIDERS.has(p)) return { ok: false, error: "provider harus 'warp' atau 'tor'." };
    config.provider = p;
  }
  if (command !== undefined) {
    const cmd = String(command ?? "").trim();
    if (cmd) config.command = cmd;
    else delete config.command;
  }
  if (controlHost !== undefined) {
    const h = String(controlHost ?? "").trim();
    if (h) config.controlHost = h;
    else delete config.controlHost;
  }
  if (controlPort !== undefined) {
    const port = Number(controlPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: "controlPort harus 1–65535." };
    }
    config.controlPort = port;
  }
  if (controlPassword !== undefined) {
    const pw = String(controlPassword ?? "");
    if (pw) config.controlPassword = pw;
    else delete config.controlPassword;
  }
  if (controlCookiePath !== undefined) {
    const cp = String(controlCookiePath ?? "").trim();
    if (cp) config.controlCookiePath = cp;
    else delete config.controlCookiePath;
  }
  if (timeoutMs !== undefined) {
    const n = Number(timeoutMs);
    if (!Number.isFinite(n) || n < 5_000 || n > 30 * 60_000) {
      return { ok: false, error: "timeoutMs harus 5.000–1.800.000 ms." };
    }
    config.timeoutMs = n;
  }
  if (cooldownMs !== undefined) {
    const n = Number(cooldownMs);
    if (!Number.isFinite(n) || n < 5_000 || n > 60 * 60_000) {
      return { ok: false, error: "cooldownMs harus 5.000–3.600.000 ms." };
    }
    config.cooldownMs = n;
  }
  if (probeUrl !== undefined) {
    const u = String(probeUrl ?? "").trim();
    if (u) {
      try {
        const parsed = new URL(u);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { ok: false, error: "probeUrl harus http(s)." };
        }
      } catch {
        return { ok: false, error: "probeUrl bukan URL yang valid." };
      }
      config.probeUrl = u;
    } else {
      delete config.probeUrl;
    }
  }
  const written = writeConfig(config);
  if (!written.ok) return written;
  return { ok: true, ...describe() };
}

/** Test-only seam: reset runtime state without touching config on disk. */
function __reset({ keepConfig = true } = {}) {
  inFlight = null;
  lastRotationAt = 0;
  coolingUntil = 0;
  lastResult = null;
  history = [];
  rotationCount = 0;
  rotationStamps = [];
  if (!keepConfig) {
    try {
      fs.unlinkSync(configFile());
    } catch {}
  }
}

module.exports = {
  CONFIG_FILE_NAME,
  ENV_CMD,
  ENV_PROVIDER,
  describe,
  rotate,
  probeExitIp,
  setConfig,
  configFile,
  stateDir,
  __reset,
  __setProbeImpl: (fn) => {
    probeExitIpImpl = fn;
  },
  __setProbeIntervalMs: (ms) => {
    probeIntervalMs = Number(ms) > 0 ? Number(ms) : PROBE_INTERVAL_MS;
  },
};
