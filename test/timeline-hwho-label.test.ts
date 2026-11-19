import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// The no-change view hid #ptag but never reset #hsign, so a "changed after you signed off" tag carried from a file step into it.
// Same boot as timeline-no-change-header-reset. The no-change view resets everything a file step paints in the header area (deletion fact, actor chip, Inferred), not a list.
// Stepping from a file step (structure panel, Open button, chart summary) to a "1 call, no change" step left all three
// on the page, because the calls view never cleared them. Walking back from a later step showed none. The panel and buttons now follow the step,
// whatever step came before. Guarded against: a no-change step claiming the previous file's structure verdict or Open buttons.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const call = (id: string, start: number, changes: Change[]) => ({ id, index: 1, of: 1, host: "claude", tool: "Bash", start, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: id, source: "agent-description", label: "l" } });
const tl = { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 3, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [
    call("w1", 1, [change("c1", "budget.xlsx")]), call("q1", 2, []), call("w2", 3, [change("c2", "notes.txt")]),
  ] }] }] } as unknown as Timeline;

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; focused = false; nodeType = 1;
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() { this.focused = true; }
  scrolled: Array<unknown> = [];
  scrollIntoView(o: unknown) { this.scrolled.push(o); }
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(sel: string): N | null { for (let n: N | null = this; n; n = n.parentNode) if (sel === ".vw[hidden]" && n.hidden && n.className.split(/\s+/).includes("vw")) return n; return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

const chartView = { change: "c1", file: "budget.xlsx", engine: "drawn by CoCheck", kind: "grid", before: [], after: [], boxes: [], caveats: [] };

async function boot() {
  const model = JSON.parse(JSON.stringify(buildRailModel(tl)));
  model.excel = true;
  const c1 = model.stops.find((s: { id: string }) => s.id === "chg-c1");
  c1.change.openExcel = { before: true, after: true };
  // c1 is a deletion by the main agent; c2 belongs to a helper, and the quiet row is the helper's call, so two actors are on the page.
  c1.change.fact = "Deleted: budget.xlsx no longer exists after this step.";
  const c2 = model.stops.find((s: { id: string }) => s.id === "chg-c2");
  c2.lane = "h1"; model.actors.push({ id: "h1", name: "Helper", chip: "H1", color: "#aa3300" });
  const SENTENCE = "Probably the Claude app saving your permission choices (CoCheck can't tell for sure; it could also be you or another process).";
  c2.muted = true; c2.sub = SENTENCE; c2.head = "Probably the Claude app created notes.txt";
  const mainActor = model.actors.find((a: { main?: boolean }) => a.main);
  const patchQuiet = (o: unknown): void => { if (Array.isArray(o)) o.forEach(patchQuiet); else if (o && typeof o === "object") { const r = o as Record<string, unknown>; if (r.quiet && typeof r.quiet === "object") for (const q of (r.quiet as { calls: Array<{ lane: string }> }).calls) q.lane = "h1"; Object.values(r).forEach(patchQuiet); } };
  patchQuiet(model);
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [], addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, activeElement: null };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "#1" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval: () => 1, clearInterval() {},
    fetch: async (u: string) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(u.includes("/review/status") ? { stops: {}, passes: { markers: [], tags: {}, afterSignoff: { changed: ["chg-c1"], newSteps: [] } } } : u.includes("/review/model") ? model : chartView)) }) };
  g.window = g; g.globalThis = g;
  ((g) as Record<string, unknown>).localStorage = { getItem: (k: string) => (k === "cocheck.showQuiet" ? "on" : null), setItem() {} }; // quiet rows are off by default; these tests are about them
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  const press = async (k: string) => { handlers.keydown!({ key: k, target: body, preventDefault() {} }); await settle(); };
  const quiet = (): N => { const all = (n: N): N[] => [n, ...n.descendants()]; return all(byId("tl")).find((n) => n.className.split(/\s+/).includes("qline"))!; };
  const openQuiet = async () => { quiet().click(); await settle(); };
  const shown = () => ({
    structure: !byId("extras").hidden && byId("extras").textContent !== "", // there is no structure panel; the step's issues (extras) must not carry over
    open: !byId("openxl").hidden && byId("openxl").textContent !== "",
    heading: byId("h1").textContent,
    fact: !byId("hfact").hidden ? byId("hfact").textContent : "",
    chip: byId("hchip").textContent,
    who: !byId("hwho").hidden ? byId("hwho").textContent : "",
    sign: !byId("hsign").hidden ? byId("hsign").textContent : "",
  });
  const rowTitles = (): string[] => { const all = (n: N): N[] => [n, ...n.descendants()]; return all(byId("tl")).filter((n) => n.className.split(/\s+/).includes("row")).map((n) => `${n.attrs.title} | ${n.attrs["aria-label"]}`); };
  return { press, openQuiet, shown, rowTitles, mainChip: mainActor.chip as string };
}

describe("a muted 'probably the app' step shows its full sentence under the heading", () => {
  const SENT = /^Probably the Claude app saving your permission choices \(CoCheck can't tell for sure; it could also be you or another process\)\.$/;
  const toStep = async (p: Awaited<ReturnType<typeof boot>>, re: RegExp) => { for (let i = 0; i < 8 && !re.test(p.shown().heading); i++) await p.press("ArrowRight"); };
  it("on that step the heading area holds the whole sentence, caveat included", async () => {
    const p = await boot(); await toStep(p, /notes\.txt/);
    assert.match(p.shown().heading, /notes\.txt/);
    assert.match(p.shown().who, SENT);
  });
  it("not on a credited agent edit, and not on the no-change view", async () => {
    const p = await boot(); await toStep(p, /notes\.txt/);
    assert.match(p.shown().who, SENT, "it is there on the step first");
    await p.openQuiet();
    assert.equal(p.shown().who, "", "the no-change view clears it");
    await p.press("ArrowLeft"); await toStep(p, /budget/);
    assert.match(p.shown().heading, /budget/);
    assert.equal(p.shown().who, "", "a credited agent edit never carries it");
  });
  it("the rail row's hover title and aria-label carry the caveat too", async () => {
    const p = await boot();
    const row = p.rowTitles().find((r) => /Probably/.test(r))!;
    assert.ok(row, "the muted row exists");
    assert.equal((row.match(/can't tell for sure/g) ?? []).length, 2, row);
  });
});
