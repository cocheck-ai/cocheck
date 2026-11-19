import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a call that rewrites a watched file with the bytes it already had leaves a note on its op (`sameBytesRewrites`), and no state.
// Shape from recorded (Codex task 18): one Bash call ran a build and a render that wrote memo_render/page-1.png again, byte-identical.
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
  const opts = { perSession: false, host: "codex" as const, home, claimed: workbookClaims, folder };
  const send = (event: string, over: Record<string, unknown>) => handleHook({ session_id: "s1", cwd: folder, hook_event_name: event, tool_name: "Bash", ...over } as HookPayload, opts);
  const run = async (id: string, command: string, between: () => Promise<void>) => {
    await send("PreToolUse", { tool_use_id: id, tool_input: { command } });
    await between();
    await send("PostToolUse", { tool_use_id: id, tool_input: { command } });
  };
  const finish = async () => {
    const r = await send("Stop", { tool_name: undefined });
    const ledger = openLedger(home);
    try {
      const ops = ledger.okOpsForTask(r.summary!.taskId, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>);
      const raw = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
      const states = raw.prepare("select file_path, sha256 from file_states where task_id = ?").all(r.summary!.taskId) as Array<{ file_path: string; sha256: string }>;
      raw.close();
      return { ops, states };
    } finally {
      ledger.close();
    }
  };
  return { folder, run, finish };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("same-bytes rewrite is noted at record time", () => {
  it("a call that rewrites a watched file with identical bytes notes it on its op and records no new state", async () => {
    const t = await setup();
    const png = path.join(t.folder, "memo_render", "page-1.png");
    await import("node:fs/promises").then((f) => f.mkdir(path.dirname(png), { recursive: true }));
    await writeFile(png, "page one bytes");
    await t.run("c0", "echo start", async () => {});
    await sleep(20);
    await t.run("c1", "python3 build_memo.py && python3 render_docx.py", async () => {
      await writeFile(png, "page one bytes");
    });
    const { ops, states } = await t.finish();
    const c1 = ops.find((o) => o.tool_use_id === "c1")!;
    assert.deepEqual(c1.sameBytesRewrites, ["memo_render/page-1.png"]);
    assert.equal(states.filter((s) => s.file_path.endsWith("page-1.png")).length <= 1, true, "no state beyond the first sight of the file");
    assert.equal(ops.find((o) => o.tool_use_id === "c0")!.sameBytesRewrites, undefined);
  });

  it("a call that changes the bytes notes no rewrite", async () => {
    const t = await setup();
    const png = path.join(t.folder, "page-1.png");
    await writeFile(png, "one");
    await t.run("c0", "echo start", async () => {});
    await t.run("c1", "render", async () => {
      await writeFile(png, "two");
    });
    const { ops } = await t.finish();
    assert.equal(ops.find((o) => o.tool_use_id === "c1")!.sameBytesRewrites, undefined);
  });
});
