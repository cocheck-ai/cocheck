import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import { stopIdentities, summarize } from "../src/timeline/rail/stop-status.ts";
import { buildSendBack } from "../src/timeline/rail/send-back.ts";
import { readPreferences, updatePreferences } from "../src/preferences.ts";

// Send-back choice, the "New since you signed off" mark, and one actor in the send-back text:
// (1) "In send back to agent, have a dialog for whether notes should be included as part of the send back, or only review comments."
// (2) "is there a way to acknowledge it so it goes away?": a step's mark clears once opened and left, and stays cleared on reload.
// (3) a send-back heading read "Helper 5 changed t12/deck.pptx" while its "What changed:" line read "Claude changed t12/deck.pptx".
// Guard: "comments only" must leave every sticky note out of the text AND unsent; an old body ({}) must still include them;
// Cancel must send nothing; a mark must not clear on a step merely shown (only when left), nor on a step never opened.

const TOKEN = "s".repeat(40);
const CLIENT = "claude:/work";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const ledger: Ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const call = (method: string, p: string, opts: { token?: string | null; origin?: string | null; json?: unknown; raw?: string } = {}): Promise<{ status: number; body: string }> => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    const url = token === null ? p : `${p}?t=${token}`;
    const body = opts.raw ?? (opts.json === undefined ? undefined : JSON.stringify(opts.json));
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (body !== undefined) headers["content-type"] = "application/json";
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
  let seq = 0;
  const file = "/work/notes.txt";
  const task = async (): Promise<number> => {
    const id = ledger.openTask(CLIENT);
    const states = await ensureStoreDir(home, id);
    await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
    const [t0, t1] = ["one\nline\n", "one\nline changed\n"];
    for (const text of [t0, t1]) await writeFile(path.join(states, sha(text)), text);
    const callId = `toolu_${id}`;
    ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit the notes", clientName: CLIENT, durationMs: 1, resultCode: "OK",
      args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: [file], description: "edit the notes", narration: { source: "none", text: "no narration recorded" } } });
    const add = (prev: string | null, text: string): void => {
      ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: file, sha256: sha(text), prevSha256: prev === null ? null : sha(prev), size: text.length, kept: "whole", note: "" }] });
    };
    add(null, t0);
    add(t0, t1);
    return id;
  };
  const verdict = (id: number, json: unknown) => call("POST", `/timeline/${id}/review/verdict`, { json, origin: `http://127.0.0.1:${port}` });
  const sendBack = (id: number, json: unknown = {}, extra: { token?: string | null; origin?: string | null; raw?: string } = {}) =>
    call("POST", `/timeline/${id}/review/sendback`, { json, origin: extra.origin === undefined ? `http://127.0.0.1:${port}` : extra.origin, ...(extra.token === undefined ? {} : { token: extra.token }), ...(extra.raw === undefined ? {} : { raw: extra.raw }) });
  const stops = async (id: number): Promise<string[]> => Object.keys(JSON.parse((await call("GET", `/timeline/${id}/review/status`)).body).stops).filter((k) => k.startsWith("chg-"));
  return { home, ledger, port, call, task, verdict, sendBack, stops };
}


