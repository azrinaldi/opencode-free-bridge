#!/usr/bin/env bun
/**
 * proxy.js: runtime-configurable egress, single proxy or pool.
 *
 * Every outbound request this bridge makes (inference, model discovery, identity
 * sync, self-update) can be routed through an HTTP/HTTPS proxy so upstream sees
 * that proxy's IP instead of this host's. Two shapes are supported:
 *
 *   - one proxy (`url`), the original behaviour, edited from the panel at `/`;
 *   - a pool of proxies, each with its own health state, so a single bridge can
 *     spread requests across many egress IPs and move off one that upstream has
 *     throttled.
 *
 * Why a pool matters here: the free-tier allowance is per egress IP, not per
 * account. Running one bridge per host therefore multiplies the number of
 * processes, service units and tunnels without adding anything a pool does not
 * already give — the pool rotates the IP while the process, the identity and the
 * model catalog stay in one place.
 *
 * Protocol: HTTP/HTTPS only. Bun's `fetch` accepts `proxy:` for those schemes and
 * tunnels TLS through CONNECT, so the ClientHello still comes from Bun, and the
 * transport-fingerprint baseline is unchanged. SOCKS5 is rejected by Bun with
 * `UnsupportedProxyProtocol`, so it is refused here with a message that says so
 * instead of failing later inside a request.
 *
 * Credentials live in `<state dir>/proxy.json` and never leave the process:
 * `describe()` is the only view the HTTP panel and `/health` get, and it carries
 * host:port only.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_FILE_NAME = "proxy.json";
const HEALTH_FILE_NAME = "pool-health.json";
const HEALTH_VERSION = 1;
const ENV_OVERRIDE = "UPSTREAM_PROXY_URL";
const POOL_ENV = "UPSTREAM_PROXY_POOL";
const STRATEGY_ENV = "UPSTREAM_PROXY_STRATEGY";

const STRATEGIES = new Set(["round-robin", "failover", "random", "priority-failover"]);
const DEFAULT_STRATEGY = "round-robin";
const DEFAULT_COOLDOWN_MS = 120000;
const DEFAULT_MAX_COOLDOWN_MS = 1800000;

function stateDir() {
  const raw = process.env.OPENCODE_BRIDGE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return String(raw).trim();
  return path.join(os.homedir(), ".opencode-free-bridge");
}

function configFile() {
  return path.join(stateDir(), CONFIG_FILE_NAME);
}

/**
 * Pool health lives beside the config but in its own file: the config is
 * operator intent, health is runtime observation. Writing one must never
 * rewrite the other, and a corrupt health file must not cost the pool.
 */
function healthFile() {
  return path.join(stateDir(), HEALTH_FILE_NAME);
}

/**
 * Canonical form of a proxy URL, or the reason it was refused.
 *
 * `""` is valid and means "direct": the panel clears the setting with an empty
 * value rather than a separate verb, so both paths share one validator.
 */
function parseProxyUrl(raw) {
  const value = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!value) return { ok: true, url: "" };

  let u;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, error: "URL proxy tidak valid. Contoh: http://user:pass@host:8080" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return {
      ok: false,
      error:
        `Skema ${u.protocol} tidak didukung. Bun fetch hanya mendukung proxy http:// dan https:// ` +
        "(tunnel CONNECT). SOCKS5 ditolak runtime, jadi tidak bisa dipakai di sini.",
    };
  }
  if (!u.hostname) return { ok: false, error: "Host proxy kosong." };
  if (u.pathname !== "/" || u.search || u.hash) {
    return { ok: false, error: "URL proxy hanya boleh berisi skema, kredensial, host, dan port." };
  }
  // `u.username`/`u.password` stay percent-encoded exactly as the user typed them,
  // which is what Bun expects. Rebuilding avoids the trailing slash `URL`
  // normalization adds, so the stored value matches what the panel shows back.
  const auth = u.username || u.password
    ? `${u.username}${u.password ? `:${u.password}` : ""}@`
    : "";
  const port = u.port ? `:${u.port}` : "";
  return { ok: true, url: `${u.protocol}//${auth}${u.hostname}${port}` };
}

/** `host:port` for display. Credentials are never part of this string. */
function displayHost(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "configured";
  }
}

/** `id` for a URL that has none: stable across reloads, never leaks credentials. */
function fallbackId(url) {
  const host = displayHost(url) || "proxy";
  return host.replace(/[^A-Za-z0-9.:-]/g, "");
}

/**
 * One pool entry, or the reason it was refused. A string entry is shorthand for
 * `{ url }`, so a pool can be written as a plain list of URLs.
 *
 * `{ direct: true }` is the bridge's own address: it lets the hosting machine's
 * IP take part in the rotation instead of being the fallback used only when
 * every proxy is down. That is worth a first-class entry because the host that
 * runs the bridge usually has a usable IP of its own.
 */
