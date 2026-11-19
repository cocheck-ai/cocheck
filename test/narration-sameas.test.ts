import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { readRecord, type RawOp } from "../src/timeline/runs.ts";
import { lineOf } from "../src/timeline/describe.ts";
import { wordsOfRun } from "../src/timeline/runs.ts";
import { workbookClaims } from "./helpers/claims.ts";

const probe = path.join(import.meta.dirname, "fixtures", "probe", "S0.xlsx");
const SENTENCE = "First step: sending two agents out in parallel to each take one file.";
const NEXT = "NEXT MESSAGE SENTENCE for the bash call";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const j = (o: unknown) => `${JSON.stringify(o)}\n`;
const asst = (msg: string, ...blocks: unknown[]) => j({ type: "assistant", uuid: `u-${msg}`, isSidechain: false, message: { id: msg, role: "assistant", content: blocks } });
const say = (text: string) => ({ type: "text", text });
const use = (id: string, name = "Agent") => ({ type: "tool_use", id, name, input: { prompt: "p" } });
const filler = (bytes: number) => j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "y".repeat(2000) }] } }).repeat(Math.ceil(bytes / 2100));

async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-t070r3-")));
  const home = path.join(root, "home");
  const folder = path.join(root, "folder");
  await mkdir(folder, { recursive: true });
  await mkdir(home, { recursive: true });
  await copyFile(probe, path.join(folder, "casebook.xlsx"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 9, 18, 12, 0, 0);
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const file = path.join(root, "t.jsonl");
  const send = (kind: string, id: string, name = "Agent", extra: Record<string, unknown> = {}) => {
    clock += 1000;
    return handleHook({ session_id: "sess-1", cwd: folder, hook_event_name: kind, tool_name: name, tool_use_id: id, tool_input: { prompt: "p", description: `desc ${id}` }, transcript_path: file, ...extra } as HookPayload, opts);
  };
  const rawOps = (): RawOp[] => {
    const ledger = openLedger(home);
    try {
      return ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId())).map((o) => ({ id: o.id, tool: o.tool, intent: o.intent, args_json: o.argsJson }));
    } finally {
      ledger.close();
    }
  };
  const lines = () => Object.fromEntries([...readRecord(rawOps(), []).calls.values()].map((c) => [c.id, lineOf(c).text]));
  const narrations = () => Object.fromEntries([...readRecord(rawOps(), []).calls.values()].map((c) => [c.id, c.narration]));
  return { home, file, rawOps, narrations, lines, pre: (id: string, name?: string) => send("PreToolUse", id, name), post: (id: string, name?: string) => send("PostToolUse", id, name), stop: () => send("Stop", "", undefined, { tool_name: undefined, tool_use_id: undefined, tool_input: undefined }) };
}

/** Pre and Post of two parallel agents with the transcript not yet holding their message. */
async function twoAgentsClosedEarly(t: Awaited<ReturnType<typeof setup>>) {
  await writeFile(t.file, j({ type: "user", message: { role: "user", content: "go" } }) + filler(160_000));
  await t.pre("toolu_A");
  await t.pre("toolu_B");
  await t.post("toolu_A");
  await t.post("toolu_B");
}


const DESC_A = "desc toolu_A";
const DESC_B = "desc toolu_B";

/** A hand-made op for the render tests: a closed call with the narration the reader stored. */
const op = (id: number, call: string, session: string, narration: unknown, agent?: string): RawOp => ({
  id,
  tool: "hook",
  intent: "x",
  args_json: JSON.stringify({ hookOpKey: `${call}#${id}`, hookAdapter: 1, tool_use_id: call, closedBy: "post", host: "claude", session_id: session, tool_name: "Agent", description: `desc ${call}`, ...(agent === undefined ? {} : { agent_id: agent }), narration }),
});
const said = (text: string) => ({ source: "agent", label: "the agent's own words", text });
const same = (first: string) => ({ source: "agent", label: "the agent's own words", sameAs: first });

describe("a sibling renders its parallel call's sentence", () => {
  it("recorded shape, late: both parallel calls render the sentence as their line", async () => {
    const t = await setup();
    await twoAgentsClosedEarly(t);
    assert.equal(t.lines()["toolu_A"], DESC_A);
    await appendFile(t.file, asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")) + asst("m1", use("toolu_B")));
    await appendFile(t.file, filler(300_000));
    await t.pre("toolu_C", "Bash");
    assert.equal(t.lines()["toolu_A"], SENTENCE);
    assert.equal(t.lines()["toolu_B"], SENTENCE);
  });

  it("not late: the message is in the file at the Pre of both calls; both lines are the sentence", async () => {
    const t = await setup();
    await writeFile(t.file, j({ type: "user", message: { role: "user", content: "go" } }) + asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")) + asst("m1", use("toolu_B")));
    await t.pre("toolu_A");
    await t.pre("toolu_B");
    await t.post("toolu_A");
    await t.post("toolu_B");
    assert.equal(t.narrations()["toolu_B"]?.sameAs, "toolu_A");
    assert.equal(t.lines()["toolu_A"], SENTENCE);
    assert.equal(t.lines()["toolu_B"], SENTENCE);
  });

  it("the sibling's words appear in the run's words once", () => {
    const { calls } = readRecord([op(1, "A", "s", said(SENTENCE)), op(2, "B", "s", same("A"))], []);
    assert.equal(calls.get("B")?.narration?.text, SENTENCE);
  });

  it("a pointer to a call of another session, another lane, a missing call or itself renders no sentence", () => {
    const ops = [
      op(1, "A", "s1", said(SENTENCE)),
      op(2, "X", "s2", same("A")), // another session
      op(3, "Y", "s1", same("A"), "agent-1"), // another lane (A is on the main line)
      op(4, "Z", "s1", same("nope")), // not in the record
      op(5, "W", "s1", same("W")), // itself
      op(6, "V", "s1", same("X")), // a call that holds no words of its own
      op(7, "U", "s1", { source: "none", text: "no narration recorded" }),
      op(8, "T", "s1", same("U")), // a sibling that has no words
    ];
    const { calls } = readRecord(ops, []);
    for (const id of ["X", "Y", "Z", "W", "V", "T"]) {
      assert.equal(lineOf(calls.get(id)!).text, `desc ${id}`, id);
      assert.equal(calls.get(id)!.narration?.text, undefined, id);
    }
    assert.equal(lineOf(calls.get("A")!).text, SENTENCE);
  });

  it("the next message's sentence is never a sibling's line", async () => {
    const t = await setup();
    await twoAgentsClosedEarly(t);
    await appendFile(t.file, asst("m2", say(NEXT), use("toolu_C", "Bash")));
    await t.pre("toolu_C", "Bash");
    await t.post("toolu_C", "Bash");
    await t.stop();
    assert.equal(t.lines()["toolu_A"], DESC_A);
    assert.equal(t.lines()["toolu_B"], DESC_B);
  });
});
