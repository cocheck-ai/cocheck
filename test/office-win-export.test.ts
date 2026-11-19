// exportPdf and openDocuments over the PowerShell host, printer discovery, the two caveats.
// Every case runs on every OS: no PowerShell and no Office. Node's side (printer choice, the localized "on", the plain sentences, the
// ops and argument types it sends) runs against the fake JSON-lines host (test/fixtures/office-win/fake-host.mjs), which logs each
// request and the COM calls its stand-in Office receives. The .ps1's own COM sequences are checked on the script text (typed casts,
// order, the forbidden assignment), since PowerShell can't run here.
// Guards against: changing the person's Windows default printer (Word's ActivePrinter never assigned: "Word's ActivePrinter is
// never assigned" on the script text and the fake's log; FilePrintSetup always with DoNotSetAsSysDefault=1: "Word redirects once per
// host") vs an export that hangs on a dead network printer because the redirect didn't take ("a read-back that does not name the PDF
// printer exports nothing", for Word and Excel).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { NO_PDF_PRINTER_SENTENCE, PRINTER_SETUP_SENTENCE, RESTRICTED_SENTENCE, exportMethods, onWord, pickPdfPrinter } from "../src/office/connector/office-win-export.ts";
import { HOST_SCRIPT, WinHost, winOfficeDriver } from "../src/office/connector/office-win.ts";

const FAKE = path.join(import.meta.dirname, "fixtures", "office-win", "fake-host.mjs");
const SCRIPT = readFileSync(HOST_SCRIPT, "utf8");
const exportOps = SCRIPT.slice(SCRIPT.indexOf("# --- export ops ---"));
const fake = (mode = "full"): WinHost => new WinHost({ command: { command: process.execPath, args: [FAKE, mode] } });

type Com = { call: string; args: { t: string; v: unknown }[] };
const PDF_DEV = { "Microsoft Print to PDF": "winspool,Ne03:", "RICOH Aficio": "winspool,Ne01:" };
const XPS_DEV = { "Microsoft XPS Document Writer": "winspool,Ne02:", "RICOH Aficio": "winspool,Ne01:" };

async function withHost(stub: Record<string, unknown>, fn: (h: WinHost, log: () => Promise<{ reqs: { op: string; args: Record<string, unknown> }[]; com: Com[] }>) => Promise<void>, mode = "full"): Promise<void> {
  const h = fake(mode);
  try {
    if (mode === "full") assert.equal((await h.call("stub", stub, 5_000)).ok, true);
    const log = async () => {
      const r = await h.call("log", {}, 5_000);
      return r as unknown as { reqs: { op: string; args: Record<string, unknown> }[]; com: Com[] };
    };
    await fn(h, log);
  } finally {
    await h.close();
  }
}
const tmpPdf = (): { dir: string; pdf: string; input: string } => {
  const root = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  const dir = path.join(root, "not yet", "made");
  return { dir, pdf: path.join(dir, "~$Book.pdf"), input: path.join(root, "Book.xlsx") };
};
const types = (c: Com | undefined): string[] => (c?.args ?? []).map((a) => a.t);

describe("printer discovery (pure)", () => {
  it("prefers Microsoft Print to PDF, port from 'winspool,NeXX:'", () => {
    assert.deepEqual(pickPdfPrinter({ ...XPS_DEV, ...PDF_DEV }, "RICOH Aficio on Ne01:"), { name: "Microsoft Print to PDF", full: "Microsoft Print to PDF on Ne03:" });
  });
  it("falls back to Microsoft XPS Document Writer", () => {
    assert.deepEqual(pickPdfPrinter(XPS_DEV, "RICOH Aficio on Ne01:"), { name: "Microsoft XPS Document Writer", full: "Microsoft XPS Document Writer on Ne02:" });
  });
  it("none: null", () => {
    assert.equal(pickPdfPrinter({ "RICOH Aficio": "winspool,Ne01:" }, "RICOH Aficio on Ne01:"), null);
    assert.equal(pickPdfPrinter({ "Microsoft Print to PDF": "winspool" }, ""), null, "a value with no port is no printer");
  });
  it("takes the localized 'on' from the app's ActivePrinter, falling back to 'on'", () => {
    assert.equal(onWord("Microsoft Print to PDF auf Ne03:"), "auf");
    assert.equal(onWord("RICOH Aficio MP C3003 sur Ne01:"), "sur");
    assert.equal(onWord("Microsoft Print to PDF"), "on");
    assert.equal(onWord(""), "on");
    assert.deepEqual(pickPdfPrinter(PDF_DEV, "Microsoft Print to PDF auf Ne03:"), { name: "Microsoft Print to PDF", full: "Microsoft Print to PDF auf Ne03:" });
  });
});

