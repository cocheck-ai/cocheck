import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { replayToy } from "./harness-toy-rig.ts";

// The pass bar of the harness manifest: a toy harness whose payloads look like no built-in host's (camelCase session id, nested tool name and
// arguments, arguments as JSON text, the event named by the hook command, no call id) is only a manifest plus recorded payloads
// (test/fixtures/harnesses/toyagent/). It records a session end to end through the real hook entry, and nothing under src/ names it.
type Row = Record<string, any>;
const args = (op: Row): Row => JSON.parse(op.args_json.replace(/<n>/g, "0"));

describe("a harness added as a manifest alone", () => {
  it("records the session end to end, credits the written file to the toy's call as inferred, and a second replay is identical", { timeout: 300_000 }, async () => {
    const first = await replayToy("outsider");
    assert.deepEqual(first.exits, [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(first.stderr, ["", "", "", "", "", "", "", ""]);
    const ops = first.dump.ops as Row[];
    assert.ok(ops.every((o) => o.client_name === "toyagent-hook:<folder>?session=toy-session-1"), "every op is the toy host's");
    // The request, the three calls (ids made up, one per call), and the closing message.
    assert.equal(args(ops[0]!).prompts[0], "write the notes file");
    const calls = ops.filter((o) => ["read_file", "write_file", "run_shell"].includes(o.tool));
    assert.deepEqual(calls.map((o) => o.tool), ["read_file", "write_file", "run_shell"]);
    assert.deepEqual(calls.map((o) => args(o).tool_use_id), ["toyagent-toy-session-1-1", "toyagent-toy-session-1-2", "toyagent-toy-session-1-3"]);
    assert.ok(calls.every((o) => args(o).host === "toyagent" && args(o).closedBy === "post"));
    assert.equal(calls[2]!.intent, "cat data.txt", "the shell call is recorded with its command");
    const closing = ops.find((o) => args(o).hookEvent === "Stop")!;
    assert.equal(args(closing).closing.text, "Wrote notes.txt and read data.txt.");
    // The written file is credited to the write call, and only that call.
    const states = first.dump.file_states as Row[];
    const written = states.filter((s) => s.file_path.replace(/\\/g, "/") === "<folder>/notes.txt" && s.phase === "Post");
    assert.ok(written.length > 0, "notes.txt has a Post state");
    assert.ok(written.some((s) => (JSON.parse(s.credited_json) as string[]).join() === "toyagent-toy-session-1-2"), "credited to the write call");
    assert.deepEqual(args(calls[1]!).steps.length > 0, true, "the write call's op names the step");
    // Inferred, never proof: an outsider's edit does not become a host-reported edit.
    const basis = first.bases.filter((b) => b.file === "notes.txt" && b.phase === "Post");
    assert.ok(basis.every((b) => b.basis !== "host-reported-edit" && b.basis !== "argv-tag" && b.proofs === 0), JSON.stringify(basis));
    assert.deepEqual((await replayToy("outsider")).dump, first.dump);
  });

  it("the same manifest in the built-in folder may prove the edit, so the cap is the outsider rule and nothing else", { timeout: 300_000 }, async () => {
    const outsider = await replayToy("outsider");
    const builtIn = await replayToy("built-in");
    const strong = (r: typeof outsider) => r.bases.some((b) => b.file === "notes.txt" && (b.basis === "host-reported-edit" || b.proofs > 0));
    assert.equal(strong(outsider), false);
    assert.equal(strong(builtIn), true, JSON.stringify(builtIn.bases));
  });

  it("loads from $COCHECK_HARNESS_DIR as well", { timeout: 300_000 }, async () => {
    const run = await replayToy("env-folder");
    assert.equal((run.dump.ops as Row[]).filter((o) => o.tool === "write_file").length, 1);
  });

  it("no file under src/ names the toy harness", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/toyagent/i.test(readFileSync(full, "latin1"))) hits.push(full);
      }
    };
    walk(path.join(import.meta.dirname, "..", "src"));
    assert.deepEqual(hits, []);
  });
});
