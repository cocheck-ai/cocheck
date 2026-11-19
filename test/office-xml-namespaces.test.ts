import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";
import { readWorkbook } from "../src/office/connector/excel/workbook.ts";
import { preflight } from "../src/office/connector/shared/preflight.ts";
import { respell } from "./respell-ooxml.ts";
import { readDocxModel, readDocxParagraphs } from "../src/office/connector/docx/reader.ts";
import { mediaChanges } from "../src/office/connector/shared/package-media.ts";
import { checkStructure } from "../src/office/connector/shared/structure-check.ts";
import { readDeck } from "../src/office/connector/pptx/reader.ts";
import { readShapeTag } from "../src/office/connector/pptx/tags.ts";
import { tagShape } from "../scripts/lib/pptx-tags.ts";
import { startTags } from "../src/office/connector/shared/ooxml-names.ts";
import { comparable } from "../src/office/connector/xlsx/layer.ts";

// Office XML is read by namespace URI and local name, never by the prefix, quote style, attribute order or declaration site a writer chose.
// The Codex workbook is a real file: artifact-tool writes `x:workbook`, `x:sheet` ... with `xmlns:r` repeated on every `x:sheet`, and a BOM on the rels.
const FX = path.join(import.meta.dirname, "fixtures");
const codex = readFileSync(path.join(FX, "xlsx-prefixed-codex-series.xlsx"));
const unprefixed = readFileSync(path.join(FX, "excel-region", "created-after.xlsx"));
const parts = (b: Uint8Array): Record<string, Uint8Array> => unzipSync(new Uint8Array(b));
const text = (b: Uint8Array, name: string): string => strFromU8(parts(b)[name]!);
const pack = (z: Record<string, Uint8Array>): Buffer => Buffer.from(zipSync(z as Zippable));
const edit = (b: Uint8Array, name: string, f: (s: string) => string): Buffer => { const z = parts(b); z[name] = strToU8(f(strFromU8(z[name]!))); return pack(z); };

describe("the Codex workbook (x: on every tag, xmlns:r on each x:sheet)", () => {
});

// ---- the same three-sheet workbook in many spellings -------------------------------------------------------------------------------------

interface Spell {
  /** Prefix of the SpreadsheetML main namespace ("" for the default namespace). */
  mp: string;
  /** Prefix of the officeDocument relationships namespace. */
  rp: string;
  strict?: boolean;
  q?: string;
  /** Declare the relationships namespace on each sheet element instead of on the root. */
  childDecl?: boolean;
  openClose?: boolean;
  bom?: boolean;
  reversed?: boolean;
  spaced?: boolean;
  /** Prefix of the package relationships namespace in the .rels part ("" for the default namespace). */
  pkg?: string;
}
const SPELLINGS: Record<string, Spell> = {
  "unprefixed": { mp: "", rp: "r" },
  "x: main, r: rel": { mp: "x", rp: "r" },
  "ns0: main, rel: relationships": { mp: "ns0", rp: "rel" },
  "relationships declared on each sheet": { mp: "x", rp: "rid", childDecl: true },
  "single quotes": { mp: "", rp: "r", q: "'" },
  "spaces around =": { mp: "x", rp: "r", spaced: true },
  "attributes in reverse order": { mp: "x", rp: "r", reversed: true },
  "open and close tags": { mp: "ns0", rp: "r", openClose: true },
  "declaration and BOM": { mp: "x", rp: "r", bom: true },
  "strict URIs": { mp: "s", rp: "o", strict: true },
  "prefixed package relationships": { mp: "", rp: "r", pkg: "pr" },
  "everything at once": { mp: "ns0", rp: "rel", strict: true, q: "'", childDecl: true, openClose: true, bom: true, reversed: true, spaced: true, pkg: "pr" },
};
const NAMES = ["Alpha", "Beta", "Gamma"];

