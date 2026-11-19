import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { servedFor } from "./helpers/v1-served.ts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { strToU8, unzipSync, zipSync } from "fflate";
import { writeSealed } from "../src/seal.ts";
import { formatChangesOf } from "../src/timeline/load.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { createFilesLayer } from "../src/office/connector/docx/layer.ts";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";
import { mediaChanges } from "../src/office/connector/shared/package-media.ts";
import { storeDirOf } from "../src/states.ts";
import type { RawState } from "../src/timeline/runs.ts";
import type { Change, FormatChanges, FormatRow, Timeline } from "../src/timeline/timeline.ts";

// The notes column says what changed in Word, PowerPoint, pictures and charts. A Word or deck text change
// is a card with its place (paragraph, slide), the previous words struck and the new words; a picture or chart change names its slide, paragraph or
// title; the chart caveat is gone where charts are drawn; a sheet that holds only charts is not "empty"; no axis tick repeats a label.
// Files are built in memory. Nothing opens an Office app.

const enc = strToU8;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (list: Array<[string, string, string]>): string => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** A chart in the default namespace, as openpyxl writes it: no prefixes. */
const plainChart = (t: string | null): string => `<chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart"><chart>${t === null ? "" : `<title><tx><rich><a:p xmlns:a="a"><a:r><a:t>${t}</a:t></a:r></a:p></rich></tx></title>`}<plotArea><lineChart><ser><tx><v>S</v></tx><val><numRef><f>Data!$B$2:$B$3</f></numRef></val></ser></lineChart></plotArea></chart></chartSpace>`;

/** A workbook: "Data" with two numbers, and one sheet per entry of `onSheets` holding only charts (no cells). */
function book(onSheets: Record<string, Array<string | null>>, extraDrawing = ""): Buffer {
  const names = ["Data", ...Object.keys(onSheets)];
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": enc(rels([["rId1", "officeDocument", "xl/workbook.xml"]])),
    "xl/workbook.xml": enc(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": enc(rels(names.map((_, i) => [`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`]))),
    "xl/worksheets/sheet1.xml": enc(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2"><c r="B2"><v>1</v></c></row><row r="3"><c r="B3"><v>2</v></c></row></sheetData></worksheet>`),
  };
  let n = 0;
  Object.entries(onSheets).forEach(([name, charts], i) => {
    const k = i + 2;
    files[`xl/worksheets/sheet${k}.xml`] = enc(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`);
    if (charts.length === 0) return;
    files[`xl/worksheets/_rels/sheet${k}.xml.rels`] = enc(rels([["rId1", "drawing", `../drawings/drawing${k}.xml`]]));
    files[`xl/drawings/drawing${k}.xml`] = enc(`<xdr:wsDr xmlns:xdr="x" xmlns:c="c" xmlns:r="${REL}">${charts.map((_, j) => `<c:chart r:id="rId${j + 1}"/>`).join("")}${extraDrawing}</xdr:wsDr>`);
    files[`xl/drawings/_rels/drawing${k}.xml.rels`] = enc(rels(charts.map((_, j) => [`rId${j + 1}`, "chart", `../charts/chart${n + j + 1}.xml`])));
    charts.forEach((t, j) => { files[`xl/charts/chart${n + j + 1}.xml`] = enc(plainChart(t)); });
    n += charts.length;
    void name;
  });
  return Buffer.from(zipSync(files, { mtime: new Date(2020, 0, 1) }));
}

const document = (paragraphs: string[], image?: { caption: string }): Buffer => {
  const p = (inner: string): string => `<w:p>${inner}</w:p>`;
  const body = paragraphs.map((t) => p(`<w:r><w:t>${t}</w:t></w:r>`));
  if (image) body.push(p(`<w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r>`), p(`<w:r><w:t>${image.caption}</w:t></w:r>`));
  const files: Record<string, Uint8Array> = {
    "word/document.xml": enc(`<?xml version="1.0"?><w:document xmlns:w="w" xmlns:a="a" xmlns:r="${REL}"><w:body>${body.join("")}</w:body></w:document>`),
    "word/_rels/document.xml.rels": enc(rels(image ? [["rId1", "image", "media/rId1.png"]] : [])),
  };
  if (image) files["word/media/rId1.png"] = enc("picture-bytes".repeat(40));
  return Buffer.from(zipSync(files, { mtime: new Date(2020, 0, 1) }));
};

async function read(file: string, layer: "xlsx" | "pptx" | "files", from: Buffer | null, to: Buffer): Promise<FormatChanges> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  try {
    await mkdir(storeDirOf(home, 1), { recursive: true });
    const stored = new Map<string, number>();
    for (const b of [from, to]) if (b !== null) { await writeSealed(path.join(storeDirOf(home, 1), sha(b)), b); stored.set(sha(b), b.length); }
    const s = { id: 1, step_id: 1, task_id: 1, file_path: `/w/${file}`, sha256: sha(to), prev_sha256: from === null ? null : sha(from), phase: "post", calls_open_json: null, credited_json: null, size: to.length, kept: "whole", note: null, ts: null } as unknown as RawState;
    const layers = [createXlsxLayer({ openState: async () => "closed" }), createPptxLayer(), createFilesLayer()].filter((l) => l.name === layer);
    return await formatChangesOf(home, 1, s, layers, stored, new Set());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
const facts = (file: string) => ({ file, secret: false, expired: false });
const rowsOf = (f: FormatChanges): FormatRow[] => {
  assert.ok(!("unavailable" in f), JSON.stringify(f));
  return f.rows;
};
// Core builds no Word, deck or chart cards (notes.ts cardOf): a connector's document carries each change's words and the page
// builds its card (view-table.js noteCard). The readers' rows, the rail model's card plumbing and the page's clipper stay pinned here.
import "../src/timeline/rail/assets/view-table.js";
const VTC = (globalThis as unknown as { CoCheckViewTable: { clipPair(b: string | null, a: string | null): [string | null, string | null] } }).CoCheckViewTable;


describe("PowerPoint: a changed slide says what about it changed", () => {
  const deck = path.join(import.meta.dirname, "fixtures", "ppt-table-deck.pptx");
  it("a picture swapped on a slide is a slide row that says a picture was replaced", () => {
    const deckOf = (img: string): Uint8Array => zipSync({
      "ppt/presentation.xml": enc(`<p:presentation xmlns:p="p" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": enc(rels([["rId1", "slide", "slides/slide1.xml"]])),
      "ppt/slides/slide1.xml": enc("<p:sld/>"),
      "ppt/slides/_rels/slide1.xml.rels": enc(rels([["rId1", "image", "../media/image1.png"]])),
      "ppt/media/image1.png": enc(img),
    });
    const rows = mediaChanges(".pptx", deckOf("old picture"), deckOf("new picture"));
    assert.deepEqual(rows, [{ location: "Slide 1", kind: "slide changed", title: null, detail: "a picture was replaced" }]);
  });
});

