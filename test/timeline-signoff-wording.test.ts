import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import vm from "node:vm";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import { afterSignoff, signoffMarkerLabel } from "../src/timeline/rail/passes.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";








// Sign-off wording and state. Submit follows the stop statuses and records a soft sign-off. A real ledger and review server on a temp home; no real CoCheck home, no
// browser. Must not happen: no submission with a failed stop, no unacknowledged not-reviewed stop, and a soft sign-off never reads as verified.

const TOKEN = "v".repeat(40);
const CLIENT = "claude:/work";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Res { status: number; body: string }
interface Setup {
  home: string;
  ledger: Ledger;
  port: number;
  task(): Promise<number>;
  /** A later state of the same file, in a new step. */
  newState(id: number, text: string): void;
  call(method: string, p: string, opts?: { token?: string | null; origin?: string | null; json?: unknown; headers?: Record<string, string> }): Promise<Res>;
  post(id: number, json: unknown, opts?: { token?: string | null; origin?: string | null }): Promise<Res>;
  status(id: number): Promise<any>;
  submit(id: number, json?: unknown, opts?: { token?: string | null; origin?: string | null }): Promise<Res>;
}

async function setup(): Promise<Setup> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  let seq = 0;
  const file = "/work/notes.txt";
  const call = (method: string, p: string, opts: { token?: string | null; origin?: string | null; json?: unknown; headers?: Record<string, string> } = {}): Promise<Res> => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    const url = token === null ? p : `${p}${p.includes("?") ? "&" : "?"}t=${token}`;
    const body = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...opts.headers };
    if (opts.origin !== null && opts.origin !== undefined) headers.origin = opts.origin;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: url, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(body);
    });
  };
  const addState = (id: number, prev: string | null, text: string): void => {
    const callId = `toolu_${id}`;
    ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: file, sha256: sha(text), prevSha256: prev === null ? null : sha(prev), size: text.length, kept: "whole", note: "" }] });
  };
  const texts = new Map<number, string>();
  return {
    home,
    ledger,
    port,
    call,
    async task() {
      const id = ledger.openTask(CLIENT);
      const states = await ensureStoreDir(home, id);
      await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
      const [t0, t1] = ["one\nline\n", "one\nline changed\n"];
      for (const text of [t0, t1]) await writeFile(path.join(states, sha(text)), text);
      const callId = `toolu_${id}`;
      ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit the notes", clientName: CLIENT, durationMs: 1, resultCode: "OK",
        args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: [file], description: "edit the notes", narration: { source: "none", text: "no narration recorded" } } });
      ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK",
        args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Fix the notes."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
      addState(id, null, t0);
      addState(id, t0, t1);
      texts.set(id, t1);
      return id;
    },
    newState(id, text) {
      const states = path.join(home, "tasks", String(id));
      // the stored copy is not needed to name the stop; the ledger row is what makes it a new state
      void states;
      addState(id, texts.get(id)!, text);
      texts.set(id, text);
    },
    post(id, json, opts = {}) {
      return call("POST", `/timeline/${id}/review/verdict`, { json, origin: opts.origin === undefined ? `http://127.0.0.1:${port}` : opts.origin, ...(opts.token === undefined ? {} : { token: opts.token }) });
    },
    submit(id, json = {}, opts = {}) {
      return call("POST", `/timeline/${id}/review/submit`, { json, origin: opts.origin === undefined ? `http://127.0.0.1:${port}` : opts.origin, ...(opts.token === undefined ? {} : { token: opts.token }) });
    },
    async status(id) {
      const r = await call("GET", `/timeline/${id}/review/status`);
      assert.equal(r.status, 200, r.body);
      return JSON.parse(r.body);
    },
  };
}

const changeStops = (st: any): string[] => Object.keys(st.stops).filter((k) => k.startsWith("chg-"));

const allStops = (st: any): string[] => Object.keys(st.stops);
const rowsOf = (home: string, table: string): number => {
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"));
  try { return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n); } finally { db.close(); }
};

async function passAll(s: Setup, id: number): Promise<string[]> {
  const ids = allStops(await s.status(id));
  for (const stop of ids) assert.equal((await s.post(id, { stop, status: "passed" })).status, 200);
  return ids;
}


const FORBIDDEN = /submit|commit|soft|verified/i;
const DAY = /\d{4}-\d\d-\d\d/;