describe("send-back choice: the server", () => {
  const prep = async () => {
    const s = await setup();
    const id = await s.task();
    const last = (await s.stops(id)).at(-1)!;
    await s.verdict(id, { stop: last, status: "failed", note: "First line is wrong." });
    const note = await s.call("POST", `/timeline/${id}/review/notes`, { json: { text: "STICKY remember the header" }, origin: `http://127.0.0.1:${s.port}` });
    assert.equal(note.status, 200, note.body);
    return { s, id };
  };

  it("notes: false sends the review comments only: no sticky note in the text, and the note is not marked sent", async () => {
    const { s, id } = await prep();
    const r = await s.sendBack(id, { notes: false });
    assert.equal(r.status, 200, r.body);
    const j = JSON.parse(r.body);
    assert.match(j.prompt, /First line is wrong\./);
    assert.doesNotMatch(j.prompt, /STICKY|Notes:|follow the notes/);
    assert.equal(s.ledger.liveNotes(id).length, 1, "the sticky note is still live, not sent");
    // the next send-back with notes carries it
    const again = JSON.parse((await s.sendBack(id, { notes: true })).body);
    assert.match(again.prompt, /Note 1: STICKY remember the header/);
    assert.equal(s.ledger.liveNotes(id).length, 0);
  });

  it("an old body ({}) and notes: true both include the sticky notes, as before", async () => {
    for (const body of [{}, { notes: true }]) {
      const { s, id } = await prep();
      const j = JSON.parse((await s.sendBack(id, body)).body);
      assert.match(j.prompt, /First line is wrong\./);
      assert.match(j.prompt, /Note 1: STICKY remember the header/);
      assert.equal(s.ledger.liveNotes(id).length, 0, JSON.stringify(body));
    }
  });

  it("refuses a notes field that is not true or false, and records nothing", async () => {
    const { s, id } = await prep();
    for (const notes of ["no", 0, null, []]) assert.equal((await s.sendBack(id, { notes })).status, 400, JSON.stringify(notes));
    assert.deepEqual(s.ledger.sendBacksForTask(id), []);
  });

  it("comments only with no failed step is nothing to send (409), and the notes stay", async () => {
    const s = await setup();
    const id = await s.task();
    await s.call("POST", `/timeline/${id}/review/notes`, { json: { text: "only a note" }, origin: `http://127.0.0.1:${s.port}` });
    assert.equal((await s.sendBack(id, { notes: false })).status, 409);
    assert.equal(s.ledger.liveNotes(id).length, 1);
  });
});

describe("send-back text: one actor per item", () => {
  it("the What changed line names the step's credit, as the heading does", () => {
    const c: any = { id: "c1", file: "t12/deck.pptx", kind: "modified", before: { sha256: "b" }, after: { sha256: "a" }, by: { kind: "call", calls: ["x"], lost: 0, open: 0, expired: false, actor: "Claude", host: "claude" },
      note: { text: "Claude changed t12/deck.pptx", source: "rule" }, format: null };
    const model: any = { task: 12, folder: "/w", actors: [], stops: [{ id: "chg-c1", label: "deck.pptx", head: "Helper 5 changed t12/deck.pptx", lane: "h5", change: { key: "c1", file: "t12/deck.pptx", kind: "modified", note: "Helper 5 changed t12/deck.pptx", rowNotes: [], secret: false } }] };
    const timeline: any = { unplaced: [c], requests: [] };
    const ids = stopIdentities(model, timeline);
    const rows = [{ id: 1, taskId: 12, stopId: "chg-c1", subject: ids.get("chg-c1")!.subject, fingerprint: ids.get("chg-c1")!.fingerprint, status: "failed" as const, note: "wrong", reviewer: "t", ts: "2026-11-01T00:00:00.000Z" }];
    const out = buildSendBack(model, timeline, summarize(model, timeline, rows));
    assert.match(out.prompt, /1\. Helper 5 changed t12\/deck\.pptx/);
    assert.match(out.prompt, /What changed: Helper 5 changed t12\/deck\.pptx/);
    assert.doesNotMatch(out.prompt, /Claude changed/);
  });
});

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; open?: boolean; checked?: boolean; style: Record<string, any> = { setProperty() {}, removeProperty() {} }; dataset = {}; _text = ""; value = ""; focused = false; nodeType = 1; rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  removeChild(c: N) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(sel: string): N | null { for (let n: N | null = this; n; n = n.parentNode) if (sel === ".vw[hidden]" && n.hidden && n.className.split(/\s+/).includes("vw")) return n; return null; }
  getBoundingClientRect() { return this.rect; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });


const stopOf = (key: string) => ({ id: `chg-${key}`, label: `${key}.txt`, lane: "main", head: `Claude changed ${key}.txt`, change: { key, file: `${key}.txt`, kind: "modified", note: `Changed ${key}.txt.`, rowNotes: [], moreNote: null, viewUrl: `/timeline/7/view/${key}`, secret: false, secretLine: null, failed: null, ask: null, newFile: null, treeBefore: null, treeAfter: null } });

