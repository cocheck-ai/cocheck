import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatValue, isDateFormat } from "./helpers/xlsx-shown.ts";

// the number format decides the text (the file's own pattern); the stored serial follows only where the text drops part of it.
process.env.COCHECK_LOCALE = "en-US";

describe("time-only formats render as a time, never an 1899 date", () => {
  it("h:mm, h:mm:ss and AM/PM formats show the time of day in their own pattern", () => {
    assert.equal(formatValue(0.5625, "h:mm"), "13:30");
    assert.equal(formatValue(0.5625, "h:mm:ss"), "13:30:00");
    assert.equal(formatValue(0.5625, "h:mm AM/PM"), "1:30 PM");
    assert.equal(formatValue(0.5625, 18), "1:30 PM");
    assert.equal(formatValue(0.5625, 21), "13:30:00");
  });
  it("a time-only cell with a whole-day part shows only the time of day, and says what it hides", () => {
    assert.equal(formatValue(45413.25, "h:mm"), "6:00 (stored 45413.25)");
  });
  it("mm:ss built-ins 45 and 47 are times", () => {
    assert.equal(formatValue(0.5625, 45), "30:00 (stored 0.5625)");
    assert.equal(isDateFormat(47), true);
  });
  it("m after h or before s is a minute, so h:mm and mm:ss are not dates", () => {
    assert.equal(formatValue(0.25, "mm:ss"), "00:00 (stored 0.25)");
    assert.equal(formatValue(45413.25, "yyyy-mm-dd hh:mm"), "2024-05-01 06:00");
  });
});

describe("elapsed formats render as elapsed time", () => {
  it("[h]:mm and [h]:mm:ss show total hours", () => {
    assert.equal(formatValue(1.5, "[h]:mm"), "36:00");
    assert.equal(formatValue(1.5, 46), "36:00:00");
    assert.equal(formatValue(3, "[h]:mm:ss"), "72:00:00");
  });
  it("[m]:ss shows total minutes, [s] total seconds", () => {
    assert.equal(formatValue(0.5, "[m]:ss"), "720:00");
    assert.equal(formatValue(0.5, "[s]"), "43200");
  });
});

describe("serials below 61 in the 1900 system render as Excel does", () => {
  it("serial 1 is 1900-01-01, 59 is 1900-02-28, 60 is the phantom 1900-02-29, 61 is 1900-03-01", () => {
    assert.equal(formatValue(1, "yyyy-mm-dd"), "1900-01-01");
    assert.equal(formatValue(59, "yyyy-mm-dd"), "1900-02-28");
    assert.equal(formatValue(60, "yyyy-mm-dd"), "1900-02-29");
    assert.equal(formatValue(61, "yyyy-mm-dd"), "1900-03-01");
  });
  it("serial 0 is Excel's 1900-01-00", () => {
    assert.equal(formatValue(0, "yyyy-mm-dd"), "1900-01-00");
  });
  it("the 1904 system has no quirk", () => {
    assert.equal(formatValue(1, "yyyy-mm-dd", false, 1904), "1904-01-02");
  });
});

describe("locale date built-ins", () => {
  it("27-36 and 50-58 are dates", () => {
    for (const id of [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]) {
      assert.equal(isDateFormat(id), true, `id ${id}`);
    }
    // Their patterns depend on the region and no code is known offline: drawn unformatted, never as a guessed date.
    assert.equal(formatValue(45413, 30), "45413 (shown unformatted)");
  });
  it("23-26, 37-44 and 48-49 are not dates", () => {
    for (const id of [0, 1, 2, 9, 10, 23, 24, 25, 26, 37, 44, 48, 49, 59]) assert.equal(isDateFormat(id), false, `id ${id}`);
  });
});

// No offline ECMA-376 18.8.30 table or CJK-locale Excel fixture exists, so the locale-dependent ids have no
// code CoCheck can state. They are dates by kind, but their pattern is unknown: every one shows the stored serial, marked.
describe("locale built-ins: no known code, shown unformatted", () => {
  for (const id of [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]) {
    it(`id ${id} shows the stored serial, marked, never a guessed date`, () => {
      assert.equal(formatValue(45413, id), "45413 (shown unformatted)");
      assert.equal(formatValue(45413.5625, id), "45413.5625 (shown unformatted)");
    });
  }
});

describe("a time part that rounds to a full day is not guessed", () => {
  // Rounding to the second carries into the next date, truncating does not, and Excel's choice for a format that shows no time is
  // unverified: such a cell is shown unformatted rather than as either date.
  it("59.99999999 under a date-only format is shown unformatted", () => {
    assert.equal(formatValue(59.99999999, "yyyy-mm-dd"), "59.99999999 (shown unformatted)");
  });
  it("45000.99999999 under a date-only format is shown unformatted; with seconds shown it carries as Excel rounds", () => {
    assert.equal(formatValue(45000.99999999, "yyyy-mm-dd"), "45000.99999999 (shown unformatted)");
    assert.equal(formatValue(45000.99999999, "yyyy-mm-dd hh:mm:ss"), "2023-03-16 00:00:00 (stored 45000.99999999)");
  });
});
