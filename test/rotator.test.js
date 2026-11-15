const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rotator = require("../rotator");

// Every case runs against a throwaway state dir so tests never read or write
// the operator's real ~/.opencode-free-bridge/rotator.json.
function freshStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocb-rotator-"));
}

async function withStateDir(dir, fn) {
  const prev = process.env.OPENCODE_BRIDGE_STATE_DIR;
  process.env.OPENCODE_BRIDGE_STATE_DIR = dir;
  try {
    // Await async bodies: the env var must stay set for every await inside,
    // or describe()/readEffective() would read the operator's real home dir.
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_BRIDGE_STATE_DIR;
    else process.env.OPENCODE_BRIDGE_STATE_DIR = prev;
  }
}

function writeConfig(dir, config) {
  fs.writeFileSync(path.join(dir, "rotator.json"), JSON.stringify(config));
}

const runOk = async () => ({ ok: true, error: null, output: "", stderr: "" });

describe("rotator", () => {
  let dir;

  beforeEach(() => {
    dir = freshStateDir();
    for (const env of ["WARP_ROTATE_CMD", "WARP_ROTATE_TIMEOUT_MS", "WARP_ROTATE_COOLDOWN_MS", "WARP_ROTATE_PROBE_URL"]) {
      delete process.env[env];
    }
    // Point the state dir at the throwaway BEFORE any __reset({keepConfig:
    // false}): with the env unset, configFile() resolves to the operator's
    // real ~/.opencode-free-bridge and the unlink deletes the live server's
    // rotator.json. Found by running this suite while a live bridge was up.
    process.env.OPENCODE_BRIDGE_STATE_DIR = dir;
    rotator.__reset({ keepConfig: false });
    rotator.__setProbeIntervalMs(1);
  });

  it("is disabled without a command and rotate() reports skipped", async () => {
    await withStateDir(dir, async () => {
      assert.equal(rotator.describe().enabled, false);
      const result = await rotator.rotate({ _probe: async () => ({ ip: "1.1.1.1", error: null }), _run: runOk });
      assert.equal(result.ok, false);
      assert.equal(result.skipped, "disabled");
    });
  });

  it("rotates and reports the IP transition", async () => {
    await withStateDir(dir, async () => {
      writeConfig(dir, { command: "noop" });
      // The pre-command probe sees the old IP; the post-command poll sees the
      // new one. That is the whole transition the module reports.
      let afterCommand = false;
      const result = await rotator.rotate({
        _probe: async () => ({ ip: afterCommand ? "2001:db8::2" : "2001:db8::1", error: null }),
        _run: async () => {
          afterCommand = true;
          return { ok: true, error: null, output: "", stderr: "" };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.changed, true);
      assert.equal(result.fromIp, "2001:db8::1");
      assert.equal(result.toIp, "2001:db8::2");

      const desc = rotator.describe();
      assert.equal(desc.enabled, true);
      assert.equal(desc.rotations, 1);
      assert.equal(desc.coolingForMs > 0, true);
      assert.equal(desc.lastResult.ok, true);
    });
  });

  it("skips while cooling after a rotation (single-flight guard)", async () => {
    await withStateDir(dir, async () => {
      writeConfig(dir, { command: "noop" });
      let afterCommand = false;
      await rotator.rotate({
        _probe: async () => ({ ip: afterCommand ? "b" : "a", error: null }),
        _run: async () => {
          afterCommand = true;
          return { ok: true, error: null, output: "", stderr: "" };
        },
      });
      const second = await rotator.rotate({
        _probe: async () => ({ ip: "b", error: null }),
        _run: runOk,
      });
      assert.equal(second.ok, false);
      assert.equal(second.skipped, "cooling");
    });
  });

  it("fails when the exit IP never changes before the deadline", async () => {
    await withStateDir(dir, async () => {
      writeConfig(dir, { command: "noop", timeoutMs: 3000 });
      const result = await rotator.rotate({
        _probe: async () => ({ ip: "same", error: null }),
        _run: runOk,
      });
      assert.equal(result.ok, false);
      assert.equal(result.changed, false);
      assert.match(result.error, /tidak berubah/);
      // A failed rotation still counts as an attempt: the hourly cap exists to
      // stop hammering the tunnel, success or failure alike.
      assert.equal(rotator.describe().rotations, 1);
    });
  });

  it("fails when the command fails and does not probe further", async () => {
    await withStateDir(dir, async () => {
      writeConfig(dir, { command: "noop" });
      let probes = 0;
      const result = await rotator.rotate({
        _probe: async () => ({ ip: `p${++probes}`, error: null }),
        _run: async () => ({ ok: false, error: "boom", output: "", stderr: "" }),
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /Perintah rotasi gagal/);
      assert.equal(probes, 1, "no polling after a failed command");
    });
  });

  it("env command locks the panel config", async () => {
    process.env.WARP_ROTATE_CMD = "echo hop";
    try {
      assert.equal(rotator.describe().locked, true);
      const result = rotator.setConfig({ command: "other" });
      assert.equal(result.ok, false);
      assert.match(result.error, /WARP_ROTATE_CMD/);
    } finally {
      delete process.env.WARP_ROTATE_CMD;
    }
  });

  it("setConfig round-trips and clearing the command disables", async () => {
    await withStateDir(dir, async () => {
      assert.equal(rotator.setConfig({ command: "hop.cmd" }).ok, true);
      assert.equal(rotator.describe().enabled, true);
      const bad = rotator.setConfig({ command: "x", probeUrl: "socks5://x" });
      assert.equal(bad.ok, false);
      assert.equal(rotator.setConfig({ command: "" }).ok, true);
      assert.equal(rotator.describe().enabled, false);
      // Command is written to disk 0600 and never echoed through describe().
      const raw = JSON.parse(fs.readFileSync(path.join(dir, "rotator.json"), "utf8"));
      assert.equal(raw.command, undefined);
    });
  });

  it("honours an unknown-ip probe (first probe with no prior IP still succeeds)", async () => {
    await withStateDir(dir, async () => {
      writeConfig(dir, { command: "noop" });
      let probes = 0;
      const result = await rotator.rotate({
        _probe: async () => (probes++ === 0 ? { ip: null, error: "probe down" } : { ip: "9.9.9.9", error: null }),
        _run: runOk,
      });
      assert.equal(result.ok, true);
      assert.equal(result.changed, false, "no previous IP to compare against");
      assert.equal(result.toIp, "9.9.9.9");
    });
  });

  it("hands rotate()'s egressUrl to the real probeExitIp", async () => {
    await withStateDir(dir, async () => {
      writeConfig(dir, { command: "noop" });
      // Stub ./proxy BEFORE rotator can require it, so probeExitIp's
      // late-require picks the stub up.
      const realProxy = require("../proxy");
      const realNetFetch = realProxy.netFetch;
      const seen = [];
      realProxy.netFetch = async (url, init, egressUrl) => {
        seen.push({ url: String(url), egressUrl });
        return {
          ok: true,
          status: 200,
          text: async () => `ip=${seen.length === 1 ? "10.0.0.1" : "10.0.0.2"}\n`,
        };
      };
      try {
        const result = await rotator.rotate({
          _run: runOk,
          egressUrl: "http://127.0.0.1:41987",
        });
        assert.equal(result.ok, true);
        assert.equal(result.fromIp, "10.0.0.1");
        assert.equal(result.toIp, "10.0.0.2");
        assert.equal(seen.length, 2, "pre-rotation + one post-command probe");
        for (const call of seen) {
          assert.equal(call.url, rotator.describe().probeUrl);
          assert.equal(call.egressUrl, "http://127.0.0.1:41987", "the probe rides the request egress");
        }
      } finally {
        // Restore by reference: __reload() re-reads config from disk and never
        // rebinds a stubbed module property, so a leaked stub here would make
        // every later suite's upstream response bodyless (body.getReader
        // undefined) — the exact cross-file failure this once caused.
        realProxy.netFetch = realNetFetch;
      }
    });
  });

  it("real probeExitIp with no egress fetches direct (TUN mode unchanged)", async () => {
    await withStateDir(dir, async () => {
      const proxyMod = require("../proxy");
      let usedNetFetch = false;
      const origNetFetch = proxyMod.netFetch;
      proxyMod.netFetch = async (...a) => {
        usedNetFetch = true;
        return origNetFetch(...a);
      };
      try {
        // No network in tests: expect the fetch to fail with a transport error,
        // which proves the probe took the direct fetch() path, not netFetch.
        const result = await rotator.probeExitIp("http://127.0.0.1:1/trace", 2000, null);
        assert.equal(usedNetFetch, false, "null egress must not touch proxy.netFetch");
        assert.equal(result.ip, null);
        assert.ok(result.error, "direct fetch to a closed port errors — probe attempted");
      } finally {
        proxyMod.netFetch = origNetFetch;
      }
    });
  });

  it("does not count a v4→v6 probe answer as a hop (same-family comparison)", async () => {
    await withStateDir(dir, async () => {
      // Short deadline: the failed rotation must resolve well inside bun's
      // 5s per-test timeout, which the 45s default would exceed.
      writeConfig(dir, { command: "noop", timeoutMs: 800 });
      // cdn-cgi/trace serves v4 and v6 from one URL; a direct Bun fetch can
      // flip families between polls. Found live: fromIp=104.28.x (v4) before
      // the hop, toIp=2a09:bac1::/64 (v6) after — string inequality would
      // claim success with no hop at all.
      const answers = [
        { ip: "104.28.204.79", error: null }, // pre-rotation, v4
        { ip: "2a09:bac1:34a0:10::3ab:9", error: null }, // post-command, v6 — not a hop
        { ip: "2a09:bac1:34a0:10::3ab:9", error: null }, // still v6
      ];
      const result = await rotator.rotate({
        _probe: async () => answers.shift() ?? { ip: null, error: "probe exhausted" },
        _run: runOk,
      });
      assert.equal(result.ok, false, "family change alone is not a hop");
      assert.equal(result.fromIp, "104.28.204.79");
      assert.equal(result.toIp, null);
      assert.match(result.error, /tidak berubah|unchanged|tenggat/);
    });
  });

  it("counts a same-family IP change as a hop", async () => {
    await withStateDir(dir, async () => {
      writeConfig(dir, { command: "noop" });
      const answers = [
        { ip: "104.28.204.79", error: null },
        { ip: "104.28.204.80", error: null },
      ];
      const result = await rotator.rotate({
        _probe: async () => answers.shift() ?? { ip: null, error: "probe exhausted" },
        _run: runOk,
      });
      assert.equal(result.ok, true);
      assert.equal(result.fromIp, "104.28.204.79");
      assert.equal(result.toIp, "104.28.204.80");
    });
  });

  it("records every attempt in describe().history with its trigger", { timeout: 15000 }, async () => {
    await withStateDir(dir, async () => {
      writeConfig(dir, { command: "noop", timeoutMs: 500, cooldownMs: 5000 });
      // Probe answers shift per call: pre-rotation v4, post-command changed v4
      // (a real hop), then everything after stays at the new address.
      const answers = ["104.28.204.79", "104.28.204.80"];
      await rotator.rotate({
        _probe: async () => ({ ip: answers.shift() ?? "104.28.204.80", error: null }),
        _run: runOk,
        trigger: "manual",
      });
      // Second call: the command itself fails (not a skip — a real attempt).
      // The first rotation's cooldown (floored at 5s by readEffective) would
      // make the second call skip as "cooling"; instead of poking module
      // internals, wait it out — cooldown 5000ms, rotation took ~0ms in the
      // fake-probe path, so a 5.2s wait clears it deterministically.
      await new Promise((resolve) => setTimeout(resolve, 5200));
      await rotator.rotate({
        _probe: async () => ({ ip: "104.28.204.80", error: null }),
        _run: async () => ({ ok: false, error: "boom", output: "", stderr: "" }),
        trigger: "429",
      });
      // Third call: skipped outright (disabled via empty command config). The
      // first rotation left a cooldown running (readEffective floors cooldownMs
      // at 5s even when the file says 0), but `disabled` skips happen before
      // the cooldown check, so this still lands in history as a skip.
      writeConfig(dir, {});
      const third = await rotator.rotate({ trigger: "429" });
      assert.equal(third.skipped, "disabled");
      const desc = rotator.describe();
      assert.ok(Array.isArray(desc.history), "history array present");
      assert.equal(desc.history.length, 3);
      const [first, second, skippedEntry] = desc.history;
      assert.equal(first.ok, true);
      assert.equal(first.trigger, "manual");
      assert.equal(first.fromIp, "104.28.204.79");
      assert.equal(first.toIp, "104.28.204.80");
      assert.equal(second.ok, false);
      assert.equal(second.skipped, null);
      assert.equal(second.trigger, "429");
      assert.match(second.error, /boom/);
      assert.equal(skippedEntry.skipped, "disabled");
      assert.equal(skippedEntry.ok, false);
      // Never leak the command through history entries.
      assert.equal(JSON.stringify(desc.history).includes("noop"), false);
    });
  });
});
