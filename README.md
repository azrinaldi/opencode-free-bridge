# opencode-free-bridge

OpenAI/Anthropic-compatible local API bridge for [OpenCode](https://opencode.ai) free-tier models. No account and no API key required.

It runs a local server on `http://127.0.0.1:20129/v1` that any OpenAI-compatible client (9Router, Cursor, Continue, LiteLLM, Open WebUI, or the OpenAI SDK) can call directly.

## What's New in v2.0.0

- **Bun TLS transport parity:** The official OpenCode CLI ships as a compiled Bun binary, and upstream's free-tier gate inspects the TLS `ClientHello` fingerprint (17 cipher suites and 12 TLS extensions in exact order). The bridge runs on Bun (`bun server.js`), blocks accidental Node.js startups unless `ALLOW_NODE=1` is set for offline tests, and ships `transport-fingerprint.js` to verify TLS parity against `transport-baseline.json`.
- **Full source & catalog derivation:** All hardcoded model tables (`MODEL_MAP`) and model-name substring heuristics have been removed. Client version, commit SHA, session ID recipe (`ses_` + 12 hex + 14 base62), 7 gate headers, 13 tool plugins (parsed from upstream's Effect Schema AST in GitHub source, 12 active per model after `patch` vs `edit`/`write` swap), inference endpoints (`chatUrl` and `responsesUrl`), active free models, shorthand family aliases, and reasoning token limits are derived directly from OpenCode's update API, GitHub repository, and `models.opencode.ai/api.json`.
- **On-disk catalog cache for instant cold starts:** Caches `models.opencode.ai/api.json` at `~/.opencode-free-bridge/cache/catalog.json` and loads it at startup (`OPENCODE_CACHE_DIR=off` disables disk caching). Shorthand aliases (`mimo`, `longcat`, `beam`), deprecated/paid model checks, and reasoning token budgets work on the very first request and when offline.
- **Multi-layer reactive self-healing with IP-cooldown protection:** On `403 FreeTierError`, `426 UpgradeRequired`, or `404` on a migrated endpoint path, the bridge refreshes its recipe and catalog, evicts stale session IDs, mints a fresh session ID, escalates to the full tool profile, and retries once transparently. If a full-shape retry still returns `403 FreeTierError` (indicating a per-IP upstream cooldown rather than a stale request shape), subsequent requests within the 30s cooldown window (`GATE_RETRY_COOLDOWN_MS`, `GATE_REFRESH_COOLDOWN_MS`) skip redundant GitHub fetches and duplicate retries so the bridge never amplifies an IP penalty. **Exception:** the gateway's explicit IP-level abuse block (*"detected abusive traffic from this IP address"* / `Detect Abuse Traffic`) is terminal — the bridge answers it verbatim with `X-OpenCode-Gate: ip-abuse` and performs no refresh, session re-mint, or retry, because no client-side change can clear a flag keyed to the egress network.
- **Gate anchors, so a shape bug can never masquerade as an IP block:** Upstream returns one `403 FreeTierError` — *"OpenCode's free tier can only be used from within OpenCode"* — for at least four unrelated causes: a refused egress IP, a request without a tool named `read`, a User-Agent that is not `opencode/<channel>/<semver>/<name>`, and a request without a session header. Measured by replaying byte-identical requests from a refused egress and a clean one, varying one field at a time: `read` + 11 fabricated tools → `200`, the real `read` renamed → `403`, a fabricated tool *named* `read` → `200`. The bridge therefore pins those anchors (`GATE_ANCHOR_TOOL_NAMES`, `GATE_ANCHOR_HEADER_NAMES`) independently of what the derived recipe and tool profile contain, audits the outgoing request when a `403` arrives, and reports `X-OpenCode-Gate: shape-rejected` plus the missing anchors instead of blaming the network. A second, unambiguous message (*"detected abusive traffic from this IP address"* or `Detect Abuse Traffic`) identifies a network-level block and is answered immediately as `ip-abuse`; only the ambiguous free-tier message goes through the shape audit at all. Upstream's `x-opencode-log-id` is recorded and exposed at `/health` (`identity.gate.lastRejection`) for correlation.
- **Zero-dead-end universal installer:** `install.sh` finds or installs Bun (and `unzip` when missing on minimal Linux), stages and validates every file before touching a running bridge, retires legacy `opencode-bridge.service` units, rewrites `node` units to `bun`, configures `systemd` (Linux) or `launchd` (macOS), and verifies `/health` and the TLS fingerprint baseline before succeeding.

## Features

- **Self-healing client identity:** Derives the OpenCode CLI wire identity at the current release commit SHA and updates automatically when upstream tightens the gate.
- **Live catalog discovery:** Reads `models.opencode.ai/api.json` (and `/v1/models`) to expose only active free-tier models (`cost.input === 0`, non-deprecated) and reject retired or paid model IDs locally with a clear error.
- **Dual-protocol support:** Routes requests to `/inference/openai/v1/chat/completions` or `/inference/openai/v1/responses` based on catalog metadata and automatic protocol-mismatch detection.
- **Reasoning-aware token budgeting:** Applies an additive token floor (`max(requested, 1024) + 4096`) for reasoning models (determined from catalog `reasoning: true` metadata) so short prompts do not return empty content with `finish_reason: "length"`.
- **Reasoning stream normalization:** Emits thinking tokens under `reasoning_content` for both streaming SSE and non-streaming JSON responses, and forwards client tool calls with automatic name de-collision (`read` -> `read_client` upstream, restored to `read` on return).
- **Zero dependencies:** Uses only built-in runtime modules (`http`, `crypto`, `fs`, `path`, `net`, `tls`). No `npm install` step.
- **Container deployment:** Ships a `Dockerfile` and `docker-compose.yaml` (contributed in PR #1 by @rustam76, completed in v2.1.0). The image pins `oven/bun:1.4.3-slim` — the Bun version is pinned because the free-tier gate inspects the TLS `ClientHello` — runs as the non-root `bun` user, and publishes the port on loopback only.

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

`bash install.sh` inside the clone installs that working tree (including
uncommitted or unpushed files) instead of downloading from GitHub. Force a
download with `SOURCE=remote bash install.sh`.

The server listens on `http://127.0.0.1:20129` by default.
Open `http://127.0.0.1:20129/` for the panel: a live-summary dashboard (four
status cards — upstream gate status, the egress IP upstream sees, active
free-model count, rotator state — plus today's per-egress traffic, refreshed
every 15 s), a "Log bridge" tab (the last 500 console lines from memory,
auto-refreshed — full history stays with journald / docker logs), the live
egress state, and the form that sets an HTTP proxy for every outbound request.
See [Egress proxy](#egress-proxy).

### Docker

A prebuilt image is published to GHCR on every version tag (multi-arch:
`linux/amd64` + `linux/arm64`), built by GitHub Actions with the pinned
`oven/bun:1.4.3-slim` base and the TLS fingerprint verified inside the image
before push. No Docker build on your host is needed:

```bash
docker pull ghcr.io/luqman-v1/ocb:latest
```

Tags: `latest` (newest tagged release), `2.4.0` / `2.4` (semver, per release),
`edge` (main-branch builds via manual workflow dispatch). The first `docker
pull` may need the package made public once: after the workflow runs, open
`https://github.com/luqman-v1?tab=packages`, select `ocb`, *Package settings*
→ *Change visibility* → *Public* (or `docker login ghcr.io` with a PAT that
has `read:packages` to stay private).

The repository ships a `Dockerfile` and a `docker-compose.yaml` for container
deployments (single host, no orchestrator needed):

```bash
git clone https://github.com/luqman-v1/ocb.git
cd ocb
docker compose up -d
```

A ready-made deployment example — the bridge from GHCR plus the
[`caomingjun/warp`](https://github.com/cmj2002/warp-docker) sidecar as a
hoppable egress, wired for the reactive WARP rotation — lives in
[`docker-compose.example.yml`](docker-compose.example.yml):

```bash
curl -fsSL https://raw.githubusercontent.com/luqman-v1/ocb/main/docker-compose.example.yml -o docker-compose.yml
docker compose up -d
# then open http://127.0.0.1:20129/ and set the egress to http://warp:1080
```

The bridge is then reachable at `http://127.0.0.1:20129/v1` (API key `public`),
exactly like a native install, and the model catalog cache survives restarts in
the `bridge-cache` volume.

What the container setup does:

- Runs on `oven/bun:1.4.3-slim` as the non-root `bun` user. The Bun version is
  pinned because the free-tier gate inspects the TLS ClientHello: the image
  must produce the same fingerprint as the OpenCode CLI, which
  `transport-baseline.json` records.
- Publishes the port on **loopback only**. The bridge has no authentication
  (the API key is literally `public`), so publishing on `0.0.0.0` would expose
  an open relay to the whole network. For remote access, put a reverse proxy
  or an SSH tunnel in front of it.
- Persists the on-disk catalog cache in the `bridge-cache` volume
  (`OPENCODE_CACHE_DIR=/data/cache`), so a restart does not re-fetch the
  upstream model catalog.
- Persists the panel's egress-proxy setting in the `bridge-state` volume
  (`OPENCODE_BRIDGE_STATE_DIR=/data/state`). Without it, the container
  filesystem is thrown away on recreate and the proxy would silently revert.
- Runs with `no-new-privileges` and all Linux capabilities dropped.

The image is the unit of deployment, so `AUTO_UPDATE` defaults to `0` in the
compose file: an in-place self-update is reverted by the next
`docker compose build`. Upgrade with:

```bash
docker compose build --pull && docker compose up -d
```

Plain `docker run` works too — set `HOST=0.0.0.0` and publish the port
yourself:

```bash
docker run -d --name opencode-free-bridge \
  -p 127.0.0.1:20129:20129 \
  -e OPENCODE_CACHE_DIR=/data/cache \
  -e OPENCODE_BRIDGE_STATE_DIR=/data/state \
  -v opencode-free-bridge-cache:/data/cache \
  -v opencode-free-bridge-state:/data/state \
  ghcr.io/luqman-v1/ocb:latest
```

Or build the image yourself from the checkout:

```bash
docker build -t opencode-free-bridge .
docker run -d --name opencode-free-bridge \
  -p 127.0.0.1:20129:20129 \
  -e OPENCODE_CACHE_DIR=/data/cache \
  -e OPENCODE_BRIDGE_STATE_DIR=/data/state \
  -v opencode-free-bridge-cache:/data/cache \
  -v opencode-free-bridge-state:/data/state \
  opencode-free-bridge
```

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

**9Router's SSRF guard blocks `127.0.0.1` by default.** The guard exists so a
request cannot reach an internal address, and the bridge's own base URL looks
exactly like one. Two ways through, depending on how 9Router was started:

| 9Router started… | What to do |
|---|---|
| With `ALLOW_PRIVATE_NETWORKING=true` | Nothing. The guard short-circuits for the whole process, so loopback works as documented above. |
| Without it | Add `ALLOW_PRIVATE_NETWORKING=true` to its service environment and restart. |

Symptom without it: the connection's test button fails and chat answers an
error, both reporting `request to private/reserved IP blocked by SSRF
protection`. The bridge itself is fine — `curl http://127.0.0.1:20129/health`
still answers `ok` from that host, so those two symptoms together mean the
guard, not the bridge.

This only applies to 9Router running on the same machine. Every other client
(LiteLLM, the OpenAI SDK, Cursor) talks to loopback directly and is unaffected.

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

### Anthropic Messages API

The bridge also serves Anthropic's native `POST /v1/messages`, so Claude Code and
the Anthropic SDK can point at it directly. Model ids are the same bare ids the
OpenAI endpoint uses.

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:20129` |
| API key | `public` (sent as `x-api-key`, any non-empty string works) |
| Path | `/v1/messages` |

```bash
curl -s http://127.0.0.1:20129/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: public' \
  -d '{"model":"big-pickle","max_tokens":1024,
       "messages":[{"role":"user","content":"Reply with OK"}]}'
```

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:20129", api_key="public")
message = client.messages.create(
    model="big-pickle",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Reply with OK"}],
)
print(message.content[0].text)
```

Streaming is real, not replayed: `stream: true` relays each upstream delta as it
arrives, including `input_json_delta` for tool calls. `POST
/v1/messages/count_tokens` also answers — with a conservative 4-chars-per-token
estimate, because this bridge has no Anthropic tokenizer and a made-up exact
number would be worse than an honest approximation.

Anthropic-only parameters with no OpenAI equivalent — `thinking`, `top_k`,
`metadata`, `container` — are ignored, and the bridge logs one line naming them
so a caller that expected a thinking budget can see why it got none.

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
bun test                        # 165 offline unit, contract, and regression tests
bun run verify                  # live check: probes every discovered free model
bun run verify:quick            # live check: stops at the first model that answers
bun run drill                   # runs live + offline self-healing gate drills
bun run fingerprint:check       # checks Bun TLS ClientHello against transport-baseline.json
```

`verify.js` exits `0` when a model answers, `2` when the bridge is healthy and its TLS fingerprint matches the baseline but upstream refuses this IP (free-tier allowance or an explicit abuse block), and `1` for a real failure (bridge unreachable, running on Node.js, or TLS fingerprint drift). The `2` case is what a throttled or flagged network looks like: the official OpenCode CLI gets the same `403 FreeTierError` from the same IP at the same moment, so it is not a reason to reinstall or edit headers. The bridge labels the refusal (`X-OpenCode-Gate: ip-throttled | ip-abuse | shape-rejected`), so `verify.js` no longer depends on upstream keeping identical wording.

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
| `DNS_RESULT_ORDER` | `ipv6first` (`server.js`), `ipv4first` (`egress-proxy.js`) | Resolution order passed to `dns.setDefaultResultOrder` (`ipv4first`, `ipv6first`, `verbatim`). The bridge prefers AAAA so WARP inference rides the rotating IPv6 address; the sidecar proxy keeps its own `ipv4first` default because that upstream path refuses IPv6 egress |
| `TOOL_PROFILE_SCOPE` | `core` | `core` sends the minimal gate anchor (`read`, `shell`) on first attempt and escalates to `full` (all model-applicable tools) on retry; `full` sends the full tool profile on every request |
| `OPENCODE_CHANNEL` | `latest` | OpenCode release channel (`latest`, `beta`, `dev`) |
| `OPENCODE_MAJOR` | _(unset)_ | Pin a major version line (for example `2`) |
| `OPENCODE_USER_AGENT` | _(derived)_ | Override `User-Agent` and disable dynamic identity derivation |
| `OPENCODE_CATALOG_URL` | `https://models.opencode.ai/api.json` | Provider catalog URL |
| `OPENCODE_CACHE_DIR` | `~/.opencode-free-bridge/cache` | Directory for the on-disk `catalog.json` cache (`off` disables disk caching) |
| `OPENCODE_CHAT_URL` | _(derived)_ | Override the upstream Chat Completions endpoint URL |
| `OPENCODE_RESPONSES_URL` | _(derived)_ | Override the upstream Responses API endpoint URL |
| `UPSTREAM_RELAY_URL` | _(unset)_ | Route inference through an egress relay (`x-relay-target` / `x-relay-path` contract); empty = direct. See [Optional egress relay](#optional-egress-relay) |
| `UPSTREAM_PROXY_URL` | _(unset)_ | Operator-level default for the egress proxy (`http://[user:pass@]host:port`). When set it wins over the panel and locks runtime edits. See [Egress proxy](#egress-proxy) |
| `PANEL_ALLOWED_HOSTS` | _(unset)_ | Extra `Host` names the panel and `/api/proxy` accept (comma-separated), for a reverse proxy in front of the bridge. Loopback names and the configured `HOST` are always accepted |
| `WARP_ROTATE_CMD` | _(unset)_ | Command run once on a quota 429 (`FreeUsageLimitError`; capacity 429s pass through) to change the egress IP (WARP reconnect / hop CLI). When set it wins over the panel and locks runtime edits. See [Reactive egress rotation](#reactive-egress-rotation-warp-hop-on-429) |
| `ROTATION_INEFFECTIVE_LIMIT` | `3` | Consecutive quota-429 rotations whose fresh address is refused again before the reactive rotator parks itself (answers 429 without hopping). A manual rotation resets the counter. |
| `QUOTA_PLAIN_RETRIES` | `1` | Retries of a quota 429 on the same egress before the bridge considers rotating. Conservative default: a spent allowance rarely clears on a second dial, and each retry costs time. |
| `QUOTA_MAX_ROTATIONS` | `5` | Maximum egress rotations in one request after the plain retries are exhausted. After this cap the client gets an explicit `quota_recovery_exhausted` error. Live testing showed 1-3 hops often find an address with allowance; 5 leaves headroom without the old 10-hop cost. |
| `QUOTA_RETRY_DELAY_MS` | `1500` | Wait between plain retries on the same IP. |
| `QUOTA_ROTATION_SETTLE_MS` | `6000` | Wait for the WARP tunnel to report Connected/healthy after a hop before resending; this avoids the `ECONNRESET` of a dial during the disconnect window. |
| `LOG_BUFFER_LINES` | `500` | Size of the in-memory log ring buffer served to the panel's Log bridge tab (`/api/logs`). Oldest lines fall off; the full history remains with the service manager (journald, docker logs, or the foreground terminal). |
| `WARP_ROTATE_TIMEOUT_MS` | `45000` | Whole-rotation deadline: command run + exit-IP polling. The original 429 passes through when the IP has not changed by then |
| `WARP_ROTATE_COOLDOWN_MS` | `75000` | Minimum gap between two rotations (manual or reactive), protecting the tunnel from hop storms |
| `WARP_ROTATE_PROBE_URL` | `https://www.cloudflare.com/cdn-cgi/trace` | IP-echo endpoint polled during a rotation; probed through the pinned proxy when one is configured, direct otherwise (TUN mode) |
| `ROTATE_PROVIDER` | `warp` | Rotation provider: `warp` (run a hop command) or `tor` (send `SIGNAL NEWNYM` to the Tor control port). Env locks the panel. |
| `TOR_CONTROL_HOST` | `127.0.0.1` | Tor control host for `SIGNAL NEWNYM` |
| `TOR_CONTROL_PORT` | `9051` | Tor control port |
| `TOR_CONTROL_PASSWORD` | _(unset)_ | Password for Tor `AUTHENTICATE` (quoted in the protocol). Env locks the panel. |
| `TOR_CONTROL_COOKIE` | _(unset)_ | Path to Tor's `control_auth_cookie` file; bytes are hex-encoded for `AUTHENTICATE`. Env locks the panel. |
| `AUTO_UPDATE` | `1` | Poll GitHub for bridge updates every 6 hours (automatically skipped inside a `.git` checkout; set `0` to disable) |
| `ALLOW_NODE` | _(unset)_ | Set `ALLOW_NODE=1` to bypass the startup Bun check for offline tests |

### Optional egress relay

Set `UPSTREAM_RELAY_URL` to a relay that speaks the same contract as 9Router's
Cloudflare/Vercel/Deno/Netlify relays. The bridge POSTs to the relay with
`x-relay-target: <origin>` and `x-relay-path: <path>`, and the relay replays the
request at that origin; upstream therefore sees the relay's egress IP.

```bash
UPSTREAM_RELAY_URL="https://relay.example.workers.dev" bun server.js
```

The relay covers inference requests and their retries; model discovery and
identity synchronization stay direct. `/health` reports `egress.mode` (`direct`
or `relay`) and the relay's origin, without credentials or query strings. Use a
trusted HTTPS relay: it receives the request headers (including
`Authorization: Bearer public`) and the full prompt. Changing the variable
requires a restart.

### Egress proxy

Open `http://127.0.0.1:20129/` and enter an HTTP proxy. Every outbound request
the bridge makes then tunnels through it (`CONNECT`), so upstream sees the
proxy's IP rather than this machine's. That covers inference, model discovery,
identity sync, and the self-updater.

- **Protocol:** `http://` and `https://` only. Bun's fetch accepts those and
  tunnels TLS itself, so `transport-baseline.json` still matches. SOCKS5 is
  refused by Bun (`UnsupportedProxyProtocol`) and rejected in the panel with
  that reason.
- **Credentials:** `http://user:pass@host:port`, percent-encoded if they contain
  `@`, `:`, or `/`. They are stored in `~/.opencode-free-bridge/proxy.json`
  (mode `0600`) and never returned by the panel, `/api/proxy`, or `/health`;
  those show `host:port` only.
- **Test before trusting it:** *Uji koneksi* fetches the models endpoint through
  the candidate proxy and reports the exit IP from `cdn-cgi/trace`. A 403 there
  means the proxy reaches upstream but its egress is refused.
- **No restart:** the setting is read on every request. *Matikan proxy* returns
  to direct egress.
- **Operator override:** `UPSTREAM_PROXY_URL` beats the panel and locks runtime
  edits to it.
- **Only from this machine:** the panel and `/api/proxy` accept `Host` names of
  loopback (or the configured bind address) plus anything in
  `PANEL_ALLOWED_HOSTS`, reject cross-site requests, and require
  `Content-Type: application/json` for writes. That blocks a random website from
  re-pointing your egress and blocks DNS rebinding. Put a reverse proxy in front
  and add its name to `PANEL_ALLOWED_HOSTS` if you reach the panel that way.
- **Container:** the compose file mounts the `bridge-state` volume at
  `/data/state` (`OPENCODE_BRIDGE_STATE_DIR`) so the setting survives a
  recreate. Plain `docker run` needs that env var and volume too.

### Egress pool

The free-tier allowance is per egress IP, not per account. Running one bridge
per host multiplies processes, service units and tunnels without giving anything
a pool does not: the pool rotates the egress while one process keeps the
identity, the catalog and the session cache in one place.

A pool is a list of egress entries. Each keeps its own health, so an entry that
upstream throttles is skipped until its cooldown ends instead of being retried
by every request.

```bash
# in the panel under "Pool egress", one entry per line
med1=http://pool:token@127.0.0.1:20251
med2=http://pool:token@127.0.0.1:20252
```

```bash
# operator override: comma- or newline-separated, label=url optional
UPSTREAM_PROXY_POOL="med1=http://a:1,med2=http://b:2" \
UPSTREAM_PROXY_STRATEGY=failover \
  bun server.js
```

- **Entry shape:** a URL string, `{id,label,url,enabled,weight}`, or
  `{direct: true}` for this machine's own address. `direct` is a first-class
  entry, so the hosting IP can take part in the rotation instead of being the
  fallback used only when every proxy is down.
- **Strategies:** `round-robin` (default; even spread across healthy entries),
  `failover` (sticky on the first healthy entry, which keeps upstream prompt
  caching on one IP), `random` (weighted).
- **Cooldown:** a refusal on a pooled egress is recorded against *that* entry.
  The backoff doubles per consecutive failure from `cooldownMs` (default 120 s)
  up to `maxCooldownMs` (default 30 min); a success resets it. A `429` earns four
  times the base window because it is an unambiguous allowance answer.
- **Always sends:** when every entry is cooling, the one that recovers first is
  used anyway. Refusing would turn a throttled pool into a dead bridge, and
  upstream answers a throttled IP with a normal refusal the caller already
  handles.
- **Failover on a gate rejection:** the bridge drops the entry that was refused
  and retries through a different one, in the same request. An unreachable proxy
  is also failed over, since nothing reached upstream.
- **One egress per request:** the protocol-lane, endpoint-migration, 5xx and
  gate retries all reuse the entry the request started on, because upstream ties
  a retry to the address that saw the first attempt. Only the two cases above
  move it.
- **`/health`** reports `egress.mode: "pool"` and `egress.proxy.pool` with each
  entry's host, state, remaining cooldown and failure count. Credentials are
  never included.

#### Health across restarts

Cooldowns are written to `<state dir>/pool-health.json` (mode `0600`), so a
service restart or a host suspend/resume does not forget which IPs are spent and
re-burn all of them.

- A refusal is written immediately; a success is coalesced over one second,
  because a success arrives with every request and a rewrite per request would
  turn a memory update into disk churn.
- The file is written by rename, so a crash mid-write keeps the previous copy
  instead of leaving a truncated one that would cost every cooldown.
- Records are keyed by a truncated SHA-256 of the egress identity, not by URL,
  so the file is not a second copy of the proxy credentials. A `label` field
  carries `host:port` (or `direct`), which `/health` already exposes.
- Saving the pool in the panel keeps existing cooldowns; only an entry that
  leaves the pool loses its record.
- A corrupt or missing health file costs the cooldowns and nothing else: the
  bridge starts, reports the pool from `proxy.json`, and treats every entry as
  ready.

#### Turning a host into a pool member

`egress-proxy.js` is a dependency-free HTTP proxy for exactly this: it answers
`CONNECT` and absolute-URI HTTP, and forwards bytes without inspecting them.
Its TLS is tunneled end to end, so it never sees plaintext.

```bash
# on the node
PORT=8888 EGRESS_PROXY_TOKEN=secret bun egress-proxy.js

# from the bridge host: put it on a loopback port, so the proxy itself is never
# exposed and the tunnel carries the authentication
ssh -L 127.0.0.1:20251:127.0.0.1:8888 node
```

`/healthz` is unauthenticated on purpose: it reports a connection count and an
uptime, nothing about the target or the token, so a monitor does not need the
credential to ask whether the proxy is up.

`/health` reports `egress.mode` (`pool`, `proxy`, `relay`, or `direct`) plus
`egress.proxy` with the same credential-free description.

The proxy applies *in addition to* the relay: with both configured, the request
is still sent to `UPSTREAM_RELAY_URL`, and that connection is dialled through
the proxy.

### Testing models from the panel

The *Ringkasan* tab lists every model currently advertised by `/v1/models`.
Each row has an **Uji** button that sends one short `Reply with OK` prompt
through the bridge's own chat route, so the probe uses the real gate anchors,
session identity, egress proxy/pool and rotator. Results are shown inline:
`ok`, rate limit, gate refusal, empty response, or failure. Only active free
models can be probed; the endpoint `POST /api/models/test` is admin-guarded and
shares one in-flight probe per model.

### Reactive egress rotation (WARP / Tor hop on 429)

A pool needs several egress *URLs*. A WARP-style tunnel instead changes the
address *behind* one URL (or no URL at all, in TUN mode): reconnecting the
tunnel yields a fresh `/64` allocation. When you configure a rotate command, the
bridge uses it on a capacity `429` — the one status that means *transport and
request shape passed, only this IP's allowance is spent*:

```bash
# configure once (or use the panel section "Rotator egress (WARP hop)")
curl -s http://127.0.0.1:20129/api/rotator \
  -H "Content-Type: application/json" \
  -d '{"command":"warp-cli disconnect && warp-cli connect"}'

# trigger a hop manually
curl -s http://127.0.0.1:20129/api/rotator \
  -H "Content-Type: application/json" \
  -d '{"rotate":true}'

# watch what the last hop did
curl -s http://127.0.0.1:20129/health | jq .egress.rotator
```

On a 429 the bridge runs the command once, polls the exit IP
(`https://www.cloudflare.com/cdn-cgi/trace` by default). Only the *quota* kind
of 429 reaches the rotator: upstream answers both a spent per-IP allowance
(`FreeUsageLimitError`) and a busy model (`RateLimitError "Endpoint is
unavailable"`) with the same status, but no IP makes a busy model less busy,
so the body is classified first and capacity 429s pass through untouched.
The probe leaves
through the *same egress the requests use*: with a single proxy configured
it goes through that proxy (`proxy.netFetch`); with none it goes direct —
the TUN-mode case, where "direct" already leaves through WARP. When the
address actually changed, the bridge clears the egress cooldown and replays
the request once — the client sees 200 and never the 429. If the IP has not
changed within `WARP_ROTATE_TIMEOUT_MS` (default 45 s), the original 429
passes through with upstream's `Retry-After`.

- **Env overrides:** `WARP_ROTATE_CMD` (locks the panel, like
  `UPSTREAM_PROXY_URL`), `WARP_ROTATE_TIMEOUT_MS`, `WARP_ROTATE_COOLDOWN_MS`
  (default 75 000 ms between hops), `WARP_ROTATE_PROBE_URL`.
- **Guard rails:** one rotation per request, single-flight, 20 hops/hour, and a
  skip when a ≥2-entry pool is active (the pool walk already changes IP without
  a hop). 403/ip-abuse refusals are never hopped on — a rotation cannot fix a
  shape problem and hopping only prolongs an IP penalty.
- **History:** every attempt — hop, command failure, and skip with its reason —
  is kept in memory (last 50), exposed as `history` in `GET /api/rotator`, and
  drawn under the rotator form in the panel (newest first, `manual` vs `429`
  tag, `fromIp → toIp` or the failure reason). In-memory only: it resets on
  restart, and the command string never appears in entries.
- **Config:** `<state dir>/rotator.json`, mode `0600`. The command string is
  write-only: the panel, `/api/rotator` and `/health` report *that* one exists,
  never *what* it is.

#### Tor circuit rotation

Set `ROTATE_PROVIDER=tor` to renew a Tor circuit instead of running a WARP hop.
Tor exposes a SOCKS proxy, which Bun's `fetch` cannot use directly, so the
bridge's egress must still be an **HTTP proxy in front of Tor** (Privoxy,
torsocks+HTTP, or a GOST `socks5→http` bridge). The rotator connects to Tor's
control port (default `127.0.0.1:9051`), authenticates with a password or cookie
file, sends `SIGNAL NEWNYM`, then polls the exit IP through the same egress. A
command may also be configured; when both are set, the command runs first and
the control signal follows. At least one is required.

```bash
# local Tor daemon with password auth
curl -s http://127.0.0.1:20129/api/rotator \
  -H "Content-Type: application/json" \
  -d '{"provider":"tor","controlHost":"127.0.0.1","controlPort":9051,"controlPassword":"secret"}'

# or via environment (locks the panel):
#   ROTATE_PROVIDER=tor TOR_CONTROL_PASSWORD=secret
```

A new circuit can reuse the same exit IP, especially with a small guard set.
The bridge follows the same rule as WARP: success means the probed IP actually
changed; otherwise the original 429 passes through. Cookie auth reads
`TOR_CONTROL_COOKIE` as a file path and sends the bytes hex-encoded. Both
credentials are write-only, stored in `rotator.json` with mode `0600`, and
never echoed by `/health` or the panel.

#### Verified behaviors (live warp-cli testing, Windows host)

Measured on a real WARP+ client (Unlimited account, Windows 10), so the notes
below are observed facts, not guesses:

- **The rotate command must run through a shell and wait.** `execFile` uses the
  shell, so `cmd1 && cmd2` works; append `sleep 4` (or `timeout /t 4
  /nobreak >nul` in cmd, but note Git-Bash `sleep` if the bridge inherits that
  PATH) so the probe's first poll does not race the reconnect. A hop was
  verified end-to-end in ~6 s with `warp-cli disconnect && warp-cli connect &&
  sleep 4`.
- **IPv4 egress is pinned per account; IPv6 /64 rotates per handshake (MASQUE).**
  Across many disconnect/connect cycles the v4 echo returned the same
  `104.28.x.x` every time, while the v6 address rotated /64s
  (`2a09:bac1::/64 ↔ 2a09:bac5::/64`). Consequence: **probe an IPv6-reachable
  endpoint** (e.g. `https://ipv6.icanhazip.com`) — the default
  `cdn-cgi/trace` may answer over either family, which the rotator now guards
  against (same-family comparison; a v4→v6 flip is never counted as a hop).
- **Protocol decides whether a hop changes the address at all.** With
  **MASQUE** (the client default) each reconnect allocates a fresh /64 — a
  real hop. With **WireGuard** the device address is pinned and five reconnect
  cycles in a row produced the identical v6 address — a no-op hop. Verify your
  protocol with `warp-cli tunnel stats`; force MASQUE with
  `warp-cli tunnel protocol set MASQUE` (the switch itself drops the tunnel;
  `warp-cli connect` afterwards).
- **A dead egress proxy starves the probe.** While a stale proxy was pinned in
  the panel, every probe failed ("Unable to connect") and the rotation timed
  out even though the hop itself had succeeded — the probe rides the egress by
  design, so check `/health` → `egress.mode` first when a rotation "never"
  observes a change.
- **Bare-address probe bodies are accepted.** `ip=…` (cdn-cgi/trace), JSON
  `{"ip":"…"}`, and bare single-line echoes (`icanhazip.com` and friends) all
  parse; anything else is rejected with a parse error rather than guessed.
- **The hop drops in-flight requests through the tunnel.** Disconnecting the
  tunnel resets every socket mid-flight, so concurrent client requests die with
  `ECONNRESET`, and fresh dials while the tunnel is down fail with
  `ConnectionRefused`. The bridge classifies both as expected rotator behavior:
  one warn line in the log, and the client gets `503` with `Retry-After: 10`
  instead of a generic `500`. The same errors while the rotator is *idle* are
  real transport faults.
- **The rotator parks itself when hops stop working.** If the WARP pool hands
  out only addresses upstream refuses (the measured case: a `/64` pool shared
  with many WARP users is collectively quota-spent), every hop costs ~9s of
  tunnel churn plus the ~10s dead window and buys nothing. After
  `ROTATION_INEFFECTIVE_LIMIT` (default 3, env-tunable) consecutive rotations
  whose fresh address is refused again, the reactive hook parks: quota 429s are
  answered directly (with the upstream `Retry-After`) instead of hopping.
  `/health` reports the counter as `egress.rotator.rotationIneffective`; a
  manual rotation (panel or `POST /api/rotator {"rotate":true}`) resets it.
- **Cooldown pacing ends where evidence begins.** The inter-hop cooldown
  (`cooldownMs`) paces a hop whose outcome is still unknown. Once the previous
  hop's fresh address has been refused, the reactive hook hops again
  immediately instead of waiting the cooldown out — the address the wait was
  protecting is already proven spent. Single-flight (one hop at a time) and the
  hourly cap still apply; the breaker above is the futility cap. A manual
  rotation always skips the cooldown wait: a deliberate click is not something
  to pace.

#### In Docker

The bridge never installs or owns WARP — the tunnel lives wherever the operator
runs it. A common pairing is the [`caomingjun/warp`](https://github.com/cmj2002/warp-docker)
sidecar, and it fits directly: its GOST default (`GOST_ARGS=-L :1080`) serves
**HTTP and SOCKS5 on the same port**, so Bun's HTTP-only proxy support speaks
to it without extra front ends.

```yaml
# bridge container — the essentials
services:
  bridge:
    # ... build/port/volumes as in the compose file above ...
    environment:
      OPENCODE_BRIDGE_STATE_DIR: /data/state
      WARP_ROTATE_CMD: >-
        bun -e "await fetch('http://' + (process.env.DOCKER_HOST || 'host.docker.internal') + ':2375/containers/cloudflare-warp/kill?signal=HUP', {method:'POST'})"
    extra_hosts:            # Linux only; Docker Desktop resolves it natively
      - "host.docker.internal:host-gateway"
```

- **Egress:** set the panel's *URL proxy* to `http://cloudflare-warp:1080`
  (same compose network) or `http://host.docker.internal:1080` (host-published
  port). Verify first:
  `curl -x http://127.0.0.1:1080 https://www.cloudflare.com/cdn-cgi/trace` must
  show `warp=on` (gost auto-detects HTTP vs SOCKS per connection, so one port
  serves both).
- **The rotate command runs inside the bridge container** (`execFile`), so a
  host `warp-cli` is not callable. `warp-cli` exists only *inside* the warp
  container; reach it through the Docker API instead. Simplest: publish
  dockerd on `127.0.0.1:2375` (`DOCKER_HOST`) or mount the container's socket
  if it is a Linux daemon, and restart the warp container as the hop —
  `entrypoint.sh` re-registers (license key is persisted in the
  `/var/lib/cloudflare-warp` volume) and re-connects, which allocates a fresh
  `/64`. `POST /containers/<name>/kill?signal=HUP` restarts the main process
  without recreating; a full `restart` works too.
- **A container does not ride the host's WARP TUN.** Container egress leaves
  through Docker's own NAT, so "direct probe = already through WARP" only holds
  when the bridge runs natively on the WARP machine. Inside a container the
  probe is correct because it rides the configured egress (previous section) —
  with `http://cloudflare-warp:1080` as the egress, the probe and every request
  leave through WARP.
- **Loopback trap:** with the compose file above publishing `1080` on
  `0.0.0.0`, any LAN host can use the WARP exit. Keep gost reachable only from
  the bridge: same network + no published port (drop the `ports:` block), or
  publish `127.0.0.1:1080:1080`.
- **License note:** `WARP_LICENSE_KEY` in plain env/compose is readable via
  `docker inspect` by anyone with Docker access — same trust level as the
  bridge's proxy credentials, keep both on a host only you control.
- **State persists:** `rotator.json` lives in `/data/state`
  (`OPENCODE_BRIDGE_STATE_DIR`), already a compose volume — rotator config
  survives `docker compose up -d` recreates like the proxy pool does.
- **Desktop reality check:** on a Windows/macOS desktop the native install
  (`install.sh`) next to the warp sidecar is the low-friction path. The
  all-in-Docker topology earns its keep on servers.

#### On CasaOS

CasaOS installs a compose app through its UI: **App Management → Install →
Custom install → paste the YAML**. Use `docker-compose.example.yml` as the
base, then adapt these four things — a compose pasted verbatim leaves the app
invisible from your LAN and the WARP hop dead:

1. **Port binding.** CasaOS's dashboard and your LAN clients cannot reach a
   `127.0.0.1:20129:20129` binding (that is loopback *of the CasaOS host*).
   The bridge has no authentication, so think before you widen it:
   - Clients only on the same host (9Router/LiteLLM in another container on
     this machine): keep `127.0.0.1:20129:20129`, and point those clients at
     the container-to-container address `http://bridge:20129/v1` instead —
     put both apps in the same compose project so the name resolves.
   - Clients on other devices of your LAN: bind to the host's LAN IP, e.g.
     `192.168.1.10:20129:20129` (narrower than `0.0.0.0`), and accept that
     everything on that network can use the bridge.
2. **The WARP hop needs the Docker API on TCP, not the socket.** Bun's fetch
   cannot talk to a unix socket, so `WARP_ROTATE_CMD` posts to
   `host.docker.internal:2375`. On the CasaOS host, publish dockerd on
   loopback with a systemd drop-in (CasaOS uses the system docker):

   ```bash
   # /etc/systemd/system/docker.service.d/99-local-api.conf
   [Service]
   ExecStart=
   ExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375 --containerd=/run/containerd/containerd.sock
   ```

   `systemctl daemon-reload && systemctl restart docker` (CasaOS containers
   with `restart: unless-stopped` come back on their own). Loopback-only, so
   it is reachable from the host itself and, through `host-gateway`, from the
   bridge container. The safer alternative is a
   [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy)
   limited to `CONTAINERS=1`, pointed at by `DOCKER_HOST`.
3. **If a WARP sidecar already runs on the CasaOS host** (the common
   `caomingjun/warp` app), do not install a second one: drop the `warp`
   service from the compose, point the bridge's egress at the existing one
   (`http://<host-lan-ip>:1080` if its gost port is published, or the
   container name if you move it into the same compose project), and keep the
   `WARP_ROTATE_CMD` container name matching (`/containers/<name>/kill`).
4. **App metadata.** CasaOS reads port and icon info from `x-casaos` labels
   for its dashboard tiles; without them the app still runs and the UI lists
   it, just without a clickable web-UI link. Open the panel manually at
   `http://<host-ip>:20129/`.

After install: open the bridge panel, set the egress to the warp gost
(`http://warp:1080` same-project, or the existing container/host address),
and if you use the rotator, set the command in the panel or keep
`WARP_ROTATE_CMD` from the compose. The health checks in the compose show in
CasaOS as the app's running state.

## Troubleshooting

### `403` with "detected abusive traffic" / `Detect Abuse Traffic` (IP-level block)

This is not the shape gate and not a stale bridge. The gateway has flagged the
network's egress IP for abusive traffic; the message says it is unrelated to the
account. The bridge treats it as terminal: it does **not** refresh the identity,
re-mint the session id, or retry, and returns the refusal verbatim with
`X-OpenCode-Gate: ip-abuse`. `/health` reports `identity.gate.status:
"ip-blocked"` and `identity.gate.lastRejection.kind: "ip-abuse"`.

The official OpenCode CLI gets the same answer from the same network. Only
upstream can clear the flag (`help@anoma.ly`, with the time it started and the
`x-opencode-log-id` from the response). Until then, change egress (route through
another host or SSH tunnel), subscribe to OpenCode Go, or wait. Reinstalling the
bridge or editing headers will not help.

### `403 FreeTierError` persists even after retry

When the bridge receives `403 FreeTierError`, it refreshes its recipe from OpenCode's update API and GitHub source tree, re-mints the session ID, escalates to the full tool profile, and retries once. If the message names an explicit IP-level abuse block (`abusive traffic` / `Detect Abuse Traffic`), this path is skipped entirely — see the section above.

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

### `429 FreeUsageLimitError` — the quota, or a missing `<env>` block?

`429 FreeUsageLimitError` has **two** causes, and the gateway uses the same
message for both:

1. the free-tier allowance is spent, or
2. the request's system prompt is missing the harness environment block.

Cause 2 is the one that made the bridge look throttled while the CLI worked.
Reproduced by capturing the CLI's own request and replaying it byte-for-byte:
the captured body answers `200`, the same body with only its system prompt
replaced by a short one answers `429`. Same headers, same session id, same TLS
stack — the difference is the body.

The trigger is precise: an `<env>` block containing a `Working directory:` line.

| system prompt | result |
|---|---|
| `You are a helpful assistant.` | `429` |
| 12 KB of generic prompt text | `429` |
| `<env>Working directory: /tmp</env>` (65 bytes) | `200` |
| 12 KB generic prompt **plus** the env block | `200` |

Length is not the rule, and neither is the model — `big-pickle` and
`mimo-v2.6-flash-free` split the same way. Sending `tools: []` also produces
this `429`, which is why an empty tool profile looked like a quota error too.

### `429 FreeUsageLimitError` from a blocked tool name

The quota wording also hides a tool-name filter. A request whose only fault is a
tool named `run_code` is answered with the same `429 FreeUsageLimitError`, even
when the system prompt, the headers and the token budget are identical to a
request that answers `200`:

| `tools[].function.name` | result |
|---|---|
| `run_code` | `429` |
| `run_code_client` | `429` (the match is on the substring) |
| `run-code` | `200` |
| `runcode` | `200` |
| `run_program` | `200` |
| `code_exec` | `200` (same schema) |

Sending the anchor tool `read` alongside `run_code` does not help, so this is not
the shape gate and not the allowance. The bridge now sends such a tool upstream
as `run_program` and restores the client's name on the way back, including
streamed tool-call deltas, `tool_choice` and tool-result turns, so a client keeps
its own tool name.

### `429 FreeUsageLimitError` from a blocked parameter name

The same quota wording hides a second, deeper filter: it also inspects the
**property names** inside `tools[].function.parameters.properties`. Measured
on 2026-11-21 with one model, one gateway and one egress, in the same minute the
official CLI answered `200`:

| `edit` schema | result |
|---|---|
| `old_string` / `new_string` (snake_case) | `429` |
| `old_text` / `new_text` | `200` |
| `oldString` / `newString` (camelCase) | `200` |
| original description, simplified schema | `200` |
| empty description, original schema | `429` |

So the rule is on the key, not the tool name, the description or the byte size.
It matters because omp, Cline, Roo and Aider declare `edit` with
`old_string`/`new_string`, while the OpenCode CLI uses `oldString`/`newString`
— which is why the CLI keeps working from the same IP. The bridge now sends
those keys as `old_text`/`new_text` and puts the client's names back into
`tool_calls[].function.arguments`, both in streamed SSE (arguments are buffered
per tool-call index because a JSON key can straddle two chunks) and in the
folded JSON response, on both the Chat Completions and Responses lanes.

The bridge has appended the block since the fix in this release: it derives the
working directory, workspace root, git-repo flag and platform from its own
process. A client that already forwards the CLI's prompt keeps its own block
and does not get a duplicate. If you still see `429` on an up-to-date bridge,
the allowance really is spent — check with the interleaving probe:

```bash
for i in 1 2 3; do
  opencode run -m opencode/glm-5.3-flash-free "probe $i" 2>&1 | tail -1
  curl -s http://127.0.0.1:20129/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"glm-5.3-flash-free","messages":[{"role":"user","content":"probe"}],"max_tokens":8}' \
    | head -c 120; echo
done
```

If both refuse, the allowance is spent. If the CLI answers while the bridge
refuses **in the same minute** on a bridge older than this release, upgrade —
that is the shape bug, not a quota.

#### Why the bridge can be charged earlier than the CLI

The default `TOOL_PROFILE_SCOPE=core` sends two tools (`read`, `shell`) and a
short placeholder note, then escalates to `full` only after a rejection. The
real CLI always sends the full profile. Measured against a captured CLI request
(`opencode run`, v2.0.32) and this bridge on the same model:

| | CLI | bridge, `core` | bridge, `full` |
|---|---|---|---|
| tools | 12 | 2 | 13 |
| tool schema bytes | 13,991 | 2,522 | 13,972 |
| system prompt chars | 12,259 | ~470 | ~470 |
| `max_completion_tokens` | 32,000 | 5,120 | 5,120 |
| total body bytes | 26,296 | ~3,300 | ~14,500 |

`TOOL_PROFILE_SCOPE=full` closes the tool gap and is the safer default when a
deployment is being throttled ahead of the CLI.

The system-prompt gap is **not** cosmetic: before the `<env>` fix in this
release it was the whole `429` cause. What remains after the fix is the CLI's
harness prose (persona, communication rules, skill catalogue), which the bridge
does not ship. That part is accepted by the gateway — the env block is the only
anchor it checks — so the bridge no longer needs to reproduce the full prompt.

```bash
# systemd drop-in for a service that runs as a dedicated user
sudo mkdir -p /etc/systemd/system/opencode-free-bridge.service.d
printf '[Service]\nEnvironment=TOOL_PROFILE_SCOPE=full\n' \
  | sudo tee /etc/systemd/system/opencode-free-bridge.service.d/10-tool-profile.conf
sudo systemctl daemon-reload && sudo systemctl restart opencode-free-bridge.service
```

### Reverse tunnel dies while the process still looks healthy

A deployment that reaches the bridge over `ssh -R` can fail in a way systemd
cannot see: the `ssh` process stays `active`, the TCP connection stays `ESTAB`,
and the listener on the far end is gone. `Restart=always` never fires because
the process never exits. This cost two hours of downtime on a five-node
deployment before it was diagnosed.

The only reliable probe is the endpoint itself. Run it on the host that owns the
forwarded port, not on the node:

```bash
#!/bin/bash
# /usr/local/bin/opencode-tunnel-watchdog.sh — run as root via a systemd timer
PORT=20136
LOG=/var/log/opencode-tunnel-watchdog.log
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

if ! curl -sf --max-time 5 http://127.0.0.1:20129/health >/dev/null; then
  log "bridge DOWN - restarting"; systemctl restart opencode-bridge.service; sleep 4
fi
if ! pgrep -f "ssh .*-R 127.0.0.1:${PORT}:" >/dev/null; then
  log "tunnel MISSING - restarting"; systemctl restart opencode-tunnel.service; sleep 6
fi
pgrep -f "ssh .*-R 127.0.0.1:${PORT}:" >/dev/null \
  && log "SUMMARY ok" || log "SUMMARY FAILED - manual attention needed"
```

Pair it with a `oneshot` service and a `OnUnitActiveSec=60` timer. The
`SUMMARY` line is deliberate: without a heartbeat, an empty log is
indistinguishable from a watchdog that never ran.

Restarting the tunnel from a remote host over SSH needs care. `Defaults use_pty`
in `/etc/sudoers` makes `sudo -n` fail with "a password is required" even when
`NOPASSWD` is granted, and a nested `ssh host "python3 -c \"...\""` mangles
quotes. Run the watchdog **as root on the node itself** through systemd instead
of driving it remotely.

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

## License and upstream data

This project is licensed under [MIT](./LICENSE). `identity.js` derives request identity and tool metadata from the [OpenCode source repository](https://github.com/anomalyco/opencode). Its offline fallback includes OpenCode `read` and `shell` tool descriptions and schema fields; related source-shaped fixtures appear in `test/identity.test.js`. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for the OpenCode MIT notice and contributor credit.
