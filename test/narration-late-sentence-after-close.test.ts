import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { readRecord, type RawOp } from "../src/timeline/runs.ts";
import { workbookClaims } from "./helpers/claims.ts";

/**
 * recorded. Two parallel Agent calls; at their Pre and Post the transcript ended at 166944 bytes (the message's lines
 * not flushed yet). The sentence sat at offset 171064. The next Pre (a Bash) found the file at 474796 bytes, hit the read cap and
 * stepped past it, after the ops had closed with "no narration recorded". Definition under test: a sentence that reaches the file after
 * its call closed is added later as an append-only record keyed to the call (the ledger is never rewritten), and the page's call
 * carries it. Guards against: the late record never goes to another call (a sibling's own, or the next message's), and the
 * hook stays inside its time budget on a large transcript.
 */
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
    return handleHook({ session_id: "sess-1", cwd: folder, hook_event_name: kind, tool_name: name, tool_use_id: id, tool_input: { prompt: "p" }, transcript_path: file, ...extra } as HookPayload, opts);
  };
  const rawOps = (): RawOp[] => {
    const ledger = openLedger(home);
    try {
      return ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId())).map((o) => ({ id: o.id, tool: o.tool, intent: o.intent, args_json: o.argsJson }));
    } finally {
      ledger.close();
    }
  };
  const narrations = () => Object.fromEntries([...readRecord(rawOps(), []).calls.values()].map((c) => [c.id, c.narration]));
  return { file, rawOps, narrations, pre: (id: string, name?: string) => send("PreToolUse", id, name), post: (id: string, name?: string) => send("PostToolUse", id, name), stop: () => send("Stop", "", undefined, { tool_name: undefined, tool_use_id: undefined, tool_input: undefined }) };
}

/** Pre and Post of two parallel agents with the transcript not yet holding their message. */
async function twoAgentsClosedEarly(t: Awaited<ReturnType<typeof setup>>) {
  await writeFile(t.file, j({ type: "user", message: { role: "user", content: "go" } }) + filler(160_000));
  await t.pre("toolu_A");
  await t.pre("toolu_B");
  await t.post("toolu_A");
  await t.post("toolu_B");
}

describe("a sentence flushed after its call closed", () => {
  it("recorded shape: a later read adds the sentence to both closed calls, as new ops only", async () => {
    const t = await setup();
    await twoAgentsClosedEarly(t);
    const before = t.rawOps();
    assert.equal(t.narrations()["toolu_A"]?.source, "none");
    await appendFile(t.file, asst("m1", { type: "thinking", thinking: "t" }) + asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")) + asst("m1", use("toolu_B")));
    await appendFile(t.file, filler(300_000));
    await t.pre("toolu_C", "Bash");
    const n = t.narrations();
    assert.equal(n["toolu_A"]?.text, SENTENCE);
    assert.equal(n["toolu_B"]?.sameAs, "toolu_A");
    // append-only: every earlier op is byte-identical, the record only grew
    const after = t.rawOps();
    assert.deepEqual(after.slice(0, before.length), before);
    assert.ok(after.length > before.length);
  });

  it("the late sentence is written once", async () => {
    const t = await setup();
    await twoAgentsClosedEarly(t);
    await appendFile(t.file, asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")) + asst("m1", use("toolu_B")));
    await t.pre("toolu_C", "Bash");
    const once = t.rawOps().length;
    await t.post("toolu_C", "Bash");
    await t.stop();
    assert.equal(t.rawOps().filter((o) => (o.args_json ?? "").includes("lateNarrationFor")).length, 2);
    assert.ok(t.rawOps().length >= once);
  });

  it("the next message's sentence never goes to the closed calls", async () => {
    const t = await setup();
    await twoAgentsClosedEarly(t);
    await appendFile(t.file, asst("m2", say(NEXT), use("toolu_C", "Bash")));
    await t.pre("toolu_C", "Bash");
    await t.post("toolu_C", "Bash");
    await t.stop();
    const n = t.narrations();
    assert.equal(n["toolu_A"]?.source, "none");
    assert.equal(n["toolu_B"]?.source, "none");
    assert.equal(n["toolu_C"]?.text, NEXT);
  });

  it("a late sentence for A does not touch an unrelated closed call D", async () => {
    const t = await setup();
    await twoAgentsClosedEarly(t);
    await t.pre("toolu_D", "Bash");
    await t.post("toolu_D", "Bash");
    await appendFile(t.file, asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")) + asst("m1", use("toolu_B")));
    await t.pre("toolu_E", "Bash");
    const n = t.narrations();
    assert.equal(n["toolu_A"]?.text, SENTENCE);
    assert.equal(n["toolu_D"]?.source, "none");
  });

  it("a large transcript stays inside the budget and finds the sentence", async () => {
    const t = await setup();
    await twoAgentsClosedEarly(t);
    await appendFile(t.file, asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")) + asst("m1", use("toolu_B")));
    await appendFile(t.file, filler(8_000_000));
    const started = performance.now();
    await t.pre("toolu_C", "Bash");
    assert.ok(performance.now() - started < 2000, "the hook took too long");
    assert.ok((await stat(t.file)).size > 8_000_000);
    // found now or by a later event once the forward read has caught up; never skipped
    await t.post("toolu_C", "Bash");
    await t.stop();
    assert.equal(t.narrations()["toolu_A"]?.text, SENTENCE);
  });
});
