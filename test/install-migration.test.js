"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const INSTALLER = path.join(__dirname, "..", "install.sh");

function hasInstaller() {
  return fs.existsSync(INSTALLER);
}

test("installer installs Bun itself instead of dead-ending the user", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // Telling a new user "install Bun first" and exiting defeats the point of a
  // one-line installer. It must fetch Bun, and still never fall back to Node
  // unless ALLOW_NODE is explicit.
  assert.match(src, /bun\.sh\/install/, "installer must install Bun when it is missing");
  assert.match(src, /ALLOW_NODE/);
  assert.doesNotMatch(src, /Bun is required but not found/, "installer must not dead-end on a missing Bun");
  // Every runtime invocation must go through $RUNTIME, not a hardcoded node.
  const hardcoded = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .filter((l) => /\bnode\s+["']?\$?BINDIR/.test(l) || /nohup node /.test(l));
  assert.deepEqual(hardcoded, [], "installer still hardcodes node for execution");
});

test("installer fetches every file the runtime needs", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  for (const f of [
    "server.js",
    "identity.js",
    "token-budget.js",
    "verify.js",
    "gate-drill.js",
    "transport-fingerprint.js",
    "transport-baseline.json",
  ]) {
    assert.match(src, new RegExp(`fetch ${f.replace(".", "\\.")}`), `installer does not fetch ${f}`);
  }
});

test("installer ships tunnel-doctor.sh, and validates it before swapping files", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // A file that is committed but never fetched is invisible to every install
  // made with the one-liner, which is how tunnel-doctor.sh first shipped.
  assert.match(src, /fetch tunnel-doctor\.sh/, "installer does not fetch tunnel-doctor.sh");
  assert.match(
    src,
    /mv -f "\$STAGE\/\$file" "\$BINDIR\/\$file"[\s\S]*tunnel-doctor\.sh|tunnel-doctor\.sh; do[\s\S]*mv -f/,
    "tunnel-doctor.sh is fetched but never moved into BINDIR"
  );
  assert.match(src, /chmod \+x[^\n]*tunnel-doctor\.sh/, "tunnel-doctor.sh is installed without the execute bit");
  // `new Function` cannot parse bash; only `bash -n` can, and it must run
  // before the running bridge is stopped. Compare against the *call* site:
  // indexOf("stop_own_bridge") would find the function definition at line 255.
  const syntaxAt = src.indexOf("bash -n");
  const stopAt = src.indexOf("\nstop_own_bridge\n");
  assert.ok(syntaxAt > -1, "installer never syntax-checks tunnel-doctor.sh");
  assert.ok(stopAt > -1, "installer never calls stop_own_bridge");
  assert.ok(syntaxAt < stopAt, "tunnel-doctor.sh must be validated before the old bridge is stopped");
});

test("installer backs up an existing install before overwriting", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /\.backup-v/);
  assert.match(src, /cp -p/);
});

test("installer rewrites a service unit that points at node", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /migrate_service_runtime/);
  assert.match(src, /ExecStart=/);
  assert.match(src, /\.bak/);
});

test("installer writes a systemd unit systemd actually accepts", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // systemd does not strip quotes on WorkingDirectory=; it treats them as part
  // of the path and fails with "path is not absolute". ExecStart= does parse
  // quotes, so only the directory must stay bare.
  assert.doesNotMatch(src, /^WorkingDirectory="/m, "WorkingDirectory must not be quoted");
  assert.match(src, /^WorkingDirectory=\$BINDIR$/m);
  // A failed restart must not be reported as success.
  assert.match(src, /if ! systemctl restart opencode-free-bridge/);
});

test("verify.js separates an IP throttle from a broken bridge", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "verify.js"), "utf8");
  // A 403 FreeTierError is upstream refusing the network, not a bridge fault.
  // Reporting it as FAIL made a correct install look broken on a throttled VPS.
  assert.match(src, /gate-closed/, "verify.js must have a distinct gate-closed state");
  assert.match(src, /process\.exit\(2\)/, "verify.js must exit 2 when only the IP is refused");
  assert.match(src, /free tier can only be used/i, "verify.js must recognise the upstream refusal body");
});

