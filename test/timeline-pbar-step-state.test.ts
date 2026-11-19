import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, call: string, kind = "modified"): Change => ({ id, file, outside: false, at: null, kind, step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: [call], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const call = (id: string, start: number, text: string, changes: Change[]) => ({ id, index: 1, of: 1, host: "claude", tool: "Bash", start, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text, source: "agent-description", label: "l" } });
const tl = { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 5, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [
    call("k1", 1, "delete it", [change("a", "delete-me.txt", "k1", "deleted")]),
    call("k2", 2, "write b", [change("b", "b.txt", "k2", "created")]),
    call("kq", 3, "look around", []),
    call("k3", 4, "edit helper", [change("c", "helper-file.txt", "k3")]),
    call("k4", 5, "write d", [change("d", "d.txt", "k4")]),
  ] }] }] } as unknown as Timeline;
const model = buildRailModel(tl);
const MODEL = model;
// a file the task read and never changed: Deliverables lists it as read only (no versions, no step, no verdict)
const READ_ONLY = { file: "notes.txt", name: "notes.txt", start: "lost", versions: [], source: true };

// Reported on 0.1.5 (Claude Code, Timeline, a 5-step task): after one verdict the bar's Pass/Fail state stuck to that step as the user moved,
// Pass/Fail kept acting on it, a second Pass on the step he had just passed sent him to the first change, and opening Fail's note left Pass lit.
// The bar's Pass and Fail now judge and show the step on show only; the Pass button stays on its step, so a second click clears it.
class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false; focused = false;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  fire(k: string, e: Record<string, unknown> = {}) { let prevented = false; (this.listeners[k] ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() { prevented = true; }, target: this, ...e })); return prevented; }
  click() { this.fire("click"); }
  focus() { this.focused = true; } select() {} scrollIntoView() {} showModal() { this.open = true; } close() { this.open = false; }
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });
const has = (n: N, c: string) => n.className.split(/\s+/).includes(c);

