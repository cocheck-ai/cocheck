// the print route (officePdfs without views) runs the open-watch rule while the app's open of the staged copy is pending. A confirmed prompt ends the side early with
// promptWhy; the rule never reads a window title (what CGWindowList gives without Screen Recording); a slow healthy open is never a prompt. Fakes only (no Office, no helper).
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { describe, it } from "node:test";
import { OFFICE_APPS, promptWhy } from "../src/office/connector/apps.ts";
import { officePdfs, type ExportOutcome, type WindowScreen, type OfficeExportDriver } from "../src/office/connector/office-job.ts";
import { fakeDriver, fakePager } from "./helpers/office-fake.ts";

const APP = OFFICE_APPS.powerpoint;
const __FILE__ = fileURLToPath(import.meta.url);
type W = { id: number; layer: number; bounds: { x: number; y: number; w: number; h: number }; onscreen: boolean; title: string };
const win = (id: number, title: string, w = 1600, h = 900): W => ({ id, layer: 0, bounds: { x: 0, y: 0, w, h }, onscreen: false, title });
const lister = (f: (n: number) => W[]): WindowScreen & { reads: number } => {
  const l = { reads: 0, windows: async () => ({ ok: true, windows: f(l.reads++) }) };
  return l as unknown as WindowScreen & { reads: number };
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Rig { driver: OfficeExportDriver; kills: string[]; asked: number[] }
/** A driver whose export call waits `openMs` (or until its own timeout), and whose document list answers `docs` (null: no answer, as a busy app). */
function rig(o: { openMs: number; docs: () => string[] | null }): Rig {
  const base = fakeDriver({ stageRoot: mkdtempSync(path.join(os.tmpdir(), "stage-")) });
  const kills: string[] = [], asked: number[] = [];
  const driver: OfficeExportDriver = {
    ...base.driver,
    pager: fakePager,
    async exportPdf(app, input, pdf, timeoutMs): Promise<ExportOutcome> {
      if (o.openMs > timeoutMs) { await sleep(timeoutMs); return { ok: false, timedOut: true, why: "no answer" }; }
      await sleep(o.openMs);
      return base.driver.exportPdf(app, input, pdf, timeoutMs);
    },
    async openDocuments(_app, t) { asked.push(t); return o.docs(); },
    kill(pid, signal, at) { kills.push(String(pid)); base.driver.kill(pid, signal, at); },
  };
  return { driver, kills, asked };
}
const opts = (r: Rig, windows: WindowScreen) => ({ driver: r.driver, lockPath: path.join(mkdtempSync(path.join(os.tmpdir(), "lock-")), "lock"), deadline: Date.now() + 60_000, windows, promptTickMs: 10, promptHoldMs: 60, sideTimeoutMs: 25_000, goneWaitMs: 200, pollMs: 10 });
const side = { side: "after" as const, file: __FILE__, name: "after.pptx" };

describe("the print route's open-watch", () => {
  for (const title of ["", "Untitled"]) {
    it(`a prompting open (stray window, document list answers without the copy) ends the side early with promptWhy; window title ${JSON.stringify(title)}`, { timeout: 30_000 }, async () => {
      const r = rig({ openMs: 20_000, docs: () => [] });
      const t0 = Date.now();
      const j = await officePdfs(APP, [side], opts(r, lister((n) => [win(5, ""), ...(n > 0 ? [win(91, title)] : [])])));
      assert.ok(!j.pending, JSON.stringify(j));
      const s = j.pending ? undefined : j.sides[0];
      assert.deepEqual(s && "prompt" in s ? [s.prompt, s.why] : s, [true, promptWhy(APP)]);
      assert.ok(Date.now() - t0 < 3_000, `took ${Date.now() - t0} ms, not the side timeout`);
      assert.equal(r.kills.length >= 1, true, "the app this job launched is stopped by its pid");
    });
  }
  it("a slow healthy open (a stray window, the document list not answering) is never a prompt; the PDF is returned", { timeout: 30_000 }, async () => {
    const r = rig({ openMs: 900, docs: () => null });
    const w = lister((n) => [win(5, ""), ...(n > 0 ? [win(91, "")] : [])]);
    const j = await officePdfs(APP, [side], opts(r, w));
    const s = j.pending ? undefined : j.sides[0];
    assert.ok(s && "pdf" in s, JSON.stringify(s));
    assert.ok(r.asked.length >= 2, "the watch did ask the document list while the open was pending");
    assert.equal(r.kills.length, 0);
  });
  it("a stray window while the document list names the copy (the open worked) is never a prompt, titles blank", { timeout: 30_000 }, async () => {
    const r = rig({ openMs: 900, docs: () => [path.join("/x", "after.pptx")] });
    const j = await officePdfs(APP, [side], opts(r, lister((n) => [win(5, ""), ...(n > 0 ? [win(91, "")] : [])])));
    const s = j.pending ? undefined : j.sides[0];
    assert.ok(s && "pdf" in s, JSON.stringify(s));
  });
  it("without a window helper there is no prompt verdict (the old hang path)", { timeout: 30_000 }, async () => {
    const r = rig({ openMs: 20_000, docs: () => [] });
    const j = await officePdfs(APP, [side], { ...opts(r, lister(() => [])), windows: undefined, sideTimeoutMs: 300 });
    const s = j.pending ? undefined : j.sides[0];
    assert.ok(s && "hang" in s && s.hang === true, JSON.stringify(s));
  });
});
