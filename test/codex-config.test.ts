import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addCoCheckHooks, removeCoCheckHooks, hasCoCheckHooks } from "../src/codex-config.ts";

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];
const opts = { events: EVENTS, command: (e: string) => `/opt/cocheck/dist/hook.js --host codex ${e}` };

// Shape copied from the live Codex 0.162 run config (features block, per-event two-level hook tables).
const LIVE = [
  'model_reasoning_summary = "detailed"',
  "[features]",
  "hooks = true",
  "codex_hooks = true",
  "[[hooks.PreToolUse]]",
  "[[hooks.PreToolUse.hooks]]",
  'type = "command"',
  'command = "/usr/local/bin/mine.sh PreToolUse"',
  "[[hooks.Stop]]",
  "[[hooks.Stop.hooks]]",
  'type = "command"',
  'command = "/usr/local/bin/mine.sh Stop"',
  "",
].join("\n");

const WITH_TABLES = [
  "# my codex config",
  'model = "gpt-5"   # keep',
  "",
  "[profiles.fast]",
  'model = "x"',
  "",
  "[mcp_servers.foo]",
  'command = "foo"',
  "",
].join("\n");

const FEATURES_NO_HOOKS = '[features]\ncodex_hooks = true\n\n[profiles.a]\nmodel = "y"\n';
const FEATURES_HOOKS_FALSE = '# top\n[features]\nhooks = false # off for now\nother = 1\n\n[tui]\nx = 1\n';
const FEATURES_LAST_NO_NL = "[features]";
const DOTTED = 'features.hooks = false\nmodel = "m"\n\n[tui]\nx = 1\n';
const DOTTED_NO_HOOKS = 'features.other = true\nmodel = "m"\n\n[tui]\nx = 1\n';
const INLINE = 'features = { hooks = false }\nmodel = "m"\n';
const NO_TRAILING_NL = 'model = "m"\n[tui]\nx = 1';

const crlf = (s: string) => s.replace(/\n/g, "\r\n");

const FIXTURES: Record<string, string> = {
  empty: "",
  live: LIVE,
  tables: WITH_TABLES,
  featuresNoHooks: FEATURES_NO_HOOKS,
  featuresHooksFalse: FEATURES_HOOKS_FALSE,
  featuresHeaderOnlyNoNl: FEATURES_LAST_NO_NL,
  dotted: DOTTED,
  dottedNoHooks: DOTTED_NO_HOOKS,
  inline: INLINE,
  noTrailingNl: NO_TRAILING_NL,
  crlfLive: crlf(LIVE),
  crlfTables: crlf(WITH_TABLES),
  crlfFeaturesHooksFalse: crlf(FEATURES_HOOKS_FALSE),
};

