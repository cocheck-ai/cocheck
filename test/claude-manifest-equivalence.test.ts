import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalize } from "../src/normalize.ts";
import { newCursor } from "../src/narration.ts";
import { platform as currentPlatform } from "../src/platform/index.ts";
import { profileOf, registerHost, type EventKind } from "../src/hosts/index.ts";
import { claude as OLD } from "./fixtures/frozen-hosts/claude-profile.ts";

// The Claude Code profile is compiled from harnesses/claude/cocheck-harness.json. This pins it to the profile object it replaced
// (a frozen copy in test/fixtures/frozen-hosts/): every data member equal, every function member giving the same answer on the real recording
// (platforms/claude-code/versions/2.1.302/) and on variants of its payloads.
const platform = currentPlatform();
const NEW = profileOf("claude");
const rec = path.resolve(import.meta.dirname, "../platforms/claude-code/versions/2.1.302");
const payloads: any[] = readFileSync(path.join(rec, "payloads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(JSON.parse(l).stdin));
const sessionFile = path.join(rec, "sessions", "b0f5204b-5694-452a-b345-e478329f2f19.jsonl");
const transcript = readFileSync(sessionFile, "utf8").split("\n").filter((l) => l !== "");

const FAILED = { error: "Exit code 2\nboom", is_interrupt: false };
const variants: any[] = [
  ...payloads,
  ...[
    { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "false" }, ...FAILED },
    { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "t1", error: "stopped", is_interrupt: true },
    { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "t1" },
    { hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "", tool_response: { is_error: true, content: "from content" } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { is_error: true, content: "from content" } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { isError: true, content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { is_error: true, content: [] } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { is_error: true, content: { x: 1 }, error: "from error" } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { is_error: true } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", error: "own", is_interrupt: true, tool_response: { is_error: true, content: "ignored" } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { is_error: false, content: "fine" } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "text" },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: null },
    { hook_event_name: "SubagentStop", session_id: "s", agent_id: "a1", agent_type: "x", last_assistant_message: "done" },
    { hook_event_name: "Stop", session_id: "s", turn_id: "t", permission_mode: "plan", model: "m", stop_hook_active: true },
    { hook_event_name: "Stop", session_id: "s", turn_id: 3, permission_mode: 1, model: null, stop_hook_active: "yes" },
    { hook_event_name: "Nope", session_id: "s" },
    { session_id: "s" },
    { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/w/a", description: "d" }, tool_use_id: "u" },
  ],
];
const KINDS: EventKind[] = ["tool-pre", "tool-post", "tool-failure", "stop", "subagent-stop", "prompt", "other"];
registerHost({ ...OLD, key: "claude-old" });
const asNew = (e: any) => ({ ...e, host: "claude" });

describe("the Claude Code manifest compiles to the profile it replaced", () => {
  it("every data member is equal", () => {
    for (const k of ["key", "displayName", "fullName", "chip", "testedVersions", "eventKinds", "capabilities", "sessionEnv", "toolClasses", "fields", "hostOwnedFiles", "hostOwnedWhat", "shape", "perAction", "foreignHookFingerprint", "readsConfigsOf", "trust", "unverifiedEvents", "eventFromArg", "calls", "readPayload", "refineKind", "parseToolInput", "toolName", "displayText"] as const) {
      assert.deepEqual(NEW[k], OLD[k], k);
    }
    assert.deepEqual(Object.keys(NEW.toolClasses), Object.keys(OLD.toolClasses), "tool table order");
    assert.deepEqual(NEW.narration.sources, OLD.narration.sources);
    assert.equal(NEW.sessionFile.bySessionId, OLD.sessionFile.bySessionId);
    assert.equal(NEW.sessionFile.locate("s", 0), OLD.sessionFile.locate("s", 0));
    for (const e of OLD.extras!) assert.ok(NEW.extras!.includes(e), e);
    const { configFile: _c, addHooks: _a, removeHooks: _r, missingEvents: _m, checkPayload: _p, ...oi } = OLD.install!;
    const { configFile: _c2, addHooks: _a2, removeHooks: _r2, missingEvents: _m2, checkPayload: _p2, ...ni } = NEW.install!;
    assert.deepEqual(ni, oi);
    assert.deepEqual(NEW.install!.checkPayload("/f/x y"), OLD.install!.checkPayload("/f/x y"));
    for (const k of ["tool", "envFileVar", "shellEnv", "sessionStartEvent"] as const) assert.equal(NEW.argvTag![k], OLD.argvTag![k], k);
  });

  it("the argv tag output is byte for byte the same", () => {
    for (const input of [{ command: "ls" }, { command: "echo 'é' \"x\"\n", description: "d", timeout: 5 }, {}]) {
      for (const ev of ["PreToolUse", "x\"y"]) assert.equal(NEW.argvTag!.preOutput(ev, input), OLD.argvTag!.preOutput(ev, input));
    }
  });

  it("normalize reads every recorded payload and variant alike", () => {
    for (const p of variants) {
      const o = normalize("claude-old", p);
      const n = normalize("claude", p);
      assert.deepEqual(n, asNew(o), JSON.stringify(p).slice(0, 120));
      assert.equal(JSON.stringify(n), JSON.stringify(asNew(o)));
    }
  });

  it("failure and extra reads agree for every kind", () => {
    for (const p of variants) {
      for (const kind of KINDS) {
        const o = OLD.failureOf(kind, p);
        const n = NEW.failureOf(kind, p);
        // The old shared reader answered any kind; a manifest answers the post and failure kinds, the only ones a hook payload names a failure for.
        if (kind === "tool-post" || kind === "tool-failure") assert.deepEqual(n, o, `${kind} ${JSON.stringify(p).slice(0, 100)}`);
      }
      assert.deepEqual(NEW.extraOf(p), OLD.extraOf(p));
    }
  });

  it("the transcript reads the same words, and the closing message", () => {
    for (const agent of [false, true]) {
      const o = newCursor(sessionFile, agent);
      const n = newCursor(sessionFile, agent);
      for (const line of transcript) {
        OLD.narration.foldLine(o, line);
        NEW.narration.foldLine(n, line);
        assert.deepEqual(n, o);
      }
      assert.equal(NEW.narration.closing(n), OLD.narration.closing(o));
      assert.equal(NEW.narration.closing(undefined), OLD.narration.closing(undefined));
    }
    assert.ok(Object.keys(newFolded().byId).length > 0, "the recording holds narrated calls");
  });

  it("coverage, reveal, helpers and the title read the same", async () => {
    const ids = transcript.flatMap((l) => (l.includes('"tool_use"') ? [...l.matchAll(/"id":"(toolu_[A-Za-z0-9]+)"/g)].map((m) => m[1]!) : []));
    assert.ok(ids.length > 0);
    assert.deepEqual(NEW.coverage!.readCalls(sessionFile, "b0f5204b-5694-452a-b345-e478329f2f19"), OLD.coverage!.readCalls(sessionFile, "b0f5204b-5694-452a-b345-e478329f2f19"));
    for (const id of ids) for (const field of ["command", "description", "nope"]) assert.equal(await NEW.reveal!.fieldText(sessionFile, id, field), await OLD.reveal!.fieldText(sessionFile, id, field));
    assert.ok((await Promise.all(ids.map((id) => NEW.reveal!.fieldText(sessionFile, id, "command")))).some((v) => typeof v === "string"));
    const h = NEW.helpers!;
    const oh = OLD.helpers!;
    assert.equal(h.dirOf("/p/s.jsonl", "s"), oh.dirOf("/p/s.jsonl", "s"));
    assert.equal(h.transcriptFile("ab"), oh.transcriptFile("ab"));
    assert.equal(h.metaFile("ab"), oh.metaFile("ab"));
    assert.equal(h.idOfTranscript("agent-ab.jsonl"), oh.idOfTranscript("agent-ab.jsonl"));
    assert.equal(h.idOfMeta("agent-ab.meta.json"), oh.idOfMeta("agent-ab.meta.json"));
    assert.deepEqual([h.transcriptName, h.metaName, h.folderName], [oh.transcriptName, oh.metaName, oh.folderName]);
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/x/cfg";
    try {
      assert.equal(h.projectsRoot(), oh.projectsRoot());
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
    const root = mkdtempSync(path.join(tmpdir(), "claude-title-"));
    mkdirSync(path.join(root, "projects"), { recursive: true });
    assert.equal(NEW.sessionTitle!("b0f5204b", root), OLD.sessionTitle!("b0f5204b", root));
  });

  it("install add, remove and missing give the same text on representative configs", () => {
    const spec = { dataHome: "/data/home", launcher: "/cc/cocheck-hook", hookPath: "/cc/hook.js", host: "claude" };
    const own = JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-hook --note COCHECK_MANAGED=1" }] }], Notification: [{ hooks: [{ type: "command", command: "notify" }] }] } }, null, 2);
    const configs = ["", "{}", own, "{\"hooks\":{}}", "{\"hooks\": []}", "not json", "[1]"];
    const env = { CLAUDE_CONFIG_DIR: "/x/cfg" };
    assert.equal(NEW.install!.configFile(env, "/h"), OLD.install!.configFile(env, "/h"));
    assert.equal(NEW.install!.configFile({}, "/h"), OLD.install!.configFile({}, "/h"));
    const same = (f: (i: NonNullable<typeof OLD.install>) => unknown) => {
      const run = (i: NonNullable<typeof OLD.install>) => {
        try {
          return { ok: f(i) };
        } catch (e) {
          return { err: (e as Error).message };
        }
      };
      assert.deepEqual(run(NEW.install!), run(OLD.install!));
    };
    for (const cfg of configs) {
      same((i) => i.addHooks(cfg, "s.json", spec, platform));
      same((i) => i.addHooks(cfg, "s.json", undefined, platform));
      same((i) => i.removeHooks(cfg, "s.json", platform));
      same((i) => i.missingEvents(cfg, "s.json", platform));
      same((i) => i.removeHooks(i.addHooks(cfg, "s.json", spec, platform), "s.json", platform));
      same((i) => i.missingEvents(i.addHooks(cfg, "s.json", spec, platform), "s.json", platform));
    }
  });
});

function newFolded() {
  const c = newCursor(sessionFile);
  for (const line of transcript) NEW.narration.foldLine(c, line);
  return c;
}