type St = { status: "passed" | "failed" | "not_reviewed"; note: string; stale: boolean; history: unknown[] };
async function boot(opts: { verdicts?: Record<string, ["passed" | "failed", string?]>; hash?: string; reduced?: boolean; live?: boolean; superseded?: string[]; notes?: unknown[]; deliverables?: boolean; model?: typeof model } = {}) {
  const model = opts.model ?? MODEL;
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const loc = { search: "?t=tok", pathname: "/timeline/7/page", hash: opts.hash ?? "#1" };
  const handlers: Record<string, (e: unknown) => void> = {};
  const timers: Array<{ f: () => void; ms: number }> = [];
  const polls: Array<() => void> = [];
  const posts: Array<{ stop: string; status: string; note: string }> = [];
  const submits: unknown[] = [];
  const stops: Record<string, St> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  for (const [id, [status, note]] of Object.entries(opts.verdicts ?? {})) stops[`chg-${id}`] = { status, note: note ?? "", stale: false, history: [] };
  const summary = () => ({ anyFailed: Object.values(stops).some((s) => s.status === "failed"), submit: { blocking: [], superseded: opts.superseded ?? [], notReviewed: Object.keys(stops).filter((k) => stops[k]!.status === "not_reviewed"), eligible: true } });
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => v });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: loc, history: { replaceState(_a: unknown, _b: unknown, u: string) { loc.hash = u.includes("#") ? u.slice(u.indexOf("#")) : ""; } }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    ...(opts.reduced === undefined ? {} : { matchMedia: (q: string) => ({ matches: opts.reduced === true && q === "(prefers-reduced-motion: reduce)" }) }),
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval: () => 0, clearInterval() {},
    // the undo bar's six seconds are held here, so a test decides when they run out
    setTimeout: (f: () => void, ms: number) => { if (opts.live && f.name === "poll") { polls.push(f); return 1000 + polls.length; } if (ms === 6000) { timers.push({ f, ms }); return timers.length; } if (f.name === "poll") return 0; return setTimeout(f, 0); }, clearTimeout() {},
    fetch: async (u: string, init?: { body?: string }) => {
      if (u.includes("/review/model")) { const m = JSON.parse(JSON.stringify(model)); if (opts.deliverables) m.files.push(READ_ONLY); return json({ ...m, ...(opts.live ? { live: true } : {}) }); }
      if (u.includes("/review/status")) return json({ stops: JSON.parse(JSON.stringify(stops)), passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], notes: opts.notes ?? [], ...summary() });
      if (u.includes("/review/verdict")) {
        const b = JSON.parse(init!.body!);
        if (b.status === "failed" && String(b.note).trim() === "") return json({ error: "needs a note" }, false);
        posts.push({ stop: b.stop, status: b.status, note: b.note });
        if (!(b.stop in stops)) return json({ error: "no such stop" }, false);
        stops[b.stop] = { status: b.status, note: b.status === "failed" ? b.note : "", stale: false, history: [] };
        return json({ stop: b.stop, state: stops[b.stop], ...summary() });
      }
      if (u.includes("/review/submit")) { submits.push(JSON.parse(init!.body!)); return json({ submitted: true, n: 1, label: "soft sign-off, not verified" }); }
      if (u.includes("/view/")) return json({ change: "x", file: "f", engine: "e", kind: "card", before: [], after: [], boxes: [], caveats: [] });
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  ((g) as Record<string, unknown>).localStorage = { getItem: (k: string) => (k === "cocheck.showQuiet" ? "on" : null), setItem() {} }; // quiet rows are off by default; these tests are about them
  const ctx = vm.createContext(g);
  for (const f of opts.deliverables ? ["view-table.js", "files-view.js", "review.js"] : ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const press = async (k: string, target: unknown = { tagName: "BODY" }, extra: Record<string, unknown> = {}) => { let prevented = false; handlers.keydown!({ key: k, target, preventDefault() { prevented = true; }, ...extra }); await settle(); return prevented; };
  const h1 = () => byId("h1").textContent;
  // the step on show, read from its heading (every step's heading differs here)
  const on = () => (h1() === "Rerun the fetch" ? "hdr" : model.stops.find((s) => (s.title ?? s.head) === h1())?.id);
  const expire = () => { timers.splice(0).forEach((t) => t.f()); };
  const poll = async () => { const f = polls.pop(); assert.ok(f, "a poll is scheduled"); f(); await settle(); };
  return { byId, press, settle, poll, posts, submits, stops, on, h1, expire, loc };
}


async function page(deliverables = false, verdicts: Record<string, ["passed" | "failed", string?]> = {}, m?: typeof model) {
  const p = await boot({ hash: deliverables ? "" : "#v=timeline", deliverables, verdicts, ...(m ? { model: m } : {}) });
  const rows = () => p.byId("tl").children.filter((n) => has(n, "row"));
  const row = async (head: string) => { const r = rows().find((x) => String(x.attrs.title).startsWith(head + ":")); assert.ok(r, head); r.click(); await p.settle(); };
  const click = async (id: string) => { p.byId(id).click(); await p.settle(); };
  const pressed = () => ({ pass: p.byId("pbpass").attrs["aria-pressed"], fail: p.byId("pbfail").attrs["aria-pressed"] });
  const label = () => p.byId("pblabel").textContent;
  const pick = async (name: string) => { const b = p.byId("fileslist").descendants().find((n) => n.attrs["data-file"] !== undefined && n.descendants().some((c) => has(c, "nm") && c.textContent === name)); assert.ok(b, name); b.click(); await p.settle(); };
  const posts = () => p.posts.map((x) => `${x.stop}:${x.status}`);
  return { ...p, row, click, pick, pressed, label, posts };
}
const NONE = { pass: "false", fail: "false" };

