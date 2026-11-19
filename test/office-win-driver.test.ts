// officeExportDriver('win32') returns the Windows driver, and a job on Windows says plainly
// when this computer cannot draw (PowerShell restricted, host cannot start, no local PDF printer) instead of "Excel is open, pages later" forever.
// Every case runs on every OS: the OS is passed as 'win32', the host is the fake JSON-lines host (test/fixtures/office-win/fake-host.mjs), and the
// test bootstrap's guard (COCHECK_TEST_NO_OFFICE=1) keeps the real powershell.exe from ever starting.
// Guards against: a Windows person told "Excel is open, pages later" when the cause is a restricted PowerShell or a missing printer ("restricted
// hello", "host cannot start", "no-printer from Word") vs the Mac or Linux path changing ("darwin and linux driver choice").
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { officeExportDriver } from "../src/office/connector/export-driver.ts";
import { officeDeps } from "../src/office/connector/main.ts";
import type { OfficeExportDriver } from "../src/office/connector/office-job.ts";
import { HOST_NOT_STARTED_SENTENCE, NO_PDF_PRINTER_SENTENCE, PRINTER_SETUP_SENTENCE, RESTRICTED_SENTENCE } from "../src/office/connector/office-win-export.ts";
import { answerDiff, NO_DRIVER_WHY } from "../src/office/connector/program.ts";
import { FIXTURES, fakePager } from "./helpers/office-fake.ts";

const FAKE = path.join(import.meta.dirname, "fixtures", "office-win", "fake-host.mjs");
const fakeHost = (mode: string) => ({ command: { command: process.execPath, args: [FAKE, mode] } });
const word = OFFICE_APPS.word;

/** The Windows driver over a fake host, with the lifecycle replaced by spies (the fake's "full" mode has no process table). Export and preflight stay real. */
function spied(mode: string, host: { command: { command: string; args: string[] } } = fakeHost(mode)) {
  const real = officeExportDriver("win32", host) as OfficeExportDriver & { host: import("../src/office/connector/office-win.ts").WinHost };
  const calls: string[] = [];
  const stage = mkdtempSync(path.join(tmpdir(), "stage-"));
  const driver: OfficeExportDriver = {
    ...real,
    exportPdf: (...a) => real.exportPdf(...a),
    preflight: (a) => real.preflight!(a),
    close: () => real.close!(),
    closeSync: () => real.closeSync!(),
    stageRoot: () => stage,
    isRunning: async () => { calls.push("isRunning"); return false; },
    launch: async () => { calls.push("launch"); return 4242; },
    ready: async () => true,
    documentCount: async () => 0,
    quit: async () => undefined,
    kill: () => undefined,
    alive: () => true,
    pager: fakePager,
  };
  return { driver, calls, real };
}
const lock = (): string => path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "lock");
const ask = (driver: OfficeExportDriver, app = word, ext = ".docx") => answerDiff(app, path.join(FIXTURES, `v1${ext}`), path.join(FIXTURES, `v2${ext}`), { driver, pager: fakePager, lockPath: lock() });

describe("the driver chosen per OS", () => {
  it("win32 gives the Windows driver, fresh on every call (a fresh host per job)", () => {
    const a = officeExportDriver("win32"), b = officeExportDriver("win32");
    assert.notEqual(a, undefined);
    assert.equal(typeof a!.preflight, "function");
    assert.notEqual(a, b);
    assert.notEqual((a as unknown as { host: unknown }).host, (b as unknown as { host: unknown }).host);
  });
  it("darwin still gives the Mac driver (no preflight, no Windows host)", () => {
    const d = officeExportDriver("darwin") as unknown as { host?: unknown; preflight?: unknown };
    assert.notEqual(d, undefined);
    assert.equal(d.host, undefined);
    assert.equal(d.preflight, undefined);
  });
  for (const os of ["linux", "freebsd", "aix"]) it(`${os} still has no driver`, () => assert.equal(officeExportDriver(os), undefined));
  it("officeDeps on win32 holds a driver and no NO_DRIVER_WHY; on linux it still holds neither a driver nor a window helper", () => {
    const w = officeDeps({}, "win32");
    assert.notEqual(w.driver, undefined);
    assert.equal(w.noDriverWhy, undefined);
    const l = officeDeps({}, "linux");
    assert.equal(l.driver, undefined);
    assert.equal(l.windows, undefined);
  });
  it("the answer on win32 with a working driver carries no NO_DRIVER_WHY sentence", async () => {
    const { driver, real } = spied("full");
    try {
      const doc = await ask(driver);
      assert.ok(!doc.caveats.includes(NO_DRIVER_WHY(word)), JSON.stringify(doc.caveats));
    } finally {
      await real.close!();
    }
  });
});

describe("the bootstrap guard", () => {
  it("officeExportDriver('win32') with no host option never starts the real powershell.exe under the test bootstrap", async () => {
    assert.equal(process.env.COCHECK_TEST_NO_OFFICE, "1", "this test runs under scripts/test-bootstrap.ts");
    const d = officeExportDriver("win32") as OfficeExportDriver & { host: { pid: number | undefined } };
    assert.equal(await d.preflight!(word), HOST_NOT_STARTED_SENTENCE);
    assert.equal(d.host.pid, undefined, "no process was spawned");
    await d.close!();
  });
});

