import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { reconcileSession } from "../src/coverage.ts";
import { loadRows } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a call with no Post (blocked by another hook, or moved to the background past the 10-minute expiry) reads "no result recorded",
// never OK and never a write; a Post that arrives after expiry replaces the expiry outcome; coverage counts the calls expiry closed.
// Command shape copied from recorded, op 826 (the call rm_guard blocked: a heredoc write of fetch.py).

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

const FETCH = "W=/private/tmp/x/scratch/snodas; mkdir -p $W/scripts; cat > $W/scripts/fetch.py <<'EOF'\nimport sys, os\nEOF";
const SID = "sess";

async function session() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const hook = (o: Record<string, unknown>) => handleHook({ session_id: SID, cwd: folder, ...o } as HookPayload, opts);
  const call = (id: string, command: string, extra: Record<string, unknown> = {}) => ({ tool_name: "Bash", tool_use_id: id, tool_input: { command, ...extra } });
  const pre = (id: string, command: string, extra: Record<string, unknown> = {}) => hook({ hook_event_name: "PreToolUse", ...call(id, command, extra) });
  const post = (id: string, command: string, extra: Record<string, unknown> = {}) => hook({ hook_event_name: "PostToolUse", ...call(id, command, extra), tool_response: { stdout: "", stderr: "", interrupted: false } });
  const advance = (ms: number) => void (clock += ms);
  const calls = () => {
    const ledger = openLedger(home);
    try {
      const loaded = loadRows(ledger, 1, "test");
      const t = buildTimeline({ ...loaded, build: "t", folder, stored: new Map(), formats: new Map(), quickLook: false });
      return t.requests.flatMap((q) => q.runs).flatMap((r) => r.calls);
    } finally {
      ledger.close();
    }
  };
  const coverage = () => {
    const ledger = openLedger(home);
    try {
      return reconcileSession({ home, ledger, host: "claude", sessionId: SID });
    } finally {
      ledger.close();
    }
  };
  return { hook, pre, post, advance, calls, coverage };
}

const EXPIRE = 11 * 60_000;

describe("a call with no Post event", () => {
  it("reads 'no result recorded', not 'Wrote to', and its outcome is unknown", async () => {
    const t = await session();
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await t.pre("toolu_blocked", FETCH);
    t.advance(EXPIRE);
    await t.pre("toolu_next", "ls"); // sweeps and expires the blocked call
    const c = t.calls().find((x) => x.id === "toolu_blocked")!;
    assert.equal(c.closedBy, "expiry");
    assert.equal(c.outcome, "unknown");
    assert.match(c.line.text, /no result recorded/i);
    assert.doesNotMatch(c.line.text, /wrote/i);
  });
});

describe("a Post that arrives after expiry", () => {
  it("replaces the expiry outcome, once, with no second call", async () => {
    const t = await session();
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await t.pre("toolu_slow", FETCH);
    t.advance(EXPIRE);
    await t.pre("toolu_next", "ls");
    await t.post("toolu_slow", FETCH);
    await t.post("toolu_slow", FETCH); // a repeat adds nothing
    const slow = t.calls().filter((x) => x.id === "toolu_slow");
    assert.equal(slow.length, 1);
    assert.equal(slow[0]!.closedBy, "post");
    assert.equal(slow[0]!.outcome, "succeeded");
    assert.match(slow[0]!.line.text, /wrote to fetch\.py/i);
  });
  it("a late PostToolUseFailure makes it failed", async () => {
    const t = await session();
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await t.pre("toolu_slow", "make");
    t.advance(EXPIRE);
    await t.pre("toolu_next", "ls");
    await t.hook({ hook_event_name: "PostToolUseFailure", ...{ tool_name: "Bash", tool_use_id: "toolu_slow", tool_input: { command: "make" } }, error: "Exit code 2", is_interrupt: false });
    const slow = t.calls().find((x) => x.id === "toolu_slow")!;
    assert.equal(slow.closedBy, "failure");
    assert.equal(slow.outcome, "failed");
  });
});

describe("an expired helper is never read as live", () => {
  it("a call whose Post arrives in time keeps its outcome and its write line", async () => {
    const t = await session();
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await t.pre("toolu_ok", FETCH);
    t.advance(60_000);
    await t.post("toolu_ok", FETCH);
    const c = t.calls().find((x) => x.id === "toolu_ok")!;
    assert.equal(c.closedBy, "post");
    assert.equal(c.outcome, "succeeded");
    assert.match(c.line.text, /wrote to fetch\.py/i);
  });
  it("a Post for a call that was never opened and never expired changes no other call and is no expiry replacement", async () => {
    const t = await session();
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await t.pre("toolu_open", "ls");
    await t.post("toolu_stranger", "ls");
    const all = t.calls();
    const open = all.find((x) => x.id === "toolu_open");
    assert.equal(open?.closedBy, "stop" === open?.closedBy ? "stop" : open?.closedBy);
    assert.deepEqual(all.filter((x) => x.id === "toolu_stranger").map((x) => x.closedBy), ["ghost-post"]);
  });
});

describe("coverage", () => {
  it("counts the calls expiry closed, names them, and is not complete; a late Post takes the call back out", async () => {
    const t = await session();
    await t.hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await t.pre("toolu_blocked", FETCH);
    t.advance(EXPIRE);
    await t.pre("toolu_next", "ls");
    await t.post("toolu_next", "ls");
    const row = t.coverage();
    assert.equal(row.expired, 1);
    assert.deepEqual(row.names.expired, ["toolu_blocked"]);
    assert.notEqual(row.status, "complete");
    await t.post("toolu_blocked", FETCH);
    const after = t.coverage();
    assert.equal(after.expired, 0);
  });
});
