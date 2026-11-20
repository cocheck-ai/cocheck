// The Copilot run's workbook: (1) the file-level signal: a chart axis that crosses an axis the chart does not have is a likely-repair structure finding (live
// bisect: either dangling crossAx alone makes Excel show "We found a problem with some content"; both pointing at the other axis removes the prompt); (2) the page: a connector
// status of kind "prompt" or "refused" (the app would not open the file) is shown as a finding above the pictures, not only inside "About this view"; other kinds are not.
import assert from "node:assert/strict";
import { readFile as rf } from "node:fs/promises";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { checkStructure } from "../src/office/connector/shared/structure-check.ts";
import { structureIssues } from "../src/office/connector/issues.ts";

const CT = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`;
/** openpyxl's line chart with a DateAxis, as the Copilot run wrote it: the date axis (500) and the value axis (100), each with its own crossAx. */
const chart = (dateCross: string, valCross: string, prefix = ""): string => {
  const p = prefix === "" ? "" : `${prefix}:`;
  return `<${p}chartSpace xmlns${prefix === "" ? "" : `:${prefix}`}="http://schemas.openxmlformats.org/drawingml/2006/chart"><${p}chart><${p}plotArea><${p}lineChart><${p}grouping val="standard"/><${p}axId val="500"/><${p}axId val="100"/></${p}lineChart>` +
    `<${p}dateAx><${p}axId val="500"/><${p}scaling><${p}orientation val="minMax"/></${p}scaling><${p}axPos val="l"/><${p}crossAx val="${dateCross}"/></${p}dateAx>` +
    `<${p}valAx><${p}axId val="100"/><${p}scaling><${p}orientation val="minMax"/></${p}scaling><${p}axPos val="l"/><${p}crossAx val="${valCross}"/></${p}valAx></${p}plotArea></${p}chart></${p}chartSpace>`;
};
const book = (chartXml: string): Uint8Array => zipSync({
  "[Content_Types].xml": strToU8(CT),
  "_rels/.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
  "xl/workbook.xml": strToU8(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Charts" sheetId="1" r:id="rId1"/></sheets></workbook>`),
  "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
  "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData/><drawing r:id="rId1"/></worksheet>`),
  "xl/worksheets/_rels/sheet1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="/xl/drawings/drawing1.xml"/></Relationships>`),
  "xl/drawings/drawing1.xml": strToU8(`<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>`),
  "xl/drawings/_rels/drawing1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="/xl/charts/chart1.xml"/></Relationships>`),
  "xl/charts/chart1.xml": strToU8(chartXml),
});
const axisFindings = (b: Uint8Array) => checkStructure(b, "book.xlsx")!.findings.filter((f) => f.rule === "chart-axis-crossref");

describe("structure check: an axis that crosses an axis the chart does not have", () => {
  it("the Copilot run's chart (date axis crosses 102, value axis crosses 10, the chart has 500 and 100): a likely-repair finding on the Charts sheet", () => {
    const f = axisFindings(book(chart("102", "10")));
    assert.equal(f.length, 1);
    assert.equal(f[0]!.severity, "likely-repair");
    assert.equal(f[0]!.where, 'sheet "Charts"');
    assert.match(f[0]!.sentence, /axis 500 crossing axis 102 and axis 100 crossing axis 10/);
    // the Excel connector's issue for it, at the sheet
    assert.deepEqual(structureIssues(book(chart("102", "10")), "fred.xlsx"), [{ text: 'sheet "Charts" chart has an axis tied to an axis that does not exist, and Excel will likely ask to repair that.', side: "after", where: 'sheet "Charts"' }]);
  });
  it("either dangling crossAx alone is a finding (each was enough for Excel's prompt in the bisect), also with a namespace prefix", () => {
    assert.equal(axisFindings(book(chart("100", "10"))).length, 1);
    assert.equal(axisFindings(book(chart("102", "500"))).length, 1);
    assert.equal(axisFindings(book(chart("100", "10", "c"))).length, 1);
  });
  it("axes that cross each other (the minimal edit that removed the prompt) give no finding", () => {
    assert.deepEqual(axisFindings(book(chart("100", "500"))), []);
    assert.deepEqual(axisFindings(book(chart("100", "500", "c"))), []);
  });
});

