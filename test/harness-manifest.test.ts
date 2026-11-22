import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHarnessFolder } from "../src/hosts/harnesses.ts";
import { patternProblem } from "../src/hosts/manifest.ts";
import { knownExtra, extras } from "../src/hosts/extras.ts";
import { compileManifest, readPath } from "../src/hosts/compile.ts";
import { validateManifest } from "../src/hosts/manifest.ts";
import { loadOutsiderHarnesses, allProfiles, skippedHarnesses } from "../src/hosts/index.ts";
import { normalize } from "../src/normalize.ts";
import { RECORDINGS, readGolden, replayRecording } from "./hook-real-recordings.ts";
import { TOY } from "./harness-toy-rig.ts";

const toy = (): Record<string, any> => JSON.parse(readFileSync(path.join(TOY, "cocheck-harness.json"), "utf8"));
const label = "toyagent/cocheck-harness.json";
const scratch = (): string => mkdtempSync(path.join(tmpdir(), "cocheck-harnesses-"));
const put = (dir: string, name: string, body: unknown): void => {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, "cocheck-harness.json"), typeof body === "string" ? body : JSON.stringify(body));
};

describe("harness manifest validation names the field", () => {
  it("accepts the toy manifest", () => {
    assert.equal(validateManifest(toy(), label).key, "toyagent");
  });
  it("an unknown event kind", () => {
    const m = toy();
    m.events.beforeTool = "tool-pree";
    assert.throws(() => validateManifest(m, label), { message: `${label}: events.beforeTool: unknown kind "tool-pree"` });
  });
  it("an unknown extra", () => {
    const m = toy();
    m.extras = ["codex-rollout-narration", "my-own-code"];
    assert.throws(() => validateManifest(m, label), (e: Error) => e.message.startsWith(`${label}: extras[1]: unknown extra "my-own-code"`));
  });
  it("a known extra passes, and every registered extra is known", () => {
    const m = toy();
    m.extras = ["claude-transcript-narration"];
    validateManifest(m, label);
    for (const name of Object.keys(extras())) assert.ok(knownExtra(name), name);
  });
  it("a bad payload path, a wrong schema, an unknown field, a bad install block", () => {
    let m = toy();
    m.fields.session = "session id";
    assert.throws(() => validateManifest(m, label), (e: Error) => e.message.startsWith(`${label}: fields.session: not a payload path`));
    m = toy();
    m.schema = "cocheck-harness/2";
    assert.throws(() => validateManifest(m, label), (e: Error) => e.message.startsWith(`${label}: schema:`));
    m = toy();
    m.colour = "red";
    assert.throws(() => validateManifest(m, label), { message: `${label}: colour: unknown field` });
    m = toy();
    delete m.install.path;
    assert.throws(() => validateManifest(m, label), { message: `${label}: install.path: expected a string` });
    m = toy();
    m.failure = { "tool-post": { exitCode: { from: "tool.result.text", pattern: "(" } } };
    assert.throws(() => validateManifest(m, label), (e: Error) => e.message.startsWith(`${label}: failure.tool-post.exitCode.pattern: not a regular expression`));
  });
});

