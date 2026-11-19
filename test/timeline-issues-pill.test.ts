import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readFile as rf } from "node:fs/promises";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The step's issues (spec `issues`, any connector) are a small amber pill at the right end of the step header: "1 issue" / "N issues", none
// when there are no issues. The pill opens the Details panel at its Issues group, where the sentences and "Copy fix prompt" live; the stage
// draws no issues disclosure. The fix prompt is made only from the issues about the file as it is now (not a before-side issue).

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, any> = { setProperty() {}, removeProperty() {} }; dataset = {}; _text = ""; focused = false; nodeType = 1;
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

const RC = { key: "k1", file: "decks/deck.pptx", kind: "modified", note: "Changed deck.pptx.", rowNotes: [], moreNote: null, viewUrl: "/timeline/7/view/k1", secret: false, secretLine: null, failed: null, ask: null, newFile: null };
async function boot(issues: unknown) {
  const VIEW = { change: "k1", file: "deck.pptx", engine: "", kind: "card", before: [], after: [], boxes: [], caveats: [], ...(issues === undefined ? {} : { issues }) };
  const model: any = { task: 7, folder: "work", actors: [{ id: "main", name: "Claude", chip: "C", color: "#123456" }], stops: [{ id: "chg-k1", label: "deck.pptx", lane: "main", head: "Claude changed deck.pptx", change: RC }] };
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; if (id === "detpanel" || id === "detissues" || id === "hissues") n.hidden = true; nodes.set(id, n); } return nodes.get(id)!; };
  const copied: string[] = [];
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement: mkNode(), activeElement: null };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    navigator: { clipboard: { writeText: async (t: string) => { copied.push(t); } } },
    addEventListener() {}, setInterval, clearInterval, setTimeout: (f: () => void) => { if (f.name === "poll") return 0; return 1; },
    fetch: async (u: string) => ({ ok: true, status: 200, json: async () => (u.includes("/review/model") ? JSON.parse(JSON.stringify(model)) : u.includes("/view/") ? VIEW : {}) }) };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await rf(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 30));
  return { byId, copied, group: () => byId("detissues"), pill: () => byId("hissues") };
}
const TWO = [{ text: "The total no longer matches the rows above.", where: "Ledger!F12" }, { text: "Already broken before.", side: "before", where: "Ledger!A1" }];

describe("the issues pill in the step header", () => {
  it("counts the step's issues: '1 issue', 'N issues'", async () => {
    const one = await boot([TWO[0]]);
    assert.equal(one.pill().hidden, false);
    assert.equal(one.pill().textContent, "1 issue");
    const two = await boot(TWO);
    assert.equal(two.pill().hidden, false);
    assert.equal(two.pill().textContent, "2 issues");
  });
  it("is absent when the step has no issues, and so is the Issues group", async () => {
    for (const none of [undefined, []]) {
      const p = await boot(none);
      assert.equal(p.pill().hidden, true, JSON.stringify(none));
      assert.equal(p.pill().textContent, "");
      assert.equal(p.group().hidden, true);
      assert.equal(p.group().textContent, "");
    }
  });
  it("opens the Details panel at its Issues group; the stage draws no issues disclosure", async () => {
    const p = await boot(TWO);
    assert.equal(p.byId("detpanel").hidden, true);
    p.pill().click();
    assert.equal(p.byId("detpanel").hidden, false, "Details opens");
    assert.equal(p.group().hidden, false);
    assert.ok(p.group().scrolled.length > 0, "the panel is scrolled to the Issues group");
    assert.match(p.group().textContent, /Ledger!F12: The total no longer matches the rows above\./);
    assert.match(p.group().textContent, /Ledger!A1: \(before\) Already broken before\./);
    assert.ok(!p.byId("extras").descendants().some((n) => n.tag === "details" || n.tag === "button"), "no disclosure or button in the stage");
  });
  it("the Issues group's Copy fix prompt is built from the now-side issues only", async () => {
    const p = await boot(TWO);
    const btn = p.group().descendants().find((n) => n.tag === "button")!;
    assert.equal(btn.textContent, "Copy fix prompt");
    btn.click(); await new Promise((r) => setTimeout(r, 10));
    assert.equal(p.copied.length, 1);
    assert.ok(p.copied[0]!.includes("- Ledger!F12: The total no longer matches the rows above."));
    assert.ok(!p.copied[0]!.includes("Already broken before."));
    const only = await boot([TWO[1]]);
    assert.equal(only.pill().textContent, "1 issue");
    assert.equal(only.group().descendants().filter((n) => n.tag === "button").length, 0, "no prompt from before-side issues alone");
  });
});
