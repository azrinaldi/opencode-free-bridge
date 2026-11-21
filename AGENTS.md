# AGENTS.md: AI Agent Playbook for `opencode-free-bridge`

This file gives AI coding agents (OpenCode, Claude Code, Cursor, Codex, Cline, Aider, etc.) exact instructions for installing, running, connecting, troubleshooting, and modifying `opencode-free-bridge`.

---

## 1. Critical Rules (Read First)

1. **Runtime MUST be Bun (`bun server.js`).**
   - Do **not** run the production server under Node.js (`node server.js` intentionally exits with code `1`).
   - Reason: the official OpenCode CLI is compiled with Bun (BoringSSL). Upstream's free-tier gate inspects the TLS `ClientHello` fingerprint (17 ciphers, 12 extensions). Node.js (OpenSSL) offers 52 ciphers and is rejected with `403 FreeTierError`.
   - `ALLOW_NODE=1` is strictly for offline unit tests with mocked `fetch`, never for live traffic.
2. **Zero external dependencies.**
   - Do not run `npm install` or add packages to `package.json`. The bridge uses only built-in runtime modules.
3. **Never hardcode model IDs or aliases.**
   - Model availability changes frequently upstream. Always query `GET http://127.0.0.1:20129/v1/models` to see active free models.
   - Retired models (such as `cat-jam-free`, `muse-spark-1.3-contributor-free`, `muse-spark-1.2-contributor-free`, `step-5-preview-free`) return HTTP `404` by design.
4. **Upstream inference requires `stream: true`.**
   - Upstream rejects non-streaming inference requests with `403 FreeTierError`. `server.js` always sends `stream: true` upstream and folds SSE back into JSON when a client requests `stream: false`. Any direct diagnostic probe (`verify.js`, `gate-drill.js`) must keep `stream: true`.

---

## 2. Installing & Starting the Bridge for a User

### Option A: Standard system install (recommended for persistent background service)

Run the installer script. It finds or installs `bun` (installing `unzip` first on minimal Linux if needed), stages and validates files before touching a running service, retires legacy `opencode-bridge.service` units, places files in `~/.opencode-free-bridge`, migrates any `node` service units to `bun`, starts the `opencode-free-bridge` service (`systemd` on Linux, `launchd` on macOS), and verifies `/health` and the TLS baseline:

```bash
curl -fsSL https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/install.sh | bash
```

If you are already inside a local clone of this repository, run:

```bash
bash install.sh
```

That installs the **working tree**, not GitHub, so an unpushed commit can be
installed and tested. `SOURCE=remote bash install.sh` forces the download path;
`SOURCE=local` refuses to fall back to it.

Custom port or install directory:

```bash
PORT=20129 HOST=127.0.0.1 BINDIR="$HOME/.opencode-free-bridge" bash install.sh
```

### Option B: Run directly from this repository (foreground or custom process manager)

```bash
# Ensure bun is on PATH (check ~/.bun/bin/bun or ~/.local/bin/bun if not in default PATH)
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
bun server.js
```

### Option C: Container deployment (Docker / Docker Compose)

```bash
docker compose up -d          # builds the image and starts the bridge
docker compose build --pull && docker compose up -d   # upgrade
```

The compose file publishes `127.0.0.1:20129` on loopback only, persists the
catalog cache in the `bridge-cache` volume, and runs the image as the non-root
`bun` user. The base image is pinned to `oven/bun:1.4.3-slim` because the
free-tier gate checks the TLS ClientHello — verify it inside the image with
`docker compose exec bridge bun transport-fingerprint.js --check`.

`AUTO_UPDATE` is `0` in the compose file: the image is the unit of deployment,
so an in-place self-update would be reverted by the next build.

### Verify the server is healthy

```bash
# 1. Check health and derived OpenCode CLI identity
curl -s http://127.0.0.1:20129/health

# 2. List currently active free models
curl -s http://127.0.0.1:20129/v1/models

# 3. Verify Bun TLS ClientHello matches the OpenCode CLI baseline
bun transport-fingerprint.js --check

# 4. Run the quick readiness check (exits 0 if a model answers, 2 if IP quota is throttled, 1 if broken)
bun verify.js --quick

# 5. Send a test chat completion request
curl -s http://127.0.0.1:20129/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Reply with OK"}]}'
```

---

