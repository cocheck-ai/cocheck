import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

/**
 * recorded. Claude Code writes the message's lines to the transcript about 5 ms after the Pre hook fires, so the Pre lookup
 * saw a file that ended before them. Definition under test: a call whose narration is none after its Pre takes the sentence at its
 * Post (or Stop, whichever first), parallel siblings inherit it. Guards against: the later look never overwrites words found at
 * the Pre, and never gives a call a sentence written after it (a later message's).
 */
const probe = path.join(import.meta.dirname, "fixtures", "probe", "S0.xlsx");
const SENTENCE = "Let me spawn the helper for the ledger.";
const LATER = "A LATER MESSAGE SENTENCE";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const j = (o: unknown) => `${JSON.stringify(o)}\n`;
const asst = (msg: string, ...blocks: unknown[]) => j({ type: "assistant", uuid: `u-${msg}`, isSidechain: false, message: { id: msg, role: "assistant", content: blocks } });
const say = (text: string) => ({ type: "text", text });
const use = (id: string, name = "Agent") => ({ type: "tool_use", id, name, input: { prompt: "p" } });

async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  const home = path.join(root, "home");
  const folder = path.join(root, "folder");
  await mkdir(folder, { recursive: true });
  await mkdir(home, { recursive: true });
  await copyFile(probe, path.join(folder, "casebook.xlsx"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 9, 18, 12, 0, 0);
  const jump = (ms: number) => (clock += ms);
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const file = path.join(root, "t.jsonl");
  const send = (kind: string, id: string, name = "Agent", extra: Record<string, unknown> = {}) => {
    clock += 1000;
    return handleHook({ session_id: "sess-1", cwd: folder, hook_event_name: kind, tool_name: name, tool_use_id: id, tool_input: { prompt: "p" }, transcript_path: file, ...extra } as HookPayload, opts);
  };
  const narrations = () => {
    const ledger = openLedger(home);
    try {
      return Object.fromEntries(ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson))).filter((a: any) => a.tool_use_id).map((a: any) => [a.tool_use_id, a.narration]));
    } finally {
      ledger.close();
    }
  };
  return { jump, root, home, file, pre: (id: string, name?: string) => send("PreToolUse", id, name), post: (id: string, name?: string) => send("PostToolUse", id, name), stop: () => send("Stop", "", undefined, { tool_name: undefined, tool_use_id: undefined, tool_input: undefined }), narrations };
}

describe("late transcript lines", () => {
  it("recorded shape: lines land after the Pre, the Post attaches the sentence", async () => {
    const t = await setup();
    await writeFile(t.file, j({ type: "user", message: { role: "user", content: "go" } }));
    await t.pre("toolu_A");
    await appendFile(t.file, asst("m1", { type: "thinking", thinking: "t" }) + asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")));
    await t.post("toolu_A");
    assert.equal(t.narrations()["toolu_A"].text, SENTENCE);
  });

  it("parallel siblings inherit it", async () => {
    const t = await setup();
    await writeFile(t.file, "");
    await t.pre("toolu_A");
    await t.pre("toolu_B", "Artifact");
    await appendFile(t.file, asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")) + asst("m1", use("toolu_B", "Artifact")));
    await t.post("toolu_A");
    await t.post("toolu_B", "Artifact");
    const n = t.narrations();
    assert.equal(n["toolu_A"].text, SENTENCE);
    assert.equal(n["toolu_B"].sameAs, "toolu_A");
  });

  it("the sibling's Post comes first: it still gets the sentence", async () => {
    const t = await setup();
    await writeFile(t.file, "");
    await t.pre("toolu_A");
    await t.pre("toolu_B", "Artifact");
    await appendFile(t.file, asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")) + asst("m1", use("toolu_B", "Artifact")));
    await t.post("toolu_B", "Artifact");
    await t.post("toolu_A");
    const n = t.narrations();
    assert.equal(n["toolu_A"].text, SENTENCE);
    assert.ok(n["toolu_B"].sameAs === "toolu_A" || n["toolu_B"].text === SENTENCE);
  });

  it("a Stop that closes the call first attaches the sentence", async () => {
    const t = await setup();
    await writeFile(t.file, "");
    await t.pre("toolu_A");
    await t.pre("toolu_B", "Artifact");
    await appendFile(t.file, asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")) + asst("m1", use("toolu_B", "Artifact")));
    await t.stop();
    const n = t.narrations();
    assert.equal(n["toolu_A"].text, SENTENCE);
    assert.equal(n["toolu_B"].sameAs, "toolu_A");
  });

  it("a call the expiry closed, then its Post: the last op of the call holds the sentence", async () => {
    const t = await setup();
    await writeFile(t.file, "");
    await t.pre("toolu_A");
    await appendFile(t.file, asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")));
    t.jump(11 * 60_000);
    await t.post("toolu_A");
    assert.equal(t.narrations()["toolu_A"].text, SENTENCE);
  });

  it("a Stop never gives a later message's sentence to an open call", async () => {
    const t = await setup();
    await writeFile(t.file, "");
    await t.pre("toolu_A");
    await appendFile(t.file, asst("m2", say(LATER), use("toolu_B", "Artifact")));
    await t.stop();
    assert.equal(t.narrations()["toolu_A"].source, "none");
  });

  it("the file grew past the read cap between the Pre and the Post: the call's lines are still found", async () => {
    const t = await setup();
    await writeFile(t.file, "");
    await t.pre("toolu_A");
    await appendFile(t.file, asst("m1", say(SENTENCE)) + asst("m1", use("toolu_A")));
    const filler = j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "y".repeat(2000) }] } });
    await appendFile(t.file, filler.repeat(200));
    await t.post("toolu_A");
    assert.equal(t.narrations()["toolu_A"].text, SENTENCE);
  });

  it("never overwrites words found at the Pre", async () => {
    const t = await setup();
    await writeFile(t.file, asst("m1", say(SENTENCE), use("toolu_A")));
    await t.pre("toolu_A");
    await appendFile(t.file, asst("m2", say(LATER), use("toolu_A")));
    await t.post("toolu_A");
    assert.equal(t.narrations()["toolu_A"].text, SENTENCE);
  });

  it("never gives a call a later message's sentence", async () => {
    const t = await setup();
    await writeFile(t.file, "");
    await t.pre("toolu_A");
    // the call's own tool_use never lands; only a later message with its own call does
    await appendFile(t.file, asst("m2", say(LATER), use("toolu_B", "Artifact")));
    await t.post("toolu_A");
    assert.equal(t.narrations()["toolu_A"].source, "none");
  });

  it("text written after the call's tool_use line is not attached to it", async () => {
    const t = await setup();
    await writeFile(t.file, "");
    await t.pre("toolu_A");
    await appendFile(t.file, asst("m1", use("toolu_A")) + asst("m2", say(LATER)));
    await t.post("toolu_A");
    assert.equal(t.narrations()["toolu_A"].source, "none");
  });
});
