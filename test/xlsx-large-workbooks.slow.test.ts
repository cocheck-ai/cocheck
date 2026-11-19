import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, unzipSync, zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { createXlsxLayer, DIFF_LIMITS } from "../src/office/connector/xlsx/layer.ts";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";
import { changedOutsideWording } from "../src/fingerprint.ts";

// Fixed so two builds of the same workbook are byte-identical; fflate stamps the current time (2 s granularity) otherwise.
const ZIP_MTIME = new Date(2020, 0, 1);

/**
 * Workbooks of realistic size in a watched folder. The heavy cases run in a child process capped
 * at `HEAP_MB` of heap, so running out of memory fails the test instead of killing the runner;
 * the child is this same file, switched by `LARGE_CASE`.
 */
const HEAP_MB = 500;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

/**
 * An `n`-row, 3-column workbook built as raw XML: A a number, B a shared string, C `=A*2` with
 * its cached result. `edit` changes A (and C's cached value) on that row; `cols` adds a column
 * width, as a hand resize in Excel would.
 */
function bigBook(n: number, options: { edit?: number; cols?: boolean } = {}): Uint8Array {
  const rows: string[] = [];
  const strings: string[] = [];
  for (let r = 1; r <= n; r++) {
    const a = r === options.edit ? -r : r * 3 + 0.25;
    strings.push(`<si><t>Item ${r}</t></si>`);
    rows.push(`<row r="${r}"><c r="A${r}"><v>${a}</v></c><c r="B${r}" t="s"><v>${r - 1}</v></c><c r="C${r}"><f>A${r}*2</f><v>${a * 2}</v></c></row>`);
  }
  const cols = options.cols ? `<cols><col min="1" max="1" width="31.5" customWidth="1"/></cols>` : "";
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows.join("")}</sheetData></worksheet>`;
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${n}" uniqueCount="${n}">${strings.join("")}</sst>`;
  return zipSync({
    "xl/workbook.xml": strToU8(WORKBOOK_XML),
    "xl/_rels/workbook.xml.rels": strToU8(WORKBOOK_RELS),
    "xl/sharedStrings.xml": strToU8(sst),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  }, { mtime: ZIP_MTIME });
}

