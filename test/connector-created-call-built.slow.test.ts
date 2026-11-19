import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { placeKit } from "./helpers/install-layout.ts";

// The create-call post path swallows failure, so it is also run from the built output (tsc to a temp outDir, never the repo's dist/),
// with no review process recorded in the home and the production client (no `localProcess` seam). A create call with no review process is a "not running" gap;
// an answer over 1 MiB is the "didn't name the item" gap, written by the hook. Answer shape: the MCP CallToolResult form, not a recorded host payload (none exists).
const root = path.resolve(import.meta.dirname, "..");
const SESSION = "8d2e1b74-5c8f-4a17-9b26-4e0c3d8f5f32";
let box: string;
after(async () => {
  if (box) await rm(box, { recursive: true, force: true });
});

describe("the built hook records a create call's gaps", () => {
  it("no review process, and an answer over 1 MiB: the built PostToolUse hook records one gap each that the built gap rule shows", async () => {
    box = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-build-")));
    const out = path.join(box, "dist");
    const tsc = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json"), "--outDir", out], { cwd: root, encoding: "utf8" });
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
    await cp(path.join(root, "src", "timeline", "rail", "assets"), path.join(out, "timeline", "rail", "assets"), { recursive: true });
    await symlink(path.join(root, "node_modules"), path.join(box, "node_modules"));
    placeKit(box); // public-kit beside dist, as installed
    const home = path.join(box, "home"), folder = path.join(box, "work");
    await mkdir(folder, { recursive: true });
    const dir = path.join(home, "connectors", "linear");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "stand-in.mjs"), "process.stdin.resume();\n");
    const tool = "mcp__linear__create_issue";
    await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "linear", version: "0.0.1", entry: "state", matches: { schemes: ["linear"], calls: { [tool]: { subjects: [{ from: "response", template: "linear://issue/{issue.id}", created: true }] } } }, run: ["node", "stand-in.mjs"] }));
    const { runHook } = await import(path.join(out, "hook-cli.js"));
    const { setTracking } = await import(path.join(out, "tracking.js"));
    const { openLedger } = await import(path.join(out, "ledger.js"));
    setTracking(home, "claude", SESSION, true);
    const send = async (body: Record<string, unknown>) => {
      const res = await runHook({ argv: ["node", "hook.js", "--host", "claude", "--folder", folder], env: { COCHECK_HOME: home }, stdin: (async function* () { yield Buffer.from(JSON.stringify({ session_id: SESSION, cwd: folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", ...body })); })() });
      assert.equal(res.exitCode, 0, res.stderr);
    };
    const input = { title: "Q4 close", teamId: "ENG" };
    const answer = (pad: string) => ({ content: [{ type: "text", text: JSON.stringify({ issue: { id: "0b5f3c2e-7a41-4d8e-9f10-2c6a4e8b1d33" }, pad }) }] });
    await send({ hook_event_name: "UserPromptSubmit", prompt: "file the issue" });
    for (const [call, pad] of [["toolu_built_a", ""], ["toolu_built_b", "x".repeat(1024 * 1024)]] as const) {
      await send({ hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: call, tool_input: input });
      await send({ hook_event_name: "PostToolUse", tool_name: tool, tool_use_id: call, tool_input: input, tool_response: answer(pad) });
    }
    const ledger = openLedger(home);
    try {
      const rows = ledger.allCaptureOutcomes();
      assert.equal(rows.length, 2);
      const { captureGapsOf } = await import(path.join(out, "connector", "after-gap.js"));
      const { GAP_OUTCOMES } = await import(path.join(out, "connector", "after-snapshot.js"));
      assert.deepEqual([...captureGapsOf(ledger.captureOutcomesForTask(rows[0].taskId), GAP_OUTCOMES).entries()], [
        ["toolu_built_a", "This change wasn't recorded, because CoCheck's review page wasn't running."],
        ["toolu_built_b", "This change wasn't recorded, because the tool's answer didn't name the item."],
      ]);
    } finally {
      ledger.close();
    }
  });
});
