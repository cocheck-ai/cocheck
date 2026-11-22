import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { newCursor } from "../src/narration.ts";
import { compileManifest } from "../src/hosts/compile.ts";
import { validateManifest } from "../src/hosts/manifest.ts";
import { profileOf } from "../src/hosts/index.ts";
import { platformFor } from "../src/platform/index.ts";
import type { HostProfile } from "../src/hosts/types.ts";
import { copilot as OLD } from "./fixtures/hosts/legacy-copilot-profile.ts";

// The Copilot profile built from its manifest equals the profile the host had as code (a frozen copy under test/fixtures/hosts/): every data member,
// and every function member on every payload line of the real recordings (platforms/copilot-cli, platforms/copilot-vscode) plus the shapes the recordings lack.
const PLATFORMS = path.join(import.meta.dirname, "..", "platforms");
const MANIFEST = path.join(import.meta.dirname, "..", "harnesses", "copilot", "cocheck-harness.json");

interface Wire {
  event: string;
  stdin: Record<string, unknown>;
}
function recorded(): Wire[] {
  const out: Wire[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl") && !e.name.startsWith("events-") && e.name !== "session-events.jsonl") {
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (line.trim() === "") continue;
          let d: any;
          try {
            d = JSON.parse(line);
          } catch {
            continue;
          }
          if (d?.stdin !== null && typeof d?.stdin === "object") out.push({ event: String(d.event_arg ?? d.stdin.hook_event_name ?? "preToolUse"), stdin: d.stdin });
          else if (d !== null && typeof d === "object" && typeof d.sessionId === "string") out.push({ event: e.name.replace(/\.jsonl$/, ""), stdin: d });
        }
      }
    }
  };
  walk(path.join(PLATFORMS, "copilot-cli"));
  walk(path.join(PLATFORMS, "copilot-vscode"));
  return out;
}

/** Payload shapes the recordings do not hold: a failed shell exit, several exit markers, a system notice, a helper's own prompt, text tool input. */
function extra(): Wire[] {
  const base = { sessionId: "s", cwd: "/w", toolName: "bash", toolArgs: '{"command":"x"}' };
  const post = (text: unknown) => ({ event: "postToolUse", stdin: { ...base, toolResult: { textResultForLlm: text } } });
  return [
    post("out\n<shellId: 1 completed with exit code 2>"),
    post("<shellId: 1 completed with exit code 0>\n<shellId: 2 completed with exit code -1>"),
    post("<shellId: 1 completed with exit code 3>\n<shellId: 2 completed with exit code 0>"),
    post("no marker"),
    post(5),
    { event: "postToolUse", stdin: { ...base, toolResult: "text" } },
    { event: "postToolUseFailure", stdin: { ...base, error: "boom" } },
    { event: "postToolUseFailure", stdin: { ...base, error: 7 } },
    { event: "userPromptSubmitted", stdin: { sessionId: "s", prompt: "<system_notification>Agent x is idle</system_notification>" } },
    { event: "userPromptSubmitted", stdin: { sessionId: "s", prompt: "  <system_notification>a</system_notification>\n" } },
    { event: "userPromptSubmitted", stdin: { sessionId: "s", prompt: "see <system_notification>a</system_notification> here" } },
    { event: "userPromptSubmitted", stdin: { sessionId: "s", prompt: "<system_notification>a<system_notification>b</system_notification>" } },
    { event: "userPromptSubmitted", stdin: { sessionId: "s", prompt: "do it", agentId: "a1", agentType: "task", parentAgentId: "m" } },
    { event: "userPromptSubmitted", stdin: { sessionId: "s", prompt: "do it", agentId: "" } },
    { event: "agentStop", stdin: { sessionId: "s", agentId: "a1" } },
    { event: "agentStop", stdin: { sessionId: "s", agentId: 4, stop_hook_active: true } },
    { event: "preToolUse", stdin: { ...base, toolArgs: '"a patch"', cocheckLaunchKey: "k" } },
    { event: "preToolUse", stdin: { ...base, toolArgs: "12" } },
    { event: "preToolUse", stdin: { ...base, toolArgs: "not json" } },
    { event: "preToolUse", stdin: { ...base, toolArgs: { command: "y" } } },
    { event: "preToolUse", stdin: { ...base, toolCallId: "call_1" } },
    { event: "somethingNew", stdin: { sessionId: "s" } },
  ];
}

const SLOTS = ["session", "cwd", "toolName", "toolInput", "toolResponse", "agentId", "agentType", "transcriptPath", "lastAssistantMessage", "prompt", "parentSession", "launchKey", "callReason"] as const;