function parsePoolEntry(raw, index) {
  const source = typeof raw === "string" ? { url: raw } : raw;
  if (!source || typeof source !== "object") {
    return { ok: false, error: `Entri #${index + 1} bukan objek atau URL.` };
  }

  const label = String(source.label == null ? "" : source.label).trim().slice(0, 64);

  if (source.direct === true) {
    const id = String(source.id == null ? "" : source.id).trim().slice(0, 64) || label || "direct";
    const weight = Number(source.weight);
    return {
      ok: true,
      entry: {
        id,
        label: label || id,
        url: "",
        direct: true,
        enabled: source.enabled === undefined ? true : Boolean(source.enabled),
        weight: Number.isFinite(weight) && weight > 0 ? Math.min(weight, 100) : 1,
        // meter: false opts an entry out of usage accounting — meant for
        // entries whose traffic is not scarce (VPS egress), keeping usage.json
        // focused on the entries that cost real money, e.g. phone data.
        meter: source.meter === undefined ? true : Boolean(source.meter),
      },
    };
  }

  const parsed = parseProxyUrl(source.url);
  if (!parsed.ok) return { ok: false, error: `Entri #${index + 1}: ${parsed.error}` };
  if (!parsed.url) return { ok: false, error: `Entri #${index + 1}: URL kosong.` };

  const id = String(source.id == null ? "" : source.id).trim().slice(0, 64) || label || fallbackId(parsed.url);
  // Weights stay optional: an operator that never sets one gets an even spread,
  // and a weight only has to make relative sense within the pool.
  const weight = Number(source.weight);
  return {
    ok: true,
    entry: {
      id,
      label: label || id,
      url: parsed.url,
      direct: false,
      enabled: source.enabled === undefined ? true : Boolean(source.enabled),
      weight: Number.isFinite(weight) && weight > 0 ? Math.min(weight, 100) : 1,
      meter: source.meter === undefined ? true : Boolean(source.meter),
    },
  };
}

/**
 * Parse a `UPSTREAM_PROXY_POOL` value: URLs separated by commas or newlines,
 * each optionally prefixed with `label=`. Empty entries are ignored so a
 * trailing separator is not an error.
 */
