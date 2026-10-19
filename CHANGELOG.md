# Changelog

## [2.0.1] — 2026-10-18

### Tunnel lifecycle tooling actually reaches installed hosts

`tunnel-doctor.sh` was added in 2.0.0 but no delivery path carried it: it was
absent from `install.sh` (fetch, move, backup, `chmod`), absent from the
self-updater's `UPDATE_FILES`, and absent from the npm `files` list. A fresh
one-liner install and an auto-update both produced a bridge without it, while
`AGENTS.md` and `README.md` told operators to run it.

#### Delivery (`install.sh`, `server.js`, `package.json`)
- **Installer:** fetches `tunnel-doctor.sh`, validates it with `bash -n` before the running bridge is stopped, moves it into `BINDIR`, marks it executable, and includes it in the pre-upgrade backup.
- **Self-updater:** `tunnel-doctor.sh` is in `UPDATE_FILES`. Because `new Function` cannot parse bash, the updater checks the shebang, then runs `bash -n` on the staged temp file, and applies mode `0755`. A host without bash is not treated as a syntax failure.
- **npm `files`:** the script ships in the published tarball.

#### Correctness (`tunnel-doctor.sh`)
- **Default port scan widened to `20120-20149`.** The previous hardcoded `20129-20135` list silently omitted a newly added node's tunnel on `20136` — the exact failure the script exists to catch. Narrow it with `TUNNEL_PORTS="20129 20136"`.
- **No-bash guard in the updater:** the earlier code removed the staged file before `chmod`, so a host without bash would fail the update instead of skipping the parse.

#### Documentation
- `README.md`: test count corrected (121 → 137), the stale-forward symptom and the `00-` prefix ordering rule for sshd keepalive drop-ins documented, and the installer's validation step now mentions `bash -n`.

---

## [2.0.0] — 2026-10-18

### Adaptive OpenCode CLI Synchronization & Bun Transport Parity

`2.0.0` replaces the static `1.x` gate constants and hardcoded model tables with full runtime derivation from the official OpenCode CLI release pipeline, GitHub source tree, and provider catalog, paired with Bun TLS transport parity.

#### 1. Bun Runtime & TLS `ClientHello` Parity (`server.js`, `transport-fingerprint.js`)
- **Bun required for live traffic:** The official OpenCode CLI is compiled with Bun (BoringSSL). Upstream's free-tier gate inspects the TLS `ClientHello` fingerprint (17 cipher suites, 12 TLS extensions in exact order) and refuses Node.js (OpenSSL, 52 ciphers) with `403 FreeTierError`.
- **Startup guard & TLS baseline check:** `node server.js` exits with code `1` and clear instructions unless `ALLOW_NODE=1` is set for offline tests. `transport-fingerprint.js --check` captures the runtime's raw TLS `ClientHello` against a local TCP listener and verifies cipher and extension parity against `transport-baseline.json`.

#### 2. Full Source & Catalog Derivation (`identity.js`, `token-budget.js`)
- **Release handshake (`resolveRelease`):** Queries `https://opencode.ai/update/api/latest/cli/npm` (with GitHub `releases.atom` fallback) to resolve the active CLI version, minimum version floor, and exact release commit SHA.
- **TypeScript AST / source extraction (`extractRecipe`, `extractToolFromSource`):** Fetches and parses upstream's release source files at the resolved commit SHA:
  - `packages/schema/src/identifier.ts` & `session-id.ts`: session ID prefix (`ses_`), length (`26`), base62 charset, and timestamp multiplier (`4096`).
  - `packages/core/src/app.ts`: `User-Agent` template (`opencode/${channel}/${version}/${cli}`).
  - `packages/core/src/session/model-request.ts`: required and optional gate headers (`x-opencode-session-id`, `x-session-affinity`, `X-Session-Id`, `User-Agent`, `x-opencode-project`, `x-opencode-session`, `x-opencode-client`) plus W3C `traceparent` / `b3` trace headers and derived project hash.
  - `packages/core/src/tool/plugin/*.ts`, `codemode/tool.ts`, and `@opencode/schema/*`: dynamically discovers and parses all 13 CLI tool plugins (Effect Schema AST to JSON Schema, cross-file struct references, sibling `.txt` descriptions, and model-conditional `patch` vs `edit`/`write` swaps).
