import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RECORDINGS, readGolden, replayRecording, rewritePaths, wireOfLine } from "./hook-real-recordings.ts";

// The hook stdin recorded from real host runs (Claude Code 2.1.302, Codex 0.162 and 0.164, Copilot CLI 1.0.103 and 1.0.98, Copilot in
// VS Code 1.140) replays through the real hook entry into a ledger equal to the golden dump captured from the code of the day
// (test/fixtures/hook-goldens/golden-real-<name>.json), and a second replay is identical. How each recording is made replayable is
// written at the top of test/hook-real-recordings.ts.
// This test never writes a golden. To capture them on purpose: `node --import ./scripts/test-bootstrap.ts test/write-real-goldens.ts`.
describe("real recordings replay into their golden ledger", () => {
  for (const rec of RECORDINGS) {
    // The goldens store POSIX-form paths: they are the macOS parity guard, so the replay is not run on Windows.
    it(`${rec.name}: the replay equals the golden, and a second replay is identical`, { timeout: 300_000, skip: process.platform === "win32" ? "goldens hold POSIX-form paths (macOS parity guard)" : false }, async () => {
      const first = await replayRecording(rec);
      const want = readGolden(rec) as Record<string, unknown[]>;
      if (rec.recordsNothing) assert.ok(want.tasks!.length === 0 && want.ops!.length === 0, "the golden is the empty ledger");
      else assert.ok(want.ops!.length > 0 && want.steps!.length > 0, "the golden is not empty");
      assert.deepEqual(first.dump, want);
      if (rec.fileTools) {
        const tools = new Set((want.ops as Array<{ tool: string }>).map((o) => o.tool));
        for (const t of rec.fileTools.tools) assert.ok(tools.has(t), `the golden holds an op for the ${t} tool`);
        const states = want.file_states as Array<{ file_path: string; phase: string; credited_json: string }>;
        for (const f of rec.fileTools.files) {
          const post = states.filter((st) => st.phase === "Post" && st.file_path.replace(/\\/g, "/") === `<folder>/${f}`);
          assert.ok(post.length > 0, `${f} has a Post state`);
          assert.ok(post.some((st) => (JSON.parse(st.credited_json) as string[]).length > 0), `${f} is credited to the agent's call`);
        }
      }
      assert.deepEqual((await replayRecording(rec)).dump, first.dump);
    });
  }
});

describe("recorded paths are substituted as JSON text", () => {
  it("a backslash path round-trips through the parsed payload", () => {
    const folder = "C:\\Users\\x\\tmp\\ws";
    const root = "C:\\Users\\x\\tmp";
    const line = JSON.stringify({ a: "<scratch>/ws/data.csv", b: "<scratch>/ws2", c: "<scratch>/home", d: "/private/var/folders/xx/AbC123/T/cocheck-probe-Zq9/work/n.txt", e: "say \"hi\"" });
    const got = JSON.parse(rewritePaths(line, folder, root));
    assert.equal(got.a, `${folder}/data.csv`);
    assert.equal(got.b, folder);
    assert.equal(got.c, `${root}/home`);
    assert.equal(got.d, `${folder}/n.txt`);
    assert.equal(got.e, 'say "hi"');
  });

  it("a wrapped line's inner stdin text takes a backslash path too", () => {
    const folder = "C:\\Users\\x\\tmp\\ws";
    const root = "C:\\Users\\x\\tmp";
    const line = JSON.stringify({ event: "PreToolUse", ts: 1, stdin: JSON.stringify({ cwd: "<scratch>/ws", transcript_path: "<scratch>/t.jsonl" }) });
    const wrapped = RECORDINGS.find((r) => r.name === "claude-2.1.302")!;
    const got = wireOfLine(wrapped, line, folder, root);
    assert.equal(got.stdin.cwd, folder);
    assert.equal(got.stdin.transcript_path, `${root}/t.jsonl`);
  });
});
