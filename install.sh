#!/usr/bin/env bash
# opencode-free-bridge installer.
#
#   curl -fsSL https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/install.sh | bash
#
# What it does:
#   1. finds Bun, or installs it. The CLI ships as a Bun binary and the
#      free-tier gate checks the transport fingerprint: measured 200 on Bun,
#      403 on Node and curl.
#   2. downloads the bridge into a staging directory and validates it before
#      touching anything that is already running
#   3. retires a pre-2.0 `opencode-bridge.service` that would fight for the port
#   4. copies the bridge and its tools into an install dir (server.js,
#      identity.js, token-budget.js, verify.js, gate-drill.js and the
#      transport-fingerprint files), backing up any existing install first
#   5. registers a service so the bridge starts on boot and restarts on crash
#      (systemd on Linux, launchd on macOS). Windows is not supported.
#   6. waits for /health, then runs the self-check and the TLS fingerprint check
#
# It exits non-zero if the bridge does not come up. "Done" is only printed for
# a bridge that answered.
#
# Env overrides:
#   PORT       listen port            (default 20129)
#   HOST       bind address           (default 127.0.0.1)
#   BINDIR     where the files go     (default ~/.opencode-free-bridge)
#   NO_SERVICE skip service install   (default: install the service)
#   REPO       source repo            (default azrinaldi/opencode-free-bridge)
set -euo pipefail

PORT="${PORT:-20129}"
HOST="${HOST:-127.0.0.1}"
BINDIR="${BINDIR:-$HOME/.opencode-free-bridge}"
REPO="${REPO:-azrinaldi/opencode-free-bridge}"
BRANCH="${BRANCH:-main}"

say()  { printf '\033[1;32m[opencode-free-bridge]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[opencode-free-bridge]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[opencode-free-bridge]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "Invalid PORT: $PORT"
[[ "$HOST" =~ ^[A-Za-z0-9.:_-]+$ ]] || die "Invalid HOST: $HOST"
case "$BINDIR" in
  *$'\n'*|*$'\r'*) die "Invalid BINDIR: newline not allowed" ;;
esac

# ---------------------------------------------------------------- Node.js ---
# Bun is required, not preferred. Measured from one IP in one minute with
# identical headers and body: the real CLI and the bridge on Bun both get 200,
# while Node and curl get 403. The CLI ships as a Bun binary, and the free-tier
# gate inspects the transport fingerprint, so only Bun reproduces it.
#
# `curl https://bun.sh/install | bash` puts bun in `$HOME/.bun/bin` and adds it
# to an *interactive* shell's PATH only. A non-interactive SSH session, a cron
# job, or this installer running under `sh -c` therefore sees no `bun` even
# though the binary is present. Look in the standard locations before
# concluding it is missing.
find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  local candidate
  for candidate in "${BUN_INSTALL:-}/bin/bun" "$HOME/.bun/bin/bun" "$HOME/.local/bin/bun" /usr/local/bin/bun /opt/bun/bin/bun; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if BUN_BIN="$(find_bun)"; then
  RUNTIME="$BUN_BIN"
  say "runtime: bun ($("$RUNTIME" --version)) — matches the CLI's transport"
  case ":$PATH:" in
    *":$(dirname "$RUNTIME"):"*) ;;
    *) warn "bun is not on PATH; using $RUNTIME. Add $(dirname "$RUNTIME") to PATH for manual runs." ;;
  esac
elif [ -n "${ALLOW_NODE:-}" ] && command -v node >/dev/null 2>&1; then
  RUNTIME="$(command -v node)"
  warn "runtime: node — NOT supported for live use. The free-tier gate refuses Node's"
  warn "transport fingerprint with 403. Proceeding because ALLOW_NODE is set."
