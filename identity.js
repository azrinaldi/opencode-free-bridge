#!/usr/bin/env bun
/**
 * identity.js — adaptive OpenCode CLI identity & security-layer sync.
 *
 * Keeps the bridge aligned with the official OpenCode CLI when upstream adjusts
 * its free-tier gate (User-Agent version floor, session ID format, headers, or
 * core tool fingerprint definitions).
 *
 * How it works:
 *  1. HANDSHAKE — Queries the same update endpoint the OpenCode CLI uses:
 *       GET https://opencode.ai/update/api/<channel>/cli/npm?current=<version>
 *       -> { version, minimum, metadata: { github: { sha } } }
 *     Falls back to GitHub's releases.atom feed if the update API is unreachable.
 *
 *  2. UPDATE MODES (`UPDATE_MODE`):
 *     - `reactive` (default): Uses the current identity until upstream rejects a
 *       request (403 FreeTierError / 426 UpgradeRequired) or flags `minimum: true`,
 *       then refreshes immediately and retries the request once.
 *     - `always`: Proactively adopts every new OpenCode release when the lazy
 *       TTL expires.
 *
 *  3. SOURCE SYNC — When moving to a new release (or forced by a gate error),
 *     fetches the lightweight source files at the release's exact commit SHA
 *     to update the session ID recipe, User-Agent template, and `read`/`shell`
 *     tool fingerprint schemas. Incomplete parses fall back safely to the last
 *     known-good values.
 */

const crypto = require("crypto");

const UPDATE_API_BASE =
  process.env.OPENCODE_UPDATE_API_BASE || "https://opencode.ai/update/api";
const ATOM_URL =
  process.env.OPENCODE_RELEASES_ATOM_URL ||
  "https://github.com/anomalyco/opencode/releases.atom";
const SOURCE_BASE =
  process.env.OPENCODE_SOURCE_BASE ||
  "https://raw.githubusercontent.com/anomalyco/opencode";

const CHANNEL = process.env.OPENCODE_CHANNEL || "latest";
const ARTIFACT = "cli";
const DISTRIBUTION = process.env.OPENCODE_DISTRIBUTION || "npm";

const IDENTITY_TTL_MS = parseInt(
  process.env.IDENTITY_TTL_MS || String(15 * 60 * 1000),
  10
);
const HANDSHAKE_TIMEOUT_MS = parseInt(
  process.env.HANDSHAKE_TIMEOUT_MS || process.env.IDENTITY_FETCH_TIMEOUT_MS || "6000",
  10
);
const SOURCE_TIMEOUT_MS = parseInt(
  process.env.IDENTITY_SOURCE_TIMEOUT_MS || "8000",
  10
);
const GATE_REFRESH_COOLDOWN_MS = parseInt(
  process.env.GATE_REFRESH_COOLDOWN_MS || "30000",
  10
);

function getUpdateMode() {
  const mode = (process.env.UPDATE_MODE || "reactive").toLowerCase().trim();
  return mode === "always" ? "always" : "reactive";
}

// Non-tool sources. These are individual files with a stable role, so they are
// named. The *tool* sources are not: see PLUGIN_DIR below.
const SOURCE_FILES = Object.freeze({
  identifier: "packages/schema/src/identifier.ts",
  sessionId: "packages/schema/src/session-id.ts",
  app: "packages/core/src/app.ts",
  modelRequest: "packages/core/src/session/model-request.ts",
});

// Every tool the CLI ships is a file in this directory. The list is discovered
// from the release tree rather than enumerated here: when upstream added
// `patch.ts`, `mcp-resource.ts`, and `opencode.ts`, a hardcoded list would have
// kept reading the eleven names it already knew and silently missed the new
// ones — which is the failure mode this bridge exists to avoid.
const PLUGIN_DIR = "packages/core/src/tool/plugin";
// The one wire tool that is not a plugin file: code mode's dispatcher. It is
// always present when code mode is enabled, and it is the tool the other
// (codemode: true) tools are reached through.
const CODEMODE_TOOL_FILE = "packages/core/src/codemode/tool.ts";
const GITHUB_API = process.env.OPENCODE_GITHUB_API || "https://api.github.com";
const REPO = process.env.OPENCODE_REPO || "anomalyco/opencode";

// The provider/model catalog the real CLI consumes at boot. The `opencode`
// provider entry carries the inference endpoints (`api` field): today
// `https://opencode.ai/inference/openai/v1`, formerly `/zen/v1`. Deriving the
// wire URLs from here made the /zen → /inference migration detectable — the
// URL is no longer a hardcoded constant.
const CATALOG_URL = process.env.OPENCODE_CATALOG_URL || "https://models.opencode.ai/api.json";
// The catalog is what makes model aliases and the free list derivable. Fetching
// it on every boot would leave a cold-start window where a client's shorthand
// ("mimo", "deepseek") resolves to nothing. The cache closes that window with
// the last real catalog this process saw — not with a table of names written by
// hand, which is what it replaces.
function getCatalogCacheDir() {
  const raw = process.env.OPENCODE_CACHE_DIR;
  if (raw !== undefined) {
    const trimmed = String(raw).trim();
    if (!trimmed || /^(off|0|false|none)$/i.test(trimmed)) return null;
    return trimmed;
  }
  return require("path").join(require("os").homedir(), ".opencode-free-bridge", "cache");
}
function getCatalogCacheFile() {
  const dir = getCatalogCacheDir();
  return dir ? require("path").join(dir, "catalog.json") : null;
}
function getSourceCacheFile() {
  const dir = getCatalogCacheDir();
  return dir ? require("path").join(dir, "source-recipe.json") : null;
}
const BOOT_FETCH = global.fetch;
const CATALOG_CACHE_DIR = getCatalogCacheDir();
const CATALOG_CACHE_FILE = getCatalogCacheFile();

const DEFAULT_RECIPE = Object.freeze({
  channel: "latest",
  version: "2.0.32",
  client: "cli",
  sessionPrefix: "ses_",
  sessionCharset: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  sessionLength: 26,
  sessionMultiplier: 0x1000,
  userAgentTemplate: "opencode/${app.channel}/${app.version}/${app.name}",
  // Wire endpoints, resolved from the upstream model catalog (field `api` of
  // the `opencode` provider). The fallback here matches today's gate; a catalog
  // read at refresh time replaces them, so a path migration upstream is picked
  // up without a bridge release.
  chatUrl: "https://opencode.ai/inference/v1/chat/completions",
  responsesUrl: "https://opencode.ai/inference/v1/responses",
  modelsUrl: "https://opencode.ai/inference/v1/models",
  catalogBase: "https://opencode.ai",
  // The header names upstream's own request builder sets, in its order. This is
  // the fallback when the source read fails, so it must be the complete set —
  // a partial list would silently stop sending a header the gate checks.
  headers: Object.freeze([
    "x-opencode-session-id",
    "x-session-affinity",
    "X-Session-Id",
    "User-Agent",
    "x-opencode-project",
    "x-opencode-session",
    "x-opencode-client",
  ]),
});

const DEFAULT_TOOLS = Object.freeze({
  read: {
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The line or directory entry to start reading from (1-based)",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description:
            "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: {
          type: "string",
          description:
            "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
        },
        timeout: {
          type: "integer",
          minimum: 0,
          description:
            "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
        },
        background: {
          type: "boolean",
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
});

const CORE_TOOL_NAMES = ["read", "shell", "bash"];

/**
 * Tool names the free-tier gate requires *by name*, independent of what the
 * derived profile happens to contain.
 *
 * Measured against upstream on 2026-10-18 by replaying byte-identical requests
 * from a blocked egress and a clean one, varying one field at a time:
 *
 *   - 12 real tools                     -> 200
 *   - the same 12 minus `read`          -> 403 FreeTierError
 *   - the same 12 minus any other tool  -> 200
 *   - `read` alone                      -> 200
 *   - `read` + 11 fabricated tools      -> 200
 *   - a fabricated tool *named* `read`  -> 200
 *   - the real `read` renamed `read_file` -> 403
 *
 * So the check is the name, not the description or the schema: a made-up
 * `read` with an empty schema passes, a renamed real one fails. That matters
 * here because the profile is derived from upstream's own plugin sources — if
 * upstream renames `read.ts` (or drops it), the derived wire shape loses the
 * anchor and the gate answers with the *same* 403 it uses for an exhausted IP.
 * Without this anchor the bridge would report a per-IP allowance problem while
 * the actual cause is a shape this bridge produced.
 *
 * The shipped definition is used as the fallback, so the anchor survives a
 * profile that no longer carries the name.
 */
const GATE_ANCHOR_TOOL_NAMES = ["read"];

/**
 * Header names the gate requires, independent of what the recipe lists.
 *
 * Measured the same way (clean egress, `read` tool present):
 *
 *   - no User-Agent                        -> 403
 *   - `opencode` (no version)              -> 403
 *   - `Mozilla/5.0 …`, `curl/8.18.0`       -> 403
 *   - `opencode/9.9.9`, `OpenCode/2.0.32`  -> 200
 *   - `x-opencode-session` alone           -> 200
 *   - `x-session-affinity` alone           -> 200
 *   - `x-opencode-session-id` alone        -> 403
 *   - no `x-opencode-client`/`-project`    -> 200
 *
 * The recipe is derived from upstream's request builder, so it normally lists
 * these. They are pinned anyway because a recipe change that drops one would
 * produce a 403 indistinguishable from a blocked IP.
 */
const GATE_ANCHOR_HEADER_NAMES = ["user-agent", "x-opencode-session", "x-session-affinity"];

let recipe = { ...DEFAULT_RECIPE };
let toolProfile = null;
let toolProfileSource = "default";
let toolProfileVersion = DEFAULT_RECIPE.version;
// The gate allowlist: tool names upstream accepts. Derived from the tool plugin
// sources at the release SHA; the wire sends these names (schema is not
// fingerprinted). Empty = fall back to the tool profile's own key order.
let toolNames = [];
// Per-model route overrides from the provider catalog (model id -> base URL).
let modelEndpoints = {};
// Free-tier model ids derived from the provider catalog (zero cost, not
// deprecated). Empty until the first successful catalog read.
let freeModels = [];
// id → "free" | "paid" | "deprecated", straight from the provider catalog.
let catalogVerdicts = {};
// catalog family → a free model id in that family (e.g. "nemotron-free").
let modelFamilies = {};
// id → { reasoning: boolean, maxOutput: number|null } from the catalog.
let modelFacts = {};
// Model-conditional tool swaps read from the release (see extractToolOverrides).
let toolOverrides = null;
// Tool descriptions the CLI extends at request time (see extractDynamicDescriptions).
let dynamicDescriptions = null;
// Tool plugin basenames last seen in the release tree. Seeded with the current
// set so the first refresh works even if the directory listing fails.
let knownPlugins = [
  "edit",
  "glob",
  "grep",
  "mcp-resource",
  "opencode",
  "patch",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "webfetch",
  "websearch",
  "write",
];
let lastRelease = null;
let lastAvailable = null;
let lastCheckTime = 0;
let refreshInFlight = null;
let refreshInFlightForced = false;
let versionFloor = null;
let lastRefreshError = null;
let lastSourceTag = null;
let optionalHeaders = [];
let lastForcedRefreshTime = 0;
let stateEpoch = 0;
let refreshGen = 0;
let lastSyncedSource = null;

function stableStringify(val) {
  if (!val || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(stableStringify).join(",") + "]";
  const keys = Object.keys(val).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(val[k])).join(",") + "}";
}

function clampString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

// --- Version & Handshake Helpers ---------------------------------------------

function sortVersions(list) {
  const seen = new Set();
  return list
    .filter((v) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v))
    .filter((v) => (seen.has(v) ? false : (seen.add(v), true)))
    .sort((a, b) => {
      const [a1, a2, a3] = a.split(".").map(Number);
      const [b1, b2, b3] = b.split(".").map(Number);
      return b1 - a1 || b2 - a2 || b3 - a3;
    });
}

