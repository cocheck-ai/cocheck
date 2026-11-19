// the copy each side is staged as for the print. Excel: paperSize and errors out of every worksheet's pageSetup. Word: comments out, tracked changes kept,
// the page says so only then. A rewrite that cannot be done safely sends the plain copy with no claim; the change list still reads the agent's own file.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { officePdfs, type JobOptions, type SideInput } from "../src/office/connector/office-job.ts";
import { answerDiff, type ProgramDeps } from "../src/office/connector/program.ts";
import { fakeDriver, fakePager } from "./helpers/office-fake.ts";
import { FX, parts, put, read, text, xlsxWithPrintSetup, zip } from "./helpers/print-copy-fixtures.ts";

const GOOD = "%PDF-fake good";
const CAVEAT = "Word prints comments in a side pane, so comments are hidden on these pages";

/** officePdfs over fake exports that record the bytes of the file staged for the app. */
function rig(app: typeof OFFICE_APPS.word, exportWhy?: string) {
  const f = fakeDriver();
  const staged: Buffer[] = [];
  f.driver.exportPdf = async (_a, input, pdf) => {
    staged.push(readFileSync(input));
    if (exportWhy !== undefined) return { ok: false, timedOut: false, why: exportWhy };
    writeFileSync(pdf, GOOD);
    return { ok: true };
  };
  const opts: JobOptions = { driver: f.driver, lockPath: path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "lock"), deadline: Date.now() + 20_000, sideTimeoutMs: 5_000, pollMs: 5, goneWaitMs: 100, lockWaitMs: 200, stableGapMs: 5 };
  const file = (b: Buffer, name: string): string => { const p = path.join(mkdtempSync(path.join(tmpdir(), "src-")), name); writeFileSync(p, b); return p; };
  const run = async (sides: { side: "before" | "after"; bytes: Buffer }[]) => {
    const input: SideInput[] = sides.map((s) => ({ side: s.side, file: file(s.bytes, `a${app.exts[0]}`), name: `a${app.exts[0]}` }));
    const j = await officePdfs(app, input, opts);
    assert.ok(!j.pending);
    return j.pending ? [] : j.sides;
  };
  return { run, staged };
}

