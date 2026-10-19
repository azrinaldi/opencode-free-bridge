const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../identity");

const origFetch = global.fetch;

afterEach(() => {
  global.fetch = origFetch;
  identity.__reset();
  delete process.env.OPENCODE_MAJOR;
  delete process.env.UPDATE_MODE;
  delete process.env.OPENCODE_USER_AGENT;
});

const SOURCE = {
  identifier: `
export * as Identifier from "./identifier.js"
const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
export function create(descending: boolean, timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
}
`,
  sessionId: `
export const SessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(
  Schema.annotate({ identifier: "Session.ID" }),
  statics((schema) => {
    const create = () => schema.make("ses_" + descending())
    return { create }
  }),
)
`,
  app: `
export function useragent(app: Info) {
  return \`opencode/\${app.channel}/\${app.version}/\${app.name}\`
}
`,
  modelRequest: `
      const base = LLM.request({
        model: model.model,
        http: {
          headers: {
            "x-opencode-session-id": session.id,
            ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
            "x-session-affinity": affinity,
            "X-Session-Id": affinity,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
            "User-Agent": App.useragent(app),
            "x-opencode-project": session.projectID,
            "x-opencode-session": affinity,
            "x-opencode-client": app.name,
          },
        },
      })
`,
  "tool:read": `
export const name = "read"
const LocationInput = Schema.Struct({
  path: Schema.String.annotate({ description: "File or directory to read" }),
  offset: PageInput.fields.offset.annotate({
    description: "The line or directory entry to start reading from (1-based)",
  }),
  limit: PageInput.fields.limit.annotate({
    description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
  }),
})
const StructuredOutput = Schema.Struct({ content: Schema.String })
export const ReadTool = Tool.define(name, async (editor) => {
  editor.add({
    options: { codemode: false },
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    input: LocationInput,
  })
})
`,
  "tool:shell": `
export const name = "shell"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
  }),
  timeout: Schema.optionalKey(Schema.NonNegativeInt).annotate({
    description: \`Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to \${DEFAULT_TIMEOUT_MS} for foreground commands. Background commands have no timeout by default.\`,
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
  }),
})
const Output = Schema.Struct({ output: Schema.String })
const description = (shell?: string) => [
  "Execute a shell command and return its output.",
  \`Commands run on \${OS} using \${shell}.\`,
  "Quote file paths containing spaces or special characters.",
  "Prefer dedicated tools over shell commands when possible.",
  "When output is large, the full result is saved to a file and a truncated preview is returned.",
  "Rely on automatic truncation unless filtering the output is more useful.",
  "Commands accept an optional timeout, background commands have no timeout by default.",
  "Background commands return immediately, and you will be notified when they complete.",
].join(" ")
export const ShellTool = Tool.define(name, async (editor) => {
  editor.add({
    name,
    options: { codemode: false },
    description: description(),
    input: Input,
  })
})
`,
};

function mockUpstream({
  versions = ["2.0.32"],
  source = SOURCE,
  failSource = false,
  failUpdateApi = false,
  minimum = false,
  sha = "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad",
} = {}) {
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);

    if (u.includes("/update/api/")) {
      if (failUpdateApi) return { ok: false, status: 503 };
      const newest = versions.slice().sort((a, b) => {
        const [a1, a2, a3] = a.split(".").map(Number);
        const [b1, b2, b3] = b.split(".").map(Number);
        return b1 - a1 || b2 - a2 || b3 - a3;
      })[0];
      return {
        ok: true,
        json: async () => ({
          channel: "latest",
          version: newest,
          active: true,
          minimum,
          metadata: { package: "@opencode/cli", github: { sha } },
        }),
      };
    }

    if (u.includes("releases.atom")) {
      if (failUpdateApi && versions.length === 0) return { ok: false, status: 500 };
      return {
        ok: true,
        text: async () => versions.map((v) => `<title>v${v}</title>`).join("\n"),
      };
    }

    if (u.includes("raw.githubusercontent.com")) {
      if (failSource) return { ok: false, status: 404 };
      const key = u.includes("session-id.ts")
        ? "sessionId"
        : u.includes("identifier.ts")
          ? "identifier"
          : u.includes("app.ts")
            ? "app"
            : u.includes("read.ts")
              ? "readTool"
              : u.includes("shell.ts")
                ? "shellTool"
                : "modelRequest";
      return { ok: true, text: async () => source[key] || "" };
    }
    return { ok: false, status: 404 };
  };
  return calls;
}

