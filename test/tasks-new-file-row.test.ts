import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { changedOutsideWording } from "../src/fingerprint.ts";

const ZIP_MTIME = new Date(2020, 0, 1);
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** A workbook with one sheet per entry of `sheets`; each is a list of numbers down column A. */
function book(sheets: number[][]): Uint8Array {
  const defs = sheets.map((_, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  const rels = sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("");
  const parts: Record<string, Uint8Array> = {
    "xl/workbook.xml": strToU8(`<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${defs}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`),
  };
  sheets.forEach((values, i) => {
    const rows = values.map((v, r) => `<row r="${r + 1}"><c r="A${r + 1}"><v>${v}</v></c></row>`).join("");
    parts[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zipSync(parts, { mtime: ZIP_MTIME });
}

/** A one-sheet workbook from raw `<row>` XML. */
function rawBook(rows: string): Uint8Array {
  return zipSync({
    "xl/workbook.xml": strToU8(`<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`),
  }, { mtime: ZIP_MTIME });
}

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-nf-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-nf-folder-")));
  const ledger = openLedger(home);
  const tasks = new TaskStore(ledger, home, [createXlsxLayer({ openState: async () => "closed" }), createPptxLayer(), createFilesLayer()]);
  const anchor = path.join(folder, "anchor.xlsx");
  await writeFile(anchor, book([[1]]));
  const cleanup = async () => {
    ledger.close();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  };
  return { tasks, ledger, folder, anchor, cleanup };
}

// The round does not diff, so a file created during a task is no "new file" row of the round. What stays is the layer's
// own summary of a new file (`summarizeNew`, and `diff` against no before-side), which the timeline reads, and the folder watch's fingerprint
// of the newcomer. The per-cell rows an op's recorded cells attributed do not exist (the xlsx layer's `touches` and
// `explains` are pinned in formats-xlsx-layer-explains.test.ts).
describe("a file created during a task", () => {
  const xlsx = createXlsxLayer({ openState: async () => "closed" });
  const withFile = async (name: string, bytes: Uint8Array | Buffer, run: (file: string) => Promise<void>) => {
    const { folder, cleanup } = await setup();
    try {
      const file = path.join(folder, name);
      await writeFile(file, bytes);
      await run(file);
    } finally {
      await cleanup();
    }
  };

  it("a 3-sheet workbook is one 'new file' summary row", async () => {
    await withFile("made.xlsx", book([[1, 2, 3], [4, 5], [6, 7, 8, 9]]), async (made) => {
      const row = await xlsx.summarizeNew!(made);
      assert.ok(row);
      assert.deepEqual([row.kind, xlsx.describe(row)], ["new file", "new workbook: 3 sheets, 9 cells"]);
    });
  });

  it("a later edit to the workbook is one fingerprint-only row", async () => {
    const { tasks, folder, anchor, cleanup } = await setup();
    await tasks.touch("c", anchor);
    const made = path.join(folder, "made.xlsx");
    await writeFile(made, book([[1, 2, 3], [4, 5], [6, 7, 8, 9]]));
    await tasks.submit("c", "made a book", false);
    await writeFile(made, book([[1, 2, 30], [4, 5], [6, 7, 8, 9]]));
    const second = await tasks.submit("c", "edited", false);
    assert.deepEqual(second.rows.map((r) => [r.kind, r.description]), [["changed outside CoCheck", changedOutsideWording()]]); // once reported as new, the newcomer is a fingerprint only
    await cleanup();
  });

  it("a deck is one 'new file' row with its slide count, and a later edit diffs against it", async () => {
    const pptx = createPptxLayer();
    const fixture = (n: string) => new URL(`./fixtures/${n}`, import.meta.url);
    await withFile("made.pptx", readFileSync(fixture("deck-resave.pptx")), async (made) => {
      const first = await pptx.diff(null, made);
      assert.equal(first.length, 1);
      assert.equal(first[0]!.kind, "new file");
      assert.match(pptx.describe(first[0]!), /^new deck: \d+ slides? /);
      const edited = `${made}.edit.pptx`;
      await writeFile(edited, readFileSync(fixture("deck-resave-edit.pptx")));
      const second = await pptx.diff(made, edited);
      assert.ok(second.length > 0);
      assert.ok(second.every((r) => r.kind !== "new file"));
    });
  });

  it("a new workbook holding #REF! is one summary row that counts its errors", async () => {
    await withFile("bad.xlsx", rawBook(
      `<row r="1"><c r="A1" t="e"><v>#REF!</v></c><c r="B1"><f>#REF!+1</f><v>0</v></c></row><row r="2"><c r="A2"><v>1</v></c></row>`,
    ), async (made) => {
      const row = await xlsx.summarizeNew!(made);
      assert.ok(row);
      assert.equal(row.kind, "new file");
      // Migration X2: the error checks moved into the Excel connector (test/office-issues-x.test.ts); the row still counts what it holds.
      assert.ok(Number(row.detail.errors) > 0, JSON.stringify(row.detail));
      assert.ok(Number(row.detail.brokenRefs) > 0, JSON.stringify(row.detail));
    });
  });
});