function parseVersions(text) {
  const found = [];
  const re = /<title>v?(\d+\.\d+\.\d+)<\/title>/gi;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) found.push(m[1]);
  return sortVersions(found);
}

function selectVersion(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const pinned = process.env.OPENCODE_MAJOR;
  if (pinned && /^\d+$/.test(pinned)) {
    return versions.find((v) => v.split(".")[0] === pinned) || null;
  }
  return versions[0];
}

function compareVersions(a, b) {
  const [a1, a2, a3] = String(a).split(".").map(Number);
  const [b1, b2, b3] = String(b).split(".").map(Number);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

function parseVersionFloor(message) {
  const m = String(message || "").match(/(\d+\.\d+\.\d+)\s+or newer/i);
  return m ? m[1] : null;
}

function sourceRef(release) {
  if (release && release.sha) return release.sha;
  if (release && release.version) return `v${release.version}`;
  return process.env.OPENCODE_SOURCE_REF || "dev";
}

async function fetchJson(url, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url, timeoutMs = SOURCE_TIMEOUT_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * List the `.ts` files in a release directory.
 *
 * The tool plugins are discovered, not enumerated: a hardcoded list keeps
 * working after upstream adds a tool, which means it silently stops covering
 * the release. `raw.githubusercontent.com` cannot list a directory, so this
 * uses the contents API once per refresh; a failure returns an empty list and
 * the caller falls back to the previously known set.
 */
async function listSourceDir(dir, ref, timeoutMs = SOURCE_TIMEOUT_MS) {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${REPO}/contents/${dir}?ref=${encodeURIComponent(ref)}`,
      { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json
      .filter((e) => e && e.type === "file" && /^[a-z0-9-]+\.ts$/i.test(e.name))
      .map((e) => e.name.replace(/\.ts$/, ""));
  } catch {
    return [];
  }
}

/**
 * Resolve the current authoritative CLI release via OpenCode's update handshake,
 * falling back to the GitHub Atom feed when the update API is unreachable.
 */
async function resolveRelease(currentVersion = recipe.version) {
  const channel = process.env.OPENCODE_CHANNEL || CHANNEL;
  const url =
    `${UPDATE_API_BASE}/${encodeURIComponent(channel)}/${encodeURIComponent(ARTIFACT)}` +
    `/${encodeURIComponent(DISTRIBUTION)}?current=${encodeURIComponent(currentVersion || "0.0.0")}`;
  try {
    const data = await fetchJson(url, HANDSHAKE_TIMEOUT_MS);
    const version = typeof data?.version === "string" ? data.version : null;
    if (!version) throw new Error("update service returned no version");
    const github = data?.metadata?.github || {};
    const sha =
      typeof github.sha === "string" && /^[0-9a-f]{7,40}$/i.test(github.sha)
        ? github.sha
        : null;
    lastRelease = {
      version,
      sha,
      minimum: data.minimum === true,
      active: data.active !== false,
      channel: data.channel || channel,
      source: "update-api",
      resolvedAt: Date.now(),
      stale: false,
    };
    return lastRelease;
  } catch (primaryErr) {
    try {
      const text = await fetchText(ATOM_URL, HANDSHAKE_TIMEOUT_MS);
      const version = selectVersion(parseVersions(text));
      if (!version) throw new Error("no version found in release feed");
      lastRelease = {
        version,
        sha: null,
        minimum: false,
        active: true,
        channel,
        source: "atom-feed",
        resolvedAt: Date.now(),
        stale: false,
        degraded: `update-api: ${primaryErr.message}`,
      };
      return lastRelease;
    } catch (feedErr) {
      const error = `update-api: ${primaryErr.message}; atom-feed: ${feedErr.message}`;
      if (lastRelease) return { ...lastRelease, stale: true, error };
      return {
        version: null,
        sha: null,
        minimum: false,
        active: true,
        channel,
        source: "none",
        resolvedAt: null,
        stale: true,
        error,
      };
    }
  }
}

// --- Source Extraction (Recipe + Tool Definitions) ---------------------------

function interpolateTemplate(str, vars) {
  return str.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const key = expr.trim();
    if (vars[key] !== undefined) return String(vars[key]);
    // `FileSystem.DEFAULT_SEARCH_LIMIT` and friends: take the last segment and
    // look it up in the numeric constants harvested from the source. An
    // expression that still cannot be resolved is left as its own text rather
    // than being turned into a newline — a description that differs from the
    // CLI's by a stray line break is a wire mismatch.
    const tail = key.split(".").pop();
    if (vars[tail] !== undefined) return String(vars[tail]);
    // A date expression is evaluated, not emitted: the CLI sends the current
    // year, so a literal `${new Date().getFullYear()}` would differ from it.
    if (/new Date\(\)\.getFullYear\(\)/.test(key)) return String(new Date().getFullYear());
    return `\${${key}}`;
  });
}

/**
 * Read a balanced `{...}` / `(...)` / `[...]` region starting at `open`.
 * Regexes with lazy quantifiers stop at the first `\n})`, which is how a struct
 * with a multi-line `.annotate({...})` lost the fields after it.
 */
function readBalanced(source, openIndex) {
  const open = source[openIndex];
  const close = open === "{" ? "}" : open === "(" ? ")" : "]";
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return null;
}

// Every source file fetched for the current release, joined. Cross-file schema
// references are resolved against this when a plugin imports a struct or class
// from a sibling module.
let schemaCorpus = null;
// Numeric/constant bindings harvested from the corpus, used to interpolate
// `${...}` inside descriptions.
let schemaVars = null;
// basename → source text, for resolving `Namespace.Struct` references.
let schemaModules = null;

/** `Schema.Struct({...})` → the full call text, matched by braces. */
function readStructAt(source, indexOfStruct) {
  const paren = source.indexOf("(", indexOfStruct);
  if (paren < 0) return null;
  const args = readBalanced(source, paren);
  if (!args) return null;
  return `Schema.Struct${args}`;
}

/**
 * Locate the tool's input schema expression.
 *
 * Three forms upstream uses:
 *   1. `export const Input = Schema.Struct({ ... })`
 *   2. `input: LocationInput` inside `editor.add({...})`, defined above
 *   3. an inline `Schema.Struct({...})` passed as `input:`
 */
function findInputSchema(source) {
  const inlineAt = source.search(/input:\s*Schema\.Struct\s*\(/);
  if (inlineAt >= 0) {
    const structAt = source.indexOf("Schema.Struct", inlineAt);
    const full = readStructAt(source, structAt);
    if (full) return full;
  }

  const named = source.match(/input:\s*([A-Z][A-Za-z0-9_]*)\b/);
  if (named) {
    // Follow aliasing: `export const Input = LocationInput` where
    // `LocationInput` holds the Struct (read.ts does this).
    let varName = named[1];
    for (let hop = 0; hop < 3; hop++) {
      const decl = source.match(
        new RegExp(`(?:const|export\\s+const)\\s+${varName}\\s*=\\s*(Schema\\.Struct\\s*\\()`)
      );
      if (decl) {
        const structAt = source.indexOf("Schema.Struct", decl.index);
        const full = readStructAt(source, structAt);
        if (full) return full;
      }
      const alias = source.match(
        new RegExp(`(?:const|export\\s+const)\\s+${varName}\\s*=\\s*([A-Z][A-Za-z0-9_]*)\\b`)
      );
      if (!alias) break;
      varName = alias[1];
    }
  }

  const exportedAt = source.search(/export\s+const\s+Input\s*=\s*Schema\.Struct\s*\(/);
  if (exportedAt >= 0) {
    const structAt = source.indexOf("Schema.Struct", exportedAt);
    return readStructAt(source, structAt);
  }
  return null;
}

/** Split a `{ a: x, b: y }` body at top-level commas (ignores nested braces,
 *  brackets, parens, strings, and template literals). */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (start < body.length) parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Undo the escapes that carry meaning in a description string. */
function unescapeLiteral(text) {
  if (typeof text !== "string") return text;
  // A single left-to-right pass, so each escape is consumed exactly once.
  // Doing the replacements sequentially mangled `\\n` (an escaped backslash
  // followed by `n`, i.e. the two characters `\n`) into backslash + newline.
  return text.replace(/\\(r\\n|n|t|"|'|`|\\)/g, (_, seq) => {
    switch (seq) {
      case "r\n":
      case "n":
        return "\n";
      case "t":
        return "\t";
      case '"':
        return '"';
      case "'":
        return "'";
      case "`":
        return "`";
      case "\\":
        return "\\";
      default:
        return seq;
    }
  });
}

/** Read a JS string/template literal body and unescape it. */
function readStringLiteral(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/s);
  if (!m) return null;
  const text = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  return unescapeLiteral(text);
}

/**
 * Evaluate one field's schema expression into a JSON Schema fragment plus its
 * requiredness. This understands the constructors upstream uses and nothing
 * else; anything unrecognised degrades to `{ type: "string" }`.
 */
