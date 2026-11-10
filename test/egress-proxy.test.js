"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROXY = path.join(__dirname, "..", "egress-proxy.js");

/**
 * Ask a process that *runs* the proxy what resolver order it ended up with.
 *
 * The assertion has to observe the proxy's own process, not the test's: the
 * bug it guards was that `egress-proxy.js` dialled upstream in Bun's default
 * `verbatim` order while `server.js` pinned `ipv4first`. The gateway refuses
 * IPv6 egress, so every pool member on a dual-stack host tunnelled requests out
 * over the family that answers `429` and took the whole pool down for a day.
 */
function resolveOrderInProxyProcess(env) {
  const script = `
    const dns = require("dns");
    process.env.PORT = "0";
    require(${JSON.stringify(PROXY)});
    setTimeout(() => {
      process.stdout.write("ORDER=" + dns.getDefaultResultOrder());
      process.exit(0);
    }, 150);
  `;
  const env_ = { ...process.env, PORT: "0", ...env };
  delete env_.DNS_RESULT_ORDER;
  if (env && env.DNS_RESULT_ORDER !== undefined) env_.DNS_RESULT_ORDER = env.DNS_RESULT_ORDER;

  const out = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: env_,
    encoding: "utf8",
    timeout: 20000,
  });
  const match = /ORDER=(\w+)/.exec(out.stdout || "");
  assert.ok(match, `proxy process did not report a resolver order: ${out.stderr || out.stdout}`);
  return match[1];
}

test("egress-proxy dials upstream IPv4-first by default", () => {
  assert.equal(resolveOrderInProxyProcess({}), "ipv4first");
});

test("egress-proxy honours DNS_RESULT_ORDER like server.js does", () => {
  // `ipv6first` exists from Node 22. On an older runtime the proxy must fall
  // back to an order it understands instead of throwing at module load, which
  // killed the process before it could listen (CI: compat 18.x went red).
  let supportsIpv6First = true;
  try {
    require("dns").setDefaultResultOrder("ipv6first");
  } catch {
    supportsIpv6First = false;
  }
  const got = resolveOrderInProxyProcess({ DNS_RESULT_ORDER: "ipv6first" });
  assert.equal(got, supportsIpv6First ? "ipv6first" : "ipv4first");
  assert.equal(resolveOrderInProxyProcess({ DNS_RESULT_ORDER: "verbatim" }), "verbatim");
});

test("egress-proxy starts even when DNS_RESULT_ORDER is unknown to the runtime", () => {
  // The failure this guards: setDefaultResultOrder threw at module load, so the
  // process never listened and an operator lost the proxy to a typo. Any
  // nonsense value must land on a working order, not a dead process.
  const got = resolveOrderInProxyProcess({ DNS_RESULT_ORDER: "not-a-real-order" });
  assert.ok(got === "ipv4first" || got === "verbatim", `expected a working order, got ${got}`);
});