describe("exportPdf over the fake host", () => {
  it("PowerPoint: Open(ReadOnly, Untitled false, WithWindow false), SaveCopyAs(pdf, 32), Close; no printer asked", async () => {
    const t = tmpPdf();
    await withHost({ apps: { powerpoint: {} }, devices: {} }, async (h, log) => {
      const r = await exportMethods(h).exportPdf(OFFICE_APPS.powerpoint, t.input, t.pdf, 5_000);
      assert.deepEqual(r, { ok: true });
      const { reqs, com } = await log();
      assert.deepEqual(reqs.map((q) => q.op), ["stub", "exportPdf"]);
      assert.deepEqual(reqs[1]!.args, { app: "powerpoint", input: t.input, pdf: t.pdf, printer: null });
      assert.deepEqual(com.map((c) => c.call), ["Presentations.Open", "MkDir", "SaveCopyAs", "Close"]);
      assert.deepEqual(types(com[0]), ["string", "int", "int", "int"]);
      assert.deepEqual(com[0]!.args.map((a) => a.v), [t.input, -1, 0, 0]);
      assert.deepEqual(com[2]!.args, [{ t: "string", v: t.pdf }, { t: "int", v: 32 }]);
      assert.equal(existsSync(t.dir), true, "the missing pdf folder was created");
    });
  });

  it("PowerPoint is unaffected by a missing PDF printer", async () => {
    const t = tmpPdf();
    await withHost({ apps: { powerpoint: {} }, devices: { "RICOH Aficio": "winspool,Ne01:" } }, async (h) => {
      assert.deepEqual(await exportMethods(h).exportPdf(OFFICE_APPS.powerpoint, t.input, t.pdf, 5_000), { ok: true });
    });
  });

  it("Word redirects once per host with FilePrintSetup(Printer, DoNotSetAsSysDefault=1), then Open, ExportAsFixedFormat([string], [int]17), Close(0)", async () => {
    const t = tmpPdf();
    await withHost({ apps: { word: { active: "RICOH Aficio on Ne01:" } }, devices: PDF_DEV }, async (h, log) => {
      const m = exportMethods(h);
      assert.deepEqual(await m.exportPdf(OFFICE_APPS.word, t.input, t.pdf, 5_000), { ok: true });
      assert.deepEqual(await m.exportPdf(OFFICE_APPS.word, t.input, t.pdf, 5_000), { ok: true });
      const { reqs, com } = await log();
      assert.deepEqual(reqs.map((q) => q.op), ["stub", "pdfPrinter", "exportPdf", "exportPdf"]);
      assert.deepEqual(reqs[2]!.args.printer, { name: "Microsoft Print to PDF", full: "Microsoft Print to PDF on Ne03:" });
      const calls = com.map((c) => c.call);
      assert.deepEqual(calls, ["FilePrintSetup", "ActivePrinter?", "Documents.Open", "MkDir", "ExportAsFixedFormat", "Close", "Documents.Open", "MkDir", "ExportAsFixedFormat", "Close"]);
      assert.deepEqual(com[0]!.args, [{ t: "string", v: "Microsoft Print to PDF on Ne03:" }, { t: "int", v: 1 }], "DoNotSetAsSysDefault is always 1");
      assert.deepEqual(types(com[2]), ["string", "bool", "bool", "bool", "string"]);
      assert.deepEqual(com[2]!.args.slice(0, 4).map((a) => a.v), [t.input, false, true, false]);
      assert.deepEqual(com[4]!.args, [{ t: "string", v: t.pdf }, { t: "int", v: 17 }]);
      assert.deepEqual(com[5]!.args, [{ t: "int", v: 0 }]);
      assert.equal(com.some((c) => c.call === "ActivePrinter="), false, "Word's ActivePrinter is never assigned");
    });
  });

  it("Excel: Open(UpdateLinks 0, ReadOnly, Password), ActivePrinter set after open and read back, ExportAsFixedFormat(0, [string]), Close(false)", async () => {
    const t = tmpPdf();
    await withHost({ apps: { excel: { active: "RICOH Aficio on Ne01:" } }, devices: PDF_DEV }, async (h, log) => {
      assert.deepEqual(await exportMethods(h).exportPdf(OFFICE_APPS.excel, t.input, t.pdf, 5_000), { ok: true });
      const { com } = await log();
      assert.deepEqual(com.map((c) => c.call), ["Workbooks.Open", "ActivePrinter=", "ActivePrinter?", "MkDir", "ExportAsFixedFormat", "Close"]);
      assert.deepEqual(types(com[0]), ["string", "int", "bool", "missing", "string"]);
      assert.deepEqual(com[1]!.args, [{ t: "string", v: "Microsoft Print to PDF on Ne03:" }]);
      assert.deepEqual(com[4]!.args, [{ t: "int", v: 0 }, { t: "string", v: t.pdf }]);
      assert.deepEqual(com[5]!.args, [{ t: "bool", v: false }]);
      assert.equal(existsSync(t.dir), true);
    });
  });

  it("XPS fallback: Excel exports through Microsoft XPS Document Writer", async () => {
    const t = tmpPdf();
    await withHost({ apps: { excel: { active: "RICOH Aficio on Ne01:" } }, devices: XPS_DEV }, async (h, log) => {
      assert.deepEqual(await exportMethods(h).exportPdf(OFFICE_APPS.excel, t.input, t.pdf, 5_000), { ok: true });
      assert.deepEqual((await log()).com[1]!.args, [{ t: "string", v: "Microsoft XPS Document Writer on Ne02:" }]);
    });
  });

  it("a localized ActivePrinter ('auf') names the printer in that language", async () => {
    const t = tmpPdf();
    await withHost({ apps: { excel: { active: "Microsoft Print to PDF auf Ne03:" } }, devices: PDF_DEV }, async (h, log) => {
      assert.deepEqual(await exportMethods(h).exportPdf(OFFICE_APPS.excel, t.input, t.pdf, 5_000), { ok: true });
      assert.deepEqual((await log()).com[1]!.args, [{ t: "string", v: "Microsoft Print to PDF auf Ne03:" }]);
    });
  });

  for (const key of ["word", "excel"] as const) {
    it(`${key}: no local PDF printer exports nothing and says so plainly`, async () => {
      const t = tmpPdf();
      await withHost({ apps: { [key]: { active: "RICOH Aficio on Ne01:" } }, devices: { "RICOH Aficio": "winspool,Ne01:" } }, async (h, log) => {
        const r = await exportMethods(h).exportPdf(OFFICE_APPS[key], t.input, t.pdf, 5_000);
        assert.deepEqual(r, { ok: false, timedOut: false, why: NO_PDF_PRINTER_SENTENCE, caveat: NO_PDF_PRINTER_SENTENCE });
        assert.equal(NO_PDF_PRINTER_SENTENCE, "No local PDF printer (Microsoft Print to PDF) is installed, so Word and Excel pages can't be drawn.");
        const { com } = await log();
        assert.equal(com.some((c) => c.call === "ExportAsFixedFormat" || c.call.endsWith(".Open") || c.call === "FilePrintSetup"), false);
        assert.equal(existsSync(t.dir), false);
      });
    });

    it(`${key}: a read-back that does not name the PDF printer exports nothing`, async () => {
      const t = tmpPdf();
      await withHost({ apps: { [key]: { active: "RICOH Aficio on Ne01:", readBack: "RICOH Aficio on Ne01:" } }, devices: PDF_DEV }, async (h, log) => {
        const r = await exportMethods(h).exportPdf(OFFICE_APPS[key], t.input, t.pdf, 5_000);
        assert.deepEqual(r, { ok: false, timedOut: false, why: PRINTER_SETUP_SENTENCE, caveat: PRINTER_SETUP_SENTENCE });
        const { com } = await log();
        assert.match(PRINTER_SETUP_SENTENCE, /English-language Office/);
        assert.equal(com.some((c) => c.call === "ExportAsFixedFormat"), false, "never an export on an unconfirmed printer");
        assert.equal(existsSync(t.dir), false);
        if (key === "excel") assert.deepEqual(com.at(-1), { call: "Close", args: [{ t: "bool", v: false }] }, "the opened workbook is closed unsaved");
        if (key === "word") assert.equal(com.some((c) => c.call === "Documents.Open"), false, "Word opens nothing on a failed redirect");
      });
    });
  }

  it("Word accepts its bare read-back ('Microsoft Print to PDF'); Excel needs the full name", async () => {
    const t = tmpPdf();
    await withHost({ apps: { word: { active: "RICOH Aficio on Ne01:", readBack: "Microsoft Print to PDF" }, excel: { active: "RICOH Aficio on Ne01:", readBack: "Microsoft Print to PDF" } }, devices: PDF_DEV }, async (h) => {
      const m = exportMethods(h);
      assert.deepEqual(await m.exportPdf(OFFICE_APPS.word, t.input, t.pdf, 5_000), { ok: true });
      assert.deepEqual(await m.exportPdf(OFFICE_APPS.excel, t.input, t.pdf, 5_000), { ok: false, timedOut: false, why: PRINTER_SETUP_SENTENCE, caveat: PRINTER_SETUP_SENTENCE });
    });
  });

  it("an app this host did not launch: not launched, nothing sent to Office", async () => {
    const t = tmpPdf();
    await withHost({ apps: {}, devices: PDF_DEV }, async (h, log) => {
      const r = await exportMethods(h).exportPdf(OFFICE_APPS.powerpoint, t.input, t.pdf, 5_000);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.timedOut, false);
      assert.deepEqual((await log()).com, []);
    });
  });

  it("a restricted PowerShell answers the plain restricted sentence", async () => {
    const t = tmpPdf();
    const h = fake("constrained");
    try {
      await h.hello(5_000);
      const r = await exportMethods(h).exportPdf(OFFICE_APPS.excel, t.input, t.pdf, 5_000);
      assert.deepEqual(r, { ok: false, timedOut: false, why: RESTRICTED_SENTENCE, caveat: RESTRICTED_SENTENCE });
      assert.equal(RESTRICTED_SENTENCE, "PowerShell is restricted by policy on this computer, so Office pages can't be drawn.");
    } finally {
      await h.close();
    }
    const b = fake("bootstrap-restricted");
    try {
      assert.deepEqual(await exportMethods(b).exportPdf(OFFICE_APPS.powerpoint, t.input, t.pdf, 5_000), { ok: false, timedOut: false, why: RESTRICTED_SENTENCE, caveat: RESTRICTED_SENTENCE });
    } finally {
      await b.close();
    }
  });

  it("a host that does not answer in time is timedOut", async () => {
    const t = tmpPdf();
    await withHost({ apps: { powerpoint: { hang: true } }, devices: {} }, async (h) => {
      const r = await exportMethods(h).exportPdf(OFFICE_APPS.powerpoint, t.input, t.pdf, 300);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.timedOut, true);
    });
  });

  it("openDocuments lists the full names; null when the app is not ours", async () => {
    await withHost({ apps: { word: { docs: ["C:\\Users\\a\\Pictures\\CoCheck 1\\~$x.docx"] } }, devices: {} }, async (h) => {
      const m = exportMethods(h);
      assert.deepEqual(await m.openDocuments(OFFICE_APPS.word, 5_000), ["C:\\Users\\a\\Pictures\\CoCheck 1\\~$x.docx"]);
      assert.equal(await m.openDocuments(OFFICE_APPS.excel, 5_000), null);
    });
  });

  it("winOfficeDriver carries exportPdf and openDocuments", () => {
    const d = winOfficeDriver({ command: { command: process.execPath, args: [FAKE] } });
    assert.equal(typeof d.exportPdf, "function");
    assert.equal(typeof d.openDocuments, "function");
  });
});