test("installer reports the self-check outcome instead of always claiming a timeout", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /CHECK_RC/, "installer must capture the self-check exit code");
  assert.match(src, /124\)/, "installer must distinguish a real timeout");
});

test("installer finds bun installed outside PATH", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // `curl https://bun.sh/install | bash` only edits an interactive shell's
  // PATH. A non-interactive SSH session sees no bun even though it is present,
  // which is exactly how a VPS install fails after a successful bun install.
  assert.match(src, /find_bun/, "installer must probe standard bun locations");
  assert.match(src, /\.bun\/bin\/bun/, "installer must look in ~/.bun/bin");
});

test("installer survives a probe that matches nothing under pipefail", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // set -euo pipefail + `grep` with no match exits 1 and aborted the whole
  // install with no message. Empty probes must be tolerated.
  assert.match(src, /pid_on_port/, "pid probing must go through a pipefail-safe helper");
  assert.match(src, /grep -oP 'pid=\\K\[0-9\]\+' \| head -1 \|\| true/);
});

test("installer can replace its own running bridge", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // Re-running the installer is the documented update path, so a bridge this
  // installer started is not a port conflict. Only a foreign process is.
  assert.match(src, /port_held_by_own_bridge/);
  assert.match(src, /stop_own_bridge/);
  assert.match(src, /! port_held_by_own_bridge/);
});

test("installer parses staged files instead of running bun --check", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // `bun --check` is not a flag Bun supports. Bun treats the argument as an
  // entrypoint and runs it, which started a server mid-install and made every
  // upgrade fail its "syntax check".
  assert.doesNotMatch(src, /\$RUNTIME" --check/, "installer must not use bun --check");
  assert.match(src, /new Function\(src\)/, "installer must parse without executing");
});

test("installer refuses to claim success when the bridge never answered", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // A HOST that cannot be bound used to hang the health loop on curl with no
  // timeout, then print "Done" anyway.
  assert.match(src, /curl -fsS -m 2/, "health probe must have a timeout");
  assert.match(src, /BRIDGE_UP/, "installer must track whether /health answered");
  assert.match(src, /install finished but the service is not running/);
});

test("installer checks the TLS fingerprint before declaring success", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // An outdated Bun installs and runs, then earns a 403 that looks exactly
  // like an exhausted IP allowance. The installer must say so.
  assert.match(src, /transport-fingerprint\.js --check/);
  assert.match(src, /does not match the recorded OpenCode CLI baseline/);
});

test("macOS service redirects its log where the docs say it is", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /StandardOutPath/);
  assert.match(src, /Library\/Logs\/opencode-free-bridge\.log/);
});

test("installer stages and validates downloads before stopping the old bridge", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  const stageAt = src.indexOf("ofb-stage");
  const retireCall = src.indexOf("\nretire_legacy_service\n");
  const syntaxAt = src.indexOf("failed a syntax check");
  assert.ok(stageAt > 0, "installer must stage downloads");
  assert.ok(retireCall > 0, "installer must retire the legacy unit");
  assert.ok(syntaxAt > 0, "installer must syntax-check the staged files");
  // Order matters: a failed download must leave the running bridge untouched.
  assert.ok(stageAt < retireCall, "staging must happen before the old bridge is stopped");
  assert.ok(syntaxAt < retireCall, "validation must happen before the old bridge is stopped");
});

test("installer retires the pre-2.0 unit that owns the same port", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // Old releases shipped opencode-bridge.service. Leaving it enabled makes the
  // new service restart-loop on EADDRINUSE, so an upgrade must stop and
  // disable it instead of assuming a clean machine.
  assert.match(src, /retire_legacy_service/);
  assert.match(src, /opencode-bridge\.service/);
  assert.match(src, /already in use/, "installer must report a port held by another process");
  assert.match(src, /port \$PORT is occupied/, "an occupied port must abort before anything is changed");
});

