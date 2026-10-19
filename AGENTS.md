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

If you are already inside a local clone of this repository, you can also run:

```bash
bash install.sh
```

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
| `HTTP 403 FreeTierError` returned to client **after** logs show `refreshing identity and retrying once with full tool set` or `skipping retry because a full-shape retry already failed <30s ago` (and `verify.js` exits `2` with `GATE`) | **Two distinct causes, one indistinguishable upstream message.** Read the log tail: it now ends with either *"the request carried every anchor the gate checks, so this is the egress"* or *"this bridge produced a shape the gate refuses — missing …"*. The second is a bridge bug, not a quota problem. | **First read the verdict in the log line.** If it says the shape was complete, the egress is refused: do not modify headers or code, run `bun gate-drill.js` and check `upstream control` (`HTTP 403 -> gate CLOSED` means this IP is refused; the official `opencode` CLI fails identically from it). If it names missing anchors, the derived recipe/tool profile lost one — inspect `/health` → `identity.gate.anchors` and `identity.gate.lastRejection`. The bridge suppresses duplicate 403 retries and forced GitHub refreshes for 30s (`GATE_RETRY_COOLDOWN_MS`, `GATE_REFRESH_COOLDOWN_MS`) so it does not extend an IP penalty. |
| `verify.js` exits `1` with `TLS fingerprint drift detected` or `Server is running on Node.js` | The runtime's TLS `ClientHello` does not match `transport-baseline.json` | Run `bun transport-fingerprint.js --check` to inspect cipher/extension differences, and ensure the service runs under a current Bun 1.4+ binary. |
| `bun: command not found` in a fresh SSH session, but the service is healthy | `bun.sh/install` only edits an interactive shell's PATH | Use the absolute path (`~/.bun/bin/bun`) or export `PATH="$HOME/.bun/bin:$PATH"`. Do not reinstall. |
| `HTTP 429` or `BUSY` in `verify.js` | Upstream model capacity limit | Switch to another model ID from `GET /v1/models`. |
| `HTTP 404 Model '<id>' has been retired upstream` | Client requested a deprecated model (e.g. `cat-jam-free`, `muse-spark-*`, `step-5-preview-free`) | Fetch `GET /v1/models` and update the client configuration to use an active model ID. |
| `HTTP 404 Model '<id>' is not on the free tier` | Client requested a paid model (e.g. `gpt-5.4`, `claude-sonnet-4-5`) | The bridge only serves zero-cost models (`cost.input === 0`). Pick a model from `GET /v1/models`. |
| Port conflict (`port 20129 is occupied by another process`) during `install.sh` | Another non-bridge process is listening on port 20129 | Stop the conflicting process or install on another port (`PORT=20130 bash install.sh`). Legacy `opencode-bridge.service` and the bridge's own process are retired/replaced automatically. |

---

## 5. Repository Architecture & Codebase Guide (For Contributors)

| File | Responsibility |
|---|---|
| `server.js` | HTTP server (`/v1/chat/completions`, `/v1/models`, `/health`), Bun runtime guard, configurable DNS result order (`DNS_RESULT_ORDER`), session affinity cache, client tool aliasing (`read` -> `read_client`), SSE stream normalization (`reasoning_content`, `usage`, `finish_reason`), 403/426/404 reactive retry loop with 30s IP-cooldown retry suppression (`GATE_RETRY_COOLDOWN_MS`), and 6-hour self-updater (`checkAndApplyUpdate`). |
| `identity.js` | Adaptive OpenCode CLI synchronization: release handshake (`opencode.ai/update/api`), GitHub source fetcher (`identifier.ts`, `session-id.ts`, `app.ts`, `model-request.ts`, `tool/plugin/*.ts`, `codemode/tool.ts`), Effect Schema AST parser (`extractToolFromSource`), provider catalog parser & disk cache (`~/.opencode-free-bridge/cache/catalog.json`), 30s forced-refresh cooldown (`GATE_REFRESH_COOLDOWN_MS`), and pooled CSPRNG session ID generator (`createSessionId`). |
| `token-budget.js` | Additive token budget calculation (`max(requested, 1024) + 4096` for reasoning models, `max(requested, 512)` for standard models), driven by catalog `modelFacts`. |
| `transport-fingerprint.js` | Captures the runtime's raw TLS `ClientHello` bytes against a local TCP listener and compares cipher suites and extension order against `transport-baseline.json`. |
| `gate-drill.js` | End-to-end self-healing drill suite (4 live drills + 6 deterministic offline drills including `full-corrupt`). |
| `verify.js` | Live model readiness checker (`bun verify.js` / `bun verify.js --quick`); sends `stream: true` and halts immediately on `gate-closed` (`403 FreeTierError`) to avoid extending IP cooldowns. |
| `install.sh` | Cross-platform installer and `node` -> `bun` service unit migrator for Linux (`systemd`) and macOS (`launchd`). |

### Mandatory verification before committing changes

Any code change in this repository must pass all three checks:

```bash
bun test test/*.test.js
bun transport-fingerprint.js --check
bun gate-drill.js
```
