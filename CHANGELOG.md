# Changelog
## [2.4.0] — 2026-11-10

Anthropic's Messages API, with streaming that is actually streamed.

Claude Code and anything built on the Anthropic SDK speak `/v1/messages`, which
this bridge did not serve. The adapter relays through this bridge's own
`/v1/chat/completions`, so the Anthropic path inherits the gate anchors, session
minting, egress pool and self-healing retries instead of reimplementing them.

- `POST /v1/messages` accepts `system` blocks, `tool_use` / `tool_result`
  content, `tool_choice` and `stop_sequences`, and answers either Anthropic JSON
  or SSE.
- Streaming is forwarded as it arrives. The first version of this adapter
  buffered the whole completion and replayed it as SSE: measured, nine events
  landed in 17ms with a single `content_block_delta`, so a long generation
  looked frozen. The relay now emits each upstream delta immediately, including
  `input_json_delta` for tool calls, and asks upstream for
  `stream_options.include_usage` so a streamed reply still reports tokens.
- `POST /v1/messages/count_tokens` answers with a conservative
  four-characters-per-token estimate. There is no Anthropic tokenizer here, and
  an invented exact number would be worse than a stated approximation.
- Anthropic-only parameters with no OpenAI equivalent (`thinking`, `top_k`,
  `metadata`, `container`) are ignored with one log line naming them.
- `anthropic.js` joined `UPDATE_FILES`: a release whose `server.js` requires it
  would otherwise crash-loop on installs that never fetched it.

## [2.3.2] — 2026-11-10

A rotated address clears the cooldown its predecessor earned, and an
all-cooling pool stops spending requests it knows will be refused.

The free allowance is keyed to the address upstream sees, not to the URL of the
proxy in front of it. A phone on mobile data rotates that address several times
a day, and every rotation hands back a fresh allowance — but the pool tracked
health per proxy URL, so a `Retry-After` of 13 hours (measured: `47674s`, the
next midnight UTC) kept the phone parked long after the address that earned the
refusal was gone. Measured on a live pool: the phone answered `200` on six
consecutive requests while `/health` still reported it cooling with 13.7 hours
left, and the bridge returned `429` to the client because every member looked
spent. The other three members really were spent; the phone was not.

- The recovery watchdog now reads each parked entry's exit address from
  `cdn-cgi/trace` and clears the cooldown when it changes, because a new address
  means a new allowance. The address is persisted in `pool-health.json`, so a
  restart mid-cooldown can still notice the rotation instead of trusting stale
  evidence. `proxy.recoveryProbeTick()` runs once a minute.
- A 429 no longer walks a pool whose members are all cooling. `pick()` reports
  `cooling: true` when nothing is ready; walking the pool then spends one
  request per entry on upstreams that already refused each of them, which is how
  an egress that served nothing that day still accumulated failures and got
  stamped with a fresh 429.
- The caller now receives upstream's real `Retry-After` on a capacity 429. That
  path is a passthrough, not the gate branch, so the header was dropped and
  clients retried immediately into a still-spent pool.
- `priority-failover` strategy and the per-egress usage meter (`meter: false`
  opts an entry out) are now in `main` rather than only on the deployment.
- Gateway price list reconciles the catalog verdicts: an id the gateway serves
  at zero price is free even when the catalog still marks it deprecated, and a
  catalog-free id the gateway has stopped serving is no longer advertised —
  it sent clients into a 404 that burned their burst quota.

## [Unreleased]
A pool member no longer burns its allowance over the address family the gateway refuses.

The free tier refuses IPv6 egress and accepts IPv4: the same request, from the
same host, answered `200` over IPv4 and `429 FreeUsageLimitError` over IPv6. Bun
resolves in `verbatim` order by default, and every dual-stack host listed AAAA
for `opencode.ai` first. `server.js` already pinned `ipv4first` for its own
fetches, but `egress-proxy.js` dials the upstream itself for every CONNECT and
did not — so a pool member tunnelled every request out over IPv6, was refused,
and took the whole pool into a day-long cooldown. Six of eight members were
unusable while their IPv4 addresses still had allowance.

