#!/usr/bin/env bun
/**
 * tor-control.js: minimal Tor control protocol client for circuit renewal.
 *
 * Tor exposes a control socket (default 127.0.0.1:9051) where an authenticated
 * client can send `SIGNAL NEWNYM` to request a fresh circuit. This module does
 * exactly that one job, with no dependencies beyond Node's `net` and `fs`.
 *
 * The bridge cannot use Tor as an HTTP proxy directly (Bun's fetch rejects
 * socks5://), so an HTTP proxy in front of Tor remains the egress. Rotation
 * changes the circuit behind that proxy; the rotator verifies the new exit IP
 * through the same egress and only reports success when it actually changed.
 */

const net = require("net");
const fs = require("fs");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9051;
const DEFAULT_TIMEOUT_MS = 10_000;

function escapePassword(password) {
  return String(password).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Send SIGNAL NEWNYM over the Tor control socket.
 *
 * Options:
 *   host, port        control endpoint (defaults above)
 *   password          AUTHENTICATE "password"
 *   cookiePath        file whose bytes are hex-encoded into AUTHENTICATE
 *   timeoutMs         socket deadline
 *   connect           injected (options) => EventEmitter-like net.Socket
 *
 * Resolves { ok, error, reply } where `reply` is the raw NEWNYM reply line.
 */
async function newnym({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  password = null,
  cookiePath = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  connect = null,
} = {}) {
  if (!password && !cookiePath) {
    return { ok: false, error: "Tor control needs a password or cookie file", reply: null };
  }

  let authLine;
  if (cookiePath) {
    try {
      const hex = fs.readFileSync(cookiePath).toString("hex");
      authLine = `AUTHENTICATE ${hex}`;
    } catch (err) {
      return { ok: false, error: `Gagal membaca cookie Tor: ${err.message}`, reply: null };
    }
  } else {
    authLine = `AUTHENTICATE "${escapePassword(password)}"`;
  }

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve(result);
    };

    const socket = connect
      ? connect({ host, port })
      : net.connect({ host, port });

    const timer = setTimeout(() => {
      finish({ ok: false, error: `Tor control timeout after ${timeoutMs} ms`, reply: null });
    }, timeoutMs);

    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      // Tor control replies are line-based; 250 is success. A `250+...` line
      // starts a multiline reply terminated by a single `250` line. We only
      // need readiness, so any `250` line moves us to the next step.
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        const code = line.slice(0, 3);
        if (stage === "greeting") {
          if (code !== "250") return finish({ ok: false, error: `Tor greeting ditolak: ${line.slice(0, 300)}`, reply: line });
          stage = "auth";
          socket.write(`${authLine}\r\n`);
        } else if (stage === "auth") {
          if (code !== "250") return finish({ ok: false, error: `Tor AUTHENTICATE gagal: ${line.slice(0, 300)}`, reply: line });
          stage = "newnym";
          socket.write("SIGNAL NEWNYM\r\n");
        } else if (stage === "newnym") {
          if (code !== "250") return finish({ ok: false, error: `Tor SIGNAL NEWNYM gagal: ${line.slice(0, 300)}`, reply: line });
          socket.write("QUIT\r\n");
          finish({ ok: true, error: null, reply: line });
        }
      }
    };

    let stage = "greeting";
    socket.on("data", onData);
    socket.on("error", (err) => finish({ ok: false, error: `Tor control error: ${err.message}`, reply: null }));
    socket.on("close", () => {
      if (!settled) finish({ ok: false, error: "Tor control socket closed early", reply: null });
    });
    if (typeof socket.setTimeout === "function") socket.setTimeout(timeoutMs);
  });
}

module.exports = { newnym, DEFAULT_HOST, DEFAULT_PORT };
