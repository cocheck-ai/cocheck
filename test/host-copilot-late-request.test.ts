import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleEvent } from "../src/hook-adapter.ts";
import { normalize } from "../src/normalize.ts";
import { workbookClaims } from "./helpers/claims.ts";

// two Copilot calls whose Pres both ran before the host flushed their requests. Every id a step names, or an op is joint with,
// must be an id some op has, whichever Post the requests landed before.
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const msg = (ids: string[], args: unknown[], text: string) =>
  JSON.stringify({ type: "assistant.message", data: { phase: "commentary", content: text, toolRequests: ids.map((id, i) => ({ toolCallId: id, name: "bash", arguments: args[i], intentionSummary: `R-${id}` })) } });
const OTHER = msg(["x0"], [{ command: "zz" }], "earlier");

async function run(scen: "same" | "diff" | "never") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-h009r2-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const folder = path.join(root, "folder");
  const sessions = path.join(root, "ss");
  await mkdir(home);
  await mkdir(folder);
  await mkdir(path.join(sessions, SESSION), { recursive: true });
  await copyFile(probe(0), path.join(folder, "g.xlsx"));
  let clock = Date.UTC(2026, 9, 18, 12, 0, 0);
  const opts = { perSession: false, host: "copilot" as const, home, claimed: workbookClaims, folder, now: () => (clock += 1000), sessionsDir: sessions };
  const argsA = { command: "ls" };
  const argsB = scen === "diff" ? { command: "pwd" } : argsA;
  const send = (ev: string, args?: unknown, extra: Record<string, unknown> = {}) => handleEvent(normalize("copilot", { sessionId: SESSION, cwd: folder, toolName: "bash", toolArgs: args, ...extra }, ev), opts);
  const file = (lines: string[]) => writeFile(path.join(sessions, SESSION, "events.jsonl"), lines.join("\n") + "\n");
  const cp = (n: number) => copyFile(probe(n), path.join(folder, "g.xlsx"));
  await send("userPromptSubmitted", undefined, { prompt: "p" });
  await file([OTHER]);
  await send("preToolUse", argsA);
  await send("preToolUse", argsB);
  await file(scen === "never" ? [OTHER] : [OTHER, msg(["r1", "r2"], [argsA, argsB], "both")]);
  await cp(1);
  await send("postToolUse", argsA, { toolResult: {} });
  await cp(2);
  await send("postToolUse", argsB, { toolResult: {} });
  const ledger = openLedger(home);
  const ops: Array<Record<string, any>> = [];
  const steps: Array<Record<string, any>> = [];
  for (const t of ledger.allTaskIds()) {
    for (const o of ledger.okOpsForTask(t, 0, ledger.maxOpId())) ops.push(JSON.parse(o.argsJson));
    steps.push(...(ledger.stepsForTask(t) as unknown as Array<Record<string, any>>));
  }
  ledger.close();
  return { ops: ops.filter((o) => o.tool_name === "bash"), steps };
}

function assertResolves({ ops, steps }: Awaited<ReturnType<typeof run>>): void {
  const ids = new Set(ops.map((o) => o.tool_use_id));
  assert.equal(ids.size, 2, "two ops");
  for (const s of steps) for (const id of [...s.callsOpen, ...s.credited]) assert.ok(ids.has(id), `step ${s.seq} names ${id}, which no op has (ops: ${[...ids].join(", ")})`);
  for (const o of ops) for (const id of o.joint_with ?? []) assert.ok(ids.has(id), `op ${o.tool_use_id} is joint with ${id}, which no op has`);
}

describe("a late request rebinds every open synthetic call before a step is written", () => {
  it("two identical parallel calls, both requests landed before the first Post", async () => {
    const r = await run("same");
    assert.deepEqual(r.ops.map((o) => o.tool_use_id).sort(), ["r1", "r2"]);
    assertResolves(r);
  });
  it("two different parallel calls, same lag", async () => {
    const r = await run("diff");
    assert.deepEqual(r.ops.map((o) => o.tool_use_id).sort(), ["r1", "r2"]);
    assertResolves(r);
  });
  it("requests that never land: synthetic ids stay, consistently everywhere", async () => {
    const r = await run("never");
    assert.ok(r.ops.every((o) => /^copilot-/.test(o.tool_use_id)));
    assertResolves(r);
  });
});
