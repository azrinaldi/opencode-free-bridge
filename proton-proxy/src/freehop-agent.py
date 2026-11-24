#!/usr/bin/env python3
"""Proton VPN local agent: keeps the free-server session alive.
Reads the Proton keyring (created when you log in once with the official
Proton VPN client) and the certificate FreeHop fetched. Never prints secrets.
The WireGuard private key itself is derived from the same keyring by
freehop-netns.sh setup; this agent only holds the session.
Usage: freehop-agent.py [server-domain]
"""
import asyncio, glob, json, os, sys
sys.path.insert(0, "/usr/lib/python3/dist-packages")
from proton.vpn.platform.local_agent import Listener
from proton.vpn.session.credentials import VPNSecrets

def _cfg(key, default):
    return os.path.expandvars(os.path.expanduser(os.environ.get(key, default)))

KEYRING_GLOB = _cfg("FREEHOP_KEYRING_GLOB", "~/.config/Proton/keyring-proton-sso-account-*.json")
CERT_FILE = _cfg("FREEHOP_CERT_FILE", "~/.local/share/freehop/cert.json")

kf = sorted(glob.glob(KEYRING_GLOB))
if not kf:
    raise SystemExit("no keyring file found (log in once with the Proton VPN client)")
d = json.load(open(kf[-1]))
priv = d["vpn"]["secrets"]["ed25519_privatekey"]
key_pem = VPNSecrets.from_dict({"ed25519_privatekey": priv}).get_ed5519_sk_pem()
cert_pem = json.load(open(CERT_FILE))["Certificate"]
domain = sys.argv[1] if len(sys.argv) > 1 else "node-us-175.protonvpn.net"
def on_status(status):
    print(f"AGENT STATUS state={status.state} reason={status.reason}", flush=True)
def on_error(err):
    print(f"AGENT ERROR {err!r}", flush=True)
async def main():
    print(f"AGENT connecting to {domain}...", flush=True)
    listener = await Listener.connect(domain, key_pem, cert_pem, 30)
    print("AGENT CONNECTED", flush=True)
    await listener.listen(on_status, on_error)
    print("AGENT LISTEN ENDED", flush=True)
asyncio.run(main())