describe("compiled profile reads the payload by the manifest's paths", () => {
  it("nested and indexed paths", () => {
    assert.equal(readPath({ a: { b: [{ c: 7 }] } }, "a.b[0].c"), 7);
    assert.equal(readPath({ a: {} }, "a.b[0].c"), undefined);
    assert.equal(readPath({ roots: ["/x"] }, "roots[0]"), "/x");
  });
  it("event from the argument, json-text tool input, synthesized id, failure and refine rules, name strip", () => {
    const m = toy();
    m.failure = { "tool-failure": { text: ["error.message"], interrupt: "error.interrupted" }, "tool-post": { exitCode: { from: "tool.result.text", pattern: "exit (-?\\d+)" }, inferred: true } };
    m.refine = [{ kinds: ["prompt"], becomes: "other", whenMatches: { path: "userText", pattern: "^<note>.*</note>$" } }];
    m.toolNameStrip = { prefix: "ns_" };
    m.extraFields = { model: "meta.model" };
    const profile = compileManifest(validateManifest(m, label), "outsider");
    assert.equal(profile.trust, "outsider");
    const at = (event: string, raw: unknown) => normalize("toyagent", raw, event);
    // (registered through the loader in the other tests; here the profile is read directly)
    const read = (event: string, raw: Record<string, unknown>) => profile.readPayload!(raw, event);
    const p = read("beforeTool", { sessionId: "s", workspace: { roots: ["/w"] }, tool: { name: "ns_read_file", args: '{"path":"/w/a"}' } });
    assert.equal(p.session, "s");
    assert.equal(p.cwd, "/w");
    assert.equal(p.toolName, "ns_read_file");
    assert.equal(profile.toolName!("ns_read_file", p), "read_file");
    assert.deepEqual(profile.parseToolInput!(p.toolInput), { path: "/w/a" });
    assert.equal(profile.calls!.syntheticId("s", 3), "toyagent-s-3");
    assert.equal(profile.failureOf("tool-failure", read("toolFailed", { error: { message: "boom", interrupted: true } }))!.raw, "boom");
    assert.equal(profile.failureOf("tool-failure", read("toolFailed", { error: { message: "boom", interrupted: true } }))!.interrupted, true);
    assert.deepEqual(profile.failureOf("tool-post", read("afterTool", { tool: { result: { text: "done\nexit 2" } } })), { raw: "done\nexit 2", interrupted: false, inferred: true });
    assert.equal(profile.failureOf("tool-post", read("afterTool", { tool: { result: { text: "exit 0" } } })), undefined);
    assert.equal(profile.refineKind!("prompt", read("userPrompt", { userText: "  <note>x</note> " })), "other");
    assert.equal(profile.refineKind!("prompt", read("userPrompt", { userText: "fix it" })), "prompt");
    assert.deepEqual(profile.extraOf(read("beforeTool", { meta: { model: "m1" } })), { model: "m1" });
    assert.equal(typeof at, "function");
  });
  it("a tool-post failure rule with nonEmpty: words at a text path mean the call failed; empty or absent words do not", () => {
    const m = toy();
    m.failure = { "tool-post": { text: ["result.error"], nonEmpty: true } };
    for (const source of ["outsider", "built-in"] as const) {
      const p = compileManifest(validateManifest(m, label, { outsider: source === "outsider" }), source);
      assert.deepEqual(p.failureOf!("tool-post", { result: { error: "target not found" } }), { raw: "target not found", interrupted: false }, source);
      assert.equal(p.failureOf!("tool-post", { result: { error: "" } }), undefined, source);
      assert.equal(p.failureOf!("tool-post", { result: {} }), undefined, source);
    }
    // Without nonEmpty, text alone still names the words and decides nothing (as before).
    m.failure = { "tool-post": { text: ["result.error"] } };
    assert.equal(compileManifest(validateManifest(m, label), "outsider").failureOf!("tool-post", { result: { error: "x" } }), undefined);
    m.failure = { "tool-post": { nonEmpty: true } };
    assert.throws(() => validateManifest(m, label), { message: `${label}: failure.tool-post.nonEmpty: needs text: the paths whose words mean the call failed` });
    m.failure = { "tool-failure": { text: ["e"], nonEmpty: true } };
    assert.throws(() => validateManifest(m, label), (e: Error) => e.message.startsWith(`${label}: failure.tool-failure.nonEmpty: only a tool-post rule`));
    m.failure = { "tool-post": { text: ["e"], nonEmpty: 1 } };
    assert.throws(() => validateManifest(m, label), { message: `${label}: failure.tool-post.nonEmpty: expected true` });
  });
  it("the session file template: a missing root is refused under the test runner, a given root is used", () => {
    const m = toy();
    m.sessionFile = { bySessionId: true, defaultRoot: "{home}/.toyagent/sessions", file: "{root}/{session}.jsonl" };
    const profile = compileManifest(validateManifest(m, label), "outsider");
    assert.throws(() => profile.sessionFile.locate("abc", 0), /refusing/);
    assert.equal(profile.sessionFile.locate("abc", 0, "/r"), path.normalize("/r/abc.jsonl"));
    assert.equal(profile.sessionFile.locate("../x", 0, "/r"), undefined);
  });
});