describe("identity: version & handshake resolution", () => {
  it("sorts versions newest-first and dedupes", () => {
    assert.deepEqual(identity.sortVersions(["1.9.0", "2.0.1", "2.0.10", "2.0.1"]), [
      "2.0.10",
      "2.0.1",
      "1.9.0",
    ]);
  });

  it("parses versions out of an atom feed", () => {
    const feed = "<title>Release notes</title><title>v2.0.32</title><title>v1.19.3</title>";
    assert.deepEqual(identity.parseVersions(feed), ["2.0.32", "1.19.3"]);
  });

  it("selects the newest version regardless of major unless OPENCODE_MAJOR is set", () => {
    assert.equal(identity.selectVersion(["3.0.0", "2.9.9"]), "3.0.0");
    process.env.OPENCODE_MAJOR = "2";
    assert.equal(identity.selectVersion(["3.0.0", "2.9.9"]), "2.9.9");
  });

  it("compares versions numerically, not lexically", () => {
    assert.ok(identity.compareVersions("2.0.10", "2.0.9") > 0);
    assert.ok(identity.compareVersions("1.18.0", "1.19.0") < 0);
    assert.equal(identity.compareVersions("2.0.1", "2.0.1"), 0);
  });

  it("reads the version floor out of an UpgradeRequired message", () => {
    assert.equal(
      identity.parseVersionFloor("OpenCode 1.18.0 or newer is required to use the free tier"),
      "1.18.0"
    );
    assert.equal(identity.parseVersionFloor("something else"), null);
    assert.equal(identity.parseVersionFloor(undefined), null);
  });

  it("resolves version, commit SHA, and minimum flag from update API with atom fallback", async () => {
    mockUpstream({ versions: ["2.0.32"], minimum: true });
    const r = await identity.resolveRelease("2.0.0");
    assert.equal(r.version, "2.0.32");
    assert.equal(r.sha, "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad");
    assert.equal(r.minimum, true);
    assert.equal(r.source, "update-api");
    assert.equal(identity.sourceRef(r), "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad");

    mockUpstream({ versions: ["2.0.35"], failUpdateApi: true });
    const fallback = await identity.resolveRelease("2.0.32");
    assert.equal(fallback.version, "2.0.35");
    assert.equal(fallback.source, "atom-feed");
    assert.equal(fallback.sha, null);
    assert.equal(identity.sourceRef(fallback), "v2.0.35");
  });
});

