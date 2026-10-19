#!/usr/bin/env bash
#
# tunnel-doctor.sh — reap stale SSH port forwards, and check the keepalive that
# prevents them.
#
# The problem this exists for
# ---------------------------
# A reverse tunnel (`ssh -R 127.0.0.1:20132:127.0.0.1:20129 …`) is held open by
# an sshd child process on the *receiving* host. When the sending host reboots,
# loses power, or is suspended, the TCP connection dies without a FIN. The
# receiving sshd keeps the listening socket until it notices, and until then a
# replacement tunnel fails with:
#
#   Error: remote port forwarding failed for listen port 20132
#
# With the default `ClientAliveInterval 300` / `ClientAliveCountMax 2`, "until it
# notices" can be ten minutes — long enough for a supervisor to give up, and long
# enough that an operator concludes the tunnel unit itself is broken. This script
# is the manual remedy for that window, and `--check` reports whether the
# keepalive is tight enough to keep the window short.
#
# What counts as stale
# --------------------
# Not "a listening socket exists" — a healthy tunnel listens too. A forwarded
# port is stale when its owning sshd session has **no established TCP connection
# to the peer**. The listener is the port forward; the ESTAB socket is the SSH
# transport that makes it work. No transport, no tunnel, regardless of what the
# listener still claims.
#
# Usage
# -----
#   ./tunnel-doctor.sh                  # report only (default)
#   ./tunnel-doctor.sh --reap           # kill sessions whose transport is gone
#   ./tunnel-doctor.sh --reap 20131 20132
#   ./tunnel-doctor.sh --check          # keepalive audit, exits 1 if too loose
#
# Exit codes: 0 healthy / reaped nothing needed, 1 problems found (report mode)
# or keepalive too loose (--check), 2 usage error.
#
# By default it scans the whole 20120-20149 block (set TUNNEL_PORTS="20129 20136"
# to narrow it). A hardcoded list silently skipped newly added nodes.
#
# Requires: ss, ps (iproute2 + procps). Must run as root on the receiving host.

set -euo pipefail

PORTS=()
REAP=0
CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --reap) REAP=1; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) PORTS+=("$1"); shift ;;
  esac
done

if [ "${#PORTS[@]}" -eq 0 ]; then
  # Scan the whole 201xx block rather than a hardcoded 20129..20135 list: a new
  # node's tunnel (20136 in this fleet) silently escaped the report, which is
  # the one thing this script exists to catch. Override with TUNNEL_PORTS.
  if [ -n "${TUNNEL_PORTS:-}" ]; then
    # shellcheck disable=SC2206
    PORTS=(${TUNNEL_PORTS})
  else
    PORTS=()
    for p in $(seq 20120 20149); do
      PORTS+=("$p")
    done
  fi
fi

# --- keepalive audit --------------------------------------------------------
# A session is declared dead after ClientAliveInterval × ClientAliveCountMax
# seconds. Anything above ~2 minutes leaves a rebooted peer's port held long
# enough to collide with an automatic restart.
if [ "$CHECK" -eq 1 ]; then
  if ! command -v sshd >/dev/null 2>&1; then
    echo "sshd not found; cannot audit keepalive" >&2
    exit 1
  fi
  # `sshd -T` needs root to read its own config. Capture the failure rather than
  # letting `set -e` + `pipefail` abort the script with no explanation.
  if ! sshd_config=$(sshd -T 2>&1); then
    echo "cannot read the effective sshd config (run as root):" >&2
    echo "  $(echo "$sshd_config" | head -1)" >&2
    exit 1
  fi
  interval=$(printf '%s\n' "$sshd_config" | awk '$1=="clientaliveinterval"{print $2; exit}')
  count=$(printf '%s\n' "$sshd_config" | awk '$1=="clientalivecountmax"{print $2; exit}')
  interval=${interval:-0}
  count=${count:-0}
  window=$((interval * count))
  echo "sshd keepalive: ClientAliveInterval=${interval}s ClientAliveCountMax=${count} -> dead peer detected after ${window}s"
  if [ "$interval" -eq 0 ]; then
    echo "FAIL: keepalive is disabled; a rebooted peer's forwards are held until the kernel gives up" >&2
    exit 1
  fi
  if [ "$window" -gt 120 ]; then
    echo "FAIL: ${window}s is too long; an automatic tunnel restart will collide with the stale listener" >&2
    echo "      Set ClientAliveInterval 30 + ClientAliveCountMax 4 (120s), or 15 + 4 (60s)." >&2
    echo "      Note OpenSSH uses the FIRST value it reads: a drop-in must sort BEFORE any" >&2
    echo "      existing one (e.g. /etc/ssh/sshd_config.d/00-keepalive.conf), or it is ignored." >&2
    exit 1
  fi
  echo "OK: a dead peer is detected within ${window}s"
fi

if [ "$CHECK" -eq 1 ] && [ "$REAP" -eq 0 ] && [ "$#" -eq 0 ]; then
  exit 0
fi

# --- stale forward reaping --------------------------------------------------
# For each port: find the sshd-session holding the listener, then ask whether
# that same process still has an ESTAB socket. `ss -tanp` lists the transport
# under both the privileged parent and the session child, so match the pid set
# of the whole session rather than one pid.
problems=0
reaped=0

for port in "${PORTS[@]}"; do
  holder=$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {print}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
  if [ -z "${holder:-}" ]; then
    printf '%-6s no listener (nothing to reap)\n' "$port"
    continue
  fi

  cmd=$(ps -o cmd= -p "$holder" 2>/dev/null || true)
  case "$cmd" in
    *sshd-session*) : ;;
    *)
      printf '%-6s held by pid %s (%s) — not sshd, leaving alone\n' "$port" "$holder" "$(echo "$cmd" | cut -c1-40)"
      continue
      ;;
  esac

  estab=$(ss -tanp 2>/dev/null | awk -v pid="pid=$holder," '$0 ~ pid && $1=="ESTAB"' | wc -l)
  if [ "$estab" -gt 0 ]; then
    printf '%-6s pid %-8s OK (%s established)\n' "$port" "$holder" "$estab"
    continue
  fi

  problems=$((problems + 1))
  printf '%-6s pid %-8s STALE (listener held, no established transport)\n' "$port" "$holder"
  if [ "$REAP" -eq 1 ]; then
    if kill "$holder" 2>/dev/null; then
      printf '%-6s killed %s\n' "$port" "$holder"
      reaped=$((reaped + 1))
    else
      printf '%-6s could not kill %s\n' "$port" "$holder" >&2
    fi
  fi
done

if [ "$REAP" -eq 1 ]; then
  echo
  echo "reaped ${reaped} stale session(s); restart the tunnel unit(s) to re-establish the forwards"
  exit 0
fi

if [ "$problems" -gt 0 ]; then
  echo
  echo "${problems} stale forward(s). Re-run with --reap to clear them." >&2
  exit 1
fi

echo
echo "all forwarded ports have a live transport"
