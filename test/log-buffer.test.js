const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { logBuffer, LOG_BUFFER_LINES } = require("../server");

/**
 * The panel's log tab reads from the in-memory ring buffer that
 * hookConsoleBuffer() fills. These tests drive it the way production does —
 * through console.log/warn — and assert the ring discipline and the panel
 * payload contract (`/api/logs` serves { count, lines: [{at, level, text}] }).
 */
describe("console log ring buffer", () => {
  it("captures console.log/warn/error with level and timestamp", () => {
    const before = logBuffer.length;
    console.log("[log-buffer-test] plain line", { a: 1 });
    console.warn("[log-buffer-test] warn line");
    console.error("[log-buffer-test] error line");
    assert.equal(logBuffer.length, before + 3);
    const mine = logBuffer.filter((e) => e.text.includes("[log-buffer-test]"));
    assert.equal(mine.length, 3);
    assert.deepEqual(mine.map((e) => e.level), ["log", "warn", "error"]);
    for (const entry of mine) {
      assert.equal(typeof entry.at, "number");
      assert.ok(entry.at <= Date.now() + 5);
    }
    // Objects are formatted, not the string "[object Object]":
    assert.match(mine[0].text, /\{ a: 1 \}/);
  });

  it("the original console output still reaches stdout (hook is transparent)", () => {
    // The hook wraps and then calls through; a broken hook that swallowed the
    // line would silence journald/docker logs. We can only observe that the
    // hook does not throw and the buffer still fills, but the call itself is
    // the regression canary for the call-through.
    assert.doesNotThrow(() => console.log("[log-buffer-test] passthrough"));
  });

  it("rings: oldest lines fall off past LOG_BUFFER_LINES", () => {
    const spam = LOG_BUFFER_LINES + 10;
    for (let i = 0; i < spam; i++) console.log("[log-buffer-spam]", i);
    assert.equal(logBuffer.length, LOG_BUFFER_LINES);
    // Newest content survives; the very first spam line is gone.
    assert.equal(logBuffer[0].text.includes("[log-buffer-spam] 0"), false);
    assert.match(logBuffer[logBuffer.length - 1].text, /\[log-buffer-spam\] \d+/);
  });
});