else
  # The one-line installer exists so a new user does not have to read a manual.
  # Telling them "install Bun first" and exiting defeats that, so install it.
  say "Bun is not installed; installing it now (required for the transport fingerprint)"
  if ! command -v unzip >/dev/null 2>&1 && ! command -v 7z >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ] || (command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1); then
      SUDO_CMD=""
      [ "$(id -u)" != "0" ] && SUDO_CMD="sudo -n"
      say "Installing unzip (required by the Bun installer)..."
      if command -v apt-get >/dev/null 2>&1; then
        $SUDO_CMD apt-get update -qq >/dev/null 2>&1 && $SUDO_CMD apt-get install -y -qq unzip >/dev/null 2>&1 || true
      elif command -v dnf >/dev/null 2>&1; then
        $SUDO_CMD dnf install -y -q unzip >/dev/null 2>&1 || true
      elif command -v yum >/dev/null 2>&1; then
        $SUDO_CMD yum install -y -q unzip >/dev/null 2>&1 || true
      elif command -v apk >/dev/null 2>&1; then
        $SUDO_CMD apk add --no-cache -q unzip >/dev/null 2>&1 || true
      elif command -v pacman >/dev/null 2>&1; then
        $SUDO_CMD pacman -Sy --noconfirm unzip >/dev/null 2>&1 || true
      fi
    fi
  fi
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL https://bun.sh/install | bash >/tmp/ofb-bun-install.log 2>&1; then
      warn "Bun installation failed. Log:"
      tail -5 /tmp/ofb-bun-install.log >&2 2>/dev/null || true
      die "install Bun manually: https://bun.sh"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -qO- https://bun.sh/install | bash >/tmp/ofb-bun-install.log 2>&1; then
      warn "Bun installation failed. Log:"
      tail -5 /tmp/ofb-bun-install.log >&2 2>/dev/null || true
      die "install Bun manually: https://bun.sh"
    fi
  else
    die "neither curl nor wget is available, so Bun cannot be installed. Install Bun manually: https://bun.sh"
  fi
  rm -f /tmp/ofb-bun-install.log
  if ! BUN_BIN="$(find_bun)"; then
    die "Bun was installed but cannot be found in ~/.bun/bin. Open a new shell and re-run this installer."
  fi
  RUNTIME="$BUN_BIN"
  say "runtime: bun ($("$RUNTIME" --version)) — installed by this script"
fi
# Bun has no version gate here: the bridge uses only long-stable APIs, and Bun
# 1.4.2 (the CLI's own bundled version) and 1.4.3 were both verified. Node does.
if [ "$(basename "$RUNTIME")" = "node" ]; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 18 ] || die "Node.js >= 18 required (found $(node -v))"
fi

# -------------------------------------------------------------- migration ---
# Upgrading from 1.x or early 2.x means three things change underneath:
#
#   * the runtime (node -> bun), so any service unit still says `node`
#   * the file set (identity.js and the transport tools are new), so a partial
#     copy from an older installer leaves a bridge that cannot start
#   * the transport itself, so an old install that "worked" now needs Bun to
#     get anything but 403
#
# The old files are moved aside rather than deleted, so a failed upgrade can be
# undone by hand.
PREV_VERSION=""
if [ -f "$BINDIR/package.json" ]; then
  PREV_VERSION="$("$RUNTIME" -e 'try{process.stdout.write(require(process.argv[1]).version||"")}catch{}' "$BINDIR/package.json" 2>/dev/null || true)"
fi
if [ -n "$PREV_VERSION" ]; then
  say "Found existing install: v$PREV_VERSION in $BINDIR"
  BACKUP="$BINDIR/.backup-v$PREV_VERSION-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$BACKUP"
  for f in server.js identity.js token-budget.js verify.js gate-drill.js transport-fingerprint.js transport-baseline.json package.json tunnel-doctor.sh; do
    [ -f "$BINDIR/$f" ] && cp -p "$BINDIR/$f" "$BACKUP/$f" 2>/dev/null || true
  done
  say "Backed up to $BACKUP"
  if [ -f "$BINDIR/server.js" ] && ! grep -q '#!/usr/bin/env bun' "$BINDIR/server.js" 2>/dev/null; then
    say "Old install ran on Node; this version requires Bun for the live gate"
  fi