describe("review bar: Pass and Fail belong to the step on show", () => {
  it("a second Pass click on the step just passed clears it, and the page stays on that step", async () => {
    const p = await page();
    await p.row("Changed helper-file.txt");
    await p.click("pbpass");
    assert.equal(p.on(), "chg-c", "the Pass button does not move on");
    assert.deepEqual(p.pressed(), { pass: "true", fail: "false" });
    await p.click("pbpass");
    assert.equal(p.on(), "chg-c", "no jump to the first change");
    assert.deepEqual(p.posts(), ["chg-c:passed", "chg-c:not_reviewed"], "both clicks judged helper-file.txt");
    assert.deepEqual(p.pressed(), NONE);
    assert.equal(p.label(), "Changed helper-file.txt");
  });

  it("after a verdict, moving to other steps shows each step's own state, and Pass/Fail act on the step on show", async () => {
    const p = await page();
    await p.row("Changed helper-file.txt");
    await p.click("pbfail");
    p.byId("vnote").value = "wrong"; await p.click("vfailgo");
    assert.deepEqual(p.pressed(), { pass: "false", fail: "true" });
    await p.row("Created b.txt");
    assert.deepEqual(p.pressed(), NONE, "b.txt has no verdict");
    assert.equal(p.label(), "Created b.txt");
    await p.click("pbpass");
    assert.equal(p.on(), "chg-b");
    assert.deepEqual(p.pressed(), { pass: "true", fail: "false" });
    await p.row("Deleted delete-me.txt");
    assert.deepEqual(p.pressed(), NONE);
    await p.click("pbfail");
    assert.equal(p.byId("pcomp").hidden, false);
    assert.equal(p.on(), "chg-a", "Fail opened the note on the step on show");
    assert.deepEqual(p.posts(), ["chg-c:failed", "chg-b:passed"]);
  });

  it("on a step that takes no verdict the bar shows no state and its buttons judge nothing, never the last step judged", async () => {
    const p = await page();
    await p.row("Changed helper-file.txt");
    await p.click("pbfail");
    p.byId("vnote").value = "wrong"; await p.click("vfailgo");
    await p.row("Request 1");
    assert.equal(p.on(), "req-r0");
    assert.deepEqual(p.pressed(), NONE, "the request shows no verdict, not helper-file.txt's");
    assert.equal(p.byId("pbpass").disabled, true); assert.equal(p.byId("pbfail").disabled, true);
    assert.notEqual(p.label(), "Changed helper-file.txt");
    await p.click("pbpass"); await p.click("pbfail");
    assert.equal(p.on(), "req-r0", "no jump back to helper-file.txt");
    assert.deepEqual(p.posts(), ["chg-c:failed"], "nothing more was judged");
    // an opened quiet row (calls with no change) is the same
    await p.row("Changed helper-file.txt");
    const q = p.byId("tl").descendants().find((n) => has(n, "qline"));
    assert.ok(q, "a quiet row"); q.click(); await p.settle();
    assert.deepEqual(p.pressed(), NONE);
    await p.click("pbpass");
    assert.deepEqual(p.posts(), ["chg-c:failed"]);
  });

  it("opening Fail's note shows Fail for the step on show; cancel puts its saved state back", async () => {
    const p = await page();
    await p.row("Changed helper-file.txt");
    await p.click("pbpass");
    assert.deepEqual(p.pressed(), { pass: "true", fail: "false" });
    await p.click("pbfail");
    assert.equal(p.byId("pcomp").hidden, false);
    assert.deepEqual(p.pressed(), { pass: "false", fail: "true" }, "the open note shows Fail, not the old Pass");
    await p.click("vfailno");
    assert.deepEqual(p.pressed(), { pass: "true", fail: "false" }, "cancel leaves the pass");
    assert.deepEqual(p.posts(), ["chg-c:passed"]);
    await p.row("Created b.txt");
    assert.deepEqual(p.pressed(), NONE);
  });

  it("a fail note left open while a quiet row is opened closes, and Save or Cmd+Enter writes nothing", async () => {
    const p = await page();
    await p.row("Changed helper-file.txt");
    await p.click("pbfail");
    p.byId("vnote").value = "wrong";
    const q = p.byId("tl").descendants().find((n) => has(n, "qline"));
    assert.ok(q, "a quiet row"); q.click(); await p.settle();
    const closed = p.byId("pcomp").hidden;
    await p.click("vfailgo");
    await p.press("Enter", { tagName: "BODY" }, { metaKey: true });
    p.byId("vnote").fire("keydown", { key: "Enter", shiftKey: false });
    await p.settle();
    assert.deepEqual(p.posts(), [], "chg-c was never failed");
    assert.equal(closed, true, "the note closed with nothing saved");
    assert.equal(p.label(), "1 command, no file changed");
  });
});