describe("Excel: the staged copy has no paperSize and no errors", () => {
  it("each worksheet's own pageSetup loses the two attributes; the copy the app opens is that; nothing is claimed on the side", async () => {
    const orig = xlsxWithPrintSetup();
    const r = rig(OFFICE_APPS.excel);
    const out = await r.run([{ side: "after", bytes: orig }]);
    const got = parts(r.staged[0]!);
    assert.match(text(got, "xl/worksheets/sheet1.xml"), /<pageSetup orientation="landscape" horizontalDpi="300"\/><\/worksheet>/);
    assert.doesNotMatch(text(got, "xl/worksheets/sheet1.xml").replace(/<customSheetViews>.*<\/customSheetViews>/, ""), /paperSize|errors=/);
    assert.ok("pdf" in out[0]! && !("commentsHidden" in out[0]!));
  });

  it("rule 39: every other part is byte for byte the original, and the sheet differs by exactly the two attributes", async () => {
    const orig = xlsxWithPrintSetup();
    const r = rig(OFFICE_APPS.excel);
    await r.run([{ side: "after", bytes: orig }]);
    const a = parts(orig), b = parts(r.staged[0]!);
    assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());
    for (const n of Object.keys(a)) if (n !== "xl/worksheets/sheet1.xml") assert.deepEqual(Buffer.from(b[n]!), Buffer.from(a[n]!), n);
    const expected = text(a, "xl/worksheets/sheet1.xml").replace(/(<worksheet.*)<pageSetup paperSize="9" orientation="landscape" errors="blank" horizontalDpi="300"\/>/, '$1<pageSetup orientation="landscape" horizontalDpi="300"/>');
    assert.equal(text(b, "xl/worksheets/sheet1.xml"), expected);
    assert.match(text(b, "xl/worksheets/sheet1.xml"), /<pageSetup paperSize="8" errors="dash"\/>/, "a custom view's own setup is not the sheet's and stays");
  });

  it("a file with nothing to remove, or one that cannot be rewritten safely, is sent as the plain copy", async () => {
    const plain = read("v1.xlsx");
    const noRels = zip(Object.fromEntries(Object.entries(parts(xlsxWithPrintSetup())).filter(([n]) => n !== "xl/_rels/workbook.xml.rels")));
    const bad = zip(put(parts(xlsxWithPrintSetup()), "xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/><y:pageSetup paperSize="9"/></worksheet>'));
    const notZip = Buffer.from("not a zip at all");
    for (const bytes of [plain, noRels, bad, notZip]) {
      const r = rig(OFFICE_APPS.excel);
      await r.run([{ side: "before", bytes }]);
      assert.deepEqual(r.staged[0], bytes);
    }
  });

  it("a failure on the rewritten copy never blames the agent's file; on a plain copy the words are the app's own", async () => {
    const a = rig(OFFICE_APPS.excel, "Excel answered error -50");
    const out = await a.run([{ side: "before", bytes: xlsxWithPrintSetup() }]);
    assert.ok("why" in out[0]! && /Excel answered error -50 \(this was CoCheck's own copy of the workbook/.test(out[0]!.why), JSON.stringify(out[0]));
    const b = rig(OFFICE_APPS.excel, "Excel answered error -50");
    const out2 = await b.run([{ side: "before", bytes: read("v1.xlsx") }]);
    assert.deepEqual(out2[0], { side: "before", why: "Excel answered error -50" });
  });
});

describe("Word: the staged copy has no comments", () => {
  const before = read("word-comments-before.docx");

  it("comment parts, links, content types and anchors are gone; tracked changes stay; the side says comments were hidden", async () => {
    const r = rig(OFFICE_APPS.word);
    const out = await r.run([{ side: "before", bytes: before }]);
    const a = parts(before), b = parts(r.staged[0]!);
    assert.ok(a["word/comments.xml"] && a["word/commentsExtended.xml"]);
    assert.ok(!Object.keys(b).some((n) => /comments/i.test(n)), Object.keys(b).join());
    assert.doesNotMatch(text(b, "[Content_Types].xml"), /comments/i);
    assert.doesNotMatch(text(b, "word/_rels/document.xml.rels"), /comments/i);
    for (const n of Object.keys(b)) if (/\.xml$/.test(n)) assert.doesNotMatch(text(b, n), /commentRange|commentReference/, n);
    const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
    for (const re of [/<w:ins /g, /<w:del /g]) { assert.ok(count(text(a, "word/document.xml"), re) > 0); assert.equal(count(text(b, "word/document.xml"), re), count(text(a, "word/document.xml"), re)); }
    assert.deepEqual(out[0], { side: "before", pdf: Buffer.from(GOOD), commentsHidden: true });
  });

  it("rule 39: every other part is byte for byte the original; the three edited parts equal the original less exactly the comment elements", async () => {
    const r = rig(OFFICE_APPS.word);
    await r.run([{ side: "before", bytes: before }]);
    const a = parts(before), b = parts(r.staged[0]!);
    const edited = new Set(["word/document.xml", "[Content_Types].xml", "word/_rels/document.xml.rels"]);
    const gone = new Set(["word/comments.xml", "word/commentsExtended.xml"]);
    assert.deepEqual(Object.keys(b).sort(), Object.keys(a).filter((n) => !gone.has(n)).sort());
    for (const n of Object.keys(b)) if (!edited.has(n)) assert.deepEqual(Buffer.from(b[n]!), Buffer.from(a[n]!), n);
    const cut = (s: string): string => s.replace(/<w:commentRange(?:Start|End) [^>]*\/>/g, "").replace(/<w:commentReference [^>]*\/>/g, "");
    assert.equal(text(b, "word/document.xml"), cut(text(a, "word/document.xml")));
    assert.equal(text(b, "[Content_Types].xml"), text(a, "[Content_Types].xml").replace(/<Override PartName="\/word\/comments(?:Extended)?\.xml"[^>]*\/>/g, ""));
    assert.equal(text(b, "word/_rels/document.xml.rels"), text(a, "word/_rels/document.xml.rels").replace(/<Relationship [^>]*Target="comments(?:Extended)?\.xml"[^>]*\/>/g, ""));
  });

  it("no comments in the file: the plain copy and no claim", async () => {
    const r = rig(OFFICE_APPS.word);
    const out = await r.run([{ side: "before", bytes: read("v1.docx") }]);
    assert.deepEqual(r.staged[0], read("v1.docx"));
    assert.deepEqual(out[0], { side: "before", pdf: Buffer.from(GOOD) });
  });

  it("an anchor that cannot be cut safely (not self-closing) sends the plain copy and makes no claim", async () => {
    const p = parts(before);
    const bad = zip(put(p, "word/document.xml", text(p, "word/document.xml").replace(/<w:commentRangeStart w:id="0"\/>/, '<w:commentRangeStart w:id="0"></w:commentRangeStart>')));
    const r = rig(OFFICE_APPS.word);
    const out = await r.run([{ side: "before", bytes: bad }]);
    assert.deepEqual(r.staged[0], bad);
    assert.ok(!("commentsHidden" in out[0]!));
    const garbage = zip(put(p, "word/document.xml", "<w:document><w:body></w:document>"));
    const r2 = rig(OFFICE_APPS.word);
    await r2.run([{ side: "before", bytes: garbage }]);
    assert.deepEqual(r2.staged[0], garbage);
  });
});

describe("Word: the answer", () => {
  const world = () => {
    const f = fakeDriver();
    const staged: Buffer[] = [];
    f.driver.exportPdf = async (_a, input, pdf) => { staged.push(readFileSync(input)); writeFileSync(pdf, GOOD); return { ok: true }; };
    const deps: ProgramDeps = { driver: f.driver, pager: fakePager, lockPath: path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "lock"), pollMs: 5, goneWaitMs: 100, lockWaitMs: 200, diffMs: 60_000 };
    return { deps, staged };
  };
  const tmp = mkdtempSync(path.join(tmpdir(), "pair-"));
  const save = (name: string, b: Buffer): string => { const p = path.join(tmp, name); writeFileSync(p, b); return p; };

  it("a document whose only change is a comment still lists it, and its pages come from copies without comments, with the caveat", async () => {
    const base = read("word-comments-before.docx");
    const p = parts(base);
    const edited = zip(put(p, "word/comments.xml", text(p, "word/comments.xml").replace("please confirm this wording.", "please confirm this wording (reworded).")));
    const w = world();
    const doc = await answerDiff(OFFICE_APPS.word, save("only-comment-before.docx", base), save("only-comment-after.docx", edited), w.deps);
    // the connector's own change list (the files layer, over the agent's files) still lists the file as changed
    assert.ok(doc.changes.length > 0 && doc.changes.every((c) => c.mark === "changed"), JSON.stringify(doc.changes));
    assert.ok(doc.caveats.includes(CAVEAT), JSON.stringify(doc.caveats));
    assert.equal(w.staged.length, 2);
    for (const s of w.staged) assert.ok(!Object.keys(parts(s)).some((n) => /comments/i.test(n)));
  });

  it("a pair with no comments: no caveat", async () => {
    const w = world();
    const doc = await answerDiff(OFFICE_APPS.word, path.join(FX, "v1.docx"), path.join(FX, "v2.docx"), w.deps);
    assert.ok(!doc.caveats.includes(CAVEAT));
    assert.ok(doc.changes.length > 0);
  });
});