fi

# A service unit written by an older installer still points at `node`, which
# would silently keep failing after the upgrade. Rewrite it if we can.
migrate_service_runtime() {
  local unit esc_runtime esc_bindir
  esc_runtime="$(printf '%s' "$RUNTIME" | sed 's/[\\&|]/\\&/g')"
  esc_bindir="$(printf '%s' "$BINDIR" | sed 's/[\\&|]/\\&/g')"
  for unit in "/etc/systemd/system/opencode-free-bridge.service" \
              "$HOME/.config/systemd/user/opencode-free-bridge.service"; do
    [ -f "$unit" ] || continue
    if grep -q 'ExecStart=.*node' "$unit" 2>/dev/null; then
      sed -i.bak -E "s|^ExecStart=.*|ExecStart=\"$esc_runtime\" \"$esc_bindir/server.js\"|" "$unit" 2>/dev/null || {
        warn "could not rewrite $unit — update ExecStart to: \"$RUNTIME\" \"$BINDIR/server.js\""
        continue
      }
      say "Service unit updated to run under $(basename "$RUNTIME"): $unit"
      if [ "${unit#/etc}" != "$unit" ]; then
        systemctl daemon-reload 2>/dev/null || true
      else
        systemctl --user daemon-reload 2>/dev/null || true
      fi
    fi
  done
  local plist="$HOME/Library/LaunchAgents/com.opencode-free-bridge.plist"
  if [ -f "$plist" ] && grep -q '<string>.*node</string>' "$plist" 2>/dev/null; then
    sed -i.bak -E "s|<string>[^<]*node</string>|<string>$esc_runtime</string>|" "$plist" 2>/dev/null || true
    say "launchd agent updated to run under $(basename "$RUNTIME")"
  fi
}
migrate_service_runtime

# ------------------------------------------------------- legacy retirement ---
# Releases before v2.0 registered `opencode-bridge.service`, not
# `opencode-free-bridge.service`. Both bind the same port, so leaving the old
# unit enabled makes the new service fail with EADDRINUSE and restart-loop
# forever. A user who finds this repo and re-runs the installer on a machine
# that still has the old bridge should get an upgrade, not a port fight.
port_holder() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | awk -v p=":$PORT$" '$4 ~ p {print; exit}'
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print; exit}'
    return 0
  fi
  return 0
}

legacy_unit_active() {
  systemctl is-active --quiet opencode-bridge 2>/dev/null && return 0
  systemctl --user is-active --quiet opencode-bridge 2>/dev/null && return 0
  return 1
}

# Is the port held by the bridge this installer is about to replace? Re-running
# the installer on an existing install must work, so the bridge's own process
# is not a conflict. Anything else is.
#
# Note the `|| true`: the installer runs under `set -euo pipefail`, and a
# pipeline whose `grep` finds nothing exits 1, which would abort the whole
# install with no message. Every probe here must be allowed to come up empty.
pid_on_port() {
  local pid
  pid="$(port_holder | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  if [ -z "$pid" ]; then
    pid="$(port_holder | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1 || true)"
  fi
  if [ -z "$pid" ] && command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  fi
  printf '%s\n' "$pid"
}

port_held_by_own_bridge() {
  local pid cwd target
  pid="$(pid_on_port)"
  [ -n "$pid" ] || return 1

  # The detached bridge is started with `bun server.js` after a pushd, so its
  # cmdline is relative and only the cwd identifies it. readlink appends
  # " (deleted)" once the install directory has been replaced, which must not
  # defeat the match.
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null | sed 's/ (deleted)$//' || true)"
  target="$(readlink -f "$BINDIR" 2>/dev/null || printf '%s' "$BINDIR")"
  [ -n "$cwd" ] && [ -n "$target" ] && [ "$cwd" = "$target" ] && return 0

  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$BINDIR/server.js" && return 0
  ps -p "$pid" -o command= 2>/dev/null | grep -qF "$BINDIR/server.js" && return 0
  command -v lsof >/dev/null 2>&1 && lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -qF "n$target" && return 0
  return 1
}

