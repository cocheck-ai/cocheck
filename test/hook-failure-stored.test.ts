import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { loadRows } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a failed call is stored as failed (never result_code OK, error text kept) and shows on the page. The fixture is a real Claude Code
// capture (two failing Bash calls: exit 3 after a partial write, exit 1 with stderr); the adapter's parsing is tested against that exact shape.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

const captured = async (): Promise<Array<Record<string, any>>> =>
  (await readFile(path.join(import.meta.dirname, "fixtures", "posttoolusefailure.jsonl"), "utf8")).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));

async function session() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => (clock += 1000) };
  const hook = (o: Record<string, unknown>) => handleHook({ session_id: "sess", cwd: folder, ...o } as HookPayload, opts);
  const F = (f: string) => path.join(folder, f);
  const rows = () => {
    const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
    try {
      return (db.prepare("SELECT id, tool, result_code, error_text, args_json FROM ops WHERE tool != 'hook' ORDER BY id").all() as Array<Record<string, any>>).map((r) => ({ ...r, args: JSON.parse(r.args_json) }) as Record<string, any>);
    } finally {
      db.close();
    }
  };
  const model = () => {
    const ledger = openLedger(home);
    try {
      const loaded = loadRows(ledger, 1, "test");
      return buildRailModel(buildTimeline({ ...loaded, build: "t", folder, stored: new Map(), formats: new Map(), quickLook: false }));
    } finally {
      ledger.close();
    }
  };
  const ok = () => {
    const ledger = openLedger(home);
    try {
      return ledger.okOpsForTask(1, 0, ledger.maxOpId()).map((o) => o.id);
    } finally {
      ledger.close();
    }
  };
  return { hook, rows, model, ok, file: F };
}

describe("the captured PostToolUseFailure shape", () => {
  it("the fixture holds the real keys, and no tool_response", async () => {
    const [pre, fail] = await captured();
    assert.equal(pre!.hook_event_name, "PreToolUse");
    assert.equal(fail!.hook_event_name, "PostToolUseFailure");
    assert.deepEqual(Object.keys(fail!).sort(), ["cwd", "duration_ms", "effort", "error", "hook_event_name", "is_interrupt", "permission_mode", "prompt_id", "session_id", "tool_input", "tool_name", "tool_use_id", "transcript_path"]);
  });
  it("both captured failures close as failed with their error text kept", async () => {
    const t = await session();
    const all = await captured();
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    for (const p of all) await t.hook({ ...p, cwd: undefined });
    const [a, b] = t.rows();
    assert.equal(a!.args.closedBy, "failure");
    assert.equal(a!.error_text, "Exit code 3");
    assert.equal(a!.args.error, "Exit code 3");
    assert.notEqual(a!.result_code, "OK");
    assert.equal(b!.args.closedBy, "failure");
    assert.equal(b!.error_text, "Exit code 1\ncat: /nonexistent/file: No such file or directory");
    assert.notEqual(b!.result_code, "OK");
  });
  it("a failed op still counts for the round and the page (the readers keep it)", async () => {
    const t = await session();
    for (const p of await captured()) await t.hook({ ...p, cwd: undefined });
    assert.equal(t.ok().length, t.rows().length);
  });
});

describe("a result the host marks as error", () => {
  it("a PostToolUse whose tool_response is flagged is_error closes as failed, with the text", async () => {
    const t = await session();
    const p = { tool_name: "mcp__x__do", tool_use_id: "toolu_e1", tool_input: {} };
    await t.hook({ hook_event_name: "PreToolUse", ...p });
    await t.hook({ hook_event_name: "PostToolUse", ...p, tool_response: { is_error: true, content: [{ type: "text", text: "quota exceeded" }] } });
    const [r] = t.rows();
    assert.equal(r!.args.closedBy, "failure");
    assert.equal(r!.error_text, "quota exceeded");
    assert.notEqual(r!.result_code, "OK");
  });
  it("a failure event whose Pre was never seen is still a failure", async () => {
    const t = await session();
    const [, fail] = await captured();
    await t.hook({ ...fail!, cwd: undefined });
    const [r] = t.rows();
    assert.equal(r!.args.closedBy, "failure");
    assert.notEqual(r!.result_code, "OK");
    assert.equal(r!.error_text, "Exit code 3");
  });
});

