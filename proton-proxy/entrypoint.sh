#!/usr/bin/env bash
# Proton WireGuard + forward proxy for OCB. No netns: the container's own
# network namespace is the scoped tunnel. OCB decides when to rotate by
# walking its egress pool; this container only keeps the tunnel alive.
set -euo pipefail

: "${PROTON_DOMAIN:?set PROTON_DOMAIN (e.g. node-mx-13.protonvpn.net)}"
: "${PROTON_ENTRY_IP:?set PROTON_ENTRY_IP}"
: "${PROTON_PUBKEY:?set PROTON_PUBKEY}"
: "${KEYRING_FILE:?mount the Proton keyring at KEYRING_FILE}"
: "${CERT_FILE:?mount the Proton certificate at CERT_FILE}"
: "${WG_PRIVATE_KEY:?mount the WireGuard private key at WG_PRIVATE_KEY}"

mkdir -p /state
printf '{"type":"direct"}' > /state/upstream.json

# Capture the bridge gateway BEFORE touching routes — the tunnel endpoint
# must stay reachable through it, or WireGuard can never handshake.
HOST_GW=$(ip route show default | awk '/default via/{print $3; exit}')
echo "bridge gateway: ${HOST_GW:-none}"

# WireGuard inside the container.
ip link add proton0 type wireguard
wg set proton0 private-key "$WG_PRIVATE_KEY" \
    peer "$PROTON_PUBKEY" \
    allowed-ips 0.0.0.0/0,::/0 \
    endpoint "$PROTON_ENTRY_IP:51820" \
    persistent-keepalive 25
ip addr add 10.2.0.2/32 dev proton0
ip link set proton0 up

# Keep the endpoint on the bridge, then send everything else through proton0.
ip route add "$PROTON_ENTRY_IP/32" via "$HOST_GW" 2>/dev/null || true
ip route replace default dev proton0

# Keep the Proton local-agent session alive in the background. It reconnects
# automatically if the tunnel re-handshakes; the agent reads the mounted
# keyring and certificate read-only.
FREEHOP_KEYRING_GLOB="$KEYRING_FILE" \
FREEHOP_CERT_FILE="$CERT_FILE" \
python3 /app/freehop-agent.py "$PROTON_DOMAIN" &

# The forward proxy reads /state/upstream.json on every connection, so a
# future rotate only needs to rewrite that one tiny file.
exec python3 /app/freehop-proxy.py 0.0.0.0 18080