describe("the .ps1's export ops (script text)", () => {
  it("has the export ops section with exportPdf, openDocuments and pdfPrinter", () => {
    assert.ok(SCRIPT.includes("# --- export ops ---"));
    for (const op of ["exportPdf", "openDocuments", "pdfPrinter"]) assert.match(exportOps, new RegExp(`\\$Ops\\['${op}'\\] = \\{`));
  });
  it("Word's ActivePrinter is never assigned (only read); FilePrintSetup always carries DoNotSetAsSysDefault = 1", () => {
    const word = exportOps.slice(exportOps.indexOf("function Export-Word"), exportOps.indexOf("function Export-Excel"));
    assert.ok(word.length > 0);
    assert.doesNotMatch(word, /ActivePrinter\s*=(?!=)/);
    assert.match(word, /'FilePrintSetup'/);
    assert.match(word, /\[object\[\]\]@\(\[string\]\$p\.full, \[int\]1\)/);
    assert.match(word, /'Printer', 'DoNotSetAsSysDefault'/);
    // the only ActivePrinter assignment anywhere in the host is Excel's
    assert.equal((SCRIPT.match(/ActivePrinter\s*=(?!=)/g) ?? []).length, 1);
    assert.match(exportOps.slice(exportOps.indexOf("function Export-Excel")), /\$com\.ActivePrinter = \[string\]\$p\.full/);
  });
  it("every COM argument is typed and every call goes through Invoke-Busy", () => {
    assert.match(exportOps, /Invoke-Busy \{ \$com\.Presentations\.Open\(\[string\]\$a\.input, \[int\]-1, \[int\]0, \[int\]0\) \}/);
    assert.match(exportOps, /Invoke-Busy \{ \$doc\.SaveCopyAs\(\[string\]\$a\.pdf, \[int\]32\) \}/);
    assert.match(exportOps, /Invoke-Busy \{ \$com\.Documents\.Open\(\[string\]\$a\.input, \[bool\]\$false, \[bool\]\$true, \[bool\]\$false, \[string\]\$DummyPassword\) \}/);
    assert.match(exportOps, /Invoke-Busy \{ \$doc\.ExportAsFixedFormat\(\[string\]\$a\.pdf, \[int\]17\) \}/);
    assert.match(exportOps, /Invoke-Busy \{ \$doc\.Close\(\[int\]0\) \}/);
    assert.match(exportOps, /Invoke-Busy \{ \$com\.Workbooks\.Open\(\[string\]\$a\.input, \[int\]0, \[bool\]\$true, \[Type\]::Missing, \[string\]\$DummyPassword\) \}/);
    assert.match(exportOps, /Invoke-Busy \{ \$doc\.ExportAsFixedFormat\(\[int\]0, \[string\]\$a\.pdf\) \}/);
    assert.match(exportOps, /Invoke-Busy \{ \$doc\.Close\(\[bool\]\$false\) \}/);
    // no untyped COM call on the Office objects
    for (const line of exportOps.split("\n")) {
      const m = line.match(/\$(?:com|doc|wb)\.[A-Za-z.]+\(([^)]*)\)/);
      if (m && m[1]!.trim() !== "") for (const arg of m[1]!.split(/,\s*/)) assert.match(arg, /^\[(string|int|bool|Type)\]/, `untyped COM argument in: ${line.trim()}`);
    }
  });
  it("the pdf's folder is created before each export, and the read-back comes before Excel's export", () => {
    const mk = /\[void\]\[IO\.Directory\]::CreateDirectory\(\[IO\.Path\]::GetDirectoryName\(\[string\]\$a\.pdf\)\)/;
    for (const fn of ["Export-PowerPoint", "Export-Word", "Export-Excel"]) {
      const start = exportOps.indexOf(`function ${fn}`);
      const body = exportOps.slice(start, exportOps.indexOf("\n}", start));
      const mkAt = body.search(mk);
      const exAt = body.search(/SaveCopyAs|ExportAsFixedFormat/);
      assert.ok(mkAt > 0 && mkAt < exAt, `${fn}: folder created before export`);
      if (fn !== "Export-PowerPoint") assert.ok(body.indexOf("Test-ReadBack") > 0 && body.indexOf("Test-ReadBack") < exAt, `${fn}: read back before export`);
    }
  });
});
