import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACCEPTED_TOKEN_KINDS, builtinCode, showNumber, showText, tokenKindsOf } from "../src/office/connector/xlsx/numfmt.ts";

// The expected text of every case is LibreOffice's CSV export with "save cell content as shown"
// (the test reads the committed files and does not need LibreOffice). The formatter under test is not
// consulted for any expected value. Built-in ids 14 and 22 follow the Mac's region and are covered in numfmt.test.ts.
// The fixture is frozen: a new case is added by hand.
process.env.COCHECK_LOCALE = "en-US";

const DIR = path.join(import.meta.dirname, "fixtures", "numfmt");

interface Case {
  code?: string;
  id?: number;
  value: number | string;
}

/** A tiny RFC 4180 reader: one field per line is all the oracle holds, but a quoted field may carry commas and quotes. */
function lines(csv: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === "\n") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur !== "") out.push(cur);
  return out;
}

/**
 * Real Microsoft Excel output (test/fixtures/numfmt/excel-real.json; its "source" names the version and how it was read) for the cases
 * where LibreOffice and Excel were suspected to differ, plus controls. Our text must equal Excel's. Where Excel differs from
 * LibreOffice that is the Excel text we assert; where it agrees, the generic LibreOffice check below holds as well.
 */
const EXCEL = JSON.parse(readFileSync(path.join(DIR, "excel-real.json"), "utf8")) as { source: string; cases: Array<{ key: string; excel: string }> };
const EXCEL_DIFFERS: Record<string, { excel: string }> = Object.fromEntries(EXCEL.cases.map((c) => [c.key, { excel: c.excel }]));

function check(name: string, date1904: boolean): { cases: Case[]; seen: Set<string>; differs: Set<string> } {
  const cases = JSON.parse(readFileSync(path.join(DIR, `${name}.cases.json`), "utf8")) as Case[];
  // LibreOffice pads a "?" with U+2007 (figure space); Excel's text is a plain space.
  const expected = lines(readFileSync(path.join(DIR, `${name}.csv`), "utf8")).map((l) => l.replace(/ /g, " "));
  // no workbook reader is involved; the cases' own code and value go straight to the formatter under test.
  const dateSystem = date1904 ? 1904 : 1900;
  assert.equal(expected.length, cases.length, "one oracle line per case");
  const seen = new Set<string>();
  const differs = new Set<string>();
  cases.forEach((c, i) => {
    const code = c.code ?? builtinCode(c.id!) ?? `built-in format ${c.id}`;
    const key = `${c.id !== undefined ? `#${c.id}` : c.code}|${c.value}`;
    const got = typeof c.value === "string" ? showText(c.value, code) : showNumber(c.value, code, { dateSystem }).text;
    const known = EXCEL_DIFFERS[key];
    if (known) {
      seen.add(key);
      assert.equal(got, known.excel, `${key}: Excel text`);
      if (known.excel !== expected[i]) differs.add(key);
    } else {
      assert.equal(got, expected[i], `row ${i + 1}: ${key}`);
    }
  });
  return { cases, seen, differs };
}

describe("number formats against the LibreOffice oracle", () => {
  it("the fixture holds at least 40 distinct format codes", () => {
    const cases = JSON.parse(readFileSync(path.join(DIR, "oracle.cases.json"), "utf8")) as Case[];
    const formats = new Set(cases.map((c) => (c.id !== undefined ? `#${c.id}` : `=${c.code}`)));
    assert.ok(formats.size >= 40, `only ${formats.size} formats`);
  });

  it("every case shows the text LibreOffice exports, except where real Excel differs", () => {
    const { seen, differs } = check("oracle", false);
    assert.match(EXCEL.source, /Microsoft Excel for Mac \d+\.\d+/);
    assert.ok(seen.size >= 10, "real Excel text was compared for the suspect cases");
    assert.ok(seen.size >= 14, `${seen.size} of ${EXCEL.cases.length} Excel cases are in the oracle workbook`);
    assert.ok(differs.size >= 8, `${differs.size} cases where Excel differs from LibreOffice`);
  });

  it("every token kind the parser accepts has an oracle case (LibreOffice, or real Excel for the cases in excel-real.json)", () => {
    const cases = JSON.parse(readFileSync(path.join(DIR, "oracle.cases.json"), "utf8")) as Case[];
    const covered = new Map<string, string>();
    for (const c of cases) {
      const code = c.code ?? builtinCode(c.id!);
      if (code === null || code === undefined) continue;
      for (const kind of tokenKindsOf(code)) if (!covered.has(kind)) covered.set(kind, `${code} (${c.value})`);
    }
    const missing = ACCEPTED_TOKEN_KINDS.filter((k) => !covered.has(k));
    assert.deepEqual(missing, [], `token kinds with no oracle case: ${missing.join(", ")}`);
    // The list itself is exhaustive: no kind the parser reports is missing from it.
    for (const kind of covered.keys()) assert.ok(ACCEPTED_TOKEN_KINDS.includes(kind), kind);
    if (process.env.PRINT_TOKEN_COVERAGE) for (const k of ACCEPTED_TOKEN_KINDS) console.log(`${k}\t${covered.get(k)}`);
  });

  it("codes whose output is not certain are shown unformatted, never guessed", () => {
    const un = (value: number, code: string) => assert.deepEqual([showNumber(value, code).exact, showNumber(value, code).text], [false, String(value)], code);
    un(12345, "E+00"); // an exponent with no digit placeholder
    un(5, "");
    un(5, "   ");
    un(5, "0.0General");
    un(5, "0*x");
    un(5, "0*-"); // a non-space fill repeats to the column width
    un(0.6, "hh:mm A/P"); // LibreOffice and Excel's documentation disagree on its case
    un(0.6, "h:mm am/pm");
    un(0.5034722, "h:mm"); // 12:04:59.5 shows 12:04 or 12:05 depending on the rounding Excel uses
  });

  it("the 1904 date system shows the same serials 1462 days later", () => {
    check("oracle-1904", true);
  });
});
