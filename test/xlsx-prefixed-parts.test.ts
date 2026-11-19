import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, unzipSync, zipSync } from "fflate";
import { isoDateSerial, readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";

/**
 * A workbook whose SpreadsheetML parts are all `x:`-prefixed (Codex's artifact-tool) reads like any other.
 * The fixture is that file cut to a few rows per sheet; every part is otherwise as written.
 */
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "xlsx-prefixed-series-trimmed.xlsx");
const bytes = (): Uint8Array => new Uint8Array(readFileSync(FIXTURE));
const without = (parts: Record<string, Uint8Array>): Uint8Array => zipSync(parts);
const withPart = (name: string, text: string): Uint8Array => without({ ...unzipSync(bytes()), [name]: strToU8(text) });

// 1947-01-01 in the 1900 date system
const SERIAL_1947_01_01 = 17168;

describe("prefixed SpreadsheetML parts", () => {
  it("the snapshot reader reads t=\"d\" as the same serial, with no NaN", () => {
    const snap = readWorkbookSnapshot(bytes());
    const a6 = snap.sheets.find((s) => s.name === "GDP")!.cells.get("A6")!;
    assert.equal(a6.value, SERIAL_1947_01_01);
    for (const sheet of snap.sheets) for (const c of sheet.cells.values()) assert.ok(typeof c.value !== "number" || !Number.isNaN(c.value), `${sheet.name}!${c.address}`);
  });

});

describe("t=\"d\" date cells", () => {
  const sheetWith = (cell: string, workbookPr = ""): Uint8Array => {
    const parts = unzipSync(bytes());
    parts["xl/workbook.xml"] = strToU8(new TextDecoder().decode(parts["xl/workbook.xml"]!).replace("<x:sheets>", `${workbookPr}<x:sheets>`));
    parts["xl/worksheets/sheet2.xml"] = strToU8(new TextDecoder().decode(parts["xl/worksheets/sheet2.xml"]!).replace(/<x:c r="A6".*?<\/x:c>/, cell));
    return without(parts);
  };
  // The snapshot reader is the only reader; the pair shape is kept so each case still reads as before.
  const both = (buf: Uint8Array): [unknown, unknown] => {
    const v = readWorkbookSnapshot(buf).sheets[1]!.cells.get("A6")?.value ?? null;
    return [v, v];
  };

  it("equals the serial an Excel resave writes, in both readers", () => {
    const date = both(sheetWith('<x:c r="A6" s="26" t="d"><x:v>2024-01-01</x:v></x:c>'));
    const serial = both(sheetWith('<x:c r="A6" s="26"><x:v>45292</x:v></x:c>'));
    assert.deepEqual(date, [45292, 45292]);
    assert.deepEqual(serial, date);
  });

  it("follows the workbook's date system", () => {
    const [a, b] = both(sheetWith('<x:c r="A6" s="26" t="d"><x:v>2024-01-01</x:v></x:c>', '<x:workbookPr date1904="1" />'));
    assert.equal(a, 45292 - 1462);
    assert.equal(b, 45292 - 1462);
  });

  it("a real date edit still produces a different value", () => {
    const one = both(sheetWith('<x:c r="A6" s="26" t="d"><x:v>2024-01-01</x:v></x:c>'));
    const two = both(sheetWith('<x:c r="A6" s="26" t="d"><x:v>2024-01-02</x:v></x:c>'));
    assert.notDeepEqual(one, two);
  });

  it("an unparsable date stays text, never NaN and never a number", () => {
    for (const junk of ["not a date", "2024-13-45", "2024-02-30", "", "0001-01-01"]) {
      const [a, b] = both(sheetWith(`<x:c r="A6" s="26" t="d"><x:v>${junk}</x:v></x:c>`));
      for (const v of [a, b]) assert.ok(v === null || v === junk, `${junk} -> ${String(v)}`);
    }
    assert.equal(isoDateSerial("2024-02-30", 1900), null);
  });

  it("a non-numeric plain value is never NaN in the snapshot", () => {
    const [, b] = both(sheetWith('<x:c r="A6" s="26"><x:v>12abc</x:v></x:c>'));
    assert.ok(!(typeof b === "number" && Number.isNaN(b)));
  });

  it("serials around 1900 follow Excel's leap-year quirk", () => {
    assert.equal(isoDateSerial("1900-01-01", 1900), 1);
    assert.equal(isoDateSerial("1900-03-01", 1900), 61);
    assert.equal(isoDateSerial("2024-01-01T12:00:00Z", 1900), 45292.5);
  });
});