- `egress-proxy.js` calls `dns.setDefaultResultOrder(DNS_RESULT_ORDER || "ipv4first")`
  at startup, matching `server.js`. Pool entries on dual-stack hosts now exit
  over IPv4 and answer `200`.
- The `Retry-After` cooldown above made this worse: a refusal recorded by the
  IPv6 path parked the entry until the next daily reset, so the family could not
  be re-tested until then.

A spent egress stays spent, and a 429 no longer reaches the caller early.

OpenCode resets the free allowance once a day and says so: a spent IP answers
`429 FreeUsageLimitError` with `Retry-After: ~77415` (about 21.5 hours). The
bridge ignored that header and parked the IP for `cooldownMs * 4` — 8 minutes —
then backed off exponentially to a 30-minute cap. A spent IP therefore rejoined
rotation every 8-30 minutes, was refused again, and burned one request on every
probe. Under `failover`, which always returns `healthy[0]`, the same spent IP at
the front of the pool was retried first while the rest of the pool idled.

- `retryAfterMs(res)` reads `Retry-After` (delta-seconds or HTTP-date) and all
  four 429 sites pass it as `cooldownMs`, so a spent entry leaves rotation until
  the allowance actually returns. Missing or unparseable headers keep the old
  fixed cooldown, so a gateway that omits the header cannot regress.
- A 429 now walks the whole pool instead of failing over once. Two spent IPs at
  the front used to hand the caller a 429 while six healthy IPs sat idle; now
  every enabled member is tried and `429` only reaches the caller when the pool
  is exhausted, which is the honest answer at that point.
- Each refusal on the walk is recorded with that response's own `Retry-After`,
  so a second spent IP is parked for its own reset window rather than the
  default.
- `proxy.js`: comment wording only (an upstream suspend, not a specific host).

## [Unreleased]

`429 FreeUsageLimitError` is also a tool-name filter.

A client tool called `run_code` makes upstream answer the quota message even
when the request is otherwise identical to one that answers `200`; the same
schema under `run-code`, `runcode`, `run_program` or `code_exec` is accepted, and
adding the `read` anchor alongside it does not help. A PTC-style harness that
collapses its tool set into a single `run_code` tool therefore failed every turn
with what looked like a spent allowance.

- A client tool whose name matches `run_code` is sent upstream as `run_program`
  and renamed back on the way out: streaming deltas, `tool_choice` and
  tool-result turns all carry the client's own name.
- An alias the client already owns is left alone; the renamed copy becomes
  `run_program2` instead of shadowing a live tool.
- The filter is documented in the troubleshooting section with the measured
  name matrix.

## [2.3.1] — 2026-10-25

Pool health survives a restart.

A pool that forgets its cooldowns re-burns every spent IP on the first request
after a restart, which is exactly what an Instabox suspend/resume does eight
times a day. The rotation was correct; its memory was not.

- Cooldowns, failure counts and last-seen timestamps are written to
  `<state dir>/pool-health.json` (mode `0600`) and re-applied by
  `loadFromDisk()`. A restart now resumes with the same pool state it went down
  with.
- Records are keyed by a truncated SHA-256 of the egress identity, so the health
  file is not a second copy of the proxy credentials sitting next to
  `proxy.json`.
- A refusal writes immediately; a success is coalesced over one second. The file
  is written by rename, so a crash mid-write keeps the previous copy.
- A corrupt health file costs the cooldowns and nothing else.
- `setPool` no longer calls `resetHealth()`: saving the pool from the panel —
  including a strategy change — used to discard every cooldown it had learned.
  Removed entries are still pruned and the file is rewritten to match.

## [2.3.0] — 2026-10-25

Egress pool: one bridge, many exit IPs.

The free-tier allowance is per egress IP, so the previous answer to "I need more
IPs" was one bridge process per host: eight hosts, eight service units, eight
tunnels, eight catalogs to keep in step. The pool moves that rotation into the
one thing that already makes the request, and the per-host process goes away.

### Pool (`proxy.js`, `server.js`)

