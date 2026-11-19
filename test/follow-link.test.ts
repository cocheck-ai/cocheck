import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { handleHook, hookClientName, type HookPayload } from "../src/hook-adapter.ts";
import { startReviewServer } from "../src/review-server.ts";
import { followUpMarker } from "../src/timeline/rail/send-back.ts";
import { workbookClaims } from "./helpers/claims.ts";

// a fix run that opens with a send-back's follow-up line is linked to the task it came from.
// Must not happen (each pinned below, each writes no row): wrong folder, unknown nonce or id, a task number that is not the send-back's,
// the line in a mid-task prompt, the line only in agent output or a tool result, the line inside a longer line.

const TOKEN = "f".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tmp = async (prefix: string): Promise<string> => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};

async function setup() {
  const home = await tmp("cocheck-home-");
  const folder = await tmp("cocheck-folder-");
  let clock = 1_000_000;
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, now: () => (clock += 1000) };
  const ev = (session: string, hook_event_name: string, extra: Record<string, unknown> = {}) =>
    handleHook({ session_id: session, transcript_path: `/x/${session}.jsonl`, cwd: folder, hook_event_name, ...extra } as HookPayload, opts);
  const read = <T>(f: (l: Ledger) => T): T => {
    const l = openLedger(home);
    try {
      return f(l);
    } finally {
      l.close();
    }
  };
  /** The original task (its own session, in `origFolder`) with a failed verdict and a send-back. */
  const original = (origFolder = folder) =>
    read((l) => {
      const task = l.openTask(hookClientName("claude", origFolder, "orig"));
      l.appendStopVerdict({ taskId: task, stopId: "s1", subject: "f", fingerprint: "x", status: "failed", note: "bad", reviewer: "r" });
      const id = l.appendSendBack({ taskId: task, prompt: "fix it", stopIds: ["s1"], reviewer: "r", note: "n" });
      return { task, id, nonce: l.sendBacksForTask(task)[0]!.nonce! };
    });
  const dump = (task: number): string =>
    read(() => {
      const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
      try {
        const q = (sql: string) => db.prepare(sql).all(task);
        return JSON.stringify([q("SELECT * FROM tasks WHERE id = ?"), q("SELECT * FROM ops WHERE task_id = ? ORDER BY id"), q("SELECT * FROM signoffs WHERE task_id = ?"), q("SELECT * FROM submissions WHERE task_id = ?"), q("SELECT * FROM stop_verdicts WHERE task_id = ?"), q("SELECT * FROM send_backs WHERE task_id = ?")]);
      } finally {
        db.close();
      }
    });
  const follows = () => read(() => {
    const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT task_id, send_back_id FROM follows ORDER BY id").all() as Array<{ task_id: number; send_back_id: number }>;
    } finally {
      db.close();
    }
  });
  const taskOf = (session: string) => read((l) => l.allTaskIds().find((id) => l.taskClient(id) === hookClientName("claude", folder, session)));
  return { home, folder, ev, read, original, dump, follows, taskOf };
}

const line = (task: number, id: number, nonce: string) => followUpMarker(task, id, nonce);
const boxed = (m: string) => `Fix step 1: the total in B4.\n\n${m}`;

describe("the link is written", () => {
  it("the first typed prompt carries the true line: one row, the original untouched, sessions never merged", async () => {
    const s = await setup();
    const o = s.original();
    const before = s.dump(o.task);
    await s.ev("fix", "UserPromptSubmit", { prompt: boxed(line(o.task, o.id, o.nonce)) });
    const fix = s.taskOf("fix");
    assert.ok(fix !== undefined, "the first prompt opened the fix task");
    assert.deepEqual(JSON.parse(JSON.stringify(s.follows())), [{ task_id: fix, send_back_id: o.id }]);
    assert.equal(s.dump(o.task), before, "the original task's rows are byte-identical");
    assert.notEqual(fix, o.task);
    assert.equal(s.read((l) => l.taskClient(fix)), hookClientName("claude", s.folder, "fix"), "the fix task keeps its own client");
    assert.equal(s.read((l) => l.taskClient(o.task)), hookClientName("claude", s.folder, "orig"));
    assert.deepEqual(s.read((l) => [l.followOf(fix)?.fromTask, l.followersOf(o.task).map((f) => f.taskId)]), [o.task, [fix]]);
  });

  it("a marker with the line after other typed lines still counts, and a CRLF line too", async () => {
    const s = await setup();
    const o = s.original();
    await s.ev("fix", "UserPromptSubmit", { prompt: `line one\r\nline two\r\n${line(o.task, o.id, o.nonce)}\r\n` });
    assert.equal(s.follows().length, 1);
  });
});

