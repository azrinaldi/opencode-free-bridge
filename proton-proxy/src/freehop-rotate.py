#!/usr/bin/env python3
"""Rotate the FreeHop egress to a fresh exit.
EGRESS_METHOD (config) picks the method, default proton:
  proton:     WireGuard to another Proton Free server (the original flow).
              Picks the lowest-load free (Tier 0, Status 1) server different
              from the current one. Steps: refresh logicals from API, swap
              wg peer, fix endpoint host route + /etc/hosts agent line,
              restart agent, verify exit IP. Refreshes the agent certificate
              if past its RefreshTime. Agent connect is retried up to 3
              times: the first connect after a peer swap often fails with
              APIError 86203 "session not found" and succeeds on retry with
              the same certificate.
  tor:        SIGNAL NEWNYM to the Tor control port, then verify the exit
              IP changed (up to 3 attempts). The proxy chains through Tor's
              SOCKS port; see upstream.json.
  proxy-pool: round-robin to the next upstream in PROXY_POOL, write it to
              upstream.json, verify the proxy still answers. A dead entry
              is skipped on the next attempt because the pointer advanced.
Never prints secrets. All paths come from the FreeHop config file
($FREEHOP_CONFIG or ~/.config/freehop/config).
Usage: freehop-rotate.py [--dry-run]
"""
import glob, json, os, re, socket, subprocess, sys, time, urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))


def load_config():
    cfg = {}
    path = os.environ.get("FREEHOP_CONFIG", os.path.expanduser("~/.config/freehop/config"))
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip('"').strip("'")
    def get(key, default=""):
        return os.path.expandvars(os.path.expanduser(cfg.get(key, default)))
    return get


CFG = load_config()
METHOD = CFG("EGRESS_METHOD", "proton")
NETNS = CFG("NETNS", "freehop")
WG_IF = CFG("WG_IF", "freehop0")
VETH_NS = CFG("VETH_NS", "veth-ns")
HOST_GW = CFG("HOST_IP", "10.200.0.1")
NS_IP = CFG("NS_IP", "10.200.0.2")
PROXY_PORT = CFG("PROXY_PORT", "18080")
STATE_DIR = CFG("STATE_DIR", "~/.local/share/freehop")
KEYRING_GLOB = CFG("KEYRING_GLOB", "~/.config/Proton/keyring-proton-sso-account-*.json")
CERT_FILE = os.path.join(STATE_DIR, "cert.json")
LOGICALS_FILE = os.path.join(STATE_DIR, "logicals.json")
STATE_FILE = os.path.join(STATE_DIR, "rotate-state.json")
UPSTREAM_FILE = os.path.join(STATE_DIR, "upstream.json")
POOL_STATE_FILE = os.path.join(STATE_DIR, "pool-state.json")
TOR_CONTROL = CFG("TOR_CONTROL", "127.0.0.1:9051")
PROXY_POOL = CFG("PROXY_POOL", "")
EXIT_IP_URL = CFG("EXIT_IP_URL", "https://api.ipify.org")
AGENT_PY = os.path.join(_HERE, "freehop-agent.py")
AGENT_LOG = os.path.join(STATE_DIR, "agent.log")

def run(cmd, check=True, timeout=60):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"CMD FAILED {r.returncode}: {cmd}\n{r.stdout}\n{r.stderr}")
    return r

def write_state(extra):
    st = {}
    try:
        st = json.load(open(STATE_FILE))
    except Exception:
        pass
    st.update(extra)
    st["rotated_at"] = int(time.time())
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(st, open(STATE_FILE, "w"))

def write_upstream(d):
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(d, open(UPSTREAM_FILE, "w"))

def exit_ip_via_proxy():
    r = run(f"curl -s --max-time 15 --noproxy '' -x http://{NS_IP}:{PROXY_PORT} {EXIT_IP_URL}", check=False)
    return r.stdout.strip()

def prev_exit_ip():
    try:
        return json.load(open(STATE_FILE)).get("exit_ip", "")
    except Exception:
        return ""

# ---- proton (original flow) ----

def load_keyring():
    files = glob.glob(KEYRING_GLOB)
    if not files:
        raise RuntimeError("no keyring file found (log in once with the Proton VPN client)")
    return json.load(open(sorted(files)[-1]))

def api_headers(kr):
    return {
        "x-pm-appversion": kr["LastUseData"]["appversion"],
        "Authorization": "Bearer " + kr["AccessToken"],
        "x-pm-uid": kr["UID"],
        "Content-Type": "application/json",
    }

def refresh_logicals(kr):
    req = urllib.request.Request("https://api.protonvpn.ch/vpn/logicals", headers=api_headers(kr))
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(data, open(LOGICALS_FILE, "w"))
    return data