describe("state after signing off (server)", () => {
  it("signing off with steps not looked at is allowed and the record keeps them; the refusal words carry none of the old vocabulary", async () => {
    const s = await setup();
    const id = await s.task();
    const refused = await s.submit(id);
    assert.equal(refused.status, 409);
    assert.doesNotMatch(JSON.parse(refused.body).error, FORBIDDEN, refused.body);
    const open = allStops(await s.status(id));
    assert.equal((await s.submit(id, { acknowledge: open })).status, 200);
    const st = await s.status(id);
    assert.deepEqual(st.submitted.acknowledged, [...open].sort());
    assert.equal(st.submitState, "submitted");
    assert.deepEqual(st.passes.afterSignoff, { changed: [], newSteps: [] });
    assert.match(st.passes.markers[0].label, new RegExp(`^Signed off by .+, ${DAY.source}: everything above this line was reviewed except ${open.filter((id) => id.startsWith("chg-")).length} changes not looked at$`));
  });

  it("a verdict changed after signing is marked on its step and unlocks signing off again; a sign-off with nothing new is still refused", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    assert.equal((await s.submit(id)).status, 200);
    assert.equal((await s.submit(id)).status, 409, "nothing changed yet");
    const first = changeStops(await s.status(id)).at(-1)!;
    assert.equal((await s.post(id, { stop: first, status: "failed", note: "wrong total" })).status, 200);
    let st = await s.status(id);
    assert.deepEqual(st.passes.afterSignoff.changed, [first]);
    assert.equal(st.submitState, "new_work");
    // the failed verdict still blocks, and the old sign-off stays what it was
    assert.equal(JSON.parse((await s.submit(id)).body).code, "FAILED_STOPS");
    assert.equal((await s.post(id, { stop: first, status: "passed" })).status, 200);
    st = await s.status(id);
    assert.deepEqual(st.passes.afterSignoff.changed, [], "back to what the sign-off covered");
    assert.equal(st.submitState, "submitted");
    assert.equal((await s.post(id, { stop: first, status: "not_reviewed" })).status, 200);
    st = await s.status(id);
    assert.deepEqual(st.passes.afterSignoff.changed, [first]);
    assert.equal(JSON.parse((await s.submit(id)).body).code, "ACK_REQUIRED");
    assert.equal((await s.submit(id, { acknowledge: [first] })).status, 200);
    st = await s.status(id);
    assert.equal(st.earlier.length, 1);
    assert.equal(st.submitState, "submitted");
  });

  it("a new step after signing is new since the sign-off, on the status and in its tag", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    assert.equal((await s.submit(id)).status, 200);
    await new Promise((r) => setTimeout(r, 5));
    s.newState(id, "one\nline again\n");
    const st = await s.status(id);
    assert.equal(st.passes.afterSignoff.newSteps.length, 1);
    assert.equal(st.submitState, "new_work");
    assert.deepEqual((Object.values(st.passes.tags) as any[]).map((t) => t.text), ["Changes something you passed"]);
  });

  it("a stored sign-off row is never updated or deleted, and an old sign-off never covers a verdict that came after it", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    assert.equal((await s.submit(id)).status, 200);
    const read = () => {
      const db = new DatabaseSync(path.join(s.home, "ledger.sqlite"));
      try { return JSON.stringify(db.prepare("SELECT * FROM submissions ORDER BY id").all()) + JSON.stringify(db.prepare("SELECT * FROM signoffs ORDER BY id").all()); } finally { db.close(); }
    };
    const before = read();
    const first = changeStops(await s.status(id)).at(-1)!;
    await s.post(id, { stop: first, status: "failed", note: "no" });
    assert.equal((await s.status(id)).submitState, "new_work", "the old sign-off does not read as covering the failed verdict");
    assert.equal(read(), before, "later verdicts leave the stored rows untouched");
    await s.post(id, { stop: first, status: "passed" });
    assert.equal((await s.submit(id, {})).status, 409);
    assert.equal(read(), before, "a refused sign-off writes nothing");
    const db = new DatabaseSync(path.join(s.home, "ledger.sqlite"));
    try {
      assert.throws(() => db.exec("UPDATE submissions SET reviewer = 'x'"), /append-only/);
      assert.throws(() => db.exec("DELETE FROM submissions"), /append-only/);
      assert.throws(() => db.exec("UPDATE signoffs SET signer = 'x'"), /append-only/);
      assert.throws(() => db.exec("DELETE FROM signoffs"), /append-only/);
    } finally { db.close(); }
  });

  it("index page: a task signed off, then a verdict changed, is listed as waiting; the index text carries none of the old vocabulary", async () => {
    const s = await setup();
    const id = await s.task();
    await passAll(s, id);
    assert.equal((await s.submit(id)).status, 200);
    const quiet = (await s.call("GET", "/")).body;
    assert.match(quiet, /Nothing is waiting for review/);
    assert.match(quiet, /class="gl ok" title="Signed off"/);
    const first = changeStops(await s.status(id)).at(-1)!;
    assert.equal((await s.post(id, { stop: first, status: "failed", note: "wrong" })).status, 200);
    const waiting = (await s.call("GET", "/")).body;
    assert.doesNotMatch(waiting, /Nothing is waiting for review/, "an old sign-off does not cover the later verdict");
    assert.match(waiting, new RegExp(`href="/timeline/${id}/review\\?t=`));
    assert.match(waiting, /new work since, not yet signed off again/);
    // back to what the sign-off covered: not waiting again
    assert.equal((await s.post(id, { stop: first, status: "passed" })).status, 200);
    assert.match((await s.call("GET", "/")).body, /Nothing is waiting for review/);
    // sign off again with an earlier one on record, then sweep every index state's text
    await s.post(id, { stop: first, status: "not_reviewed" });
    assert.equal((await s.submit(id, { acknowledge: [first] })).status, 200);
    s.newState(id, "one\nline a third time\n");
    for (const body of [quiet, waiting, (await s.call("GET", "/")).body]) {
      const text = body.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ");
      assert.doesNotMatch(text, FORBIDDEN, text);
    }
    assert.match((await s.call("GET", "/")).body, /1 earlier sign-off/);
  });
});

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, at: number): Change => ({ id, file, outside: false, at, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref(id.padEnd(64, "b")), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const tl = { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: 1, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "call", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes: [change("c1", "a.xlsx", 1000), change("c2", "b.xlsx", 2000)], line: { text: "t", source: "agent-description", label: "l" } }] }] }] } as unknown as Timeline;
const railModel = buildRailModel(tl);

