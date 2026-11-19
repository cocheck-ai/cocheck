// a PDF the app says it saved counts only when the file proves it (non-empty, stable, opens with a page); one more ask, then the exact words.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { officePdfs, type ExportOutcome, type JobOptions, type SideInput, type SidePdf } from "../src/office/connector/office-job.ts";
import { fakeDriver } from "./helpers/office-fake.ts";

const WORD = OFFICE_APPS.word;
const EXCEL = OFFICE_APPS.excel;
const WORDS = (app: typeof WORD): string => `not drawn: ${app.name} reported the save, but no PDF appeared (tried twice)`;
const GOOD = "%PDF-fake good";

function rig(script: (n: number, pdf: string) => ExportOutcome | Promise<ExportOutcome>, opt: { clock?: { t: number } } = {}) {
  const f = fakeDriver();
  let asks = 0;
  f.driver.exportPdf = async (_a, _i, pdf) => { f.calls.push({ method: "exportPdf", args: [] }); return script(++asks, pdf); };
  const src = path.join(mkdtempSync(path.join(tmpdir(), "src-")), "a.docx");
  writeFileSync(src, "x");
  const opts: JobOptions = { driver: f.driver, lockPath: path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "lock"), deadline: (opt.clock?.t ?? Date.now()) + 20_000, sideTimeoutMs: 5_000, ...(opt.clock ? { now: () => opt.clock!.t } : {}), pollMs: 5, goneWaitMs: 100, lockWaitMs: 200, stableGapMs: 5 };
  const run = async (sides: SideInput[]): Promise<SidePdf[]> => { const j = await officePdfs(WORD, sides, opts); assert.ok(!j.pending); return j.pending ? [] : j.sides; };
  const side = (s: "before" | "after"): SideInput => ({ side: s, file: src, name: "a.docx" });
  return { f, run, side, asks: () => asks };
}

