// Word's boxes on its print pages, placed from where the finder (the kit's `findPdfParagraphs`) puts a paragraph's own words.
// Fakes only: the finder is a fake keyed by the words it is asked for, so a test shows which words the connector asked it to place.
// Guard: a box on a different paragraph that has the same words (a change inside hidden text, a repeated paragraph, a header's words), against no box.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { zipSync } from "fflate";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { answerDiff, levelFor, type OfficeDoc, type ProgramDeps } from "../src/office/connector/program.ts";
import type { PdfPager } from "../src/office/connector/pictures.ts";
import type { PdfFindOutput, PdfFindQuery, PdfRect } from "../public-kit/helpers/pdf-text.mjs";
import { fakeDriver, tinyPng } from "./helpers/office-fake.ts";

const W = 400, H = 500;
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const run = (t: string, vanish = false): string => `<w:r>${vanish ? "<w:rPr><w:vanish/></w:rPr>" : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
/** A paragraph from runs: a string is visible text, `{ hidden }` is a w:vanish run. */
const para = (...parts: Array<string | { hidden: string } | { raw: string }>): string => `<w:p>${parts.map((x) => (typeof x === "string" ? run(x) : "hidden" in x ? run(x.hidden, true) : x.raw)).join("")}</w:p>`;
function docx(paragraphs: string[], extra: Record<string, string> = {}): Buffer {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document ${NS}><w:body>${paragraphs.join("")}</w:body></w:document>`),
  };
  for (const [k, v] of Object.entries(extra)) files[k] = Buffer.from(v);
  return Buffer.from(zipSync(files));
}

interface Rig { shas: { before: string; after: string }; deps: ProgramDeps; asked: Array<{ side: "before" | "after"; queries: PdfFindQuery[] }> }
/** A pager over the fake driver's stand-in PDFs: `pageCount` pages of W x H, and a finder that places a paragraph by its visible words (`layout`: words to segments, per side). */
function rig(layout: Record<"before" | "after", Record<string, Array<{ page: number; rect: PdfRect; highlights?: PdfRect[] }>>>, o: { pageCount?: number; samePictures?: boolean; noFind?: boolean } = {}): Rig {
  const asked: Rig["asked"] = [];
  const shas = { before: "", after: "" };
  // the fake driver names the sha of the staged input in each stand-in PDF
  const sideOf = (pdf: Buffer): "before" | "after" => (pdf.toString("latin1").includes(shas.before) ? "before" : "after");
  const pager: PdfPager = {
    async pages(pdf) { return pdf.toString("latin1").startsWith("%PDF-fake ") ? Array.from({ length: o.pageCount ?? 1 }, (_, i) => `page ${i + 1}`) : null; },
    async png(pdf, n) { return tinyPng(o.samePictures === true ? `same#${n}` : `${pdf.toString("latin1")}#${n}`, W, H); },
    ...(o.noFind === true ? {} : {
      async find(pdf, queries) {
        const side = sideOf(pdf);
        asked.push({ side, queries });
        const results = queries.map((q) => {
          const segs = q.want ? layout[side][q.text] : undefined;
          return { id: q.id, found: segs !== undefined, pagebreak: (segs?.length ?? 0) > 1, segments: (segs ?? []).map((s) => ({ page: s.page, rect: s.rect, highlights: s.highlights ?? [] })) };
        });
        const out: PdfFindOutput = { pages: Array.from({ length: o.pageCount ?? 1 }, (_, i) => ({ index: i + 1, width: W, height: H })), results };
        return out;
      },
    }),
  };
  const f = fakeDriver({ exportAs: "ok" });
  const lock = path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "lock");
  return { asked, shas, deps: { driver: f.driver, pager, lockPath: lock, pollMs: 5, goneWaitMs: 100, lockWaitMs: 200, diffMs: 60_000 } };
}
const R = (x: number, y: number, w = 100, h = 20): PdfRect => ({ x, y, w, h });
async function review(before: Buffer, after: Buffer, r: Rig): Promise<OfficeDoc> {
  const dir = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  const b = path.join(dir, "before.docx"), a = path.join(dir, "after.docx");
  writeFileSync(b, before);
  writeFileSync(a, after);
  r.shas.before = createHash("sha256").update(before).digest("hex");
  r.shas.after = createHash("sha256").update(after).digest("hex");
  return answerDiff(OFFICE_APPS.word, b, a, r.deps);
}
const rowFor = (d: OfficeDoc, label: string) => d.changes.find((c) => c.label === label)!;

describe("Word's hello says level 3", () => {
  it("levelFor is 3 for Word", () => assert.equal(levelFor(OFFICE_APPS.word), 3));
});