- **Zero hardcoded model tables (`extractCatalog`, `parseCatalogData`):** Removed `MODEL_MAP` and `REASONING_MODEL_HINTS`. Active free models (`cost.input === 0`, non-deprecated), paid/deprecated model verdicts, family shorthand aliases (`mimo`, `longcat`, `beam`, `deepseek-flash`, `glm-flash`, `nemotron-free`), inference endpoints (`chatUrl`, `responsesUrl` validated under `https://*.opencode.ai`), and per-model `reasoning` / `maxOutput` facts are derived from `https://models.opencode.ai/api.json`.
- **On-disk catalog cache:** Persists the fetched catalog to `~/.opencode-free-bridge/cache/catalog.json` (configurable via `OPENCODE_CACHE_DIR`, disabled with `off`) and warm-starts at module load so aliases, verdicts, and token budgets work on the first request and when offline.

#### 3. Multi-Layer Reactive Self-Healing & Cooldown Protection (`server.js`, `identity.js`, `gate-drill.js`)
- **Reactive heal on `403` / `426` / `404`:**
  - On `403 FreeTierError` or `426 UpgradeRequired`, the bridge refreshes its recipe and catalog from upstream, evicts the rejected session ID from `sessionCache`, mints a fresh `ses_...` ID, escalates from `core` to the `full` tool profile, and retries once transparently.
  - On `404` / `410` route migration, re-derives the endpoint URL from the catalog and retries once when the URL moved.
- **IP-cooldown retry & refresh protection (`GATE_RETRY_COOLDOWN_MS`, `GATE_REFRESH_COOLDOWN_MS`):** When a full-shape retry with the freshly synced identity still returns `403 FreeTierError` (indicating a per-IP upstream cooldown rather than a stale request shape), subsequent requests within the 30s cooldown window skip duplicate `403` retries and redundant GitHub/catalog fetches until the identity changes or a request succeeds.
- **Streaming probes & self-healing drill suite (`verify.js`, `gate-drill.js`):**
  - `verify.js` and `gate-drill.js` send `stream: true` on all upstream probes to match the CLI's streaming wire shape, and stop probing remaining models immediately on `gate-closed` (`403 FreeTierError`) so diagnostics never extend an IP cooldown.
  - `gate-drill.js` includes 4 live drills (`version-floor`, `empty-tools`, `session-shape`, `legacy-shape`) gated by a control probe and 6 deterministic offline drills (`routing`, `allowlist`, `retry-endpoint`, `endpoint-move`, `gate-heal`, `full-corrupt`).

#### 4. Universal Installer & Safe Self-Updater (`install.sh`, `server.js`)
- **Staged, zero-dead-end installer (`install.sh`):** Finds or installs Bun (plus `unzip` on minimal Linux), downloads and validates all files in a staging directory (`new Function` syntax check and `JSON.parse`) before stopping a running service, migrates legacy `opencode-bridge.service` / Node units to Bun, configures `systemd` (Linux) or `launchd` (macOS), and verifies `/health` and `transport-fingerprint.js --check`.
- **Bun-compatible self-updater (`checkAndApplyUpdate`):** Validates staged updates in-process without spawning `bun --check`, bypasses GitHub raw CDN caches, and skips overwriting files inside a `.git` checkout.

---

## [1.5.3] — 2026-10-15

### Pruned, Hardened & Deep-Optimized

- **Removed runtime self-updater bloat (`FIND-02`)**: deleted `checkAndApplyUpdate()`,
  `isNewerVersion()`, `fs`/`path`/`child_process`/`vm` imports, and `AUTO_UPDATE`
  from `server.js`. Updating is handled cleanly by `install.sh` or `git pull`.
- **Zero-allocation hot paths**:
  - Pre-computed and froze `CANONICAL_TOOLS_CHAT`, `CANONICAL_TOOLS_RESPONSES`,
    `FINGERPRINT_PARAM_STRINGS`, and `DEFAULT_PLACEHOLDER_NOTE` at module load so
    tool-less or standard requests allocate zero tool objects/maps.
  - Pooled `crypto.randomFillSync` (3.5 KB buffer, 256 IDs per syscall) in
    `createId()`.
  - Pre-serialized `/health` and `/v1/models` JSON payloads on discovery change
    and replaced `new URL()` + regex path parsing with direct string indexing.
  - Added zero-split `consumeSseLines()` scanner and zero-parse SSE passthrough
    fast path when no tool aliases or `reasoning` field normalization are needed.