describe("identity: recipe & tool extraction", () => {
  it("extracts session id shape, UA template, headers, and exact read/shell tool schemas from source", () => {
    const r = identity.extractRecipe(SOURCE);
    assert.equal(r.sessionCharset.length, 62);
    assert.equal(r.sessionLength, 26);
    assert.equal(r.sessionMultiplier, 0x1000);
    assert.equal(r.sessionPrefix, "ses_");
    assert.equal(r.userAgentTemplate, "opencode/${app.channel}/${app.version}/${app.name}");
    assert.ok(r.headers.includes("x-session-affinity"));
    assert.ok(r.headers.includes("x-opencode-client"));
    // Conditional (parent-session) headers are separated from the required set:
    // the bridge never creates nested sessions, so their absence is expected.
    assert.deepEqual(r.optionalHeaders, [
      "x-opencode-parent-session-id",
      "x-parent-session-id",
    ]);
    assert.equal(r.headers.includes("x-opencode-parent-session-id"), false);

    assert.deepEqual(r.tools.read, identity.DEFAULT_TOOLS.read);
    assert.deepEqual(r.tools.shell, identity.DEFAULT_TOOLS.shell);
  });

  it("returns a partial recipe instead of throwing on malformed source", () => {
    const r = identity.extractRecipe({ identifier: "nothing useful here", app: "", modelRequest: "" });
    assert.deepEqual(r, {});
  });

  // The fallback header list is what the bridge sends when the source read
  // fails, and it is also the baseline the extractor is tested against. Adding
  // a header here that upstream does not emit makes the bridge claim a wire
  // shape the real CLI never sends, and the next successful refresh silently
  // removes it again (measured: a host showed 8 headers, then 7 after refresh).
  it("ships only header names that upstream's request builder actually sets", () => {
    const upstream = identity.extractRecipe(SOURCE).headers;
    assert.deepEqual(
      [...identity.DEFAULT_RECIPE.headers].sort(),
      [...upstream].sort(),
      "DEFAULT_RECIPE.headers must match the names parsed from model-request.ts"
    );
  });

  it("ignores an implausible session length", () => {
    const r = identity.extractRecipe({ identifier: 'const length = 3\nconst chars = "ab"' });
    assert.equal(r.sessionLength, undefined);
  });

  it("extracts the wire allowlist from the codemode flag, not from the file list", () => {
    // A tool is on the wire when its registration says `codemode: false`;
    // everything else is reached through `execute`. So a file whose add block
    // omits the flag (or sets it true) must NOT be sent, even though the file
    // exists — measured: the real CLI's request carries exactly this set.
    const src = (name, flag) =>
      [
        `export const name = "${name}"`,
        "export const X = Tool.define(name, async (editor) => {",
        "  editor.add({",
        `    name,`,
        flag === null ? "    description: \"d\"," : `    options: { codemode: ${flag} },`,
        "    input: Input,",
        "  })",
        "})",
      ].join("\n");

    const r = identity.extractRecipe({
      "tool:read": src("read", "false"),
      "tool:shell": src("shell", "false"),
      "tool:glob": src("glob", "false"),
      "tool:patch": src("patch", "true"),
      "tool:opencode": src("opencode", null),
    });

    assert.deepEqual(r.toolNames, ["read", "shell", "glob"]);
    assert.ok(!r.toolNames.includes("patch"), "a code-mode tool must not be sent on the wire");
    assert.ok(!r.toolNames.includes("opencode"), "a tool with no flag is code-mode by default");
  });

  it("reads a plugin that registers its tools with editor.add literals", () => {
    // `mcp-resource.ts` registers by literal name rather than an exported
    // constant, and nests an execute closure inside the argument — the scanner
    // must follow the braces rather than stop at the first `})`.
    const src = [
      "export const Plugin = {",
      "  effect: Effect.fn(function* (ctx) {",
      "    yield* ctx.tool.transform((editor) =>",
      "      editor.add({",
      '        name: "list_mcp_resources",',
      "        options: { codemode: false },",
      "        execute: (input) => Effect.gen(function* () {",
      "          const x = { nested: { deep: 1 } }",
      "          return x",
      "        }),",
      "      })",
      "    )",
      "  }),",
      "}",
    ].join("\n");
    const r = identity.extractRecipe({ "tool:mcp-resource": src });
    assert.deepEqual(r.toolNames, ["list_mcp_resources"]);
  });

  it("extracts a tool whose description is an exported template literal", () => {
    const src = [
      'export const name = "webfetch"',
      'export const description = `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.`',
      'export const Input = Schema.Struct({',
      '  url: Schema.String.annotate({ description: "The HTTP or HTTPS URL to fetch content from" }),',
      '})',
    ].join("\n");
    const def = identity.extractToolFromSource(src, "webfetch");
    assert.equal(def.name, "webfetch");
    assert.ok(def.description.startsWith("Fetch content"));
    assert.deepEqual(Object.keys(def.parameters.properties), ["url"]);
  });

  it("extracts a tool whose description is an array joined with a newline", () => {
    const src = [
      'export const name = "skill"',
      'export const description = [',
      '  "Load a specialized skill.",',
      '  "The skill ID must match an available skill.",',
      '].join("\\n")',
      'export const Input = Schema.Struct({',
      '  id: Schema.String.annotate({ description: "The ID of an available skill" }),',
      '})',
    ].join("\n");
    const def = identity.extractToolFromSource(src, "skill");
    assert.equal(def.name, "skill");
    assert.equal(def.description, "Load a specialized skill.\nThe skill ID must match an available skill.");
    assert.deepEqual(Object.keys(def.parameters.properties), ["id"]);
  });
});