describe("a visible, unique paragraph gets boxes", () => {
  const before = docx([para("Intro paragraph"), para("Payment is due in 30 days"), para("Closing words")]);
  const after = docx([para("Intro paragraph"), para("Payment is due in 45 days"), para("Closing words")]);
  it("changed: a box on each side's page, with the changed words highlighted", async () => {
    const r = rig({ before: { "Payment is due in 30 days": [{ page: 1, rect: R(40, 100, 300, 24), highlights: [R(240, 100, 40, 24)] }] }, after: { "Payment is due in 45 days": [{ page: 1, rect: R(40, 100, 300, 24), highlights: [R(240, 100, 40, 24)] }] } });
    const d = await review(before, after, r);
    const c = rowFor(d, "paragraph 2");
    assert.deepEqual(c.boxes?.map((b) => b.picture).sort(), ["after:page1", "before:page1"], JSON.stringify(d.changes));
    assert.deepEqual(c.boxes?.[0]?.rect, R(40, 100, 300, 24));
    assert.equal(c.boxes?.[0]?.highlights?.length, 1);
    assert.equal(c.unplaced, undefined);
    // the finder was asked for the changed words only with want true, in document order, with the changed span
    const q = r.asked.find((x) => x.side === "after")!.queries;
    assert.deepEqual(q.map((x) => x.want), [false, true, false]);
    assert.deepEqual(q[1]!.spans, [[18, 20]]);
  });
  it("deleted: a box on the before side only", async () => {
    const r = rig({ before: { "Payment is due in 30 days": [{ page: 1, rect: R(40, 100, 300, 24) }] }, after: {} });
    const d = await review(before, docx([para("Intro paragraph"), para("Closing words")]), r);
    const c = d.changes.find((x) => x.mark === "removed")!;
    assert.deepEqual(c.boxes?.map((b) => b.picture), ["before:page1"], JSON.stringify(d.changes));
    assert.equal(c.unplaced, undefined);
  });
  it("added: a box on the after side only", async () => {
    const r = rig({ before: {}, after: { "A brand new clause": [{ page: 1, rect: R(40, 150, 300, 24) }] } });
    const d = await review(docx([para("Intro paragraph")]), docx([para("Intro paragraph"), para("A brand new clause")]), r);
    const c = d.changes.find((x) => x.mark === "added")!;
    assert.deepEqual(c.boxes?.map((b) => b.picture), ["after:page1"], JSON.stringify(d.changes));
  });
  it("a moved paragraph is boxed on both sides, each side by its own row, when its words are unique", async () => {
    const mid = { "Middle clause text": [{ page: 1, rect: R(40, 200, 300, 24) }] };
    const lay = { ...mid, "Alpha clause text": [{ page: 1, rect: R(40, 100, 300, 24) }], "Omega clause text": [{ page: 1, rect: R(40, 300, 300, 24) }] };
    const lay2 = { ...mid, "Alpha clause text": [{ page: 1, rect: R(40, 300, 300, 24) }], "Omega clause text": [{ page: 1, rect: R(40, 100, 300, 24) }] };
    const r = rig({ before: lay, after: lay2 });
    const d = await review(docx([para("Alpha clause text"), para("Middle clause text"), para("Omega clause text")]), docx([para("Omega clause text"), para("Middle clause text"), para("Alpha clause text")]), r);
    const sides = d.changes.flatMap((c) => (c.boxes ?? []).map((b) => b.picture.split(":")[0]));
    assert.ok(sides.includes("before") && sides.includes("after"), JSON.stringify(d.changes.map((c) => [c.label, c.mark, c.boxes, c.unplaced])));
  });
});

