import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readFile as rf } from "node:fs/promises";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { checkStructure, PLAIN_RULES, type StructureFinding } from "../src/office/connector/shared/structure-check.ts";
import { structureIssues } from "../src/office/connector/issues.ts";
import { stopIdentities, summarize } from "../src/timeline/rail/stop-status.ts";
import { buildSendBack } from "../src/timeline/rail/send-back.ts";

// Structure issues in plain words with a copy-ready fix prompt. (1) every rule has a plain sentence and fix, none with an element name, a part
// path or a rule id; migration X1: the connectors' issues carry those sentences, likely-repair only. (2) the page: the step's issues (any connector)
// give "Copy fix prompt" in the Details panel; (3) a failed step's send-back carries its issues, an unfailed step sends nothing; a clean, tolerated or
// unchecked file shows no new text.

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



const FIX = path.join(import.meta.dirname, "fixtures");
const deck = (): Uint8Array => new Uint8Array(readFileSync(path.join(FIX, "structure/broken-chart.pptx")));
const ELEMENTS = ["invertIfNegative", "numCache", "numLit", "prstDash", "sldId", "numId", "abstractNumId", "bodyPr", "legendPos", "dLblPos", "scatterStyle", "crossBetween", "Content_Types", "Relationship"];
/** Why a visible line is not plain, or null. */
function jargon(t: string): string | null {
  if (/[<>]/.test(t)) return "markup";
  if (/\b(ppt|xl|word|docProps|_rels|customXml)\//.test(t) || /\.rels\b|\.xml\b/.test(t)) return "part path";
  if (/\b[a-z]{1,4}:[A-Za-z]+\b/.test(t)) return "prefixed element";
  for (const e of ELEMENTS) if (t.includes(e)) return `element ${e}`;
  for (const r of Object.keys(PLAIN_RULES)) if (new RegExp(`(^|[^\\w-])${r}($|[^\\w-])`).test(t)) return `rule id ${r}`;
  return null;
}

describe("every rule is in plain words", () => {
  it("the table covers exactly the rules the checker can raise, so a new rule without a plain sentence fails", () => {
    const src = readFileSync(path.join(import.meta.dirname, "../src/office/connector/shared/structure-check.ts"), "utf8");
    const raised = new Set([...src.slice(0, src.indexOf("// ---- wording for the page ----")).matchAll(/rule: "([a-z-]+)"/g)].map((m) => m[1]!));
    assert.ok(raised.size >= 15, [...raised].join());
    assert.deepEqual([...raised].sort(), Object.keys(PLAIN_RULES).sort());
  });

  it("each rule gives a plain detail, sentence and fix for every place shape, with technical input", () => {
    const places: Array<[string | null, string]> = [["slide 5", "chart"], [null, "package"], [null, "presentation"], [null, "workbook"], [null, "styles"], [null, "numbering"], ['sheet "Data"', "sheet"], ["the document", "document"], ["slide 2", "slide"]];
    for (const rule of Object.keys(PLAIN_RULES)) for (const [where, subject] of places) for (const app of ["PowerPoint", "Excel", "Word"] as const) {
      const f: StructureFinding = { severity: "likely-repair", rule, part: "ppt/charts/chart3.xml", where, subject, detail: "23 empty values", sentence: `ppt/charts/chart3.xml uses ${rule} with invertIfNegative <c:v>` };
      const p = PLAIN_RULES[rule]!(f, app);
      for (const [k, t] of Object.entries(p)) { assert.ok(t.length > 10, `${rule} ${k}`); assert.equal(jargon(t), null, `${rule} ${k}: ${t}`); }
    }
  });

  it("the real broken-chart deck: the connector's issues are the plain sentences of its likely-repair findings, at slide 5", () => {
    const issues = structureIssues(deck(), "deck.pptx");
    assert.ok(issues.length >= 2, JSON.stringify(issues));
    for (const x of issues) { assert.equal(jargon(x.text), null, x.text); assert.equal(x.where, "slide 5"); assert.equal(x.side, "after"); }
    assert.ok(checkStructure(deck(), "deck.pptx")!.findings.some((f) => /invertIfNegative|ppt\/charts/.test(f.sentence)), "the technical sentence stays on the finding");
  });

  it("a clean file, a tolerated-only result and an unreadable file give no issues", () => {
    assert.deepEqual(structureIssues(new Uint8Array(readFileSync(path.join(FIX, "memo-aptos.docx"))), "m.docx"), []);
    assert.deepEqual(structureIssues(new Uint8Array(readFileSync(path.join(FIX, "long-html-deck-v3.pptx"))), "d.pptx"), []);
    assert.deepEqual(structureIssues(new Uint8Array([1, 2, 3]), "x.xlsx"), []);
    assert.deepEqual(structureIssues(null, "x.xlsx"), []);
  });
});

// ---- (2) the page ----

const RC = { key: "k1", file: "decks/deck.pptx", kind: "modified", note: "Changed deck.pptx.", rowNotes: [], moreNote: null, viewUrl: "/timeline/7/view/k1", secret: false, secretLine: null, failed: null, ask: null, newFile: null };
async function boot(issues: unknown) {
  const VIEW = { change: "k1", file: "deck.pptx", engine: "", kind: "card", before: [], after: [], boxes: [], caveats: [], ...(issues === undefined ? {} : { issues }) };
  const model: any = { task: 7, folder: "work", actors: [{ id: "main", name: "Claude", chip: "C", color: "#123456" }], stops: [{ id: "chg-k1", label: "deck.pptx", lane: "main", head: "Claude changed deck.pptx", change: RC }] };
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
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
  const box = byId("detissues");
  const visible = (n: N): string => (n.className.split(/\s+/).includes("stech") ? "" : n._text + n.children.map(visible).join(""));
  return { box, pill: byId("hissues"), copied, visible: () => visible(box), all: () => box.descendants() };
}
const issuesOf = () => structureIssues(deck(), "deck.pptx");

describe("(2), migration X1: the page makes the fix prompt from the step's issues, for any connector", () => {
  it("a step with issues: the header pill counts them, Details lists them, and the button copies a plain prompt naming the file and each issue", async () => {
    const issues = issuesOf();
    const p = await boot(issues);
    assert.equal(p.box.hidden, false);
    assert.equal(p.pill.textContent, `${issues.length} issues`);
    const btn = p.all().find((n) => n.tag === "button")!;
    assert.equal(btn.textContent, "Copy fix prompt");
    btn.click(); await new Promise((r) => setTimeout(r, 10));
    assert.equal(p.copied.length, 1);
    const prompt = p.copied[0]!;
    assert.match(prompt, /"deck\.pptx"/);
    assert.ok(!prompt.includes("decks/"), "the bare file name, not the path");
    for (const x of issues) assert.ok(prompt.includes(`- slide 5: ${x.text}`), x.text);
    assert.equal(jargon(prompt), null, prompt);
  });

  it("an installed connector's issues work the same; a before-side issue is listed but not put in the prompt", async () => {
    const p = await boot([{ text: "The total no longer matches the rows above.", where: "Ledger!F12" }, { text: "Already broken before.", side: "before", where: "Ledger!A1" }]);
    p.all().find((n) => n.tag === "button")!.click(); await new Promise((r) => setTimeout(r, 10));
    assert.ok(p.copied[0]!.includes("- Ledger!F12: The total no longer matches the rows above."));
    assert.ok(!p.copied[0]!.includes("Already broken before."));
    const only = await boot([{ text: "Already broken before.", side: "before" }]);
    assert.equal(only.all().filter((n) => n.tag === "button").length, 0);
  });

  it("a step with no issues (clean, tolerated only, or never checked) shows nothing and has no button", async () => {
    for (const none of [undefined, []]) {
      const p = await boot(none);
      assert.equal(p.box.hidden, true);
      assert.equal(p.box.textContent, "");
      assert.equal(p.all().filter((n) => n.tag === "button").length, 0);
    }
  });
});

// ---- (3) the send-back ----

function sendFixture(issues: unknown, verdict: "failed" | "passed" | null) {
  const c: any = { id: "c1", file: "/work/deck.pptx", kind: "modified", before: { sha256: "b" }, after: { sha256: "a" }, note: { text: "Changed deck.pptx.", source: "rule" }, format: null, ...(issues === undefined ? {} : { diff: { spec: "cocheck.diff/1", subject: "deck.pptx", connector: "microsoft-powerpoint", producer: "connector", before: { ref: "b" }, after: { ref: "a" }, changes: [], caveats: [], issues } }) };
  const timeline: any = { unplaced: [c], requests: [] };
  const model: any = { task: 7, folder: "/work", actors: [], stops: [{ id: "chg-c1", label: "deck.pptx", head: "Claude changed /work/deck.pptx", lane: "main", change: { key: "c1", file: c.file, kind: "modified", note: "Changed deck.pptx.", rowNotes: [], secret: false } }] };
  const ids = stopIdentities(model, timeline);
  const rows = verdict === null ? [] : [{ id: 1, taskId: 7, stopId: "chg-c1", subject: ids.get("chg-c1")!.subject, fingerprint: ids.get("chg-c1")!.fingerprint, status: verdict, note: "The chart is wrong.", reviewer: "t", ts: "2026-10-12T00:00:00.000Z" }];
  return { model, timeline, summary: summarize(model, timeline, rows) };
}

describe("(3), migration X1: the send-back carries the step's issues, for any connector", () => {
  it("a failed step whose file has issues carries each one, where first", () => {
    const issues = issuesOf();
    const f = sendFixture(issues, "failed");
    const { prompt } = buildSendBack(f.model, f.timeline, f.summary);
    for (const x of issues) assert.ok(prompt.includes(`Issue: slide 5: ${x.text}`), x.text);
    assert.ok(prompt.includes("The chart is wrong."));
    for (const l of prompt.split("\n").filter((x) => x.includes("Issue: "))) assert.equal(jargon(l), null, l);
  });

  it("an installed connector's issue is carried too; outside words are capped", () => {
    const f = sendFixture([{ text: "x".repeat(400), where: "Ledger!F12" }, ...Array.from({ length: 60 }, (_, i) => ({ text: `issue ${i}` }))], "failed");
    const lines = buildSendBack(f.model, f.timeline, f.summary).prompt.split("\n").filter((x) => x.includes("Issue: "));
    assert.equal(lines.length, 51);
    assert.ok(lines[0]!.startsWith("   Issue: Ledger!F12: xxx") && lines[0]!.length <= "   Issue: ".length + 300, lines[0]);
    assert.equal(lines[50], "   Issue: and 11 more issues");
  });

  it("a failed file with no issues (clean, tolerated only, never checked) adds no issue line, and a passed or unjudged step sends nothing", () => {
    for (const s of [[], undefined]) {
      const f = sendFixture(s, "failed");
      assert.ok(!buildSendBack(f.model, f.timeline, f.summary).prompt.includes("Issue: "));
    }
    for (const v of ["passed", null] as const) {
      const f = sendFixture(issuesOf(), v);
      assert.throws(() => buildSendBack(f.model, f.timeline, f.summary), /nothing to send back/);
    }
  });
});