describe("identity: applying a recipe", () => {
  beforeEach(() => identity.__reset());

  it("applies a complete update and reports what changed", () => {
    const changed = identity.applyRecipe({ version: "2.0.99" }, "v2.0.99");
    assert.deepEqual(changed, ["version"]);
    assert.equal(identity.getRecipe().version, "2.0.99");
  });

  it("rejects a UA template that does not render a plausible OpenCode UA", () => {
    const before = identity.getUserAgent();
    identity.applyRecipe({ userAgentTemplate: "not-an-opencode-agent" });
    assert.equal(identity.getUserAgent(), before);
  });

  it("accepts a UA template that renders a valid OpenCode UA", () => {
    identity.applyRecipe({ userAgentTemplate: "opencode/${app.channel}/${app.version}/desktop" });
    assert.equal(identity.getUserAgent(), `opencode/latest/${identity.getRecipe().version}/desktop`);
  });

  it("ignores an invalid version string", () => {
    const before = identity.getRecipe().version;
    identity.applyRecipe({ version: "not-a-version" });
    assert.equal(identity.getRecipe().version, before);
  });
});

describe("identity: session id generation", () => {
  beforeEach(() => identity.__reset());

  it("matches the upstream format: 12 hex + 14 base62", () => {
    const id = identity.createId(true);
    assert.match(id, /^[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.equal(id.length, 26);
  });

  it("keeps the decoded counter within 1..16 under burst load", () => {
    const ts = 1_760_000_000_000;
    for (let i = 0; i < 64; i++) {
      const id = identity.createId(true, ts);
      const prefix = BigInt(`0x${id.slice(0, 12)}`);
      const decoded = ~prefix & ((1n << 48n) - 1n);
      const counter = Number(decoded & 0xfffn);
      assert.ok(counter >= 1 && counter <= 16, `counter ${counter} out of range`);
    }
  });

  it("follows the recipe when the upstream format changes", () => {
    identity.applyRecipe({ sessionLength: 20 });
    const id = identity.createId(true);
    assert.equal(id.length, 20);
    assert.match(id, /^[0-9a-f]{12}[0-9A-Za-z]{8}$/);
  });
});

describe("identity: refresh & update modes (reactive vs always)", () => {
  beforeEach(() => identity.__reset());

  it("adopts the newest release and derives the recipe when forced", async () => {
    mockUpstream({ versions: ["1.19.3", "2.0.32", "2.0.31"] });
    const res = await identity.refresh({ force: true });
    assert.equal(res.version, "2.0.32");
    assert.equal(identity.getUserAgent(), "opencode/latest/2.0.32/cli");
    assert.equal(identity.getState().lastSourceTag, "d4a6223d017e17f1beaa91d3e6ecc6511c5132ad");
  });

  it("in reactive mode (default), defers non-minimum upgrades until forced", async () => {
    process.env.UPDATE_MODE = "reactive";
    mockUpstream({ versions: ["2.0.40"], minimum: false });
    const res = await identity.refresh({ force: false });
    assert.equal(res.updated, false);
    assert.equal(res.available, "2.0.40");
    assert.equal(identity.getRecipe().version, "2.0.32");

    // When minimum: true, reactive mode adopts immediately.
    mockUpstream({ versions: ["2.0.40"], minimum: true });
    identity.__setLastCheckTime(0);
    const minRes = await identity.refresh({ force: false });
    assert.equal(minRes.updated, true);
    assert.equal(identity.getRecipe().version, "2.0.40");
  });

  it("recheck bypasses the TTL guard but still respects reactive mode", async () => {
    process.env.UPDATE_MODE = "reactive";
    mockUpstream({ versions: ["2.0.41"], minimum: false });
    identity.__setLastCheckTime(Date.now()); // identity is fresh
    const res = await identity.refresh({ recheck: true });
    assert.equal(res.reason, "available-not-adopted:reactive");
    assert.equal(res.available, "2.0.41");
    assert.equal(identity.getRecipe().version, "2.0.32");
    // Reported so an operator can see a release is waiting for a gate signal.
    assert.equal(identity.getState().available, "2.0.41");
  });

  it("clears the deferred release once it is adopted", async () => {
    process.env.UPDATE_MODE = "reactive";
    mockUpstream({ versions: ["2.0.42"], minimum: false });
    await identity.refresh({ recheck: true });
    assert.equal(identity.getState().available, "2.0.42");

    mockUpstream({ versions: ["2.0.42"], minimum: true });
    identity.__setLastCheckTime(0);
    await identity.refresh({ recheck: true });
    assert.equal(identity.getRecipe().version, "2.0.42");
    assert.equal(identity.getState().available, null);
  });

  it("in always mode, adopts every new release immediately on TTL expiry", async () => {
    process.env.UPDATE_MODE = "always";
    mockUpstream({ versions: ["2.0.40"], minimum: false });
    const res = await identity.refresh({ force: false });
    assert.equal(res.updated, true);
    assert.equal(identity.getRecipe().version, "2.0.40");
  });

  it("still adopts the version when the source files are unavailable", async () => {
    mockUpstream({ versions: ["2.0.40"], failSource: true });
    const res = await identity.refresh({ force: true });
    assert.equal(res.version, "2.0.40");
    assert.equal(identity.getRecipe().sessionLength, 26);
  });

  it("never moves backwards to an older tag", async () => {
    mockUpstream({ versions: ["2.0.32"] });
    await identity.refresh({ force: true });
    const v = identity.getRecipe().version;

    mockUpstream({ versions: ["2.0.10"] });
    identity.__setLastCheckTime(0);
    await identity.refresh({ force: true });
    assert.equal(identity.getRecipe().version, v);
  });

  it("keeps the previous recipe when the feed is unreachable", async () => {
    global.fetch = async () => {
      throw new Error("network down");
    };
    const before = identity.getRecipe();
    const res = await identity.refresh({ force: true });
    assert.equal(res.updated, false);
    assert.equal(identity.getRecipe().version, before.version);
    assert.ok(identity.getState().lastRefreshError);
  });

  it("does not fetch source files when the version has not moved", async () => {
    const calls = mockUpstream({ versions: ["2.0.32"] });
    await identity.refresh({ force: true });
    const afterFirst = calls.length;

    identity.__setLastCheckTime(0);
    const res = await identity.refresh();
    assert.equal(res.reason, "up-to-date");
    const second = calls.slice(afterFirst);
    const sourceReads = second.filter((u) => u.includes("raw.githubusercontent.com"));
    assert.equal(sourceReads.length, 0);
    assert.ok(second.some((u) => u.includes("/update/api/")));
  });

  it("honours the operator-pinned user agent", async () => {
    process.env.OPENCODE_USER_AGENT = "opencode/latest/9.9.9/cli";
    const res = await identity.refresh({ force: true });
    assert.equal(res.reason, "pinned");
  });
});

describe("identity: ensureFresh is non-blocking", () => {
  beforeEach(() => identity.__reset());

  it("does nothing while the cached identity is fresh", () => {
    identity.__setLastCheckTime(Date.now());
    let fetched = 0;
    global.fetch = async () => {
      fetched++;
      return { ok: true, text: async () => "" };
    };
    const res = identity.ensureFresh();
    assert.equal(res.reason, "fresh");
    assert.equal(fetched, 0);
  });

  it("kicks off a background refresh without awaiting it", async () => {
    identity.__setLastCheckTime(0);
    let resolveFetch;
    const gate = new Promise((r) => {
      resolveFetch = r;
    });
    global.fetch = async () => {
      await gate;
      return { ok: true, text: async () => "<title>v2.0.32</title>" };
    };
    const res = identity.ensureFresh();
    assert.equal(res.reason, "refreshing-in-background");
    resolveFetch();
  });
});

describe("identity: self-healing on gate rejection", () => {
  beforeEach(() => identity.__reset());

  it("adopts an advertised version floor and asks for a retry", async () => {
    mockUpstream({ versions: ["2.0.32"] });
    identity.__setLastCheckTime(Date.now());
    const verdict = await identity.onGateRejection(
      426,
      "UpgradeRequired",
      "OpenCode 2.5.0 or newer is required to use the free tier"
    );
    assert.equal(verdict.retry, true);
    assert.match(verdict.reason, /version-floor:2\.5\.0/);
    assert.equal(identity.getState().versionFloor, "2.5.0");
    assert.ok(identity.compareVersions(identity.getRecipe().version, "2.5.0") >= 0);
  });

  it("does not ask for a retry when nothing was learned", async () => {
    mockUpstream({ versions: [identity.getRecipe().version] });
    await identity.refresh({ force: true });

    identity.__setLastCheckTime(Date.now());
    const verdict = await identity.onGateRejection(403, "FreeTierError", "free tier");
    assert.equal(verdict.retry, false);
    assert.equal(verdict.reason, "no-change");
  });

  it("refuses to retry a second time (no retry loops)", async () => {
    const verdict = await identity.onGateRejection(403, "FreeTierError", "x", true);
    assert.equal(verdict.retry, false);
    assert.equal(verdict.reason, "already-retried");
  });

  it("recovers when the feed names a newer version", async () => {
    mockUpstream({ versions: ["2.0.99"] });
    identity.__setLastCheckTime(Date.now());
    const verdict = await identity.onGateRejection(403, "FreeTierError", "free tier");
    assert.equal(verdict.retry, true);
    assert.equal(identity.getRecipe().version, "2.0.99");
  });

  it("throttles repeated forced refreshes during a 403 burst unless a version floor is reported", async () => {
    const calls = mockUpstream({ versions: [identity.getRecipe().version] });
    await identity.refresh({ force: true });
    identity.__setLastCheckTime(Date.now());

    const countBefore = calls.length;
    const first = await identity.onGateRejection(403, "FreeTierError", "free tier");
    assert.equal(first.retry, false);
    const countAfterFirst = calls.length;
    assert.ok(countAfterFirst > countBefore);

    const second = await identity.onGateRejection(403, "FreeTierError", "free tier");
    assert.equal(second.retry, false);
    assert.equal(second.cooldown, true);
    assert.equal(calls.length, countAfterFirst, "must not re-fetch GitHub/catalog during 403 cooldown");
  });

  it("memoizes extracted source by release SHA on forced refresh and persists source-recipe.json to disk", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-src-cache-"));
    const prevCacheDir = process.env.OPENCODE_CACHE_DIR;
    process.env.OPENCODE_CACHE_DIR = tmpDir;
    try {
      const calls = mockUpstream({ versions: ["2.0.32"] });
      await identity.refresh({ force: true });
      const afterFirst = calls.length;
      assert.ok(calls.some((u) => u.includes("raw.githubusercontent.com")));

      // Even when cooldown is cleared and local session prefix is corrupted,
      // forced refresh at the same SHA heals from memoized source without
      // re-downloading raw.githubusercontent.com files.
      identity.__setSessionPrefix("bad_");
      const verdict = await identity.onGateRejection(403, "FreeTierError", "free tier");
      assert.equal(verdict.retry, true);
      assert.equal(identity.getSessionPrefix(), "ses_");
      const secondCalls = calls.slice(afterFirst);
      assert.equal(
        secondCalls.filter((u) => u.includes("raw.githubusercontent.com")).length,
        0,
        "must not re-fetch raw.githubusercontent.com files for the same commit SHA"
      );

      // Disk cache round-trip for source-recipe.json
      const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      const extracted = {
        sessionPrefix: "ses_",
        sessionLength: 26,
        tools: { read: identity.DEFAULT_TOOLS.read, shell: identity.DEFAULT_TOOLS.shell },
        toolNames: ["read", "shell"],
      };
      identity.writeCachedSource(sha, extracted);
      assert.equal(identity.readCachedSource(sha)?.ref, sha);
      assert.equal(identity.readCachedSource("other-sha"), null);
    } finally {
      if (prevCacheDir === undefined) delete process.env.OPENCODE_CACHE_DIR;
      else process.env.OPENCODE_CACHE_DIR = prevCacheDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("identity: adaptive endpoints", () => {
  it("adopts catalog-derived endpoints and exposes them per request", () => {
    const changed = identity.applyRecipe({
      chatUrl: "https://opencode.ai/inference/openai/v1/chat/completions",
      responsesUrl: "https://opencode.ai/inference/openai/v1/responses",
    });
    assert.ok(changed.includes("chatUrl"));
    const e = identity.getEndpoints();
    assert.equal(e.chatUrl, "https://opencode.ai/inference/openai/v1/chat/completions");
    assert.equal(e.responsesUrl, "https://opencode.ai/inference/openai/v1/responses");
    assert.equal(e.modelsUrl, identity.DEFAULT_RECIPE.modelsUrl);
  });

  it("rejects a malformed endpoint instead of adopting it", () => {
    identity.applyRecipe({ chatUrl: "not-a-url" });
    assert.equal(identity.getEndpoints().chatUrl, identity.DEFAULT_RECIPE.chatUrl);
  });

  it("routes a model to its catalog-pinned base when the SDK is OpenAI-compatible", () => {
    identity.applyRecipe({
      modelEndpoints: { "some-openai-model": "https://opencode.ai/inference/openai/v1" },
    });
    const e = identity.getEndpoints("some-openai-model");
    assert.equal(e.chatUrl, "https://opencode.ai/inference/openai/v1/chat/completions");
    // unknown models keep the provider-wide base
    assert.equal(
      identity.getEndpoints("unlisted-model").chatUrl,
      identity.DEFAULT_RECIPE.chatUrl
    );
  });

  it("reports endpoints and the tool allowlist in state", () => {
    identity.applyRecipe({ toolNames: ["read", "shell", "glob"] });
    const st = identity.getState();
    assert.deepEqual(st.toolNames, ["read", "shell", "glob"]);
    assert.equal(typeof st.endpoints.chatUrl, "string");
  });
});

describe("identity: gate header wiring", () => {
  beforeEach(() => identity.__reset());

  it("builds the upstream header set from the recipe, not a hardcoded list", () => {
    const ctx = {
      userAgent: "opencode/latest/2.0.32/cli",
      client: "cli",
      project: "global",
      sessionId: "ses_abc",
    };
    const { headers, unsent } = identity.buildGateHeaders(ctx);
    assert.equal(headers["User-Agent"], ctx.userAgent);
    assert.equal(headers["x-opencode-client"], "cli");
    assert.equal(headers["x-opencode-project"], "global");
    assert.equal(headers["x-opencode-session"], "ses_abc");
    assert.equal(headers["x-opencode-session-id"], "ses_abc");
    assert.equal(headers["x-session-affinity"], "ses_abc");
    assert.equal(headers["x-session-id"], "ses_abc");
    assert.deepEqual(unsent, []);
  });

  it("reports a header that upstream adds when this bridge has no value for it", () => {
    identity.applyRecipe({ headers: [...identity.DEFAULT_RECIPE.headers, "x-brand-new-gate"] });
    const { headers, unsent } = identity.buildGateHeaders({
      userAgent: "opencode/latest/2.0.32/cli",
      client: "cli",
      project: "global",
      sessionId: "ses_abc",
    });
    // The name is known from source but this bridge has no value for it: it is
    // reported rather than sent empty, which would be worse than omitting it.
    assert.deepEqual(unsent, ["x-brand-new-gate"]);
    assert.equal("x-brand-new-gate" in headers, false);
    assert.deepEqual(identity.getState().unsentHeaders, ["x-brand-new-gate"]);
  });

  it("does not duplicate a header when upstream changes its case", () => {
    identity.applyRecipe({ headers: ["User-Agent", "user-agent", "x-session-id", "X-Session-Id"] });
    const { headers } = identity.buildGateHeaders({
      userAgent: "opencode/latest/2.0.32/cli",
      sessionId: "ses_abc",
    });
    // One canonical spelling per name, whatever case the recipe used. The gate
    // anchors are pinned on top of the recipe (see GATE_ANCHOR_HEADER_NAMES),
    // so the recipe's own names are asserted as a subset rather than a fixed
    // list — the invariant under test is de-duplication, not the anchor set.
    const keys = Object.keys(headers);
    assert.equal(keys.filter((k) => k.toLowerCase() === "user-agent").length, 1);
    assert.equal(keys.filter((k) => k.toLowerCase() === "x-session-id").length, 1);
    assert.ok(keys.includes("User-Agent"));
    assert.ok(keys.includes("x-session-id"));
  });
});

describe("identity: session id prefix", () => {
  beforeEach(() => identity.__reset());

  it("prefixes ids with the recipe value, so an upstream prefix change is followed", () => {
    assert.equal(identity.createSessionId(true).startsWith("ses_"), true);
    identity.applyRecipe({ sessionPrefix: "sess_" });
    const id = identity.createSessionId(true);
    assert.match(id, /^sess_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });
});

describe("identity: tool profile formatting", () => {
  beforeEach(() => identity.__reset());

  it("shapes the list for both protocol lanes", () => {
    identity.__setToolProfile(
      {
        read: { description: "r", parameters: { type: "object", properties: {} } },
        shell: { description: "s", parameters: { type: "object", properties: {} } },
      },
      "test"
    );

    const chat = identity.getToolList(false);
    assert.deepEqual(
      chat.map((t) => t.function.name),
      ["read", "shell"]
    );
    assert.ok(chat.every((t) => t.type === "function" && t.function));

    const responses = identity.getToolList(true);
    assert.deepEqual(
      responses.map((t) => t.name),
      ["read", "shell"]
    );
    assert.ok(responses.every((t) => t.type === "function" && !t.function && t.strict === false));
  });

  it("sends a source-derived profile whole in `full` scope, so a renamed tool reaches the wire", () => {
    // Upstream renamed `shell` to `run`. The extractor records the new name; a
    // hardcoded core filter would keep sending `shell` and silently drop it.
    // The retry after a gate rejection uses `full` scope for exactly this case.
    identity.applyRecipe({
      tools: {
        read: { description: "r".repeat(30), parameters: { type: "object", properties: {} } },
        run: { description: "x".repeat(30), parameters: { type: "object", properties: {} } },
      },
      toolNames: ["read", "run"],
    });
    assert.deepEqual(
      identity.getToolList(false, "full").map((t) => t.function.name),
      ["read", "run"]
    );
    // The default scope stays minimal: only the proven core names are sent.
    assert.deepEqual(
      identity.getToolList(false).map((t) => t.function.name),
      ["read"]
    );
  });

  it("replaces the profile instead of merging, so a removed tool disappears", () => {
    identity.applyRecipe({
      tools: {
        read: { description: "r".repeat(30), parameters: { type: "object", properties: {} } },
        shell: { description: "s".repeat(30), parameters: { type: "object", properties: {} } },
      },
    });
    assert.deepEqual(Object.keys(identity.getTools()).sort(), ["read", "shell"]);

    // Upstream drops `shell` from the release.
    identity.applyRecipe({
      tools: {
        read: { description: "r".repeat(30), parameters: { type: "object", properties: {} } },
      },
    });
    assert.deepEqual(Object.keys(identity.getTools()), ["read"]);
  });
});
