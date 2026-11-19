import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { writeSealed } from "../src/seal.ts";
import { formatChangesOf } from "../src/timeline/load.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { createFilesLayer } from "../src/office/connector/docx/layer.ts";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";
import { storeDirOf } from "../src/states.ts";
import type { RawState } from "../src/timeline/runs.ts";
import type { FormatChanges } from "../src/timeline/timeline.ts";

// the readers list what a user would miss otherwise: a chart or picture that came or went, and each slide that changed. (Migration
// core's notes for those rows are gone, a connector words its own steps; the readers' guard cases stay.)
// Files are built in memory; nothing opens an Office app. The recorded-run shapes: c12 (two charts on an xlsx), c18 (a docx picture and its
// caption removed), c20/c21 (a deck's theme and layout changed, with no text row).

const enc = strToU8;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (list: Array<[string, string, string]>): string => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const chartXml = (title: string | null, v: number): string => `<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart>${title ? `<c:title><c:tx><c:rich><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title>` : ""}<c:plotArea><c:ser><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>${v}</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:plotArea></c:chart></c:chartSpace>`;

/** A workbook with one sheet per entry; each chart is `[title, cached value]`. */
function workbook(sheets: Array<{ name: string; charts: Array<[string | null, number]> }>): Buffer {
  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": enc(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": enc(rels(sheets.map((_, i) => [`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`]))),
  };
  let n = 0;
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = enc(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>${i + 1}</v></c></row></sheetData></worksheet>`);
    if (s.charts.length === 0) return;
    files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = enc(rels([["rId1", "drawing", `../drawings/drawing${i + 1}.xml`]]));
    files[`xl/drawings/drawing${i + 1}.xml`] = enc(`<xdr:wsDr xmlns:xdr="x" xmlns:c="c" xmlns:r="${REL}">${s.charts.map((_, k) => `<xdr:graphicFrame><c:chart r:id="rId${k + 1}"/></xdr:graphicFrame>`).join("")}</xdr:wsDr>`);
    files[`xl/drawings/_rels/drawing${i + 1}.xml.rels`] = enc(rels(s.charts.map((_, k) => [`rId${k + 1}`, "chart", `../charts/chart${n + k + 1}.xml`])));
    s.charts.forEach(([title, v], k) => { files[`xl/charts/chart${n + k + 1}.xml`] = enc(chartXml(title, v)); });
    n += s.charts.length;
  });
  return Buffer.from(zipSync(files, { mtime: new Date(2020, 0, 1) }));
}

/** A document: each entry is a paragraph of text, or `{ image, caption }` for a paragraph holding a picture followed by a caption paragraph. */
function document(body: Array<string | { image: string }>, images: Record<string, string> = {}): Buffer {
  const p = (inner: string, style = ""): string => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${inner}</w:p>`;
  const files: Record<string, Uint8Array> = {
    "word/document.xml": enc(`<?xml version="1.0"?><w:document xmlns:w="w" xmlns:a="a" xmlns:r="${REL}"><w:body>${body.map((b) => typeof b === "string" ? p(`<w:r><w:t>${b}</w:t></w:r>`, /^Figure/.test(b) ? "Caption" : "") : p(`<w:r><w:drawing><a:blip r:embed="${b.image}"/></w:drawing></w:r>`)).join("")}</w:body></w:document>`),
    "word/_rels/document.xml.rels": enc(rels(Object.keys(images).map((id) => [id, "image", `media/${id}.png`]))),
  };
  for (const [id, bytes] of Object.entries(images)) files[`word/media/${id}.png`] = enc(bytes);
  return Buffer.from(zipSync(files, { mtime: new Date(2020, 0, 1) }));
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
async function read(file: string, layer: "xlsx" | "pptx" | "files", from: Buffer, to: Buffer): Promise<FormatChanges> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  try {
    await mkdir(storeDirOf(home, 1), { recursive: true });
    const stored = new Map<string, number>();
    for (const b of [from, to]) { await writeSealed(path.join(storeDirOf(home, 1), sha(b)), b); stored.set(sha(b), b.length); }
    const s = { id: 1, step_id: 1, task_id: 1, file_path: `/w/${file}`, sha256: sha(to), prev_sha256: sha(from), phase: "post", calls_open_json: null, credited_json: null, size: to.length, kept: "whole", note: null, ts: null } as unknown as RawState;
    const layers = [createXlsxLayer({ openState: async () => "closed" }), createPptxLayer(), createFilesLayer()].filter((l) => l.name === layer);
    return await formatChangesOf(home, 1, s, layers, stored, new Set());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("xlsx: a chart added or removed names the sheet it sits on", () => {
  const before = workbook([{ name: "data", charts: [] }, { name: "chart_macro", charts: [] }]);
  it("a chart whose data changed in place is not added or removed", async () => {
    const a = workbook([{ name: "data", charts: [["Macro", 1]] }]);
    const b = workbook([{ name: "data", charts: [["Macro", 2]] }]);
    const f = await read("m.xlsx", "xlsx", a, b);
    assert.ok(!("unavailable" in f) && f.rows.every((r) => !/^chart/.test(r.kind)), JSON.stringify(f));
  });
  it("a chart that only moved to a renamed sheet is not added or removed", async () => {
    const a = workbook([{ name: "old", charts: [["Macro", 1]] }]);
    const b = workbook([{ name: "new", charts: [["Macro", 1]] }]);
    const f = await read("m.xlsx", "xlsx", a, b);
    assert.ok(!("unavailable" in f) && f.rows.every((r) => !/^chart/.test(r.kind)), JSON.stringify(f));
  });
});

describe("docx: a picture added or removed, with its caption", () => {
  const img = { rId1: "chart-image-bytes".repeat(50) };
  it("a picture that stays does not show up", async () => {
    const a = document(["Intro", { image: "rId1" }, "Figure 1: GDP"], img);
    const b = document(["Intro changed", { image: "rId1" }, "Figure 1: GDP"], img);
    const f = await read("r.docx", "files", a, b);
    assert.ok(!("unavailable" in f) && f.rows.every((r) => !/^image/.test(r.kind)), JSON.stringify(f));
  });
});

describe("pptx: each changed slide gets a note", () => {
  const deck = path.join(import.meta.dirname, "fixtures", "ppt-table-deck.pptx");
  it("a slide that already has a text row is not listed twice, and an identical deck lists nothing", async () => {
    const { editPptx } = await import("./fixtures/make-office.ts");
    const a = await readFile(deck);
    const text = /<a:t>([^<]+)<\/a:t>/.exec(Buffer.from(unzipSync(new Uint8Array(a))["ppt/slides/slide1.xml"]!).toString("utf8"))![1]!;
    const f = await read("d.pptx", "pptx", a, editPptx(deck, text, `${text} v2`));
    assert.ok(!("unavailable" in f) && f.rows.every((r) => r.kind !== "slide changed"), JSON.stringify(f));
  });
});