describe("a call that succeeded is never failed", () => {
  const succeed = async (response: unknown, name = "Bash") => {
    const t = await session();
    const p = { tool_name: name, tool_use_id: "toolu_ok", tool_input: { command: "make" } };
    await t.hook({ hook_event_name: "PreToolUse", ...p });
    await t.hook({ hook_event_name: "PostToolUse", ...p, tool_response: response });
    return t.rows()[0]!;
  };
  it("a Bash call with stderr but exit 0", async () => {
    const r = await succeed({ stdout: "built", stderr: "warning: deprecated\nerror: ignored, continuing", interrupted: false, isImage: false });
    assert.equal(r.args.closedBy, "post");
    assert.equal(r.result_code, "OK");
    assert.equal(r.error_text, null);
    assert.equal("error" in r.args, false);
  });
  it("a tool returning text that contains error", async () => {
    for (const response of [{ content: [{ type: "text", text: "Error handling guide: errors are values" }] }, "error: none found", { is_error: false, content: "error" }, { error: null }]) {
      const r = await succeed(response, "Read");
      assert.equal(r.args.closedBy, "post", JSON.stringify(response));
      assert.equal(r.result_code, "OK");
    }
  });
});

describe("the page", () => {
  it("a failed call that changed a file: the A line, with the error", async () => {
    const t = await session();
    await writeFile(t.file("deck.txt"), "start\n");
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "Build the deck." });
    const p = { tool_name: "Bash", tool_use_id: "toolu_f1", tool_input: { command: "python3 build.py" } };
    await t.hook({ hook_event_name: "PreToolUse", ...p });
    await writeFile(t.file("deck.txt"), "half\n");
    await t.hook({ hook_event_name: "PostToolUseFailure", ...p, error: "Exit code 3", is_interrupt: false });
    const change = t.model().stops.find((s) => s.change?.file.endsWith("deck.txt"))!.change!;
    assert.match(change.failed ?? "", /^The call that changed .*deck\.txt failed/);
    assert.match(change.failed ?? "", /Exit code 3/);
    assert.ok(!/recorded no error text/.test(change.failed ?? ""));
  });
  it("a failed call that changed no file is a moment of its own, in plain words", async () => {
    const t = await session();
    await writeFile(t.file("a.txt"), "start\n");
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "Check it." });
    const p = { tool_name: "Bash", tool_use_id: "toolu_f2", tool_input: { command: "cat /nonexistent/file", description: "Read a file that does not exist" } };
    await t.hook({ hook_event_name: "PreToolUse", ...p });
    await t.hook({ hook_event_name: "PostToolUseFailure", ...p, error: "Exit code 1\ncat: /nonexistent/file: No such file or directory", is_interrupt: false });
    const stop = t.model().stops.find((s) => s.id.startsWith("fail-"));
    assert.ok(stop, "a failed call with no change has a stop");
    assert.match(stop!.head, /failed/);
    const text = JSON.stringify(stop);
    assert.match(text, /No such file or directory/);
    assert.ok(!/succeeded/.test(text));
  });
  it("a succeeded call that changed nothing gets no failed moment", async () => {
    const t = await session();
    await writeFile(t.file("a.txt"), "start\n");
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "Check it." });
    const p = { tool_name: "Bash", tool_use_id: "toolu_s1", tool_input: { command: "ls" } };
    await t.hook({ hook_event_name: "PreToolUse", ...p });
    await t.hook({ hook_event_name: "PostToolUse", ...p, tool_response: { stdout: "a.txt", stderr: "error: noisy", interrupted: false } });
    assert.equal(t.model().stops.some((s) => s.id.startsWith("fail-")), false);
  });
});
