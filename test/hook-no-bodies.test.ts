import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { book, eventArgs, filesContaining, journalRecords, makeRig, spawnHook, wireFor, type Rig } from "./hook-corpus.ts";
import type { HookHost } from "../src/hook-adapter.ts";

// the hook journal keeps index lines only. No raw event body is ever written. Black box through `node src/hook.ts`;
// HOME and COCHECK_HOME are the rig's temp home, nothing reads a real home.
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const rig = async () => {
  const r = await makeRig();
  rigs.push(r);
  return r;
};
const ev = (r: Rig, over: Record<string, unknown>) => ({ session_id: "sess-331", cwd: r.folder, transcript_path: "/x/t.jsonl", ...over });
const send = (host: HookHost, r: Rig, payload: Record<string, unknown>) => {
  const w = wireFor(host, payload);
  return spawnHook(r, ["--host", host, ...eventArgs(w), "--folder", r.folder], JSON.stringify(w.payload));
};
const journal = (r: Rig) => path.join(r.home, "journal");

for (const host of ["claude", "codex", "copilot"] as const) describe(`${host}: no hook event writes a body`, () => {
  it("Pre, Post, Stop: journal/ holds only .jsonl at every step and no payload token appears", async () => {
    const r = await rig();
    const T = ["TOKEN-INPUT-5c1d77", "TOKEN-RESPONSE-a93e10", "TOKEN-EXTRA-0be4f2", "sk-live-331ABCDEF123456"];
    const call = (name: string, extra: Record<string, unknown>) => ev(r, { hook_event_name: name, tool_name: "Bash", tool_use_id: "t1", tool_input: { command: `echo ${T[0]} ${T[3]}`, description: "edit" }, ...extra });
    await writeFile(path.join(r.folder, "model.xlsx"), book({ A1: 1 }));
    const check = async (step: string) => {
      const names = await readdir(journal(r));
      assert.ok(names.length > 0, `${step}: journal exists`);
      assert.ok(names.every((n) => n.endsWith(".jsonl")), `${step}: only .jsonl, got ${names.join(",")}`);
      for (const t of T) assert.deepEqual(filesContaining(journal(r), t), [], `${step}: ${t} in the journal`);
    };
    const p0 = await send(host, r, call("PreToolUse", { unlogged_field: T[2] }));
    assert.equal(p0.status, 0, p0.stderr);
    await check("Pre");
    await writeFile(path.join(r.folder, "model.xlsx"), book({ A1: 9 }));
    assert.equal((await send(host, r, call("PostToolUse", { tool_response: { stdout: T[1] }, unlogged_field: T[2] }))).status, 0);
    await check("Post");
    assert.equal((await send(host, r, ev(r, { hook_event_name: "Stop", last_assistant_message: "Done.", note: T[2] }))).status, 0);
    await check("Stop");
    assert.equal(journalRecords(r.home).filter((x) => x.k === "event").length, 3, "index lines exist");
    for (const rec of journalRecords(r.home)) assert.ok(!("body" in rec), "no body flag in the index");
  });
});
