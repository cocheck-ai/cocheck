import { posixOnly } from "./helpers/platform.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { book, dumpLedger, filesContaining, journalRecords, makeRig, spawnHook, type Rig } from "./hook-corpus.ts";

// exit code, stdout and ledger for every stdin class (pinned from the comparison with the pre-code, which proved them equal);
// a completed Stop leaves no raw body of its session; unwritable-journal variants. HOME and COCHECK_HOME are temp dirs.
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
const args = (r: Rig) => ["--host", "claude", "--folder", r.folder];

describe("exit code and ledger for every stdin class", () => {
  const classes: Array<[string, Buffer, number]> = [
    ["array", Buffer.from("[]"), 0],
    ["number", Buffer.from("123"), 0],
    ["string", Buffer.from('"x"'), 0],
    ["true", Buffer.from("true"), 0],
    ["null", Buffer.from("null"), 1],
    ["empty object", Buffer.from("{}"), 0],
    ["empty stdin", Buffer.alloc(0), 1],
    ["binary", Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]), 1],
    ["malformed", Buffer.from("{oops"), 1],
  ];
  for (const [name, input, exit] of classes) {
    it(`${name}`, async () => {
      const a = await rig();
      const run = await spawnHook(a, args(a), input);
      assert.equal(run.status, exit, run.stderr);
      assert.equal(run.stdout, "");
      // Rows, not the file: a payload of `null` opened an empty ledger before it threw; no row is the same outcome as an empty ledger.
      const empty = Object.fromEntries(["tasks", "ops", "events", "steps", "file_states", "rounds", "round_results", "review_rows", "state_removals"].map((t) => [t, []]));
      const ledger = existsSync(path.join(a.home, "ledger.sqlite")) ? dumpLedger(a.home, a.folder) : empty;
      assert.deepEqual(ledger, empty);
    });
  }
});

describe("no raw body of a session is ever written", () => {
  it("a failed Pre, an unparseable event, then a good Stop: no token anywhere under the home", async () => {
    const r = await rig();
    const T = { input: "TOKEN-INPUT-5e2c1a", resp: "TOKEN-RESP-91d0be", extra: "TOKEN-EXTRA-3a77f0", junk: "TOKEN-JUNK-c4412d" };
    const base = { session_id: "sess-r2", cwd: r.folder, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: T.input }, tool_response: { stdout: T.resp }, extra: T.extra };
    const failed = await spawnHook(r, ["--host", "claude", "--folder", path.join(r.folder, "nonexistent")], JSON.stringify(base));
    assert.equal(failed.status, 1);
    await spawnHook(r, args(r), `{"session_id":"${T.junk}", oops`);
    for (const t of Object.values(T)) assert.deepEqual(filesContaining(path.join(r.home, "journal"), t), [], `before the Stop: ${t} not in the journal`);
    const stop = await spawnHook(r, args(r), JSON.stringify({ session_id: "sess-r2", cwd: r.folder, hook_event_name: "Stop" }));
    assert.equal(stop.status, 0);
    for (const t of Object.values(T)) assert.deepEqual(filesContaining(r.home, t), [], t);
    const recs = journalRecords(r.home);
    assert.equal(recs.filter((x) => x.k === "failure").length, 2, "failure info stays in the index");
    assert.equal(recs.filter((x) => x.k === "event").length, 3);
  });

  it("an event whose index line cannot be written leaves no payload anywhere", async () => {
    const r = await rig();
    const session = createHash("sha256").update("sess-x").digest("hex").slice(0, 16);
    await mkdir(path.join(r.home, "journal"), { recursive: true });
    await writeFile(path.join(r.home, "journal", `${session}.jsonl`), "");
    await chmod(path.join(r.home, "journal", `${session}.jsonl`), 0o000);
    const run = await spawnHook(r, args(r), JSON.stringify({ session_id: "sess-x", cwd: r.folder, hook_event_name: "Notification", extra: "TOKEN-ORPHAN-77" }));
    assert.equal(run.status, 0);
    assert.deepEqual(filesContaining(r.home, "TOKEN-ORPHAN-77"), []);
    await chmod(path.join(r.home, "journal", `${session}.jsonl`), 0o600);
  });
});

describe("unwritable journal variants change nothing toward the host", { skip: process.getuid?.() === 0 && "root bypasses file permissions" }, () => {
  const good = (r: Rig) => ({ session_id: "sess-p", cwd: r.folder, hook_event_name: "Notification" });
  it("journal directory mode 500", posixOnly("a read-only directory mode (0500) does not stop a Windows write"), async () => {
    const r = await rig();
    await mkdir(path.join(r.home, "journal"));
    await chmod(path.join(r.home, "journal"), 0o500);
    const run = await spawnHook(r, args(r), JSON.stringify(good(r)));
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /journal unavailable/);
    const bad = await spawnHook(r, args(r), "{nope");
    assert.equal(bad.status, 1);
  });
  it("the session's journal file mode 000", async () => {
    const r = await rig();
    const session = createHash("sha256").update("sess-p").digest("hex").slice(0, 16);
    await mkdir(path.join(r.home, "journal"));
    await writeFile(path.join(r.home, "journal", `${session}.jsonl`), "");
    await chmod(path.join(r.home, "journal", `${session}.jsonl`), 0o000);
    const run = await spawnHook(r, args(r), JSON.stringify(good(r)));
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /journal unavailable/);
    await chmod(path.join(r.home, "journal", `${session}.jsonl`), 0o600);
  });
});