test("server refuses to start on Node without ALLOW_NODE", () => {
  // This is a Node-specific behaviour, so it needs a real `node` binary — under
  // Bun, process.execPath is Bun and the server would (correctly) start.
  let nodeBin = null;
  for (const candidate of ["/usr/bin/node", "/usr/local/bin/node"]) {
    if (fs.existsSync(candidate)) {
      nodeBin = candidate;
      break;
    }
  }
  if (!nodeBin) {
    try {
      nodeBin = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim() || null;
    } catch {
      nodeBin = null;
    }
  }
  if (!nodeBin) return; // no Node on this machine; nothing to assert

  const server = path.join(__dirname, "..", "server.js");
  const env = { ...process.env, PORT: "0" };
  delete env.ALLOW_NODE;
  let code = 0;
  let stderr = "";
  try {
    // 5s was too tight: the refusal path loads every module before it can print,
    // and on a cold, loaded CI runner that occasionally exceeded the budget. The
    // resulting ETIMEDOUT left `err.status` undefined, so the assertion below
    // read as "Node started successfully" — a flaky failure that named the wrong
    // cause. The child prints and exits in well under a second locally.
    execFileSync(nodeBin, [server], { env, stdio: "pipe", timeout: 30000 });
  } catch (err) {
    code = err.status;
    stderr = String(err.stderr || "");
    assert.notEqual(err.signal, "SIGTERM", `node did not exit on its own within the timeout: ${stderr}`);
  }
  assert.equal(code, 1, "Node must exit non-zero");
  assert.match(stderr, /requires Bun/);
  assert.match(stderr, /0\/6[\s\S]*6\/6/, "the message must cite the measurement");
});

