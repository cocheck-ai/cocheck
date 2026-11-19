// The rules of open-watch.ts (watchedOpen), pinned directly. The module stays: it is the live prompt rule on the print route. Each case below fails
// when its rule is removed. Must not: a healthy slow open called a prompt; those cases say so. Fakes only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { officePdfs, type ExportOutcome, type OfficeExportDriver, type WindowScreen } from "../src/office/connector/office-job.ts";
import { PROMPT_CONFIRMATIONS, watchedOpen } from "../src/office/connector/open-watch.ts";
import { fakeDriver, fakePager } from "./helpers/office-fake.ts";

type W = { id: number; layer: number; bounds: { x: number; y: number; w: number; h: number }; onscreen: boolean; title: string };
const win = (id: number, title: string, w = 410, h = 384): W => ({ id, layer: 0, bounds: { x: 551, y: 137, w, h }, onscreen: false, title });
const lister = (f: () => W[]): WindowScreen => ({ windows: async () => ({ ok: true, windows: f() }) }) as unknown as WindowScreen;
const later = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));
const never = (): Promise<never> => new Promise<never>(() => undefined);
const base = { pid: 4242, before: new Set([12]), names: ["fred"], tickMs: 10, holdMs: 60 };

describe("watchedOpen: the hold", () => {
  it("a stray window listed past the hold, the open pending, the app answering its list without the copy: a prompt with the stray windows", async () => {
    const r = await watchedOpen(never(), { ...base, helper: lister(() => [win(12, "Book1"), win(91, ""), win(92, "", 260, 234)]), confirm: async () => "absent" });
    assert.ok("prompt" in r, JSON.stringify(r));
    assert.deepEqual("prompt" in r ? r.prompt.windows.map((w) => w.id) : [], [91, 92]);
  });
  it("a stray window that goes before the hold is over is not a prompt", async () => {
    let n = 0;
    const r = await watchedOpen(later(300, "opened"), { ...base, holdMs: 150, helper: lister(() => (n++ < 2 ? [win(91, "")] : [])), confirm: async () => "absent" });
    assert.deepEqual(r, { done: "opened" });
  });
  it("a stray window goes away and a DIFFERENT window appears later: the new one is held from its own first sighting, not from the old one's", async () => {
    const t0 = Date.now();
    const at = (): number => Date.now() - t0;
    // window 91 is listed 0-40 ms, nothing 40-400 ms, window 92 from 400 ms; hold 250 ms; the open answers at 520 ms (120 ms after 92 appeared, inside its own hold)
    const r = await watchedOpen(later(520, "opened"), { ...base, holdMs: 250, helper: lister(() => (at() < 40 ? [win(91, "")] : at() >= 400 ? [win(92, "")] : [])), confirm: async () => "absent" });
    assert.deepEqual(r, { done: "opened" });
  });
  it("a stray window not yet held long enough is not asked about: the list is not read before the hold", async () => {
    let asked = 0;
    const r = await watchedOpen(later(100, "opened"), { ...base, holdMs: 5_000, helper: lister(() => [win(91, "")]), confirm: async () => { asked++; return "absent"; } });
    assert.deepEqual(r, { done: "opened" });
    assert.equal(asked, 0);
  });
});

describe("watchedOpen: the confirmations", () => {
  it("the default is two answers in a row", () => assert.equal(PROMPT_CONFIRMATIONS, 2));
  it("one quick answer without the copy, then no answer, is not enough", async () => {
    let n = 0;
    const r = await watchedOpen(later(500, "opened"), { ...base, helper: lister(() => [win(91, "")]), confirm: async () => (n++ === 0 ? "absent" : "no-answer") });
    assert.deepEqual(r, { done: "opened" });
  });
  it("two answers in a row without the copy are enough (default); the count is asked of the app that many times", async () => {
    let n = 0;
    const r = await watchedOpen(never(), { ...base, helper: lister(() => [win(91, "")]), confirm: async () => { n++; return "absent"; } });
    assert.ok("prompt" in r);
    assert.equal(n, 2);
  });
  it("a busy app (the list does not answer) is never a prompt", async () => {
    const r = await watchedOpen(later(500, "opened"), { ...base, helper: lister(() => [win(91, "")]), confirm: async () => "no-answer" });
    assert.deepEqual(r, { done: "opened" });
  });
  it("a list that names the copy resets the confirmation: absent and present alternating (never two absents in a row), then the open answers", async () => {
    let n = 0;
    const r = await watchedOpen(later(400, "opened"), { ...base, helper: lister(() => [win(91, "")]), confirm: async () => (n++ % 2 === 0 ? "absent" : "present") });
    assert.deepEqual(r, { done: "opened" });
  });
});

