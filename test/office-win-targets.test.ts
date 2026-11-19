// Excel per-sheet exportTargets over the PowerShell host. Every case runs on every OS
// against the fake JSON-lines host (test/fixtures/office-win/fake-host.mjs), which logs the COM calls its stand-in Excel receives and
// mirrors office-win.ps1 "# --- export targets ---"; the .ps1's own order is checked on its script text.
// Guards against: PrintCommunication left false or another sheet's state changed, giving wrong Excel pictures ("PrintCommunication
// is restored after a throw", "no sheet is hidden or shown") vs one bad sheet failing every target ("one failing target among three").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import type { ExportTarget } from "../src/office/connector/office-job.ts";
import { exportMethods, PRINTER_SETUP_SENTENCE as NOSETUP } from "../src/office/connector/office-win-export.ts";
import { HOST_SCRIPT, WinHost } from "../src/office/connector/office-win.ts";

const FAKE = path.join(import.meta.dirname, "fixtures", "office-win", "fake-host.mjs");
const SCRIPT = readFileSync(HOST_SCRIPT, "utf8");
const section = SCRIPT.slice(SCRIPT.indexOf("# --- export targets ---"), SCRIPT.indexOf("while (-not $script:Quit)"));
type Com = { call: string; sheet?: string; args: { t: string; v: unknown }[] };
const PDF_DEV = { "Microsoft Print to PDF": "winspool,Ne03:", "RICOH Aficio": "winspool,Ne01:" };
const T: ExportTarget[] = [
  { sheet: "Sales", kind: "worksheet", area: "$A$1:$D$20", zoom: 85, landscape: true },
  { sheet: "Chart1", kind: "chartsheet", zoom: 100, landscape: false },
  { sheet: "Costs", kind: "worksheet", area: "$A$1:$B$5,$D$1:$E$5", zoom: 120.4, landscape: false },
];
const OUT = mkdtempSync(path.join(tmpdir(), "cocheck-"));
const PDFS = [0, 1, 2].map((i) => path.join(OUT, `${i}.pdf`));

async function run(app: Record<string, unknown>, devices: Record<string, string>, targets = T, pdfs = PDFS): Promise<{ r: Awaited<ReturnType<ReturnType<typeof exportMethods>["exportTargets"]>>; com: Com[] }> {
  const h = new WinHost({ command: { command: process.execPath, args: [FAKE, "full"] } });
  try {
    assert.equal((await h.call("stub", { apps: { excel: app, word: {} }, devices }, 5_000)).ok, true);
    const r = await exportMethods(h).exportTargets(OFFICE_APPS.excel, "/in/Book.xlsx", targets, pdfs, 5_000);
    const log = (await h.call("log", {}, 5_000)) as unknown as { com: Com[] };
    return { r, com: log.com };
  } finally {
    await h.close();
  }
}
const calls = (com: Com[], sheet?: string): string[] => com.filter((c) => sheet === undefined || c.sheet === sheet || c.sheet === undefined).map((c) => c.call);