/** A one-sheet workbook whose sheet part is `<worksheet>` around `body`, plus any `extra` parts. */
function rawBook(body: string, extra: Record<string, string> = {}): Uint8Array {
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${body}</worksheet>`;
  const parts: Record<string, Uint8Array> = {
    "xl/workbook.xml": strToU8(WORKBOOK_XML),
    "xl/_rels/workbook.xml.rels": strToU8(WORKBOOK_RELS),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  };
  for (const [name, text] of Object.entries(extra)) {
    parts[name] = strToU8(text);
  }
  return zipSync(parts, { mtime: ZIP_MTIME });
}

/**
 * A `rows` x `cols` sheet, the shape of a wide model: odd columns numbers, even columns a formula
 * on the cell to their left with its cached result. `edit` negates the number at that [row, col]
 * (an odd column), and its neighbour's cached result with it.
 */
function wideBook(rows: number, cols: number, edit?: [number, number]): Uint8Array {
  const letters = (c: number): string => (c > 26 ? letters(Math.floor((c - 1) / 26)) : "") + String.fromCharCode(65 + ((c - 1) % 26));
  const names = Array.from({ length: cols }, (_, i) => letters(i + 1));
  const out: string[] = [];
  for (let r = 1; r <= rows; r++) {
    const cells = names.map((n, i) => {
      const col = i % 2 === 0 ? i + 1 : i;
      const v = (r * 1000 + col) * (edit && edit[0] === r && edit[1] === col ? -1 : 1);
      return i % 2 === 0
        ? `<c r="${n}${r}" s="1"><v>${v}</v></c>`
        : `<c r="${n}${r}" s="1"><f>${names[i - 1]}${r}*2</f><v>${v * 2}</v></c>`;
    });
    out.push(`<row r="${r}">${cells.join("")}</row>`);
  }
  return rawBook(`<sheetData>${out.join("")}</sheetData>`);
}

async function setup(limits = DIFF_LIMITS) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-large-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-large-folder-")));
  const ledger = openLedger(home);
  const layers = [createXlsxLayer({ openState: async () => "closed" }, limits), createFilesLayer()];
  const tasks = new TaskStore(ledger, home, layers);
  const cleanup = async () => {
    ledger.close();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  };
  return { tasks, ledger, folder, cleanup };
}

/**
 * These cases call the layer's `diff` on the two files, the one reader the timeline still uses.
 * `status` is what the row gets with no op touching it: "derived" for a derivable row, else "unlogged".
 */
async function diffRows(limits: typeof DIFF_LIMITS, before: Uint8Array, after: Uint8Array): Promise<Array<{ status: string; kind: string; description: string }>> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-large-diff-")));
  try {
    const a = path.join(dir, "a.xlsx");
    const b = path.join(dir, "b.xlsx");
    await writeFile(a, before);
    await writeFile(b, after);
    const layer = createXlsxLayer({ openState: async () => "closed" }, limits);
    return (await layer.diff(a, b)).map((row) => ({ status: row.derivable ? "derived" : "unlogged", kind: row.kind, description: layer.describe(row) }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What a child case reports back on its last stdout line. */
interface ChildResult {
  submitMs: number;
  peakHeapMb: number;
  rows: Array<{ status: string; kind: string; description: string }>;
}

/** Runs `fn` with heap sampled every few ms and on each call to the returned `sample`. */
async function measured(fn: (sample: () => void) => Promise<ChildResult["rows"]>): Promise<ChildResult> {
  let peak = 0;
  const sample = () => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  };
  const timer = setInterval(sample, 5);
  const start = performance.now();
  const rows = await fn(sample);
  const submitMs = performance.now() - start;
  clearInterval(timer);
  sample();
  return { submitMs, peakHeapMb: Math.round(peak / 1048576), rows };
}

const CASES: Record<string, () => Promise<ChildResult>> = {
  /** Three unchanged 100,000-row workbooks among 197 text files: 200 watched files. */
  async unchanged() {
    const { tasks, folder, cleanup } = await setup();
    const books = ["a.xlsx", "b.xlsx", "c.xlsx"].map((name) => path.join(folder, name));
    for (const book of books) {
      await writeFile(book, bigBook(100_000));
    }
    for (let i = 0; i < 197; i++) {
      await writeFile(path.join(folder, `note-${i}.txt`), `note ${i}\n`);
    }
    await tasks.touch("c", books[0]!);
    const result = await measured(async () => {
      const summary = await tasks.submit("c", "nothing changed", false);
      return summary.rows;
    });
    await cleanup();
    return result;
  },

  /** A 150,000-row workbook with one input edited by hand. */
  async changed() {
    const before = bigBook(150_000);
    const after = bigBook(150_000, { edit: 75_000 });
    return measured(() => diffRows(DIFF_LIMITS, before, after));
  },

  /** A 1,000-row x 550-column workbook (550,000 cells, under the limits) with one cell edited. */
  async wide() {
    const before = wideBook(1000, 550);
    const after = wideBook(1000, 550, [500, 301]);
    return measured(() => diffRows(DIFF_LIMITS, before, after));
  },
};

const childCase = process.env.LARGE_CASE;
if (childCase !== undefined) {
  const result = await CASES[childCase]!();
  process.stdout.write(`\n${JSON.stringify(result)}\n`);
} else {
  describe("large workbooks at submit", () => {
    function runChild(name: string): ChildResult {
      const child = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, fileURLToPath(import.meta.url)], {
        env: { ...process.env, LARGE_CASE: name },
        encoding: "utf8",
        maxBuffer: 16 * 1048576,
      });
      const last = child.stdout.trim().split("\n").at(-1) ?? "";
      assert.equal(child.status, 0, `child "${name}" exited ${child.status} (${child.signal ?? "no signal"}):\n${child.stderr.slice(0, 2000)}`);
      return JSON.parse(last) as ChildResult;
    }

    it(`three unchanged 100,000-row workbooks in a 200-file folder submit in under 5 s and ${HEAP_MB} MB of heap`, () => {
      const result = runChild("unchanged");
      assert.deepEqual(result.rows, []);
      assert.ok(result.submitMs < 5000, `submit took ${Math.round(result.submitMs)} ms`);
      assert.ok(result.peakHeapMb < HEAP_MB, `heap peaked at ${result.peakHeapMb} MB`);
    });

    it(`a changed 150,000-row workbook diffs within ${HEAP_MB} MB of heap and shows the edit`, () => {
      const result = runChild("changed");
      assert.deepEqual(
        result.rows.map((r) => [r.status, r.description]),
        [
          ["unlogged", "Sheet1!A75000: 225000.25 -> -75000"],
          ["derived", "Sheet1!C75000: 450000.5 -> -150000"],
        ],
      );
    });

    it(`a 1,000-row x 550-column workbook diffs within ${HEAP_MB} MB of heap`, () => {
      const result = runChild("wide");
      // Columns 301/302 are KO/KP. The check also accepts a "too large" row, but under the limits it diffs.
      assert.deepEqual(
        result.rows.map((r) => [r.status, r.description]),
        [
          ["unlogged", "Sheet1!KO500: 500301 -> -500301"],
          ["derived", "Sheet1!KP500: 1000602 -> -1000602"],
        ],
      );
      assert.ok(result.peakHeapMb < HEAP_MB, `heap peaked at ${result.peakHeapMb} MB`);
    });
  });

  describe("sheets with no cell data", () => {
    const spellings: Array<[string, string]> = [
      ["<sheetData />", "<sheetData />"],
      ["<sheetData/>", "<sheetData/>"],
      ["an empty pair", "<sheetData></sheetData>"],
    ];
    for (const [name, body] of spellings) {
      it(`reads ${name} as a sheet with no cells`, () => {
        const snapshot = readWorkbookSnapshot(rawBook(body), DIFF_LIMITS);
        assert.deepEqual(snapshot.sheets.map((s) => [s.name, s.cells.size]), [["Sheet1", 0]]);
      });
    }

    it("a worksheet with no sheetData element is unreadable, not an empty sheet", () => {
      assert.throws(() => readWorkbookSnapshot(rawBook(`<dimension ref="A1"/>`), DIFF_LIMITS), /sheetData/);
    });

    it("a sheet that gains a cell after <sheetData /> shows the cell", async () => {
      const rows = await diffRows(DIFF_LIMITS, rawBook("<sheetData />"), rawBook(`<sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData>`));
      assert.deepEqual(rows.map((r) => r.description), ["Sheet1 1:1: row inserted", "Sheet1!A1: null -> 7"]);
    });

    it("a new workbook with no cells is one row", async () => {
      const { folder, cleanup } = await setup();
      const layer = createXlsxLayer({ openState: async () => "closed" }, DIFF_LIMITS);
      const empty = path.join(folder, "Empty.xlsx");
      await writeFile(empty, rawBook("<sheetData/>"));
      const rows = await layer.diff(null, empty);
      assert.deepEqual(rows.map((r) => layer.describe(r)), ["new workbook, with no cells yet"]);
      await cleanup();
    });
  });

  describe("a workbook CoCheck can't read", () => {
    it("a sheet cut off mid-data is one plain unlogged row, and the diff doesn't throw", async () => {
      const rows = await diffRows(DIFF_LIMITS, bigBook(3), rawBook(`<sheetData><row r="1"><c r="A1"><v>1</v></c></row>`));
      assert.deepEqual(
        rows.map((r) => [r.status, r.kind, r.description]),
        [["unlogged", "file changed", "CoCheck can't read this file; open it in Excel to check it still opens"]],
      );
    });
  });

  describe("a hand-typed value over a formula", () => {
    it("says both sides in words", async () => {
      const rows = await diffRows(
        DIFF_LIMITS,
        rawBook(`<sheetData><row r="5000"><c r="A5000"><f>ROW()*3</f><v>15000</v></c></row></sheetData>`),
        rawBook(`<sheetData><row r="5000"><c r="A5000"><v>999</v></c></row></sheetData>`),
      );
      assert.deepEqual(rows.map((r) => r.description), ["Sheet1!A5000: was formula =ROW()*3 (15000), now 999"]);
    });
  });

  describe("a workbook whose bytes change with no cell changing", () => {
    it("a hand column-width change in a second workbook is one fingerprint-only row", async () => {
      const { tasks, folder, cleanup } = await setup();
      const main = path.join(folder, "main.xlsx");
      const other = path.join(folder, "other.xlsx");
      await writeFile(main, bigBook(3));
      await writeFile(other, bigBook(3));
      await tasks.touch("c", main);
      await writeFile(other, bigBook(3, { cols: true }));
      const summary = await tasks.submit("c", "widened a column", false);
      assert.deepEqual(
        summary.rows.map((r) => [path.basename(r.file), r.status, r.kind, r.description]),
        [[
          "other.xlsx",
          "unlogged",
          "changed outside CoCheck",
          changedOutsideWording(),
        ]],
      );
      await cleanup();
    });

    it("an extra part in an untouched workbook is a 'file changed' row", async () => {
      const { tasks, folder, cleanup } = await setup();
      const main = path.join(folder, "main.xlsx");
      const other = path.join(folder, "other.xlsx");
      await writeFile(main, bigBook(3));
      await writeFile(other, bigBook(3));
      await tasks.touch("c", main);
      const parts = unzipSync(bigBook(3));
      await writeFile(other, zipSync({ ...parts, "customXml/item1.xml": strToU8("<Properties/>") }, { mtime: ZIP_MTIME }));
      const summary = await tasks.submit("c", "added a part", false);
      assert.deepEqual(summary.rows.map((r) => [path.basename(r.file), r.kind]), [["other.xlsx", "changed outside CoCheck"]]);
      await cleanup();
    });
  });

  describe("an Excel re-save that only moves docProps", () => {
    const props = (at: string) => ({
      "docProps/core.xml": `<cp:coreProperties xmlns:cp="c" xmlns:dcterms="d"><dcterms:modified>${at}</dcterms:modified></cp:coreProperties>`,
      "docProps/app.xml": `<Properties><AppVersion>16.0${at.slice(-3, -1)}</AppVersion></Properties>`,
    });
    const body = `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>`;

    it("produces no row", async () => {
      const { tasks, folder, cleanup } = await setup();
      const book = path.join(folder, "Saved.xlsx");
      await writeFile(book, rawBook(body, props("2026-09-28T10:00:00Z")));
      await tasks.touch("c", book);
      await writeFile(book, rawBook(body, props("2026-09-29T11:30:12Z")));
      const summary = await tasks.submit("c", "re-saved", false);
      assert.deepEqual(summary.rows, []);
      await cleanup();
    });

    it("produces no row for a workbook past the limits either", async () => {
      const { tasks, folder, cleanup } = await setup({ maxCells: 10, maxUnzippedBytes: DIFF_LIMITS.maxUnzippedBytes });
      const book = path.join(folder, "Saved.xlsx");
      const big = unzipSync(bigBook(5));
      const core = (n: number) => `<cp:coreProperties xmlns:cp="c" xmlns:dcterms="d"><dcterms:modified>2026-09-2${n}T10:00:00Z</dcterms:modified></cp:coreProperties>`;
      await writeFile(book, zipSync({ ...big, "docProps/core.xml": strToU8(core(1)) }, { mtime: ZIP_MTIME }));
      await tasks.touch("c", book);
      await writeFile(book, zipSync({ ...big, "docProps/core.xml": strToU8(core(2)) }, { mtime: ZIP_MTIME }));
      const summary = await tasks.submit("c", "re-saved", false);
      assert.deepEqual(summary.rows, []);
      await cleanup();
    });
  });

  describe("a workbook past the diff limits", () => {
    const small = { maxCells: 10, maxUnzippedBytes: DIFF_LIMITS.maxUnzippedBytes };

    it("is one unlogged 'too large' row in plain words", async () => {
      const rows = await diffRows(small, bigBook(5), bigBook(5, { edit: 2 }));
      assert.deepEqual(
        rows.map((r) => [r.status, r.kind, r.description]),
        [["unlogged", "too large", "workbook changed, but it's too large to compare cell by cell (over 10 cells); open it to check"]],
      );
    });

    it("an unchanged workbook past the limits is skipped without a row", async () => {
      const { tasks, folder, cleanup } = await setup(small);
      const book = path.join(folder, "Budget.xlsx");
      await writeFile(book, bigBook(5));
      await tasks.touch("c", book);
      const summary = await tasks.submit("c", "nothing", false);
      assert.deepEqual(summary.rows, []);
      await cleanup();
    });
  });
}
