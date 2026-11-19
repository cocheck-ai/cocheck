// The Mac driver's per-sheet print script for Excel's region pictures (src/office/connector/office-macos.ts targetsScript, readTargets). Text only:
// nothing is sent to Excel. Must not: an app-wide setting that reaches the person's own workbooks, a hide that leaves no visible
// sheet (Excel refuses: live check), a target with no answer read as printed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readTargets, targetsScript } from "../src/office/connector/office-macos.ts";

const script = targetsScript("/Users/x/Pictures/CoCheck 1/a \"b\".xlsx", [
  { sheet: "GDP", kind: "worksheet", area: "$A$3:$D$16,$A$941:$D$963", zoom: 100, landscape: false },
  { sheet: "Chart", kind: "chartsheet", zoom: 100, landscape: true },
], ["/p/~$a-1.pdf", "/p/~$a-2.pdf"]);

test("opens read-only with no links or recents, and closes the copy by name saving nothing; no app-wide settings", () => {
  assert.match(script, /open workbook workbook file name "\/Users\/x\/Pictures\/CoCheck 1\/a \\"b\\".xlsx" update links do not update links read only true add to mru false/);
  assert.match(script, /close workbook dn saving no/);
  assert.ok(!/display alerts|screen updating|calculate full|close every|quit/.test(script));
});

test("per target: page setup replaced on the copy, the target shown before any other sheet is hidden, then the PDF", () => {
  const ws = script.slice(script.indexOf('worksheet "GDP"'), script.indexOf('chart sheet "Chart"'));
  for (const s of ['set print title rows of ps to ""', 'set print area of ps to "$A$3:$D$16,$A$941:$D$963"', "set zoom of ps to 100", "set print gridlines of ps to true", "set print headings of ps to true", "reset all page breaks sh", 'set center footer of ps to ""', "set left margin of ps to 18"]) assert.ok(ws.includes(s), s);
  assert.ok(ws.indexOf("set visible of sh to sheet visible") < ws.indexOf("set visible of s to sheet hidden"), "show the target first");
  assert.ok(ws.indexOf("set visible of s to sheet hidden") < ws.indexOf('save workbook as wb filename "/p/~$a-1.pdf" file format PDF file format'));
  const cs = script.slice(script.indexOf('chart sheet "Chart"'));
  assert.ok(cs.includes("set page orientation of ps to landscape") && !cs.includes("print area") && !cs.includes("print gridlines"));
});

test("answers: OK with the read-back area, an error per target, a missing line is not printed, an open error fails the side", () => {
  const r = readTargets("OK\t0\t$A$3:$D$16,$A$941:$D$963\nERR\t1\t-10006\tprotected", 3, "Microsoft Excel");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.results[0], { ok: true, readBack: "$A$3:$D$16,$A$941:$D$963" });
  assert.equal(r.results[1]!.ok, false);
  assert.match((r.results[1] as { why: string }).why, /could not set up this sheet for printing \(error -10006/);
  assert.deepEqual(r.results[2], { ok: false, why: "Microsoft Excel did not print this sheet" });
  const open = readTargets("ERR\topen\t-50\tno", 2, "Microsoft Excel");
  assert.deepEqual(open, { ok: false, timedOut: false, why: "Microsoft Excel could not open this file (it answered error -50)" });
});

test("zoom is set after the page-break reset, the four file flags are set false, and zoom and flags are read back before the save", () => {
  const ws = script.slice(script.indexOf('worksheet "GDP"'), script.indexOf('chart sheet "Chart"'));
  const at = (x: string): number => { const i = ws.indexOf(x); assert.ok(i >= 0, x); return i; };
  assert.ok(at("reset all page breaks sh") < at("set zoom of ps to 100"), "zoom after the reset");
  for (const f of ["black and white", "center horizontally", "center vertically", "draft"]) {
    assert.ok(at(`set ${f} of ps to false`) < at("save workbook as wb"), f);
    const rb = at(`set fb to ${f} of ps`);
    assert.ok(rb > at(`set ${f} of ps to false`) && rb < at("save workbook as wb"), `${f} read back before the save`);
  }
  assert.ok(at("set zb to zoom of ps") > at("set zoom of ps to 100") && at("set zb to zoom of ps") < at("save workbook as wb"));
  assert.match(ws, /if zb is not 100 then error "the print zoom read back as "/);
});

test("a failed read-back fails that target with a why naming the zoom, and not the other targets", () => {
  const r = readTargets("ERR\t0\t9001\tthe print zoom read back as 100, not 50\nOK\t1\t", 2, "Microsoft Excel");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.results[0]!.ok, false);
  assert.match((r.results[0] as { why: string }).why, /zoom read back as 100, not 50/);
  assert.equal(r.results[1]!.ok, true);
});

// Cases kept from an earlier Excel look-script test. Must not: closing a workbook that is not our staged copy.
test("the fallback close is the exact staged path (full name is it), never a name substring or 'first workbook whose'", () => {
  const IN = "/Users/x/Pictures/CoCheck 123e4567-e89b-12d3-a456-426614174000/after.xlsx";
  const s = targetsScript(IN, [{ sheet: "A", kind: "worksheet", area: "$A$1:$B$2", zoom: 100, landscape: false }], ["/x/p.pdf"]);
  assert.match(s, /set inP to "\/Users\/x\/Pictures\/CoCheck 123e4567/);
  assert.match(s, /if \(full name of w\) is inP or \(full name of w\) is inH then\s+close w saving no\s+exit repeat/);
  assert.doesNotMatch(s, /full name contains|first workbook whose/);
});