function parsePoolSpec(raw) {
  const out = [];
  const errors = [];
  String(raw || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((piece, index) => {
      const eq = piece.indexOf("=");
      const hasLabel = eq > 0 && !piece.slice(0, eq).includes("/");
      const parsed = parsePoolEntry(
        hasLabel ? { label: piece.slice(0, eq).trim(), url: piece.slice(eq + 1).trim() } : piece,
        index
      );
      if (parsed.ok) out.push(parsed.entry);
      else errors.push(parsed.error);
    });
  return { entries: out, errors };
}

// ---------------------------------------------------------------- state ---

/** Single-proxy state (legacy). `pool` below is used only when it has entries. */
let current = { url: "", source: "none", error: null };
let pool = { entries: [], errors: [], strategy: DEFAULT_STRATEGY, source: "none", error: null };
let cooldowns = { baseMs: DEFAULT_COOLDOWN_MS, maxMs: DEFAULT_MAX_COOLDOWN_MS };

/**
 * Health is keyed by egress identity, not by proxy URL: the "direct" entry has
 * no URL, and two entries must never share a health record.
 */
function keyOf(url) {
  return url ? url : "@direct";
}
/** Usage accounting gate: false skips an entry flagged `meter: false` in config. */
function shouldMeter(url) {
  const entry = url
    ? pool.entries.find((e) => e.url === url)
    : pool.entries.find((e) => e.direct);
  return entry ? entry.meter !== false : true;
}

/** key -> { failures, cooldownUntil, lastError, lastOkAt, lastUsedAt } */
const health = new Map();
let cursor = 0;

function healthFor(url) {
  const key = keyOf(url);
  let h = health.get(key);
  if (!h) {
    h = { failures: 0, cooldownUntil: 0, lastError: null, lastOkAt: 0, lastUsedAt: 0, lastStatus: null };
    health.set(key, h);
  }
  return h;
}

/**
 * Drop health for egresses no longer in the pool, so a removed entry leaves no
 * ghost. Pure: the caller persists, so a reload never writes a half-restored map
 * over a file it has not read yet.
 */
function pruneHealth(entries) {
  const live = new Set(entries.map((e) => keyOf(e.url)));
  if (current.url) live.add(current.url);
  let removed = 0;
  for (const key of [...health.keys()]) {
    if (!live.has(key)) {
      health.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Stable, non-secret id for one egress. The health file sits beside a config
 * that already holds proxy credentials; a second copy of every token would be
 * a second thing to leak, and the record only has to be matchable, not readable.
 */
function healthId(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function healthLabel(key) {
  if (key === "@direct") return "direct";
  const entry = pool.entries.find((e) => keyOf(e.url) === key);
  return entry ? entry.label : null;
}

function healthSnapshot(now = Date.now()) {
  return {
    version: HEALTH_VERSION,
    savedAt: new Date(now).toISOString(),
    entries: [...health.entries()].map(([key, h]) => ({
      id: healthId(key),
      label: healthLabel(key),
      failures: h.failures,
      cooldownUntil: h.cooldownUntil,
      lastError: h.lastError,
      lastStatus: h.lastStatus,
      lastOkAt: h.lastOkAt || null,
      lastUsedAt: h.lastUsedAt || null,
      // The address this cooldown belongs to. Without it a restart cannot tell
      // a still-spent IP from one that has already rotated to a fresh
      // allowance, and would keep the entry parked on stale evidence.
      exitIp: exitIpByKey.get(key) || null,
    })),
  };
}

let healthWriteTimer = null;

/** Drop the health file: no egress has anything worth remembering. */
function removeHealthFile() {
  try {
    fs.unlinkSync(healthFile());
  } catch (err) {
    if (err.code !== "ENOENT") return;
  }
}

/**
 * Write observed health. Atomic via rename so a crash mid-write leaves the
 * previous file intact — a truncated file would silently cost the pool every
 * cooldown it had learned.
 *
 * Failure is never surfaced: health is a memory optimization, and a request
 * must not fail because a cache file could not be written.
 */
function writeHealthNow(now = Date.now()) {
  if (healthWriteTimer) {
    clearTimeout(healthWriteTimer);
    healthWriteTimer = null;
  }
  if (health.size === 0) {
    removeHealthFile();
    return;
  }
  try {
    fs.mkdirSync(path.dirname(healthFile()), { recursive: true });
    const tmp = `${healthFile()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(healthSnapshot(now), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, healthFile());
    fs.chmodSync(healthFile(), 0o600);
  } catch {
    // Best effort: the bridge keeps running with in-memory health.
  }
}

/**
 * Coalesce rapid writes. A success arrives with every request, and rewriting a
 * file per request would turn a cheap memory update into disk churn.
 */
function scheduleHealthWrite(delayMs = 1000) {
  if (healthWriteTimer) return;
  healthWriteTimer = setTimeout(() => {
    healthWriteTimer = null;
    writeHealthNow();
  }, delayMs);
  // Never hold the process open for a cache write.
  if (typeof healthWriteTimer.unref === "function") healthWriteTimer.unref();
}

/**
 * Re-apply health saved by an earlier process. An upstream suspend or a service
 * restart would otherwise forget which IPs are spent and re-burn all of them.
 *
 * The in-memory record wins when it already exists: a restart is the only thing
 * that leaves the map empty, so a live record is by definition at least as
 * fresh as the file.
 */
function restoreHealth(entries, now = Date.now()) {
  let raw;
  try {
    raw = fs.readFileSync(healthFile(), "utf8");
  } catch {
    return 0;
  }

  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // A corrupt health file must cost nothing but the cooldowns.
    removeHealthFile();
    return 0;
  }
  if (!json || json.version !== HEALTH_VERSION || !Array.isArray(json.entries)) return 0;

  const saved = new Map();
  for (const record of json.entries) {
    if (record && typeof record.id === "string") saved.set(record.id, record);
  }

  const keys = entries.map((e) => keyOf(e.url));
  if (current.url) keys.push(current.url);

  let restored = 0;
  for (const key of keys) {
    if (health.has(key)) continue;
    const record = saved.get(healthId(key));
    if (!record) continue;
    const cooldownUntil = Number(record.cooldownUntil);
    const failures = Number(record.failures);
    const hasExitIp = typeof record.exitIp === "string" && record.exitIp;
    // A cooldown is only trusted when the record says which address earned it.
    // An older health file has no `exitIp`, and the free allowance is keyed to
    // the address upstream sees — a phone on mobile data rotates it several
    // times a day. A 13-hour `Retry-After` restored from a record that cannot
    // name its address is an unverifiable claim, and trusting it kept a healthy
    // phone parked all day. Clear it and let the next request re-learn: at worst
    // one request per unverified entry, and a still-spent IP simply parks again
    // with its own fresh `Retry-After`.
    const rawUntil = Number.isFinite(cooldownUntil) && cooldownUntil > now ? cooldownUntil : 0;
    health.set(key, {
      failures: Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0,
      cooldownUntil: hasExitIp ? rawUntil : 0,
      lastError: typeof record.lastError === "string" ? record.lastError : null,
      lastOkAt: Number.isFinite(Number(record.lastOkAt)) ? Number(record.lastOkAt) : 0,
      lastUsedAt: Number.isFinite(Number(record.lastUsedAt)) ? Number(record.lastUsedAt) : 0,
      lastStatus: typeof record.lastStatus === "string" ? record.lastStatus : null,
    });
    if (hasExitIp) exitIpByKey.set(key, record.exitIp);
    restored += 1;
  }
  return restored;
}

function normalizeStrategy(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return STRATEGIES.has(value) ? value : DEFAULT_STRATEGY;
}

function normalizeCooldowns(raw) {
  const base = Number(raw?.cooldownMs);
  const max = Number(raw?.maxCooldownMs);
  return {
    baseMs: Number.isFinite(base) && base >= 1000 ? Math.min(base, 3600000) : DEFAULT_COOLDOWN_MS,
    maxMs: Number.isFinite(max) && max >= 1000 ? Math.min(max, 7200000) : DEFAULT_MAX_COOLDOWN_MS,
  };
}

function loadFromDisk() {
  const envPool = (process.env[POOL_ENV] || "").trim();
  const envSingle = (process.env[ENV_OVERRIDE] || "").trim();

  if (envPool) {
    const spec = parsePoolSpec(envPool);
    pool = {
      entries: spec.entries,
      errors: spec.errors,
      strategy: normalizeStrategy(process.env[STRATEGY_ENV]),
      source: "env",
      error: spec.errors.length > 0 ? spec.errors.join(" ") : null,
    };
    current = { url: "", source: "env", error: null };
    pruneHealth(pool.entries);
    restoreHealth(pool.entries);
    return pool;
  }

  if (envSingle) {
    const parsed = parseProxyUrl(envSingle);
    if (parsed.ok) {
      current = { url: parsed.url, source: "env", error: null };
    } else {
      current = { url: "", source: "env", error: `${ENV_OVERRIDE}: ${parsed.error}` };
    }
    pool = { entries: [], errors: [], strategy: DEFAULT_STRATEGY, source: "env", error: null };
    pruneHealth([]);
    restoreHealth([]);
    return pool;
  }

  let raw = null;
  try {
    raw = fs.readFileSync(configFile(), "utf8");
  } catch {
    current = { url: "", source: "none", error: null };
    pool = { entries: [], errors: [], strategy: DEFAULT_STRATEGY, source: "none", error: null };
    pruneHealth([]);
    restoreHealth([]);
    return pool;
  }

  let json = null;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    // A corrupt file must not stop the bridge from starting. Direct egress is
    // the safe fallback, and `error` surfaces the reason in the panel.
    current = { url: "", source: "none", error: `proxy.json tidak terbaca: ${err.message}` };
    pool = { entries: [], errors: [], strategy: DEFAULT_STRATEGY, source: "none", error: current.error };
    pruneHealth([]);
    restoreHealth([]);
    return pool;
  }

  const entries = [];
  const errors = [];
  if (Array.isArray(json?.pool)) {
    json.pool.forEach((item, index) => {
      const parsed = parsePoolEntry(item, index);
      if (parsed.ok) entries.push(parsed.entry);
      else errors.push(parsed.error);
    });
  }

  const single = parseProxyUrl(json?.url);
  current = single.ok
    ? { url: single.url, source: single.url ? "file" : "none", error: null }
    : { url: "", source: "none", error: single.error };

  pool = {
    entries,
    errors,
    strategy: normalizeStrategy(json?.strategy),
    source: entries.length > 0 ? "file" : "none",
    error: errors.length > 0 ? errors.join(" ") : null,
  };
  cooldowns = normalizeCooldowns(json);
  pruneHealth(entries);
  restoreHealth(entries);
  return pool;
}

function getProxyUrl() {
  return current.url;
}

/** Enabled entries in config order; the pool's working set. */
function activeEntries() {
  return pool.entries.filter((e) => e.enabled);
}

function isCooling(url, now = Date.now()) {
  const h = health.get(keyOf(url));
  return Boolean(h && h.cooldownUntil > now);
}

/**
 * The egress for one request.
 *
 * Never returns empty while a pool has enabled entries: when every entry is
 * cooling, the one whose cooldown ends first is used anyway. Refusing to send
 * would turn a throttled pool into a dead bridge, and upstream answers a
 * throttled IP with a normal refusal the caller already handles.
 *
 * `exclude` lets a retry avoid the egress that just failed.
 */
function pick({ exclude = null, now = Date.now() } = {}) {
  const entries = activeEntries();

  if (entries.length === 0) {
    return { url: current.url, id: null, label: null, source: current.url ? "single" : "direct", cooling: false };
  }

  // `null` means "no preference", which must not be confused with the direct
  // entry's empty URL — both would map to the same health key.
  const excluded = exclude === null || exclude === undefined ? null : keyOf(exclude);
  let candidates = excluded === null ? entries.slice() : entries.filter((e) => keyOf(e.url) !== excluded);
  if (candidates.length === 0) candidates = entries.slice();

  const healthy = candidates.filter((e) => !isCooling(e.url, now));
  let chosen;
  let cooling = false;

  if (healthy.length > 0) {
    if (pool.strategy === "random") {
      // Weighted pick: a weight only has to be relative within the pool.
      const total = healthy.reduce((sum, e) => sum + e.weight, 0);
      let roll = Math.random() * total;
      chosen = healthy[healthy.length - 1];
      for (const e of healthy) {
        roll -= e.weight;
        if (roll <= 0) {
          chosen = e;
          break;
        }
      }
    } else if (pool.strategy === "priority-failover") {
      // Config order IS the priority: entry #1 (the renewable phone IP) is
      // preferred while healthy. Failover and recovery are both just health
      // moving: a 429 cools the phone and the next entry serves; the priority
      // watchdog probes cooling entries in the background and clears the
      // cooldown the moment one answers 200, so the next pick() snaps back to
      // the top without spending a real request.
      chosen = healthy[0];
    } else if (pool.strategy === "failover") {
      // Sticky: keep using the first healthy entry, which preserves upstream
      // prompt caching on that IP until it is throttled.
      chosen = healthy[0];
    } else {
      // Round-robin across healthy candidates, skipping ones that are cooling.
      // `candidates` already has `exclude` removed, so a retry that must leave a
      // failed egress does not come back to it here.
      chosen = healthy[cursor % healthy.length];
      cursor = (cursor + 1) % Number.MAX_SAFE_INTEGER;
    }
  } else {
    // Everything is throttled: use whichever recovers first.
    cooling = true;
    chosen = candidates
      .slice()
      .sort((a, b) => (health.get(keyOf(a.url))?.cooldownUntil || 0) - (health.get(keyOf(b.url))?.cooldownUntil || 0))[0];
  }

  if (!chosen) {
    return { url: current.url, id: null, label: null, source: current.url ? "single" : "direct", cooling };
  }

  const h = healthFor(chosen.url);
  h.lastUsedAt = now;
  return {
    url: chosen.url,
    id: chosen.id,
    label: chosen.label,
    // `direct` means "this process's own address", whether it came from a pool
    // entry or because no pool exists.
    source: chosen.direct ? "direct" : "pool",
    cooling,
    cooldownUntil: h.cooldownUntil || 0,
  };
}

/**
 * Record that an egress was refused by upstream. The cooldown doubles per
 * consecutive failure so a spent IP is retried less and less often, capped at
 * `maxMs`; a success resets both.
 *
 * Only upstream throttling belongs here. A transport error (proxy unreachable)
 * is also a reason to move on, but it must not look like a spent allowance, so
 * the caller passes the reason and it is shown separately in the panel.
 */
function markFailure(egressUrl, { reason = "throttled", now = Date.now(), cooldownMs = null } = {}) {
  // An empty string is the `direct` entry, which is a real egress; only a
  // missing target (null/undefined) means "nothing to record".
  if (egressUrl === null || egressUrl === undefined) return null;
  const h = healthFor(egressUrl);
  h.failures += 1;
  h.lastError = String(reason).slice(0, 200);
  const base = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : cooldowns.baseMs;
  const backoff = Math.min(base * Math.pow(2, h.failures - 1), Math.max(cooldowns.maxMs, base));
  h.cooldownUntil = now + backoff;
  h.lastStatus = reason;
  // A refusal is the expensive thing to rediscover: write it before the caller
  // can act on it, so a restart in the next second does not forget the IP.
  writeHealthNow(now);
  return { failures: h.failures, cooldownUntil: h.cooldownUntil, backoffMs: backoff };
}

/** Clear an egress's failure history; called after a request succeeds. */
function markSuccess(egressUrl, { now = Date.now() } = {}) {
  if (egressUrl === null || egressUrl === undefined) return null;
  const h = healthFor(egressUrl);
  h.failures = 0;
  h.cooldownUntil = 0;
  h.lastError = null;
  h.lastOkAt = now;
  h.lastStatus = "ok";
  // Every request lands here, so this one is coalesced.
  scheduleHealthWrite();
  return h;
}

/**
 * Remember the address an egress is currently exiting through.
 *
 * Called with the exit IP a probe already read, so a cooldown can record which
 * address earned it. Optional by design: a probe that fails (proxy down, trace
 * unreachable) leaves the mapping alone rather than inventing one, and the
 * capped-cooldown path in `loadFromDisk` covers records written without it.
 */
function noteExitIp(egressUrl, ip, { now = Date.now() } = {}) {
  if (egressUrl === null || egressUrl === undefined) return null;
  if (typeof ip !== "string" || !ip) return null;
  const key = keyOf(egressUrl);
  if (exitIpByKey.get(key) === ip) return ip;
  exitIpByKey.set(key, ip);
  scheduleHealthWrite(now);
  return ip;
}

function resetHealth() {
  health.clear();
  cursor = 0;
  writeHealthNow();
}

/** Public view of one entry: host:port, health, and never the URL's credentials. */
function describeEntry(entry, now = Date.now()) {
  const h = health.get(keyOf(entry.url));
  const cooling = Boolean(h && h.cooldownUntil > now);
  return {
    id: entry.id,
    label: entry.label,
    host: entry.direct ? "direct" : displayHost(entry.url),
    enabled: entry.enabled,
    weight: entry.weight,
    state: !entry.enabled ? "disabled" : cooling ? "cooling" : "ready",
    cooldownMsLeft: cooling ? Math.max(0, h.cooldownUntil - now) : 0,
    cooldownUntil: cooling ? h.cooldownUntil : 0,
    failures: h ? h.failures : 0,
    lastError: h ? h.lastError : null,
    lastOkAt: h ? h.lastOkAt || null : null,
    lastUsedAt: h ? h.lastUsedAt || null : null,
  };
}

function describe(now = Date.now()) {
  const entries = pool.entries;
  const active = entries.filter((e) => e.enabled);
  const ready = active.filter((e) => !isCooling(e.url, now));
  const poolActive = active.length > 0;
  const singleActive = !poolActive && Boolean(current.url);

  const poolView = {
    active: poolActive,
    size: entries.length,
    enabled: active.length,
    ready: ready.length,
    cooling: active.length - ready.length,
    strategy: pool.strategy,
    source: pool.source,
    cooldownMs: cooldowns.baseMs,
    maxCooldownMs: cooldowns.maxMs,
    error: pool.error,
    entries: entries.map((e) => describeEntry(e, now)),
  };

  return {
    mode: poolActive ? "pool" : singleActive ? "proxy" : "direct",
    proxy: poolActive ? `${active.length} proxy` : displayHost(current.url),
    hasCredentials: poolActive
      ? entries.some((e) => /\/\/[^/@]+@/.test(e.url))
      : current.url
        ? /\/\/[^/@]+@/.test(current.url)
        : false,
    source: poolActive ? pool.source : current.source,
    locked: (poolActive ? pool.source : current.source) === "env",
    configPath: configFile(),
    error: current.error || pool.error || null,
    pool: poolView,
  };
}

/** Write the whole config atomically-ish: one file, owner-only. */
function writeConfig(next) {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // A file created earlier keeps its old mode; chmod so credentials created by
    // an older release are not left readable by every local user.
    fs.chmodSync(configFile(), 0o600);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Gagal menulis ${configFile()}: ${err.message}` };
  }
}

/** Current on-disk shape, so one setter never drops the other's fields. */
function readConfigObject() {
  try {
    const json = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}

function refuseWhenLocked() {
  if (pool.source === "env" || current.source === "env") {
    return {
      ok: false,
      error: `${POOL_ENV}/${ENV_OVERRIDE} diset di environment. Ubah variabel itu lalu restart service.`,
    };
  }
  return null;
}

/**
 * Persist a new single-proxy setting. `raw` may be empty to go back to direct
 * egress.
 *
 * `UPSTREAM_PROXY_URL` is an operator override, so a runtime edit is refused
 * instead of silently losing to the environment on the next restart.
 */
function setProxyUrl(raw) {
  const locked = refuseWhenLocked();
  if (locked) return locked;
  const parsed = parseProxyUrl(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const config = readConfigObject();

  if (!parsed.url) {
    delete config.url;
    if (Array.isArray(config.pool) && config.pool.length > 0) {
      if (!writeConfig(config).ok) return { ok: false, error: `Gagal menulis ${configFile()}` };
    } else {
      try {
        fs.unlinkSync(configFile());
      } catch (err) {
        if (err.code !== "ENOENT") {
          return { ok: false, error: `Gagal menghapus ${configFile()}: ${err.message}` };
        }
      }
    }
    current = { url: "", source: "none", error: null };
    loadFromDisk();
    return { ok: true, ...describe() };
  }

  config.url = parsed.url;
  const written = writeConfig(config);
  if (!written.ok) return written;
  current = { url: parsed.url, source: "file", error: null };
  return { ok: true, ...describe() };
}

/**
 * Replace the pool. `raw` accepts:
 *   - an array of entries (`{id,label,url,enabled,weight}` or bare URL strings)
 *   - `{ entries: [...], strategy, cooldownMs, maxCooldownMs }`
 *   - `[]` / `{ entries: [] }` to clear it and fall back to direct/single egress
 */
function setPool(raw) {
  const locked = refuseWhenLocked();
  if (locked) return locked;

  const spec = Array.isArray(raw) ? { entries: raw } : raw && typeof raw === "object" ? raw : null;
  if (!spec) return { ok: false, error: "Format pool tidak valid." };

  const source = Array.isArray(spec.entries) ? spec.entries : [];
  const entries = [];
  const errors = [];
  source.forEach((item, index) => {
    const parsed = parsePoolEntry(item, index);
    if (parsed.ok) entries.push(parsed.entry);
    else errors.push(parsed.error);
  });
  if (errors.length > 0) return { ok: false, error: errors.join(" ") };

  const seen = new Set();
  for (const entry of entries) {
    const key = keyOf(entry.url);
    if (seen.has(key)) {
      return { ok: false, error: `Egress ganda di pool: ${entry.direct ? "direct" : displayHost(entry.url)}` };
    }
    seen.add(key);
  }

  const config = readConfigObject();
  if (entries.length === 0) {
    delete config.pool;
  } else {
    config.pool = entries;
  }
  if (spec.strategy !== undefined) config.strategy = normalizeStrategy(spec.strategy);
  if (spec.cooldownMs !== undefined) config.cooldownMs = normalizeCooldowns({ cooldownMs: spec.cooldownMs }).baseMs;
  if (spec.maxCooldownMs !== undefined) {
    config.maxCooldownMs = normalizeCooldowns({ maxCooldownMs: spec.maxCooldownMs }).maxMs;
  }

  if (!config.url && !config.pool) {
    try {
      fs.unlinkSync(configFile());
    } catch (err) {
      if (err.code !== "ENOENT") return { ok: false, error: `Gagal menghapus ${configFile()}: ${err.message}` };
    }
  } else {
    const written = writeConfig(config);
    if (!written.ok) return written;
  }

  // Deliberately not `resetHealth()`: an operator saving the pool (even just to
  // change the strategy) must not forget which IPs are spent. In-memory health
  // wins over the file during reload, so unchanged entries keep their cooldown
  // and removed ones were just pruned.
  loadFromDisk();
  cursor = 0;
  for (const entry of entries) healthFor(entry.url);
  writeHealthNow();
  return { ok: true, ...describe() };
}

/**
 * Add `proxy:` to a fetch init. Callers pass their own init untouched, so a
 * request that pins its own proxy keeps it.
 *
 * With a pool this picks an egress per call. A caller that needs one egress for
 * several fetches (a retry that must stay on the IP that answered) should call
 * `pick()` once and pass the result explicitly instead.
 *
 * An empty target is meaningful: it selects the `direct` pool entry, which is
 * this process's own address, so the fetch goes out without a proxy.
 */
function withProxy(init, egressUrl = null) {
  if (init && init.proxy) return init;
  // A caller that pins an egress passes the URL, and "" is the direct entry —
  // distinct from passing nothing, which asks the pool to choose.
  const target = egressUrl === null || egressUrl === undefined ? pick().url : egressUrl;
  if (!target) return init;
  return { ...(init || {}), proxy: target };
}

/** fetch() through the resolved egress. The single egress entry point. */
function netFetch(url, init, egressUrl = null) {
  const metering = shouldMeter(egressUrl);
  const body = init?.body;
  const requestBytes =
    typeof body === "string"
      ? Buffer.byteLength(body)
      : body && body.byteLength
        ? body.byteLength
        : 0;
  return fetch(url, withProxy(init, egressUrl)).then((res) => {
    if (metering) recordUsage(egressUrl, requestBytes, 0, { ok: res.ok && res.status < 400 });
    // Count response bytes as the stream is read: the response is always SSE
    // here, so wrapping the reader catches every payload without buffering it.
    if (metering && res.body && typeof res.body.getReader === "function") {
      const origGetReader = res.body.getReader.bind(res.body);
      let counted = false;
      res.body.getReader = () => {
        if (counted) return origGetReader();
        counted = true;
        const reader = origGetReader();
        const origRead = reader.read.bind(reader);
        reader.read = () =>
          origRead().then((chunk) => {
            if (chunk && chunk.value && chunk.value.byteLength) {
              loadUsage();
              const e = usageEntry(keyOf(egressUrl));
              e.responseBytes += chunk.value.byteLength;
              persistUsage();
            }
            return chunk;
          });
        return reader;
      };
    }
    return res;
  });
}

// ------------------------------------------------------------- usage meter ---

/**
 * Per-egress traffic accounting, persisted to usage.json beside the config.
 *
 * The point is phone data: when the egress is the Android phone over Tailscale,
 * every upstream byte is mobile data. Requests and response bytes are counted
 * here rather than derived from tokens because the wire carries headers, SSE
 * framing, and identity payloads that tokens do not describe. The bridge hands
 * the same numbers to OpenBot in `usage` (chat requests) and `/health`, so a
 * token-to-data ratio can be computed from one place.
 */
const USAGE_FILE_NAME = "usage.json";
function usageFile() {
  return path.join(stateDir(), USAGE_FILE_NAME);
}
let usage = {
  // day = UTC date string; rolls when a request lands on a new day.
  day: new Date().toISOString().slice(0, 10),
  perEgress: {}, // key -> { requests, okRequests, requestBytes, responseBytes, promptTokens, completionTokens }
};
let usageLoaded = false;

function usageEntry(key) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== usage.day) {
    usage = { day: today, perEgress: {} };
    persistUsage();
  }
  if (!usage.perEgress[key]) {
    usage.perEgress[key] = {
      requests: 0,
      okRequests: 0,
      requestBytes: 0,
      responseBytes: 0,
      promptTokens: 0,
      completionTokens: 0,
    };
  }
  return usage.perEgress[key];
}

function loadUsage() {
  if (usageLoaded) return;
  usageLoaded = true;
  try {
    const json = JSON.parse(fs.readFileSync(usageFile(), "utf8"));
    if (json && typeof json.day === "string" && json.perEgress && typeof json.perEgress === "object") {
      if (json.day === new Date().toISOString().slice(0, 10)) usage = { day: json.day, perEgress: json.perEgress };
    }
  } catch {}
}

function persistUsage() {
  try {
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.writeFileSync(usageFile(), `${JSON.stringify(usage, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
}

/** Record one wire transaction through an egress. Coarse, by design. */
function recordUsage(egressUrl, requestBytes, responseBytes, { ok = false, promptTokens = 0, completionTokens = 0 } = {}) {
  // Entries flagged `meter: false` in proxy.json stay out of usage.json —
  // the accounting exists for scarce links (phone data), not free ones.
  if (!shouldMeter(egressUrl)) return;
  // null/undefined means the direct entry; keyOf maps it to "@direct" so
  // direct traffic is accounted too, not silently dropped.
  loadUsage();
  const e = usageEntry(keyOf(egressUrl));
  e.requests += 1;
  e.requestBytes += Math.max(0, Math.round(requestBytes) || 0);
  e.responseBytes += Math.max(0, Math.round(responseBytes) || 0);
  if (ok) {
    e.okRequests += 1;
    e.promptTokens += Math.max(0, Math.round(promptTokens) || 0);
    e.completionTokens += Math.max(0, Math.round(completionTokens) || 0);
  }
  persistUsage();
}

/** Read view for /health and tests; adds derived MB and token/data ratio. */
function describeUsage() {
  loadUsage();
  const out = { day: usage.day, perEgress: {} };
  for (const [key, e] of Object.entries(usage.perEgress)) {
    const mb = (e.requestBytes + e.responseBytes) / 1_000_000;
    const tokens = e.promptTokens + e.completionTokens;
    out.perEgress[key] = {
      ...e,
      label: healthLabel(key),
      totalMB: Math.round(mb * 100) / 100,
      tokensPerMB: mb > 0.01 ? Math.round(tokens / mb) : null,
    };
  }
  return out;
}

/**
 * Prove one proxy works before it becomes the live egress.
 *
 * Two probes: the API the bridge actually calls, and a trace endpoint that
 * answers with the exit IP so the panel can show that egress moved. The API
 * probe is the one that decides `ok`; the IP probe is best-effort.
 */
async function testProxy(url, { timeoutMs = 15000, probeUrl = null } = {}) {
  if (typeof Bun === "undefined") {
    return { ok: false, error: "Proxy egress hanya berjalan di Bun; runtime Node tidak mendukung opsi proxy." };
  }
  const parsed = parseProxyUrl(url);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!parsed.url) return { ok: false, error: "URL proxy kosong." };

  const started = Date.now();
  const exit = await probeExitIp(parsed.url, timeoutMs);
  let res;
  try {
    // Default matches the shipped wire endpoint. The caller passes the live one
    // so a catalog migration does not turn a working proxy into a false failure.
    res = await fetch(probeUrl || "https://opencode.ai/inference/v1/models", {
      proxy: parsed.url,
      headers: { Authorization: "Bearer public" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      exitIp: exit.ip,
      latencyMs: Date.now() - started,
      error: `Tidak bisa menghubungi upstream lewat proxy: ${err.message}`,
    };
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    return {
      ok: false,
      apiStatus: res.status,
      exitIp: exit.ip,
      latencyMs,
      error:
        res.status === 403
          ? "Proxy tersambung, tapi upstream menolak egress-nya (403). Coba proxy lain."
          : `Proxy tersambung, upstream menjawab ${res.status}.`,
    };
  }
  return { ok: true, apiStatus: res.status, exitIp: exit.ip, latencyMs, exitError: exit.error || null };
}

/**
 * Probe every entry of the pool concurrently, and record the verdict in the
 * health map so the panel's result is also what the next request uses. A
 * throttled entry goes into cooldown; a working one is cleared.
 */
async function testPool({ probeUrl = null, timeoutMs = 15000 } = {}) {
  const entries = pool.entries.slice();
  if (entries.length === 0) return { ok: true, entries: [] };
  const results = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.enabled) return { id: entry.id, label: entry.label, host: displayHost(entry.url), skipped: true };
      const verdict = await testProxy(entry.url, { probeUrl, timeoutMs });
      const ok = verdict.ok;
      if (ok) markSuccess(entry.url);
      else if (verdict.apiStatus === 403) markFailure(entry.url, { reason: "upstream 403" });
      // Record where this entry exits, so a later cooldown can name the address
      // that earned it and a rotation can be told apart from a still-spent IP.
      if (verdict.exitIp) noteExitIp(entry.url, verdict.exitIp);
      // `health` is keyed by keyOf(), which maps the direct entry's empty URL to
      // "@direct" — reading it by the raw url would silently report no state.
      const h = health.get(keyOf(entry.url));
      return {
        id: entry.id,
        label: entry.label,
        host: displayHost(entry.url),
        ok: verdict.ok,
        apiStatus: verdict.apiStatus || null,
        exitIp: verdict.exitIp || null,
        latencyMs: verdict.latencyMs || null,
        error: verdict.error || null,
        state: h && h.cooldownUntil > Date.now() ? "cooling" : verdict.ok ? "ready" : "error",
      };
    })
  );
  return { ok: results.some((r) => r.ok), entries: results };
}

async function probeExitIp(proxyUrl, timeoutMs) {
  try {
    const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      proxy: proxyUrl,
      signal: AbortSignal.timeout(Math.min(timeoutMs, 8000)),
    });
    if (!res.ok) return { ip: null, error: `trace HTTP ${res.status}` };
    const text = await res.text();
    const ip = (text.match(/^ip=(.+)$/m) || [])[1] || null;
    return { ip, error: ip ? null : "trace tanpa field ip" };
  } catch (err) {
    return { ip: null, error: err.message };
  }
}

/**
 * Priority-failover recovery watchdog.
 *
 * Config order is priority. When a high-priority egress (the renewable phone
 * IP) is parked by a 429 and lower-priority entries are serving, a plain
 * "cooldown expiry" model only puts the phone back in the candidate list —
 * but `pick()` sticks to the first *healthy* entry, so it would not actually
 * return to the top until the serving entry also fails. This watchdog probes
 * a cooling entry once its cooldown has fully elapsed: one cheap
 * GET /v1/models through that egress. 200 clears the cooldown via
 * `markSuccess`, so the next `pick()` snaps back to the top entry; anything
 * else re-parks it with a fresh backoff. The walk order is the pool order,
 * so the highest-priority entry always recovers first.
 */
const RECOVERY_PROBE_INTERVAL_MS = 60_000;
/**
 * Last exit IP seen per egress key.
 *
 * Upstream keys the free allowance to the address it sees, not to the URL of
 * the proxy in front of it. A phone on mobile data rotates its address several
 * times a day, and every rotation hands back a fresh allowance — but the pool
 * only knew the proxy URL, so a `Retry-After` of 13 hours (measured: 47674s,
 * i.e. the next midnight UTC) kept the phone parked long after its address,
 * and with it the refusal, was gone. That is why a healthy entry could sit
 * cooling all day while the same URL answered 200 in a burst test.
 *
 * So an exit-IP change is treated as evidence the refusal no longer applies:
 * the cooldown is cleared and the entry returns to the pool. The mapping is
 * also persisted in the health file so a restart mid-cooldown can still notice
 * the rotation instead of trusting a stale park.
 */
const exitIpByKey = new Map();
let recoveryProbeBusy = false;
async function recoveryProbeTick() {
  if (recoveryProbeBusy) return;
  if (pool.strategy !== "priority-failover" || pool.entries.length === 0) return;
  recoveryProbeBusy = true;
  const now = Date.now();
  try {
    const active = activeEntries();
    // Address rotation outranks the cooldown clock: check the highest-priority
    // parked entry whose exit address is still worth re-reading. One probe per
    // tick, so the cost is a single trace request per minute at worst.
    const parked = active.find((e) => {
      const h = health.get(keyOf(e.url));
      return h && h.cooldownUntil > now;
    });
    if (parked) {
      const key = keyOf(parked.url);
      const seen = exitIpByKey.get(key);
      const exit = await probeExitIp(parked.url || null, 8_000);
      if (exit && exit.ip) {
        if (seen && seen !== exit.ip) {
          console.log(
            `[opencode-free-bridge] Egress ${displayHost(parked.url) || "direct"} rotated ${seen} -> ${exit.ip}; clearing the cooldown that IP earned`
          );
          exitIpByKey.set(key, exit.ip);
          markSuccess(parked.url);
          return;
        }
        if (!seen) exitIpByKey.set(key, exit.ip);
      }
    }
    // Walk the pool in priority order and probe the first entry whose
    // cooldown has fully elapsed. One probe per tick keeps the cost at one
    // models call per minute, worst case.
    const candidates = active.filter((e) => {
      const h = health.get(keyOf(e.url));
      return h && h.cooldownUntil > 0 && h.cooldownUntil <= now;
    });
    const entry = candidates[0];
    if (!entry) return;
    const before = health.get(keyOf(entry.url));
    if (before) before.cooldownUntil = now + RECOVERY_PROBE_INTERVAL_MS; // hold position during probe
    const probeUrl = process.env.OPENCODE_MODELS_URL || "https://opencode.ai/inference/v1/models";
    try {
      const res = await netFetch(probeUrl, {
        headers: { Authorization: "Bearer public" },
        signal: AbortSignal.timeout(10_000),
      }, entry.url || null);
      if (res.status === 200) {
        console.log(
          `[opencode-free-bridge] Priority egress ${displayHost(entry.url) || "direct"} recovered (probe 200); returning to top of pool`
        );
        markSuccess(entry.url);
      } else {
        markFailure(entry.url, { reason: `recovery probe ${res.status}` });
      }
    } catch (err) {
      markFailure(entry.url, { reason: `recovery probe transport: ${err.message}`.slice(0, 200) });
    }
  } finally {
    recoveryProbeBusy = false;
  }
}

loadFromDisk();

module.exports = {
  ENV_OVERRIDE,
  POOL_ENV,
  STRATEGY_ENV,
  configFile,
  healthFile,
  parseProxyUrl,
  parsePoolEntry,
  parsePoolSpec,
  displayHost,
  getProxyUrl,
  getPool: () => pool.entries.slice(),
  describe,
  setProxyUrl,
  setPool,
  pick,
  markFailure,
  markSuccess,
  resetHealth,
  noteExitIp,
  withProxy,
  netFetch,
  testProxy,
  testPool,
  recoveryProbeTick,
  recordUsage,
  describeUsage,
  get strategy() {
    return pool.strategy;
  },
  __setForTest(state) {
    current = state;
  },
  __reload: loadFromDisk,
  /** Simulate a process start: in-memory state gone, everything re-read from disk. */
  __restart() {
    health.clear();
    cursor = 0;
    loadFromDisk();
  },
  /** Force the coalesced health write, so a test can assert persisted state. */
  __flushHealth: () => writeHealthNow(),
};
