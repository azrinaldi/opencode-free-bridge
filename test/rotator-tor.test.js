const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const torControl = require("../tor-control");

function fakeConnect(replies, capture = null) {
  const remaining = [...replies];
  return () => {
    const handlers = {};
    const socket = {
      on(event, fn) { handlers[event] = fn; return socket; },
      write(data) {
        if (capture) capture.written.push(data);
        const line = remaining.shift();
        if (line !== undefined && handlers.data) {
          handlers.data(Buffer.from(line + "\r\n"));
        }
      },
      setTimeout() {},
      destroy() {},
    };
    queueMicrotask(() => {
      const greeting = remaining.shift();
      if (greeting !== undefined && handlers.data) handlers.data(Buffer.from(greeting + "\r\n"));
    });
    return socket;
  };
}

describe("tor-control.newnym", () => {
  it("sends AUTHENTICATE with a quoted password and SIGNAL NEWNYM", async () => {
    const capture = { written: [] };
    const result = await torControl.newnym({
      password: "secret",
      connect: fakeConnect(["250 Tor ready", "250 OK", "250 OK"], capture),
    });
    assert.equal(result.ok, true);
    assert.match(result.reply, /250 OK/);
    assert.equal(capture.written[0], 'AUTHENTICATE "secret"\r\n');
    assert.equal(capture.written[1], "SIGNAL NEWNYM\r\n");
    assert.equal(capture.written[2], "QUIT\r\n");
  });

  it("sends hex cookie bytes for cookie auth", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-tor-cookie-"));
    const cookie = path.join(dir, "control_auth_cookie");
    fs.writeFileSync(cookie, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const capture = { written: [] };
    const result = await torControl.newnym({
      cookiePath: cookie,
      connect: fakeConnect(["250 Tor ready", "250 OK", "250 OK"], capture),
    });
    assert.equal(result.ok, true);
    assert.equal(capture.written[0], "AUTHENTICATE deadbeef\r\n");
  });

  it("escapes quotes and backslashes in passwords", async () => {
    const capture = { written: [] };
    await torControl.newnym({
      password: 'p"ass\\word',
      connect: fakeConnect(["250 Tor ready", "250 OK", "250 OK"], capture),
    });
    assert.equal(capture.written[0], 'AUTHENTICATE "p\\"ass\\\\word"\r\n');
  });

  it("reports a non-250 reply as an error", async () => {
    const result = await torControl.newnym({
      password: "bad",
      connect: fakeConnect(["250 Tor ready", "515 Authentication failed"]),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /AUTHENTICATE|Authentication failed/);
  });

  it("requires either a password or a cookie file", async () => {
    const result = await torControl.newnym({});
    assert.equal(result.ok, false);
    assert.match(result.error, /password|cookie/i);
  });
});