describe("a restricted PowerShell, or a host that cannot start, is said plainly", () => {
  const cases: [string, () => ReturnType<typeof spied>, string][] = [
    ["restricted hello (ConstrainedLanguage)", () => spied("constrained"), RESTRICTED_SENTENCE],
    ["the loader's restricted line", () => spied("bootstrap-restricted"), RESTRICTED_SENTENCE],
    ["host start failure (no such program)", () => spied("full", { command: { command: path.join(tmpdir(), "no-such-host"), args: [] } }), HOST_NOT_STARTED_SENTENCE],
  ];
  for (const [name, make, sentence] of cases) {
    it(`${name}: the plain sentence is the caveat, no isRunning or launch call, never pending or "is open"`, async () => {
      const { driver, calls, real } = make();
      try {
        const doc = await ask(driver);
        assert.deepEqual(calls, []);
        assert.equal(doc.pendingRetry, undefined);
        assert.ok(doc.caveats.includes(sentence), JSON.stringify(doc.caveats));
        assert.equal(doc.caveats.filter((c) => c === sentence).length, 1, "once per file, not once per side");
        for (const c of doc.caveats) assert.doesNotMatch(c, /is open|pending|once it is closed/i, c);
        assert.ok(doc.changes.length > 0, "the change list is still there");
      } finally {
        await real.close!();
      }
    });
  }
  it("a working host passes the preflight and the job goes on to the gate", async () => {
    const { driver, calls, real } = spied("full");
    try {
      await ask(driver);
      assert.equal(calls[0], "isRunning");
    } finally {
      await real.close!();
    }
  });
});

describe("the PDF printer would not take (localized Office)", () => {
  it("a read-back that differs: the setup sentence once for the file, not the no-printer sentence", async () => {
    const { driver, real } = spied("full");
    try {
      assert.equal((await real.host.call("stub", { apps: { word: { active: "RICOH on Ne01:", readBack: "Microsoft Drucker" } }, devices: { "Microsoft Print to PDF": "winspool,Ne03:" } }, 5_000)).ok, true);
      const doc = await ask(driver);
      assert.equal(doc.caveats.filter((c) => c === PRINTER_SETUP_SENTENCE).length, 1, JSON.stringify(doc.caveats));
      assert.ok(!doc.caveats.includes(NO_PDF_PRINTER_SENTENCE));
    } finally {
      await real.close!();
    }
  });
});

describe("no local PDF printer", () => {
  it("no-printer from Word: the plain sentence once for the file (both sides), and the change list", async () => {
    const { driver, real } = spied("full");
    try {
      assert.equal((await real.host.call("stub", { apps: { word: { active: "RICOH on Ne01:" } }, devices: { "RICOH Aficio": "winspool,Ne01:" } }, 5_000)).ok, true);
      const doc = await ask(driver);
      assert.equal(doc.caveats.filter((c) => c === NO_PDF_PRINTER_SENTENCE).length, 1, JSON.stringify(doc.caveats));
      for (const c of doc.caveats) assert.doesNotMatch(c, /^(Before|After):|not drawn:/, c);
      assert.equal(doc.pictures, undefined);
      assert.equal(doc.status?.kind, "unavailable");
      assert.ok(doc.changes.length > 0, "the change list is still there");
    } finally {
      await real.close!();
    }
  });
  it("no-printer from Excel (per-sheet export): the plain sentence once for the file, no Before/After copies, the change list, no pictures", async () => {
    const { driver, real } = spied("full");
    try {
      assert.equal((await real.host.call("stub", { apps: { excel: { active: "RICOH on Ne01:", readBack: "RICOH Aficio on Ne01:" } }, devices: { "Microsoft Print to PDF": "winspool,Ne03:", "RICOH Aficio": "winspool,Ne01:" } }, 5_000)).ok, true);
      const doc = await ask(driver, OFFICE_APPS.excel, ".xlsx");
      assert.equal(doc.caveats.filter((c) => c === PRINTER_SETUP_SENTENCE).length, 1, JSON.stringify(doc.caveats));
      for (const c of doc.caveats) assert.doesNotMatch(c, /^(Before|After):|not drawn:/, c);
      assert.equal(doc.pictures, undefined);
      assert.equal(doc.status?.kind, "unavailable");
      assert.ok(doc.changes.length > 0, "the change list is still there");
    } finally {
      await real.close!();
    }
  });
  it("a why that already ends in a period is not given a second one", async () => {
    const { driver, real } = spied("full");
    try {
      assert.equal((await real.host.call("stub", { apps: { word: {} }, devices: {} }, 5_000)).ok, true);
      const doc = await ask({ ...driver, exportPdf: async () => ({ ok: false, timedOut: false, why: "Word could not save its PDF (disk full)." }) });
      assert.ok(doc.caveats.some((c) => c.startsWith("Before: not drawn: Word could not save")), JSON.stringify(doc.caveats));
      for (const c of doc.caveats) assert.doesNotMatch(c, /\.\./, c);
    } finally {
      await real.close!();
    }
  });
  it("PowerPoint is never given the printer sentence: its export needs no printer", async () => {
    const { real } = spied("full");
    try {
      assert.equal((await real.host.call("stub", { apps: { powerpoint: {} }, devices: {} }, 5_000)).ok, true);
      const out = await real.exportPdf(OFFICE_APPS.powerpoint, path.join(tmpdir(), "in.pptx"), path.join(mkdtempSync(path.join(tmpdir(), "cocheck-")), "~$x.pdf"), 5_000);
      assert.deepEqual(out, { ok: true });
    } finally {
      await real.close!();
    }
  });
});