describe("watchedOpen: no way to ask, and nothing to watch", () => {
  it("a window alone, with no way to ask the document list, is no prompt", async () => {
    const r = await watchedOpen(later(400, "opened"), { ...base, helper: lister(() => [win(91, "")]) });
    assert.deepEqual(r, { done: "opened" });
  });
  it("an open that answers at once reads no list", async () => {
    let lists = 0;
    const r = await watchedOpen(Promise.resolve("opened"), { ...base, helper: { windows: async () => { lists++; return { ok: true, windows: [] }; } } as unknown as WindowScreen });
    assert.deepEqual(r, { done: "opened" });
    assert.equal(lists, 0);
  });
  it("the copy's own window, windows listed before the open, and the open's failure rethrown", async () => {
    const r = await watchedOpen(later(200, "opened"), { ...base, helper: lister(() => [win(12, ""), win(77, "fred"), win(78, "a-fred - Read-Only")]), confirm: async () => "absent" });
    assert.deepEqual(r, { done: "opened" });
    await assert.rejects(watchedOpen(later(30, 0).then(() => { throw new Error("boom"); }), { ...base, helper: lister(() => []) }), /boom/);
  });
  it("Word's real untitled 500x500 helper window (repo fixture), listed during a slow healthy open, is not a prompt when the app does not answer its list", async () => {
    const REAL = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "word-look-live.json"), "utf8")) as { windows: W[] }[];
    const before = new Set(REAL[0]!.windows.map((w) => w.id));
    const after = REAL[2]!.windows;
    assert.ok(after.some((w) => w.id === 31117 && w.title === "" && !before.has(31117)));
    const r = await watchedOpen(later(600, { ok: true }), { ...base, before, names: ["after"], helper: lister(() => after), confirm: async () => "no-answer" });
    assert.deepEqual(r, { done: { ok: true } });
  });
});

describe("the print route: each open's watch starts from the windows listed right before that open", () => {
  const APP = OFFICE_APPS.powerpoint;
  const __FILE__ = fileURLToPath(import.meta.url);
  it("the first copy's open leaves an untitled window; the second copy's slow healthy open (list answers, window already there) is not a prompt, nothing is killed", { timeout: 30_000 }, async () => {
    const fd = fakeDriver({ stageRoot: mkdtempSync(path.join(os.tmpdir(), "owr-stage-")) });
    const kills: string[] = [];
    let opens = 0, left = false;
    const driver: OfficeExportDriver = {
      ...fd.driver,
      pager: fakePager,
      async exportPdf(app, input, pdf, t): Promise<ExportOutcome> {
        const n = opens++;
        await new Promise((r) => setTimeout(r, n === 0 ? 5 : 400));
        if (n === 0) left = true;
        return fd.driver.exportPdf(app, input, pdf, t);
      },
      async openDocuments() { return []; },
      kill(pid, signal, at) { kills.push(String(pid)); fd.driver.kill(pid, signal, at); },
    };
    const windows = lister(() => (left ? [win(31117, "", 500, 500)] : []));
    const j = await officePdfs(APP, [{ side: "before", file: __FILE__, name: "before.pptx" }, { side: "after", file: __FILE__, name: "after.pptx" }], { driver, lockPath: path.join(mkdtempSync(path.join(os.tmpdir(), "owr-lock-")), "lock"), deadline: Date.now() + 60_000, windows, promptTickMs: 10, promptHoldMs: 60, sideTimeoutMs: 25_000, goneWaitMs: 200, pollMs: 10 });
    assert.ok(!j.pending, JSON.stringify(j));
    const s = j.pending ? [] : j.sides;
    assert.equal(s.length, 2);
    assert.ok(s.every((p) => !("why" in p) || !/prompt/i.test(p.why)), JSON.stringify(s));
    assert.equal(kills.length, 0, JSON.stringify(kills));
    assert.equal(opens, 2);
  });
});