describe("review bar in Deliverables: a read-only file takes no verdict", () => {
  it("a fail note left open when a read-only file is picked closes; the label names that file; Save writes nothing", async () => {
    const p = await page(true);
    await p.pick("d.txt");
    assert.equal(p.label(), "Changed d.txt");
    await p.click("pbfail");
    assert.equal(p.byId("pcomp").hidden, false);
    p.byId("vnote").value = "wrong";
    await p.pick("notes.txt");
    const closed = p.byId("pcomp").hidden, label = p.label(), pressed = p.pressed();
    await p.click("vfailgo");
    p.byId("vnote").fire("keydown", { key: "Enter", shiftKey: false }); await p.settle();
    await p.click("pbpass"); await p.click("pbfail");
    assert.deepEqual(p.posts(), []);
    assert.equal(closed, true, "the note closed");
    assert.equal(label, "notes.txt", "the label names the file on show, not d.txt");
    assert.deepEqual(pressed, NONE);
  });

  it("P and F on a read-only file judge nothing and open no note", async () => {
    const p = await page(true);
    await p.pick("d.txt");
    await p.pick("notes.txt");
    await p.press("p");
    assert.deepEqual(p.posts(), [], "P judged nothing");
    await p.press("f");
    assert.equal(p.byId("pcomp").hidden, true, "F opened no note");
    await p.pick("d.txt");
    await p.press("p");
    assert.deepEqual(p.posts(), ["chg-d:passed"], "on a changed file P still judges the file on show");
  });

  it("U on a read-only file clears nothing (a passed or failed changed file shown before it keeps its verdict)", async () => {
    for (const v of [["passed"], ["failed", "wrong"]] as Array<["passed" | "failed", string?]>) {
      const p = await page(true, { d: v });
      await p.pick("d.txt");
      await p.pick("notes.txt");
      await p.press("u");
      assert.deepEqual(p.posts(), [], `d.txt ${v[0]} was not cleared`);
      await p.pick("d.txt");
      await p.press("u");
      assert.deepEqual(p.posts(), ["chg-d:not_reviewed"], "on d.txt itself U still clears it");
    }
  });
});

