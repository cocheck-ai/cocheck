// updated by (S5): PDF (print) pages are the only picture route for Excel, Word and PowerPoint; the screen look is
// deleted, so COCHECK_EXCEL_LOOK=screen changes nothing. Fakes only. Must not: (1) a review that reaches a screen route again (a stray COCHECK_EXCEL_LOOK=screen in the
// environment must still give print pages): the "no effect" tests; (2) dropping a failure finding (a file the app would not open shown as fine): the "print route still says" tests.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { answerExcel } from "../src/office/connector/excel/answer.ts";
import { answerDiff, levelFor, type OfficeDoc, type ProgramDeps } from "../src/office/connector/program.ts";
import { fakeCropper, fakeDriver, fakePageReader, fakePager, FIXTURES } from "./helpers/office-fake.ts";
import { printRig } from "./helpers/print-rig.ts";

const FX = path.join(import.meta.dirname, "fixtures", "excel-look");
const noScreenWords = (d: OfficeDoc): void => assert.ok(!d.caveats.some((c) => /less accurate|screen look was not used|screen view/.test(c)), JSON.stringify(d.caveats));

describe("levelFor", () => {
  it("3 for Excel, Word and PowerPoint: their pages carry boxes", () => {
    for (const k of ["excel", "word", "powerpoint"] as const) assert.equal(levelFor(OFFICE_APPS[k]), 3, k);
  });
});

describe("Excel's pictures are the print pages", () => {
  const run = async () => {
    const rig = printRig();
    const deps: ProgramDeps = { driver: rig.driver, pager: fakePager, crop: fakeCropper, pages: fakePageReader, lockPath: rig.lockPath, pollMs: 5, goneWaitMs: 300, lockWaitMs: 200 };
    return answerExcel(OFFICE_APPS.excel, path.join(FX, "answer-gdp-before.xlsx"), path.join(FX, "answer-gdp-after.xlsx"), deps);
  };
  const withEnv = async <T>(v: string | undefined, f: () => Promise<T>): Promise<T> => {
    const saved = process.env.COCHECK_EXCEL_LOOK;
    if (v === undefined) delete process.env.COCHECK_EXCEL_LOOK; else process.env.COCHECK_EXCEL_LOOK = v;
    try { return await f(); } finally { if (saved === undefined) delete process.env.COCHECK_EXCEL_LOOK; else process.env.COCHECK_EXCEL_LOOK = saved; }
  };
  it("print pictures, the plain caveat, no screen words", async () => {
    const doc = await run();
    const pics = (doc.pictures ?? []) as unknown as { label: string; private: { look?: string } }[];
    assert.ok(pics.length >= 2 && pics.every((p) => p.private.look !== "screen"));
    for (const p of pics) assert.ok(doc.caveats.includes(`${p.label}: changes are not marked on this picture.`), JSON.stringify(doc.caveats));
    noScreenWords(doc);
  });
  it("DANGER (1): COCHECK_EXCEL_LOOK=screen in the environment has no effect: the same print pictures and caveats", async () => {
    const plain = await withEnv(undefined, run);
    const screen = await withEnv("screen", run);
    assert.deepEqual(screen, plain);
  });
});

for (const key of ["word", "powerpoint"] as const) {
  const app = OFFICE_APPS[key];
  const fx = (v: 1 | 2): string => path.join(FIXTURES, `v${v}${app.exts[0]}`);
  const mk = (exportAs: "ok" | "fail" | "timeout") => {
    const f = fakeDriver({ exportAs });
    const deps: ProgramDeps = { driver: f.driver, pager: fakePager, crop: fakeCropper, pages: fakePageReader, lockPath: path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "lock"), pollMs: 5, goneWaitMs: 100, lockWaitMs: 200, diffMs: 60_000 };
    return { deps, calls: f.calls };
  };
  describe(`${app.name} default route is the print pages`, () => {
    it("the print route runs, no screen words", async () => {
      const w = mk("ok");
      const doc = await answerDiff(app, fx(1), fx(2), w.deps);
      assert.ok(w.calls.some((c) => c.method === "exportPdf"));
      assert.ok((doc.pictures ?? []).length >= 1);
      noScreenWords(doc);
    });
    it("DANGER (1): COCHECK_EXCEL_LOOK=screen in the environment has no effect on the answer", async () => {
      const saved = process.env.COCHECK_EXCEL_LOOK;
      try {
        delete process.env.COCHECK_EXCEL_LOOK;
        const plain = await answerDiff(app, fx(1), fx(2), mk("ok").deps);
        process.env.COCHECK_EXCEL_LOOK = "screen";
        const screen = await answerDiff(app, fx(1), fx(2), mk("ok").deps);
        assert.deepEqual(screen, plain);
      } finally { if (saved === undefined) delete process.env.COCHECK_EXCEL_LOOK; else process.env.COCHECK_EXCEL_LOOK = saved; }
    });
    for (const mode of ["fail", "timeout"] as const) {
      it(`DANGER: the print route still says so when ${app.name} will not draw the file (${mode}); never shown as fine`, async () => {
        const w = mk(mode);
        const doc = await answerDiff(app, fx(1), fx(2), w.deps);
        assert.equal((doc.pictures ?? []).length, 0);
        assert.ok(doc.status !== undefined && ["unavailable", "hang"].includes(doc.status.kind), JSON.stringify(doc.status));
        assert.ok(doc.caveats.some((c) => /not drawn/.test(c)), JSON.stringify(doc.caveats));
      });
    }
  });
}
