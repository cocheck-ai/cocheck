import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { workbookClaims } from "./helpers/claims.ts";

// Live op (Codex apply_patch): the patch named `/Users/user/Desktop/CoCheck Testing/codex-run/t08/one.md`, and the op recorded
// outsideRefs ["/Users/user/Desktop/CoCheck"], the path cut at the space. A cut path names a folder the agent never touched.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-cxspace-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);

async function refsOf(dir: string): Promise<string[]> {
  const home = await tmp("home");
  const root = await tmp("root");
  const folder = path.join(root, "work");
  const outside = path.join(root, ...dir.split("/"));
  await mkdir(folder, { recursive: true });
  await mkdir(outside, { recursive: true });
  const a = path.join(folder, "a.xlsx");
  await copyFile(probe(0), a);
  let clock = Date.parse("2026-11-01T14:00:00Z");
  const opts = { host: "codex" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>) => { clock += 1000; return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts); };
  const call = (event: string, id: string, name: string, input: unknown) => send({ hook_event_name: event, tool_name: name, tool_use_id: id, tool_input: input });
  await call("PreToolUse", "warm", "Bash", { command: "true" });
  await call("PostToolUse", "warm", "Bash", { command: "true" });
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  await call("PreToolUse", "F", "Bash", { command: "python3 first.py" });
  await copyFile(probe(1), a);
  await call("PostToolUse", "F", "Bash", { command: "python3 first.py" });
  const input = { command: `*** Begin Patch\n*** Add File: ${path.join(outside, "one.md")}\n+hello world\n*** End Patch` };
  await call("PreToolUse", "P", "apply_patch", input);
  await writeFile(path.join(outside, "one.md"), "hello world\n");
  await call("PostToolUse", "P", "apply_patch", input);
  const l = openLedger(home);
  try {
    const refs: string[] = [];
    for (const op of l.okOpsForTask(1, 0, 1e9)) {
      const args = JSON.parse(op.argsJson) as { tool_use_id?: string; outsideRefs?: string[] };
      if (args.tool_use_id === "P") refs.push(...(args.outsideRefs ?? []));
    }
    return refs;
  } finally { l.close(); }
}

describe("a patch path with a space in it is recorded whole in outsideRefs", () => {
  it("records the full path, never the part before the space", async () => {
    const refs = await refsOf("Desk Top/Out Side");
    assert.ok(refs.some((r) => r.endsWith(path.join("Desk Top", "Out Side", "one.md"))), JSON.stringify(refs));
    assert.ok(!refs.some((r) => r.endsWith("Desk")), `a path cut at the space: ${JSON.stringify(refs)}`);
  });
  it("a path without a space is still recorded (must not: the fix must not hide real outside paths)", async () => {
    const refs = await refsOf("Desktop/Outside");
    assert.ok(refs.some((r) => r.endsWith(path.join("Desktop", "Outside", "one.md"))), JSON.stringify(refs));
  });
});