describe("Excel exportTargets over the fake host", () => {
  it("sequence and argument types per target, PrintCommunication off around the setup, read-backs, results in order", async () => {
    const { r, com } = await run({ active: "RICOH Aficio on Ne01:" }, PDF_DEV);
    assert.deepEqual(r, { ok: true, results: [{ ok: true, readBack: "$A$1:$D$20" }, { ok: true }, { ok: true, readBack: "$A$1:$B$5,$D$1:$E$5" }] });
    assert.deepEqual(com.slice(0, 3).map((c) => c.call), ["Workbooks.Open", "ActivePrinter=", "ActivePrinter?"]);
    assert.deepEqual(com[0]!.args.map((a) => a.t), ["string", "int", "bool", "missing", "string"]);
    assert.deepEqual(com[1]!.args, [{ t: "string", v: "Microsoft Print to PDF on Ne03:" }]);
    const FLAGS = ["BlackAndWhite", "CenterHorizontally", "CenterVertically", "Draft"];
    assert.deepEqual(com.slice(3, 25).map((c) => c.call), ["Sheets.Item", "PrintCommunication=", "PageSetup.PrintTitleRows=", "PageSetup.PrintTitleColumns=", "PageSetup.PrintArea=",
      "PageSetup.PrintHeadings=", "PageSetup.PrintGridlines=", ...FLAGS.map((f) => `PageSetup.${f}=`), "PageSetup.Zoom=", "PageSetup.Orientation=", "PrintCommunication=", "PrintCommunication?",
      "PageSetup.Zoom?", ...FLAGS.map((f) => `PageSetup.${f}?`), "PageSetup.PrintArea?", "MkDir"]);
    const arg = (call: string) => com.find((c) => c.sheet === "Sales" && c.call === call)!.args;
    assert.deepEqual(com[4]!.args, [{ t: "bool", v: false }]);
    assert.deepEqual(arg("PageSetup.PrintTitleRows="), [{ t: "string", v: "" }]);
    assert.deepEqual(arg("PageSetup.PrintArea="), [{ t: "string", v: "$A$1:$D$20" }]);
    assert.deepEqual(arg("PageSetup.PrintHeadings="), [{ t: "bool", v: true }]);
    assert.deepEqual(arg("PageSetup.PrintGridlines="), [{ t: "bool", v: true }]);
    for (const f of FLAGS) assert.deepEqual(arg(`PageSetup.${f}=`), [{ t: "bool", v: false }]);
    assert.deepEqual(arg("PageSetup.Zoom="), [{ t: "int", v: 85 }], "zoom is an int");
    assert.deepEqual(arg("PageSetup.Orientation="), [{ t: "int", v: 2 }], "landscape is 2");
    assert.deepEqual(com[16]!.args, [{ t: "bool", v: true }]);
    assert.deepEqual(com[25]!.args, [{ t: "int", v: 0 }, { t: "string", v: PDFS[0] }]);
    assert.equal(com[25]!.call, "ExportAsFixedFormat");
    assert.equal(com[25]!.sheet, "Sales", "the export is on that sheet alone");
    const costs = com.filter((c) => c.sheet === "Costs");
    assert.deepEqual(costs.find((c) => c.call === "PageSetup.Zoom=")!.args, [{ t: "int", v: 120 }]);
    assert.deepEqual(costs.find((c) => c.call === "PageSetup.Orientation=")!.args, [{ t: "int", v: 1 }], "portrait is 1");
    assert.deepEqual(com.slice(-2).map((c) => c.call), ["PrintCommunication=", "Close"]);
    assert.deepEqual(com.at(-1)!.args, [{ t: "bool", v: false }], "closed unsaved");
  });

  it("a chart sheet takes no print area and no zoom", async () => {
    const { r, com } = await run({}, PDF_DEV, [T[1]!], [PDFS[0]!]);
    assert.deepEqual(r, { ok: true, results: [{ ok: true }] });
    const chart = com.filter((c) => c.sheet === "Chart1").map((c) => c.call);
    assert.deepEqual(chart, ["PageSetup.Orientation=", "ExportAsFixedFormat"]);
  });

  it("one failing target among three: that target has {ok:false, why}, the others print", async () => {
    const { r, com } = await run({ failAt: { Chart1: "PageSetup.Orientation=" } }, PDF_DEV);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.results[0]!.ok, true);
    assert.equal(r.results[1]!.ok, false);
    assert.match((r.results[1] as { why: string }).why, /Orientation= failed/);
    assert.equal(r.results[2]!.ok, true);
    assert.equal(com.filter((c) => c.call === "ExportAsFixedFormat").length, 2);
  });

  it("PrintCommunication is restored after a throw, before the next target, and read back", async () => {
    const { com } = await run({ failAt: { Sales: "PageSetup.Zoom=" } }, PDF_DEV);
    const seq = com.map((c) => (c.call === "PrintCommunication=" ? `pc${(c.args[0]!.v as boolean) ? "On" : "Off"}` : c.call));
    const fail = seq.indexOf("PageSetup.Zoom=");
    assert.deepEqual(seq.slice(fail + 1, fail + 3), ["pcOn", "PrintCommunication?"]);
    assert.equal(seq.indexOf("pcOff", fail), seq.indexOf("pcOff", fail), "next target turns it off only after the restore");
    assert.ok(seq.indexOf("pcOn", fail) < seq.indexOf("pcOff", fail));
    assert.deepEqual(seq.slice(-2), ["pcOn", "Close"], "and once more before the workbook closes");
  });

  it("script text: the restore is in a finally inside the target, and again in the finally that closes", () => {
    const t = section.slice(section.indexOf("function Export-ExcelTarget"), section.indexOf("$Ops['exportTargets']"));
    const off = t.indexOf("PrintCommunication = [bool]$false");
    const fin = t.indexOf("} finally {", off);
    const on = t.indexOf("PrintCommunication = [bool]$true", fin);
    const back = t.indexOf("PrintCommunication })", on);
    const exp = t.indexOf("ExportAsFixedFormat");
    assert.ok(off > 0 && off < fin && fin < on && on < back && back < exp, "off, finally, on, read back, then export");
    const ops = section.slice(section.indexOf("$Ops['exportTargets']"));
    const f2 = ops.lastIndexOf("} finally {");
    assert.ok(ops.indexOf("PrintCommunication = [bool]$true", f2) < ops.indexOf("$doc.Close([bool]$false)", f2));
  });

  it("script text: a worksheet's page setup matches the Mac's (print titles cleared, headings and gridlines on, the four flags off), and the zoom and flags are read back before the export", () => {
    // Without printed headings the box finder cannot place any change on a Windows Excel picture ("the heading frame was not found").
    const t = section.slice(section.indexOf("function Export-ExcelTarget"), section.indexOf("$Ops['exportTargets']"));
    const off = t.indexOf("PrintCommunication = [bool]$false");
    const fin = t.indexOf("} finally {", off);
    const setup = t.slice(off, fin);
    for (const line of [
      "$ps.PrintTitleRows = ''",
      "$ps.PrintTitleColumns = ''",
      "$ps.PrintHeadings = [bool]$true",
      "$ps.PrintGridlines = [bool]$true",
      "$ps.BlackAndWhite = [bool]$false",
      "$ps.CenterHorizontally = [bool]$false",
      "$ps.CenterVertically = [bool]$false",
      "$ps.Draft = [bool]$false",
    ]) {
      const at = setup.indexOf(line);
      assert.ok(at > 0, `setup sets ${line}`);
      assert.ok(setup.lastIndexOf("if (-not $isChart) {", at) > 0 && at < setup.indexOf("$ps.Orientation"), `${line} is worksheet-only`);
    }
    const after = t.slice(t.indexOf("PrintCommunication })", fin), t.indexOf("ExportAsFixedFormat"));
    for (const read of ["$ps.Zoom }", "$ps.BlackAndWhite }", "$ps.CenterHorizontally }", "$ps.CenterVertically }", "$ps.Draft }"]) {
      assert.ok(after.includes(read), `${read} is read back after PrintCommunication is on and before the export`);
    }
    assert.match(after, /\[int\]\$zb -ne \$zoom\) \{ throw/);
    assert.equal((after.match(/read back as true, not false' \}/g) ?? []).length, 4, "each flag that reads back true fails that target");
  });

  it("no sheet is hidden or shown: no Visible or Hidden assignment in the section", () => {
    assert.doesNotMatch(section, /\bVisible\b/i);
    assert.doesNotMatch(section, /\bHidden\b/i);
    assert.doesNotMatch(section, /FitToPages/);
  });

  it("a printer whose read-back does not name the PDF printer exports nothing (pdf-printer-setup-failed)", async () => {
    const { r, com } = await run({ readBack: "RICOH Aficio on Ne01:" }, PDF_DEV);
    assert.deepEqual(r, { ok: false, timedOut: false, why: NOSETUP, caveat: NOSETUP });
    assert.deepEqual(com.map((c) => c.call), ["Workbooks.Open", "ActivePrinter=", "ActivePrinter?", "PrintCommunication=", "Close"]);
  });

  it("no local PDF printer at all: nothing is opened", async () => {
    const { r, com } = await run({}, { "RICOH Aficio": "winspool,Ne01:" });
    assert.equal(r.ok, false);
    assert.deepEqual(com, []);
  });

  it("other apps answer that they cannot print sheets one by one", async () => {
    const h = new WinHost({ command: { command: process.execPath, args: [FAKE, "full"] } });
    try {
      assert.equal((await h.call("stub", { apps: { word: {} }, devices: PDF_DEV }, 5_000)).ok, true);
      assert.deepEqual(await exportMethods(h).exportTargets(OFFICE_APPS.word, "/in/a.docx", T, PDFS, 5_000), { ok: false, timedOut: false, why: "Microsoft Word cannot print sheets one by one" });
    } finally {
      await h.close();
    }
  });

  it("a call timeout is timedOut:true", async () => {
    const h = new WinHost({ command: { command: process.execPath, args: [FAKE, "full"] } });
    try {
      assert.equal((await h.call("stub", { apps: { excel: {} }, devices: PDF_DEV }, 5_000)).ok, true);
      const r = await exportMethods({ call: (op: string, a: Record<string, unknown>, ms: number) => (op === "exportTargets" ? h.call("hang", {}, 50) : h.call(op, a, ms)) } as unknown as WinHost).exportTargets(OFFICE_APPS.excel, "/in/b.xlsx", T, PDFS, 5_000);
      assert.deepEqual(r, { ok: false, timedOut: true, why: "Microsoft Excel did not answer in time" });
    } finally {
      await h.close();
    }
  });
});