## 3. Connecting Clients & Gateways

Use these connection details in any OpenAI-compatible tool:

- **Base URL:** `http://127.0.0.1:20129/v1`
- **API Key:** `public` (or any non-empty string)
- **Chat Completions Endpoint:** `POST http://127.0.0.1:20129/v1/chat/completions`
- **Models Endpoint:** `GET http://127.0.0.1:20129/v1/models`

### Egress proxy (panel)

`GET http://127.0.0.1:20129/` serves an HTML panel: enter `http://[user:pass@]host:port`, press
*Simpan dan pakai*, and every outbound request (inference, model discovery, identity sync,
self-update) is tunnelled through that proxy. *Uji koneksi* probes the models endpoint through the
candidate and reports the exit IP; *Matikan proxy* returns to direct egress. No restart needed.

- HTTP/HTTPS only. SOCKS5 is refused (Bun: `UnsupportedProxyProtocol`). TLS still comes from Bun,
  so `transport-baseline.json` stays valid.
- Credentials persist in `~/.opencode-free-bridge/proxy.json` (mode `0600`) and are never returned
  by the panel, `/api/proxy`, or `/health`.
- API: `GET /api/proxy` (status), `POST /api/proxy` `{"url":"…"}` (set; `""` clears),
  `POST /api/proxy/test` `{"url":"…"}` (probe). Operator override: `UPSTREAM_PROXY_URL`, which
  locks the panel.
- The panel and `/api/proxy` are an admin surface: writes must be
  `Content-Type: application/json`, cross-site requests are refused, and `Host` must be loopback,
  the bind address, or listed in `PANEL_ALLOWED_HOSTS`. Keep those checks if you touch the route.
- `/health` → `egress.mode` (`proxy` / `relay` / `direct`) and `egress.proxy` (host:port only).

### Reactive egress rotation (WARP / Tor hop on 429)

When upstream answers `429 FreeUsageLimitError` and the operator configures a rotation provider, the
bridge can exchange a spent IP for a fresh one instead of passing the refusal to the client:

- Configure once: panel section *Rotator egress (WARP / Tor)*, `POST /api/rotator
  {"command":"…"}` for WARP, or `{"provider":"tor","controlPassword":"…"}` for Tor. Env overrides
  (`WARP_ROTATE_CMD`, `ROTATE_PROVIDER`, `TOR_CONTROL_*`) lock the panel, like `UPSTREAM_PROXY_URL`.
  WARP uses any command that produces a new egress address (`warp-cli disconnect && warp-cli
  connect`, a hop CLI, a PowerShell script). Tor sends `SIGNAL NEWNYM` over the control port
  (default `127.0.0.1:9051`) with password or cookie auth; an HTTP proxy in front of Tor remains
  the bridge's egress because Bun's fetch refuses `socks5://`.
