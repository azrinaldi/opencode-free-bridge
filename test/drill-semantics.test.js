"use strict";
// Semantics contract of gate-drill.js: an undecided live drill is a SKIP, not
// a failure. 2026-11 CI: a 429 burst closed the upstream gate, the live drills
// could not be judged, and undecided results were counted as failures — the
// pipeline went red on a healthy bridge. These tests pin the tri-state
// contract so the exit code is decided only by offline drills and real
// upstream verdicts.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const drill = require("../gate-drill.js");
const { judge, DRILLS } = drill;
const DRILL_SRC = fs.readFileSync(path.join(__dirname, "..", "gate-drill.js"), "utf8");

test("judge: a passing check is true regardless of gate state", () => {
  assert.strictEqual(judge(true, true), true);
  assert.strictEqual(judge(true, false), true);
});

test("judge: an undecided check on a busy gate is null (SKIP), never false", () => {
  // 429 capacity / closed gate means upstream gave no verdict — the drill
  // must not translate that into a bridge fault.
  assert.strictEqual(judge(false, true), null);
});

test("judge: an undecided check on an open gate is a real failure", () => {
  assert.strictEqual(judge(false, false), false);
});

test("live drills are skipped (null), not failed, when the control probe is refused", () => {
  // main() pushes null for every live drill the closed gate could not judge;
  // the summary line must read SKIP for exactly those.
  assert.match(
    DRILL_SRC,
    /results\.push\(\[name, null\]\); \/\/ skipped, not failed/,
    "live drills under a closed gate must be recorded as undecided",
  );
  assert.match(
    DRILL_SRC,
    /\$\{ok === null \? "SKIP" : ok \? "PASS" : "FAIL"\}/,
    "summary must render undecided results as SKIP",
  );
});

test("exit code is decided only by explicit failures, never by undecided results", () => {
  assert.match(
    DRILL_SRC,
    /const failed = results\.filter\(\(\[, ok\]\) => ok === false\);/,
    "only ok === false counts as failed",
  );
  assert.match(
    DRILL_SRC,
    /process\.exit\(failed\.length === 0 \? 0 : 1\);/,
    "exit 0 when nothing failed, regardless of skips",
  );
});

test("busy-gate heal assertions in the live drills use the tri-state", () => {
  // The heal half of version-floor and session-shape needs upstream to have
  // issued a gate verdict; a 429 never triggers the refresh, so those
  // assertions must be lineMaybe (null on busy), not hard line() checks.
  for (const [name, nextName] of [
    ["drillVersionFloor", "drillLegacyShape"],
    ["drillSessionShape", "drillRouting"],
  ]) {
    const start = DRILL_SRC.indexOf(`async function ${name}(`);
    const next = DRILL_SRC.indexOf(`async function ${nextName}(`);
    assert.ok(start > 0 && next > start, `${name} not found in gate-drill.js`);
    const body = DRILL_SRC.slice(start, next);
    const busyAware = body.match(/lineMaybe\(judge\([^)]*busy\)/g) ?? [];
    assert.ok(
      busyAware.length >= 3,
      `${name} should judge its assertions through the tri-state (found ${busyAware.length})`,
    );
    assert.doesNotMatch(
      body,
      /^\s*line\(/m,
      `${name} must not hard-fail assertions upstream cannot always judge`,
    );
  }
});