// The bar shows the Fail/Pass pair only where a verdict can be given, and no "1 of N" elsewhere. Must not happen: a verdict
// control hidden or unreachable on a step that takes one. Every verdict-taking step type is walked: a created, a modified and a deleted file, a call
// header over two files, and a file version in Deliverables; and every kind that takes none: a request, an opened quiet row, a read-only file.
const tl2 = JSON.parse(JSON.stringify(tl));
tl2.requests[0].runs[0].calls.push(call("k5", 6, "write e and f", [change("e", "e.txt", "k5"), change("f", "f.txt", "k5")]));
const model2 = buildRailModel(tl2 as Timeline);
describe("review bar: the verdict pair where a verdict can be given, nowhere else", () => {
  const shown = (p: Awaited<ReturnType<typeof page>>) => ({ pair: !p.byId("pbverdict").hidden, pass: !p.byId("pbpass").disabled, fail: !p.byId("pbfail").disabled, pos: p.byId("pbpos").textContent });
  it("on every verdict-taking step the pair is drawn and enabled, P passes the step on show and F opens its note", async () => {
    const p = await page(false, {}, model2);
    const rows = () => p.byId("tl").children.filter((n) => has(n, "row"));
    const heads = ["Created b.txt", "Changed helper-file.txt", "Deleted delete-me.txt"];
    for (const head of heads) {
      await p.row(head);
      const id = p.on()!;
      const s = shown(p);
      assert.deepEqual({ ...s, pos: /^\d+ of \d+$/.test(s.pos) }, { pair: true, pass: true, fail: true, pos: true }, head);
      const before = p.posts().length;
      await p.press("p");
      assert.deepEqual(p.posts().slice(before), [`${id}:passed`], `${head}: P judged the step on show`);
      await p.row(head);
      await p.press("f");
      assert.equal(p.byId("pcomp").hidden, false, `${head}: F opened the note`);
      await p.press("Escape");
    }
    // the call header over e.txt and f.txt takes a verdict for both
    const hdr = rows().find((r) => has(r, "hdr"));
    assert.ok(hdr, "a call header"); hdr.click(); await p.settle();
    const hs = shown(p);
    assert.deepEqual({ ...hs, pos: /^\d+ of \d+$/.test(hs.pos) }, { pair: true, pass: true, fail: true, pos: true }, "header");
    const n = p.posts().length;
    await p.press("p");
    assert.deepEqual(p.posts().slice(n).sort(), ["chg-e:passed", "chg-f:passed"], "P on the header passed both files");
  });
  it("on a request and an opened quiet row the pair is not drawn, the position is empty, and P and F do nothing", async () => {
    const p = await page();
    await p.row("Request 1");
    assert.deepEqual(shown(p), { pair: false, pass: false, fail: false, pos: "" }, "request");
    await p.press("p"); await p.press("f");
    assert.deepEqual(p.posts(), []); assert.equal(p.byId("pcomp").hidden, true);
    await p.row("Changed helper-file.txt");
    const q = p.byId("tl").descendants().find((x) => has(x, "qline"));
    assert.ok(q, "a quiet row"); q.click(); await p.settle();
    assert.deepEqual(shown(p), { pair: false, pass: false, fail: false, pos: "" }, "quiet row");
    await p.press("p"); await p.press("f");
    assert.deepEqual(p.posts(), []); assert.equal(p.byId("pcomp").hidden, true);
  });
  it("in Deliverables a changed file's version takes a verdict (pair drawn, P live) and a read-only file does not", async () => {
    const p = await page(true);
    await p.pick("d.txt");
    assert.equal(shown(p).pair, true); assert.match(shown(p).pos, /^\d+ of \d+$/);
    await p.press("p");
    assert.deepEqual(p.posts(), ["chg-d:passed"]);
    await p.pick("notes.txt");
    assert.deepEqual(shown(p), { pair: false, pass: false, fail: false, pos: "" });
    await p.press("p"); await p.press("f");
    assert.deepEqual(p.posts(), ["chg-d:passed"]); assert.equal(p.byId("pcomp").hidden, true);
  });
});
describe("toolbar", () => {
  it("the task is named in words from its first request, and Send back appears only once a change is failed", async () => {
    const p = await page();
    assert.equal(p.byId("taskname").textContent, "Do it", "the first request, as the home page shortens it");
    assert.equal(p.byId("sendback").hidden, true, "nothing to send: no dead Send back");
    await p.row("Changed helper-file.txt");
    await p.click("pbfail");
    p.byId("vnote").value = "wrong"; await p.click("vfailgo");
    assert.equal(p.byId("sendback").hidden, false, "a failed change: Send back shows");
    assert.equal(p.byId("sendback").disabled, false);
  });
});