test("self-updater in server.js parses JS and JSON in-process instead of spawning bun --check", async () => {
  const serverPath = path.join(__dirname, "..", "server.js");
  const src = fs.readFileSync(serverPath, "utf8");
  assert.doesNotMatch(src, /\["--check"/, "server.js must not invoke --check on Bun");
  assert.match(src, /new Function\(text\.replace\(\/\^#!\.\*\\n\/, ""\)\)/);

  const srv = require("../server");
  const origFetch = global.fetch;
  const prevAuto = process.env.AUTO_UPDATE;
  process.env.AUTO_UPDATE = "force";
  srv.__setLastUpdateCheck(0);
  try {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("package.json")) {
        return {
          ok: true,
          json: async () => ({ version: "99.0.0" }),
          text: async () => JSON.stringify({ name: "opencode-free-bridge", version: "99.0.0" }),
        };
      }
      if (u.includes("identity.js")) {
        return {
          ok: true,
          text: async () => "const broken = {{{ syntax error;",
        };
      }
      return { ok: true, text: async () => "// valid placeholder script content\nmodule.exports = {};" };
    };
    const res = await srv.checkAndApplyUpdate();
    assert.equal(res.updated, false);
    assert.match(res.error, /syntax check failed for identity\.js/);
  } finally {
    global.fetch = origFetch;
    if (prevAuto === undefined) delete process.env.AUTO_UPDATE;
    else process.env.AUTO_UPDATE = prevAuto;
    srv.__setLastUpdateCheck(Date.now());
  }
});

test("every shipped file reaches installed hosts through both delivery paths", () => {
  const root = path.join(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const serverSrc = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const installSrc = fs.readFileSync(path.join(root, "install.sh"), "utf8");

  const updateBlock = serverSrc.match(/const UPDATE_FILES = \[([\s\S]*?)\];/);
  assert.ok(updateBlock, "server.js has no UPDATE_FILES list");
  const updateFiles = [...updateBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  // These are the runtime files an installed bridge needs. A file that is in
  // package.json but in neither delivery path ships to nobody, which is how
  // tunnel-doctor.sh was committed yet missing from every host in the fleet.
  const runtime = pkg.files.filter((f) => f !== "README.md" && f !== "AGENTS.md" && f !== "install.sh");
  for (const f of runtime) {
    assert.ok(updateFiles.includes(f), `${f} is in package.json files but not in UPDATE_FILES`);
    assert.ok(installSrc.includes(f), `${f} is in package.json files but install.sh never fetches it`);
  }

  // A .sh entry is useless without a parser that understands it.
  if (updateFiles.some((f) => f.endsWith(".sh"))) {
    assert.match(serverSrc, /bash", \["-n"/, "self-updater fetches a shell script but never runs bash -n on it");
    assert.match(serverSrc, /chmodSync\(tmpPath, 0o755\)/, "self-updater does not mark the shell script executable");
  }
});

test("installer installs the local checkout instead of 404ing on unpushed files", () => {
  if (!hasInstaller()) return;
  const src = fs.readFileSync(INSTALLER, "utf8");
  // Running install.sh from a clone means installing that working tree. It used
  // to always download from GitHub, so a file that existed only locally failed
  // with a bare `curl: (22) ... 404` after the release list gained proxy.js.
  assert.match(src, /SOURCE="\$\{SOURCE:-auto\}"/);
  assert.match(src, /cp -p "\$SRC_DIR\/\$file"/, "local source must copy the checkout file");
  assert.match(src, /Source: local checkout/, "the installer must say where files came from");
  // The remote path must name the file it failed on and the way out.
  assert.match(src, /could not download \$file from \$RAW/);
  assert.match(src, /SOURCE=local/);
  // And the health probe must still run after either path.
  assert.match(src, /probe_health/);
});

test("verify.js checks runtime and TLS baseline before blaming the IP for a closed gate", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "verify.js"), "utf8");
  assert.match(src, /health\.runtime\.startsWith\("node\/"\)/);
  assert.match(src, /TLS fingerprint drift detected/);
});

test("a server.js that requires a module the old updater never fetched still boots", async () => {
  // 2.1.0's UPDATE_FILES had no proxy.js/panel.js. Updating that install to
  // 2.2.0 therefore wrote a server.js whose top-level requires pointed at files
  // the updater never downloaded, and the restart crash-looped with
  // "Cannot find module './proxy'". Reproduced here against a temp tree: the
  // module loader must degrade to direct egress, not throw.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-missing-module-"));
  const serverPath = path.join(tmp, "server.js");
  try {
    // Every real sibling module, except the two the 2.1.0 updater did not know
    // about. `token-budget` is a hard require and must stay, or this would test
    // a different failure.
    for (const f of fs.readdirSync(path.join(__dirname, ".."))) {
      if (!f.endsWith(".js") || f === "proxy.js" || f === "panel.js") continue;
      fs.copyFileSync(path.join(__dirname, "..", f), path.join(tmp, f));
    }
    fs.copyFileSync(path.join(__dirname, "..", "package.json"), path.join(tmp, "package.json"));
    assert.equal(fs.existsSync(path.join(tmp, "proxy.js")), false);
    // `proxy.js` and `panel.js` are deliberately absent from this directory.
    const out = execFileSync(
      process.execPath,
      ["-e", `const m = require(${JSON.stringify(serverPath)}); console.log(typeof m.__repairMissingModules)`],
      { encoding: "utf8", env: { ...process.env, ALLOW_NODE: "1" } }
    );
    assert.match(out, /function/, "server.js must load without proxy.js/panel.js");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the updater stages every local module the incoming server.js requires", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // The guard must read the *incoming* server.js and fetch its imports, so an
  // old file list cannot install a server it cannot boot.
  assert.match(src, /localRequires\(fs\.readFileSync\(incoming\.tmpPath/, "updater does not inspect the incoming server.js");
  assert.match(src, /Staged newly required module/, "updater never logs a staged dependency");
  // And boot repairs a tree that is already missing modules.
  assert.match(src, /repairMissingModules\(\)/, "boot never repairs missing modules");
});

test("the panel API refuses cross-site and non-JSON writes", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /function adminRequestError/, "no admin request guard");
  assert.match(src, /sec-fetch-site/, "guard ignores Sec-Fetch-Site");
  assert.match(src, /type !== "application\/json"/, "guard accepts non-JSON bodies (CSRF)");
  assert.match(src, /PANEL_ALLOWED_HOSTS/, "no escape hatch documented for a reverse proxy");
});

test("the Docker image persists the panel proxy setting outside the container", () => {
  const root = path.join(__dirname, "..");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const compose = fs.readFileSync(path.join(root, "docker-compose.yaml"), "utf8");
  assert.match(dockerfile, /OPENCODE_BRIDGE_STATE_DIR=\/data\/state/);
  assert.match(compose, /OPENCODE_BRIDGE_STATE_DIR: \/data\/state/);
  assert.match(compose, /bridge-state:\/data\/state/);
  assert.match(compose, /^  bridge-state:$/m, "compose does not declare the bridge-state volume");
});
