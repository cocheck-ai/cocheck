// The Office checks come back through spec v1.2 `issues`, from inside the built-in connectors.
//   X1: the structure check runs in the connector; only a likely-repair finding is an issue (`where` = slide, sheet or part); tolerated and clean give none.
//   X2: the Excel connector reports error values a change introduced, `where` = the cell (ported from core's checks/errors.ts).
//   X4, both ways: a real deck PowerPoint opened (recorded, a duplicate shape id, tolerated) shows no issue; the recorded deck whose
//   slide 5 chart PowerPoint asked to repair shows its issues.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { structureIssues } from "../src/office/connector/issues.ts";
import { answerDiff, type ProgramDeps } from "../src/office/connector/program.ts";
import { fakePager } from "./helpers/office-fake.ts";

const FIX = path.join(import.meta.dirname, "fixtures");
const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-x-issues-"));
const deps = (): ProgramDeps => ({ driver: undefined, pager: fakePager, lockPath: path.join(scratch, "lock") });
const put = (name: string, bytes: Uint8Array): string => {
  const p = path.join(scratch, name);
  writeFileSync(p, bytes);
  return p;
};
const fx = (name: string): string => path.join(FIX, name);

function mutate(file: string, part: string, edit: (xml: string) => string): Uint8Array {
  const z = unzipSync(new Uint8Array(readFileSync(file)));
  const before = strFromU8(z[part]!);
  const after = edit(before);
  assert.notEqual(after, before, `the edit changed ${part}`);
  return zipSync({ ...z, [part]: strToU8(after) });
}

/** formula-edit-before.xlsx (Sheet1: B*C in D2:D4, SUM in D5) with one sheet edit. */
const book = (name: string, edit: (xml: string) => string): string => put(name, mutate(fx("formula-edit-before.xlsx"), "xl/worksheets/sheet1.xml", edit));

