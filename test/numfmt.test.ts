import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatValue, beforeAfterText } from "./helpers/xlsx-shown.ts";
import { EN_US, localeFor, showNumber, showText, SYSTEM_SHORT_DATE } from "../src/office/connector/xlsx/numfmt.ts";

// every cell shows what Excel shows. (the cases that drew a workbook through core's grid reader went with that reader.) The LibreOffice oracle lives in numfmt-oracle.test.ts; these are the cases that
// need no oracle: the recorded repro, the guard against a value in a wrong format, the 1904 system, the Mac's region, notes.
process.env.COCHECK_LOCALE = "en-US";

describe("a value is never shown in a wrong format", () => {
  it("day and month are never swapped: the code decides the order", () => {
    assert.equal(showNumber(45413, "dd/mm/yyyy", { locale: EN_US }).text, "01/05/2024");
    assert.equal(showNumber(45413, "mm/dd/yyyy", { locale: EN_US }).text, "05/01/2024");
    assert.equal(showNumber(45427, "d/m/yyyy", { locale: EN_US }).text, "15/5/2024");
  });

  it("a custom code that spells m/d/yyyy stays month-first on a day-first Mac; only the built-in ids follow the Mac", () => {
    const gb = localeFor("en-GB");
    assert.equal(showNumber(45413, "m/d/yyyy", { locale: gb }).text, "5/1/2024");
    assert.equal(showNumber(45413, SYSTEM_SHORT_DATE, { locale: gb }).text, "01/05/2024");
    assert.equal(showNumber(45413, SYSTEM_SHORT_DATE, { locale: EN_US }).text, "5/1/2024");
    assert.equal(showNumber(45413, SYSTEM_SHORT_DATE, { locale: localeFor("de-DE") }).text, "01.05.2024");
  });

  it("rounds half away from zero on the 15-digit decimal, not on the binary double", () => {
    assert.equal(showNumber(2.675, "0.00").text, "2.68");
    assert.equal(showNumber(1.005, "0.00").text, "1.01");
    assert.equal(showNumber(0.125, "0.00").text, "0.13");
    assert.equal(showNumber(2.5, "0").text, "3");
    assert.equal(showNumber(-2.5, "0").text, "-3");
    assert.equal(showNumber(0.285, "0.0%").text, "28.5%");
  });

  it("a negative keeps its minus, also in front of a currency symbol but not when the digits round to zero", () => {
    assert.equal(showNumber(-5, '"$"#,##0.00').text, "-$5.00");
    assert.equal(showNumber(-1234.5, "#,##0.00").text, "-1,234.50");
    assert.equal(showNumber(-0.4, "0").text, "0"); // real Excel drops the minus when the digits round to zero
    assert.equal(showNumber(-5, "0.00;(0.00)").text, "(5.00)");
    assert.equal(showNumber(-5, "#,##0;[Red]-#,##0").text, "-5");
  });

  it("a code it cannot render exactly shows the stored value, marked, never a guess", () => {
    for (const [value, code] of [[45413, "[DBNum1]0"], [45413, "yyyy年m月d日 [$-411]ggge"], [-3, "[>0]0;[<-1]0.0"], [31, "built-in format 31"], [-1, "yyyy-mm-dd"], [3000000, "yyyy-mm-dd"], [5, "0 zz"], [5, "a/p/q"]] as const) {
      const r = showNumber(value, code);
      assert.equal(r.exact, false, code);
      assert.equal(r.text, String(value), code);
    }
  });

});

describe("the 1904 date system", () => {
  it("the weekday follows the system", () => {
    assert.equal(showNumber(43951, "dddd", { dateSystem: 1904, locale: EN_US }).text, "Wednesday");
    assert.equal(showNumber(45413, "dddd", { dateSystem: 1900, locale: EN_US }).text, "Wednesday");
  });
});

describe("General follows Excel's 11 characters", () => {
  it("switches to scientific at 1e11 and below 1e-4, and trims to 11 characters otherwise", () => {
    const g = (n: number) => showNumber(n, "General").text;
    assert.equal(g(12345678901), "12345678901");
    assert.equal(g(123456789012), "1.23457E+11");
    assert.equal(g(0.0001), "0.0001");
    assert.equal(g(0.00001234), "1.234E-05");
    assert.equal(g(Math.PI), "3.141592654");
    assert.equal(g(-Math.PI), "-3.141592654");
    assert.equal(g(0.1 + 0.2), "0.3");
    assert.equal(g(1e-9), "1E-09");
    assert.equal(g(123456789.123456), "123456789.1");
  });
});

describe("text under a number format", () => {
  it("applies the text section and leaves other strings alone", () => {
    assert.equal(showText("Who", '"Dr. "@'), "Dr. Who");
    assert.equal(showText("hello", '0;-0;0;"text: "@'), "text: hello");
    assert.equal(showText("hello", "0.00"), "hello");
    assert.equal(showText("hello", "General"), "hello");
  });
});

describe("notes quote the displayed text", () => {
  it("a date reads in the file's pattern, a percent as a percent, with the stored value only where the two disagree", () => {
    assert.equal(formatValue(17168, "yyyy-mm-dd"), "1947-01-01");
    assert.equal(formatValue(45413, "dd/mm/yyyy"), "01/05/2024");
    assert.equal(formatValue(0.0312, "0.0%"), "3.1% (stored 0.0312)");
    assert.equal(formatValue(0.031, "0.0%"), "3.1%");
    assert.equal(formatValue(1234.5, "#,##0.00"), "1,234.50");
    assert.equal(formatValue(45413.75, "yyyy-mm-dd"), "2024-05-01 (stored 45413.75)");
    assert.equal(formatValue(0.0312, "0.0%", true), "3.1% (stored 0.0312)");
  });

  it("a code it cannot render exactly is quoted unformatted, marked", () => {
    assert.equal(formatValue(45413, "[DBNum1]0"), "45413 (shown unformatted)");
    assert.equal(formatValue(45413, 31), "45413 (shown unformatted)");
  });

  it("before and after use the format of their own side", () => {
    assert.deepEqual(beforeAfterText(45413, 45414, "dd/mm/yyyy", "yyyy-mm-dd"), { before: "01/05/2024", after: "2024-05-02" });
    assert.deepEqual(beforeAfterText(1, 1 + 1e-9, "0", "0"), { before: "1", after: "1 (stored 1.000000001)" });
  });
});