stop_own_bridge() {
  local pid
  pid="$(pid_on_port)"
  [ -n "$pid" ] || return 0

  # If systemd supervises this bridge, stop it through systemd. Killing the pid
  # directly would be undone immediately by Restart=always.
  if systemctl is-active --quiet opencode-free-bridge 2>/dev/null; then
    say "Stopping the running bridge service to replace it"
    systemctl stop opencode-free-bridge 2>/dev/null || true
    return 0
  fi
  if systemctl --user is-active --quiet opencode-free-bridge 2>/dev/null; then
    say "Stopping the running bridge service to replace it"
    systemctl --user stop opencode-free-bridge 2>/dev/null || true
    return 0
  fi

  say "Stopping the running bridge (pid $pid) to replace it"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null || true
}

# Decide before touching anything. If a stranger owns the port, stopping the
# user's working bridge first would leave them with nothing at all.
if [ -n "$(port_holder)" ] && ! legacy_unit_active && ! port_held_by_own_bridge; then
  warn "port $PORT is already in use:"
  warn "  $(port_holder)"
  warn "Nothing was changed. Either stop that process, or install on another port:"
  warn "  PORT=20130 bash install.sh"
  die "port $PORT is occupied by another process"
fi

retire_legacy_service() {
  local name="opencode-bridge.service"
  local stamp retired=0
  stamp="$(date +%Y%m%d%H%M%S)"

  if [ -f "/etc/systemd/system/$name" ] || systemctl cat "$name" >/dev/null 2>&1; then
    if systemctl is-active --quiet "$name" 2>/dev/null; then
      systemctl stop "$name" 2>/dev/null && retired=1
    fi
    systemctl disable "$name" >/dev/null 2>&1 || true
    if [ -f "/etc/systemd/system/$name" ]; then
      mv -f "/etc/systemd/system/$name" "/etc/systemd/system/$name.retired-$stamp" 2>/dev/null || true
    fi
    rm -f "/etc/systemd/system/multi-user.target.wants/$name" 2>/dev/null || true
    systemctl daemon-reload 2>/dev/null || true
    say "Retired legacy unit $name (it held the old bridge on port $PORT)"
  fi

  if [ -f "$HOME/.config/systemd/user/$name" ]; then
    systemctl --user stop "$name" 2>/dev/null || true
    systemctl --user disable "$name" >/dev/null 2>&1 || true
    mv -f "$HOME/.config/systemd/user/$name" "$HOME/.config/systemd/user/$name.retired-$stamp" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/default.target.wants/$name" 2>/dev/null || true
    systemctl --user daemon-reload 2>/dev/null || true
    say "Retired legacy user unit $name"
  fi

  # Let the old process release the listening socket before the new service
  # tries to bind it.
  if [ "$retired" = "1" ]; then sleep 1; fi
}

# ------------------------------------------------------------------ fetch ---
# Everything is downloaded and syntax-checked in a staging directory *before*
# the running bridge is touched. A network failure halfway through an upgrade
# therefore leaves the old bridge serving traffic instead of leaving the user
# with a stopped service and a half-written install.
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
mkdir -p "$BINDIR"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/ofb-stage.XXXXXX")"
cleanup_stage() { rm -rf "$STAGE" 2>/dev/null || true; }
trap cleanup_stage EXIT
say "Installing into $BINDIR"

fetch() {
  local file="$1"
  local tmp="$STAGE/$file"
  # raw.githubusercontent.com sits behind a CDN that can serve the previous
  # commit for a while after a push. A stale install.sh is harmless (it already
  # ran) but a stale server.js next to a fresh identity.js is not. The query
  # string is ignored by the server and defeats the cache.
  local url="$RAW/$file?cb=$(date +%s)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -H 'Cache-Control: no-cache' -o "$tmp" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp" "$url"
  else
    die "neither curl nor wget is available"
  fi
  [ -s "$tmp" ] || die "downloaded $file is empty"
}

