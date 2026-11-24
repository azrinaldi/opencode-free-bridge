#!/usr/bin/env python3
"""Minimal HTTP forward proxy. Runs INSIDE the FreeHop netns and only
forwards traffic for clients that point at it (your gateway), so the
rest of the machine keeps its normal connection.
Supports CONNECT (https) and absolute-URI http. No logging of content.

Egress methods: the proxy reads $STATE_DIR/upstream.json on every new
connection (cheap, tiny file) so a rotate takes effect without a
restart. The file is written by setup/rotate and holds one of:
  {"type": "direct"}                       Proton method (WireGuard).
  {"type": "socks5", "host": h, "port": p} Tor method (Tor SOCKS port).
  {"type": "http", "host": h, "port": p}   Proxy-pool method (an HTTP proxy).
Missing or invalid file means direct. SOCKS5 is no-auth only.
Usage: freehop-proxy.py [bind-host] [port]
Defaults: $FREEHOP_PROXY_HOST or 0.0.0.0, $FREEHOP_PROXY_PORT or 18080.
STATE_DIR comes from $STATE_DIR or ~/.local/share/freehop.
"""
import json, os, socket, sys, threading
HOST = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("FREEHOP_PROXY_HOST", "0.0.0.0")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else int(os.environ.get("FREEHOP_PROXY_PORT", "18080"))
STATE_DIR = os.environ.get("STATE_DIR", os.path.expanduser("~/.local/share/freehop"))
UPSTREAM_FILE = os.path.join(STATE_DIR, "upstream.json")

def load_upstream():
    try:
        d = json.load(open(UPSTREAM_FILE))
        t = d.get("type", "direct")
        if t in ("socks5", "http"):
            return (t, (str(d["host"]), int(d["port"])))
    except Exception:
        pass
    return ("direct", None)

def _recv_exact(s, n):
    buf = b""
    while len(buf) < n:
        chunk = s.recv(n - len(buf))
        if not chunk:
            raise RuntimeError("upstream reply truncated")
        buf += chunk
    return buf

def socks5_connect(up_host, up_port, host, port, timeout=30):
    s = socket.create_connection((up_host, up_port), timeout=timeout)
    s.sendall(b"\x05\x01\x00")
    if _recv_exact(s, 2) != b"\x05\x00":
        s.close()
        raise RuntimeError("socks5 no-auth rejected")
    hb = host.encode()
    s.sendall(b"\x05\x01\x00\x03" + bytes([len(hb)]) + hb + port.to_bytes(2, "big"))
    head = _recv_exact(s, 4)
    if head[1] != 0x00:
        s.close()
        raise RuntimeError(f"socks5 connect refused: {head[1]}")
    atyp = head[3]
    if atyp == 1:
        _recv_exact(s, 4 + 2)
    elif atyp == 3:
        n = _recv_exact(s, 1)[0]
        _recv_exact(s, n + 2)
    elif atyp == 4:
        _recv_exact(s, 16 + 2)
    else:
        s.close()
        raise RuntimeError(f"socks5 bad address type: {atyp}")
    return s

def http_upstream_connect(up_host, up_port, host, port, timeout=30):
    s = socket.create_connection((up_host, up_port), timeout=timeout)
    s.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())
    resp = b""
    while b"\r\n\r\n" not in resp and len(resp) < 65536:
        chunk = s.recv(4096)
        if not chunk:
            s.close()
            raise RuntimeError("http upstream closed before 200")
        resp += chunk
    status = resp.split(b"\r\n")[0]
    if b" 200 " not in status:
        s.close()
        raise RuntimeError(f"http upstream refused: {status[:120]!r}")
    return s

def connect_upstream(upstream, host, port, tunnel=False):
    # tunnel=True is the CONNECT case (https): the upstream must open a
    # tunnel to the target (SOCKS5 CONNECT, or an HTTP CONNECT). A plain
    # http request must NOT open a tunnel first: an HTTP upstream gets
    # the absolute-URI request on a plain connection, and a SOCKS5
    # upstream gets the origin-form request on a tunnel to the target.
    kind, addr = upstream
    if kind == "socks5":
        return socks5_connect(addr[0], addr[1], host, port)
    if kind == "http":
        if tunnel:
            return http_upstream_connect(addr[0], addr[1], host, port)
        return socket.create_connection(addr, timeout=30)
    return socket.create_connection((host, port), timeout=30)

def relay(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data: break
            b.sendall(data)
    except Exception:
        pass
    finally:
        try: b.shutdown(socket.SHUT_WR)
        except Exception: pass

def handle(client):
    try:
        req = b""
        while b"\r\n\r\n" not in req and len(req) < 65536:
            chunk = client.recv(4096)
            if not chunk: return
            req += chunk
        head, _, rest = req.partition(b"\r\n\r\n")
        line = head.split(b"\r\n")[0].decode(errors="ignore")
        parts = line.split(" ")
        if len(parts) < 2: return
        method, target = parts[0], parts[1]
        upstream = load_upstream()
        if method.upper() == "CONNECT":
            host, _, port = target.rpartition(":")
            port = int(port or 443)
            up = connect_upstream(upstream, host, port, tunnel=True)
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            t1 = threading.Thread(target=relay, args=(client, up), daemon=True)
            t2 = threading.Thread(target=relay, args=(up, client), daemon=True)
            t1.start(); t2.start(); t1.join(); t2.join()
            up.close()
        else:
            # absolute URI form: http://host:port/path (port may be omitted)
            if target.startswith("http://"):
                u = target[7:]
                hostport, _, path = u.partition("/")
                if ":" in hostport:
                    host, _, port = hostport.rpartition(":")
                    port = int(port or 80)
                else:
                    host, port = hostport, 80
                path = "/" + path
            else:
                return
            up = connect_upstream(upstream, host, port, tunnel=False)
            if upstream[0] == "http":
                # An HTTP upstream expects the absolute URI, on a plain
                # connection (no CONNECT first). Forward as-is.
                up.sendall(head + b"\r\n\r\n" + rest)
            else:
                # Direct and SOCKS5 are a plain tunnel to the target, so
                # the request line uses the origin form (path only).
                newhead = head.replace(target.encode(), path.encode(), 1)
                up.sendall(newhead + b"\r\n\r\n" + rest)
            t1 = threading.Thread(target=relay, args=(client, up), daemon=True)
            t2 = threading.Thread(target=relay, args=(up, client), daemon=True)
            t1.start(); t2.start(); t1.join(); t2.join()
            up.close()
    except Exception as e:
        print(f"proxy err: {e}", flush=True)
    finally:
        try: client.close()
        except Exception: pass

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind((HOST, PORT)); srv.listen(50)
print(f"freehop forward proxy listening on {HOST}:{PORT}", flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
