// The Codex manifest, compiled, behaves as the profile it replaced. The old profile is frozen in test/fixtures/frozen-codex-profile.ts; every data
// member is compared, and every function member runs on the inputs of the real recordings under platforms/codex/ (payload lines, rollouts) and on
// install configs. A deliberate one-field change to the manifest must show up as a difference.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileManifest } from "../src/hosts/compile.ts";
import { validateManifest } from "../src/hosts/manifest.ts";
import { profileOf } from "../src/hosts/index.ts";
import { newCursor } from "../src/narration.ts";
import type { HostProfile } from "../src/hosts/types.ts";
import { codex as frozen } from "./fixtures/frozen-codex-profile.ts";

const root = path.resolve(import.meta.dirname, "..");
const MANIFEST = path.join(root, "harnesses", "codex", "cocheck-harness.json");
const versions = path.join(root, "platforms", "codex", "versions");
const load = (): any => JSON.parse(readFileSync(MANIFEST, "utf8"));
const compile = (m: unknown): HostProfile => compileManifest(validateManifest(m, "codex/cocheck-harness.json"), "built-in");

/** What a profile makes of one raw payload, the way the normalizer reads it. */
function readOne(p: HostProfile, raw: any, eventArg?: string): unknown {
  const q = p.readPayload === undefined ? raw : p.readPayload(raw, eventArg);
  const f = p.fields;
  const name = q[f.eventName];
  const named = (typeof name === "string" && Object.hasOwn(p.eventKinds, name) ? p.eventKinds[name] : undefined) ?? "other";
  const kind = p.refineKind === undefined ? named : p.refineKind(named, q);
  const reported = q[f.toolName];
  return {
    kind,
    fields: Object.fromEntries((["session", "cwd", "toolName", "toolInput", "toolResponse", "toolUseId", "agentId", "agentType", "transcriptPath", "lastAssistantMessage", "prompt", "eventName"] as const).map((k) => [k, f[k] === undefined ? undefined : q[f[k]!]])),
    reason: f.callReason,
    toolName: typeof reported === "string" && p.toolName !== undefined ? p.toolName(reported, q) : reported,
    parsed: p.parseToolInput === undefined ? undefined : p.parseToolInput(q[f.toolInput]),
    failure: p.failureOf(kind, q),
    extra: p.extraOf(q),
  };
}

const payloads = (): any[] => {
  const out: any[] = [];
  for (const [dir, file] of [["0.162.0-alpha.2", "payloads.jsonl"], ["0.164.0-alpha.11.1", "hook-calls-run2.jsonl"], ["0.169.0", "payloads-write-tools.jsonl"]] as const) {
    for (const line of readFileSync(path.join(versions, dir, file), "utf8").split("\n")) {
      if (line === "") continue;
      const d = JSON.parse(line);
      out.push(typeof d.stdin === "string" ? JSON.parse(d.stdin) : d.stdin);
    }
  }
  return out;
};

/** Payloads the recordings do not hold: failures of every shape the old reader knew, and tool names with a namespace. */
const SYNTHETIC: any[] = [
  { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_response: "ls: nope: No such file or directory\nsh: x: command not found" },
  { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_response: "ls: nope: No such file or directory\nand then some words" },
  { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_response: "" },
  { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_response: { is_error: true, content: "boom" } },
  { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_response: { isError: true, content: [{ text: "a" }, { text: "b" }] } },
  { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", error: "top", tool_response: { is_error: true } },
  { hook_event_name: "PostToolUseFailure", session_id: "s", tool_name: "Bash", error: "bad", is_interrupt: true },
  { hook_event_name: "PreToolUse", session_id: "s", tool_name: "collaborationsend_message", turn_id: "t", permission_mode: "plan", model: "m", stop_hook_active: true },
  { hook_event_name: "PreToolUse", session_id: "s", tool_name: "agent.spawn_agent", tool_input: "{}" },
  { hook_event_name: "PreToolUse", session_id: "s", tool_name: "mcp__srv__tool", tool_namespace: "mcp__srv" },
  { hook_event_name: "PreToolUse", session_id: "s", tool_name: "collaboration", namespace: "collaboration" },
  { hook_event_name: "Stop", session_id: "s", last_assistant_message: "done" },
];

function rolloutFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (/^(rollout-|main-|helper-).*\.jsonl$/.test(e.name)) out.push(path.join(d, e.name));
    }
  };
  walk(versions);
  return out;
}

