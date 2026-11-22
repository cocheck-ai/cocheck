import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { trackedClaims } from "./helpers/claims.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "hooks");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-hook-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-hook-folder-")));
  await writeFile(path.join(folder, "seed.txt"), "seed\nstatus: draft\n");
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const opts = { perSession: false, host: "claude" as const, home, claimed: trackedClaims, folder };
  const base = async (name: string) => JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
  const send = async (name: string, over: Record<string, unknown>) => handleHook({ ...(await base(name)), cwd: folder, ...over } as HookPayload, opts);
  const pre = (id: string, tool: string, input: Record<string, unknown>) => send("claude-pre-bash.json", { tool_use_id: id, tool_name: tool, tool_input: input });
  const post = (id: string, tool: string, input: Record<string, unknown>, failed = false) =>
    send("claude-post-bash.json", { tool_use_id: id, tool_name: tool, tool_input: input, tool_response: failed ? undefined : { success: true }, ...(failed ? { hook_event_name: "PostToolUseFailure", error: "File not found" } : {}) });
  const stop = () => send("claude-stop.json", {});
  const ops = (taskId: number) => {
    const ledger = openLedger(home);
    try {
      return ledger.okOpsForTask(taskId, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, unknown>);
    } finally {
      ledger.close();
    }
  };
  const credited = (taskId: number, file: string): string[][] => {
    const ledger = openLedger(home);
    try {
      return ledger.fileStatesForTask(taskId).filter((s) => path.basename(s.filePath) === file && s.credited.length > 0).map((s) => [...s.credited]);
    } finally {
      ledger.close();
    }
  };
  return { folder, pre, post, stop, ops, credited };
}

describe("hook adapter: a call id the host reuses for the next call", () => {
  for (const readFails of [true, false]) {
    it(`a Pre naming a closed call's id (${readFails ? "after a failed" : "after a finished"} Read) starts a new call, credited with its own write`, async () => {
      const t = await setup();
      const id = "call-1\nfc_1_0";
      const readIn = { file_path: path.join(t.folder, "hello.txt") };
      const writeIn = { file_path: path.join(t.folder, "hello.txt"), content: "hello\n" };
      await t.pre(id, "Read", readIn);
      await t.post(id, "Read", readIn, readFails);
      await t.pre(id, "Write", writeIn);
      await writeFile(path.join(t.folder, "hello.txt"), "hello\n");
      await t.post(id, "Write", writeIn);
      const s = (await t.stop()).summary;
      assert.ok(s, "Stop returned a round summary");
      const callOps = t.ops(s.taskId).filter((o) => typeof o.tool_use_id === "string" && o.closedBy !== undefined);
      const ids = [...new Set(callOps.map((o) => o.tool_use_id as string))];
      assert.equal(ids.length, 2, `the Read and the Write are two calls, got ${JSON.stringify(callOps.map((o) => [o.tool_use_id, o.hookEvent, o.closedBy]))}`);
      assert.ok(ids.includes(id), "the first call keeps the id the host sent");
      const writeId = ids.find((x) => x !== id)!;
      assert.deepEqual(t.credited(s.taskId, "hello.txt"), [[writeId]], "the created file is the Write call's");
    });
  }

  it("a Pre and Post of one call sharing an id stay one call (no reuse, no split)", async () => {
    const t = await setup();
    const input = { file_path: path.join(t.folder, "seed.txt"), content: "seed\nstatus: done\n" };
    await t.pre("toolu_W", "Write", input);
    await writeFile(path.join(t.folder, "seed.txt"), "seed\nstatus: done\n");
    await t.post("toolu_W", "Write", input);
    await t.post("toolu_W", "Write", input); // a repeated Post logs nothing more
    const s = (await t.stop()).summary!;
    const ids = new Set(t.ops(s.taskId).filter((o) => o.closedBy !== undefined).map((o) => o.tool_use_id));
    assert.deepEqual([...ids], ["toolu_W"]);
    assert.deepEqual(t.credited(s.taskId, "seed.txt"), [["toolu_W"]]);
  });
});