describe("DANGER: no box on a different paragraph with the same words", () => {
  it("a change inside hidden text whose words appear elsewhere: no box, said in words, and the hidden words are never searched for", async () => {
    const before = docx([para("Terms", { hidden: " Net 30 days" }), para("Between"), para("Net 30 days")]);
    const after = docx([para("Terms", { hidden: " Net 45 days" }), para("Between"), para("Net 30 days")]);
    // a finder that would happily place the visible paragraph 3 (its words are right there on the page)
    const r = rig({ before: { "Net 30 days": [{ page: 1, rect: R(40, 400, 200, 20) }], Terms: [{ page: 1, rect: R(40, 100, 80, 20) }] }, after: { "Net 30 days": [{ page: 1, rect: R(40, 400, 200, 20) }], Terms: [{ page: 1, rect: R(40, 100, 80, 20) }] } });
    const d = await review(before, after, r);
    const c = rowFor(d, "paragraph 1");
    assert.equal(c.boxes, undefined, JSON.stringify(c));
    assert.match(c.unplaced?.after ?? "", /not marked.*hidden/, JSON.stringify(c));
    assert.ok(d.changes.every((x) => x.boxes === undefined), "no change may land on the visible 'Net 30 days' paragraph");
    for (const x of r.asked) assert.ok(!x.queries.some((q) => /Net 45/.test(q.text) || (/hidden/.test(q.text))), "hidden words must not be sent to the finder");
  });
  it("a changed paragraph whose before words are repeated elsewhere on its side: no box on either side", async () => {
    const before = docx([para("Sign here"), para("Filler one"), para("Sign here")]);
    const after = docx([para("Sign below"), para("Filler one"), para("Sign here")]);
    const r = rig({ before: { "Sign here": [{ page: 1, rect: R(40, 100, 100, 20) }] }, after: { "Sign below": [{ page: 1, rect: R(40, 100, 100, 20) }] } });
    const d = await review(before, after, r);
    const c = rowFor(d, "paragraph 1");
    assert.equal(c.boxes, undefined, JSON.stringify(c));
    assert.match(c.unplaced?.before ?? "", /not marked.*another paragraph/);
    assert.ok(c.unplaced?.after !== undefined);
  });
  it("words held inside a longer visible paragraph are refused too (a finder match could land in the long one)", async () => {
    const before = docx([para("Net 30 days"), para("Payment terms are Net 30 days from invoice")]);
    const after = docx([para("Net 45 days"), para("Payment terms are Net 30 days from invoice")]);
    const r = rig({ before: { "Net 30 days": [{ page: 1, rect: R(40, 100, 100, 20) }] }, after: { "Net 45 days": [{ page: 1, rect: R(40, 100, 100, 20) }] } });
    const d = await review(before, after, r);
    assert.equal(rowFor(d, "paragraph 1").boxes, undefined);
    assert.match(rowFor(d, "paragraph 1").unplaced?.before ?? "", /another paragraph/);
  });
  it("an added paragraph that is entirely hidden text has no box", async () => {
    const r = rig({ before: {}, after: { "Secret note": [{ page: 1, rect: R(40, 100, 100, 20) }] } });
    const d = await review(docx([para("Intro")]), docx([para("Intro"), para({ hidden: "Secret note" })]), r);
    const c = d.changes.find((x) => x.mark === "added")!;
    assert.equal(c.boxes, undefined);
    assert.match(c.unplaced?.after ?? "", /hidden/);
  });
  it("a paragraph with a tracked deletion has no box", async () => {
    const del = '<w:del w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>old </w:delText></w:r></w:del>';
    const r = rig({ before: {}, after: { "new text here": [{ page: 1, rect: R(40, 100, 100, 20) }] } });
    const d = await review(docx([para("Intro")]), docx([para("Intro"), para({ raw: del }, "new text here")]), r);
    const c = d.changes.find((x) => x.mark === "added")!;
    assert.equal(c.boxes, undefined);
    assert.match(c.unplaced?.after ?? "", /tracked deletion/);
  });
});

describe("headers and footers are never boxed", () => {
  const hf = { "word/footer1.xml": `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${NS}>${para("Confidential draft")}</w:ftr>`, "word/header1.xml": `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${NS}>${para("Company header")}</w:hdr>` };
  it("a changed header row gets no box and no placement; a body paragraph repeating the footer's words gets none", async () => {
    const before = docx([para("Body one"), para("Confidential draft")], hf);
    const after = docx([para("Body one"), para("Confidential draft v2")], { ...hf, "word/header1.xml": `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${NS}>${para("Company header 2")}</w:hdr>` });
    const r = rig({ before: { "Confidential draft": [{ page: 1, rect: R(40, 460, 100, 20) }] }, after: { "Confidential draft v2": [{ page: 1, rect: R(40, 460, 100, 20) }] } });
    const d = await review(before, after, r);
    const head = d.changes.find((c) => c.label === "header 1");
    assert.ok(head !== undefined);
    assert.equal(head.boxes, undefined);
    const body = rowFor(d, "paragraph 2");
    assert.equal(body.boxes, undefined, JSON.stringify(body));
    assert.match(body.unplaced?.before ?? "", /header or footer/);
  });
});