- **Responses API system/developer instructions & multimodal inputs (`FIND-01`, `FIND-04`)**:
  extracts `system` and `developer` messages from `body.messages` into
  `upstreamBody.instructions` alongside `placeholderNote`, preserves multimodal
  `image_url` / `input_image` / `input_file` parts, and forwards `temperature`,
  `top_p`, `stop`, `response_format`, and `reasoning_effort`.
- **Chunked 413 stream cleanup (`FIND-03`)**: when a streaming request body
  exceeds `MAX_BODY_BYTES`, `readRequestBody` detaches listeners, pauses the
  stream immediately, and destroys the socket without calling `req.resume()`.
- **Localhost-scoped CORS (`FIND-05`)**: restricts `Access-Control-Allow-Origin`
  to `localhost` / `127.0.0.1` / `[::1]` by default (configurable via
  `CORS_ORIGIN`) so arbitrary third-party websites cannot drain local IP quota.
- **Collision-resistant headerless session hashing (`FIND-06`)**: samples both
  head and tail plus total length (`messageSignatureSample`) so conversations
  sharing a long (>1000 char) system prompt prefix do not collide.
- **Reasoning hint & installer quoting (`FIND-04`, `FIND-07`)**: added
  `deepseek` to `REASONING_MODEL_HINTS` in `token-budget.js` and hardened path
  quoting in `install.sh`.

## [1.5.2] — 2026-10-15

### Performance — 4 hot-path optimizations (zero-deps, all covered by `test/optimizations.test.js`)

- **Single-flight discovery**: 50 parallel `/v1/models` hits after TTL expiry
  share one upstream fetch (was: 50 parallel fetches = thundering herd).
- **Discovery no longer waits on the CLI version feed**: feed refreshes in
  parallel fire-and-forget and is cached 6h (was: every hourly discovery
  blocked up to 5s on the Atom feed).
- **Session fast path**: requests carrying a session header skip message
  hashing entirely; headerless fallback slices *before* stringify via new
  `shortText()` so a multi-MB system prompt is never serialized for a hash.
- **Early 413 reject**: bodies declaring `content-length` over the limit are
  refused without buffering a byte.

Measured: 50 parallel GETs served in 0.22s with 1 upstream fetch;
header-path session lookups with 5MB messages in ~6ms.

## [1.5.1] — 2026-10-15

### Removed — hardcoded model fallback

- **No more `FALLBACK_MODELS` / built-in list.** `server.js` starts with an
  empty model list and serves only live discovery results. An empty
  `/v1/models` honestly means "upstream not reached yet", so gateways and
  harnesses apply their own fallback instead of being served a stale list.
- Removed retired `ling-3.1-flash-free` aliases (upstream retired the model),
  removed its hint from `token-budget.js`, and replaced it with
  `deepseek-v4.1-flash-free` in `README.md`.
- Added `deepseek` / `big-pickle` shorthand aliases to `MODEL_MAP`.
- Unified log prefix to `[opencode-free-bridge]`, fixed stale comments
  referencing the removed cache/fallback.
- Boot no longer blocks on network: `server.listen` first, discovery runs in
  background and refreshes hourly.

## [1.5.0] — 2026-10-14

### Fixed — OpenCode v2 `/inference/v1` gate migration (`403 FreeTierError`, 9router#4837)

OpenCode v2 migrated free-tier inference from `/zen/v1/*` to `/inference/v1/*`
and added multi-layer request verification:

- **Endpoints**: moved responses, chat completions, and model discovery to
  `https://opencode.ai/inference/v1/{responses,chat/completions,models}`.
- **User-Agent**: updated to the v2 CLI format (`opencode/latest/2.0.29/cli`)
  with automatic version refresh from the upstream GitHub release Atom feed.
- **Session headers & counter gate**: sends the required session header mirrors
  (`x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`,
  `x-session-id`), removes `x-opencode-request` (rejected by v2), and clamps the
  12-bit inverted session counter to `1..16` per millisecond in `createId`.
- **Canonical tool fingerprint & conflict aliasing**: injects verbatim `read`
  and `shell` schemas required by upstream, omits `tool_choice: "none"`,
  aliases conflicting client `read`/`shell` tools (`read_client`,
  `shell_client`) with transparent response restoration, and appends a
  placeholder system instruction so injected fingerprint tools are not invoked.

### Fixed — token budget, `usage`, and `finish_reason`

