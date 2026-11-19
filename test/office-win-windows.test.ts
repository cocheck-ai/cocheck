// a blocking Office dialog answers 'prompt' on Windows. The Windows window list is `windows(pid)` + `close()` over one WinHost
// (op `windows {pid}` in office-win.ps1), the same contract as the Mac's ScreenHelper. Every case runs on every OS against the fake JSON-lines host; no PowerShell, no Office.
// The Guards against: the helper acting on a window (the grep case: read-only API only) vs a real blocking dialog read as no window (the appearing-window case).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { OFFICE_APPS, promptWhy } from "../src/office/connector/apps.ts";
import { officePdfs, type ExportOutcome, type OfficeExportDriver } from "../src/office/connector/office-job.ts";
import { watchedOpen } from "../src/office/connector/open-watch.ts";
import { HOST_SCRIPT } from "../src/office/connector/office-win.ts";
import { officeDeps } from "../src/office/connector/main.ts";
import { WinScreen, winPromptWindows } from "../src/office/connector/screen-windows.ts";
import { fakeDriver, fakePager } from "./helpers/office-fake.ts";

const FAKE = path.join(import.meta.dirname, "fixtures", "office-win", "fake-host.mjs");
const screen = (mode: string, timeoutMs?: number): WinScreen => new WinScreen({ command: { command: process.execPath, args: [FAKE, mode] } }, timeoutMs);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const APP = OFFICE_APPS.powerpoint;
const side = { side: "after" as const, file: fileURLToPath(import.meta.url), name: "after.pptx" };

describe("the Windows window list", () => {
  it("windows(pid) answers ok with ScreenWindow rows (id, layer, bounds, onscreen, title)", async () => {
    const s = screen("full");
    try {
      const r = await s.windows(4242);
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepEqual(r.ok && r.windows, [{ id: 5, layer: 0, title: "Deck", bounds: { x: 0, y: 0, w: 1600, h: 900 }, onscreen: true }]);
    } finally { await s.close(); }
  });
  it("a host that does not answer in time gives ok:false", async () => {
    const s = screen("windows-hang", 150);
    try {
      const r = await s.windows(1);
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.why, /did not answer windows/);
    } finally { await s.close(); }
  });
  it("a host that cannot start gives ok:false, never a throw", async () => {
    const s = new WinScreen({ command: { command: path.join(os.tmpdir(), "no-such-host"), args: [] } }, 500);
    const r = await s.windows(1);
    assert.equal(r.ok, false);
    await s.close();
  });
  for (const mode of ["windows-appear", "windows-nested-appear"]) it(`a dialog appearing during the open (${mode}: ${mode === "windows-appear" ? "a flat row" : "only a nested dialog row, as UIA exposes an owned modal"}) gives the existing prompt verdict end to end through officePdfs`, { timeout: 30_000 }, async () => {
    const s = screen(mode);
    const base = fakeDriver({ stageRoot: mkdtempSync(path.join(os.tmpdir(), "stage-")) });
    const kills: string[] = [];
    const driver: OfficeExportDriver = {
      ...base.driver,
      pager: fakePager,
      async exportPdf(app, input, pdf, timeoutMs): Promise<ExportOutcome> { await sleep(Math.min(20_000, timeoutMs)); return { ok: false, timedOut: true, why: "no answer" }; },
      async openDocuments() { return []; },
      kill(pid, signal, at) { kills.push(String(pid)); base.driver.kill(pid, signal, at); },
    };
    try {
      const t0 = Date.now();
      const j = await officePdfs(APP, [side], { driver, lockPath: path.join(mkdtempSync(path.join(os.tmpdir(), "lock-")), "lock"), deadline: Date.now() + 60_000, windows: s, promptTickMs: 10, promptHoldMs: 60, sideTimeoutMs: 25_000, goneWaitMs: 200, pollMs: 10 });
      assert.ok(!j.pending, JSON.stringify(j));
      const r = j.pending ? undefined : j.sides[0];
      assert.deepEqual(r && "prompt" in r ? [r.prompt, r.why] : r, [true, promptWhy(APP)]);
      assert.ok(Date.now() - t0 < 5_000, "ended at the prompt, not at the side timeout");
      assert.ok(kills.length >= 1);
    } finally { await s.close(); }
  });
  it("a nested pane already listed before the open is baseline, not a prompt", { timeout: 15_000 }, async () => {
    const s = screen("windows-nested-before");
    try {
      const first = await s.windows(1);
      assert.ok(first.ok && first.windows.some((w) => w.id === 77));
      const call = sleep(600).then(() => "opened");
      const w = await watchedOpen(call, { helper: s, pid: 1, before: new Set(first.ok ? first.windows.map((q) => q.id) : []), names: ["Deck"], tickMs: 10, holdMs: 60 });
      assert.deepEqual(w, { done: "opened" });
    } finally { await s.close(); }
  });
  it("main.ts wiring: win32 gets a window helper, linux gets none, the Mac keeps its own", () => {
    assert.equal(typeof winPromptWindows("win32"), "function");
    assert.equal(winPromptWindows("linux"), undefined);
    assert.equal(winPromptWindows("darwin"), undefined);
    const deps = officeDeps({ COCHECK_ALLOW_REAL_OFFICE: "1" } as NodeJS.ProcessEnv, "win32");
    assert.equal(typeof deps.windows, "function");
    assert.equal(officeDeps({ COCHECK_ALLOW_REAL_OFFICE: "1" } as NodeJS.ProcessEnv, "linux").windows, undefined);
  });
  it("the windows op's script text holds no acting call and no Add-Type", () => {
    const ps = readFileSync(HOST_SCRIPT, "utf8");
    const a = ps.indexOf("# --- window list ---");
    const b = ps.indexOf("# --- end window list ---");
    assert.ok(a >= 0 && b > a, "the op sits between its marker lines");
    const text = ps.slice(a, b);
    assert.match(text, /\$Ops\['windows'\]/);
    assert.match(text, /TreeScope\]::Descendants/);
    assert.match(text, /ControlType\]::Window/);
    assert.match(text, /Assembly\]::Load\('UIAutomationClient/);
    for (const bad of ["SetFocus", "SendKeys", "Invoke(", "Close(", "SetForegroundWindow", "Add-Type"]) assert.equal(text.includes(bad), false, `${bad} in the op`);
  });
});
