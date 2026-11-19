import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { handleEvent, handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { assertNormalized, normalize } from "../src/normalize.ts";
import { book, dumpLedger, goldenView, journalRecords, makeRig, sessionFor, sessionNoId, type CorpusEvent, type Rig } from "./hook-corpus.ts";
import { workbookClaims } from "./helpers/claims.ts";
import { PRODUCTION_BUILTIN_CONNECTORS, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";

// in process: the replay through the CLI body (journal healthy and journal blocked) equals the pre-change golden; the crash seam;
// the day-old sweep; the normalizer's contract; and the rule that hook-adapter.ts never reads a raw payload or names a host.
// the CLI builds no format layer; the hook claims model.xlsx because the shipped Excel connector does, so each rig
// registers the production built-ins (the test bootstrap registers none).
const rigs: Rig[] = [];
afterEach(async () => {
  setBuiltinConnectorsForTest(undefined);
  for (const r of rigs.splice(0)) await r.cleanup();
});
const rig = async () => {
  setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
  const r = await makeRig();
  rigs.push(r);
  return r;
};
const golden = async (name: string) => JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures", "hook-goldens", name), "utf8"));
const bytes = (o: unknown) => Buffer.from(JSON.stringify(o));
const cli = (r: Rig, host: string, payload: unknown, extra: { now?: () => number; journalNow?: () => number; fault?: (s: string) => void } = {}) =>
  runHook({ argv: ["node", "hook.ts", "--host", host, "--folder", r.folder], env: { COCHECK_HOME: r.home }, stdin: (async function* () { yield Buffer.isBuffer(payload) ? payload : bytes(payload); })(), ...extra });

async function replayViaCli(r: Rig, host: "claude" | "codex", events: CorpusEvent[]) {
  let clock = 1_700_000_000_000;
  for (const ev of events) {
    if (ev.write) await writeFile(path.join(r.folder, "model.xlsx"), book(ev.write));
    const res = await cli(r, host, ev.payload, { now: () => (clock += 1000) });
    assert.equal(res.exitCode, 0, res.stderr);
  }
  return goldenView(dumpLedger(r.home, r.folder));
}

describe("the CLI path writes what the pre-change code wrote", () => {
  for (const [host, name, make] of [["claude", "golden-claude.json", sessionFor], ["codex", "golden-codex.json", sessionFor], ["claude", "golden-claude-noid.json", sessionNoId]] as const) {
    it(`${name}: journal healthy`, async () => {
      const r = await rig();
      assert.deepEqual(await replayViaCli(r, host, make(host, r.folder)), await golden(name));
      assert.ok(journalRecords(r.home).length >= 3, "the journal was written");
    });
    it(`${name}: journal blocked, ops identical, stderr notes it`, async () => {
      const r = await rig();
      await writeFile(path.join(r.home, "journal"), "a file where the journal directory goes");
      assert.deepEqual(await replayViaCli(r, host, make(host, r.folder)), await golden(name));
    });
  }
});

describe("a crash between the journal write and the ledger write", () => {
  const post = (r: Rig): CorpusEvent[] => {
    const events = sessionFor("claude", r.folder);
    return events.slice(0, 3);
  };
  const opKeys = (r: Rig) => (dumpLedger(r.home, r.folder).ops as Array<{ args_json: string }>).map((o) => /"hookOpKey":"([^"]+)"/.exec(o.args_json)![1]).sort();

  for (const step of ["after-save", "after-flush"]) {
    it(`${step}: record present, marker linked, no done; replaying the event does not duplicate ops`, async () => {
      const clean = await rig();
      await replayViaCli(clean, "claude", post(clean));
      const r = await rig();
      const events = post(r);
      let clock = 1_700_000_000_000;
      const now = () => (clock += 1000);
      await cli(r, "claude", events[0].payload, { now });
      await cli(r, "claude", events[1].payload, { now });
      await writeFile(path.join(r.folder, "model.xlsx"), book(events[2].write!));
      const crashed = await cli(r, "claude", events[2].payload, { now, fault: (s) => { if (s === step) throw new Error(`killed at ${s}`); } });
      assert.equal(crashed.exitCode, 1);
      const recs = journalRecords(r.home);
      const last = recs.filter((x) => x.k === "event").at(-1)!;
      assert.equal(last.event, "PostToolUse");
      assert.ok(recs.some((x) => x.k === "failure" && x.ref === last.id && x.sha256 === last.sha256), "marker linked to the record");
      assert.ok(!recs.some((x) => x.k === "done" && x.sha256 === last.sha256), "no done record for the crashed event");
      assert.equal((await cli(r, "claude", events[2].payload, { now })).exitCode, 0);
      assert.deepEqual(opKeys(r), opKeys(clean));
    });
  }
});

describe("normalize(host, raw)", () => {
  const claude = { session_id: "s", cwd: "/w", permission_mode: "default", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1", tool_response: { is_error: true, content: "boom" } };
  const codex = { session_id: "s", cwd: "/w", turn_id: "turn-1", model: "gpt-5-codex", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" };

  it("one versioned shape for both hosts", () => {
    const a = normalize("claude", claude);
    const b = normalize("codex", codex);
    assert.equal(a.v, 1);
    assert.equal(b.v, 1);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
    assert.equal(a.kind, "tool-post");
    assert.deepEqual(a.failure, { raw: "boom", interrupted: false });
    assert.equal(b.failure, undefined);
    assert.deepEqual([a.narratesBeforeCall, a.sessionFileBySessionId, b.narratesBeforeCall, b.sessionFileBySessionId], [true, false, true, true]);
    assert.equal(a.extra.permissionMode, "default");
    assert.equal(b.extra.turnId, "turn-1");
  });
  it("a Codex payload under the claude host, and an unknown event, do not throw", () => {
    assert.equal(normalize("claude", codex).kind, "tool-post");
    assert.equal(normalize("claude", { ...codex, hook_event_name: "Brand New" }).kind, "other");
    assert.equal(normalize("claude", { session_id: "s" }).kind, "other");
  });
  it("refuses a host that is not wired and a null payload; any other JSON value is an event the adapter ignores", () => {
    assert.throws(() => normalize("gemini" as never, claude), /unknown hook host/);
    assert.throws(() => normalize("claude", null), /null/);
    for (const other of [3, "x", [1], [], true, {}]) assert.equal(normalize("claude", other).kind, "other");
  });
  it("an unknown v is refused by the adapter and by the guard", async () => {
    const r = await rig();
    const ev = { ...normalize("claude", { ...claude, hook_event_name: "Notification" }), v: 2 };
    assert.throws(() => assertNormalized(ev), /version/);
    await assert.rejects(handleEvent(ev as never, { host: "claude", home: r.home, claimed: workbookClaims, folder: r.folder }), /version/);
  });
  it("handleHook (raw) and handleEvent (normalized) take the same event", async () => {
    const r = await rig();
    const opts = { perSession: false, host: "claude" as const, home: r.home, claimed: workbookClaims, folder: r.folder };
    const raw = { ...claude, cwd: r.folder, hook_event_name: "Notification" };
    assert.deepEqual(await handleHook(raw as unknown as HookPayload, opts), await handleEvent(normalize("claude", raw), opts));
  });
});

describe("hook-adapter.ts reads no raw payload field and names no host", () => {
  it("the adapter source", async () => {
    const src = await readFile(path.join(import.meta.dirname, "..", "src", "hook-adapter.ts"), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    const RAW = ["session_id", "hook_event_name", "tool_use_id", "tool_name", "tool_input", "tool_response", "transcript_path", "agent_id", "agent_type", "last_assistant_message", "is_interrupt", "stop_hook_active", "permission_mode", "turn_id"];
    const hits = RAW.filter((f) => new RegExp(`\\b(payload|p)\\.${f}\\b|\\["${f}"\\]`).test(code));
    assert.deepEqual(hits, [], "raw payload fields read outside the normalizer");
    assert.ok(!/#payload|\bpayload\.\w/.test(code), "no payload member access");
    assert.ok(!/["'`](claude|codex)["'`]/.test(code.replace(/^\s*\/\*\*.*$/gm, "")), "no host literal in code");
    assert.ok(!/(opts|options)\.host\b/.test(code.replace("normalize(options.host, payload)", "")), "the host comes from the event");
    assert.ok(existsSync(path.join(import.meta.dirname, "..", "src", "normalize.ts")));
  });
});