describe("the link is not written", () => {
  it("wrong folder: the send-back's task is in another folder", async () => {
    const s = await setup();
    const o = s.original(path.join(s.folder, "..", "somewhere-else"));
    await s.ev("fix", "UserPromptSubmit", { prompt: boxed(line(o.task, o.id, o.nonce)) });
    assert.ok(s.taskOf("fix") !== undefined);
    assert.deepEqual(s.follows(), []);
  });

  it("unknown nonce, unknown send-back id, a task number that is not the send-back's", async () => {
    const s = await setup();
    const o = s.original();
    const other = o.nonce === "zzzzzz" ? "yyyyyy" : "zzzzzz";
    await s.ev("a", "UserPromptSubmit", { prompt: boxed(line(o.task, o.id, other)) });
    await s.ev("b", "UserPromptSubmit", { prompt: boxed(line(o.task, o.id + 50, o.nonce)) });
    await s.ev("c", "UserPromptSubmit", { prompt: boxed(line(o.task + 9, o.id, o.nonce)) });
    for (const x of ["a", "b", "c"]) assert.ok(s.taskOf(x) !== undefined, x);
    assert.deepEqual(s.follows(), []);
  });

  it("the nonce alone in free text is not a marker; the line inside a longer line is not one either", async () => {
    const s = await setup();
    const o = s.original();
    await s.ev("a", "UserPromptSubmit", { prompt: `please use ${o.nonce} somewhere` });
    await s.ev("b", "UserPromptSubmit", { prompt: `see: ${line(o.task, o.id, o.nonce)} and carry on` });
    assert.deepEqual(s.follows(), []);
  });

  it("the line in a mid-task prompt (not the task's first typed prompt)", async () => {
    const s = await setup();
    const o = s.original();
    await s.ev("fix", "UserPromptSubmit", { prompt: "hello, please look at the workbook" });
    await s.ev("fix", "Stop");
    await s.ev("fix", "UserPromptSubmit", { prompt: boxed(line(o.task, o.id, o.nonce)) });
    assert.ok(s.taskOf("fix") !== undefined);
    assert.deepEqual(s.follows(), []);
  });

  it("the line only in agent output or a tool result", async () => {
    const s = await setup();
    const o = s.original();
    const m = line(o.task, o.id, o.nonce);
    await s.ev("fix", "UserPromptSubmit", { prompt: "hello, please look at the workbook" });
    await s.ev("fix", "PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "cat notes.txt", description: "read" } });
    await s.ev("fix", "PostToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "cat notes.txt", description: "read" }, tool_response: { stdout: m } });
    await s.ev("fix", "Stop", { last_assistant_message: m });
    // A later session whose first prompt only quotes nothing: its agent output carries the line, its prompt does not.
    await s.ev("two", "UserPromptSubmit", { prompt: "look at this" });
    await s.ev("two", "Stop", { last_assistant_message: m });
    assert.deepEqual(s.follows(), []);
  });
});

describe("ledger", () => {
  it("follows is append-only and holds one row per task", async () => {
    const home = await tmp("cocheck-led-");
    const l = openLedger(home);
    const a = l.openTask("claude:/w");
    const b = l.openTask("claude:/w2");
    const sb = l.appendSendBack({ taskId: a, prompt: "p", stopIds: [], reviewer: "r", note: "" });
    assert.equal(l.appendFollow(b, sb), true);
    assert.equal(l.appendFollow(b, sb), false, "a second link for the task writes nothing");
    l.close();
    const db = new DatabaseSync(path.join(home, "ledger.sqlite"));
    assert.throws(() => db.prepare("UPDATE follows SET send_back_id = 9").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM follows").run(), /append-only/);
    db.close();
  });
});

// The page harness: the node class and model shape of test/secret-reveal-page.test.ts.
class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty(this: Record<string, unknown>, k: string, v: string) { this[k] = v; } }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false; focused = false;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  fire(k: string, e: Record<string, unknown> = {}) { (this.listeners[k] ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this, ...e })); }
  click() { this.fire("click"); }
  focus() { this.focused = true; } select() {} scrollIntoView() {} scrollTo() {} showModal() { this.open = true; } close() { this.open = false; }
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { if (!s.className.split(/\s+/).includes(c)) s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

describe("the page", () => {
  it("the status route names the task a fix came from and the fix that came from a task", async () => {
    const home = await tmp("cocheck-page-");
    const ledger = openLedger(home);
    const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
    cleanups.push(async () => {
      await new Promise<void>((r) => (server as Server).close(() => r()));
      ledger.close();
    });
    const a = ledger.openTask("claude:/work");
    const b = ledger.openTask("claude:/work2");
    const sb = ledger.appendSendBack({ taskId: a, prompt: "p", stopIds: [], reviewer: "r", note: "" }, new Date("2026-10-20T12:00:00Z"));
    ledger.appendFollow(b, sb);
    const get = (id: number): Promise<any> =>
      new Promise((resolve, reject) => {
        http.get({ hostname: "127.0.0.1", port, path: `/timeline/${id}/review/status?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        }).on("error", reject);
      });
    const fixSide = await get(b);
    assert.deepEqual(fixSide.follow, { task: a, sentAt: "2026-10-20T12:00:00.000Z" });
    assert.deepEqual(fixSide.followedBy, []);
    const origSide = await get(a);
    assert.equal(origSide.follow, null);
    assert.deepEqual(origSide.followedBy, [{ task: b }]);
  });

  async function boot(status: Record<string, unknown>) {
    const nodes = new Map<string, N>();
    const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
    const model = { task: 7, folder: "work", actors: [{ id: "claude", name: "Claude", chip: "C", color: "#6fb0e3", main: true }], stops: [{ id: "start-1", label: "Started Helper 1", lane: "claude", head: "Started Helper 1 to fetch", brief: { by: "Claude", lines: [], withheld: true }, reveal: [] }] };
    const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => v });
    const body = mkNode(); body.getAttribute = (() => "7") as never;
    const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
    const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
      addEventListener() {}, setInterval: () => 0, clearInterval() {}, setTimeout: (f: () => void, ms: number) => (ms === 6000 || f.name === "poll" ? 0 : setTimeout(f, 0)), clearTimeout() {},
      fetch: async (u: string) => {
        if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(model)));
        if (u.includes("/review/status")) return json({ stops: { "start-1": { status: "not_reviewed", note: "", stale: false, history: [] } }, passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true }, ...status });
        return json({}, false);
      } };
    g.window = g; g.globalThis = g;
    const ctx = vm.createContext(g);
    for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 30));
    return byId("followline");
  }

  it("the fix task reads 'of task <n>, after your send-back on <date>'; the original reads 'Fix came in as task <m>'", async () => {
    const sentAt = "2026-10-20T12:00:00.000Z";
    const date = new Date(sentAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const fix = await boot({ follow: { task: 3, sentAt }, followedBy: [] });
    assert.equal(fix.textContent, `Round 2 of task 3, after your send-back on ${date}`);
    assert.equal(fix.hidden, false);
    const orig = await boot({ follow: null, followedBy: [{ task: 9 }] });
    assert.equal(orig.textContent, "Fix came in as task 9");
    assert.equal(orig.hidden, false);
    const none = await boot({ follow: null, followedBy: [] });
    assert.equal(none.hidden, true);
  });
});