fetch package.json
fetch server.js
fetch identity.js
fetch token-budget.js
fetch verify.js
fetch gate-drill.js
fetch transport-fingerprint.js
fetch transport-baseline.json
fetch tunnel-doctor.sh

# A syntactically broken release must never replace a working install.
#
# `bun --check` does NOT mean "parse only": Bun has no --check flag, so it
# treats the file as the entrypoint and *runs* it. That started a second server
# during an install and, worse, made every upgrade abort with "failed a syntax
# check". Parse the source instead: new Function compiles without executing.
syntax_check() {
  "$RUNTIME" -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8").replace(/^#!.*\n/, "");
    try { new Function(src); } catch (err) { console.error(err.message); process.exit(1); }
  ' "$1"
}

for js in server.js identity.js token-budget.js verify.js gate-drill.js transport-fingerprint.js; do
  syntax_check "$STAGE/$js" >/dev/null 2>&1 || die "$js failed a syntax check; the running bridge was left untouched"
done
for json in package.json transport-baseline.json; do
  "$RUNTIME" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$STAGE/$json" \
    || die "$json is not valid JSON; the running bridge was left untouched"
done
# tunnel-doctor.sh is bash, not JS, so `new Function` cannot check it. `bash -n`
# parses without executing, which is exactly the guarantee we need here.
if [ -f "$STAGE/tunnel-doctor.sh" ]; then
  if command -v bash >/dev/null 2>&1; then
    bash -n "$STAGE/tunnel-doctor.sh" || die "tunnel-doctor.sh failed a syntax check; the running bridge was left untouched"
  fi
fi

# Staged and validated. Only now is it safe to stop the old bridge.
retire_legacy_service
stop_own_bridge

# The old process releases the socket asynchronously after SIGTERM. Wait for it
# instead of racing the bind, and report clearly if it never happens.
for _ in $(seq 1 10); do
  [ -z "$(port_holder)" ] && break
  sleep 0.5
done
if [ -n "$(port_holder)" ]; then
  warn "port $PORT is still held after stopping the old bridge:"
  warn "  $(port_holder)"
  die "cannot bind port $PORT"
fi

for file in package.json server.js identity.js token-budget.js verify.js gate-drill.js transport-fingerprint.js transport-baseline.json tunnel-doctor.sh; do
  [ -f "$STAGE/$file" ] && mv -f "$STAGE/$file" "$BINDIR/$file"
done
chmod +x "$BINDIR/server.js" "$BINDIR/identity.js" "$BINDIR/verify.js" "$BINDIR/gate-drill.js" "$BINDIR/transport-fingerprint.js" "$BINDIR/tunnel-doctor.sh" 2>/dev/null || true
say "Files installed (v$("$RUNTIME" -e 'try{process.stdout.write(require(process.argv[1]).version||"latest")}catch{process.stdout.write("latest")}' "$BINDIR/package.json" 2>/dev/null || echo 'latest'))"