const textPane = (side: string) => ({ id: `${side}:t`, label: `${side} text`, text: { lines: [1, 2].map((n) => ({ n, text: `${side} line ${n}`, marks: [] })) } });
const textView = (change: string) => ({ change, file: `${change}.txt`, engine: "", kind: "text", before: [textPane("before")], after: [textPane("after")], boxes: [], caveats: [] });
interface Call { method: string; url: string; body: any }
async function boot(o: { failed?: string[]; notes?: string[]; newSteps?: string[]; prefsHome?: string } = {}) {
  const keys = ["k1", "k2", "k3"];
  const model: any = { task: 7, folder: "work", actors: [{ id: "main", name: "Claude", chip: "C", color: "#123456" }], stops: keys.map(stopOf) };
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  for (const id of ["ncomp", "pcomp", "sbout", "toast"]) byId(id).hidden = true;
  const calls: Call[] = []; const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const answer = (j: unknown, status = 200) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(j)) });
  const prefsHome = o.prefsHome ?? await mkdtemp(path.join(tmpdir(), "cocheck-seen-prefs-"));
  const stops = Object.fromEntries((o.failed ?? []).map((id) => [id, { status: "failed", note: "bad", stale: false, history: [] }]));
  const passes = o.newSteps ? { markers: [], tags: {}, afterSignoff: { changed: [], newSteps: o.newSteps }, answeredBy: {} } : null;
  const fetchStub = async (u: string, op?: { method?: string; body?: string }) => {
    const b = op?.body ? JSON.parse(op.body) : null;
    calls.push({ method: op?.method ?? "GET", url: u, body: b });
    // the review process's preferences, backed by the real store in a temp home, as the route does
    if (u.includes("/review/preferences")) { const out = b ? updatePreferences(prefsHome, b) : { prefs: readPreferences(prefsHome) }; return "error" in out ? answer(out, 400) : answer(out.prefs); }
    const json = u.includes("/review/status") ? { stops, passes, notes: (o.notes ?? []).map((text, i) => ({ id: i + 1, text, ts: 1, regionId: null, region: null, where: null, picture: false })) } : u.includes("/review/model") ? model : u.includes("/review/sendback") ? { id: 4, prompt: "p", stops: [], nonce: "ab12cd", marker: "m" } : u.includes("/view/") ? textView(u.split("/view/")[1]!.split("?")[0]!) : {};
    return answer(json);
  };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, setInterval, clearInterval, setTimeout: (f: () => void, ms: number) => (f.name === "poll" ? (0 as never) : setTimeout(f, ms)), clearTimeout, fetch: fetchStub,
    addEventListener: (k: string, f: (e: unknown) => void) => { (listeners[k] ??= []).push(f); } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 25));
  await settle();
  const sendBacks = () => calls.filter((c) => c.url.includes("/review/sendback") && !c.url.includes("copy")).map((c) => c.body);
  const dlgKey = (key: string, target: N = mkNode()) => (byId("sbdlg").listeners.keydown ?? []).forEach((f) => f({ key, target, preventDefault() {}, stopPropagation() {} }));
  const go = async (dir: "next" | "prev") => { byId(dir === "next" ? "pbnext" : "pbprev").click(); await settle(); };
  const marks = () => (byId("tl").textContent.match(/New since you signed off/g) ?? []).length;
  return { byId, calls, sendBacks, dlgKey, settle, go, marks, prefsHome, listeners };
}