- Flow on a quota 429 (`FreeUsageLimitError`; a model-capacity `RateLimitError`
  429 passes through untouched): run the command once → poll the exit IP (`WARP_ROTATE_PROBE_URL`,
  default `https://www.cloudflare.com/cdn-cgi/trace`; through the same egress the requests use —
  the pinned proxy, or direct when none is configured, the TUN-mode case) →
  when the IP differs from the pre-rotation address, clear the egress cooldown and replay the
  request once on the new IP. Client sees 200; only a failed/unchanged rotation passes the 429
  (with upstream's `Retry-After`) through.
- Guards: single-flight, one rotation per request, inter-rotation cooldown
  (`WARP_ROTATE_COOLDOWN_MS`, default 75s), 20 rotations/hour cap, skipped for 403/ip-abuse and
  when a ≥2-entry pool is active (the pool walk already changes IP without a hop).
- Status: `/health` → `egress.rotator`; manual hop: `POST /api/rotator {"rotate":true}`;
  config lives in `<state dir>/rotator.json` (mode `0600`); the command string is write-only and
  never echoed by the panel, `/api/rotator`, or `/health`.

### Current active free models (also supports family shorthands)

Always verify via `GET /v1/models`. As of catalog sync `v2.0.0`:
- `mimo-v2.6-flash-free` (shorthand: `mimo`)
- `big-pickle` (shorthand: `big-pickle`)
- `beam-free` (shorthand: `beam`)
- `nemotron-3-ultra-free` (shorthand: `nemotron-free`)
- `nemotron-3.5-lightning-free`
- `nemotron-3.5-super-vl-free`
- `longcat-2.5-preview-free` (shorthand: `longcat`)
- `deepseek-v4.1-flash-free` (shorthand: `deepseek-flash`)
- `glm-5.3-flash-free` (shorthand: `glm-flash`)
- `space-bunny-free`

### Multi-host / VPS SSH tunnel setup (to bypass single-IP rate limits)

If the user has another machine or VPS running `opencode-free-bridge` on port `20129`, forward a local port via SSH and register both ports in their router (such as 9Router or LiteLLM):

```bash
ssh -N -L 127.0.0.1:20130:127.0.0.1:20129 user@remote-vps
```

For a **reverse** tunnel (`-R`, the sending host dials out to the host that runs the router), run it as a systemd unit so it survives a reboot, and point `-i` at a key that actually exists on that host:

```ini
[Service]
ExecStart=/usr/bin/ssh -NT -o BatchMode=yes -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
  -i /root/.ssh/id_vps_master -p 48222 \
  -R 127.0.0.1:20136:127.0.0.1:20129 root@router-host
Restart=always
RestartSec=5
```

#### Stale forwards after an unclean disconnect

A reverse tunnel is held open by an `sshd-session` on the **receiving** host. When the sending host reboots or loses power, the TCP connection dies without a FIN and the receiving sshd keeps the listening socket until it notices. A replacement tunnel then fails with:

```
Error: remote port forwarding failed for listen port 20136
```

The default `ClientAliveInterval 300` × `ClientAliveCountMax 2` leaves that window at **ten minutes**. Two fixes, both worth having:

1. **Tighten the keepalive** on the receiving host. OpenSSH uses the **first** value it reads, so the drop-in must sort *before* any existing one:

   ```bash
   # /etc/ssh/sshd_config.d/00-keepalive.conf   (note the 00- prefix)
   ClientAliveInterval 30
   ClientAliveCountMax 4      # dead peer detected after 120s
   ```

   Verify with `sshd -T | grep -i clientalive`, then `systemctl reload ssh`.

2. **Reap the stale session** when it has already happened. `tunnel-doctor.sh` (shipped in this repo) distinguishes a *live* forward from a stale one by checking whether the sshd session holding the listener still has an established transport — a listener alone proves nothing:

   ```bash
   ./tunnel-doctor.sh                 # report
   ./tunnel-doctor.sh --reap          # kill sessions with no transport
   ./tunnel-doctor.sh --check         # audit the keepalive window
   ```

---

## 4. Troubleshooting Guide for Agents

When a user reports an error, diagnose it using this decision table before changing any code or configuration:

| Symptom | Root Cause | Action to Take |
|---|---|---|
| `node server.js` exits with `opencode-free-bridge requires Bun` | Server was launched with Node.js instead of Bun | Launch with `bun server.js` (or run `bash install.sh` to rewrite the systemd/launchd service unit to use `bun`). |
| `HTTP 403` whose message names `abusive traffic`, `Detect Abuse Traffic`, or `Abuse of traffic` (response header `X-OpenCode-Gate: ip-abuse`; `/health` -> `identity.gate.status: "ip-blocked"`) | The gateway flagged the egress IP. It is unrelated to the account and to the request shape, so no identity change can clear it. | Do **not** reinstall, edit headers, or retry. The bridge already skips refresh/retry and returns the refusal verbatim. Confirm with the official CLI from the same network; only upstream can clear it (`help@anoma.ly`, quote `x-opencode-log-id`). Change egress (SSH tunnel/relay) or wait. |
| `HTTP 403 FreeTierError` returned to client **after** logs show `refreshing identity and retrying once with full tool set` or `skipping retry because a full-shape retry already failed <30s ago` (and `verify.js` exits `2` with `GATE`) | **Two distinct causes, one indistinguishable upstream message.** Read the log tail: it now ends with either *"the request carried every anchor the gate checks, so this is the egress"* or *"this bridge produced a shape the gate refuses — missing …"*. The second is a bridge bug, not a quota problem. | **First read the verdict in the log line.** If it says the shape was complete, the egress is refused: do not modify headers or code, run `bun gate-drill.js` and check `upstream control` (`HTTP 403 -> gate CLOSED` means this IP is refused; the official `opencode` CLI fails identically from it). If it names missing anchors, the derived recipe/tool profile lost one — inspect `/health` → `identity.gate.anchors` and `identity.gate.lastRejection`. The bridge suppresses duplicate 403 retries and forced GitHub refreshes for 30s (`GATE_RETRY_COOLDOWN_MS`, `GATE_REFRESH_COOLDOWN_MS`) so it does not extend an IP penalty. |
| `verify.js` exits `1` with `TLS fingerprint drift detected` or `Server is running on Node.js` | The runtime's TLS `ClientHello` does not match `transport-baseline.json` | Run `bun transport-fingerprint.js --check` to inspect cipher/extension differences, and ensure the service runs under a current Bun 1.4+ binary. |
| `bun: command not found` in a fresh SSH session, but the service is healthy | `bun.sh/install` only edits an interactive shell's PATH | Use the absolute path (`~/.bun/bin/bun`) or export `PATH="$HOME/.bun/bin:$PATH"`. Do not reinstall. |
| `HTTP 429` or `BUSY` in `verify.js` | **Three causes, one message.** Either the model/IP capacity is spent, the request's system prompt lacks the harness `<env>` block (`<env>` + a `Working directory:` line) — the gateway answers both with `429 FreeUsageLimitError` — or a client tool declares a parameter named `old_string`/`new_string` (the Claude-Code-style `edit` schema used by omp/Cline/Roo/Aider); the gate inspects `parameters.properties` keys, not the tool name or description. Measured: a 65-byte env block passes while a 12 KB generic prompt fails, and `tools: []` fails too; with the env block present, all 14 omp tools pass except `edit`, and renaming just those two keys makes all 14 pass. | If the bridge is older than the `<env>` fix or the parameter-alias fix, upgrade first. Otherwise switch model ID from `GET /v1/models`, or wait for the allowance window. Confirm by interleaving `opencode run -m opencode/<model>` with a `curl` to the bridge in the same minute: both refusing means capacity; CLI answering while the bridge refuses means a shape bug. If the client declares `edit`, check its `parameters.properties` for `old_string`/`new_string`. `verify.js` now stops the sweep at the first `429` (before 2026-10-25 it swept all 11 models, prolonging the penalty). |
| `HTTP 404 Model '<id>' has been retired upstream` | Client requested a deprecated model (e.g. `cat-jam-free`, `muse-spark-*`, `step-5-preview-free`) | Fetch `GET /v1/models` and update the client configuration to use an active model ID. |
| `HTTP 404 Model '<id>' is not on the free tier` | Client requested a paid model (e.g. `gpt-5.4`, `claude-sonnet-4-5`) | The bridge only serves zero-cost models (`cost.input === 0`). Pick a model from `GET /v1/models`. |
| Port conflict (`port 20129 is occupied by another process`) during `install.sh` | Another non-bridge process is listening on port 20129 | Stop the conflicting process or install on another port (`PORT=20130 bash install.sh`). Legacy `opencode-bridge.service` and the bridge's own process are retired/replaced automatically. |
| Proxy set in the panel, but `/health` still shows `egress.mode: "direct"` | The setting is read per request; a locked panel (`locked: true`) means `UPSTREAM_PROXY_URL` in the environment owns it | Read `egress.proxy.source` (`file` / `env` / `none`) and `egress.proxy.error`. To change an env-locked proxy, edit the service unit and restart. |
| *Uji koneksi* reports `403` from the proxy | The proxy tunnel works but upstream refuses that egress IP | Pick a different proxy; the IP is refused, not the request shape. Run `bun verify.js --quick` after switching to confirm. |
| Panel rejects `socks5://…` | Bun fetch supports HTTP/HTTPS proxies only and throws `UnsupportedProxyProtocol` for SOCKS | Use `http://host:port` (Clash/v2ray expose a mixed HTTP port), or terminate SOCKS in a local HTTP proxy. |
| `exception: TypeError … ECONNRESET` in the logs while a WARP hop runs | The hop disconnects the tunnel for ~10s, so client requests whose sockets are mid-flight through the TUN get reset — expected rotator behavior, not a bridge fault | Nothing to fix since v2.4.x: the bridge logs a warn and answers those requests `503` + `Retry-After: 10` (client retries once the hop completes). Seeing the warn right after `429 on egress direct; rotating egress before retry` is normal. An `ECONNRESET` when the rotator is *idle* is a real transport fault — check `egress.mode` and the proxy. |
| `429 FreeUsageLimitError` keeps returning and the machine's egress IP can be changed (WARP tunnel / rotator app) | The per-IP free allowance is spent and the egress address never changes, so every request re-stamps the same spent IP | Configure the rotator once (panel → *Rotator egress (WARP hop)*, or `POST /api/rotator {"command":"…"}` / env `WARP_ROTATE_CMD`): on the next 429 the bridge runs that command, waits until the exit IP actually differs (≤45s), clears the cooldown, and retries once — a successful hop answers 200 to the client. Verify with `GET /health` → `egress.rotator` (`rotations`, `lastResult`) and trigger manually with `POST /api/rotator {"rotate":true}`. If `lastResult.error` says the IP never changed, the command re-connected the tunnel without a new allocation; fix the command, not the bridge. The rotator only fires on the *quota* kind of 429 (`FreeUsageLimitError`); a model-capacity 429 (`RateLimitError "Endpoint is unavailable"`) passes through untouched because no IP makes a busy model less busy. |
| Rotator configured, but in Docker the hop never happens or the IP never seems to change | The container does not ride the host's WARP TUN, cannot execute host binaries (`execFile` runs inside the container), and its `127.0.0.1` is not the host's | Point the egress at the tunnel-fronting proxy via `host.docker.internal` (Linux: `extra_hosts: ["host.docker.internal:host-gateway"]`), expose the hop as an HTTP trigger and set `WARP_ROTATE_CMD=bun -e "await fetch('http://warp-ctl:9000/hop')"` (bun ships in the image; slim has no curl). For servers use a WARP sidecar with `cap_add: [NET_ADMIN]` + HTTP proxy front end — the bridge itself keeps `cap_drop: [ALL]`. The probe rides the egress, so it observes sidecar hops without WARP knowledge. `rotator.json` persists in the `bridge-state` volume. See README → *Reactive egress rotation* → *In Docker*. |
| Hop runs (warp-cli says Connected) but rotation times out with "IP tidak berubah" | Two live-verified causes: (1) the tunnel protocol is WireGuard — device addresses are pinned, five reconnect cycles produce the identical address, so no command can hop; (2) the probe watches the wrong family — WARP pins the IPv4 egress per account (same `104.28.x.x` forever) and rotates the IPv6 /64 per handshake under MASQUE | Check `/health` → `egress.mode` first (a dead pinned proxy starves the probe). Force MASQUE: `warp-cli tunnel protocol set MASQUE && warp-cli connect`. Point `probeUrl` at an IPv6-reachable echo (`https://ipv6.icanhazip.com`). The rotator compares same-family only, so a v4→v6 flip never fakes a hop. End-to-end verified: `warp-cli disconnect && warp-cli connect && sleep 4` with an IPv6 probe answers `ok:true, changed:true` in ~6s. See README → *Verified behaviors (live warp-cli testing)* — bare-address probe bodies (`icanhazip.com`) are accepted too. |
| Running `bun test test/rotator*.test.js` while a live bridge serves on the same machine deletes the live bridge's `rotator.json` | The suite's `__reset({ keepConfig: false })` unlinks the config resolved from `OPENCODE_BRIDGE_STATE_DIR`; a test that resets before pointing that env at its temp dir deletes the operator's real config | Fixed: the state-dir env is set in `beforeEach` before any reset, and `test/rotator-429.test.js` asserts the invariant loudly. If a future refactor reorders it, the guard fails instead of silently eating live config. |

---

## 5. Repository Architecture & Codebase Guide (For Contributors)

| File | Responsibility |
|---|---|
| `server.js` | HTTP server (panel at `/`, `/v1/chat/completions`, `/v1/models`, `/health`, `/api/proxy`, `GET /api/egress-ip` — probes `cdn-cgi/trace` through the active egress so the panel shows the address upstream sees, `/api/rotator` with the `adminRequestError` CSRF/Host guard), Bun runtime guard, tolerant loading of `proxy.js`/`panel.js` plus `repairMissingModules()` so a half-installed tree boots and heals, configurable DNS result order (`DNS_RESULT_ORDER`), session affinity cache, client tool aliasing (`read` -> `read_client`, blocked names like `run_code` -> `run_program`) and client parameter aliasing for gate-refused property names (`old_string` -> `old_text`, `new_string` -> `new_text`) with argument restoration on the response path (non-streaming, SSE fragments buffered per tool-call index, and the Responses lane), SSE stream normalization (`reasoning_content`, `usage`, `finish_reason`), 403/426/404 reactive retry loop with 30s IP-cooldown retry suppression (`GATE_RETRY_COOLDOWN_MS`), terminal IP-abuse branch (`X-OpenCode-Gate: ip-abuse`, no refresh/retry), 429 body classification (quota `FreeUsageLimitError` → rotator allowed; model-capacity `RateLimitError` → passthrough verbatim), `GET /api/logs` (admin-guarded incremental window over the in-memory console ring buffer, `LOG_BUFFER_LINES` default 500, GET/HEAD only — feeds the panel's Log bridge tab), egress proxy (`proxy.netFetch` on inference, discovery, and self-update) plus the optional `UPSTREAM_RELAY_URL` relay (`x-relay-target` / `x-relay-path`), and 6-hour self-updater (`checkAndApplyUpdate`), which stages any module the incoming `server.js` requires even when the running `UPDATE_FILES` list predates it.|
| `identity.js` | Adaptive OpenCode CLI synchronization: release handshake (`opencode.ai/update/api`), GitHub source fetcher (`identifier.ts`, `session-id.ts`, `app.ts`, `model-request.ts`, `tool/plugin/*.ts`, `codemode/tool.ts`), Effect Schema AST parser (`extractToolFromSource`), provider catalog parser & disk cache (`~/.opencode-free-bridge/cache/catalog.json`), 30s forced-refresh cooldown (`GATE_REFRESH_COOLDOWN_MS`), terminal `isIpAbuseRejection` guard, and pooled CSPRNG session ID generator (`createSessionId`). |
| `token-budget.js` | Additive token budget calculation (`max(requested, 1024) + 4096` for reasoning models, `max(requested, 512)` for standard models), driven by catalog `modelFacts`. |
| `proxy.js` | Egress: URL validation (HTTP/HTTPS only, percent-encoded credentials), persistence in `<state dir>/proxy.json` (mode `0600`) for both a single proxy and a pool, `UPSTREAM_PROXY_URL`/`UPSTREAM_PROXY_POOL` overrides with panel lock, per-entry health with exponential cooldown (`markFailure`/`markSuccess`/`pick`) persisted in `<state dir>/pool-health.json` (mode `0600`, keyed by a truncated SHA-256 of the egress identity so it never duplicates proxy credentials, written by rename, refusal immediate / success coalesced), `withProxy`/`netFetch` (explicit egress argument) used by every outbound call in `server.js` and `identity.js`, and `testProxy`/`testPool` (upstream probe + `cdn-cgi/trace` exit IP). |
| `egress-proxy.js` | Dependency-free HTTP proxy for turning a host into a pool member: CONNECT plus absolute-URI HTTP, optional `EGRESS_PROXY_TOKEN` (Basic, password only), unauthenticated `/healthz`. Binds loopback by default; reachability is the tunnel's job. Pins `dns.setDefaultResultOrder(DNS_RESULT_ORDER \|\| "ipv4first")`: it dials the upstream itself for every CONNECT, and the gateway refuses IPv6 egress, so on a dual-stack host Bun's default `verbatim` order would tunnel every request out over the refused family. |
| `panel.js` | The HTML panel served at `/`: same-origin form that reads and writes `/api/proxy`, shows live status without credentials, and escapes every config value. A live-summary row of four status cards (gate, egress IP, free models, rotator) polls `/health` every 15 s; a "Log bridge" tab draws the server's in-memory log ring buffer via `/api/logs` with auto-refresh and Copy; rotation history and per-egress usage tables follow the same real-values-only rule. |
| `rotator.js` | Reactive egress rotation (WARP hop): on a quota 429 the bridge runs the operator's `WARP_ROTATE_CMD` (or the panel-configured command in `<state dir>/rotator.json`, mode `0600`; env locks the panel like `UPSTREAM_PROXY_URL`), probes the exit IP through the same egress the requests use (`cdn-cgi/trace` via `proxy.netFetch`; direct only when no egress is configured — the TUN-mode case) until it differs from the pre-rotation address or `WARP_ROTATE_TIMEOUT_MS` (default 45s) elapses, then clears the egress cooldown and retries the request once — the client never sees the 429 when the hop succeeds. Single-flight, inter-rotation cooldown (`WARP_ROTATE_COOLDOWN_MS`, default 75s), and a 20/hour cap; skipped entirely when a ≥2-entry pool is active (the pool walk owns failover) and for 403/ip-abuse (a hop cannot fix a shape problem and only prolongs an abuse penalty). Every attempt — success, command failure, and skip (disabled/cooling/busy/capped) — is recorded in an in-memory history (last 50, surfaced as `history` in `GET /api/rotator` and drawn in the panel) with its trigger (`manual` vs `429`); the command string never appears in history entries. Status: `GET /health` → `egress.rotator`; config/trigger: `GET/POST /api/rotator` (same `adminRequestError` guard as `/api/proxy`, command string is write-only). |
| `tor-control.js` | Minimal Tor control protocol client: connects to the control socket, authenticates with `AUTHENTICATE "password"` or a hex-encoded cookie, sends `SIGNAL NEWNYM` to renew a circuit, and reads the `250` reply. Used by `rotator.js` when `ROTATE_PROVIDER=tor`. Zero dependencies, injectable `connect` for tests. |
| `transport-fingerprint.js` | Captures the runtime's raw TLS `ClientHello` bytes against a local TCP listener and compares cipher suites and extension order against `transport-baseline.json`. |
| `gate-drill.js` | End-to-end self-healing drill suite (4 live drills + 6 deterministic offline drills including `full-corrupt`). |
| `verify.js` | Live model readiness checker (`bun verify.js` / `bun verify.js --quick`); sends `stream: true` and halts immediately on `gate-closed` (`403` with `X-OpenCode-Gate: ip-throttled` or `ip-abuse`, or the free-tier/abuse message) **and on the first `429` allowance** — both mean the sweep must stop so the IP cooldown is not extended. |
| `install.sh` | Cross-platform installer and `node` -> `bun` service unit migrator for Linux (`systemd`) and macOS (`launchd`). |
| `Dockerfile` | Container image for the bridge: pinned `oven/bun:1.4.3-slim` base (the Bun version is pinned because the free-tier gate checks the TLS ClientHello), non-root `bun` user, writable `/app` so the in-place self-updater can stage its temp files, `OPENCODE_CACHE_DIR=/data/cache` for the catalog cache, and `OPENCODE_BRIDGE_STATE_DIR=/data/state` for the panel's proxy setting. |
| `.github/workflows/docker-publish.yml` | Publishes the image to `ghcr.io/luqman-v1/ocb` on every `v*` tag (plus manual `workflow_dispatch`): multi-arch amd64+arm64, semver + `latest` (+ `edge` on manual main builds) tags via `docker/metadata-action`, GHA layer cache, and a final in-image `bun transport-fingerprint.js --check` so the pinned-base guarantee is proven before anyone pulls. Runs with the built-in `GITHUB_TOKEN` (`packages: write`) — no stored secrets. |
| `docker-compose.example.yml` | Deployment example that pairs the GHCR image with a `caomingjun/warp` sidecar (GOST :1080 HTTP+SOCKS5): bridge published on loopback only, both state volumes, `AUTO_UPDATE=0` (pull newer tags instead of in-place self-update), `WARP_ROTATE_CMD` driving the sidecar's re-registration through the Docker API (`host.docker.internal` + dockerd on `127.0.0.1:2375`), sidecar holds `NET_ADMIN` + ipv6 sysctl and its healthcheck verifies `warp=on` through the proxy. |
| `docker-compose.yaml` | Single-service container deployment: restart policy, loopback-only port publish (`127.0.0.1:20129:20129` — the bridge has no auth), persistent `bridge-cache` and `bridge-state` volumes, `no-new-privileges` + `cap_drop: [ALL]`, health check, and `AUTO_UPDATE=0` (the image is the unit of deployment). |
| `.dockerignore` | Keeps `.git`, `.github`, and `test/` out of the build context: a `.git` directory inside the image defeats the self-updater's `git-checkout` guard, and a published image should not carry one. |

### Mandatory verification before committing changes

Any code change in this repository must pass all three checks:

```bash
bun test test/*.test.js
bun transport-fingerprint.js --check
bun gate-drill.js
```