# ---------------------------------------------------------------- service ---
SERVICE_SCOPE="none"
install_service() {
  local os
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"

  if [ "$os" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
    local unit_dir="/etc/systemd/system"
    local unit="$unit_dir/opencode-free-bridge.service"
    if [ -w "$unit_dir" ]; then
      cat > "$unit" <<UNIT
[Unit]
Description=OpenCode Free Bridge (OpenAI-compatible, free-tier models)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$BINDIR
Environment=PORT=$PORT
Environment=HOST=$HOST
ExecStart="$RUNTIME" "$BINDIR/server.js"
Restart=always
RestartSec=3
MemoryMax=512M

[Install]
WantedBy=multi-user.target
UNIT
      systemctl daemon-reload
      systemctl enable opencode-free-bridge >/dev/null 2>&1 || true
      if ! systemctl restart opencode-free-bridge; then
        warn "systemd refused to start opencode-free-bridge — inspect: systemctl status opencode-free-bridge"
        return 1
      fi
      SERVICE_SCOPE="system"
      say "systemd service installed and restarted"
      return 0
    elif systemctl --user status >/dev/null 2>&1; then
      local user_unit_dir="$HOME/.config/systemd/user"
      local user_unit="$user_unit_dir/opencode-free-bridge.service"
      mkdir -p "$user_unit_dir"
      cat > "$user_unit" <<UNIT
[Unit]
Description=OpenCode Free Bridge (OpenAI-compatible, free-tier models)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$BINDIR
Environment=PORT=$PORT
Environment=HOST=$HOST
ExecStart="$RUNTIME" "$BINDIR/server.js"
Restart=always
RestartSec=3
MemoryMax=512M
[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload
      systemctl --user enable opencode-free-bridge >/dev/null 2>&1 || true
      if ! systemctl --user restart opencode-free-bridge; then
        warn "systemd --user refused to start opencode-free-bridge — inspect: systemctl --user status opencode-free-bridge"
        return 1
      fi
      SERVICE_SCOPE="user"
      command -v loginctl >/dev/null 2>&1 && loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
      say "systemd --user service installed and restarted"
      return 0
    else
      warn "no write access to $unit_dir — skipping service install (run with sudo to enable it)"
      return 1
    fi
  fi

  if [ "$os" = "darwin" ]; then
    local plist="$HOME/Library/LaunchAgents/com.opencode-free-bridge.plist"
    mkdir -p "$(dirname "$plist")"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.opencode-free-bridge</string>
  <key>ProgramArguments</key>
  <array><string>$RUNTIME</string><string>$BINDIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$BINDIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>$PORT</string><key>HOST</key><string>$HOST</string></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/opencode-free-bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/opencode-free-bridge.log</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
    mkdir -p "$HOME/Library/Logs"
    launchctl unload "$plist" >/dev/null 2>&1 || true
    launchctl load "$plist"
    SERVICE_SCOPE="launchd"
    say "launchd agent installed and restarted"
    return 0
  fi

  warn "no supported service manager found — start it manually: PORT=$PORT $RUNTIME $BINDIR/server.js"
  return 1
}

SERVICE_OK=1
if [ "${NO_SERVICE:-0}" != "1" ]; then
  install_service || SERVICE_OK=0
else
  SERVICE_OK=0
fi

# ------------------------------------------------------------ start check ---
if [ "$SERVICE_OK" != "1" ]; then
  say "Starting in the background (no service manager)"
  pkill -f -- "$BINDIR/server.js" 2>/dev/null || true
  sleep 0.5
  # Two things matter here, and both were measured:
  #
  #   * No subshell. `( ... & )` leaves bash waiting on the child, so a piped
  #     installer blocks until the bridge exits — 70s in a minimal repro, and a
  #     real install that never returned.
  #   * setsid + stdin from /dev/null, so the child owns no descriptor of the
  #     caller's terminal or pipe.
  #
  # pushd/popd changes directory without forking. Measured: 0.004s.
  pushd "$BINDIR" >/dev/null
  if command -v setsid >/dev/null 2>&1; then
    setsid env PORT="$PORT" HOST="$HOST" "$RUNTIME" server.js </dev/null >"$BINDIR/bridge.log" 2>&1 &
  else
    env PORT="$PORT" HOST="$HOST" nohup "$RUNTIME" server.js </dev/null >"$BINDIR/bridge.log" 2>&1 &
  fi
  disown 2>/dev/null || true
  popd >/dev/null
fi

PROBE_HOST="$HOST"
if [ "$PROBE_HOST" = "0.0.0.0" ] || [ "$PROBE_HOST" = "::" ]; then
  PROBE_HOST="127.0.0.1"
fi

probe_health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 2 "http://$PROBE_HOST:$PORT/health" >/dev/null 2>&1
  else
    "$RUNTIME" -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "http://$PROBE_HOST:$PORT/health" >/dev/null 2>&1
  fi
}

say "Waiting for the bridge to come up..."
BRIDGE_UP=0
for _ in $(seq 1 20); do
  # -m matters: a HOST that is not routable makes curl hang for minutes, and
  # the installer used to sit there until the user killed it.
  if probe_health; then BRIDGE_UP=1; break; fi
  sleep 1
done

if [ "$BRIDGE_UP" != "1" ]; then
  warn "the bridge did not answer on http://$PROBE_HOST:$PORT/health after 20s"
  if [ "$SERVICE_OK" = "1" ]; then
    if [ "$SERVICE_SCOPE" = "user" ]; then
      warn "inspect: systemctl --user status opencode-free-bridge ; journalctl --user -u opencode-free-bridge -n 30"
    else
      warn "inspect: systemctl status opencode-free-bridge ; journalctl -u opencode-free-bridge -n 30"
    fi
  else
    warn "inspect: $BINDIR/bridge.log"
  fi
  die "install finished but the service is not running"
fi
say "Bridge is answering on http://$PROBE_HOST:$PORT"

echo
say "Running self-check (quick — full check: $RUNTIME $BINDIR/verify.js)"
echo
# Bounded on purpose: the self-check talks to a live upstream that can throttle.
# Without a hard cap, a slow upstream makes the installer look hung, and the user
# kills it before the service is registered.
if command -v timeout >/dev/null 2>&1; then
  set +e
  PORT="$PORT" HOST="$HOST" timeout 120 "$RUNTIME" "$BINDIR/verify.js" --quick
  CHECK_RC=$?
  set -e
else
  set +e
  PORT="$PORT" HOST="$HOST" "$RUNTIME" "$BINDIR/verify.js" --quick
  CHECK_RC=$?
  set -e
fi
case "$CHECK_RC" in
  0) ;;
  2) warn "the bridge is installed and healthy, but upstream refused this IP's free-tier allowance"
     warn "the official OpenCode CLI gets the same refusal from this network; re-check later with the command below" ;;
  124) warn "self-check hit the 120s cap; the bridge is installed, run the check again when upstream is responsive" ;;
  *) warn "self-check reported a problem; inspect the log with the command below" ;;
