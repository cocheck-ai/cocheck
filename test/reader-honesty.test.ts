import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";

/**
 * The reader never passes off an unreadable workbook as empty. Fixtures are the casebook workbook as it stood
 * at each step of a live rerun: Codex rewrote xl/workbook.xml and its rels with namespace
 * prefixes (S1), repaired it after Excel refused to open it (S1b), and the user saved in Excel with B31=850 (S2);
 * the Claude leg's workbooks were never prefixed.
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "casebook-rerun");
const fixture = (name: string): string => path.join(FIXTURES, `${name}.xlsx`);
const ZIP_MTIME = new Date(2020, 0, 1);

const layer = createXlsxLayer({ openState: async () => "closed" });

async function bytesOf(name: string): Promise<Buffer> {
  return readFile(fixture(name));
}

/** A copy of fixture `name` with some parts replaced (a string) or removed (null). */
async function altered(name: string, changes: Record<string, string | null>): Promise<Uint8Array> {
  const parts = unzipSync(await bytesOf(name));
  for (const [part, text] of Object.entries(changes)) {
    if (text === null) delete parts[part];
    else parts[part] = strToU8(text);
  }
  return zipSync(parts, { mtime: ZIP_MTIME });
}

async function inTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function diffBytes(before: Uint8Array | string, after: Uint8Array | string) {
  return inTmp(async (dir) => {
    const put = async (side: string, what: Uint8Array | string): Promise<string> => {
      const file = path.join(dir, `${side}.xlsx`);
      if (typeof what === "string") await copyFile(fixture(what), file);
      else await writeFile(file, what);
      return file;
    };
    return layer.diff(await put("before", before), await put("after", after));
  });
}

function digest(book: ReturnType<typeof readWorkbookSnapshot>): { sheets: number; cells: number; sha: string } {
  const hash = createHash("sha256");
  let cells = 0;
  for (const sheet of book.sheets) {
    hash.update(sheet.name + (sheet.state ?? ""));
    for (const [address, cell] of sheet.cells) {
      cells++;
      hash.update(JSON.stringify([address, cell]));
    }
  }
  return { sheets: book.sheets.length, cells, sha: hash.digest("hex").slice(0, 16) };
}

const UNREADABLE = "CoCheck can't read this file; open it in Excel to check it still opens";

describe("the reader resolves XML elements by namespace URI, not by prefix", () => {
  it("a prefixed workbook.xml and rels read the same as the unprefixed original", async () => {
    const original = digest(readWorkbookSnapshot(await bytesOf("codex-S0")));
    assert.equal(original.cells, 9387);
    for (const name of ["codex-S1", "codex-S1b"]) {
      const book = digest(readWorkbookSnapshot(await bytesOf(name)));
      assert.ok(book.sheets >= 16, `${name}: ${book.sheets} sheets`);
      assert.ok(book.cells > 9000, `${name}: ${book.cells} cells`);
    }
  });

  it("every part prefixed, under a made-up prefix, reads the same as the unprefixed one", () => {
    const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const docRel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const pkgRel = "http://schemas.openxmlformats.org/package/2006/relationships";
    const plain = zipSync({
      "xl/workbook.xml": strToU8(`<workbook xmlns="${main}" xmlns:r="${docRel}"><sheets><sheet name="One" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="${pkgRel}"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="${main}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>`),
      "xl/sharedStrings.xml": strToU8(`<sst xmlns="${main}"><si><t>hello</t></si></sst>`),
    });
    const prefixed = zipSync({
      "xl/workbook.xml": strToU8(`<q:workbook xmlns:q="${main}" xmlns:rel="${docRel}"><q:sheets><q:sheet name="One" sheetId="1" rel:id="rId1"/></q:sheets></q:workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<ns0:Relationships xmlns:ns0="${pkgRel}"><ns0:Relationship Id="rId1" Target="worksheets/sheet1.xml"/></ns0:Relationships>`),
      "xl/worksheets/sheet1.xml": strToU8(`<w:worksheet xmlns:w="${main}"><w:sheetData><w:row r="1"><w:c r="A1" t="s"><w:v>0</w:v></w:c><w:c r="B1"><w:f>1+1</w:f><w:v>2</w:v></w:c></w:row></w:sheetData></w:worksheet>`),
      "xl/sharedStrings.xml": strToU8(`<x:sst xmlns:x="${main}"><x:si><x:t>hello</x:t></x:si></x:sst>`),
    });
    const a = readWorkbookSnapshot(plain);
    const b = readWorkbookSnapshot(prefixed);
    assert.equal(digest(a).cells, 2);
    assert.deepEqual(digest(b), digest(a));
    assert.equal(b.sheets[0]!.cells.get("A1")!.value, "hello");
    assert.equal(b.sheets[0]!.cells.get("B1")!.formula, "1+1");
  });

  it("a prefix bound to some other namespace is not the workbook element", () => {
    const docRel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const book = zipSync({
      "xl/workbook.xml": strToU8(`<s:workbook xmlns:s="urn:not-spreadsheetml" xmlns:r="${docRel}"><s:sheets><s:sheet name="One" r:id="rId1"/></s:sheets></s:workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`),
    });
    assert.throws(() => readWorkbookSnapshot(book), /workbook/);
  });
});