describe("afterSignoff (pure)", () => {
  const sub = (covered: Array<{ stop: string; status: string; sha256: string | null }> | null, ts = 3000) => ({ id: 1, taskId: 7, signoffId: 1, acknowledged: [], reviewer: "t", ts: new Date(ts).toISOString(), stateMark: null, covered });
  const covered = railModel.stops.map((st) => ({ stop: st.id, status: "not_reviewed", sha256: st.change === undefined ? null : st.id.slice(4).padEnd(64, "b") }));
  it("nothing differs: nothing after; a stop the sign-off did not list is new; a different status or version is changed", () => {
    assert.deepEqual(afterSignoff(railModel, tl, [], sub(covered)), { changed: [], newSteps: [] });
    assert.deepEqual(afterSignoff(railModel, tl, [], sub(covered.slice(1))).newSteps, [railModel.stops[0]!.id]);
    assert.deepEqual(afterSignoff(railModel, tl, [], sub(covered.map((c) => (c.stop === "chg-c1" ? { ...c, status: "passed" } : c)))).changed, ["chg-c1"]);
    assert.deepEqual(afterSignoff(railModel, tl, [], sub(covered.map((c) => (c.stop === "chg-c2" ? { ...c, sha256: "f".repeat(64) } : c)))).changed, ["chg-c2"]);
    assert.deepEqual(afterSignoff(railModel, tl, [], undefined), { changed: [], newSteps: [] });
  });
  it("a sign-off recorded with no covered list falls back to time: a later step is new", () => {
    assert.deepEqual(afterSignoff(railModel, tl, [], sub(null, 1500)).newSteps, ["chg-c2"]);
  });
  it("the marker line names the person and the day, and says how many steps were not looked at", () => {
    assert.equal(signoffMarkerLabel("Ana", "2026-10-29T10:00:00.000Z", 0), "Signed off by Ana, 2026-10-29: everything above this line was reviewed");
    assert.equal(signoffMarkerLabel("Ana", "2026-10-29T10:00:00.000Z", 1), "Signed off by Ana, 2026-10-29: everything above this line was reviewed except 1 change not looked at");
  });
});

// The page: the real script in a vm with a DOM stub (the shared stub), fed a status answer.
class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false;
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() {} select() {} scrollIntoView() {} scrollTo() {} showModal() { this.open = true; } close() { this.open = false; }
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });
const has = (n: N, c: string) => n.className.split(/\s+/).includes(c);
const ASSETS = ["view-table.js", "files-view.js", "review.js"];
const railJson = JSON.parse(JSON.stringify(railModel));