- A pool is a list of entries (`url`, `{id,label,url,enabled,weight}`, or
  `{direct: true}` for the hosting machine's own address). `direct` is a
  first-class entry, so the bridge host's IP takes part in the rotation instead
  of being the fallback used only when every proxy is down.
- Strategies: `round-robin` (default), `failover` (sticky, preserving upstream
  prompt caching on one IP), `random` (weighted).
- Health is per entry and keyed by egress identity, not by URL, so `direct`
  cannot share a record with a proxy. Backoff doubles per consecutive failure
  from `cooldownMs` (120 s) up to `maxCooldownMs` (30 min); a success resets it.
  A `429` earns four times the base window.
- When every entry is cooling the one that recovers first is used anyway:
  refusing to send would turn a throttled pool into a dead bridge.
- A gate rejection drops the refused entry and retries through a different one
  inside the same request. An unreachable proxy is failed over too, because
  nothing reached upstream; that path used to surface a 500 to the client.
- Every non-egress retry (protocol lane, endpoint migration, 5xx, gate shape)
  reuses the entry the request started on, since upstream ties a retry to the
  address that saw the first attempt.
- `UPSTREAM_PROXY_POOL` / `UPSTREAM_PROXY_STRATEGY` are operator overrides that
  lock runtime edits, matching `UPSTREAM_PROXY_URL`.

### Egress proxy (`egress-proxy.js`)

A dependency-free HTTP proxy so a host can become a pool member without root, a
package install, or a config file: CONNECT plus absolute-URI HTTP, optional
`EGRESS_PROXY_TOKEN` (Basic, password only), unauthenticated `/healthz` carrying
nothing but a connection count and uptime. TLS is tunneled end to end, so it
never sees plaintext. It binds loopback; reachability is the tunnel's job.

`egress-proxy.js` ships through `UPDATE_FILES`, `install.sh` and `package.json`
`files[]`, and `install.sh` marks it executable.

### Panel

`/` gains a pool section: one proxy per line (`label=url`), strategy selector,
*Uji semua* (probes every entry concurrently and records the verdict in the same
health map the request path uses), *Simpan pool*, and *Kosongkan pool*. The
status block lists each entry with its state, remaining cooldown, failure count
and last error.

### Fixed

- A `429 FreeUsageLimitError` never marked its egress. `isFreeTierCliGateError`
  only recognises 401/403/426, so the refusal fell into the generic non-gate
  branch and the pool learned nothing. Measured on the fleet: six requests
  rotated through six IPs, four answered 429, and `/health` still showed every
  entry `ready` — the pool burned the whole rotation on every request. A 429 now
  parks that entry (four base windows) and the same request retries through
  another one.
- A 5xx does *not* park the egress: that is upstream's fault, and treating it as
  the IP's would empty the pool during a bad hour at the gateway.
- `markFailure`/`markSuccess` treated the `direct` entry's empty URL as "nothing
  to record", so an exhausted bridge host IP was never cooled down. Health is
  keyed by egress identity now, and only a missing state means nothing to record.
- `pick({exclude})` let a round-robin selection return the excluded entry,
  defeating the retry-on-another-egress path entirely.
- `withProxy({}, "")` treated the `direct` entry's empty URL as "no egress" and
  fell back to a pool pick, so an explicitly pinned direct egress was ignored.

## [2.2.2] — 2026-10-25

Fleet release: the catalog-freeze fix plus the delivery fixes below. Every
machine was on 2.2.1, whose `/v1/models` could stay frozen for the life of the
process, so this is the version the fleet is pinned to.

### Upstream catalog froze on crashed boots (identity.js)

Boot-time warm-start from `~/.opencode-free-bridge/cache/catalog.json` filled
`freeModels`, and `refresh()` only re-read the provider catalog when that list
was empty — so a booted process served a permanent snapshot: retired models
(measured: `minimax-m3.1-flash-free` answered upstream with `404` while still
listed) stayed in `/v1/models`, and clients spent the per-IP free burst quota
probing ids upstream no longer knows.

- Both the "up-to-date" and "available-not-adopted" branches of `refresh()`
  now re-read the catalog. `refresh()` is TTL-gated by `ensureFresh`, so this
  costs at most one request per refresh interval.
- `verify.js` now breaks its sweep at the first `429` the same way it already
  breaks on `403 gate-closed` — hammering every model while the IP is
  throttled only prolongs the allowance window.
- `THIRD_PARTY_NOTICES.md` now ships through both delivery paths
  (`UPDATE_FILES` and `install.sh`), fixing the delivery test.

### 429 FreeUsageLimitError was a request-shape problem, not a quota

The gateway answers `429 FreeUsageLimitError` for two unrelated things: an
exhausted free-tier allowance, and a system prompt that lacks the harness
`<env>` block. Only the second one applied here — the CLI answered while the
bridge was refused in the same minute, repeatedly, which the previous
"time-of-measurement artifact" note could not explain.

- Reproduced by capturing the CLI's own request (`opencode run` through a local
  provider pointing at a capture server) and replaying it byte-for-byte: 200.
  The same body with the system prompt replaced by a short one: 429. Both went
  out with the same headers, session id and TLS stack, so the difference is the
  body.