describe("the loader", () => {
  it("loads a good manifest as an outsider", () => {
    const dir = scratch();
    put(dir, "toyagent", toy());
    const r = loadHarnessFolder(dir, "outsider", ["claude"]);
    assert.deepEqual(r.errors, []);
    assert.equal(r.profiles[0]!.trust, "outsider");
  });
  it("a manifest may not reuse a built-in key (the folder name and the key both)", () => {
    const dir = scratch();
    put(dir, "claude", { ...toy(), key: "claude" });
    put(dir, "codex", { ...toy(), key: "toyagent" });
    const r = loadHarnessFolder(dir, "outsider", ["claude", "codex", "copilot"]);
    assert.deepEqual(r.profiles, []);
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[0]!, /claude\/cocheck-harness\.json: key: "claude" is already a host; a manifest cannot reuse a key/);
    assert.match(r.errors[1]!, /key: "toyagent" must match the folder name "codex"/);
  });
  it("through the registry: a built-in key is rejected and the built-in host stays the built-in one", () => {
    const dir = scratch();
    put(dir, "claude", { ...toy(), key: "claude" });
    const errors = loadOutsiderHarnesses(dir);
    try {
      assert.equal(errors.length, 1);
      assert.equal(allProfiles().filter((p) => p.key === "claude").length, 1);
      assert.equal(allProfiles().find((p) => p.key === "claude")!.trust, undefined);
    } finally {
      loadOutsiderHarnesses(undefined);
    }
  });
  it("an outsider may not tag shell calls or take the `both` alias; it may declare a foreign-hook fingerprint (gated on its own install)", () => {
    const dir = scratch();
    put(dir, "toyagent", { ...toy(), argvTag: { tool: "run_shell", preOutput: {}, envFileVar: "X", shellEnv: "Y", sessionStartEvent: "s" } });
    put(dir, "toytwo", { ...toy(), key: "toytwo", foreignHookFingerprint: { present: ["a"], strings: [], absent: [] }, capabilities: { ...toy().capabilities, readsForeignHooks: true } });
    put(dir, "toythree", { ...toy(), key: "toythree", install: { ...toy().install, inBothAlias: true } });
    const r = loadHarnessFolder(dir, "outsider", []);
    assert.deepEqual(r.profiles.map((p) => p.key), ["toytwo"]);
    assert.equal(r.errors.length, 2);
    // a broken one beside a good one: the good one loads
    put(dir, "good", { ...toy(), key: "good" });
    put(dir, "bad", "{ not json");
    const again = loadHarnessFolder(dir, "outsider", []);
    assert.deepEqual(again.profiles.map((p) => p.key), ["good", "toytwo"]);
    assert.ok(again.errors.some((e) => e === "bad/cocheck-harness.json: not valid JSON"));
  });
});

describe("a broken outsider manifest never stops another host's hook", () => {
  it("the Claude recording replays into its golden with malformed, invalid and key-reusing manifests in the outsider folder", { timeout: 300_000 }, async () => {
    const dir = scratch();
    put(dir, "broken", "{ not json");
    put(dir, "mistyped", { ...toy(), key: "mistyped", events: { beforeTool: "tool-pree" } });
    put(dir, "claude", { ...toy(), key: "claude" });
    const saved = process.env.COCHECK_HARNESS_DIR;
    process.env.COCHECK_HARNESS_DIR = dir;
    try {
      const rec = RECORDINGS.find((r) => r.name === "claude-2.1.302")!;
      const run = await replayRecording(rec);
      if (process.platform === "win32") {
        // The golden holds POSIX-form paths, so the full dump is not compared here: the claim that the other host still records is its op count and the credit it gives each file.
        const golden = readGolden(rec) as { ops: unknown[]; file_states: Array<{ file_path: string; phase: string; credited_json: string }> };
        const credit = (rows: Array<{ file_path: string; phase: string; credited_json: string }>) => rows.map((r) => `${r.file_path.split(/[\\/]/).pop()} ${r.phase} ${r.credited_json}`);
        assert.equal(run.dump.ops.length, golden.ops.length);
        assert.deepEqual(credit(run.dump.file_states as typeof golden.file_states), credit(golden.file_states));
      } else assert.deepEqual(run.dump, readGolden(rec));
      assert.equal(skippedHarnesses().length, 3, skippedHarnesses().join("\n"));
    } finally {
      if (saved === undefined) delete process.env.COCHECK_HARNESS_DIR;
      else process.env.COCHECK_HARNESS_DIR = saved;
      loadOutsiderHarnesses(undefined);
    }
  });
});