const SPEC = { dataHome: "/Users/me/CoCheck Data", launcher: "/opt/launch.sh", hookPath: "/opt/cocheck/dist/hook.js", host: "codex" };
const CONFIGS = [
  "",
  'model = "gpt-6"\r\n[mcp_servers.x]\r\ncommand = "x"\r\n\r\n[[hooks.PreToolUse]]\r\n[[hooks.PreToolUse.hooks]]\r\ntype = "command"\r\ncommand = "/usr/local/bin/mine.sh"',
  'hooks = { PreToolUse = [] }\n',
  "[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = \"/me/stop.sh\"\n",
];

/** Every difference between a compiled profile and the frozen one, as short lines. Empty when they agree. */
function differences(p: HostProfile): string[] {
  const out: string[] = [];
  const same = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(what);
  };
  const call = (fn: () => unknown): unknown => {
    try {
      return { ok: fn() };
    } catch (e) {
      return { threw: (e as Error).message };
    }
  };
  for (const k of ["key", "displayName", "fullName", "chip", "testedVersions", "eventKinds", "capabilities", "toolClasses", "fields", "shape", "sessionEnv", "argvTag", "perAction", "hostOwnedFiles", "foreignHookFingerprint", "readsConfigsOf", "eventFromArg", "unverifiedEvents", "calls", "refineKind", "parseToolInput", "trust", "helpers", "coverage", "reveal"] as const) same(k, (p as any)[k], (frozen as any)[k]);
  same("narration.sources", p.narration.sources, frozen.narration.sources);
  same("narration.closingWaitMs", p.narration.closingWaitMs, frozen.narration.closingWaitMs);
  const [pi, fi] = [p.install!, frozen.install!];
  for (const k of ["skillRoot", "inBothAlias", "reusesRecord", "hostFlag", "folderFromPayloadCwd", "events", "afterInstall", "ownsFile", "promptContext", "projectDirEnv", "timingLabel"] as const) same(`install.${k}`, pi[k], fi[k]);
  for (const folder of ["/work", "C:\\Users\\me\\work"]) same("install.checkPayload", pi.checkPayload(folder), fi.checkPayload(folder));
  same("sessionFile.bySessionId", p.sessionFile.bySessionId, frozen.sessionFile.bySessionId);
  same("sessionTitle", typeof p.sessionTitle, typeof frozen.sessionTitle);
  same("displayText", typeof p.displayText, typeof frozen.displayText);

  for (const raw of [...payloads(), ...SYNTHETIC]) same(`payload ${JSON.stringify(raw).slice(0, 80)}`, call(() => readOne(p, raw)), call(() => readOne(frozen, raw)));
  for (const raw of [null, 3, "x", []]) same(`odd payload ${JSON.stringify(raw)}`, call(() => (p.readPayload === undefined ? raw : p.readPayload(raw))), call(() => raw));
  for (const name of ["collaborationsend_message", "collaboration.x", "agent:list_agents", "agentFoo", "Bash", "mcp__a__b", "collaboration"]) {
    for (const extra of [{}, { tool_namespace: "collaboration" }, { namespace: "mcp" }]) same(`toolName ${name}`, p.toolName!(name, extra), frozen.toolName!(name, extra));
  }
  for (const text of ["see :codex-file-citation{path=\"/a/b/File.csv\" purpose=\"output\"} ok", "plain"]) same("displayText", p.displayText!(text), frozen.displayText!(text));

  for (const file of rolloutFiles()) {
    const [a, b] = [newCursor(file), newCursor(file)];
    const calls: Array<[string, unknown]> = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      p.narration.foldLine(a, line);
      frozen.narration.foldLine(b, line);
      p.narration.claimAtPre?.(a, "x");
      frozen.narration.claimAtPre?.(b, "x");
    }
    calls.push(["cursor", [a, b]]);
    same(`narration ${path.basename(file)}`, a, b);
    same(`closing ${path.basename(file)}`, p.narration.closing(a), frozen.narration.closing(b));
    const sf = [p.sessionFile, frozen.sessionFile];
    same(`callText ${path.basename(file)}`, [...(sf[0]!.callText!(file) ?? [])], [...(sf[1]!.callText!(file) ?? [])]);
    same(`callExit ${path.basename(file)}`, [...(sf[0]!.callExit!(file) ?? [])], [...(sf[1]!.callExit!(file) ?? [])]);
    same(`refused ${path.basename(file)}`, sf[0]!.refusedCommands!(file), sf[1]!.refusedCommands!(file));
  }
  same("closing of nothing", p.narration.closing(undefined), frozen.narration.closing(undefined));

  // The rollout lookup, over a temp sessions folder with a main rollout and a helper's.
  const sess = mkdtempSync(path.join(tmpdir(), "cocheck-codex-equiv-"));
  const main = "01a16ff1-ac5d-78f1-a588-6ff46ea9e279";
  const helper = "01a16ff1-c26a-7f03-80e7-465fcf0b0f19";
  const day = path.join(sess, "2026", "10", "24");
  mkdirSync(day, { recursive: true });
  writeFileSync(path.join(day, `rollout-2026-10-24T18-04-31-${main}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: main } }) + "\n");
  writeFileSync(path.join(day, `rollout-2026-10-24T18-04-37-${helper}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: helper, parent_thread_id: main } }) + "\n");
  const now = Date.UTC(2026, 9, 24, 12);
  for (const id of [main, helper, "not-a-uuid", main.toUpperCase()]) same(`locate ${id}`, p.sessionFile.locate(id, now, sess), frozen.sessionFile.locate(id, now, sess));
  for (const [s, h] of [[main, helper], [main, main], [helper, main], ["x", helper]] as const) same(`locateHelper ${s} ${h}`, p.sessionFile.locateHelper!(s, h, now, sess), frozen.sessionFile.locateHelper!(s, h, now, sess));
  same("title", p.sessionTitle!(main, sess), frozen.sessionTitle!(main, sess));

  // Install: add, remove and missing on configs that hold the user's own hooks, and the trust step.
  const file = "/c/config.toml";
  for (const env of [{}, { CODEX_HOME: "/x/codex" }]) same("configFile", pi.configFile(env, "/h"), fi.configFile(env, "/h"));
  for (const text of CONFIGS) {
    same(`addHooks ${JSON.stringify(text).slice(0, 30)}`, call(() => pi.addHooks(text, file, SPEC)), call(() => fi.addHooks(text, file, SPEC)));
    same("addHooks dry run", call(() => pi.addHooks(text, file, undefined)), call(() => fi.addHooks(text, file, undefined)));
    const added = String((call(() => fi.addHooks(text, file, SPEC)) as any).ok ?? text);
    for (const t of [text, added]) {
      same("removeHooks", call(() => pi.removeHooks(t, file)), call(() => fi.removeHooks(t, file)));
      same("missingEvents", call(() => pi.missingEvents(t, file)), call(() => fi.missingEvents(t, file)));
    }
  }
  for (const read of [undefined, "live" as const, () => undefined, () => ({ hooks: [] })]) {
    if (read === "live") continue; // asks the real binary
    same("trustProblem", call(() => pi.trustProblem!("/h/.codex/config.toml", {}, "/opt/hook.js", read as any)), call(() => fi.trustProblem!("/h/.codex/config.toml", {}, "/opt/hook.js", read as any)));
  }
  return out;
}

describe("the Codex manifest compiles to the profile it replaced", () => {
  it("the registry serves Codex from the manifest, and nothing differs from the frozen profile", () => {
    assert.deepEqual(differences(profileOf("codex")), []);
  });

  it("the recordings are read (the comparison is not empty)", () => {
    assert.ok(payloads().length > 30);
    assert.ok(rolloutFiles().length >= 4);
  });

  for (const [what, mutate] of [
    ["a tool class", (m: any) => void (m.toolClasses.Bash.class = "read")],
    ["a payload path", (m: any) => void (m.fields.toolInput = "input")],
    ["an event kind", (m: any) => void (m.events.Stop = "other")],
    ["the install check payload", (m: any) => void (m.install.checkPayload.payload.tool_name = "Read")],
    ["an extra", (m: any) => void (m.extras = m.extras.filter((e: string) => e !== "codex-failure-read"))],
    ["the shape table", (m: any) => void (m.shape.Stop = ["session_id", "x"])],
    ["a narration source", (m: any) => void (m.narration.sources[0].readableAt = "post")],
  ] as const) {
    it(`a one-field change shows as a difference: ${what}`, () => {
      const m = load();
      mutate(m);
      assert.notDeepEqual(differences(compile(m)), []);
    });
  }
});
