import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { placeKit } from "./helpers/install-layout.ts";

// The gap write is a best-effort path, so it is also run from the built output (tsc to a temp outDir, never the repo's dist/),
// with no review process recorded in the home and the production client (no `localProcess` seam): the post hook writes the gap and the page's gap rule reads it.
const root = path.resolve(import.meta.dirname, "..");
const SESSION = "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11";
let box: string;
after(async () => {
  if (box) await rm(box, { recursive: true, force: true });
});

describe("the built hook writes the gap row", () => {
  it("review process not running: the built PostToolUse hook records one gap the built page loader shows", async () => {
    box = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-build-")));
    const out = path.join(box, "dist");
    const tsc = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json"), "--outDir", out], { cwd: root, encoding: "utf8" });
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
    // The rail's assets, as scripts/build.mjs copies them: the built hook's import graph reaches one.
    await cp(path.join(root, "src", "timeline", "rail", "assets"), path.join(out, "timeline", "rail", "assets"), { recursive: true });
    await symlink(path.join(root, "node_modules"), path.join(box, "node_modules"));
    placeKit(box); // public-kit beside dist, as installed
    const home = path.join(box, "home"), folder = path.join(box, "work");
    await mkdir(folder, { recursive: true });
    const dir = path.join(home, "connectors", "notion");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "stand-in.mjs"), "process.stdin.resume();\n");
    await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "notion", version: "0.0.1", entry: "state", matches: { mcpTools: ["mcp__notion__notion-update-page"], subjects: { "mcp__notion__notion-update-page": "notion://page/{page_id:hex}" } }, run: ["node", "stand-in.mjs"] }));
    const { runHook } = await import(path.join(out, "hook-cli.js"));
    const { setTracking } = await import(path.join(out, "tracking.js"));
    const { openLedger } = await import(path.join(out, "ledger.js"));
    setTracking(home, "claude", SESSION, true);
    const send = async (body: Record<string, unknown>) => {
      const res = await runHook({ argv: ["node", "hook.js", "--host", "claude", "--folder", folder], env: { COCHECK_HOME: home }, stdin: (async function* () { yield Buffer.from(JSON.stringify({ session_id: SESSION, cwd: folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", ...body })); })() });
      assert.equal(res.exitCode, 0, res.stderr);
    };
    const input = { page_id: "2f6c0e9b-11a1-4b7e-9a53-1d2f6c0e9b11", properties: { Status: "Done" } };
    await send({ hook_event_name: "UserPromptSubmit", prompt: "update the page" });
    await send({ hook_event_name: "PreToolUse", tool_name: "mcp__notion__notion-update-page", tool_use_id: "toolu_built", tool_input: input });
    await send({ hook_event_name: "PostToolUse", tool_name: "mcp__notion__notion-update-page", tool_use_id: "toolu_built", tool_input: input, tool_response: { ok: true } });
    const ledger = openLedger(home);
    try {
      const rows = ledger.allCaptureOutcomes();
      assert.deepEqual(rows.map((r: { call: string; subject: string; taskId: number | null }) => [r.call, r.subject, r.taskId !== null]), [["toolu_built", "notion://page/2f6c0e9b11a14b7e9a531d2f6c0e9b11", true]]);
      // The page loader's rule, from the built output (the loader itself needs the build's copied assets, which tsc alone does not place).
      const { captureGapsOf } = await import(path.join(out, "connector", "after-gap.js"));
      const { GAP_OUTCOMES } = await import(path.join(out, "connector", "after-snapshot.js"));
      assert.deepEqual([...captureGapsOf(ledger.captureOutcomesForTask(rows[0].taskId), GAP_OUTCOMES).entries()], [["toolu_built", "This change wasn't recorded, because CoCheck's review page wasn't running."]]);
    } finally {
      ledger.close();
    }
  });
});
