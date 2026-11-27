# Proton WireGuard forward proxy in a container

A scoped HTTP forward proxy whose egress is a Proton Free WireGuard tunnel.
It exists so an OCB host can add a Proton exit as an **egress pool member**
without touching host networking: WireGuard lives in the container's own
network namespace, so it cannot collide with a WARP TUN or host policy
routing. OCB still owns the decision of when to rotate; this proxy only
keeps the tunnel alive and forwards bytes.

Out of scope on purpose: the freehop watcher and any journal polling. Two
components rotating the same egress is a footgun. Register this proxy in
OCB's pool and let OCB's 429 handler walk it.

## Prerequisites

- A Proton Free account, logged in once with the official Proton VPN Linux
  client. That creates the SSO keyring this container mounts read-only.
- The keyring, certificate and WireGuard private key produced by
  [freehop](https://github.com/Urdemonlord/freehop) live on the host. This
  image does not mint credentials; it mounts them.

## Build and run

```bash
cd proton-proxy
cp .env.example .env
# fill PROTON_DOMAIN, PROTON_ENTRY_IP, PROTON_PUBKEY from
# ~/.local/share/freehop/logicals.json and rotate-state.json
# fill KEYRING_FILE, CERT_FILE, WG_PRIVATE_KEY with the paths on THIS host
docker compose up -d --build
docker logs proton-proxy          # expect: AGENT STATUS state=Connected
curl -x http://127.0.0.1:18080 https://ipv4.icanhazip.com
```

`.env.example` ships placeholders only, so it is safe to keep in the
repository. Fill in the real values in `.env`, which is git-ignored and never
copied into the image.

The proxy listens on `127.0.0.1:18080` on the host. Register it in OCB:

```bash
curl -s -X POST http://127.0.0.1:20129/api/proxy \
  -H 'Content-Type: application/json' \
  -d '{"pool":[{"id":"proton","label":"proton","url":"http://127.0.0.1:18080","enabled":true}],"strategy":"failover"}'
```

With two or more enabled pool members OCB disables its WARP rotator, so
there is a single rotation authority.

## Notes

- The endpoint IP is routed via the Docker bridge gateway before the default
  route is replaced with `proton0`, so the tunnel can always handshake.
- The forward proxy reads `upstream.json` on every connection; a future
  rotate only needs to rewrite that one file.
- Credentials are mounted read-only and never baked into the image.

## Attribution

`src/freehop-agent.py`, `src/freehop-proxy.py` and `src/freehop-rotate.py`
are copied from [freehop](https://github.com/Urdemonlord/freehop) (MIT,
Copyright (c) 2026 Hasrinata Arya Afendi). They are vendored here so the
image is self-contained; the upstream license applies to those files.