def ensure_cert(kr):
    need = True
    if os.path.exists(CERT_FILE):
        try:
            cert = json.load(open(CERT_FILE))
            refresh_at = cert.get("Certificate", {}).get("RefreshTime", 0)
            need = int(time.time()) >= int(refresh_at) - 3600
        except Exception:
            need = True
    if not need:
        return
    sys.path.insert(0, "/usr/lib/python3/dist-packages")
    from proton.vpn.session.credentials import VPNSecrets
    priv = kr["vpn"]["secrets"]["ed25519_privatekey"]
    secrets = VPNSecrets.from_dict({"ed25519_privatekey": priv})
    body = json.dumps({"ClientPublicKey": secrets.ed25519_pk_pem, "Duration": "10080 min"}).encode()
    req = urllib.request.Request("https://api.protonvpn.ch/vpn/v1/certificate", data=body, headers=api_headers(kr), method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.load(r)
    if resp.get("Code") != 1000:
        raise RuntimeError(f"cert fetch failed: {resp.get('Code')} {resp.get('Error')}")
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(resp, open(CERT_FILE, "w"))
    os.chmod(CERT_FILE, 0o600)
    print("certificate refreshed")

def current_server():
    out = run(f"sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB ip netns exec {NETNS} wg show {WG_IF}").stdout
    ep = re.search(r"endpoint: ([0-9.]+):", out)
    return ep.group(1) if ep else None

def start_agent(domain, attempts=3):
    # First connect after a peer swap often fails transiently with
    # APIError 86203 "session not found", then succeeds on retry with the
    # same certificate. Retry the agent start instead of failing the rotate.
    # A failed attempt exits fast (AGENT ERROR in the log), so break the
    # wait early instead of burning the full 24s.
    last = ""
    for attempt in range(1, attempts + 1):
        run("sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB pkill -f freehop-agent.py || true", check=False)
        time.sleep(2)
        run(f"sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB ip netns exec {NETNS} nohup python3 {AGENT_PY} {domain} > {AGENT_LOG} 2>&1 &")
        for i in range(12):
            time.sleep(2)
            try:
                last = open(AGENT_LOG).read()
            except Exception:
                last = ""
            if "AGENT STATUS state=Connected" in last:
                print(f"agent connected (attempt {attempt})")
                return
            if "AGENT ERROR" in last:
                break
        print(f"agent attempt {attempt}/{attempts} failed: {last[-200:]}")
        time.sleep(3)
    raise RuntimeError(f"agent did not connect after {attempts} attempts: {last[-400:]}")

def rotate_proton(dry_run=False):
    kr = load_keyring()
    log = refresh_logicals(kr)
    items = log["LogicalServers"]
    cur_ip = current_server()
    print("current endpoint:", cur_ip)
    free = [s for s in items if s.get("Tier") == 0 and s.get("Status") == 1]
    free.sort(key=lambda s: s.get("Load", 99))
    target = None
    for s in free:
        if s["Servers"][0]["EntryIP"] != cur_ip:
            target = s
            break
    if not target:
        raise RuntimeError("no alternative free server found")
    srv = target["Servers"][0]
    print(f"target: {target['Name']} load {target.get('Load')} domain {target['Domain']} entry {srv['EntryIP']}")
    if dry_run:
        print("dry-run, no changes made")
        return target["Name"], None
    ensure_cert(kr)
    pubkey = srv["X25519PublicKey"]
    new_ip, new_domain = srv["EntryIP"], target["Domain"]
    out = run(f"sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB ip netns exec {NETNS} wg show {WG_IF}").stdout
    m = re.search(r"peer: (\S+)", out)
    old_peer = m.group(1) if m else None
    run("sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB pkill -f freehop-agent.py || true", check=False)
    time.sleep(2)
    if old_peer:
        run(f"sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB ip netns exec {NETNS} wg set {WG_IF} peer {old_peer} remove")
    run(f"sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB ip netns exec {NETNS} wg set {WG_IF} peer {pubkey} allowed-ips 0.0.0.0/0,::/0 endpoint {new_ip}:51820 persistent-keepalive 25")
    if cur_ip:
        run(f"sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB ip netns exec {NETNS} ip route del {cur_ip}/32 2>/dev/null || true", check=False)
    run(f"sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB ip netns exec {NETNS} ip route add {new_ip}/32 via {HOST_GW} dev {VETH_NS}")
    run("sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB sed -i '/# freehop-agent-scoped/d' /etc/hosts")
    run(f"echo '{new_ip} {new_domain} # freehop-agent-scoped' | sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB tee -a /etc/hosts > /dev/null")
    start_agent(new_domain)
    time.sleep(2)
    exit_ip = run(f"sudo -n --preserve-env=HOME,FREEHOP_KEYRING_GLOB ip netns exec {NETNS} curl -s --max-time 15 {EXIT_IP_URL}").stdout.strip()
    print("new exit IP:", exit_ip)
    write_state({"method": "proton", "server": target["Name"], "domain": new_domain, "exit_ip": exit_ip})
    return target["Name"], exit_ip

# ---- tor ----

def tor_control(cmds, timeout=15):
    host, _, port = TOR_CONTROL.rpartition(":")
    s = socket.create_connection((host, int(port or 9051)), timeout=timeout)
    f = s.makefile("rwb")
    out = []
    try:
        for cmd in cmds:
            f.write((cmd + "\r\n").encode())
            f.flush()
            while True:
                line = f.readline().decode(errors="ignore").strip()
                if not line:
                    raise RuntimeError("tor control port closed")
                out.append(line)
                if re.match(r"^\d{3} ", line):
                    break
                if re.match(r"^5\d{2} ", line):
                    raise RuntimeError(f"tor control error: {line}")
    finally:
        try: f.close()
        except Exception: pass
        s.close()
    return out

def rotate_tor(dry_run=False):
    prev = prev_exit_ip()
    print("tor: current exit IP:", prev or "(unknown)")
    if dry_run:
        print("tor: would send SIGNAL NEWNYM, no changes made")
        return "tor", None
    for attempt in range(1, 4):
        tor_control(["AUTHENTICATE", "SIGNAL NEWNYM", "QUIT"])
        print(f"tor: NEWNYM sent (attempt {attempt}/3), waiting for a new circuit")
        time.sleep(10)
        ip = exit_ip_via_proxy()
        print(f"tor: exit IP now {ip or '(unreachable)'}")
        if ip and ip != prev:
            write_state({"method": "tor", "server": "tor", "exit_ip": ip})
            return "tor", ip
        time.sleep(5)
    raise RuntimeError("tor exit IP did not change after 3 NEWNYM signals")

# ---- proxy-pool ----

def parse_pool():
    pool = []
    for entry in PROXY_POOL.split(","):
        entry = entry.strip()
        if not entry:
            continue
        scheme, _, rest = entry.partition("://")
        if scheme not in ("http", "socks5") or not rest:
            raise RuntimeError(f"bad PROXY_POOL entry (want http:// or socks5://host:port): {entry}")
        host, _, port = rest.rpartition(":")
        pool.append((scheme, host, int(port or 80)))
    return pool

def rotate_pool(dry_run=False):
    pool = parse_pool()
    if not pool:
        raise RuntimeError("PROXY_POOL is empty (set it in the config)")
    try:
        idx = int(json.load(open(POOL_STATE_FILE)).get("index", -1))
    except Exception:
        idx = -1
    nxt = (idx + 1) % len(pool)
    scheme, host, port = pool[nxt]
    print(f"pool: next upstream {scheme}://{host}:{port} ({nxt + 1}/{len(pool)})")
    if dry_run:
        print("pool: dry-run, no changes made")
        return "proxy-pool", None
    write_upstream({"type": scheme, "host": host, "port": port})
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump({"index": nxt}, open(POOL_STATE_FILE, "w"))
    time.sleep(2)
    ip = exit_ip_via_proxy()
    if not ip:
        raise RuntimeError(f"pool upstream {scheme}://{host}:{port} unreachable via proxy")
    print("pool: exit IP now", ip)
    write_state({"method": "proxy-pool", "server": "proxy-pool", "upstream": f"{scheme}://{host}:{port}", "exit_ip": ip})
    return "proxy-pool", ip

# ---- dispatch ----

def rotate(dry_run=False):
    if METHOD == "proton":
        return rotate_proton(dry_run)
    if METHOD == "tor":
        return rotate_tor(dry_run)
    if METHOD == "proxy-pool":
        return rotate_pool(dry_run)
    raise RuntimeError(f"unknown EGRESS_METHOD: {METHOD} (want proton, tor, or proxy-pool)")

if __name__ == "__main__":
    import contextlib, json as _json
    want_json = "--json" in sys.argv
    if want_json:
        # Progress lines go to stderr so stdout stays one JSON object.
        with contextlib.redirect_stdout(sys.stderr):
            name, ip = rotate(dry_run="--dry-run" in sys.argv)
        print(_json.dumps({"method": METHOD, "server": name, "exit_ip": ip, "rotated_at": int(time.time())}))
    else:
        name, ip = rotate(dry_run="--dry-run" in sys.argv)
        print(f"DONE method={METHOD} server={name} exit_ip={ip}")