describe("a saved PDF must be proven by the file", () => {
  it("answers ok without writing: one retry, then the exact words; the other side still shows", async () => {
    const r = rig((n, pdf) => { if (n > 2) writeFileSync(pdf, GOOD); return { ok: true }; });
    const out = await r.run([r.side("before"), r.side("after")]);
    assert.deepEqual(out[0], { side: "before", why: WORDS(WORD) });
    assert.ok("pdf" in out[1]!, "the other side still shows");
    assert.equal(r.asks(), 3, "before asked twice, after once");
  });

  it("a fake that writes on the second ask yields the picture", async () => {
    const r = rig((n, pdf) => { if (n === 2) writeFileSync(pdf, GOOD); return { ok: true }; });
    const out = await r.run([r.side("before")]);
    assert.ok("pdf" in out[0]!);
    assert.equal(r.asks(), 2);
  });

  it("a truncated non-PDF counts as a failure (and a non-PDF is never shown as the file)", async () => {
    const r = rig((_n, pdf) => { writeFileSync(pdf, "%PD"); return { ok: true }; });
    const out = await r.run([r.side("before")]);
    assert.deepEqual(out[0], { side: "before", why: WORDS(WORD) });
    assert.equal(r.asks(), 2);
  });

  it("a file still growing between the two reads is not proven", async () => {
    const r = rig((_n, pdf) => { writeFileSync(pdf, GOOD); setTimeout(() => writeFileSync(pdf, GOOD + " more bytes"), 2); return { ok: true }; });
    const out = await r.run([r.side("before")]);
    assert.deepEqual(out[0], { side: "before", why: WORDS(WORD) });
  });

  it("Word's -1708 answer gets the same single retry", async () => {
    const r = rig((n, pdf) => { if (n === 1) return { ok: false, timedOut: false, why: "Word answered error -1708" }; writeFileSync(pdf, GOOD); return { ok: true }; });
    const out = await r.run([r.side("before")]);
    assert.ok("pdf" in out[0]!);
    assert.equal(r.asks(), 2);
    const r2 = rig(() => ({ ok: false, timedOut: false, why: "Word answered error -1708" }));
    const out2 = await r2.run([r2.side("before")]);
    assert.deepEqual(out2[0], { side: "before", why: WORDS(WORD) });
    assert.equal(r2.asks(), 2, "exactly one retry");
  });

  it("no retry after a timeout (app killed, never re-asked)", async () => {
    const r = rig(() => ({ ok: false, timedOut: true, why: "no answer" }));
    const out = await r.run([r.side("before"), r.side("after")]);
    assert.equal(r.asks(), 1);
    assert.ok("why" in out[0]! && (out[0] as { hang?: true }).hang === true);
    assert.ok(r.f.calls.some((c) => c.method === "kill"));
  });

  it("a timeout on the retry is not retried again", async () => {
    const r = rig((n) => (n === 1 ? { ok: true } : { ok: false, timedOut: true, why: "no answer" }));
    await r.run([r.side("before")]);
    assert.equal(r.asks(), 2);
    assert.ok(r.f.calls.some((c) => c.method === "kill"));
  });

  it("no retry past the deadline", async () => {
    const clock = { t: 1_000_000 };
    const r = rig(() => { clock.t += 19_500; return { ok: true }; }, { clock });
    const out = await r.run([r.side("before")]);
    assert.equal(r.asks(), 1, "inside 1 s of the deadline after the first ask: asked once");
    assert.ok("why" in out[0]!);
  });

  it("per target: a target with no file is asked once more (only it); the others show", async () => {
    const f = fakeDriver();
    const asked: string[][] = [];
    f.driver.exportTargets = async (_a, _i, targets, pdfs) => {
      asked.push(targets.map((t) => t.sheet));
      targets.forEach((t, i) => { if (asked.length === 1 ? i === 0 : false) writeFileSync(pdfs[i]!, GOOD); });
      return { ok: true, results: targets.map(() => ({ ok: true as const })) };
    };
    const src = path.join(mkdtempSync(path.join(tmpdir(), "src-")), "a.xlsx");
    writeFileSync(src, "x");
    const opts: JobOptions = { driver: f.driver, lockPath: path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "lock"), deadline: Date.now() + 20_000, pollMs: 5, goneWaitMs: 100, lockWaitMs: 200, stableGapMs: 5 };
    const targets = [{ sheet: "A", kind: "worksheet" as const, zoom: 100, landscape: false }, { sheet: "B", kind: "worksheet" as const, zoom: 100, landscape: false }];
    const j = await officePdfs(EXCEL, [{ side: "after", file: src, name: "a.xlsx", targets }], opts);
    assert.ok(!j.pending);
    const side = (j.pending ? [] : j.sides)[0] as { targets: ({ pdf: Buffer } | { why: string })[] };
    assert.ok("pdf" in side.targets[0]!);
    assert.deepEqual(side.targets[1], { why: WORDS(EXCEL) });
    assert.deepEqual(asked, [["A", "B"], ["B"]]);
  });

  // one stability wait per save call, not per target.
  const runSaved = (n: number, onSleep: (pdfs: string[], calls: number) => void) => {
    const f = fakeDriver();
    const pdfsSeen: string[][] = [];
    const log: string[] = [];
    let writes = 0;
    f.driver.exportTargets = async (_a, _i, targets, pdfs) => {
      if (pdfsSeen.length === 0) pdfsSeen.push(pdfs);
      targets.forEach((_t, i) => { writeFileSync(pdfs[i]!, GOOD); writes++; });
      return { ok: true, results: targets.map(() => ({ ok: true as const })) };
    };
    const src = path.join(mkdtempSync(path.join(tmpdir(), "src-")), "a.xlsx");
    writeFileSync(src, "x");
    let calls = 0;
    const opts: JobOptions = {
      driver: f.driver, lockPath: path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "lock"), deadline: Date.now() + 20_000, pollMs: 5, goneWaitMs: 100, lockWaitMs: 200, stableGapMs: 200,
      stableSleep: async (ms) => { calls++; log.push(`sleep ${ms}`); onSleep(pdfsSeen[0]!, calls); },
    };
    const targets = Array.from({ length: n }, (_, i) => ({ sheet: `S${i}`, kind: "worksheet" as const, zoom: 100, landscape: false }));
    const run = async () => { const j = await officePdfs(EXCEL, [{ side: "after", file: src, name: "a.xlsx", targets }], opts); assert.ok(!j.pending); return ((j.pending ? [] : j.sides)[0] as { targets: ({ pdf: Buffer } | { why: string })[] }).targets; };
    return { run, calls: () => calls, log, writes: () => writes };
  };

  it("a 12-target save waits once (stableGapMs), not 12 times", async () => {
    const r = runSaved(12, () => undefined);
    const got = await r.run();
    assert.equal(got.length, 12);
    assert.ok(got.every((g) => "pdf" in g));
    assert.deepEqual(r.log, ["sleep 200"]);
  });

  it("a target whose size changes across the gap still fails, the others show", async () => {
    const r = runSaved(12, (pdfs) => { appendFileSync(pdfs[3]!, " more bytes"); });
    const got = await r.run();
    assert.deepEqual(got[3], { why: WORDS(EXCEL) });
    assert.equal(got.filter((g) => "pdf" in g).length, 11);
    assert.equal(r.calls(), 2, "one wait for the save, one for the single retry of the failed target");
  });
});