/** Every difference between two Copilot profiles, as one line each. Empty means equal. */
export function copilotDiffs(old: HostProfile, now: HostProfile): string[] {
  const d: string[] = [];
  const eq = (what: string, a: unknown, b: unknown): void => {
    try {
      assert.deepStrictEqual(a, b);
    } catch {
      d.push(`${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  };
  for (const k of ["key", "displayName", "chip", "testedVersions", "eventKinds", "eventFromArg", "unverifiedEvents", "capabilities", "foreignHookFingerprint", "readsConfigsOf", "toolClasses", "shape", "sessionTitle", "fullName", "sessionEnv", "argvTag", "perAction", "hostOwnedFiles"] as const) eq(k, old[k], now[k]);
  eq("narration.sources", old.narration.sources, now.narration.sources);
  eq("narration.closingWaitMs", old.narration.closingWaitMs, now.narration.closingWaitMs);
  eq("sessionFile.bySessionId", old.sessionFile.bySessionId, now.sessionFile.bySessionId);
  for (const s of SLOTS) eq(`fields.${s}`, old.fields[s], now.fields[s]);
  eq("calls.syntheticId", [old.calls!.syntheticId("S", 3), old.calls!.argsKey({ b: 1, a: [2] })], [now.calls!.syntheticId("S", 3), now.calls!.argsKey({ b: 1, a: [2] })]);
  const events = new Set(Object.keys(old.eventKinds));
  const wires = [...recorded(), ...extra()];
  for (const w of wires) events.add(w.event);
  for (const w of wires) {
    const label = `${w.event} ${String(w.stdin.toolName ?? w.stdin.prompt ?? "").slice(0, 20)}`;
    const po = old.readPayload === undefined ? w.stdin : old.readPayload(w.stdin, w.event);
    const pn = now.readPayload === undefined ? w.stdin : now.readPayload(w.stdin, w.event);
    for (const s of SLOTS) {
      if (s === "callReason") continue;
      // The call id is synthesized: the recordings carry no toolCallId, so neither side reads one.
      eq(`${label} read ${s}`, po[old.fields[s]!], pn[now.fields[s]!]);
    }
    eq(`${label} read toolUseId`, po[old.fields.toolUseId], pn[now.fields.toolUseId]);
    eq(`${label} read parseToolInput`, (old.parseToolInput ?? ((x: unknown) => x))(po[old.fields.toolInput]), (now.parseToolInput ?? ((x: unknown) => x))(pn[now.fields.toolInput]));
    const named = old.eventKinds[w.event] ?? "other";
    eq(`${label} kind`, named, now.eventKinds[w.event] ?? "other");
    for (const kind of new Set([named, "prompt", "stop", "tool-post", "tool-failure", "tool-pre"] as const)) {
      eq(`${label} refine ${kind}`, old.refineKind!(kind, po), now.refineKind!(kind, pn));
      eq(`${label} failure ${kind}`, old.failureOf(kind, po), now.failureOf(kind, pn));
    }
    eq(`${label} extraOf`, old.extraOf(po), now.extraOf(pn));
  }
  // Narration: the same cursor after every line of the recorded session files, then the closing.
  for (const file of ["copilot-cli/versions/1.0.93/session-events.jsonl", "copilot-vscode/versions/1.140.0/events-vscode-control.jsonl", "copilot-vscode/versions/1.140.0/events-vscode-notified.jsonl"]) {
    const co = newCursor("f");
    const cn = newCursor("f");
    for (const line of readFileSync(path.join(PLATFORMS, file), "utf8").split("\n")) {
      old.narration.foldLine(co, line);
      now.narration.foldLine(cn, line);
    }
    eq(`narration cursor ${file}`, co, cn);
    eq(`narration closing ${file}`, old.narration.closing(co), now.narration.closing(cn));
  }
  eq("closing of nothing", old.narration.closing(undefined), now.narration.closing(undefined));
  const uuid = "25ee9a7c-ca9a-4d10-bd2e-e53055cfac50";
  eq("locate", [old.sessionFile.locate(uuid, 0, "/r"), old.sessionFile.locate("short", 0, "/r")], [now.sessionFile.locate(uuid, 0, "/r"), now.sessionFile.locate("short", 0, "/r")]);
  const oi = old.install!;
  const ni = now.install!;
  for (const k of ["skillRoot", "hostFlag", "folderFromPayloadCwd", "ownsFile", "promptContext", "events", "afterInstall", "inBothAlias", "reusesRecord", "timingLabel", "projectDirEnv"] as const) eq(`install.${k}`, oi[k], ni[k]);
  eq("install.checkPayload", oi.checkPayload("/f/x"), ni.checkPayload("/f/x"));
  eq("install.notes", oi.notes!({ launcherDir: "/l", home: "/h" }), ni.notes!({ launcherDir: "/l", home: "/h" }));
  for (const env of [{}, { COPILOT_HOME: "/x/cp" }, { COPILOT_HOME: "" }]) eq("install.configFile", oi.configFile(env, "/home/u"), ni.configFile(env, "/home/u"));
  const mine = { hooks: { preToolUse: [{ type: "command", bash: "echo mine" }], postToolUse: [{ type: "command", bash: "echo COCHECK_MANAGED=1" }], other: [{ x: 1 }] }, extra: true };
  const files = ["", "{}", JSON.stringify(mine), JSON.stringify(mine, null, "\t"), "[]", "nope", '{"hooks":[]}', '{"hooks":{"agentStop":{}}}', '{"version":1,"hooks":{}}'];
  for (const plat of [platformFor("darwin"), platformFor("win32")]) {
    const spec = { dataHome: "/D", launcher: "/L/hook-launch.sh", hookPath: "/H/hook.js", host: "copilot" };
    const run = <T>(fn: () => T): unknown => {
      try {
        return fn();
      } catch (e) {
        return `throws ${(e as Error).message}`;
      }
    };
    for (const text of files) {
      const a0 = run(() => oi.addHooks(text, "h.json", spec, plat));
      eq(`addHooks ${text.slice(0, 20)}`, a0, run(() => ni.addHooks(text, "h.json", spec, plat)));
      eq(`removeHooks ${text.slice(0, 20)}`, run(() => oi.removeHooks(text, "h.json", plat)), run(() => ni.removeHooks(text, "h.json", plat)));
      eq(`missingEvents ${text.slice(0, 20)}`, run(() => oi.missingEvents(text, "h.json", plat)), run(() => ni.missingEvents(text, "h.json", plat)));
      if (typeof a0 === "string") {
        eq(`removeHooks after add ${text.slice(0, 20)}`, run(() => oi.removeHooks(a0, "h.json", plat)), run(() => ni.removeHooks(a0, "h.json", plat)));
        eq(`missingEvents after add ${text.slice(0, 20)}`, run(() => oi.missingEvents(a0, "h.json", plat)), run(() => ni.missingEvents(a0, "h.json", plat)));
      }
    }
  }
  return d;
}

describe("the Copilot manifest compiles to the profile the host had as code", () => {
  it("the recordings are found", () => {
    assert.ok(recorded().length > 100, `${recorded().length} recorded payload lines`);
  });

  it("every data member and every function member is equal over the recordings", () => {
    assert.deepEqual(copilotDiffs(OLD, profileOf("copilot")), []);
  });

  it("is a built-in served from its manifest, with the first-party extras it names", () => {
    const p = profileOf("copilot");
    assert.deepEqual(p.extras, ["copilot-events-narration", "copilot-events-locate", "helper-linker", "copilot-session-title"]);
    assert.equal(p.trust, undefined);
  });

  it("a one-field change in the manifest is caught", () => {
    const raw = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const build = (edit: (m: any) => void): HostProfile => {
      const m = structuredClone(raw);
      edit(m);
      return compileManifest(validateManifest(m, "copilot/cocheck-harness.json", { builtIn: true }), "built-in");
    };
    assert.deepEqual(copilotDiffs(OLD, build(() => {})), [], "the unedited copy is equal");
    const edits: Array<[string, (m: any) => void]> = [
      ["chip", (m) => (m.chip = "Q")],
      ["event kind", (m) => (m.events.agentStop = "other")],
      ["tool class", (m) => (m.toolClasses.task.class = "shell")],
      ["failure pattern", (m) => (m.failure["tool-post"].exitCode.pattern = "<shellId:\\s*[^>]*?completed with exit code (\\d+)>")],
      ["failure path", (m) => (m.failure["tool-failure"].text = ["message"])],
      ["refine", (m) => (m.refine[0].kinds = ["prompt"])],
      ["notification pattern", (m) => (m.refine[1].whenMatches.pattern = "^$")],
      ["call id", (m) => delete m.callId.payload],
      ["session field", (m) => (m.fields.session = "session")],
      ["parent field", (m) => (m.fields.parentSession = "parent")],
      ["json text", (m) => (m.toolInputEncoding = "object")],
      ["fingerprint", (m) => (m.foreignHookFingerprint.absent = ["permission_mode"])],
      ["install event", (m) => (m.install.events = m.install.events.slice(1))],
      ["fail open", (m) => (m.install.failOpenEvents = [])],
      ["notes", (m) => (m.install.notes += "!")],
      ["closing wait", (m) => (m.narration.closingWaitMs = 5)],
      ["stop hook field", (m) => delete m.extraFields],
    ];
    for (const [what, edit] of edits) assert.notDeepEqual(copilotDiffs(OLD, build(edit)), [], `a change to ${what} shows`);
  });
});