async function boot(status: Record<string, unknown>, hash = "") {
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const timers: unknown[] = [];
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const stops: Record<string, unknown> = {};
  for (const st of railModel.stops) stops[st.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  const answer = { stops, passes: { markers: [], tags: {}, answeredBy: {}, afterSignoff: { changed: [], newSteps: [] } }, anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: Object.keys(stops), eligible: true }, submitState: "none", submitted: null, earlier: [], ...status };
  const posts: Array<{ url: string; body: unknown }> = [];
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    addEventListener() {},
    setInterval: (f: () => void, ms: number) => { const id = setInterval(f, ms); timers.push(id); return id; }, clearInterval,
    fetch: async (u: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") { posts.push({ url: u, body: JSON.parse(init.body ?? "{}") }); return { ok: true, status: 200, json: async () => ({ submitted: true, n: 1, acknowledged: (JSON.parse(init.body ?? "{}") as { acknowledge?: string[] }).acknowledge ?? [] }) }; }
      return { ok: true, status: 200, json: async () => (u.includes("/review/model") ? railJson : u.includes("/review/status") ? answer : { change: "x", file: "f", engine: "e", kind: "card", before: [], after: [], boxes: [], caveats: [] }) };
    } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ASSETS) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 30));
  const everything = (): string[] => [...nodes.values()].flatMap((n) => [n.textContent, n.title, n.attrs.title ?? "", n.attrs["aria-label"] ?? "", ...n.descendants().flatMap((d) => [d.textContent, d.title, d.attrs.title ?? "", d.attrs["aria-label"] ?? ""])]).filter((x) => x !== "");
  return { byId, posts, everything, cleanup: () => timers.forEach((i) => clearInterval(i as never)), settle: () => new Promise((r) => setTimeout(r, 30)) };
}

const reviewed = (ids: string[]) => Object.fromEntries(railModel.stops.map((st) => [st.id, { status: ids.includes(st.id) ? "passed" : "not_reviewed", note: "", stale: false, history: [] }]));
const signedChange = () => ({ ...signed(1), acknowledged: ["chg-c1"] }); // a sign-off that left one change (not a request) unlooked-at
const signed = (n: number) => ({ id: 1, n: 1, ts: "2026-10-29T10:00:00.000Z", reviewer: "Ana", acknowledged: railModel.stops.slice(0, n).map((st) => st.id), covered: [], label: "x" });