describe("text that reflows across pages gets one box per page", () => {
  it("two segments, two pictures", async () => {
    const long = "A long paragraph that runs over the bottom of page one and carries on at the top of page two";
    const r = rig({ before: { [long]: [{ page: 1, rect: R(40, 440, 300, 40) }] }, after: { [`${long} now`]: [{ page: 1, rect: R(40, 440, 300, 40) }, { page: 2, rect: R(40, 20, 300, 20) }] } }, { pageCount: 2 });
    const d = await review(docx([para("Top"), para(long)]), docx([para("Top"), para(`${long} now`)]), r);
    const c = rowFor(d, "paragraph 2");
    assert.deepEqual(c.boxes?.map((b) => b.picture), ["before:page1", "after:page1", "after:page2"], JSON.stringify(d.changes));
  });
});

describe("a box is refused where the page cannot show it", () => {
  const before = docx([para("Intro"), para("Old clause words")]);
  const after = docx([para("Intro"), para("New clause words")]);
  const lay = { before: { "Old clause words": [{ page: 1, rect: R(40, 100, 100, 20) }] }, after: { "New clause words": [{ page: 1, rect: R(40, 100, 100, 20) }] } };
  it("a page both sides print alike (picture flagged unchanged): no box", async () => {
    const d = await review(before, after, rig(lay, { samePictures: true }));
    assert.equal(rowFor(d, "paragraph 2").boxes, undefined);
    assert.match(rowFor(d, "paragraph 2").unplaced?.after ?? "", /same on both sides/);
  });
  it("the finder did not find it: no box", async () => {
    const d = await review(before, after, rig({ before: {}, after: {} }));
    assert.equal(rowFor(d, "paragraph 2").boxes, undefined);
    assert.match(rowFor(d, "paragraph 2").unplaced?.before ?? "", /not found/);
  });
  it("a rectangle off the picture: no box", async () => {
    const d = await review(before, after, rig({ before: lay.before, after: { "New clause words": [{ page: 1, rect: R(390, 100, 100, 20) }] } }));
    assert.equal(rowFor(d, "paragraph 2").boxes, undefined);
    assert.match(rowFor(d, "paragraph 2").unplaced?.before ?? "", /not marked/, "all or none: the before side is not marked either");
  });
  it("no finder (a machine without the helper): every paragraph row says not marked", async () => {
    const d = await review(before, after, rig(lay, { noFind: true }));
    assert.equal(rowFor(d, "paragraph 2").boxes, undefined);
    assert.match(rowFor(d, "paragraph 2").unplaced?.after ?? "", /not marked/);
  });
});

describe("the words a paragraph prints", () => {
  it("hidden by direct property or by style are left out; a deletion is flagged", async () => {
    const { readWordParas } = await import("../src/office/connector/word-boxes.ts");
    const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${NS}><w:style w:type="character" w:styleId="Hid"><w:rPr><w:vanish/></w:rPr></w:style><w:style w:type="character" w:styleId="Hid2"><w:basedOn w:val="Hid"/></w:style><w:style w:type="paragraph" w:styleId="HidP"><w:rPr><w:vanish/></w:rPr></w:style></w:styles>`;
    const byStyle = '<w:r><w:rPr><w:rStyle w:val="Hid2"/></w:rPr><w:t>by style</w:t></w:r>';
    const shown = '<w:r><w:rPr><w:rStyle w:val="Hid"/><w:vanish w:val="0"/></w:rPr><w:t>shown again</w:t></w:r>';
    const wholeStyle = '<w:p><w:pPr><w:pStyle w:val="HidP"/></w:pPr><w:r><w:t>whole paragraph</w:t></w:r></w:p>';
    const { paras } = readWordParas(docx([para("a ", { hidden: "b " }, { raw: byStyle }, { raw: shown }), wholeStyle], { "word/styles.xml": styles }));
    assert.equal(paras[0]!.text, "a shown again");
    assert.equal(paras[0]!.hidden, true);
    assert.equal(paras[1]!.text, "");
  });
});

describe("the finder's page and the picture disagree on the page size", () => {
  it("no box: the rectangle would sit on a picture of another size; the row says why", async () => {
    const before = docx([para("Intro paragraph"), para("Payment is due in 30 days")]);
    const after = docx([para("Intro paragraph"), para("Payment is due in 45 days")]);
    const r = rig({ before: { "Payment is due in 30 days": [{ page: 1, rect: R(40, 100, 300, 24) }] }, after: { "Payment is due in 45 days": [{ page: 1, rect: R(40, 100, 300, 24) }] } });
    const find = r.deps.pager.find!;
    r.deps.pager = { ...r.deps.pager, find: async (pdf, q) => { const out = (await find(pdf, q))!; return { ...out, pages: out.pages.map((p) => ({ ...p, width: p.width + 30 })) }; } };
    const c = rowFor(await review(before, after, r), "paragraph 2");
    assert.equal(c.boxes, undefined);
    assert.match(c.unplaced?.after ?? "", /disagree on its size/);
  });
});