describe("send-back choice: the dialog", () => {
  it("with failed steps and sticky notes, Send back opens the dialog with notes included by default; Enter sends notes: true", async () => {
    const p = await boot({ failed: ["chg-k1"], notes: ["n1"] });
    assert.equal(renderReviewShell(7).includes('id="sbdlg"'), true, "the page ships the dialog");
    p.byId("sendback").click(); await p.settle();
    assert.equal(p.byId("sbdlg").open, true, "the dialog is open");
    assert.deepEqual(p.sendBacks(), [], "nothing is sent before the choice");
    assert.equal(p.byId("sbwithnotes").checked, true, "default: include the sticky notes (today's behaviour)");
    p.dlgKey("Enter"); await p.settle();
    assert.deepEqual(p.sendBacks(), [{ notes: true }]);
    assert.equal(p.byId("sbdlg").open, false);
  });

  it("Review comments only sends notes: false", async () => {
    const p = await boot({ failed: ["chg-k1"], notes: ["n1"] });
    p.byId("sendback").click(); await p.settle();
    p.byId("sbwithnotes").checked = false; p.byId("sbcommentsonly").checked = true;
    p.byId("sbdlggo").click(); await p.settle();
    assert.deepEqual(p.sendBacks(), [{ notes: false }]);
  });

  it("Esc and Cancel send nothing", async () => {
    const p = await boot({ failed: ["chg-k1"], notes: ["n1"] });
    p.byId("sendback").click(); await p.settle();
    p.dlgKey("Escape"); await p.settle();
    assert.equal(p.byId("sbdlg").open, false);
    p.byId("sendback").click(); await p.settle();
    p.byId("sbdlgcancel").click(); await p.settle();
    assert.equal(p.byId("sbdlg").open, false);
    assert.deepEqual(p.sendBacks(), []);
  });

  it("with only failed steps (no sticky note) there is nothing to pick: Send back posts at once, as before", async () => {
    const p = await boot({ failed: ["chg-k1"] });
    p.byId("sendback").click(); await p.settle();
    assert.notEqual(p.byId("sbdlg").open, true);
    assert.deepEqual(p.sendBacks(), [{}]);
  });
});

describe("New since you signed off: cleared by open-then-leave", () => {
  it("a step's mark stays while it is on show, clears once left, and stays cleared on reload; a step never opened keeps its mark", async () => {
    const p = await boot({ newSteps: ["chg-k1", "chg-k2", "chg-k3"] });
    cleanups.push(() => rm(p.prefsHome, { recursive: true, force: true }));
    await p.go("prev"); await p.go("prev"); await p.go("prev"); // on the first step
    const atStart = p.marks();
    assert.equal(atStart, 3, "every new step is marked, the one on show included");
    await p.go("next"); // left k1, now on k2
    assert.equal(p.marks(), 2, "k1 cleared once left; k2 (on show) and k3 (never opened) keep theirs");
    assert.deepEqual(p.calls.filter((c) => c.url.includes("/review/preferences") && c.body).map((c) => c.body), [{ seen: { task: 7, stop: "chg-k1" } }], "one write, for the step left");
    const again = await boot({ newSteps: ["chg-k1", "chg-k2", "chg-k3"], prefsHome: p.prefsHome });
    assert.equal(again.marks(), 2, "after a reload k1 stays cleared");
    assert.deepEqual(readPreferences(p.prefsHome).seenNew, { "7": ["chg-k1"] });
  });

  it("the store adds one step at a time, refuses a bad seen patch, and keeps other keys", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-seen-store-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    updatePreferences(home, { railOrder: "newest-first" });
    updatePreferences(home, { seen: { task: 7, stop: "chg-a" } });
    updatePreferences(home, { seen: { task: 7, stop: "chg-a" } });
    updatePreferences(home, { seen: { task: 9, stop: "chg-b" } });
    assert.deepEqual(readPreferences(home).seenNew, { "7": ["chg-a"], "9": ["chg-b"] });
    assert.equal(readPreferences(home).railOrder, "newest-first");
    for (const seen of [null, "x", { task: 0, stop: "a" }, { task: 1.5, stop: "a" }, { task: 7 }, { task: 7, stop: "" }, { task: 7, stop: "x".repeat(201) }]) assert.ok("error" in updatePreferences(home, { seen }), JSON.stringify(seen));
    assert.deepEqual(readPreferences(home).seenNew, { "7": ["chg-a"], "9": ["chg-b"] });
  });
});
