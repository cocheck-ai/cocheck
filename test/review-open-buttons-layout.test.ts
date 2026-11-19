import { describe, it } from "node:test";
import { chromeHeadlessArgs } from "./helpers/chrome.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// The Open before/after buttons sit under the step title, never below a tall notes column, and the note cards stay inside the
// window at 1440 and 1280. Measured in headless Chrome on the real page shell and the real review.css with a worst-case stage
// (short grids, tall notes, a grid and a tab strip wider than their pane). REVIEW_LAYOUT_ROOT points at another checkout (red runs).
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
type Box = [number, number, number, number];

describe("review page layout measured in Chrome (macOS or Linux Chrome path)", { skip: CHROME ? false : "no Chrome installed" }, () => {
  it("the note cards end inside the window at 1440 and 1280 (migration M3.5: the Open buttons are gone)", async (t) => {
    const root = process.env.REVIEW_LAYOUT_ROOT ?? new URL("..", import.meta.url).pathname;
    const { renderReviewShell: render } = await import(join(root, "src/timeline/rail/page.ts"));
    const cssText = await readFile(join(root, "src/timeline/rail/assets/review.css"), "utf8");
    const wide = `<table class="grid"><tbody><tr>${"<td>wide column heading</td>".repeat(14)}</tr><tr>${"<td>1,860,000</td>".repeat(14)}</tr></tbody></table>`;
    const tabs = `<button class="tab on">Summary</button><button class="tab">Summary chart: Revenue and Cost by Month</button><button class="tab">Another long chart tab name here</button>`;
    const note = (top: number) => `<div class="note sel" style="top:${top}px"><span class="t">A6:B9</span><span class="v">Codex raised cell B6 on the sheet 'Summary' from $1,860,000 to $1,871,000 (labelled "Total revenue, Amount")</span></div>`;
    let html = render(7).replace(/<link[^>]*review\.css[^>]*>/, `<style>${cssText}</style>`);
    html = html.replace('<div class="notes" id="notes"></div>', `<div class="notes" id="notes" style="height:640px">${note(0)}${note(190)}${note(380)}</div>`);
    html = html.replace('<div class="tabs" id="tb"></div>', `<div class="tabs" id="tb">${tabs}</div>`).replace('<div class="tabs" id="ta"></div>', `<div class="tabs" id="ta">${tabs}</div>`);
    html = html.replace('<div class="vw" id="vb"></div>', `<div class="vw" id="vb">${wide}</div>`).replace('<div class="vw" id="va"></div>', `<div class="vw" id="va">${wide}</div>`);
    const dir = join(tmpdir(), "cocheck-review-layout-chrome");
    await mkdir(dir, { recursive: true });
    const page = join(dir, "page.html");
    await writeFile(page, html);
    await unlink(join(dir, "profile", "DevToolsActivePort")).catch(() => {});
    const chrome = spawn(CHROME!, chromeHeadlessArgs(join(dir, "profile")), { stdio: "ignore" });
    t.after(() => { chrome.kill(); });
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { port = Number((await readFile(join(dir, "profile", "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { /* not up yet */ }
    }
    assert.ok(port, "Chrome did not start");
    const tabsList = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const ws = new WebSocket(tabsList.find((x) => x.type === "page")!.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0;
    const pend: Record<number, (v: any) => void> = {};
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend[m.id]) pend[m.id]!(m.result ?? m.error); };
    t.after(() => ws.close());
    const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true })).result?.value;
    const fails: string[] = [];
    for (const w of [1440, 1280]) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: "file://" + page });
      await new Promise((r) => setTimeout(r, 500));
      const m = (await ev(`(()=>{const r=(s)=>{const b=document.querySelector(s).getBoundingClientRect();return [b.left,b.top,b.right,b.bottom]};return {stage:r('#stage'),pb:r('#pb'),notes:[...document.querySelectorAll('#notes .note')].map(n=>{const b=n.getBoundingClientRect();return [b.left,b.top,b.right,b.bottom]}),vw:innerWidth,sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}})()`)) as { ox: Box; stage: Box; pb: Box; notes: Box[]; vw: number; sw: number; cw: number };
      for (const n of m.notes) if (n[2] > m.cw + 0.5) fails.push(`${w}: a note card ends at ${Math.round(n[2])}, past the window ${m.cw}`);
      if (m.sw > m.cw + 0.5) fails.push(`${w}: the page scrolls sideways (${m.sw} > ${m.cw})`);
    }
    assert.deepEqual(fails, []);
  });

  it("a long Changed card shows its show-all toggle, and opening it shows both the old and the new words in full", async (t) => {
    const root = process.env.REVIEW_LAYOUT_ROOT ?? new URL("..", import.meta.url).pathname;
    const cssText = await readFile(join(root, "src/timeline/rail/assets/review.css"), "utf8");
    const js = await readFile(join(root, "src/timeline/rail/assets/review.js"), "utf8");
    const fn = /function refreshClamps\(\) \{[\s\S]*?\n  \}\n/.exec(js)![0];
    const long = (w: string) => Array.from({ length: 40 }, (_, k) => `${w}${k}`).join(" ");
    const html = `<!doctype html><style>${cssText}</style><div style="width:236px" id="notes" class="notes"><div class="note sel capped" id="card"><span class="v" id="vv"><span class="cardv clamp" id="cv"><span class="cs"><b>Edited: </b><s>${long("old")}</s></span><span class="cs">${long("new")}</span></span><button class="toggle" id="tg" type="button" hidden>show all</button></span></div></div>
<script>var clampers=[{node:document.getElementById('cv'),all:[document.getElementById('cv'),document.getElementById('card')],btn:document.getElementById('tg')}];${fn}refreshClamps();</script>`;
    const dir = join(tmpdir(), "cocheck-review-layout-chrome2");
    await mkdir(dir, { recursive: true });
    const page = join(dir, "page.html");
    await writeFile(page, html);
    await unlink(join(dir, "profile", "DevToolsActivePort")).catch(() => {});
    const chrome = spawn(CHROME!, chromeHeadlessArgs(join(dir, "profile")), { stdio: "ignore" });
    t.after(() => { chrome.kill(); });
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { port = Number((await readFile(join(dir, "profile", "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { /* not up yet */ }
    }
    assert.ok(port, "Chrome did not start");
    const tabsList = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const ws = new WebSocket(tabsList.find((x) => x.type === "page")!.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0;
    const pend: Record<number, (v: any) => void> = {};
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend[m.id]) pend[m.id]!(m.result ?? m.error); };
    t.after(() => ws.close());
    const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true })).result?.value;
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: "file://" + page });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await ev("document.getElementById('tg').hidden"), false, "the toggle shows for a card whose sides are cut");
    await ev("['cv','card'].forEach(i=>document.getElementById(i).classList.add('open'))");
    const cut = await ev("[...document.querySelectorAll('.cs')].map(e=>e.scrollHeight>e.clientHeight+1)");
    assert.deepEqual(cut, [false, false], "open: neither side is cut");
    const hs = (await ev("[...document.querySelectorAll('.cs')].map(e=>e.clientHeight)")) as number[];
    assert.ok(hs.every((h) => h > 60), `open: both sides show more than two lines (${hs})`);
  });
});