function book(s: Spell, active = 1): Buffer {
  const q = s.q ?? '"';
  const MAIN = s.strict ? "http://purl.oclc.org/ooxml/spreadsheetml/main" : "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const REL = s.strict ? "http://purl.oclc.org/ooxml/officeDocument/relationships" : "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
  const at = (k: string, v: string): string => `${k}${s.spaced ? " = " : "="}${q}${v}${q}`;
  const el = (n: string): string => (s.mp === "" ? n : `${s.mp}:${n}`);
  const mainDecl = at(s.mp === "" ? "xmlns" : `xmlns:${s.mp}`, MAIN);
  const relDecl = at(`xmlns:${s.rp}`, REL);
  const decl = `${s.bom ? "\uFEFF" : ""}<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
  const tag = (n: string, attrs: string[], self = true): string => (self && !s.openClose ? `<${n} ${attrs.join(" ")}/>` : `<${n} ${attrs.join(" ")}></${n}>`);
  const order = (a: string[]): string[] => (s.reversed ? [...a].reverse() : a);
  const sheets = NAMES.map((name, i) => tag(el("sheet"), order([at("name", name), at("sheetId", String(i + 1)), at(`${s.rp}:id`, `rId${i + 1}`), ...(s.childDecl ? [relDecl] : [])]))).join("");
  const workbook = `${decl}<${el("workbook")} ${mainDecl}${s.childDecl ? "" : " " + relDecl}><${el("bookViews")}>${tag(el("workbookView"), order([at("activeTab", String(active)), at("firstSheet", "0")]))}</${el("bookViews")}><${el("sheets")}>${sheets}</${el("sheets")}></${el("workbook")}>`;
  const pk = s.pkg === undefined || s.pkg === "" ? "" : `${s.pkg}:`;
  const relEls = NAMES.map((_n, i) => tag(`${pk}Relationship`, order([at("Id", `rId${i + 1}`), at("Type", `${REL}/worksheet`), at("Target", `worksheets/sheet${i + 1}.xml`)]))).join("");
  const rels = `${decl}<${pk}Relationships ${at(pk === "" ? "xmlns" : `xmlns:${s.pkg}`, PKG)}>${relEls}</${pk}Relationships>`;
  const sheetPart = (viewAttrs: string[]): string => `${decl}<${el("worksheet")} ${mainDecl}><${el("sheetViews")}>${tag(el("sheetView"), order(viewAttrs))}</${el("sheetViews")}><${el("sheetData")}/></${el("worksheet")}>`;
  return pack({
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(rels),
    "xl/worksheets/sheet1.xml": strToU8(sheetPart([at("workbookViewId", "0")])),
    "xl/worksheets/sheet2.xml": strToU8(sheetPart([at("workbookViewId", "0"), at("tabSelected", "1")])),
    "xl/worksheets/sheet3.xml": strToU8(sheetPart([at("workbookViewId", "0"), at("tabSelected", "0")])),
  });
}

// ---- the readers, on a respelled copy of a real workbook -----------------------------------------------------------------------------------

/** A workbook's readable content with the byte hashes of parts left out: a respelled part has other bytes and the same meaning. */
const digest = (v: unknown): string => createHash("sha1").update(JSON.stringify(v, (k, x: unknown) => (k === "sha" || k === "xml" || k === "extras" || k === "parts" ? undefined : x instanceof Map ? [...x] : x instanceof Set ? [...x] : x))).digest("hex");
/** Same content, compared by digest: a failing deepEqual on a 350 KB sheet spends minutes drawing its diff. */
const sameContent = (got: unknown, want: unknown, what: string): void => assert.equal(digest(got), digest(want), `${what} differs after respelling`);

describe("the workbook readers read a respelled copy of a real file as the original", () => {
  for (const [label, file] of [["the Codex workbook (x: prefixed)", codex], ["an unprefixed Excel-saved workbook", unprefixed]] as const) {
    const copy = respell(new Uint8Array(file));
    it(`${label}: the snapshot reader`, () => {
      sameContent(readWorkbookSnapshot(copy), readWorkbookSnapshot(new Uint8Array(file)), "the snapshot");
    });
    it(`${label}: the connector reader`, () => {
      const a = readWorkbook(new Uint8Array(file));
      assert.ok(a.sheets.length > 0);
      sameContent(readWorkbook(copy), a, "the workbook");
    });
  }
});

describe("preflight reads prefixed relationships and fields", () => {
  const CT = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const zip = (files: Record<string, string>): Uint8Array => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  const REL = (p: string, ext = true): string => `<${p}Relationships xmlns${p ? ":" + p.slice(0, -1) : ""}="http://schemas.openxmlformats.org/package/2006/relationships"><${p}Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="file:///\\\\host\\share\\a.xlsx"${ext ? ' TargetMode="External"' : ""}/></${p}Relationships>`;
  const hints = (b: Uint8Array): string[] => preflight(b, "a.docx").hints.map((h) => h.kind).filter((k) => k !== "likely-repair");

  for (const p of ["", "rel:", "ns0:"]) {
    it(`an external relationship in a .rels part written with the prefix "${p}"`, () => {
      const b = zip({ "[Content_Types].xml": CT, "word/document.xml": `<w:document xmlns:w="${W}"><w:body/></w:document>`, "word/_rels/document.xml.rels": REL(p) });
      assert.deepEqual(hints(b), ["external-relationship"]);
    });
  }

  it("an INCLUDETEXT field whose namespace prefix is not w:", () => {
    const body = `<q:document xmlns:q="${W}"><q:body><q:p><q:fldSimple q:instr='INCLUDETEXT "C:\\\\x\\\\a.docx"'/></q:p><q:p><q:r><q:instrText>INCLUDEPICTURE "http://h/p.png"</q:instrText></q:r></q:p></q:body></q:document>`;
    const r = preflight(zip({ "[Content_Types].xml": CT, "word/document.xml": body }), "a.docx");
    assert.deepEqual(r.hints.flatMap((h) => h.targets ?? []).map((t) => t.type).sort(), ["includePicture", "includeText"]);
  });

  it("updateFields and a hidden slide, written with other prefixes", () => {
    const settings = `<s:settings xmlns:s="${W}"><s:updateFields s:val='true'/></s:settings>`;
    assert.deepEqual(hints(zip({ "[Content_Types].xml": CT, "word/document.xml": `<w:document xmlns:w="${W}"/>`, "word/settings.xml": settings })), ["update-fields"]);
    const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
    const deck = zip({ "[Content_Types].xml": CT.replace("word/document.xml", "ppt/presentation.xml"), "ppt/slides/slide1.xml": `<q:sld xmlns:q="${P}" show='0'/>` });
    assert.deepEqual(preflight(deck, "a.pptx").hints.map((h) => h.kind).filter((k) => k !== "likely-repair"), ["hidden-slides"]);
  });
});

// ---- Word, PowerPoint, charts and the structure check, on respelled copies of real files -------------------------------------------------------

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(FX, name)));
const spelled = (b: Uint8Array): Uint8Array => respell(b, { bom: true });

describe("Word files read the same when respelled", () => {
  const memo = fixture("memo-v1.docx");
  it("the paragraph and picture model", () => {
    const a = readDocxModel(memo);
    assert.ok(a.paragraphs.length > 0);
    sameContent(readDocxModel(spelled(memo)), a, "the Word card model");
  });
  it("paragraph text", () => {
    assert.deepEqual(readDocxParagraphs(spelled(memo)), readDocxParagraphs(memo));
  });
});

describe("what changed in charts and pictures does not depend on spelling", () => {
  for (const [ext, a, b] of [[".xlsx", "chart-edit-a.xlsx", "chart-edit-title.xlsx"], [".docx", "memo-v1.docx", "word-conditional-format-w16-after.docx"], [".pptx", "broken-chart-deck-v1.pptx", "broken-chart-deck-v2.pptx"]] as const) {
    it(`${a} to ${b}`, () => {
      const real = mediaChanges(ext, fixture(a), fixture(b));
      assert.ok(real.length > 0, "the pair has a change to find");
      sameContent(mediaChanges(ext, spelled(fixture(a)), spelled(fixture(b))), real, "the media changes");
    });
  }
  it("the Codex workbook's chart is found where it sits", () => {
    const found = mediaChanges(".xlsx", null, codex);
    assert.ok(found.some((c) => c.kind === "chart added"), JSON.stringify(found));
    sameContent(mediaChanges(".xlsx", null, spelled(codex)), found, "the media changes");
  });
});

describe("the structure check finds the same problems in a respelled file", () => {
  for (const f of ["structure/broken-chart.pptx", "memo-v1.docx", "chart-edit-a.xlsx"]) {
    it(f, () => {
      const real = checkStructure(fixture(f), f);
      assert.ok(real !== null);
      sameContent(checkStructure(spelled(fixture(f)), f), real, "the findings");
    });
  }
});

describe("reading a shape tag from a respelled deck", () => {
  // the tag writer went with the deck tools; old tagged decks are still read. A deck tagged as before, then respelled
  // (other prefixes, a BOM), reads the same tag value through the parser.
  it("reads the tag back through other prefixes", () => {
    const deck = fixture("ppt-table-deck.pptx");
    const shape = readDeck(deck).slides[0]!.shapes.find((s) => s.name !== "")!;
    const tagged = spelled(tagShape(deck, 1, shape.name, '{"v":1}'));
    assert.match(text(tagged, "ppt/slides/_rels/slide1.xml.rels"), /relationships\/tags["']/);
    assert.equal(readShapeTag(tagged, 1, shape.id, "COCHECK.LINKS"), '{"v":1}');
    assert.equal(readShapeTag(spelled(deck), 1, shape.id, "COCHECK.LINKS"), undefined);
  });
});

describe("save noise in the workbook part is found by namespace", () => {
  const XR = "http://schemas.microsoft.com/office/spreadsheetml/2014/revision";
  const wb = (prefix: string, guid: string): Uint8Array => strToU8(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:${prefix}="${XR}"><${prefix}:revisionPtr documentId="${guid}" revIDLastSave='0'/><sheets/></workbook>`);
  it("revisionPtr is stripped whatever prefix the revision namespace has", () => {
    for (const prefix of ["xr", "rv"]) assert.deepEqual(comparable("xl/workbook.xml", wb(prefix, "{A}")), comparable("xl/workbook.xml", wb(prefix, "{B}")), prefix);
  });
  it("an element named revisionPtr in another namespace is not noise", () => {
    const other = (guid: string): Uint8Array => strToU8(`<workbook xmlns:xr="urn:other"><xr:revisionPtr documentId="${guid}"/></workbook>`);
    assert.notDeepEqual(comparable("xl/workbook.xml", other("{A}")), comparable("xl/workbook.xml", other("{B}")));
  });
});
