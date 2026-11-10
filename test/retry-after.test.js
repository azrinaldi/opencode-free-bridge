const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// server.js reads state from disk at require time; give it a throwaway dir so
// the test cannot touch a real installation.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-retryafter-test-"));
process.env.OPENCODE_BRIDGE_STATE_DIR = tmpDir;

const srv = require("../server");

/** Build the minimum response shape retryAfterMs reads. */
const res = (value) => ({ headers: { get: (name) => (name === "retry-after" ? value : null) } });

describe("retryAfterMs", () => {
  const fn = srv.__retryAfterMs;
  assert.equal(typeof fn, "function", "retryAfterMs must be exported for tests");

  it("reads the value upstream actually sends", () => {
    // Observed on a spent free-tier allowance: ~21.5 hours until the daily reset.
    assert.equal(fn(res("77415")), 77415 * 1000);
  });

  it("accepts delta-seconds", () => {
    assert.equal(fn(res("3600")), 3600 * 1000);
    assert.equal(fn(res("1")), 1000);
  });

  it("trims surrounding whitespace", () => {
    assert.equal(fn(res("  120  ")), 120 * 1000);
  });

  it("accepts an HTTP-date", () => {
    const target = Date.now() + 3_600_000;
    const got = fn(res(new Date(target).toUTCString()));
    // Second granularity in the header format, so allow a small window.
    assert.ok(got !== null && Math.abs(got - 3_600_000) < 2000, `got ${got}`);
  });

  // Every one of these must fall back to the caller's fixed cooldown rather
  // than parking an egress for zero or negative time.
  it("returns null when the header is absent", () => {
    assert.equal(fn(res(null)), null);
    assert.equal(fn({ headers: { get: () => null } }), null);
    assert.equal(fn({}), null);
    assert.equal(fn(undefined), null);
  });

  it("returns null for unparseable values", () => {
    assert.equal(fn(res("abc")), null);
    assert.equal(fn(res("")), null);
    assert.equal(fn(res("12.5")), null);
    assert.equal(fn(res("-60")), null);
  });

  it("returns null for zero, which would not park anything", () => {
    assert.equal(fn(res("0")), null);
  });

  it("returns null for a date in the past", () => {
    assert.equal(fn(res(new Date(Date.now() - 60_000).toUTCString())), null);
  });
});