describe("X1: the structure check inside the connectors, repair-level only", () => {
  it("the recorded deck: slide 5's chart, which PowerPoint asked to repair, is an issue at slide 5; the tolerated charts are not", async () => {
    const doc = await answerDiff(OFFICE_APPS.powerpoint, fx("broken-chart-deck-v1.pptx"), fx("structure/broken-chart.pptx"), deps());
    assert.deepEqual(checkChanges(doc), []);
    const issues = doc.issues ?? [];
    assert.ok(issues.length >= 2, JSON.stringify(issues));
    assert.ok(issues.every((i) => i.where === "slide 5" && i.side === "after"), JSON.stringify(issues));
    assert.ok(issues.some((i) => /empty values where a number is needed/.test(i.text)), JSON.stringify(issues));
    assert.ok(!issues.some((i) => /usually opens it anyway/.test(i.text)), "a tolerated finding never becomes an issue");
  });

  it("a real deck PowerPoint opened, with a duplicate shape id (tolerated only): no issues", async () => {
    const doc = await answerDiff(OFFICE_APPS.powerpoint, fx("long-html-deck-v2.pptx"), fx("long-html-deck-v3.pptx"), deps());
    assert.equal(doc.issues, undefined, JSON.stringify(doc.issues));
  });

  it("a deck with a duplicate slide id (likely repair): an issue naming the deck's part", async () => {
    const after = put("dup-slide.pptx", mutate(fx("deck-calibri.pptx"), "ppt/presentation.xml", (x) => x.replace(/(<p:sldId id="(\d+)"([^>]*)\/>)/, "$1<p:sldId id=\"$2\"$3/>")));
    const doc = await answerDiff(OFFICE_APPS.powerpoint, fx("deck-calibri.pptx"), after, deps());
    assert.ok((doc.issues ?? []).some((i) => i.where === "ppt/presentation.xml" && /share|twice|used/.test(i.text)), JSON.stringify(doc.issues));
  });

  it("clean files: no issues (Word, PowerPoint, Excel)", async () => {
    assert.equal((await answerDiff(OFFICE_APPS.word, fx("memo-v1.docx"), fx("memo-v2.docx"), deps())).issues, undefined);
    assert.equal((await answerDiff(OFFICE_APPS.powerpoint, fx("deck-calibri.pptx"), fx("deck-calibri.pptx"), deps())).issues, undefined);
    assert.equal((await answerDiff(OFFICE_APPS.excel, fx("formula-edit-before.xlsx"), fx("formula-edit-after.xlsx"), deps())).issues, undefined);
  });

  it("a workbook Excel would repair (a cell pointing past the shared strings): an issue from the Excel connector too", async () => {
    const after = book("bad-sst.xlsx", (x) => x.replace('<c r="A2" t="s"><v>3</v></c>', '<c r="A2" t="s"><v>99999</v></c>'));
    const doc = await answerDiff(OFFICE_APPS.excel, fx("formula-edit-before.xlsx"), after, deps());
    assert.ok((doc.issues ?? []).some((i) => /text that is not stored/.test(i.text) && i.side === "after"), JSON.stringify(doc.issues));
  });

  it("the after side is checked under its own ending: a .xlsm workbook and a .ppsx show with a repair-level defect each get their issue", async () => {
    const xlsm = book("bad-sst.xlsm", (x) => x.replace('<c r="A2" t="s"><v>3</v></c>', '<c r="A2" t="s"><v>99999</v></c>'));
    const d1 = await answerDiff(OFFICE_APPS.excel, fx("formula-edit-before.xlsx"), xlsm, deps());
    assert.ok((d1.issues ?? []).some((i) => /text that is not stored/.test(i.text) && /Excel/.test(i.text) && i.side === "after"), JSON.stringify(d1.issues));
    const ppsx = put("dup-slide.ppsx", mutate(fx("deck-calibri.pptx"), "ppt/presentation.xml", (x) => x.replace(/(<p:sldId id="(\d+)"([^>]*)\/>)/, "$1<p:sldId id=\"$2\"$3/>")));
    const d2 = await answerDiff(OFFICE_APPS.powerpoint, fx("deck-calibri.pptx"), ppsx, deps());
    assert.ok((d2.issues ?? []).some((i) => i.where === "ppt/presentation.xml" && /share|twice|used/.test(i.text)), JSON.stringify(d2.issues));
  });

  it("allow table: no clean real fixture raises an issue (each check keeps its clean-file tests)", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const n of readdirSync(dir)) {
        const p = path.join(dir, n);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(xlsx|xlsm|docx|pptx)$/i.test(n)) out.push(p);
      }
      return out;
    };
    // the same exclusions as the structure check's own allow table (structure-check): the recorded decks are known-bad, corrupt_* are robustness fixtures
    const files = walk(FIX).filter((p) => !p.replaceAll("\\", "/").includes("structure/") && !/broken-chart-deck-v\d\.pptx$/.test(p) && !/corrupt_[a-z_]+\.xlsx$/.test(p) && statSync(p).size > 0);
    assert.ok(files.length > 25);
    for (const f of files) assert.deepEqual(structureIssues(new Uint8Array(readFileSync(f)), f), [], f);
  });
});

