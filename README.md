# opencode-free-bridge

OpenAI-compatible local API bridge for [OpenCode](https://opencode.ai) free-tier models. No account and no API key required.

It runs a local server on `http://127.0.0.1:20129/v1` that any OpenAI-compatible client (9Router, Cursor, Continue, LiteLLM, Open WebUI, or the OpenAI SDK) can call directly.

## What's New in v2.0.0

- **Bun TLS transport parity:** The official OpenCode CLI ships as a compiled Bun binary, and upstream's free-tier gate inspects the TLS `ClientHello` fingerprint (17 cipher suites and 12 TLS extensions in exact order). The bridge runs on Bun (`bun server.js`), blocks accidental Node.js startups unless `ALLOW_NODE=1` is set for offline tests, and ships `transport-fingerprint.js` to verify TLS parity against `transport-baseline.json`.
- **Full source & catalog derivation:** All hardcoded model tables (`MODEL_MAP`) and model-name substring heuristics have been removed. Client version, commit SHA, session ID recipe (`ses_` + 12 hex + 14 base62), 7 gate headers, 13 tool plugins (parsed from upstream's Effect Schema AST in GitHub source, 12 active per model after `patch` vs `edit`/`write` swap), inference endpoints (`chatUrl` and `responsesUrl`), active free models, shorthand family aliases, and reasoning token limits are derived directly from OpenCode's update API, GitHub repository, and `models.opencode.ai/api.json`.
- **On-disk catalog cache for instant cold starts:** Caches `models.opencode.ai/api.json` at `~/.opencode-free-bridge/cache/catalog.json` and loads it at startup (`OPENCODE_CACHE_DIR=off` disables disk caching). Shorthand aliases (`mimo`, `longcat`, `beam`), deprecated/paid model checks, and reasoning token budgets work on the very first request and when offline.
- **Multi-layer reactive self-healing with IP-cooldown protection:** On `403 FreeTierError`, `426 UpgradeRequired`, or `404` on a migrated endpoint path, the bridge refreshes its recipe and catalog, evicts stale session IDs, mints a fresh session ID, escalates to the full tool profile, and retries once transparently. If a full-shape retry still returns `403 FreeTierError` (indicating a per-IP upstream cooldown rather than a stale request shape), subsequent requests within the 30s cooldown window (`GATE_RETRY_COOLDOWN_MS`, `GATE_REFRESH_COOLDOWN_MS`) skip redundant GitHub fetches and duplicate retries so the bridge never amplifies an IP penalty.
- **Gate anchors, so a shape bug can never masquerade as an IP block:** Upstream returns one `403 FreeTierError` — *"OpenCode's free tier can only be used from within OpenCode"* — for at least four unrelated causes: a refused egress IP, a request without a tool named `read`, a User-Agent that is not `opencode/<channel>/<semver>/<name>`, and a request without a session header. Measured by replaying byte-identical requests from a refused egress and a clean one, varying one field at a time: `read` + 11 fabricated tools → `200`, the real `read` renamed → `403`, a fabricated tool *named* `read` → `200`. The bridge therefore pins those anchors (`GATE_ANCHOR_TOOL_NAMES`, `GATE_ANCHOR_HEADER_NAMES`) independently of what the derived recipe and tool profile contain, audits the outgoing request when a `403` arrives, and reports `X-OpenCode-Gate: shape-rejected` plus the missing anchors instead of blaming the network. Upstream's `x-opencode-log-id` is recorded and exposed at `/health` (`identity.gate.lastRejection`) for correlation.
- **Zero-dead-end universal installer:** `install.sh` finds or installs Bun (and `unzip` when missing on minimal Linux), stages and validates every file before touching a running bridge, retires legacy `opencode-bridge.service` units, rewrites `node` units to `bun`, configures `systemd` (Linux) or `launchd` (macOS), and verifies `/health` and the TLS fingerprint baseline before succeeding.

## Features

- **Self-healing client identity:** Derives the OpenCode CLI wire identity at the current release commit SHA and updates automatically when upstream tightens the gate.
- **Live catalog discovery:** Reads `models.opencode.ai/api.json` (and `/v1/models`) to expose only active free-tier models (`cost.input === 0`, non-deprecated) and reject retired or paid model IDs locally with a clear error.
- **Dual-protocol support:** Routes requests to `/inference/openai/v1/chat/completions` or `/inference/openai/v1/responses` based on catalog metadata and automatic protocol-mismatch detection.
- **Reasoning-aware token budgeting:** Applies an additive token floor (`max(requested, 1024) + 4096`) for reasoning models (determined from catalog `reasoning: true` metadata) so short prompts do not return empty content with `finish_reason: "length"`.
- **Reasoning stream normalization:** Emits thinking tokens under `reasoning_content` for both streaming SSE and non-streaming JSON responses, and forwards client tool calls with automatic name de-collision (`read` -> `read_client` upstream, restored to `read` on return).
- **Zero dependencies:** Uses only built-in runtime modules (`http`, `crypto`, `fs`, `path`, `net`, `tls`). No `npm install` step.

## Requirements: Bun >= 1.0

Bun is required to talk to the live OpenCode gateway. Node.js 18+ can run the offline unit test suite, but upstream rejects Node.js requests with `403 FreeTierError` because Node's OpenSSL TLS `ClientHello` differs from the compiled OpenCode CLI (which is built on Bun/BoringSSL). The installer installs Bun for you when it is missing.

Supported: Linux (systemd) and macOS (launchd). Windows is not supported; use WSL if you need it there.

Measured against a raw TCP listener and the live gateway from the same IP within one minute, using identical headers and payload:

| Property | OpenCode CLI v2.0.32 | Bridge on Bun | Bridge on Node.js |
|---|---|---|---|
| TLS cipher suites offered | 17 | **17 (identical)** | 52 |
| TLS extensions offered | 12 | **12 (identical order)** | 11 (different order) |
| Default `Accept-Encoding` | `gzip, deflate, br, zstd` | **identical** | `gzip, deflate` |
| Live gateway result | `200 OK` | **`200 OK` (6/6)** | `403 FreeTierError` (0/6) |

Starting the server with `node server.js` exits immediately with an explanation so a broken Node deployment cannot fail silently in the background:

```bash
bun server.js                # required for live traffic
node server.js               # exits with code 1 and instructions
ALLOW_NODE=1 node server.js  # starts for offline tests and mocked upstreams only
```

You can verify that your local Bun binary matches the recorded OpenCode CLI TLS baseline at any time:

```bash
bun transport-fingerprint.js --check          # exits 0 if ciphers and extensions match
bun transport-fingerprint.js                  # prints current TLS ClientHello JSON
bun transport-fingerprint.js --write-baseline # updates transport-baseline.json
```

## Install & Update

### One-line installer (Linux & macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/install.sh | bash
```

What `install.sh` does:
1. Finds `bun` across `PATH`, `$BUN_INSTALL/bin`, `~/.bun/bin`, `~/.local/bin`, `/usr/local/bin`, and `/opt/bun/bin`, or installs it via `https://bun.sh/install` (installing `unzip` first on minimal Linux images when needed).
2. Downloads every file into a staging directory and validates it (in-process JS syntax compilation, JSON parsing, and `bash -n` for `tunnel-doctor.sh`) before touching anything that is already running.
3. Checks port availability (`ss` or `lsof`), retires a pre-2.0 `opencode-bridge.service` that would hold port 20129, and stops its own running bridge when upgrading in place.
4. Backs up the previous install under `~/.opencode-free-bridge/.backup-*`, then moves the staged files into place.
5. Registers and starts the background service (`systemd` system or `--user` unit on Linux, `launchd` agent with `~/Library/Logs/opencode-free-bridge.log` on macOS).
6. Waits up to 20 seconds for `/health`, runs the quick self-check, and checks the Bun TLS fingerprint against `transport-baseline.json`.

If the bridge does not answer after 20 seconds, the installer exits with code `1` and prints the exact log inspection command. It only prints `Done.` when the bridge is answering.

Installer options:

```bash
PORT=3000 BINDIR=/opt/opencode-free-bridge bash install.sh
NO_SERVICE=1 bash install.sh   # install files only, skip systemd/launchd setup
```

An occupied port aborts the install before anything is changed. To install alongside an existing service, choose a free port:

```bash
PORT=20130 bash install.sh
```

To update an existing installation, re-run the `curl ... | bash` command above. Running instances outside a git checkout also check for new releases in this repository every 6 hours (`AUTO_UPDATE=0` disables self-update).

### Run from a git clone

```bash
git clone https://github.com/azrinaldi/opencode-free-bridge.git
cd opencode-free-bridge
bun server.js
```

The server listens on `http://127.0.0.1:20129` by default.

## Usage & Client Setup

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:20129/v1` |
| API Key | `public` (any non-empty string is accepted) |
| Model ID | Any ID returned by `GET http://127.0.0.1:20129/v1/models` |

### 9Router

1. Add a custom OpenAI-compatible provider:
   - **Base URL:** `http://127.0.0.1:20129/v1`
   - **API Key:** `public`
   - **Prefix:** `zen`
   - **Model IDs:** leave empty and click **Import from /models endpoint**
2. Models are imported as `zen/big-pickle`, `zen/mimo-v2.6-flash-free`, `zen/nemotron-3-ultra-free`, etc.
3. Optional: if you run the bridge on multiple hosts (for example, a laptop and a VPS), register each host as a separate connection in 9Router so per-IP rate limits fail over automatically.

### LiteLLM, Open WebUI, Continue, Cursor

Use the same three settings: Base URL `http://127.0.0.1:20129/v1`, API key `public`, and model IDs from `/v1/models`.

```yaml
# LiteLLM config.yaml example
model_list:
  - model_name: zen-mimo
    litellm_params:
      model: openai/mimo-v2.6-flash-free
      api_base: http://127.0.0.1:20129/v1
      api_key: public
```

### Coding agents & CLI tools

```bash
export OPENAI_BASE_URL="http://127.0.0.1:20129/v1"
export OPENAI_API_KEY="public"
export MODEL="mimo-v2.6-flash-free"
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:20129/v1", api_key="public")

response = client.chat.completions.create(
    model="mimo-v2.6-flash-free",
    messages=[{"role": "user", "content": "Write a Python palindrome checker."}],
)
print(response.choices[0].message.content)
```

### curl

```bash
curl -s http://127.0.0.1:20129/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"Reply with OK"}]}'
```

## Available Free Models

The model list is derived dynamically from `models.opencode.ai/api.json` (`cost.input === 0` and `status !== "deprecated"`) and cached at `~/.opencode-free-bridge/cache/catalog.json`.

Current active free-tier models in the upstream catalog:

| Model ID | Family Shorthand | Reasoning | Max Output Tokens |
|---|---|---|---|
| `big-pickle` | `big-pickle` | Yes | 32,000 |
| `beam-free` | `beam` | Yes | 131,072 |
| `mimo-v2.6-flash-free` | `mimo` | Yes | 32,000 |
| `nemotron-3-ultra-free` | `nemotron-free` | Yes | 128,000 |
| `nemotron-3.5-lightning-free` | - | Yes | 262,144 |
| `nemotron-3.5-super-vl-free` | - | Yes | 131,072 |
| `longcat-2.5-preview-free` | `longcat` | Yes | 131,072 |
| `deepseek-v4.1-flash-free` | `deepseek-flash` | Yes | 32,000 |
| `glm-5.3-flash-free` | `glm-flash` | Yes | 32,000 |
| `space-bunny-free` | - | Yes | 524,288 |

Query the live list from your running bridge:

```bash
curl -s http://127.0.0.1:20129/v1/models
```

Requests for retired models (such as `cat-jam-free`, `muse-spark-1.3-contributor-free`, or `step-5-preview-free`) or paid models (such as `claude-sonnet-4-5` or `gpt-5.4`) are rejected locally with HTTP `404` and an explanation rather than being forwarded upstream to fail with `401 Missing API key`.

## Reasoning Models & Token Budgets

Reasoning models spend tokens on chain-of-thought before emitting visible text, and both share the same `max_completion_tokens` ceiling. When a client sends a small `max_tokens` (such as `50` or `100` for a health probe or title generator), a reasoning model can exhaust the entire budget while thinking and return an empty string with `finish_reason: "length"`.

`token-budget.js` checks the model's `reasoning` flag from the catalog (`identity.getModelFacts(modelId)`) and applies an additive floor:

| Request Type | Effective `max_completion_tokens` Sent Upstream |
|---|---|
| Catalog `reasoning: true` model (or request with `reasoning_effort` set) | `min(max(requested, 1024) + 4096, modelMaxOutput)` |
| Non-reasoning model | `min(max(requested, 512), modelMaxOutput)` |

The client's requested value is never lowered (unless it exceeds the model's catalog `limit.output` or `131072`).

## How Adaptive Identity & Self-Healing Work

```
Client ──▶ Bridge (:20129, Bun) ──▶ https://opencode.ai/inference/openai/v1/...
                 │
                 ├─ 1. Handshake: opencode.ai/update/api/latest/cli/npm
                 │     -> resolves latest CLI version, minimum floor, and GitHub commit SHA
                 ├─ 2. Source AST parser: raw.githubusercontent.com/anomalyco/opencode/<sha>/...
                 │     -> extracts session ID recipe, UA template, 7 gate headers,
                 │        13 tool plugins (Effect Schema AST), and model-conditional tool swaps
                 ├─ 3. Provider catalog: models.opencode.ai/api.json (cached on disk)
                 │     -> extracts inference endpoints, 10 free models, family aliases,
                 │        deprecated/paid verdicts, and per-model reasoning/output limits
                 └─ 4. On 403 / 426 / 404:
                       -> refreshes recipe + catalog, evicts stale session ID, mints fresh
                          ses_<12hex><14base62> ID, escalates to full tool profile, retries once
                          (throttled for 30s if full-shape retry is still refused by per-IP gate)
```

### What is derived dynamically vs. fixed

| Layer | Source | Fallback if unreachable |
|---|---|---|
| CLI version & minimum floor | `opencode.ai/update/api/latest/cli/npm` (fallback: GitHub `releases.atom`) | `DEFAULT_RECIPE.version` (`2.0.32`) |
| Session ID charset, length, multiplier | `packages/schema/src/identifier.ts` | 62-char base62, length 26, mult `4096` |
| Session ID prefix | `packages/schema/src/session-id.ts` | `ses_` |
| User-Agent template | `packages/core/src/app.ts` | `opencode/${channel}/${version}/${cli}` |
| Required & optional gate headers | `packages/core/src/session/model-request.ts` | 7 core OpenCode headers |
| Tool plugin list & wire allowlist | GitHub tree listing of `packages/core/src/tool/plugin/*.ts` + `codemode/tool.ts` | 13 known plugins (`read`, `shell`, `edit`, etc.) |
| Tool JSON schemas & descriptions | Effect Schema AST parser across plugin `.ts`, sibling `.txt`, and `@opencode/schema/*` | `DEFAULT_TOOLS` (`read`, `shell`) |
| Model-conditional tool swaps (`edit`/`write` vs `patch`) | `packages/core/src/tool/plugin/patch.ts` | `gpt-*` condition rule |
| Inference endpoints (`chatUrl`, `responsesUrl`) | `models.opencode.ai/api.json` (`opencode.api`, validated under `*.opencode.ai`) | `https://opencode.ai/inference/openai/v1/*` |
| Free model list, paid/retired verdicts, family aliases, token limits | `models.opencode.ai/api.json` | `~/.opencode-free-bridge/cache/catalog.json` |

### Inspecting live bridge state

```bash
curl -s http://127.0.0.1:20129/health
```

```json
{
  "status": "ok",
  "provider": "opencode-free-bridge",
  "version": "2.0.0",
  "runtime": "bun/1.4.2",
  "discoveredModels": 10,
  "identity": {
    "userAgent": "opencode/latest/2.0.32/cli",
    "updateMode": "reactive",
    "sourceTag": "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad",
    "versionFloor": null,
    "lastCheckAgeMs": 1240,
    "ttlMs": 900000,
    "lastError": null,
    "release": {
      "version": "2.0.32",
      "sha": "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad",
      "minimum": false,
      "active": true,
      "channel": "latest",
      "source": "update-api",
      "resolvedAt": 1760740000000,
      "stale": false
    },
    "available": null,
    "headers": [
      "x-opencode-session-id",
      "x-session-affinity",
      "X-Session-Id",
      "User-Agent",
      "x-opencode-project",
      "x-opencode-session",
      "x-opencode-client"
    ],
    "unsentHeaders": [],
    "endpoints": {
      "chatUrl": "https://opencode.ai/inference/openai/v1/chat/completions",
      "responsesUrl": "https://opencode.ai/inference/openai/v1/responses",
      "modelsUrl": "https://opencode.ai/inference/v1/models",
      "catalogBase": "https://opencode.ai/inference/openai/v1"
    },
    "toolNames": [
      "read", "shell", "edit", "write", "glob", "grep", "patch",
      "question", "skill", "subagent", "webfetch", "websearch", "execute"
    ],
    "tools": {
      "source": "source",
      "version": "2.0.32",
      "toolNames": [
        "execute", "edit", "glob", "grep", "patch", "question",
        "read", "shell", "skill", "subagent", "webfetch", "websearch", "write"
      ]
    }
  }
}
```

## Testing, Verification & Gate Drills

```bash
bun test                        # 137 offline unit, contract, and regression tests
bun run verify                  # live check: probes every discovered free model
bun run verify:quick            # live check: stops at the first model that answers
bun run drill                   # runs live + offline self-healing gate drills
bun run fingerprint:check       # checks Bun TLS ClientHello against transport-baseline.json
```

`verify.js` exits `0` when a model answers, `2` when the bridge is healthy and its TLS fingerprint matches the baseline but upstream refuses this IP's free-tier allowance, and `1` for a real failure (bridge unreachable, running on Node.js, or TLS fingerprint drift). The `2` case is what a throttled network looks like: the official OpenCode CLI gets the same `403 FreeTierError` from the same IP at the same moment, so it is not a reason to reinstall or edit headers.

`gate-drill.js` deliberately corrupts the bridge's state and verifies that a single client request triggers self-healing and still returns `HTTP 200`:

| Drill | Mode | What it corrupts / stages | What it verifies |
|---|---|---|---|
| `version-floor` | Live | User-Agent version below floor | `426 UpgradeRequired` -> floor learned -> identity refreshed -> retry succeeds |
| `empty-tools` | Live | Empty tool profile | Falls back to shipped tool definitions instead of sending `tools: []` |
| `session-shape` | Live | Unrecognized session ID prefix | `403 FreeTierError` -> recipe refreshed -> old ID evicted -> fresh `ses_...` ID minted |
| `legacy-shape` | Live | Pre-v1.5 request shape | Control check against live upstream |
| `routing` | Offline | `chatUrl` repointed after boot | Endpoints are resolved per request from recipe/catalog, not frozen at boot |
| `allowlist` | Offline | Upstream renames a tool (`shell` -> `run`) | Extracted tool name reaches the wire in `full` scope and retired name is dropped |
| `retry-endpoint` | Offline | `403` gate rejection + catalog URL change | The self-heal retry uses the newly refreshed endpoint URL |
| `endpoint-move` | Offline | `404` on retired endpoint path | Re-reads catalog on `404` and retries at the new path transparently |
| `gate-heal` | Offline | Stale prefix + minimal tool scope | Full heal order: `403` -> refresh -> re-mint session ID -> escalate to full tools -> `200` |
| `full-corrupt` | Offline | Version `0.9.9`, prefix `old_`, length `20`, hex charset, default tools | One client request heals all corrupted layers simultaneously from source and returns `200` |

Before running the 4 live drills, `gate-drill.js` sends a single CLI-shaped control probe. If the current IP is temporarily throttled by upstream (`403 FreeTierError` on the control probe), the 4 live drills report `SKIP` so they do not extend the IP cooldown, while the 6 offline drills still execute and determine the exit code.

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `20129` | HTTP listen port |
| `HOST` | `127.0.0.1` | Bind address (keep on `127.0.0.1` or behind a firewall; the server has no auth) |
| `CORS_ORIGIN` | `""` (localhost only) | Allowed CORS origin(s), comma-separated or `*` |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Upstream fetch timeout in milliseconds |
| `MAX_BODY_BYTES` | `10485760` | Maximum request body size in bytes (10 MiB) |
| `IDENTITY_TTL_MS` | `900000` | Identity freshness TTL in milliseconds (15 minutes) |
| `UPDATE_MODE` | `reactive` | `reactive` adopts new CLI releases only on `403`/`426` or `minimum: true`; `always` adopts every release on TTL expiry |
| `GATE_RETRY_COOLDOWN_MS` | `30000` | Cooldown window (ms) after a failed full-shape `403` retry during which duplicate retries are suppressed until identity changes |
| `GATE_REFRESH_COOLDOWN_MS` | `30000` | Cooldown window (ms) between forced GitHub/catalog refreshes during a `403` burst |
| `DNS_RESULT_ORDER` | `ipv4first` | DNS resolution order passed to `dns.setDefaultResultOrder` (`ipv4first`, `ipv6first`, `verbatim`) |
| `TOOL_PROFILE_SCOPE` | `core` | `core` sends the minimal gate anchor (`read`, `shell`) on first attempt and escalates to `full` (all model-applicable tools) on retry; `full` sends the full tool profile on every request |
| `OPENCODE_CHANNEL` | `latest` | OpenCode release channel (`latest`, `beta`, `dev`) |
| `OPENCODE_MAJOR` | _(unset)_ | Pin a major version line (for example `2`) |
| `OPENCODE_USER_AGENT` | _(derived)_ | Override `User-Agent` and disable dynamic identity derivation |
| `OPENCODE_CATALOG_URL` | `https://models.opencode.ai/api.json` | Provider catalog URL |
| `OPENCODE_CACHE_DIR` | `~/.opencode-free-bridge/cache` | Directory for the on-disk `catalog.json` cache (`off` disables disk caching) |
| `OPENCODE_CHAT_URL` | _(derived)_ | Override the upstream Chat Completions endpoint URL |
| `OPENCODE_RESPONSES_URL` | _(derived)_ | Override the upstream Responses API endpoint URL |
| `AUTO_UPDATE` | `1` | Poll GitHub for bridge updates every 6 hours (automatically skipped inside a `.git` checkout; set `0` to disable) |
| `ALLOW_NODE` | _(unset)_ | Set `ALLOW_NODE=1` to bypass the startup Bun check for offline tests |

## Troubleshooting

### `403 FreeTierError` persists even after retry

When the bridge receives `403 FreeTierError`, it refreshes its recipe from OpenCode's update API and GitHub source tree, re-mints the session ID, escalates to the full tool profile, and retries once.

If that retry also returns `403 FreeTierError` and `/health` shows `"lastError": null` with the current CLI version (for example `opencode/latest/2.0.32/cli`), **your current IP is in a temporary free-tier cooldown upstream**. To prevent extending the penalty, the bridge suppresses duplicate `403` retries and forced GitHub refreshes for `30s` (`GATE_RETRY_COOLDOWN_MS`). Running the official OpenCode CLI binary (`opencode run -m opencode/big-pickle "hi"`) from the same IP at the same moment returns the exact same `403 FreeTierError`. Wait for the per-IP window to reset or route through another host/SSH tunnel.

### `429 RateLimitError` / `BUSY` in `verify.js`

Upstream is throttling the specific model or current IP due to capacity. Try another model ID from `/v1/models`.

### `404 Model '<id>' has been retired upstream`

The model was marked `status: "deprecated"` in `models.opencode.ai/api.json` (for example `cat-jam-free`, `muse-spark-1.3-contributor-free`, or `step-5-preview-free`). Query `curl -s http://127.0.0.1:20129/v1/models` and switch your client to one of the active models.

### `bun: command not found` in a fresh SSH session

The service runs fine, but `curl https://bun.sh/install | bash` only adds
`~/.bun/bin` to an *interactive* shell's PATH. A new non-login SSH session, or a
`sh -c` command, does not see it:

```bash
export PATH="$HOME/.bun/bin:$PATH"     # or use the absolute path
/root/.bun/bin/bun transport-fingerprint.js --check
```

The installer prints the absolute path in its closing summary for this reason.
The service itself is unaffected: its unit file records the full path.

### `remote port forwarding failed for listen port 20136`

The receiving host still has a **stale** listener from a tunnel whose sender rebooted or lost power. The TCP connection died without a FIN, so `sshd` keeps the forwarded port until keepalive notices — ten minutes with the default `ClientAliveInterval 300` × `ClientAliveCountMax 2`. The replacement tunnel then fails even though its own unit is healthy.

```bash
./tunnel-doctor.sh              # which forwards are stale (listener with no SSH transport)
./tunnel-doctor.sh --reap       # kill only the stale sessions
./tunnel-doctor.sh --check      # is the keepalive window short enough?
```

To close the window itself, on the **receiving** host:

```bash
# /etc/ssh/sshd_config.d/00-keepalive.conf   — the 00- prefix matters
ClientAliveInterval 30
ClientAliveCountMax 4        # dead peer detected in 120s
```

OpenSSH uses the **first** value it reads, so a later-sorting file (for example `99-*.conf`) is silently ignored. Verify with `sshd -T | grep -i clientalive` and `systemctl reload ssh`.

### Checking service logs

```bash
# Linux (systemd user or system service)
journalctl --user -u opencode-free-bridge -n 50 --no-pager
journalctl -u opencode-free-bridge -n 50 --no-pager

# macOS (launchd)
tail -50 ~/Library/Logs/opencode-free-bridge.log

# Manual foreground run
bun ~/.opencode-free-bridge/server.js
```

## License

MIT