- The trigger is the `<env>` block plus a `Working directory:` line, not the
  prompt length: a 12 KB generic prompt is refused, a 65-byte
  `<env>Working directory: /tmp</env>` is accepted, and `big-pickle` and
  `mimo-v2.6-flash-free` behave identically. Dropping every tool (`tools: []`)
  produces the same 429, which is why that case also looked like a quota error.
- `transformChatMessages` and `extractSystemInstructions` now append the block
  (working directory, workspace root, git-repo flag, platform) to whichever
  system prompt the request carries, synthesizing one when the client sent
  none. A client forwarding the CLI's own prompt keeps its block unchanged and
  gets no duplicate.
- Covered by a regression test in `test/server.test.js` for both protocol
  lanes.

## [2.2.1] — 2026-10-22

Hardening for the egress proxy shipped in 2.2.0. The feature worked, but three
defects made it unsafe to leave as-is.

### An upgrade from 2.1.0 could crash the bridge

2.1.0's self-updater had no `proxy.js`/`panel.js` in `UPDATE_FILES`. Updating
such an install to 2.2.0 wrote a `server.js` that required those modules,
restarted, and died with `Cannot find module './proxy'` — a crash loop with no
recovery except reinstalling. Reproduced end to end before fixing.

- `server.js` and `identity.js` now load `proxy`/`panel` tolerantly: a missing
  own module degrades to direct egress instead of throwing at require time.
  Only a missing *own* module is tolerated; a real error inside the file still
  surfaces.
- The updater reads the **incoming** `server.js`, extracts its relative
  requires, and stages any module the running file list does not name. An old
  `UPDATE_FILES` can no longer install a server it cannot boot.
- On boot, `repairMissingModules()` re-fetches modules that `server.js` requires
  but that are absent, so an already-broken 2.2.0 install heals on restart
  instead of needing `install.sh`. Best-effort and non-blocking.

### The panel API was writable from any website (CSRF)

`POST /api/proxy` accepted `text/plain`, which browsers send cross-origin
without a preflight, and it never looked at `Origin`, `Sec-Fetch-Site`, or
`Host`. Any page the operator visited could point the bridge's egress — and its
self-updater — at an attacker's proxy, or switch it off.

- Writes require `Content-Type: application/json` (415 otherwise).
- Cross-site requests are refused (403) on `Sec-Fetch-Site` and on a foreign
  `Origin`.
- The `Host` header must be a loopback name, the configured bind address, or an
  entry in `PANEL_ALLOWED_HOSTS`, which closes DNS rebinding.
- The panel is served with `X-Frame-Options: DENY`, and `HEAD /` works again
  instead of returning 404.

### Container lost the proxy setting

`proxy.json` was written to `~/.opencode-free-bridge` inside the container,
which is discarded on recreate. The image now sets
`OPENCODE_BRIDGE_STATE_DIR=/data/state` and compose mounts a `bridge-state`
volume there.

### Node compatibility