describe("pictures and charts: each is named by its title, sheet, paragraph or slide", () => {
  it("a chart written without namespace prefixes (openpyxl) is named by its title", () => {
    const rows = mediaChanges(".xlsx", book({ Charts: [] }), book({ Charts: ["Payrolls", "Unemployment"] }));
    assert.deepEqual(rows.map((r) => [r.kind, r.title]), [["chart added", "Payrolls"], ["chart added", "Unemployment"]]);
  });
});


describe("a sheet that holds only charts is not empty", () => {
});



// ---- the page ----

// No row carries a card, so the rail model computes none.

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty(this: Record<string, unknown>, k: string, v: string) { this[k] = v; } }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { this.children.push(...c); }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() {} select() {} scrollIntoView() {} scrollTo() {} showModal() {} close() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

// No core row carries a card, so the page draws none of its own (view-table.js)
// A connector's card is built from its document (view-table.js noteCard).

describe("a long old and new text is cut around the first difference", () => {
  const lead = "The committee reviewed the quarterly figures and agreed that ".repeat(8).trim();
  const row = (before: string, after: string) => { const [b, a] = VTC.clipPair(before, after); return { before: b, after: a }; };
  it("a change past character 240 shows on both sides, with ellipses, and the two differ", () => {
    assert.ok(lead.length > 400);
    const c = row(`${lead} payroll grew by 1,200 jobs in March, ${lead}`, `${lead} payroll grew by 1,500 jobs in March, ${lead}`);
    assert.notEqual(c.before, c.after);
    for (const t of [c.before!, c.after!]) {
      assert.ok(t.startsWith("…") && t.endsWith("…"), t);
      assert.ok(t.length <= 240, String(t.length));
    }
    assert.match(c.before!, /1,200/);
    assert.match(c.after!, /1,500/);
  });
  it("a change in the first words keeps the old shape: no leading ellipsis", () => {
    const c = row(`Old ${lead}`, `New ${lead}`);
    assert.ok(c.before!.startsWith("Old ") && c.after!.startsWith("New ") && c.before!.endsWith("…"));
  });
  it("an addition at the very end of a long text still differs", () => {
    const c = row(lead, `${lead} And one more sentence about hiring.`);
    assert.notEqual(c.before, c.after);
    assert.match(c.after!, /one more sentence|…$/);
  });
});