- **Unified additive token budget**: `server.js` now calls
  `effectiveMaxTokens` from `token-budget.js` (`max(requested, 1024) + 4096` for
  reasoning models including `longcat-2.5-preview-free` and `cat-jam-free`),
  removing the duplicate flat `Math.max` logic and handling `max_tokens: 0` and
  numeric strings without jumping to `131072`.
- **Non-streaming `usage` in Chat Completions**: sends
  `stream_options: { include_usage: true }` upstream so `prompt_tokens`,
  `completion_tokens`, and `total_tokens` are populated instead of `{0, 0, 0}`.
- **Real `finish_reason` propagation**: propagates upstream `finish_reason`
  (`"length"`, `"content_filter"`, `"tool_calls"`, `"stop"`) across both Chat
  Completions and Responses API (`response.incomplete`).

### Changed — reliability, validation, and unit test suite

- Added `AbortController` upstream timeout (`UPSTREAM_TIMEOUT_MS`, default 120s),
  automatic upstream cancellation on client disconnect, and `req`/`res` stream
  error handlers.
- Added 10 MiB request body limit (`413 payload_too_large`) and `400` validation
  for missing/empty `model`, missing `messages`, or malformed JSON.
- Fixed `sessionCache` eviction to true $O(1)$ LRU instead of FIFO.
- Single-sourced `VERSION` from `package.json` in `server.js` and `install.sh`.
- Added automatic protocol fallback & caching when upstream returns
  `400 ModelProtocolUnsupported`.
- Added zero-network unit & HTTP integration tests (`npm test` via `node:test`)
  and GitHub Actions CI (`.github/workflows/ci.yml`).

---

## [1.4.0] — 2026-10-13

### Fixed — reasoning models returned empty answers on short requests

Reasoning models on the free tier (Muse Spark, MiMo, Nemotron, LongCat,
cat-jam, big-pickle) emit chain-of-thought tokens that count against the
**same** output budget as the visible answer. A client asking for a small
`max_tokens` — a probe, a title, a one-word reply — had the entire budget
consumed by reasoning, and the bridge returned `content: null` with
`finish_reason: "stop"`. No error, no content, tokens still billed.

Measured against the live upstream gateway:

| `max_tokens` | Result |
|---|---|
| 50 | empty for Muse Spark |
| 100 | empty for Muse Spark and cat-jam |
| 256 | empty for big-pickle; longcat finished exactly on the cap |
| 512 | content returned, truncated on long answers |
| 2048 + headroom | complete answers |

The bridge now enforces a floor, using the additive budget the wider ecosystem
settled on (OpenRouter documents the shared-budget behaviour; goose#11142
adopts the pi coding agent's formula):

```
reasoning model : max_tokens = max(requested, 1024) + 4096
plain model     : max_tokens = max(requested, 512)
both clamped to 131072
```

The client's value is only ever raised, never lowered. Reasoning detection
also honours `reasoning_effort`, so a client asking for thinking on an
unlisted model still gets headroom. See `token-budget.js`.

### Added — one-line installer

`install.sh` installs the bridge, registers a boot service (systemd on Linux,
launchd on macOS), starts it, and runs the self-check. No manual steps.

### Added — `verify.js` self-check

`node verify.js` probes every discovered model with a real prompt and prints a
summary. It distinguishes "rate-limited" (upstream throttling this IP, not a
misconfiguration) from "not answering", so a new user can tell whether their
setup is correct without reading logs.

### Added — `token-budget.js`

The token budgeting logic, extracted and documented with the measurements it
is based on, so the numbers can be re-derived rather than taken on faith.

### Changed — README rewritten around the default path

The first thing a reader sees is now: install, add one local connection,
done. Multi-host setups moved to their own section, since they are optional
and only useful for spreading upstream rate limits.

### Changed — package.json

Version corrected (was `1.0.0` while the server reported `1.3.0`), `verify`
and `test` scripts added, `files` list added so `npm publish` ships the right
set.

---

## [1.3.0] — 2026-10-13

### Added — real-time auto-discovery of upstream free models

The model list is fetched from the upstream gateway on startup and refreshed
hourly. New free models appear without a code change; retired ones disappear.
Falls back to a built-in list when upstream is unreachable.

---

## [1.0.0] — 2026-10-13

### Added — initial release

OpenAI-compatible bridge for OpenCode free-tier models. Dual-protocol routing
(Responses API for Muse, Chat Completions for the rest), desktop identity
headers to avoid `FreeTierError`, `reasoning_content` normalization, and a
persistent session cache so upstream prompt caching survives across turns.