esac

# The TLS fingerprint is the gate. An outdated Bun installs and starts happily
# and then earns a 403 that looks exactly like an exhausted IP allowance, so
# check it here rather than letting the user debug the wrong thing.
if [ -f "$BINDIR/transport-fingerprint.js" ] && [ -f "$BINDIR/transport-baseline.json" ]; then
  set +e
  ( cd "$BINDIR" && "$RUNTIME" transport-fingerprint.js --check >/dev/null 2>&1 )
  TLS_RC=$?
  set -e
  if [ "$TLS_RC" != "0" ]; then
    warn "this Bun build's TLS ClientHello does not match the recorded OpenCode CLI baseline"
    warn "upstream inspects that fingerprint; expect 403 until it matches."
    warn "inspect: cd $BINDIR && $RUNTIME transport-fingerprint.js --check"
  fi
fi

echo
say "Done."
cat <<NEXT

  Endpoint : http://$PROBE_HOST:$PORT/v1
  API key  : public  (any value is accepted)
  Models   : curl http://$PROBE_HOST:$PORT/v1/models

  Add it to 9Router, Cursor, Continue, or any OpenAI-compatible client as a
  custom provider. Re-run the self-check any time with:

      "$RUNTIME" $BINDIR/verify.js

NEXT

if [ "$SERVICE_OK" = "1" ]; then
  if [ "$SERVICE_SCOPE" = "user" ]; then
    echo "  Logs     : journalctl --user -u opencode-free-bridge -f"
  elif [ "$SERVICE_SCOPE" = "system" ]; then
    echo "  Logs     : journalctl -u opencode-free-bridge -f"
  else
    echo "  Logs     : tail -f ~/Library/Logs/opencode-free-bridge.log"
  fi
fi
echo