function parseFieldSchema(expr, source) {
  let required = true;
  let schema = {};

  // Unwrap modifiers, outermost first.
  let working = expr.trim();
  const optional =
    /Schema\.optionalKey\(/.test(working) ||
    /Schema\.optional\(/.test(working) ||
    // A decoding default makes the field omittable on the wire even though the
    // schema itself is not wrapped in optionalKey (webfetch's `format`).
    /withDecodingDefault(Key)?\(/.test(working) ||
    // `.pipe(optional)` / `.pipe(Schema.optional)` — the shared `optional`
    // helper in packages/schema/src/schema.ts.
    /\.pipe\(\s*(?:Schema\.)?optional\b/.test(working);
  if (optional) required = false;

  // Description and constraints are collected first, then applied in the order
  // the CLI emits them (`type`, bounds, `description`) — the wire body is
  // compared by upstream, so key order is part of matching it exactly.
  let description = null;
  const annotate = working.match(/\.annotate\(\{\s*description:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/s);
  if (annotate) {
    description = readStringLiteral(annotate[1]);
    if (description && schemaVars) description = interpolateTemplate(description, schemaVars);
    // Where the annotation sits relative to `.pipe(...)` decides whether it
    // reaches the wire: `Schema.X.annotate({...}).pipe(...)` keeps it (webfetch's
    // `format`), while `Schema.X.pipe(...).annotate({...})` does not (question's
    // `multiple`). Compare positions rather than the mere presence of a pipe.
    const pipeAt = working.indexOf(".pipe(");
    const annotateAt = working.indexOf(".annotate(");
    if (pipeAt >= 0 && annotateAt > pipeAt) description = null;
  }

  // Base type, from the innermost constructor. A local alias
  // (`const Timeout = Schema.Finite.check(...)`) is expanded first so both the
  // type and the constraints can be read from what it actually is.
  let core = working
    .replace(/Schema\.optionalKey\(/g, "(")
    .replace(/Schema\.optional\(/g, "(");
  let expanded = core;
  const aliasMatch = core.match(/^\s*\(?\s*([A-Z][A-Za-z0-9_]*)\b/);
  // Only a *local* alias is expanded: not `Schema` itself, and not a name that
  // is a struct/class reference (`Question.Prompt`, `FileSystem.GlobInput`).
  const isLocalAlias =
    aliasMatch &&
    aliasMatch[1] !== "Schema" &&
    !/\./.test(core.slice(aliasMatch.index + aliasMatch[0].length).trim().slice(0, 1)) &&
    schemaCorpus &&
    new RegExp(`const\\s+${aliasMatch[1]}\\s*=\\s*Schema\\.`).test(schemaCorpus);
  if (isLocalAlias) {
    const decl = schemaCorpus.match(new RegExp(`const\\s+${aliasMatch[1]}\\s*=\\s*([^\\n]+)`));
    if (decl) {
      expanded = `${decl[1]} ${core}`;
      core = expanded;
    }
  }

  const constraints = {};
  const minLength = working.match(/\.check\(\s*Schema\.isMinLength\(\s*(\d+)/);
  if (minLength) constraints.minLength = Number(minLength[1]);
  const maxLength = working.match(/\.check\(\s*Schema\.isMaxLength\(\s*(\d+)/);
  if (maxLength) constraints.maxLength = Number(maxLength[1]);
  if (/\.check\(\s*Schema\.isNonEmpty\(\)/.test(expanded)) constraints.minItems = 1;
  if (/\.check\([^)]*Schema\.isGreaterThan\(\s*0\s*\)/.test(expanded)) constraints.exclusiveMinimum = 0;
  const maxValue = expanded.match(/\.check\(\s*Schema\.isLessThanOrEqualTo\(\s*(\d+)/);
  if (maxValue) constraints.maximum = Number(maxValue[1]);
  // `Timeout` carries its ceiling in a named constant.
  if (/^\s*(?:Schema\.optionalKey\()?\s*Timeout\b/.test(working) && schemaVars && Number.isFinite(schemaVars.MAX_TIMEOUT_SECONDS)) {
    constraints.maximum = schemaVars.MAX_TIMEOUT_SECONDS;
  }

  if (/Schema\.Literals\(\s*\[([^\]]*)\]/.test(core)) {
    const list = core.match(/Schema\.Literals\(\s*\[([^\]]*)\]/)[1];
    const values = [...list.matchAll(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)].map((m) =>
      readStringLiteral(m[1])
    );
    schema = { ...schema, type: "string", enum: values };
  } else if (/Schema\.Array\(/.test(core)) {
    const inner = core.match(/Schema\.Array\(([\s\S]*)\)/);
    const itemExpr = inner ? inner[1] : "";
    // A nested Struct becomes an object schema with its own fields.
    const struct = itemExpr.match(/Schema\.Struct\(\{([\s\S]*)\n\s*\}\)/);
    if (struct) {
      const nested = parseStructBody(struct[1], source);
      schema = { ...schema, type: "array", items: { type: "object", ...nested } };
    } else if (/\.fields\.[a-zA-Z]/.test(itemExpr)) {
      // `SomeClass.fields.x` — a single field, not a struct.
      const ref = itemExpr.match(/^\s*([A-Za-z][A-Za-z0-9_.]*)/);
      const resolved = ref ? resolveStructRef(ref[1], source) : null;
      schema = { ...schema, type: "array", items: resolved || { type: "string" } };
    } else {
      // `Schema.Array(Question.Prompt)` — a named struct/class.
      const ref = itemExpr.match(/^\s*([A-Za-z][A-Za-z0-9_.]*)/);
      const resolved = ref ? resolveStructRef(ref[1], source) : null;
      schema = { ...schema, type: "array", items: resolved || { type: "string" } };
    }
  } else if (/\bBoolean\b/.test(core)) {
    schema = { ...schema, type: "boolean" };
  } else if (/\bPositiveInt\b/.test(core)) {
    schema = { ...schema, type: "integer", exclusiveMinimum: 0 };
  } else if (/\bNonNegativeInt\b/.test(core)) {
    schema = { ...schema, type: "integer", minimum: 0 };
  } else if (/Schema\.(?:Int|Number|Finite)\b/.test(core)) {
    schema = { ...schema, type: "number" };
  } else if (/\bSession[A-Za-z]*\.ID\b/.test(core) || /\bSessionID\b/.test(core)) {
    schema = { ...schema, type: "string", pattern: "^ses" };
  } else if (/\.fields\.[A-Za-z0-9_]+/.test(core)) {
    // A field borrowed from a shared struct: `PageInput.fields.offset`,
    // `ReadToolFileSystem.PageInput.fields.limit`, `GlobInput.fields.hidden`.
    // The field's type AND optionality live on the source struct, so resolve it
    // there rather than inferring from the name. `ReadToolFileSystem` is a
    // namespace import, so the struct is the segment right before `.fields`.
    const ref = core.match(/([A-Z][A-Za-z0-9_]*)\.fields\.([A-Za-z0-9_]+)/);
    const resolved = ref ? resolveStructField(ref[1], ref[2], source) : null;
    if (resolved) {
      schema = { ...resolved.schema, ...schema };
      if (resolved.optional) required = false;
    } else {
      // Unresolvable (no corpus for this reference). The page fields are the
      // common case: offset/limit on read. Guessing their real shape is better
      // than emitting `string` + required, which would be a worse wire match
      // than the previous behaviour and would also mark them mandatory.
      const field = ref ? ref[2] : "";
      if (/^(offset|limit)$/.test(field)) {
        schema = { ...schema, type: "integer", minimum: 0 };
        required = false;
      } else if (/^(hidden|literal|caseSensitive|background)$/.test(field)) {
        schema = { ...schema, type: "boolean" };
      } else {
        schema = { ...schema, type: "string" };
      }
    }
  } else {
    schema = { ...schema, type: "string" };
  }

  // `Timeout` is a branded number with a maximum, used by webfetch. Only apply
  // it when the expression IS that brand — `NonNegativeInt` also appears in
  // shell's timeout field, and matching any occurrence changed its type.
  if (/^\s*(?:Schema\.optionalKey\()?\s*Timeout\b/.test(core)) {
    schema = { ...schema, type: "number", exclusiveMinimum: 0 };
  }

  // Assemble in wire order: type → constraints → description. `description`
  // first would emit a different key order than the CLI's own JSON Schema.
  const merged = { ...schema, ...constraints };
  const ordered = {};
  for (const k of ["type", "minLength", "maxLength", "minimum", "exclusiveMinimum", "maximum", "pattern", "enum", "items", "minItems"]) {
    if (merged[k] !== undefined) ordered[k] = merged[k];
  }
  if (description) ordered.description = description;

  return { required, schema: ordered };
}

/** `Schema.Struct({...})` body → { properties, required, additionalProperties }. */
function parseStructBody(body, source) {
  const properties = {};
  const required = [];
  for (const part of splitTopLevel(body)) {
    const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    const [, key, expr] = m;
    const { required: isRequired, schema } = parseFieldSchema(expr, source);
    properties[key] = schema;
    if (isRequired) required.push(key);
  }
  return { properties, required, additionalProperties: false };
}

function parseSchemaExpr(expr, source) {
  const text = String(expr);
  const structAt = text.indexOf("Schema.Struct");
  if (structAt < 0) return null;
  const paren = text.indexOf("(", structAt);
  const args = readBalanced(text, paren);
  if (!args) return null;

  // `Schema.Struct({ ... })` — literal fields.
  const brace = args.indexOf("{");
  if (brace >= 0) {
    const body = readBalanced(args, brace);
    if (body) return parseStructBody(body.slice(1, -1), source);
  }

  // `Schema.Struct(base)` — the fields live in a named object literal declared
  // above (`const base = { ... }`), which is how Question.Prompt is written.
  const ref = args.slice(1, -1).trim().match(/^([A-Za-z_$][\w$]*)$/);
  if (ref) {
    const at = source.search(new RegExp(`const\\s+${ref[1]}\\s*=\\s*\\{`));
    if (at >= 0) {
      const objBrace = source.indexOf("{", at);
      const body = readBalanced(source, objBrace);
      if (body) return parseStructBody(body.slice(1, -1), source);
    }
  }
  return null;
}

/** Resolve `Question.Prompt` to the `Prompt` struct declared in the same file. */
function resolveStructRef(name, source) {
  const parts = String(name).split(".");
  const short = parts.pop();
  // For `Question.Prompt`, prefer the file that defines the `Question` module:
  // the joined corpus contains many unrelated `Prompt` declarations, and taking
  // the first match resolved to a different struct entirely.
  if (parts.length > 0 && schemaModules) {
    const namespace = parts[parts.length - 1];
    const mod = schemaModules.get(namespace);
    if (mod) {
      // Resolve the struct inside that module only. Recursing with `short`
      // would re-enter this function with no namespace and fall back to the
      // joined corpus, which is what produced the wrong struct.
      const at = mod.search(
        new RegExp(`(?:const|export\\s+const)\\s+${short}\\s*=\\s*Schema\\.Struct\\s*\\(`)
      );
      if (at >= 0) {
        const structAt = mod.indexOf("Schema.Struct", at);
        const parsed = parseSchemaExpr(mod.slice(structAt, structAt + 6000), mod);
        if (parsed) return { type: "object", ...parsed };
      }
    }
  }
  const at = source.search(new RegExp(`(?:const|export\\s+const)\\s+${short}\\s*=\\s*Schema\\.Struct\\s*\\(`));
  if (at < 0 && typeof schemaCorpus === "string" && schemaCorpus !== source) {
    return resolveStructRef(short, schemaCorpus);
  }
  if (at < 0) return null;
  const structAt = source.indexOf("Schema.Struct", at);
  const parsed = parseSchemaExpr(source.slice(structAt, structAt + 4000), source);
  if (!parsed) return null;
  return { type: "object", ...parsed };
}

/**
 * Resolve `SomeStruct.fields.name` from the struct that declares it.
 *
 * The struct may be a `const X = Schema.Struct({...})` or a
 * `class X extends Schema.Class<X>(...)({...})`, and it may live in a module the
 * plugin imports rather than in the plugin itself — `read.ts` refers to
 * `ReadToolFileSystem.PageInput`, declared in `read-filesystem.ts`.
 */
function resolveStructField(structName, field, source) {
  for (const corpus of [source, typeof schemaCorpus === "string" ? schemaCorpus : null]) {
    if (!corpus) continue;
    for (const part of structFields(structName, corpus)) {
      const m = part.match(new RegExp(`^${field}\\s*:\\s*([\\s\\S]+)$`));
      if (!m) continue;
      const parsed = parseFieldSchema(m[1], corpus);
      return { schema: parsed.schema, optional: !parsed.required };
    }
  }
  return null;
}

/** The field list of a struct/class declaration, wherever it appears. */
function structFields(structName, corpus) {
  const out = [];
  // const X = Schema.Struct({ ... })
  const constAt = corpus.search(
    new RegExp(`(?:const|export\\s+const)\\s+${structName}\\s*=\\s*Schema\\.Struct\\s*\\(`)
  );
  if (constAt >= 0) {
    const structAt = corpus.indexOf("Schema.Struct", constAt);
    const args = readBalanced(corpus, corpus.indexOf("(", structAt));
    const brace = args ? args.indexOf("{") : -1;
    const body = brace >= 0 ? readBalanced(args, brace) : null;
    if (body) out.push(...splitTopLevel(body.slice(1, -1)));
  }
  // class X extends Schema.Class<X>("...")({ ... })
  const classAt = corpus.search(new RegExp(`class\\s+${structName}\\b`));
  if (classAt >= 0) {
    const paren = corpus.indexOf("(", classAt);
    const first = paren >= 0 ? readBalanced(corpus, paren) : null;
    if (first) {
      const after = corpus.indexOf("(", paren + first.length);
      const second = after >= 0 ? readBalanced(corpus, after) : null;
      const brace = second ? second.indexOf("{") : -1;
      const body = brace >= 0 ? readBalanced(second, brace) : null;
      if (body) out.push(...splitTopLevel(body.slice(1, -1)));
    }
  }
  return out;
}

/**
 * Extract a single tool's wire definition (`description` + JSON Schema `parameters`)
 * directly from its TypeScript plugin source (`read.ts` or `shell.ts`).
 */
function extractToolFromSource(source, fallbackName) {
  if (typeof source !== "string" || !source.trim()) return null;

  const nameMatch = source.match(/export\s+const\s+name\s*=\s*"([a-z][a-z0-9_-]*)"/i);
  const name = nameMatch ? nameMatch[1] : fallbackName;
  if (!name) return null;

  const vars = { OS: "Linux", shell: "bash" };
  // Constants declared in the corpus (including imported modules) so template
  // interpolation can resolve `FileSystem.DEFAULT_SEARCH_LIMIT`.
  const corpusForVars = typeof schemaCorpus === "string" ? `${source}\n${schemaCorpus}` : source;
  for (const m of corpusForVars.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*([0-9][0-9_*\s+]*)/g)) {
    const clean = m[2].replace(/_/g, "").trim();
    if (/^[0-9*\s+]+$/.test(clean)) {
      const val = clean
        .split("+")
        .map((part) => part.split("*").reduce((acc, n) => acc * Number(n.trim()), 1))
        .reduce((a, b) => a + b, 0);
      if (Number.isFinite(val)) vars[m[1]] = val;
    }
  }

  // A description can live in a sibling `.txt` file (`patch.ts` does this:
  // `import DESCRIPTION from "../patch.txt"`). The extractor cannot read a file
  // it was not given, so it reports the reference and the refresh fetches it.
  const txtImport = source.match(/import\s+([A-Za-z_$][\w$]*)\s+from\s+"(\.\.?\/[^"]+\.txt)"/);

  // 1. Tool description. Three upstream forms:
  //    (a) array literal (optionally inside an arrow fn) joined with " " or "\n"
  //    (b) exported template/string literal
  //    (c) a `description` key inside `editor.add({ ... })`
  let description = null;
  const builderMatch = source.match(
    /const\s+description\s*=\s*(?:\([^)]*\)\s*=>\s*)?\[([\s\S]*?)\]\.join\(\s*(?:"([^"]*)"|'([^']*)')\s*\)/m
  );
  const litRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  if (builderMatch) {
    // Groups are the joiner's *contents* (`" "` gives ` `, `"\n"` gives `\n`).
    const rawJoiner = builderMatch[2] !== undefined ? builderMatch[2] : builderMatch[3];
    const joiner = String(rawJoiner === undefined ? " " : rawJoiner).replace(/\\n/g, "\n");
    const parts = [];
    let lm;
    while ((lm = litRe.exec(builderMatch[1])) !== null) {
      const raw =
        lm[1] !== undefined
          ? unescapeLiteral(lm[1])
          : interpolateTemplate(unescapeLiteral(lm[2] !== undefined ? lm[2] : lm[3] || ""), vars);
      // An empty literal is a deliberate blank line in the joined description
      // (`skill` separates its paragraphs that way); dropping it shortened the
      // text by one newline against the CLI's.
      parts.push(raw);
    }
    if (parts.length > 0) description = parts.join(joiner);
  } else {
    // Multi-line template literal. The closing backtick must be an *unescaped*
    // one: a description that quotes code (`` \`multiple: true\` ``) contains
    // escaped backticks, and a lazy match stopped at the first of those.
    const tpl = source.match(/export\s+const\s+description\s*=\s*`((?:[^`\\]|\\.)*)`/s);
    if (tpl) description = interpolateTemplate(unescapeLiteral(tpl[1]), vars);
    else {
      const dq = source.match(/export\s+const\s+description\s*=\s*"((?:[^"\\]|\\.)*)"/m);
      const sq = source.match(/export\s+const\s+description\s*=\s*'((?:[^'\\]|\\.)*)'/m);
      if (dq) description = unescapeLiteral(dq[1]);
      else if (sq) description = interpolateTemplate(unescapeLiteral(sq[1]), vars);
    }
  }
  if (!description || description.length < 20) {
    const addBlock0 = source.match(/editor\.add\(\{([\s\S]*?)\binput\s*:/);
    if (addBlock0) {
      const descMatch0 = addBlock0[1].match(
        /description\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/
      );
      if (descMatch0) {
        description =
          descMatch0[1] !== undefined
            ? unescapeLiteral(descMatch0[1])
            : interpolateTemplate(
                unescapeLiteral(descMatch0[2] !== undefined ? descMatch0[2] : descMatch0[3] || ""),
                vars
              );
      }
    }
  }
  if ((!description || description.length < 20) && txtImport) {
    return {
      name,
      description: null,
      descriptionFile: txtImport[2],
      descriptionVar: txtImport[1],
      parameters: null,
    };
  }
  if (!description || description.length < 20) {
    // A substituted literal from the sibling `.txt` is a plain string, not an
    // `export const description = ...`, so read it from the add block.
    const fromAdd = source.match(/description\s*:\s*"((?:[^"\\]|\\.){20,})"/);
    if (fromAdd) description = fromAdd[1].replace(/\\n/g, "\n");
  }
  if (!description || description.length < 20) return null;

  // 2. The input schema. Upstream writes these as Effect Schema expressions,
  //    and the shape that reaches the wire is the JSON Schema derived from
  //    them. Rather than pattern-match each form, this parses the field list and
  //    evaluates the small, closed set of constructors upstream actually uses:
  //    Schema.String / Number / Int / Boolean / Array / Literals / Struct,
  //    optionalKey, annotate (description), check (minLength), and the shared
  //    class fields (`FileSystem.GlobInput.fields.hidden`). A construct it does
  //    not recognise becomes a plain string — the previous behaviour — but the
  //    recognised ones now carry their real type, enum, bounds, and requiredness.
  const inputExpr = findInputSchema(source);
  if (!inputExpr) return null;
  const parsed = parseSchemaExpr(inputExpr, source);
  if (!parsed || Object.keys(parsed.properties).length === 0) return null;
  const { properties, required } = parsed;

  return {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

/**
 * Resolve wire endpoints from the upstream provider catalog.
 *
 * The catalog is the same file the real CLI reads at boot
 * (`models.opencode.ai/api.json`). Its `opencode` provider entry carries the
 * live inference base URLs — this is how the /zen/v1 → /inference/v1 migration
 * would have been surfaced without a bridge release. Every resolved URL is
 * sanity-checked before adoption; a malformed catalog changes nothing.
 */
function readCachedCatalog() {
  try {
    const file = getCatalogCacheFile();
    if (!file) return null;
    const fs = require("fs");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    // A cached catalog is only useful if it is structurally a catalog.
    if (parsed && typeof parsed === "object" && parsed.opencode) return parsed;
  } catch {}
  return null;
}

function writeCachedCatalog(json) {
  try {
    const dir = getCatalogCacheDir();
    const file = getCatalogCacheFile();
    if (!dir || !file) return;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(json));
    fs.renameSync(tmp, file);
  } catch {
    // A read-only home directory must not break the bridge; the fetch still
    // worked, this process just will not have a warm start next time.
  }
}

function readCachedSource(expectedRef = null) {
  try {
    const file = getSourceCacheFile();
    if (!file) return null;
    const fs = require("fs");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.ref === "string" &&
      parsed.extracted &&
      typeof parsed.extracted === "object"
    ) {
      if (expectedRef && parsed.ref !== expectedRef) return null;
      return parsed;
    }
  } catch {}
  return null;
}

function writeCachedSource(ref, extracted) {
  if (!ref || !extracted || typeof extracted !== "object") return;
  try {
    const dir = getCatalogCacheDir();
    const file = getSourceCacheFile();
    if (!dir || !file) return;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ref, extracted, savedAt: Date.now() }));
    fs.renameSync(tmp, file);
  } catch {}
}

function isTrustedCatalogBaseUrl(url) {
  return typeof url === "string" && /^https:\/\/([a-z0-9-]+\.)*opencode\.ai(\/|$)/i.test(url);
}

function parseCatalogData(json) {
  const out = {};
  const oc = json?.opencode;
  if (!oc || typeof oc !== "object") return out;
  const api = typeof oc.api === "string" ? oc.api.replace(/\/+$/, "") : null;
  if (api && isTrustedCatalogBaseUrl(api)) {
    out.catalogBase = api;
    out.chatUrl = `${api}/chat/completions`;
    // The Responses lane is the same base with /responses — that is how the
    // real CLI's @ai-sdk/openai route is built. Keep the current value if the
    // derived URL would be identical to the chat URL (malformed catalog).
    if (api.endsWith("/v1")) out.responsesUrl = `${api}/responses`;
  }
  // Per-model route overrides. The catalog lets a single model pin a different
  // base (e.g. the anthropic-protocol models under /inference/anthropic/v1).
  // This bridge speaks the OpenAI protocols only, so an override is adopted
  // only when the model's SDK is OpenAI-compatible; an anthropic-only route is
  // left alone rather than silently misrouted.
  const overrides = {};
  for (const [id, m] of Object.entries(oc.models || {})) {
    const mp = m?.provider?.api;
    if (typeof mp !== "string" || !isTrustedCatalogBaseUrl(mp)) continue;
    const npm = String(m?.provider?.npm || oc.npm || "");
    if (!npm.startsWith("@ai-sdk/openai")) continue;
    const base = mp.replace(/\/+$/, "");
    if (base !== api) overrides[id.toLowerCase()] = base;
  }
  if (Object.keys(overrides).length > 0) out.modelEndpoints = overrides;
  // The free-tier list is a catalog fact, not a naming convention. Deriving it
  // from `cost` + `status` is what the CLI itself does (models-dev.ts maps
  // `status ?? "active"` and keeps zero-cost models), so a model that stops
  // being free or gets deprecated drops out without a bridge release — and one
  // that is free but missing from the gateway's /models is not lost.
  //
  // `catalogVerdicts` records every model the catalog describes, so a caller
  // can tell "the catalog says this one is paid/deprecated" apart from "the
  // catalog does not know this id at all" (the gateway lists a few evaluator
  // models the catalog omits).
  const freeModels = [];
  const verdicts = {};
  const modelFacts = {};
  for (const [id, m] of Object.entries(oc?.models || {})) {
    const zeroCost = Number(m?.cost?.input) === 0 && Number(m?.cost?.output) === 0;
    const deprecated = m?.status === "deprecated";
    const usable = m?.tool_call !== false;
    const key = id.toLowerCase();
    verdicts[key] = deprecated ? "deprecated" : zeroCost && usable ? "free" : "paid";
    if (verdicts[key] === "free") freeModels.push(id);
    // Model facts the wire depends on. `reasoning` decides whether the client's
    // token budget needs thinking headroom (token-budget.js used to guess this
    // from substrings of the name), and `limit.output` caps a request.
    if (typeof m?.reasoning === "boolean") {
      modelFacts[key] = {
        reasoning: m.reasoning,
        maxOutput: Number(m?.limit?.output) > 0 ? Number(m.limit.output) : null,
      };
    }
  }
  if (freeModels.length > 0) out.freeModels = freeModels;
  if (Object.keys(verdicts).length > 0) out.catalogVerdicts = verdicts;
  if (Object.keys(modelFacts).length > 0) out.modelFacts = modelFacts;

  // Shorthand aliases, derived from the catalog's own `family` field instead of
  // a hand-maintained table. `family` groups revisions of one model
  // (`nemotron-free`, `deepseek-flash`), so the newest non-deprecated free
  // member answers the family name — and when a revision is retired the alias
  // follows automatically.
  const families = {};
  for (const [id, m] of Object.entries(oc.models || {})) {
    if (verdicts[id.toLowerCase()] !== "free") continue;
    const family = typeof m?.family === "string" ? m.family.trim().toLowerCase() : "";
    if (!family) continue;
    if (!families[family]) families[family] = id;
  }
  if (Object.keys(families).length > 0) out.modelFamilies = families;

  return out;
}

async function extractCatalog() {
  let json;
  let fromCache = false;
  try {
    json = await fetchJson(CATALOG_URL, SOURCE_TIMEOUT_MS);
    writeCachedCatalog(json);
  } catch {
    // Network unavailable: fall back to the last catalog this machine saw, so
    // aliases and the free list keep working offline instead of going empty.
    json = readCachedCatalog();
    if (!json) return {};
    fromCache = true;
  }
  const out = parseCatalogData(json);
  if (fromCache) out.fromCache = true;
  return out;
}

/**
 * Extract the tool *name list* (the gate's allowlist) from all fetched tool
 * source files. Schema details are secondary — the upstream gate validates the
 * tool name against its list (schema content is not fingerprinted), so the
 * wire needs correct names, not byte-identical schemas.
 */
/**
 * Which tools appear in the model's tool list.
 *
 * Upstream decides this per tool with `options: { codemode: false }` in the
 * registration block: those are sent on the wire, while everything else is
 * reached through the `execute` tool. Measured against the real CLI's request,
 * the wire carries exactly the `codemode: false` set (plus `execute`). Deriving
 * the list from that flag means a tool that moves into code mode drops out and
 * a new direct tool appears, without either being named here.
 */
function extractToolNames(files = {}) {
  const names = [];
  const seen = new Set();
  for (const key of Object.keys(files)) {
    if (!key.startsWith("tool:")) continue;
    const source = files[key];
    if (typeof source !== "string" || !source.trim()) continue;

    const exported = (source.match(/export\s+const\s+name\s*=\s*"([a-z][a-z0-9_-]*)"/i) || [])[1];
    const fallback = key.replace(/^tool:/, "").replace(/[^a-z0-9_-]/gi, "");

    for (const block of registrationBlocks(source)) {
      if (!/codemode:\s*false/.test(block.body)) continue;
      const literal = (block.body.match(/name:\s*"([a-z][a-z0-9_-]*)"/i) || [])[1];
      // `name,` (shorthand for the exported constant) or `name:` with no literal.
      const shorthand = /^\s*name\s*,/m.test(block.body) || /name:\s*name\b/.test(block.body);
      const name = literal || (shorthand ? exported || fallback : null);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Every `editor.add({ ... })` / `draft.add({ ... })` registration in a source
 * file, with its argument text. Braces are matched by counting, so a nested
 * `execute:` closure does not truncate the block the way a regex would.
 */
function registrationBlocks(source) {
  const blocks = [];
  const re = /(?:editor|draft)\.add\(/g;
  let m;
  while ((m = re.exec(source))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0) blocks.push({ body: source.slice(start, i), index: m.index });
  }
  return blocks;
}

/**
 * Tool-set overrides that depend on the model, extracted from the sources.
 *
 * `patch.ts` installs a session hook that swaps the editing tools per model:
 * GPT models (excluding `oss` and `gpt-4`) get `patch` and lose `edit`/`write`;
 * everything else keeps `edit`/`write` and loses `patch`. That is why the real
 * CLI's request for a non-GPT model carries eleven tools and no `patch`, while
 * a GPT model carries `patch` instead of `edit`+`write`. A fixed list cannot
 * express this, so the rule is read from the release and applied per request.
 */
/**
 * Descriptions upstream extends at request time.
 *
 * `subagent.ts` rewrites its description on every request to append the agents
 * the caller may use. The list itself is session state, not something a release
 * source can supply, but the *shape* is: a blank line, a heading, and one
 * `- <id>: <description>` line per agent. Extracting the shape keeps the static
 * prefix identical to the CLI's and marks the dynamic tail so it is not silently
 * missing.
 */
function extractDynamicDescriptions(files = {}) {
  const out = {};
  for (const key of Object.keys(files)) {
    if (!key.startsWith("tool:")) continue;
    const source = files[key];
    if (typeof source !== "string") continue;
    if (!/tool\.description\s*=\s*\[/.test(source)) continue;
    const exported = source.match(/export\s+const\s+name\s*=\s*"([a-z][a-z0-9_-]*)"/i);
    const block = source.match(/tool\.description\s*=\s*\[([\s\S]*?)\]\.join\(\s*"([^"]*)"\s*\)/);
    if (!exported || !block) continue;
    const literals = [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unescapeLiteral(m[1]));
    out[exported[1]] = {
      appendPrefix: literals,
      joiner: block[2] === "\n" ? "\n" : block[2],
      itemTemplate: (block[1].match(/`([^`]*\$\{[^}]*\}[^`]*)`/) || [])[1] || null,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractToolOverrides(files = {}) {
  for (const key of Object.keys(files)) {
    if (!key.startsWith("tool:")) continue;
    const source = files[key];
    if (typeof source !== "string") continue;
    const usesPatch = source.match(
      /const\s+usePatch\s*=\s*([^\n]+)\n([\s\S]{0,400}?)(?=\n\s*\}\s*\n)/
    );
    if (!usesPatch) continue;
    const condition = usesPatch[1].trim();
    const body = usesPatch[2];
    const removedForPatch = [...body.matchAll(/delete\s+event\.tools\.([a-z_]+)/g)].map((m) => m[1]);
    // The `else` branch removes the other side; read the second delete block.
    const allRemoved = [...source.matchAll(/delete\s+event\.tools\.([a-z_]+)/g)].map((m) => m[1]);
    const addedForPatch = allRemoved.filter((n) => !removedForPatch.includes(n));
    if (removedForPatch.length === 0) continue;
    return {
      // The condition is kept verbatim and evaluated by the bridge against the
      // model id, so a change of the rule upstream travels with the release.
      condition,
      whenTrueRemove: removedForPatch,
      whenTrueAdd: addedForPatch,
      whenFalseRemove: addedForPatch,
      whenFalseAdd: removedForPatch,
    };
  }
  return null;
}

/**
 * Extract session ID, User-Agent template, headers, and tool schemas from
 * upstream source files.
 */
function extractRecipe(files = {}) {
  const out = {};

  const identifier = files.identifier;
  if (typeof identifier === "string") {
    const charset = identifier.match(/const\s+chars\s*=\s*"([^"]+)"/);
    if (charset && charset[1].length >= 2) out.sessionCharset = charset[1];

    const length = identifier.match(/const\s+length\s*=\s*(\d+)/);
    if (length) {
      const n = parseInt(length[1], 10);
      if (n >= 16 && n <= 64) out.sessionLength = n;
    }

    const multiplier = identifier.match(
      /BigInt\(timestamp\)\s*\*\s*0x([0-9a-fA-F]+)n/
    );
    if (multiplier) {
      const n = parseInt(multiplier[1], 16);
      if (Number.isSafeInteger(n) && n > 0) out.sessionMultiplier = n;
    }
  }

  const sessionId = files.sessionId;
  if (typeof sessionId === "string") {
    const prefix = sessionId.match(/make\(\s*"([a-z]+_)"\s*\+\s*descending/);
    if (prefix) out.sessionPrefix = prefix[1];
  }

  const app = files.app;
  if (typeof app === "string") {
    const tpl = app.match(/return\s+`(opencode\/[^`]+)`/);
    if (tpl) out.userAgentTemplate = tpl[1];
  }

  const modelRequest = files.modelRequest;
  if (typeof modelRequest === "string") {
    const block = modelRequest.match(/headers:\s*\{([\s\S]{0,2000}?)\n\s{8}\}/);
    if (block) {
      // Split by line so a conditional spread can be told apart from a header
      // that is always sent. Upstream writes parent-session headers as
      // `...(session.parentID ? { "x-parent": ... } : {})`, which this bridge
      // has no value for — reporting those as missing would be a false alarm.
      const required = [];
      const optional = [];
      const seen = new Set();
      for (const line of block[1].split("\n")) {
        const nameMatch = line.match(/"([A-Za-z][A-Za-z0-9-]*)":/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        const key = name.toLowerCase();
        if (key.length === 0 || key.length >= 64 || seen.has(key)) continue;
        seen.add(key);
        // A spread guarded by a ternary is conditional.
        if (line.trim().startsWith("...") && line.includes("?")) optional.push(name);
        else required.push(name);
      }
      if (required.length > 0) out.headers = required;
      if (optional.length > 0) out.optionalHeaders = optional;
    }
  }

  const extractedTools = {};
  // Build the cross-file corpus once per extraction so `PageInput`-style
  // references resolve regardless of which file declares them.
  const corpusParts = Object.entries(files)
    .filter(([k]) => k.startsWith("tool:") || k.startsWith("ref:"))
    .map(([, v]) => (typeof v === "string" ? v : ""))
    .filter(Boolean);
  schemaCorpus = corpusParts.length > 0 ? corpusParts.join("\n\n") : null;
  schemaVars = null;
  schemaModules = new Map();
  for (const [k, v] of Object.entries(files)) {
    if ((k.startsWith("ref:") || k.startsWith("tool:")) && typeof v === "string") {
      const stripped = k.replace(/^(ref:|tool:)/, "");
      const base = stripped.split("-").pop();
      // Namespace lookups use the capitalised module name (`Question`), while
      // the file basename is lowercase (`question`).
      schemaModules.set(base, v);
      schemaModules.set(base.charAt(0).toUpperCase() + base.slice(1), v);
      schemaModules.set(stripped, v);
    }
  }

  // Harvest constants from the whole corpus once, so a field description that
  // interpolates an imported constant can be resolved.
  {
    const parts = Object.entries(files)
      .filter(([k]) => k.startsWith("tool:") || k.startsWith("ref:"))
      .map(([, v]) => (typeof v === "string" ? v : ""));
    const all = parts.join("\n");
    const vars = { OS: "Linux", shell: "bash" };
    for (const m of all.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*([0-9][0-9_*\s+]*)/g)) {
      const clean = m[2].replace(/_/g, "").trim();
      if (/^[0-9*\s+]+$/.test(clean)) {
        const val = clean
          .split("+")
          .map((part) => part.split("*").reduce((acc, n) => acc * Number(n.trim()), 1))
          .reduce((a, b) => a + b, 0);
        if (Number.isFinite(val)) vars[m[1]] = val;
      }
    }
    schemaVars = vars;
  }

  const toolKeys = Object.keys(files).filter((k) => k.startsWith("tool:"));
  // Code mode's `execute` is registered in its own file with an inline object,
  // so the plugin parser would miss it. Read it here.
  if (typeof files.codemode === "string") {
    const cm = files.codemode.match(/name:\s*"(execute)"[\s\S]{0,200}?input:\s*([A-Za-z0-9_.]+)/);
    if (cm) {
      const cmDesc = files.codemode.match(/const\s+description\s*=\s*\[([\s\S]*?)\]\.join\(\s*"([^"]*)"\s*\)/);
      let description = "Call tools through `tools` using exact paths and signatures from the catalog.";
      if (cmDesc) {
        const parts = [];
        for (const m of cmDesc[1].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
          parts.push(unescapeLiteral(m[1] !== undefined ? m[1] : m[2]));
        }
        // `cmDesc[2]` is the join argument's contents, already without the
        // surrounding quotes (`[^"]*`), so it is unescaped as-is.
        const joiner = unescapeLiteral(cmDesc[2]);
        if (parts.length > 0) description = parts.join(joiner);
      }
      // `{ code: string }` with no field description: the guidance lives in the
      // tool description, and the CLI does not annotate the field.
      extractedTools.execute = {
        description,
        parameters: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
          additionalProperties: false,
        },
      };
    }
  }
  for (const key of toolKeys) {
    // No filename fallback: a file that registers its tools by literal (or that
    // exposes none at all) must not be recorded under its own filename. That is
    // how `mcp-resource` used to end up in the profile as a tool name.
    const def = extractToolFromSource(files[key], null);
    if (def) {
      extractedTools[def.name] = {
        description: def.description,
        parameters: def.parameters,
      };
    }
  }
  if (Object.keys(extractedTools).length > 0) {
    out.tools = extractedTools;
  }
  const toolNames = extractToolNames(files);
  // `execute` is the code-mode dispatcher itself: always on the wire when code
  // mode is enabled, even though it carries no `codemode: false` flag.
  if (Object.keys(extractedTools).includes("execute") && !toolNames.includes("execute")) {
    toolNames.push("execute");
  }
  if (toolNames.length > 0) {
    out.toolNames = toolNames;
  }
  const overrides = extractToolOverrides(files);
  if (overrides) {
    out.toolOverrides = overrides;
  }
  const dynamicDescriptions = extractDynamicDescriptions(files);
  if (dynamicDescriptions) {
    out.dynamicDescriptions = dynamicDescriptions;
  }

  return out;
}

function buildUserAgent(next = recipe) {
  const tpl = next.userAgentTemplate;
  if (typeof tpl === "string") {
    return tpl
      .replace("${app.channel}", next.channel)
      .replace("${app.version}", next.version)
      .replace("${app.name}", next.client);
  }
  return `opencode/${next.channel}/${next.version}/${next.client}`;
}

function getUserAgent() {
  return buildUserAgent(recipe);
}

function applyRecipe(update = {}, tag = null) {
  const next = { ...recipe };
  const changed = [];

  const version = clampString(update.version, 32);
  if (version && /^\d+\.\d+\.\d+$/.test(version) && version !== next.version) {
    next.version = version;
    changed.push("version");
  }

  const charset = clampString(update.sessionCharset, 128);
  if (charset && charset.length >= 2 && charset !== next.sessionCharset) {
    next.sessionCharset = charset;
    changed.push("sessionCharset");
  }

  if (
    Number.isInteger(update.sessionLength) &&
    update.sessionLength >= 16 &&
    update.sessionLength <= 64 &&
    update.sessionLength !== next.sessionLength
  ) {
    next.sessionLength = update.sessionLength;
    changed.push("sessionLength");
  }

  if (
    Number.isInteger(update.sessionMultiplier) &&
    update.sessionMultiplier > 0 &&
    update.sessionMultiplier !== next.sessionMultiplier
  ) {
    next.sessionMultiplier = update.sessionMultiplier;
    changed.push("sessionMultiplier");
  }

  const prefix = clampString(update.sessionPrefix, 16);
  if (prefix && prefix !== next.sessionPrefix) {
    next.sessionPrefix = prefix;
    changed.push("sessionPrefix");
  }

  for (const k of ["chatUrl", "responsesUrl", "modelsUrl", "catalogBase"]) {
    const v = clampString(update[k], 256);
    if (v && /^https?:\/\/[a-z0-9.:-]+/i.test(v) && v !== next[k]) {
      next[k] = v;
      changed.push(k);
    }
  }

  if (typeof update.userAgentTemplate === "string") {
    const probe = buildUserAgent({ ...next, userAgentTemplate: update.userAgentTemplate });
    if (/^opencode\/[A-Za-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9-]+$/.test(probe)) {
      if (probe !== buildUserAgent(recipe)) changed.push("userAgentTemplate");
      next.userAgentTemplate = update.userAgentTemplate;
    }
  }

  if (Array.isArray(update.headers) && update.headers.length > 0) {
    const incoming = update.headers.map(String);
    const same =
      incoming.length === next.headers.length &&
      incoming.every((h, i) => h.toLowerCase() === next.headers[i].toLowerCase());
    if (!same) {
      next.headers = incoming;
      changed.push("headers");
    }
  }

  if (Array.isArray(update.optionalHeaders)) {
    optionalHeaders = update.optionalHeaders.map(String);
  }

  if (Array.isArray(update.freeModels) && update.freeModels.length > 0) {
    const incoming = update.freeModels.map(String).filter((n) => /^[A-Za-z0-9._:-]+$/.test(n));
    if (incoming.length > 0 && stableStringify(incoming) !== stableStringify(freeModels)) {
      freeModels = incoming;
      changed.push("freeModels");
    }
  }

  if (update.dynamicDescriptions && typeof update.dynamicDescriptions === "object") {
    if (stableStringify(update.dynamicDescriptions) !== stableStringify(dynamicDescriptions)) {
      dynamicDescriptions = update.dynamicDescriptions;
      changed.push("dynamicDescriptions");
    }
  }

  if (update.toolOverrides && typeof update.toolOverrides === "object") {
    if (stableStringify(update.toolOverrides) !== stableStringify(toolOverrides)) {
      toolOverrides = update.toolOverrides;
      changed.push("toolOverrides");
    }
  }

  if (update.modelFacts && typeof update.modelFacts === "object") {
    const next = {};
    for (const [id, f] of Object.entries(update.modelFacts)) {
      if (typeof f?.reasoning !== "boolean") continue;
      next[String(id).toLowerCase()] = {
        reasoning: f.reasoning,
        maxOutput: Number(f.maxOutput) > 0 ? Number(f.maxOutput) : null,
      };
    }
    if (Object.keys(next).length > 0 && stableStringify(next) !== stableStringify(modelFacts)) {
      modelFacts = next;
      changed.push("modelFacts");
    }
  }

  if (update.modelFamilies && typeof update.modelFamilies === "object") {
    const next = {};
    for (const [family, id] of Object.entries(update.modelFamilies)) {
      if (typeof id === "string" && /^[A-Za-z0-9._:-]+$/.test(id)) {
        next[String(family).toLowerCase()] = id;
      }
    }
    if (Object.keys(next).length > 0 && stableStringify(next) !== stableStringify(modelFamilies)) {
      modelFamilies = next;
      changed.push("modelFamilies");
    }
  }

  if (update.catalogVerdicts && typeof update.catalogVerdicts === "object") {
    const next = {};
    for (const [id, v] of Object.entries(update.catalogVerdicts)) {
      if (v === "free" || v === "paid" || v === "deprecated") next[String(id).toLowerCase()] = v;
    }
    if (Object.keys(next).length > 0 && stableStringify(next) !== stableStringify(catalogVerdicts)) {
      catalogVerdicts = next;
      changed.push("catalogVerdicts");
    }
  }

  if (update.modelEndpoints && typeof update.modelEndpoints === "object") {
    const nextMap = {};
    for (const [id, base] of Object.entries(update.modelEndpoints)) {
      if (typeof base === "string" && /^https:\/\/[a-z0-9.-]+/i.test(base)) {
        nextMap[String(id).toLowerCase()] = base;
      }
    }
    if (Object.keys(nextMap).length > 0) {
      if (stableStringify(nextMap) !== stableStringify(modelEndpoints)) {
        modelEndpoints = nextMap;
        changed.push("modelEndpoints");
      }
    }
  }

  if (Array.isArray(update.toolNames) && update.toolNames.length > 0) {
    const incoming = update.toolNames.map(String).filter((n) => /^[a-z][a-z0-9_-]*$/i.test(n));
    if (incoming.length > 0) {
      const same =
        incoming.length === toolNames.length &&
        incoming.every((n, i) => n === toolNames[i]);
      if (!same) {
        toolNames = incoming;
        changed.push("toolNames");
      }
    }
  }

  if (update.tools && typeof update.tools === "object") {
    // The extracted set *replaces* the previous one rather than merging into
    // it. Merging would keep a tool upstream has renamed or removed forever,
    // so the wire shape could never converge on what the release actually
    // ships — the opposite of adapting.
    const nextTools = { ...update.tools };
    if (Object.keys(nextTools).length > 0) {
      if (stableStringify(nextTools) !== stableStringify(getTools())) {
        changed.push("tools");
      }
      toolProfile = nextTools;
      toolProfileSource = "source";
      toolProfileVersion = next.version;
    }
  }

  if (changed.length > 0) {
    recipe = next;
    stateEpoch++;
    lastForcedRefreshTime = 0;
  }
  if (tag) lastSourceTag = tag;
  return changed;
}

// --- Refresh & Reactive Self-Heal --------------------------------------------

/**
 * @param {object}  [opts]
 * @param {boolean} [opts.force]    Adopt whatever the handshake reports, even in
 *                                  reactive mode and even when the version has
 *                                  not moved (the gate can move without a bump).
 *                                  Used by the gate-rejection self-heal.
 * @param {boolean} [opts.recheck]  Skip the freshness guard and consult the
 *                                  handshake now, but still respect UPDATE_MODE
 *                                  when deciding whether to adopt. Used by the
 *                                  periodic CLI-version poll.
 */
async function refresh({ force = false, recheck = false } = {}) {
  if (process.env.OPENCODE_USER_AGENT) {
    return { updated: false, reason: "pinned" };
  }
  if (!force && !recheck && Date.now() - lastCheckTime < IDENTITY_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  if (refreshInFlight) {
    if (!force) return refreshInFlight;
    refreshInFlightForced = true;
    const pending = await refreshInFlight;
    if (pending && (pending.updated || pending.sourceRead)) return pending;
  }

  refreshInFlightForced = Boolean(force);
  const myGen = ++refreshGen;
  refreshInFlight = (async () => {
    try {
      const release = await resolveRelease(recipe.version);
      const latest = release.version;
      if (!latest) throw new Error(release.error || "handshake resolved no version");

      if (myGen !== refreshGen) return { updated: false, reason: "reset" };
      lastCheckTime = Date.now();
      lastRefreshError = release.stale ? release.error || "handshake stale" : null;

      const cmp = compareVersions(latest, recipe.version);
      if (cmp < 0) {
        return {
          updated: false,
          version: recipe.version,
          reason: `newer-local:${recipe.version}`,
        };
      }

      const updateMode = getUpdateMode();
      const forcedByUpstream = release.minimum === true;
      const isForced = force || refreshInFlightForced;
      const shouldAdopt = cmp > 0 && (isForced || updateMode === "always" || forcedByUpstream);

      if (cmp === 0 && !isForced) {
        // Even when the CLI version has not moved, populate the catalog once if
        // this process still has no free-model list (cold boot without cache).
        if (freeModels.length === 0) {
          const catalog = await extractCatalog();
          applyRecipe(catalog);
        }
        return {
          updated: false,
          version: recipe.version,
          reason: "up-to-date",
        };
      }
      if (cmp > 0 && !shouldAdopt) {
        // Reactive mode: remember that a release exists without adopting it.
        // The next gate rejection forces a refresh, which flips shouldAdopt.
        if (freeModels.length === 0) {
          const catalog = await extractCatalog();
          applyRecipe(catalog);
        }
        lastAvailable = latest;
        return {
          updated: false,
          version: recipe.version,
          available: latest,
          reason: `available-not-adopted:${updateMode}`,
        };
      }
      lastAvailable = null;

      const ref = sourceRef(release);
      const update = { version: latest };
      let sourceRead = false;

      const diskCachedSource =
        (global.fetch === BOOT_FETCH || process.env.OPENCODE_CACHE_DIR)
          ? readCachedSource(ref)
          : null;
      if (
        lastSyncedSource &&
        lastSyncedSource.ref === ref &&
        lastSyncedSource.fetchRef === global.fetch
      ) {
        Object.assign(update, lastSyncedSource.extracted);
        sourceRead = true;
      } else if (diskCachedSource && diskCachedSource.extracted) {
        Object.assign(update, diskCachedSource.extracted);
        lastSyncedSource = { ref, extracted: diskCachedSource.extracted, fetchRef: global.fetch };
        sourceRead = true;
      } else {
        // Discover the release's tool plugins, falling back to the ones already
        // known when the directory listing is unavailable (API outage / rate
        // limit). The known set is kept in `knownPlugins`, so a transient failure
        // narrows coverage for one refresh instead of erasing it.
        const discovered = await listSourceDir(PLUGIN_DIR, ref);
        if (discovered.length > 0) knownPlugins = discovered;
        const pluginFiles = { codemode: CODEMODE_TOOL_FILE };
        for (const name of knownPlugins) {
          pluginFiles[`tool:${name}`] = `${PLUGIN_DIR}/${name}.ts`;
        }

        const settled = await Promise.allSettled(
          Object.entries({ ...SOURCE_FILES, ...pluginFiles }).map(async ([key, filePath]) => [
            key,
            await fetchText(`${SOURCE_BASE}/${ref}/${filePath}`, SOURCE_TIMEOUT_MS),
          ])
        );
        const fetchedFiles = {};
        for (const item of settled) {
          if (item.status === "fulfilled") {
            fetchedFiles[item.value[0]] = item.value[1];
            sourceRead = true;
          }
        }
        // Cross-file schema references. `read.ts` writes
        // `ReadToolFileSystem.PageInput.fields.offset`, and `PageInput` lives in
        // `../read-filesystem.ts`. Fetch the local modules each plugin imports so
        // the field's real optionality/type can be resolved instead of guessed.
        const refFiles = new Map();
        for (const [key, source] of Object.entries(fetchedFiles)) {
          if (!key.startsWith("tool:") || typeof source !== "string") continue;
          // Relative imports: `../read-filesystem.js` → packages/core/src/read-filesystem.ts
          for (const m of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"(\.\.?\/[^"]+)\.js"/g)) {
            const rel = m[2].replace(/^\.\.?\//, "");
            const resolved = new URL(m[2] + ".ts", `https://x/${PLUGIN_DIR}/`).pathname.replace(/^\//, "");
            refFiles.set(`ref:${rel.replace(/\//g, "-")}`, resolved);
          }
          // Workspace imports: `@opencode/schema/question` → packages/schema/src/question.ts.
          // This is how a plugin refers to a struct it does not declare itself
          // (`Question.Prompt`).
          for (const m of source.matchAll(/from\s+"@opencode\/([a-z-]+)\/([a-z0-9-]+)"/g)) {
            const pkg = m[1];
            const mod = m[2];
            refFiles.set(`ref:${pkg}-${mod}`, `packages/${pkg}/src/${mod}.ts`);
          }
        }
        if (refFiles.size > 0) {
          const refSettled = await Promise.allSettled(
            [...refFiles.entries()].map(async ([key, filePath]) => [
              key,
              await fetchText(`${SOURCE_BASE}/${ref}/${filePath}`, SOURCE_TIMEOUT_MS),
            ])
          );
          for (const item of refSettled) {
            if (item.status === "fulfilled") fetchedFiles[item.value[0]] = item.value[1];
          }
        }

        // Some tools keep their description in a sibling `.txt` (patch.ts). Fetch
        // those too: the description is part of the wire schema, and a tool whose
        // schema cannot be built is dropped from the profile.
        const txtRefs = [];
        for (const [key, source] of Object.entries(fetchedFiles)) {
          if (!key.startsWith("tool:")) continue;
          const probe = extractToolFromSource(source, key.replace(/^tool:/, ""));
          if (probe && probe.descriptionFile) {
            txtRefs.push({ key, file: probe.descriptionFile, varName: probe.descriptionVar });
          }
        }
        if (txtRefs.length > 0) {
          const txtSettled = await Promise.allSettled(
            txtRefs.map(async (t) => {
              const dir = PLUGIN_DIR;
              // `../patch.txt` is relative to the plugin directory.
              const resolved = new URL(t.file, `https://x/${dir}/`).pathname.replace(/^\//, "");
              return [t, await fetchText(`${SOURCE_BASE}/${ref}/${resolved}`, SOURCE_TIMEOUT_MS)];
            })
          );
          for (const item of txtSettled) {
            if (item.status !== "fulfilled") continue;
            const [t, text] = item.value;
            const src = fetchedFiles[t.key];
            if (typeof src !== "string") continue;
            // Replace the identifier with a string literal so the existing
            // description parser can read it.
            fetchedFiles[t.key] = src.replace(
              new RegExp(`\\b${t.varName}\\b(?!\\s+from)`),
              JSON.stringify(text.trim())
            );
          }
        }

        if (sourceRead) {
          const extracted = extractRecipe(fetchedFiles);
          Object.assign(update, extracted);
          const allCoreFetched = Object.keys(SOURCE_FILES).every(
            (k) => typeof fetchedFiles[k] === "string" && fetchedFiles[k].length > 0
          );
          const allSettledOk = settled.every((item) => item.status === "fulfilled");
          if (allCoreFetched && allSettledOk) {
            lastSyncedSource = { ref, extracted, fetchRef: global.fetch };
            if (extracted.tools && Object.keys(extracted.tools).length > 0) {
              writeCachedSource(ref, extracted);
            }
          }
        } else {
          const fallbackSource = readCachedSource(ref) || readCachedSource();
          if (fallbackSource && fallbackSource.extracted) {
            Object.assign(update, fallbackSource.extracted);
          }
        }
      }

      // Endpoints live in the provider catalog, not in the git source tree.
      // Missing catalog or missing `opencode` entry leaves the endpoints at
      // their current values — a catalog outage must not blank the wire URLs.
      const catalog = await extractCatalog();
      Object.assign(update, catalog);

      if (myGen !== refreshGen) return { updated: false, reason: "reset" };
      const changed = applyRecipe(update, ref);
      if (isForced && sourceRead && !release.stale) {
        lastForcedRefreshTime = Date.now();
      }
      return {
        updated: changed.length > 0,
        changed,
        version: recipe.version,
        tag: ref,
        sourceRead,
        release: {
          version: release.version,
          sha: release.sha,
          source: release.source,
          minimum: release.minimum,
        },
      };
    } catch (err) {
      if (myGen === refreshGen) {
        lastRefreshError = err.message || String(err);
      }
      return { updated: false, error: err.message || String(err) };
    } finally {
      if (myGen === refreshGen) {
        refreshInFlight = null;
        refreshInFlightForced = false;
      }
    }
  })();

  return refreshInFlight;
}

/**
 * Non-blocking freshness check on the request path.
 * - In `always` mode: kicks off a background handshake check after TTL expiry.
 * - In `reactive` mode: stays silent after initial check until a gate error occurs.
 */
function ensureFresh() {
  if (Date.now() - lastCheckTime < IDENTITY_TTL_MS) {
    return { updated: false, reason: "fresh" };
  }
  if (getUpdateMode() === "reactive" && lastCheckTime > 0) {
    return { updated: false, reason: "reactive-idle" };
  }
  refresh().catch(() => {});
  return { updated: false, reason: "refreshing-in-background" };
}

/**
 * Reactive self-heal when upstream rejects our request with a CLI gate error
 * (403 FreeTierError or 426 UpgradeRequired).
 */
async function onGateRejection(status, errType, errMsg, attempted = false) {
  if (attempted) return { retry: false, reason: "already-retried" };

  const versionBefore = recipe.version;
  const toolsBefore = stableStringify(getTools());

  const floor = parseVersionFloor(errMsg);
  if (floor) {
    versionFloor = floor;
    if (compareVersions(recipe.version, floor) < 0) {
      applyRecipe({ version: floor }, lastSourceTag);
    }
  }

  // Avoid hammering GitHub's API (60 req/hr unauthenticated) and the catalog on
  // every request during a per-IP 403 cooldown burst: if a forced refresh
  // already succeeded within GATE_REFRESH_COOLDOWN_MS and no version floor was
  // reported, reuse the current state.
  if (
    !floor &&
    lastForcedRefreshTime > 0 &&
    Date.now() - lastForcedRefreshTime < GATE_REFRESH_COOLDOWN_MS
  ) {
    return {
      retry: false,
      reason: "no-change",
      cooldown: true,
      status,
      errType,
    };
  }

  const result = await refresh({ force: true });
  const toolsAfter = stableStringify(getTools());

  const learned =
    recipe.version !== versionBefore ||
    toolsAfter !== toolsBefore ||
    (result && Array.isArray(result.changed) && result.changed.length > 0);

  return {
    retry: learned,
    reason: floor
      ? `version-floor:${floor}`
      : learned
        ? `updated:${result?.version || recipe.version}`
        : "no-change",
    status,
    errType,
  };
}

// --- Fast Session ID Generator (Pooled CSPRNG) -------------------------------

let lastTimestamp = 0;
let counter = 0;
const MAX_COUNTER_PER_MS = 16;
const RAND_POOL_SIZE = 14 * 256;
const randPool = Buffer.allocUnsafe(RAND_POOL_SIZE);
let randPoolOffset = RAND_POOL_SIZE;

function nextRandomChars(chars, count) {
  if (randPoolOffset + count > RAND_POOL_SIZE) {
    crypto.randomFillSync(randPool);
    randPoolOffset = 0;
  }
  const len = chars.length;
  let out = "";
  for (let i = 0; i < count; i++) {
    out += chars[randPool[randPoolOffset + i] % len];
  }
  randPoolOffset += count;
  return out;
}

function createId(descending = true, timestamp = Date.now()) {
  const {
    sessionCharset: chars,
    sessionLength: length,
    sessionMultiplier: mult,
  } = recipe;

  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const extraMs = Math.floor((counter - 1) / MAX_COUNTER_PER_MS);
  const effectiveCounter = ((counter - 1) % MAX_COUNTER_PER_MS) + 1;

  const current = BigInt(timestamp + extraMs) * BigInt(mult) + BigInt(effectiveCounter);
  const value = descending ? ~current : current;
  const mask = (1n << 48n) - 1n;

  const hexChars = 12;
  const hex = (value & mask).toString(16).padStart(hexChars, "0");
  const randomChars = Math.max(0, length - hexChars);
  return hex + nextRandomChars(chars, randomChars);
}

// --- Accessors & Tool Formatting ---------------------------------------------

/**
 * The gate's tool-name allowlist, in upstream's own order. Falls back to the
 * tool profile's key order when the source read has not produced a list yet.
 */
function getToolNames() {
  if (toolNames.length > 0) return toolNames.slice();
  return Object.keys(getTools());
}

/**
 * Current wire endpoints. `chatUrl` / `responsesUrl` are resolved from the
 * upstream provider catalog at refresh time; `server.js` reads these per
 * request, so an endpoint migration applies without a restart.
 */
/**
 * Free-tier model ids derived from the provider catalog. Empty means the
 * catalog has not been read yet — callers keep their own list in that case
 * rather than treating "unknown" as "none are free".
 */
function getFreeModels() {
  return freeModels.slice();
}

/** Catalog-derived shorthand: a family name (or a prefix of a free model id)
 *  mapped to a live free model. Returns undefined when nothing matches. */
function resolveModelAlias(name) {
  const key = String(name || "").toLowerCase().trim();
  if (!key) return undefined;
  if (modelFamilies[key]) return modelFamilies[key];
  // Prefix form: "nemotron" for family "nemotron-free", "nemotron-3" for the
  // model id `nemotron-3-ultra-free`. Longest match wins so a short prefix does
  // not shadow a more specific one.
  let best;
  for (const [family, id] of Object.entries(modelFamilies)) {
    const matches =
      key === family ||
      key === family.replace(/-free$/, "") ||
      family.startsWith(`${key}-`) ||
      id.toLowerCase().startsWith(`${key}-`) ||
      id.toLowerCase().startsWith(key);
    if (!matches) continue;
    if (!best || family.length > best.family.length) best = { family, id };
  }
  if (best) return best.id;
  // Revision-prefix form ("nemotron-3.5" for `nemotron-3.5-lightning-free`):
  // the family map keeps one representative, so fall back to the free list and
  // take the most specific (longest) prefix match, ties broken lexicographically
  // so the choice is stable across runs.
  const candidates = freeModels
    .filter((id) => id.toLowerCase().startsWith(`${key}-`) || id.toLowerCase().startsWith(key))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return candidates[0];
}

/**
 * Apply the release's model-conditional tool rule to a name list.
 *
 * The rule is stored as its upstream condition plus the names it removes and
 * restores on each branch. The condition is evaluated here against the model id
 * (only the `event.model.id.includes(...)` form upstream uses is supported; an
 * unrecognised condition leaves the list untouched rather than guessing).
 */
function applyToolOverrides(names, modelId) {
  const rule = toolOverrides;
  if (!rule || !Array.isArray(names)) return names.slice();
  const id = String(modelId || "");
  const cond = String(rule.condition || "");
  const tests = [...cond.matchAll(/(!?)\s*event\.model\.id\.includes\(\s*"([^"]+)"\s*\)/g)];
  if (tests.length === 0) return names.slice();
  let matches = true;
  for (const [, negated, needle] of tests) {
    const hit = id.includes(needle);
    if (negated && hit) matches = false;
    if (!negated && !hit) matches = false;
  }
  const remove = matches ? rule.whenTrueRemove || [] : rule.whenFalseRemove || [];
  const add = matches ? rule.whenTrueAdd || [] : rule.whenFalseAdd || [];
  const out = names.filter((n) => !remove.includes(n));
  for (const n of add) if (!out.includes(n)) out.push(n);
  return out;
}

/** Catalog facts for one model id: `{ reasoning, maxOutput }`, or undefined
 *  when the catalog does not describe it. */
function getModelFacts(modelId) {
  return modelFacts[String(modelId || "").toLowerCase()];
}

/** The catalog's verdict for one model id: "free", "paid", "deprecated", or
 *  undefined when the catalog does not describe it. */
function getCatalogVerdict(modelId) {
  return catalogVerdicts[String(modelId || "").toLowerCase()];
}

function getEndpoints(modelId = null) {
  const base = {
    chatUrl: recipe.chatUrl,
    responsesUrl: recipe.responsesUrl,
    modelsUrl: recipe.modelsUrl,
    catalogBase: recipe.catalogBase,
  };
  // A model can pin its own base in the catalog (anthropic-protocol models).
  // The wire path is derived the same way: <base>/chat/completions.
  if (modelId) {
    const override = modelEndpoints[String(modelId).toLowerCase()];
    if (override) {
      base.catalogBase = override;
      base.chatUrl = `${override}/chat/completions`;
      base.responsesUrl = `${override}/responses`;
    }
  }
  return base;
}

function getRecipe() {
  return { ...recipe };
}

function getTools() {
  // An empty profile is not a profile. Without this guard `toolProfile || ...`
  // lets `{}` win (objects are truthy) and the bridge sends `tools: []`, which
  // upstream rejects with 403 — the exact failure the fingerprint exists to
  // avoid. An empty or malformed profile falls back to the shipped set.
  if (toolProfile && Object.keys(toolProfile).length > 0) return toolProfile;
  return DEFAULT_TOOLS;
}

/**
 * The upstream header names currently in force, in upstream's own order.
 * `server.js` builds its header object from this, so a header added upstream
 * starts being sent on the next request after a refresh.
 */
function getHeaderNames() {
  return Array.isArray(recipe.headers) ? recipe.headers.slice() : DEFAULT_RECIPE.headers.slice();
}

/**
 * Append the part of a tool's description that upstream builds at request time.
 *
 * The static prefix and the heading come from the release source; the entries
 * under it are the caller's available agents, which this bridge does not have.
 * Emitting the heading with no entries is the truthful rendering of "none
 * available" and keeps the static text byte-identical to the CLI's.
 */
function withDynamicDescription(name, description) {
  const spec = dynamicDescriptions && dynamicDescriptions[name];
  if (!spec || !Array.isArray(spec.appendPrefix) || spec.appendPrefix.length === 0) return description;
  const joiner = spec.joiner || "\n";
  // The extracted literals are [separator, heading, fallbackText]. Only the
  // heading belongs in the static description: `fallbackText` is what upstream
  // prints for an agent that has no description, not a heading of its own.
  const heading = spec.appendPrefix.filter((p) => p !== "").slice(0, 1);
  if (heading.length === 0) return description;
  return [description, "", ...heading].join(joiner);
}

function getToolList(flat = false, scope = null, modelId = null) {
  const profile = getTools();
  const available = Object.keys(profile);
  const mode = scope || process.env.TOOL_PROFILE_SCOPE || "core";

  // `core` sends the minimum proven set. `full` sends every name derived from
  // the release's tool plugin sources — the shape the real CLI uses. The
  // reactive self-heal retries with `full` so a renamed/added upstream tool is
  // picked up without a bridge release.
  let ordered;
  if (mode === "full") {
    ordered = applyToolOverrides(getToolNames(), modelId).filter((n) => profile[n]);
    if (ordered.length === 0) ordered = available;
  } else {
    const coreNames = CORE_TOOL_NAMES.filter((n) => profile[n]);
    ordered = coreNames.length > 0 ? coreNames : available;
  }

  // Pin the gate anchors last, so the derived order is otherwise untouched.
  // `profile[name]` may be missing when upstream renamed or dropped the tool:
  // the shipped definition is then the only thing that keeps the wire shape
  // acceptable. See GATE_ANCHOR_TOOL_NAMES for the measurements.
  for (const name of GATE_ANCHOR_TOOL_NAMES) {
    if (!ordered.includes(name)) ordered = [...ordered, name];
  }

  return ordered.map((name) => {
    const def = profile[name] || DEFAULT_TOOLS[name];
    const description = withDynamicDescription(name, def.description);
    return flat
      ? {
          type: "function",
          name,
          description,
          parameters: def.parameters,
          strict: false,
        }
      : {
          type: "function",
          function: {
            name,
            description,
            parameters: def.parameters,
            // The CLI includes `strict: false` on every tool it sends. It is a
            // no-op today, but it is part of the shape the wire carries.
            strict: false,
          },
        };
  });
}

/**
 * Resolve the header names upstream's client sends to concrete values.
 *
 * Returns `{ headers, unsent }`. `unsent` lists names we know upstream sends
 * but whose value this bridge cannot derive — reported in `/health` instead of
 * being sent empty, because an empty required header is worse than a missing
 * one.
 */
const GATE_HEADER_VALUES = [
  "user-agent",
  "x-opencode-client",
  "x-opencode-project",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-session-id",
];

function buildGateHeaders(ctx = {}) {
  const values = {
    "user-agent": ctx.userAgent,
    "x-opencode-client": ctx.client,
    "x-opencode-project": ctx.project,
    "x-opencode-session": ctx.sessionId,
    "x-opencode-session-id": ctx.sessionId,
    "x-session-affinity": ctx.sessionId,
    "x-session-id": ctx.sessionId,
  };
  const headers = {};
  const unsent = [];
  const names = getHeaderNames().slice();
  // Pin the anchors even when the recipe stops listing them: the gate rejects
  // a request without these with the same 403 it uses for a blocked IP, so a
  // recipe regression would be indistinguishable from an exhausted allowance.
  for (const anchor of GATE_ANCHOR_HEADER_NAMES) {
    if (!names.some((n) => String(n).toLowerCase() === anchor)) names.push(anchor);
  }
  for (const name of names) {
    const lower = String(name).toLowerCase();
    const value = values[lower];
    // Header names are case-insensitive. Emit one canonical spelling per name
    // so a change of case upstream cannot produce a duplicate key: `User-Agent`
    // keeps its conventional form, every `x-opencode-*` header stays lowercase.
    if (value === undefined) unsent.push(name);
    else headers[lower === "user-agent" ? "User-Agent" : lower] = value;
  }
  return { headers, unsent };
}

/**
 * Header names the current recipe asks for that this bridge has no value for.
 * Non-empty means upstream added a header whose value is not derivable from
 * the release source — the alert that a manual mapping is needed, since the
 * request will be sent without it.
 */
function getUnsentHeaders() {
  const known = new Set(GATE_HEADER_VALUES);
  const conditional = new Set(optionalHeaders.map((n) => String(n).toLowerCase()));
  return getHeaderNames().filter((n) => {
    const key = String(n).toLowerCase();
    // Conditional headers (parent-session lineage) are only sent by the CLI
    // when the session has a parent. This bridge never creates nested
    // sessions, so their absence is expected, not a gap to report.
    return !known.has(key) && !conditional.has(key);
  });
}

function getSessionPrefix() {
  return recipe.sessionPrefix || DEFAULT_RECIPE.sessionPrefix;
}

/** Session id with upstream's prefix, e.g. `ses_<12 hex><14 base62>`. */
function createSessionId(descending = true, timestamp = Date.now()) {
  return getSessionPrefix() + createId(descending, timestamp);
}

function getState() {
  return {
    recipe: getRecipe(),
    userAgent: getUserAgent(),
    updateMode: getUpdateMode(),
    lastCheckTime,
    lastForcedRefreshTime,
    epoch: stateEpoch,
    ttlMs: IDENTITY_TTL_MS,
    versionFloor,
    lastRefreshError,
    lastSourceTag,
    release: lastRelease,
    available: lastAvailable,
    headers: getHeaderNames(),
    optionalHeaders: optionalHeaders.slice(),
    unsentHeaders: getUnsentHeaders(),
    toolNames: getToolNames(),
    freeModels: freeModels.slice(),
    catalogVerdicts: { ...catalogVerdicts },
    modelFamilies: { ...modelFamilies },
    modelFacts: { ...modelFacts },
    toolOverrides: toolOverrides ? { ...toolOverrides } : null,
    dynamicDescriptions: dynamicDescriptions ? { ...dynamicDescriptions } : null,
    endpoints: getEndpoints(),
    inFlight: Boolean(refreshInFlight),
    tools: {
      source: toolProfileSource,
      version: toolProfileVersion,
      toolNames: Object.keys(getTools()),
    },
  };
}

function __reset() {
  recipe = { ...DEFAULT_RECIPE };
  toolProfile = null;
  toolProfileSource = "default";
  toolProfileVersion = DEFAULT_RECIPE.version;
  toolNames = [];
  modelEndpoints = {};
  freeModels = [];
  catalogVerdicts = {};
  modelFamilies = {};
  modelFacts = {};
  toolOverrides = null;
  dynamicDescriptions = null;
  lastRelease = null;
  lastAvailable = null;
  lastCheckTime = 0;
  lastForcedRefreshTime = 0;
  stateEpoch++;
  refreshInFlight = null;
  refreshInFlightForced = false;
  refreshGen++;
  lastSyncedSource = null;
  versionFloor = null;
  lastRefreshError = null;
  lastSourceTag = null;
  optionalHeaders = [];
  lastTimestamp = 0;
  counter = 0;
}

function __setLastCheckTime(v) {
  lastCheckTime = v;
  lastForcedRefreshTime = 0;
  stateEpoch++;
}

/** Test hook: stage a session prefix without going through recipe validation. */
function __setSessionPrefix(prefix) {
  recipe = { ...recipe, sessionPrefix: String(prefix) };
  lastForcedRefreshTime = 0;
  stateEpoch++;
}

function __setToolProfile(tools, source = "test") {
  toolProfile = tools;
  toolProfileSource = source;
  toolProfileVersion = recipe.version;
  lastForcedRefreshTime = 0;
  stateEpoch++;
}

// Warm-start from the on-disk catalog cache at module load so shorthand aliases,
// model verdicts, and token-budget facts work on the very first request.
{
  const bootCatalog = readCachedCatalog();
  if (bootCatalog) applyRecipe(parseCatalogData(bootCatalog));
  const bootSource = readCachedSource();
  if (bootSource && bootSource.extracted) {
    applyRecipe(bootSource.extracted, bootSource.ref);
    lastSyncedSource = {
      ref: bootSource.ref,
      extracted: bootSource.extracted,
      fetchRef: global.fetch,
    };
  }
}
module.exports = {
  IDENTITY_TTL_MS,
  GATE_REFRESH_COOLDOWN_MS,
   get UPDATE_MODE() {
    return getUpdateMode();
  },
  DEFAULT_RECIPE,
  DEFAULT_TOOLS,
  SOURCE_FILES,
  parseVersions,
  sortVersions,
  selectVersion,
  compareVersions,
  parseVersionFloor,
  sourceRef,
  resolveRelease,
  parseCatalogData,
  extractCatalog,
  readCachedSource,
  writeCachedSource,
  extractToolFromSource,
  extractToolNames,
  extractToolOverrides,
  parseSchemaExpr,
  parseFieldSchema,
  extractRecipe,
  buildUserAgent,
  applyRecipe,
  refresh,
  ensureFresh,
  onGateRejection,
  createId,
  getUserAgent,
  getRecipe,
  getTools,
  getHeaderNames,
  getUnsentHeaders,
  getToolNames,
  getFreeModels,
  getCatalogVerdict,
  getModelFacts,
  applyToolOverrides,
  resolveModelAlias,
  getEndpoints,
  buildGateHeaders,
  GATE_ANCHOR_TOOL_NAMES,
  GATE_ANCHOR_HEADER_NAMES,
  getSessionPrefix,
  createSessionId,
  getToolList,
  getState,
  __reset,
  __setLastCheckTime,
  __setSessionPrefix,
  __setToolProfile,
};
