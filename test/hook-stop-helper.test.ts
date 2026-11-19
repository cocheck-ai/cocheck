import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { loadRows } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// the main agent's Stop arrives while a background helper's call is still open. Background helpers share the main
// session id and carry their own agent_id. The Stop must close only its own agent's calls, so the helper's Post still finds its call
// and its writes are credited to it; a person's change with no call open stays "not from an agent call"; a helper call that never
// reaches Post is closed by expiry (10 minutes), never held forever.
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const EXPIRY_PLUS = 11 * 60_000;
const OUTSIDE = /not from an agent call/;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  const book = path.join(folder, "book.xlsx");
  await copyFile(probe(0), book);
  let clock = 1_000_000;
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, perSession: false, now: () => clock };
  const send = async (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const tool_input = { command: "python3 edit.py", description: "edit" };
  const pre = (id: string, agent?: string, session = "s1") => send({ session_id: session, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input, ...(agent ? { agent_id: agent, agent_type: "general-purpose" } : {}) });
  const post = (id: string, agent?: string) => send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input, ...(agent ? { agent_id: agent } : {}) });
  const stop = () => send({ hook_event_name: "Stop" });
  const model = () => read((l) => buildRailModel(buildTimeline({ ...loadRows(l, 1, "test"), build: "t", folder, stored: new Map(), formats: new Map(), quickLook: false })));
  const advance = (ms: number) => void (clock += ms);
  const read = <T,>(f: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return f(l);
    } finally {
      l.close();
    }
  };
  const states = () => read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === book);
  const ops = () => read((l) => l.okOpsForTask(1, 0, l.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>));
  const open = async (): Promise<string[]> => {
    const dir = path.join(home, "hooks", (await readdir(path.join(home, "hooks")))[0]!);
    return Object.keys(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).open).sort();
  };
  const write = (n: number) => copyFile(probe(n), book);
  // A first call so the file has a stored state; later changes are then changes.
  await pre("warm");
  await post("warm");
  return { model, pre, post, stop, advance, states, ops, open, write, book };
}

describe("a Stop does not close a helper's open call", () => {
  it("helper Pre, main Stop, file write, helper Post: the write is the helper's", async () => {
    const t = await setup();
    await t.pre("toolu_H", "helper2");
    await t.stop();
    assert.deepEqual(await t.open(), ["toolu_H"], "the Stop left the helper's call open");
    await t.write(1);
    await t.post("toolu_H", "helper2");
    const last = t.states().at(-1)!;
    assert.equal(last.phase, "Post");
    assert.deepEqual(last.credited, ["toolu_H"]);
    assert.doesNotMatch(last.note, OUTSIDE);
    const mine = t.ops().filter((o) => o.tool_use_id === "toolu_H" && o.path === t.book);
    assert.ok(mine.length > 0, "the helper's call has an op for the file");
    assert.ok(mine.every((o) => o.agent_id === "helper2"), "the op names the helper");
  });

  it("a file that moved before the Stop, with the helper's call open, is not labelled outside", async () => {
    const t = await setup();
    await t.pre("toolu_H", "helper2");
    await t.write(1);
    await t.stop();
    const stopState = t.states().at(-1)!;
    assert.equal(stopState.phase, "Stop");
    assert.deepEqual(stopState.credited, ["toolu_H"]);
    assert.doesNotMatch(stopState.note, OUTSIDE);
  });

  it("the Stop still closes its own agent's calls, and only those", async () => {
    const t = await setup();
    await t.pre("toolu_main");
    await t.pre("toolu_H", "helper2");
    await t.stop();
    assert.deepEqual(await t.open(), ["toolu_H"]);
  });

  it("a change with no call open is still outside, at a Stop", async () => {
    const t = await setup();
    await t.write(1);
    await t.stop();
    const last = t.states().at(-1)!;
    assert.deepEqual(last.credited, []);
    assert.match(last.note, OUTSIDE);
  });

  it("a helper call that never gets its Post is closed by expiry, and later changes are outside again", async () => {
    const t = await setup();
    await t.pre("toolu_H", "helper2");
    await t.stop();
    await t.stop();
    assert.deepEqual(await t.open(), ["toolu_H"], "later Stops of the main agent do not close it");
    t.advance(EXPIRY_PLUS);
    await t.write(1);
    await t.stop();
    assert.deepEqual(await t.open(), [], "expiry closed the call");
    const last = t.states().at(-1)!;
    assert.deepEqual(last.credited, []);
    assert.match(last.note, OUTSIDE);
  });

  it("another session's open call never claims what a Stop finds, and the Stop never closes it", async () => {
    const t = await setup();
    await t.pre("toolu_O", undefined, "s2");
    await t.write(1);
    await t.stop();
    const last = t.states().at(-1)!;
    assert.deepEqual(last.credited, []);
    // callsOpen still lists the other session's call, so the wording is the "calls were still open" one, as before.
    assert.match(last.note, /not from an agent call|none can be shown to have made it/);
    assert.deepEqual(await t.open(), ["toolu_O"], "the other session's call is still open");
  });

  it("rail: the recorded order lands on the helper's lane, not unsure", async () => {
    const t = await setup();
    await t.pre("toolu_H", "helper2");
    await t.stop();
    await t.write(1);
    await t.post("toolu_H", "helper2");
    const m = t.model();
    const change = m.stops.filter((s) => s.change?.file === path.basename(t.book));
    assert.ok(change.length > 0, "the rail shows the file's change");
    for (const s of change) {
      assert.equal(s.lane, "agent:1", `lane ${String(s.lane)}`);
      assert.match(s.change!.note, /^Helper 1 changed/);
      assert.doesNotMatch(JSON.stringify(s.change), /Something, during agent calls|not from an agent call/);
    }
  });
});