describe("review the chart rule never fires on valid XML (damaged-chart cases)", () => {
  const NS = `xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"`;
  const wrap = (inner: string): string => `<c:chartSpace ${NS}><c:chart><c:plotArea>${inner}</c:plotArea></c:chart></c:chartSpace>`;
  const ax = (t: string, id: string, cross: string): string => `<c:${t}><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/></c:${t}>`;
  const ok: Record<string, string> = {
    "single-quoted crossAx": wrap(ax("catAx", "1", "2") + ax("valAx", "2", "1").replace(`crossAx val="1"`, `crossAx val='1'`)),
    "single-quoted axId": wrap(ax("catAx", "1", "2") + ax("valAx", "2", "1").replace(`axId val="2"`, `axId val='2'`)),
    "spaces around =": wrap(ax("catAx", "1", "2") + ax("valAx", "2", "1").replace(`axId val="2"`, `axId val = "2"`)),
    "an axis with no crossAx": wrap(ax("catAx", "1", "2") + ax("valAx", "2", "1").replace(`<c:crossAx val="1"/>`, "")),
    "leading zero": wrap(ax("catAx", "1", "02") + ax("valAx", "2", "1")),
    "3d with serAx": wrap(ax("catAx", "1", "2") + ax("valAx", "2", "1") + ax("serAx", "3", "2")),
    "combo secondary axes": wrap(ax("catAx", "1", "2") + ax("valAx", "2", "1") + ax("valAx", "4", "3") + ax("catAx", "3", "4")),
  };
  for (const [name, xml] of Object.entries(ok)) it(`${name}: no finding`, () => assert.deepEqual(axisFindings(book(xml)), []));
  it("a real dangling crossAx still fires", () => assert.equal(axisFindings(book(wrap(ax("catAx", "1", "9") + ax("valAx", "2", "1")))).length, 1));
  it("restricted to Excel: the same chart in a Word or PowerPoint package is not judged; the plain sentence says 'likely'", () => {
    const deck = zipSync({ "[Content_Types].xml": strToU8(CT.replace("/xl/charts/chart1.xml", "/ppt/charts/chart1.xml")), "ppt/charts/chart1.xml": strToU8(chart("102", "10")) });
    assert.deepEqual((checkStructure(deck, "d.pptx")?.findings ?? []).filter((f) => f.rule === "chart-axis-crossref"), []);
    const issues = structureIssues(book(chart("102", "10")), "fred.xlsx");
    assert.ok(issues.length > 0 && issues.every((l) => /will likely ask to repair/.test(l.text)), JSON.stringify(issues));
  });
});

// ---- the page ----

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {}, removeProperty() {} }; dataset = {}; _text = ""; nodeType = 1;
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  focus() {}
  scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

const RC = { key: "k1", file: "fred.xlsx", kind: "modified", note: "Changed fred.xlsx.", rowNotes: [], moreNote: null, viewUrl: "/timeline/7/view/k1", secret: false, secretLine: null, failed: null, ask: null, newFile: null };
async function boot(status: unknown, pictures?: unknown[]): Promise<{ finding: N; caveats: N }> {
  const view = { change: "k1", file: "fred.xlsx", engine: "", kind: "card", before: [], after: [], boxes: [], caveats: ["After: Microsoft Excel stopped at a question before opening this workbook (such as a repair, sign-in or update prompt); CoCheck never answers those, so it is not pictured."], ...(status === undefined ? {} : { status }), ...(pictures === undefined ? {} : { pictures }) };
  const model = { task: 7, folder: "work", actors: [{ id: "main", name: "Copilot", chip: "G", color: "#123456" }], stops: [{ id: "chg-k1", label: "fred.xlsx", lane: "main", head: "Copilot changed fred.xlsx", change: RC }] };
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement: mkNode(), activeElement: null };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    addEventListener() {}, setInterval, clearInterval, setTimeout: (f: () => void) => { if (f.name === "poll") return 0; return 1; },
    fetch: async (u: string) => ({ ok: true, status: 200, json: async () => (u.includes("/review/model") ? JSON.parse(JSON.stringify(model)) : u.includes("/view/") ? JSON.parse(JSON.stringify(view)) : {}) }) };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await rf(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 30));
  return { finding: byId("finding"), caveats: byId("caveats") };
}