`testProxy` correctly refuses to run on Node (Node's fetch ignores the `proxy`
option, so a probe would report success while going out directly), but two
tests asserted the Bun behaviour unconditionally. They now assert the refusal
on Node and the probe verdict on Bun.

## [2.2.0] — 2026-10-21

### Egress proxy, configured from the browser

`http://127.0.0.1:20129/` now serves a panel instead of the health document, and
the panel sets an HTTP proxy for **every** outbound request the bridge makes:
inference, model discovery, identity/update sync, and the self-updater. Upstream
sees the proxy's IP, not this machine's.

- **`proxy.js`:** validates `http://`/`https://` URLs (percent-encoded
  credentials supported), refuses SOCKS with Bun's own reason
  (`UnsupportedProxyProtocol`), persists to `~/.opencode-free-bridge/proxy.json`
  at mode `0600`, and exposes `netFetch()` — one egress point used by `server.js`
  and `identity.js`. `UPSTREAM_PROXY_URL` is an operator override that also locks
  runtime edits.
- **`panel.js`:** HTML panel plus `/api/proxy` (GET status, POST set/clear) and
  `/api/proxy/test` (probe). Status, `/api/proxy`, and `/health` expose `host:port`
  only; credentials never leave the process.
- **Test before trusting it:** the probe fetches the models endpoint through the
  candidate and reports the exit IP from `cdn-cgi/trace`, so a working tunnel with
  a refused egress (403) is distinguishable from a broken proxy.
- **No restart:** the URL is read per request.
- **`/health`:** `egress.mode` is now what actually carries traffic (`proxy`,
  `relay`, `direct`), with `egress.proxy` describing the proxy state.
  `verify.js` prints the egress line before probing.
- **Relay interaction:** with both configured, the request still targets
  `UPSTREAM_RELAY_URL` and that connection is dialled through the proxy.
- **Delivery:** `proxy.js` and `panel.js` added to `package.json` `files`,
  `UPDATE_FILES`, and `install.sh` (fetch, syntax check, install, backup), so the
  self-updater cannot leave an install missing the modules `server.js` requires.

### `install.sh` installs the checkout it runs from

`bash install.sh` inside a clone always downloaded from GitHub, so a file added
in the working tree but not yet pushed failed the install with a bare
`curl: (22) The requested URL returned error: 404` that named neither the file
nor the cause. `SOURCE=auto` now installs the local working tree when the script
runs from a checkout, the remote path names the file it could not fetch and
points at `SOURCE=local` as the way out, and `SOURCE=remote` restores the old
behaviour. The `curl | bash` route is unchanged.

## [2.1.0] — 2026-10-21

### Container deployment

The bridge can now run in a container. `Dockerfile` and `docker-compose.yaml`
were contributed in PR #1 by [@rustam76](https://github.com/rustam76); this
release completes them so the container is actually usable. Their commits stay
in the history of this repository as the base of the merge.

- **Pinned base image (`oven/bun:1.4.3-slim`).** The free-tier gate inspects
  the TLS ClientHello, so the Bun version in the image is not interchangeable
  with any other. The pinned tag is the version the fingerprint baseline was
  measured on, and `bun transport-fingerprint.js --check` passes inside the
  image.
- **Writable `/app` (`chown -R bun:bun /data /app`).** `COPY --chown` chowns
  the copied files but not the directory that holds them, so `/app` stayed
  root-owned while the process ran as `bun`. The self-updater stages its temp
  files next to their targets inside `__dirname`, so every in-place update
  died with `EACCES: permission denied`.
- **Loopback-only port publish.** The compose file only had `expose:`, which
  publishes inside the compose network, so the documented base URL
  (`http://127.0.0.1:20129/v1`) was unreachable from the host. It now publishes
  `127.0.0.1:20129:20129` — loopback on purpose, because the bridge has no
  authentication and a `0.0.0.0` publish would be an open relay.
- **`AUTO_UPDATE=0` by default.** The image is the unit of deployment, so an
  in-place self-update is reverted by the next `docker compose build`. Upgrade
  with `docker compose build --pull && docker compose up -d`.