describe("an outsider manifest names only extras that are safe for it", () => {
  it("claude-reveal, transcript-coverage and codex-rollout-locate are refused for an outsider and allowed for a built-in manifest", () => {
    for (const name of ["claude-reveal", "transcript-coverage", "codex-rollout-locate", "claude-transcript-narration", "codex-toml-editor"]) {
      const m = toy();
      m.extras = [name];
      assert.throws(() => validateManifest(m, label, { outsider: true }), { message: `${label}: extras[0]: the extra "${name}" is first-party code for built-in manifests; a manifest in your own folder cannot name it` });
      assert.equal(validateManifest(m, label).extras![0], name, "a built-in manifest can name it");
    }
    const safe = toy();
    safe.extras = ["codex-display-text"];
    validateManifest(safe, label, { outsider: true });
  });
  it("through the loader: an outsider folder with claude-reveal is skipped, the same manifest as a built-in loads", () => {
    const dir = scratch();
    put(dir, "toyagent", { ...toy(), extras: ["claude-reveal"] });
    const out = loadHarnessFolder(dir, "outsider", []);
    assert.deepEqual(out.profiles, []);
    assert.match(out.errors[0]!, /extras\[0\]: the extra "claude-reveal" is first-party code/);
    const built = loadHarnessFolder(dir, "built-in", []);
    assert.equal(built.profiles[0]!.reveal !== undefined, true);
  });
});

describe("manifest regular expressions are bounded", () => {
  it("a nested repetition is rejected at validation with the field named", () => {
    const m = toy();
    m.toolNameStrip = { prefix: "(a+)+$" };
    assert.throws(() => validateManifest(m, label), { message: `${label}: toolNameStrip.prefix: nested repetition not allowed: "(a+)+$"` });
    const n = toy();
    n.failure = { "tool-post": { exitCode: { from: "tool.result.text", pattern: "(a|a)*b" } } };
    assert.throws(() => validateManifest(n, label), (e: Error) => e.message.startsWith(`${label}: failure.tool-post.exitCode.pattern: nested repetition`));
    const r = toy();
    r.refine = [{ kinds: ["prompt"], becomes: "other", whenMatches: { path: "userText", pattern: "x".repeat(201) } }];
    assert.throws(() => validateManifest(r, label), (e: Error) => e.message.startsWith(`${label}: refine[0].whenMatches.pattern: pattern longer than`));
  });
  it("ordinary patterns pass; backreferences and lookarounds do not", () => {
    for (const ok of ["exit (-?\\d+)", "^mcp__", "^(?:collaboration|agent)[.:/]?", "^<system_notification>[^<]*</system_notification>$", "(ab)?c", "(\\d+)(?:ms)?$"]) assert.equal(patternProblem(ok), undefined, ok);
    for (const bad of ["(a)\\1", "(?=a)b", "(a*)*", "(ab+)+x", "((a)|b)+"]) assert.notEqual(patternProblem(bad), undefined, bad);
  });
  it("a compiled pattern only ever sees a bounded input: a long tool name is cut before the match", () => {
    const m = toy();
    m.toolNameStrip = { prefix: "a*b" };
    const profile = compileManifest(validateManifest(m, label), "outsider");
    const started = Date.now();
    profile.toolName!("a".repeat(200_000), {});
    assert.ok(Date.now() - started < 5000, "bounded");
  });
});