describe("X2: error values a change introduced, where = the cell", () => {
  it("a formula that now reads #REF! and shows #REF!: two issues at Sheet1!D2", async () => {
    const after = book("ref.xlsx", (x) => x.replace('<c r="D2" s="1"><f>B2*C2</f><v>7.5</v></c>', '<c r="D2" s="1" t="e"><f>#REF!*C2</f><v>#REF!</v></c>'));
    const doc = await answerDiff(OFFICE_APPS.excel, fx("formula-edit-before.xlsx"), after, deps());
    assert.deepEqual(checkChanges(doc), []);
    assert.deepEqual(doc.issues, [
      { text: "Shows the error #REF!, which the change introduced.", side: "after", where: "Sheet1!D2" },
      { text: "The formula now points at a reference that no longer exists (#REF!).", side: "after", where: "Sheet1!D2" },
    ]);
  });

  for (const code of ["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!", "#SPILL!", "#CALC!"]) {
    it(`a cell that became ${code} is an issue at that cell`, async () => {
      const after = book(`code-${code.replace(/\W/g, "")}.xlsx`, (x) => x.replace('<c r="B3"><v>5</v></c>', `<c r="B3" t="e"><v>${code}</v></c>`));
      const doc = await answerDiff(OFFICE_APPS.excel, fx("formula-edit-before.xlsx"), after, deps());
      assert.ok((doc.issues ?? []).some((i) => i.where === "Sheet1!B3" && i.text === `Shows the error ${code}, which the change introduced.`), JSON.stringify(doc.issues));
    });
  }

  it("a recalculated cell whose formula did not change and now shows #DIV/0! is flagged like an edited one", async () => {
    const after = book("div0.xlsx", (x) => x.replace('<c r="C3" s="1"><v>4</v></c>', '<c r="C3" s="1"><v>0</v></c>').replace('<c r="D3" s="1"><f>B3*C3</f><v>20</v></c>', '<c r="D3" s="1" t="e"><f>B3/C3</f><v>#DIV/0!</v></c>'));
    const doc = await answerDiff(OFFICE_APPS.excel, fx("formula-edit-before.xlsx"), after, deps());
    assert.ok((doc.issues ?? []).some((i) => i.where === "Sheet1!D3" && i.text === "Shows the error #DIV/0!, which the change introduced."), JSON.stringify(doc.issues));
  });

  it("text that spells an error, and #REF! inside a string literal, are not errors", async () => {
    const after = book("text.xlsx", (x) => x.replace('<c r="B2"><v>3</v></c>', '<c r="B2" t="inlineStr"><is><t>#N/A</t></is></c>').replace('<c r="D4" s="1"><f>B4*C4</f><v>20</v></c>', '<c r="D4" s="1" t="str"><f>IF(B4,"#REF!")</f><v>#REF!</v></c>'));
    const doc = await answerDiff(OFFICE_APPS.excel, fx("formula-edit-before.xlsx"), after, deps());
    assert.ok(doc.changes.length > 0);
    assert.equal(doc.issues, undefined, JSON.stringify(doc.issues));
  });

  it("an error already there (still shown, or changed kind) is not one the change introduced", async () => {
    const was = book("was-err.xlsx", (x) => x.replace('<c r="D2" s="1"><f>B2*C2</f><v>7.5</v></c>', '<c r="D2" s="1" t="e"><f>B2*C2+#REF!</f><v>#REF!</v></c>'));
    const now = book("now-err.xlsx", (x) => x.replace('<c r="D2" s="1"><f>B2*C2</f><v>7.5</v></c>', '<c r="D2" s="1" t="e"><f>B2*C2+#REF!+1</f><v>#N/A</v></c>'));
    const doc = await answerDiff(OFFICE_APPS.excel, was, now, deps());
    assert.ok(doc.changes.length > 0);
    assert.equal(doc.issues, undefined, JSON.stringify(doc.issues));
  });

  it("a new workbook holding #REF!: every error cell is one the change introduced", async () => {
    const made = book("made.xlsx", (x) => x.replace('<c r="D2" s="1"><f>B2*C2</f><v>7.5</v></c>', '<c r="D2" s="1" t="e"><f>#REF!+1</f><v>#REF!</v></c>'));
    const doc = await answerDiff(OFFICE_APPS.excel, put("empty-before.xlsx", new Uint8Array()), made, deps());
    assert.deepEqual((doc.issues ?? []).map((i) => i.where), ["Sheet1!D2", "Sheet1!D2"]);
  });

  it("an inserted row: its error cell has no before cell, and the rows below are compared with the rows they moved from", async () => {
    const after = book("ins.xlsx", (x) =>
      x
        .replace(/<row r="5"[\s\S]*?<\/row>/, (r) => r.replace('r="5"', 'r="6"').replace('r="C5"', 'r="C6"').replace('r="D5"', 'r="D6"').replace("SUM(D2:D4)", "SUM(D2:D5)"))
        .replace(/(<row r="4"[\s\S]*?<\/row>)/, '$1<row r="5"><c r="B5"><v>1</v></c><c r="C5" s="1"><v>0</v></c><c r="D5" s="1" t="e"><f>B5/C5</f><v>#DIV/0!</v></c></row>'));
    const doc = await answerDiff(OFFICE_APPS.excel, fx("formula-edit-before.xlsx"), after, deps());
    assert.deepEqual((doc.issues ?? []).map((i) => [i.where, i.text]), [["Sheet1!D5", "Shows the error #DIV/0!, which the change introduced."]], JSON.stringify(doc.issues));
  });
});