describe("the page's words and states", () => {
  it("the buttons: Sign off, and Send back to agent; the dialog asks about steps not looked at", () => {
    const html = renderReviewShell(7);
    assert.match(html, /id="submit" disabled>Sign off<\/button>/);
    assert.match(html, /id="sendback" disabled>Send back to agent<span/);
    assert.match(html, /Sign off with steps not looked at\?/);
  });
  it("never signed: the button says Sign off and nothing claims a sign-off; a sign-off with steps not looked at is allowed and says how many", async () => {
    const p = await boot({});
    try {
      assert.equal(p.byId("submit").textContent, "Sign off");
      assert.equal(p.byId("submsg").textContent, "");
      assert.equal(p.byId("submit").disabled, false, "steps not looked at do not block");
      p.byId("submit").click(); await p.settle();
      assert.equal(p.byId("subdlg").open, true);
      p.byId("subgo").click(); await p.settle();
      assert.equal(p.posts.length, 1);
      assert.equal(p.byId("submsg").textContent, "Signed off. You can still add to it.");
      assert.equal(p.byId("subleft").textContent.trim(), `${railModel.stops.filter((st) => st.id.startsWith("chg-")).length} changes not looked at`);
      assert.equal(p.byId("submit").disabled, true);
    } finally { p.cleanup(); }
  });
  it("signed with nothing new: the line says so and the count of steps not looked at shows; the button waits", async () => {
    const p = await boot({ stops: reviewed(["chg-c1"]), submitState: "submitted", submitted: signedChange() });
    try {
      assert.equal(p.byId("submsg").textContent, "Signed off. You can still add to it.");
      assert.equal(p.byId("subleft").textContent.trim(), "1 change not looked at");
      assert.equal(p.byId("submit").disabled, true);
    } finally { p.cleanup(); }
  });
  it("the header says Signed off once and its count is of changes, so it reconciles with the progress line", async () => {
    const p = await boot({ stops: reviewed(["chg-c1"]), submitState: "submitted", submitted: signedChange() });
    try {
      const head = (p.byId("submsg").textContent + p.byId("subleft").textContent).trim();
      assert.equal((head.match(/Signed off/g) ?? []).length, 1, head);
      assert.equal(p.byId("subleft").textContent.trim(), "1 change not looked at");
    } finally { p.cleanup(); }
  });
  it("the rail marker shows a short label that fits the rail; the full sentence is its hover text and its accessible name", async () => {
    const label = signoffMarkerLabel("Ana", "2026-10-29T10:00:00.000Z", 2);
    const passes = { markers: [{ id: "submit-1", kind: "submitted", label, ts: "2026-10-29T10:00:00.000Z", pass: 1, beforeStop: null }], tags: {}, answeredBy: {}, afterSignoff: { changed: [], newSteps: [] } };
    const p = await boot({ submitState: "submitted", submitted: signed(1), passes });
    try {
      const pml = p.byId("tl").descendants().find((n) => has(n, "pml"))!;
      assert.equal(pml.textContent, "Signed off");
      assert.equal(pml.getAttribute("title"), label);
    } finally { p.cleanup(); }
  });
  it("a change after signing: the button reads Sign off again and is unlocked, and the step says it changed after you signed off", async () => {
    const passes = { markers: [{ id: "submit-1", kind: "submitted", label: "Signed off by Ana, 2026-10-29: everything above this line was reviewed", ts: "2026-10-29T10:00:00.000Z", pass: 1, beforeStop: null }], tags: {}, answeredBy: {}, afterSignoff: { changed: ["chg-c1"], newSteps: ["chg-c2"] } };
    const p = await boot({ stops: reviewed(["chg-c1", "chg-c2"]), submitState: "new_work", submitted: signed(0), passes, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } }, "#1");
    try {
      assert.equal(p.byId("submit").textContent, "Sign off again");
      assert.equal(p.byId("submit").disabled, false);
      const chips = p.byId("tl").descendants().filter((n) => has(n, "aftersign")).map((n) => n.textContent);
      assert.deepEqual(chips.sort(), ["New since you signed off", "changed after you signed off"]);
      const marks = p.byId("tl").children.filter((n) => has(n, "pmark")).map((n) => n.textContent);
      assert.deepEqual(marks, ["Signed off"]);
      assert.match(p.byId("hsign").textContent, /changed after you signed off|New since you signed off/);
      assert.equal(p.byId("hsign").hidden, false);
      assert.equal(p.byId("hsign").parentNode === p.byId("h1").parentNode, true, "the bubble sits in the step head beside the title");
      assert.doesNotMatch(p.byId("ptag").textContent, /signed off/, "no pill under the fail note");
    } finally { p.cleanup(); }
  });
  it("an unchanged step carries no after-sign-off words, and with nothing after it the button stays locked", async () => {
    const p = await boot({ stops: reviewed(["chg-c1", "chg-c2"]), submitState: "submitted", submitted: signed(0), submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } }, "#1");
    try {
      assert.deepEqual(p.byId("tl").descendants().filter((n) => has(n, "aftersign")), []);
      assert.equal(p.byId("submit").disabled, true);
      assert.equal(p.byId("submit").textContent, "Sign off");
    } finally { p.cleanup(); }
  });
});

describe("no old vocabulary in anything the page renders", () => {
  it("rendered text across states, the shell, and every string literal of the page scripts carry none of submit, commit, soft, verified", async () => {
    const passes = { markers: [{ id: "submit-1", kind: "submitted", label: signoffMarkerLabel("Ana", "2026-10-29T10:00:00.000Z", 2), ts: "2026-10-29T10:00:00.000Z", pass: 1, beforeStop: null }], tags: { "chg-c2": { tag: "new", text: "New since you signed off", pass: 1 } }, answeredBy: {}, afterSignoff: { changed: ["chg-c1"], newSteps: ["chg-c2"] } };
    const seen: string[] = [renderReviewShell(7).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<(?!\/?[a-z])/g, "&lt;").replace(/<[^>]+?(?:title|aria-label)="([^"]*)"[^>]*>/g, " $1 ").replace(/<[^>]*>/g, " ")];
    for (const status of [{}, { submitState: "submitted", submitted: signed(2) }, { submitState: "new_work", submitted: signed(1), passes }, { submit: { blocking: ["chg-c1"], superseded: [], notReviewed: [], eligible: true } }]) {
      const p = await boot(status, "#1");
      try { p.byId("submit").click(); await p.settle(); seen.push(...p.everything()); } finally { p.cleanup(); }
    }
    for (const text of seen) assert.doesNotMatch(text, FORBIDDEN, text);
    // every string literal of the scripts: identifiers and paths (no space, lower case or containing / # . _) are internal, the rest is text a person can read
    for (const f of ASSETS) {
      const src = (await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, " ");
      for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
        const lit = m[1] ?? m[2] ?? "";
        if (!FORBIDDEN.test(lit)) continue;
        if (/^[a-z0-9_\-./#:?=&]*$/.test(lit) || lit.includes("/") || lit.startsWith("var(")) continue;
        assert.fail(`${f}: string literal shows old vocabulary: ${lit}`);
      }
    }
  });
});