describe("codex-config", () => {
  for (const [name, original] of Object.entries(FIXTURES)) {
    it(`${name}: add then remove restores the original bytes`, () => {
      const added = addCoCheckHooks(original, opts);
      assert.equal(added.changed, true);
      assert.equal(hasCoCheckHooks(added.toml), true);
      const removed = removeCoCheckHooks(added.toml);
      assert.equal(removed.changed, true);
      assert.equal(removed.toml, original);
      assert.equal(hasCoCheckHooks(removed.toml), false);
    });

    it(`${name}: double add equals single add`, () => {
      const once = addCoCheckHooks(original, opts);
      const twice = addCoCheckHooks(once.toml, opts);
      assert.equal(twice.toml, once.toml);
      assert.equal(twice.changed, false);
    });

    it(`${name}: remove without CoCheck entries is unchanged`, () => {
      const r = removeCoCheckHooks(original);
      assert.equal(r.toml, original);
      assert.equal(r.changed, false);
    });

    it(`${name}: add keeps the original as an untouched prefix or only edits the features key`, () => {
      const added = addCoCheckHooks(original, opts).toml;
      const keep = original.split(/\r?\n/).filter((l) => l !== "" && !/^\s*hooks\s*=\s*false/.test(l) && l !== "[features]");
      for (const line of keep) assert.ok(added.includes(line), `lost line: ${line}`);
    });
  }

  it("empty file gets one entry per event and no [features] block", () => {
    const { toml } = addCoCheckHooks("", opts);
    assert.doesNotMatch(toml, /features/);
    assert.doesNotMatch(toml, /^hooks = /m);
    for (const e of EVENTS) {
      assert.ok(toml.includes(`[[hooks.${e}]]`));
      assert.ok(toml.includes(`[[hooks.${e}.hooks]]`));
      assert.ok(toml.includes(`command = "/opt/cocheck/dist/hook.js --host codex ${e}"`));
    }
  });

  it("user's own hooks for the same event survive add and remove", () => {
    const added = addCoCheckHooks(LIVE, opts).toml;
    assert.ok(added.startsWith(LIVE));
    assert.equal((added.match(/^\[\[hooks\.Stop\]\]/gm) ?? []).length, 2);
    assert.equal(removeCoCheckHooks(added).toml, LIVE);
  });

  it("the features table is never written, whatever it holds", () => {
    for (const src of [LIVE, FEATURES_NO_HOOKS, FEATURES_HOOKS_FALSE, FEATURES_LAST_NO_NL, DOTTED, DOTTED_NO_HOOKS, INLINE]) {
      const added = addCoCheckHooks(src, opts).toml;
      const lines = (t: string) => t.split("\n").filter((l) => /^\s*(\[features\]|hooks\s*=|features\b)/.test(l));
      assert.deepEqual(lines(added), lines(src));
      assert.doesNotMatch(added, /cocheck-prev/);
      assert.equal(removeCoCheckHooks(added).toml, src);
    }
  });

  it("remove never deletes a user hook or key that merely resembles CoCheck's", () => {
    const user = '[features]\nhooks = true\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "node dist/hook.js --host codex Stop"\n';
    const r = removeCoCheckHooks(user);
    assert.equal(r.toml, user);
    assert.equal(r.changed, false);
    assert.equal(hasCoCheckHooks(user), false);
  });

  it("commands with quotes and backslashes are escaped", () => {
    const { toml } = addCoCheckHooks("", { events: ["Stop"], command: () => 'a "b" \\c' });
    assert.ok(toml.includes('command = "a \\"b\\" \\\\c"'));
  });

  it("add only appends events that are missing", () => {
    const partial = addCoCheckHooks("", { ...opts, events: ["Stop"] }).toml;
    const full = addCoCheckHooks(partial, opts);
    assert.equal(full.changed, true);
    assert.equal((full.toml.match(/^\[\[hooks\.Stop\]\]/gm) ?? []).length, 1);
    assert.equal(removeCoCheckHooks(full.toml).toml, "");
  });
});

// Shape of a config after Codex wrote its trust records after an earlier install (placeholder values only).
const STATE = [
  "[hooks.state]",
  "",
  '[hooks.state."/home/u/.codex/config.toml:pre_tool_use:0:0"]',
  'trusted_hash = "sha256:aaaa"',
  "",
  '[hooks.state."/home/u/.codex/config.toml:stop:0:0"]',
  'trusted_hash = "sha256:bbbb"',
  "",
].join("\n");
describe("hooks.state trust tables", async () => {
  const { codex } = await import("../src/hosts/codex.ts");
  const add = (t: string) => codex.install!.addHooks!(t, "config.toml", { dataHome: "/h", launcher: "/l.sh", hookPath: "/hook.js", host: "codex" });

  it("accepts a config whose only hooks tables are hooks.state, and keeps them byte for byte", () => {
    const original = `model = "m"\n\n${STATE}`;
    const out = add(original);
    assert.ok(out.startsWith(original));
    assert.match(out, /^\[\[hooks\.Stop\]\] # cocheck$/m);
  });

  it("still refuses hooks tables that would clash with [[hooks.X]]", () => {
    for (const bad of ['[hooks]\nStop = []\n', "[hooks.Stop]\nx = 1\n", 'hooks.Stop = []\n', "[hooks]\n", '[hooks.state]\n\n[hooks.PreToolUse]\n']) {
      assert.throws(() => add(bad), /already has/, bad);
    }
  });
});
