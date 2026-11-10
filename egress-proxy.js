#!/usr/bin/env bun
/**
 * egress-proxy.js: a minimal HTTP proxy, for turning a host into one pool entry.
 *
 * The bridge's pool speaks HTTP CONNECT (see proxy.js), so each pool member
 * needs something that answers CONNECT and forwards bytes — nothing more. This
 * is that: one process, no dependencies, no caching, no inspection. It exists
 * because the alternative is a full squid/nginx install on hosts where the
 * operator has no root, and because a pool entry only has to carry one
 * machine's egress.
 *
 * Deliberately NOT done here: TLS termination, header rewriting, logging of
 * request bodies, and any authentication beyond a shared token. The bridge
 * already tunnels TLS end to end, so this stays a byte pump and cannot see
 * plaintext.
 *
 * Reachability: the proxy binds loopback by default. Reaching it from another
 * host is the tunnel's job (an SSH `-L`), which also carries the authentication,
 * so a token is optional and only meaningful when the listener is exposed.
 *
 *   PORT=8888 EGRESS_PROXY_TOKEN=secret bun egress-proxy.js
 *   curl -x http://secret@node:8888 https://api.ipify.org
 */

const net = require("net");
const http = require("http");
const dns = require("dns");

// The free-tier gateway refuses IPv6 egress and accepts IPv4 (measured: the
// same request from the same host answers 200 over IPv4 and
// `429 FreeUsageLimitError` over IPv6). Bun's default order is `verbatim`,
// which on a dual-stack host resolves `opencode.ai` to AAAA first, so a pool
// member would tunnel every request out over the family the gateway refuses.
// `server.js` sets the same order for its own fetches; this process dials the
// upstream itself for every CONNECT, so it needs it too.
//
// `ipv6first` only exists from Node 22. Calling setDefaultResultOrder with an
// order the runtime does not know throws ERR_INVALID_ARG_VALUE, and because
// this runs at module load the proxy dies before it ever listens — an operator
// on Node 18 who set DNS_RESULT_ORDER=ipv6first lost the proxy entirely. The
// preference is honoured where it is understood and announced where it is not.
const dnsOrder = (() => {
  const wanted = String(process.env.DNS_RESULT_ORDER || "ipv4first").trim().toLowerCase();
  for (const order of [wanted, "ipv4first", "verbatim"]) {
    try {
      dns.setDefaultResultOrder(order);
      if (order !== wanted) {
        console.warn(
          `[egress-proxy] DNS_RESULT_ORDER=${wanted} is not supported by this Node (${process.versions.node}); using ${order}`
        );
      }
      return order;
    } catch {}
  }
  return null;
})();

const PORT = parseInt(process.env.PORT || "8888", 10);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = (process.env.EGRESS_PROXY_TOKEN || "").trim();
const CONNECT_TIMEOUT_MS = parseInt(process.env.CONNECT_TIMEOUT_MS || "15000", 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || "120000", 10);
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || "512", 10);

let active = 0;
const startedAt = Date.now();

function authorized(req) {
  if (!TOKEN) return true;
  // Proxy-Authorization: Basic base64(user:token). Only the password is
  // checked, because a proxy URL's user part is conventionally free-form.
  const header = req.headers["proxy-authorization"] || "";
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return password === TOKEN;
}

function requireAuth(res) {
  res.writeHead(407, {
    "Proxy-Authenticate": 'Basic realm="egress"',
    "Content-Type": "text/plain",
  });
  res.end("proxy authentication required\n");
}

/**
 * Refuse anything outside the two shapes a pool entry has to carry: CONNECT for
 * TLS, and absolute-URI HTTP for an occasional plaintext probe. A forward proxy
 * that accepts arbitrary methods is a bigger surface than this needs.
 */
const server = http.createServer((req, res) => {
  // Health is unauthenticated on purpose: it carries a connection count and an
  // uptime, and a monitor should not need the proxy credential to ask whether
  // the proxy is up. It never reports the token or a target.
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        role: "egress-proxy",
        activeConnections: active,
        uptimeMs: Date.now() - startedAt,
      })
    );
    return;
  }

  if (!authorized(req)) return requireAuth(res);

  const target = req.url || "";
  if (!/^http:\/\//i.test(target)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Only CONNECT and absolute http:// URLs are proxied." }));
    return;
  }

  const parsed = new URL(target);
  forwardHttp(req, res, parsed);
});

/** Plaintext HTTP forwarding: replay the request with origin-form path. */
function forwardHttp(clientReq, clientRes, target) {
  if (active >= MAX_CONNECTIONS) {
    clientRes.writeHead(503, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ error: "proxy connection limit reached" }));
    return;
  }
  active += 1;

  const headers = { ...clientReq.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  headers.host = target.host;

  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port || 80,
      method: clientReq.method,
      path: target.pathname + target.search,
      headers,
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
      upstreamRes.on("end", () => {
        active -= 1;
      });
    }
  );

  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    active -= 1;
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ error: `upstream: ${err.message}` }));
    } else {
      clientRes.destroy();
    }
  });
  clientReq.pipe(upstream);
}

/** CONNECT: open a raw TCP tunnel and join both directions. */
server.on("connect", (req, clientSocket, head) => {
  if (!authorized(req)) {
    clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"egress\"\r\n\r\n");
    return;
  }
  if (active >= MAX_CONNECTIONS) {
    clientSocket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }

  const [host, portRaw] = splitHostPort(req.url || "");
  const port = parseInt(portRaw || "443", 10);
  if (!host || !Number.isFinite(port)) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  active += 1;
  const upstream = net.connect({ host, port });

  upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy(new Error("idle timeout")));

  upstream.on("connect", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const close = () => {
    active = Math.max(0, active - 1);
    upstream.destroy();
    clientSocket.destroy();
  };

  upstream.on("error", () => {
    if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    close();
  });
  upstream.on("close", close);
  clientSocket.on("error", close);
  clientSocket.on("close", close);
});

function splitHostPort(value) {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return [null, null];
    return [value.slice(1, end), value.slice(end + 1).replace(/^:/, "")];
  }
  const index = value.lastIndexOf(":");
  if (index === -1) return [value, null];
  return [value.slice(0, index), value.slice(index + 1)];
}

server.listen(PORT, HOST, () => {
  console.log(
    `[egress-proxy] listening on ${HOST}:${PORT}` +
      (TOKEN ? " (token required)" : " (no token)")
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[egress-proxy] ${signal}: shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