describe("the page: the app's refusal of the file is a finding on the change", () => {
  const evidence = "After: Microsoft Excel stopped at a question before opening this workbook (such as a repair, sign-in or update prompt); CoCheck never answers those, so it is not pictured.";
  it("status prompt: one plain line above the pictures, the connector's own words, outside About this view", async () => {
    const p = await boot({ kind: "prompt", evidence });
    assert.equal(p.finding.hidden, false);
    assert.equal(p.finding.textContent, evidence);
  });
  it("status refused is shown the same way", async () => {
    const p = await boot({ kind: "refused", evidence: "After: Microsoft Word did not open this document." });
    assert.equal(p.finding.hidden, false);
    assert.equal(p.finding.textContent, "After: Microsoft Word did not open this document.");
  });
  it("spec v1.1: the status on a stand-in picture (no src) for the side that was not opened is shown the same way, and the stand-in is never a pane", async () => {
    const p = await boot(undefined, [{ id: "after:not-opened", side: "after", type: "image", label: "After: not opened", status: { kind: "prompt", evidence } }]);
    assert.equal(p.finding.hidden, false);
    assert.equal(p.finding.textContent, evidence);
  });
  it("the finding sits before the change cards in the page (it reads first on the card-only view too)", async () => {
    const page = readFileSync(new URL("../src/timeline/rail/page.ts", import.meta.url), "utf8");
    assert.ok(page.indexOf('id="finding"') >= 0 && page.indexOf('id="finding"') < page.indexOf('id="bodyview"'));
  });
  it("no status, or a status about the drawing (hang, unavailable), adds no finding", async () => {
    for (const st of [undefined, { kind: "hang", evidence: "Microsoft Excel stopped answering on this workbook and was stopped" }, { kind: "unavailable", evidence: "x" }]) {
      const p = await boot(st);
      assert.equal(p.finding.hidden, true, JSON.stringify(st));
      assert.equal(p.finding.textContent, "");
    }
  });
});

describe("final pass: the pane of a side the app would not open never says the file is empty", () => {
  const VT = (() => { const g: Record<string, unknown> = {}; g.globalThis = g; vm.runInContext(readFileSync(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url), "utf8"), vm.createContext(g)); return g.CoCheckViewTable as { sceneOf: (d: unknown) => unknown; emptyPaneText: (s: unknown, side: string) => string } })();
  const evidence = "After: Microsoft Excel stopped at a question before opening this workbook (such as a repair, sign-in or update prompt); CoCheck never answers those, so it is not pictured.";
  const doc = { kind: "grid", caveats: [evidence], pictures: [{ id: "before:g1:0", side: "before", type: "image", label: "Before - Charts!A1:O40", src: "cpic/" + "a".repeat(64), width: 10, height: 10 }, { id: "after:not-opened", side: "after", type: "image", label: "After: not opened", status: { kind: "prompt", evidence } }] };
  it("a prompt on the after side: its empty pane says it was not pictured because of the prompt, not 'There is nothing here'", () => {
    const s = VT.sceneOf(doc);
    assert.equal(VT.emptyPaneText(s, "after"), "Not pictured: the app stopped at a question before opening this file (such as a repair, sign-in or update prompt); CoCheck never answers those.");
  });
  it("refused: the pane says the app did not open it", () => {
    const d = JSON.parse(JSON.stringify(doc)); d.pictures[1].status = { kind: "refused", evidence: "After: Microsoft Word did not open this document." };
    assert.equal(VT.emptyPaneText(VT.sceneOf(d), "after"), "Not pictured: the app did not open this file.");
  });
  it("an ordinary empty side keeps its words (a deleted after, a created before)", () => {
    const s = VT.sceneOf({ kind: "grid", caveats: [], pictures: [] });
    assert.equal(VT.emptyPaneText(s, "after"), "Deleted"); // copy (critique F11): one word, not a sentence
    assert.equal(VT.emptyPaneText(s, "before"), "New");
  });
});