describe("a workbook the reader cannot fully parse is unreadable, never empty or partial", () => {
  it("throws when the workbook element is missing", async () => {
    const book = await altered("codex-S0", { "xl/workbook.xml": `<?xml version="1.0"?><notaworkbook/>` });
    assert.throws(() => readWorkbookSnapshot(book), /workbook/);
  });

  it("throws when workbook.xml is missing, empty, or cut off", async () => {
    assert.throws(() => readWorkbookSnapshot(Buffer.from("")), Error);
    for (const text of [null, "", "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheets><sheet name=\"A\" r:id=\"rId1\""]) {
      const book = await altered("codex-S0", { "xl/workbook.xml": text });
      assert.throws(() => readWorkbookSnapshot(book), Error, `workbook.xml = ${JSON.stringify(text)}`);
    }
  });

  it("throws when a sheet named in workbook.xml has no reachable part", async () => {
    const noSheet = unzipAndDrop(await bytesOf("codex-S0"), "xl/worksheets/sheet2.xml");
    assert.throws(() => readWorkbookSnapshot(noSheet), /sheet2\.xml/);
    const noRels = await altered("codex-S0", { "xl/_rels/workbook.xml.rels": null });
    assert.throws(() => readWorkbookSnapshot(noRels), Error);
  });

  it("throws when the sheets element is missing or empty", async () => {
    const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    for (const body of ["", "<sheets/>"]) {
      const book = await altered("codex-S0", { "xl/workbook.xml": `<workbook xmlns="${main}">${body}</workbook>` });
      assert.throws(() => readWorkbookSnapshot(book), Error, `body ${body}`);
    }
  });

  it("throws when a part is malformed", async () => {
    for (const part of ["xl/sharedStrings.xml", "xl/styles.xml", "xl/_rels/workbook.xml.rels"]) {
      const good = new TextDecoder().decode(unzipSync(await bytesOf("codex-S0"))[part]!);
      const book = await altered("codex-S0", { [part]: good.slice(0, Math.floor(good.length / 2)) });
      assert.throws(() => readWorkbookSnapshot(book), Error, part);
    }
  });

  it("throws when a shared-string cell points past the shared strings", async () => {
    const book = await altered("codex-S0", { "xl/sharedStrings.xml": null });
    assert.throws(() => readWorkbookSnapshot(book), /shared string/);
  });
});

function unzipAndDrop(bytes: Uint8Array, part: string): Uint8Array {
  const parts = unzipSync(bytes);
  delete parts[part];
  return zipSync(parts, { mtime: ZIP_MTIME });
}

describe("the Claude-leg snapshots read unchanged", () => {
  // Digests taken from the reader; the snapshots were rebuilt from a CoCheck-made workbook (sheet and cell counts unchanged; only the sha moved).
  const expected: Record<string, { sheets: number; cells: number; sha: string }> = {
    "claude-S0": { sheets: 16, cells: 9387, sha: "2fad6bb4028538e6" },
    "claude-S1": { sheets: 17, cells: 9411, sha: "17a3c3e157a5832a" },
    "claude-S3": { sheets: 18, cells: 9444, sha: "22b255febf70da84" },
    "claude-S4": { sheets: 18, cells: 9448, sha: "cee9a07876545b58" },
    "codex-S0": { sheets: 16, cells: 9387, sha: "2fad6bb4028538e6" },
    "codex-S2": { sheets: 17, cells: 9411, sha: "9fc99ec46b297477" },
  };
  for (const [name, want] of Object.entries(expected)) {
    it(name, async () => {
      assert.deepEqual(digest(readWorkbookSnapshot(await bytesOf(name))), want);
    });
  }
});