- **`.dockerignore`.** Keeps `.git`, `.github`, and `test/` out of the build
  context. A `.git` directory inside the image defeats the self-updater's
  `git-checkout` guard, and it is not something a published image should
  carry.
- **Hardened runtime:** `cap_drop: [ALL]` next to `no-new-privileges`, and a
  `HEALTHCHECK` in the Dockerfile so a plain `docker run` is health-checked too.
- **Docs:** README gains a Docker install section, AGENTS.md a container
  install option and rows for the new files.

The container files ship in the repository, not in the npm tarball: they are
build inputs for a checkout, not runtime files a host install needs, so they
stay out of `package.json` `files` (which the self-updater and `install.sh`
both have to deliver).

### A note on the contributor graph

[@MBMoulidharan](https://github.com/MBMoulidharan) is the same person as
[@rustam76](https://github.com/rustam76) — two accounts registered ninety
minutes apart on 2019-04-12, with user IDs `49561459` and `49564359` (the
digits transposed). Only `rustam76` authored anything here: all three commits
of PR #1 are attributed to `rustam76` by GitHub itself.

A `Co-Authored-By` trailer on the merge and the follow-up commit briefly
carried `49561459+rustam76@users.noreply.github.com` — a transposed typo —
and GitHub maps the numeric prefix of a `noreply` address to the account with
that id, so the credit landed on `MBMoulidharan` and produced a second entry
in the contributor graph. The trailer is corrected in the current history.
Forks taken before the correction still carry the old commits, so their graphs
show the same extra entry until they re-sync.

---

## [2.0.3] — 2026-10-20

### IP-level abuse blocks are terminal, not a stale identity

Upstream now returns a second, explicit `403 FreeTierError` message for a
network-level flag (*"OpenCode's free models aren't available from your current
network because we've detected abusive traffic from this IP address"*, and the
earlier `Forbidden, OpenCode Free Model Gateway Detect Abuse Traffic`). The
bridge treated it like the shape gate: forced a GitHub/catalog refresh, re-minted
the session id, and replayed the request once. No identity change can clear a
flag keyed to the egress IP, so the retry only extended the penalty and appended
a misleading "update opencode-free-bridge" hint to the refusal.

- **Terminal classifier (`identity.js`):** `isIpAbuseRejection` matches the
  known phrasings; `onGateRejection` returns `{retry:false, reason:"ip-abuse",
  terminal:true}` before consulting the refresh cooldown.
- **No refresh, no retry (`server.js`):** the gate branch short-circuits on the
  first abuse message and returns it verbatim with
  `X-OpenCode-Gate: ip-abuse` and upstream's `x-opencode-log-id`. The retry path
  applies the same rule when the first attempt carried the ambiguous shape
  message.
- **Accurate diagnosis:** `/health` reports `identity.gate.status: "ip-blocked"`
  plus `ipBlockedSince` and `lastRejection.kind`, and a later success clears it.
  The generic gate diagnostic is labelled `kind: "free-tier-gate"`.
- **`verify.js`:** reads `X-OpenCode-Gate` (`ip-throttled` / `ip-abuse` →
  `gate-closed`, exit `2`; `shape-rejected` → failure) and falls back to the
  abuse wording. A correctly installed bridge is no longer reported as broken,
  and the installer repeats the right verdict.
- **Tests:** both abuse phrasings assert exactly one upstream call, zero
  `onGateRejection` calls, a verbatim body, and the `ip-abuse` header; identity
  tests assert no refresh; the retry path is covered when the block appears only
  on the second attempt.
- **Docs:** README and AGENTS troubleshooting sections now route abuse blocks to
  upstream support instead of reinstall/update advice.

### Optional egress relay

`UPSTREAM_RELAY_URL` sends inference through a relay implementing the 9Router
`x-relay-target` / `x-relay-path` contract, so upstream sees the relay's egress
IP instead of this host's. It covers the initial request and every retry; model
discovery and identity sync stay direct. Empty (the default) keeps direct
egress. `/health` reports `egress.mode` and the relay's origin only (credentials
and query strings are not exposed), and changing the variable requires a
restart.

---

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
