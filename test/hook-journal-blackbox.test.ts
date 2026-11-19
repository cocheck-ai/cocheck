import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { book, filesContaining, journalRecords, makeRig, spawnHook, type Rig } from "./hook-corpus.ts";

// black box: `node src/hook.ts` is spawned, so this file also runs against the pre-change code (where every journal
// assertion fails and the exit-behaviour ones pass). HOME and COCHECK_HOME are the rig's temp home; nothing reads a real home.
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await chmod(path.join(r.home, "journal"), 0o700).catch(() => {});
    await r.cleanup();
  }
});
const rig = async () => {
  const r = await makeRig();
  rigs.push(r);
  return r;
};
const event = (r: Rig, over: Record<string, unknown> = {}) => ({ session_id: "sess-1", cwd: r.folder, transcript_path: "/x/t.jsonl", hook_event_name: "Notification", ...over });
const send = (r: Rig, payload: unknown, args: string[] = ["--host", "claude", "--folder", r.folder]) => spawnHook(r, args, typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
const kinds = (home: string, k: string) => journalRecords(home).filter((x) => x.k === k);

describe("the journal is written before anything that can fail", () => {
  it("1. malformed JSON: a record, a marker, exit 1, empty stdout, no body prefix in the journal", async () => {
    const r = await rig();
    const bad = Buffer.from('{"secret":"sk-live-ABCDEF123456", oops');
    const run = await send(r, bad);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    const [ev] = kinds(r.home, "event");
    assert.equal(ev.event, "unparseable");
    assert.equal(ev.sha256, sha(bad));
    assert.equal(ev.size, bad.length);
    const [mark] = kinds(r.home, "failure");
    assert.equal(mark.ref, ev.id);
    assert.equal(filesContaining(path.join(r.home, "journal"), "sk-live").filter((f) => f.endsWith(".jsonl")).length, 0, "no part of the body in the index or the marker");
  });

  it("2. empty stdin and non-UTF8 bytes: the sha256 is over the raw bytes", async () => {
    const r = await rig();
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28])]) {
      const run = await send(r, bytes);
      assert.equal(run.status, 1);
      assert.equal(run.stdout, "");
      assert.ok(kinds(r.home, "event").some((e) => e.sha256 === sha(bytes) && e.size === bytes.length), `record for ${bytes.length} bytes`);
    }
    assert.equal(kinds(r.home, "failure").length, 2);
  });

  it("3. no folder, and a missing or bad --host: a record and a marker, exit 1; the host reads unknown", async () => {
    const r = await rig();
    const noFolder = await send(r, event(r), ["--host", "claude"]);
    assert.equal(noFolder.status, 1);
    assert.match(noFolder.stderr, /no task folder/);
    const noHost = await send(r, event(r), ["--folder", r.folder]);
    assert.equal(noHost.status, 1);
    const badHost = await send(r, event(r), ["--host", "gemini", "--folder", r.folder]);
    assert.equal(badHost.status, 1);
    const events = kinds(r.home, "event");
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.host), ["claude", "unknown", "unknown"]);
    assert.equal(kinds(r.home, "failure").length, 3);
  });

  it("4. an oversized payload keeps only the index; the process finishes and exits as before", { timeout: 120_000 }, async () => {
    const r = await rig();
    const big = Buffer.from(JSON.stringify(event(r, { padding: "x".repeat(12 * 1024 * 1024) })));
    const run = await send(r, big);
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    const [ev] = kinds(r.home, "event");
    assert.equal(ev.size, big.length);
    assert.equal(ev.sha256, sha(big));
    assert.ok(!("body" in ev), "no body flag");
    assert.deepEqual(filesContaining(path.join(r.home, "journal"), "xxxxxxxxxxxx"), []);
  });

  it("5. a missing tool_use_id gets a deterministic synthetic id, flagged; a real id is kept as is", async () => {
    const r = await rig();
    const noId = event(r, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    await send(r, noId);
    await send(r, noId);
    await send(r, { ...noId, tool_use_id: "toolu_01REAL" });
    const [a, b, c] = kinds(r.home, "event");
    assert.equal(a.synthetic, true);
    assert.equal(a.id, b.id);
    assert.match(a.id, /^syn-[0-9a-f]{16}$/);
    assert.equal(c.synthetic, false);
    assert.equal(c.id, "toolu_01REAL");
    assert.notEqual(c.id, a.id);
  });

  it("6. a Codex payload sent as --host claude, and an unknown event name, are journaled and exit 0", async () => {
    const r = await rig();
    const codex = event(r, { session_id: "019a0000-0000-4000-8000-00000000c0de", turn_id: "turn-1", model: "gpt-5-codex", hook_event_name: "Stop", stop_hook_active: false });
    assert.equal((await send(r, codex)).status, 0);
    assert.equal((await send(r, event(r, { hook_event_name: "SomethingNew" }))).status, 0);
    const events = kinds(r.home, "event");
    assert.deepEqual(events.map((e) => e.event), ["Stop", "SomethingNew"]);
    assert.equal(kinds(r.home, "failure").length, 0);
  });

  it("7. 20 concurrent hooks over two folders sharing one session: 20 records, no torn line", { timeout: 180_000 }, async () => {
    const r = await rig();
    const other = path.join(r.folder, "second");
    await mkdir(other);
    await writeFile(path.join(other, "m.xlsx"), book({ A1: 1 }));
    const runs = await Promise.all(Array.from({ length: 20 }, (_, i) => send(r, event(r, { turn: i }), ["--host", "claude", "--folder", i % 2 === 0 ? r.folder : other])));
    assert.deepEqual(runs.map((x) => x.status), Array(20).fill(0));
    assert.equal(kinds(r.home, "event").length, 20, "journalRecords throws on a torn line");
    assert.equal(new Set(kinds(r.home, "event").map((e) => e.sha256)).size, 20);
    assert.equal(kinds(r.home, "done").length, 20);
  });

  it("10. no file under the home holds the response or extra tokens at any step; the index stays; a second Stop is a no-op", async () => {
    const r = await rig();
    const T1 = "TOKEN-RESPONSE-7f3a9c";
    const T2 = "TOKEN-EXTRA-b81e04";
    const call = (name: string, extra: Record<string, unknown>) => event(r, { hook_event_name: name, tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "python3 bump.py", description: "edit" }, ...extra });
    await writeFile(path.join(r.folder, "model.xlsx"), book({ A1: 1, A2: 2, A3: 3 }));
    await send(r, call("PreToolUse", { unlogged_field: T2 }));
    await writeFile(path.join(r.folder, "model.xlsx"), book({ A1: 9, A2: 2, A3: 3 }));
    await send(r, call("PostToolUse", { tool_response: { stdout: T1 }, unlogged_field: T2 }));
    assert.deepEqual(filesContaining(path.join(r.home, "journal"), T1), [], "before the Stop the response token is not in the journal");
    const stop = event(r, { hook_event_name: "Stop", last_assistant_message: "Done.", note: T2 });
    assert.equal((await send(r, stop)).status, 0);
    assert.deepEqual(filesContaining(r.home, T1), [], "response token");
    assert.deepEqual(filesContaining(r.home, T2), [], "extra token");
    assert.deepEqual(await readdir(path.join(r.home, "journal")).then((n) => n.filter((x) => !x.endsWith(".jsonl"))), [], "only index files");
    assert.equal(kinds(r.home, "event").length, 3, "index records survive");
    assert.equal((await send(r, stop)).status, 0, "a second Stop");
    assert.equal(kinds(r.home, "event").length, 4);
  });

  it("11/12. a journal that cannot be written changes no exit code, no stdout and no ledger op", async () => {
    const r = await rig();
    await writeFile(path.join(r.home, "journal"), "not a directory");
    const good = await send(r, event(r));
    assert.equal(good.status, 0, "a previously successful event still exits 0");
    assert.equal(good.stdout, "");
    assert.match(good.stderr, /journal unavailable/);
    assert.ok(existsSync(path.join(r.home, "journal.degraded")), "a degraded flag is left");
    const bad = await send(r, "{nope");
    assert.equal(bad.status, 1, "a failing event still exits 1");
    assert.equal(bad.stdout, "");
  });

  it("14. a Stop with stop_hook_active true and no transcript_path: no crash, recorded", async () => {
    const r = await rig();
    const run = await send(r, { session_id: "s", cwd: r.folder, hook_event_name: "Stop", stop_hook_active: true });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    assert.equal(kinds(r.home, "event")[0].event, "Stop");
  });

  it("15. a secret in a payload: the index holds a hash and a size, nothing of the body", async () => {
    const r = await rig();
    const secret = "sk-live-9d8c7b6a5f4e3d2c1b0a";
    await send(r, event(r, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t9", tool_input: { command: `curl -H "Authorization: Bearer ${secret}" x` } }));
    assert.deepEqual(filesContaining(path.join(r.home, "journal"), "sk-live"), [], "no journal file holds the secret");
    assert.equal(journalRecords(r.home).filter((x) => x.event === "PreToolUse").length, 1, "the index line exists");
    for (const rec of journalRecords(r.home)) assert.ok(!JSON.stringify(rec).includes("sk-live"));
  });
});