describe("what the review page shows for the rerun", () => {
  it("S0 to S1 is the agent's 29 cells, not 9,387 blanks", async () => {
    const rows = await diffBytes("codex-S0", "codex-S1");
    assert.equal(rows.length, 29);
    assert.ok(rows.every((r) => !r.wholeFile));
  });

  it("S1 to S2 and S1b to S2 hold no phantom rows: only what the agent and the user changed", async () => {
    const fromS0 = await diffBytes("codex-S0", "codex-S2");
    for (const before of ["codex-S1", "codex-S1b"]) {
      const rows = await diffBytes(before, "codex-S2");
      assert.ok(rows.length <= fromS0.length, `${before} to S2: ${rows.length} rows against ${fromS0.length} from S0`);
      assert.ok(rows.length < 100, `${before} to S2: ${rows.length} rows`);
    }
  });

  it("a workbook with its workbook element removed is one unreadable row and no cell rows", async () => {
    const broken = await altered("codex-S0", { "xl/workbook.xml": `<?xml version="1.0"?><notaworkbook/>` });
    for (const [before, after] of [["codex-S0", broken], [broken, "codex-S0"]] as const) {
      const rows = await diffBytes(before, after);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.wholeFile, true);
      assert.equal(layer.describe(rows[0]!), UNREADABLE);
    }
  });

  it("a workbook with a sheet part missing is one unreadable row", async () => {
    const rows = await diffBytes("codex-S0", unzipAndDrop(await bytesOf("codex-S1"), "xl/worksheets/sheet5.xml"));
    assert.equal(rows.length, 1);
    assert.equal(layer.describe(rows[0]!), UNREADABLE);
  });
});

describe("every part the reader consumes is checked whole, sheet parts included", () => {
  const SHEET = "xl/worksheets/sheet1.xml";
  const sheetText = async (): Promise<string> => new TextDecoder().decode(unzipSync(await bytesOf("claude-S1"))[SHEET]!);

  async function variants(): Promise<Record<string, Uint8Array>> {
    const good = await sheetText();
    const dropTwo = good.replace("</c>", "").replace("</c>", "");
    assert.notEqual(dropTwo, good);
    const garbage = good.replace("<sheetData>", "<sheetData>%%garbage<<>>&&");
    assert.notEqual(garbage, good);
    const textGarbage = good.replace("<sheetData>", "<sheetData>just some words");
    const noData = good.replace(/<sheetData>[\s\S]*<\/sheetData>/, "");
    assert.notEqual(noData, good);
    const selfClosed = good.replace(/<sheetData>[\s\S]*<\/sheetData>/, "<sheetData/>");
    const noEnd = good.replace("</worksheet>", "");
    assert.notEqual(noEnd, good);
    const twoData = good.replace("</worksheet>", "<sheetData/></worksheet>");
    const out: Record<string, Uint8Array> = {};
    const cases = { dropTwo, garbage, textGarbage, noData, selfClosed, noEnd, twoData };
    for (const [k, v] of Object.entries(cases)) out[k] = await altered("claude-S1", { [SHEET]: v });
    return out;
  }

  it("the reader throws for each malformed sheet: two </c> gone, garbage in sheetData, no sheetData, no </worksheet>, a second sheetData", async () => {
    for (const [name, book] of Object.entries(await variants())) {
      if (name === "selfClosed") continue; // well-formed and empty: reads as an empty sheet (next test)
      assert.throws(() => readWorkbookSnapshot(book), /xlsx:/, name);
    }
  });

  it("a self-closed sheetData in an otherwise well-formed sheet is an empty sheet, not an error", async () => {
    const good = await sheetText();
    const book = await altered("claude-S1", { [SHEET]: good.replace(/<sheetData>[\s\S]*<\/sheetData>/, "<sheetData />") });
    assert.equal(readWorkbookSnapshot(book).sheets[0]!.cells.size, 0);
  });

  it("each broken sheet is one unreadable row and zero cell rows, in both directions", async () => {
    for (const [name, book] of Object.entries(await variants())) {
      if (name === "selfClosed") continue; // well-formed and empty: reads, and diffs as the cells removed
      for (const [before, after] of [["claude-S1", book], [book, "claude-S1"]] as const) {
        const rows = await diffBytes(before, after);
        assert.equal(rows.length, 1, name);
        assert.equal(rows[0]!.wholeFile, true, name);
        assert.equal(layer.describe(rows[0]!), UNREADABLE, name);
      }
    }
  });

  // The TaskStore's last-readable-baseline branch is deleted, so only the xlsx layer's answer for each broken sheet is pinned.
});
