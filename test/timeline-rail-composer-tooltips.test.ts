import { describe, it } from "node:test";
import { chromeHeadlessArgs } from "./helpers/chrome.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// the fail box and the sticky note carry no grey caption; the hints are tooltips (on hover and keyboard focus) on the
// Box/Freehand control and on Save and Cancel; Box/Freehand is one segmented control; no green; no tooltip lands on the textarea.
const css = readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
const comp = (html: string, id: string, end: string) => html.slice(html.indexOf(`id="${id}"`), html.indexOf(end, html.indexOf(`id="${id}"`)));

describe("composers", () => {
  const html = renderReviewShell(7);
  for (const [id, end] of [["pcomp", 'id="pbprev"'], ["ncomp", 'id="pcomp"']] as const) {
    const c = comp(html, id, end);
    it(`${id}: no caption paragraph or key sentence is left`, () => {
      assert.doesNotMatch(c, /class="rhint"/);
      assert.doesNotMatch(c, /<span>Enter saves/);
      assert.doesNotMatch(c, /<\/div><p/);
    });
    it(`${id}: Box/Freehand, Save and Cancel each have a tooltip their button points at`, () => {
      const tips = [...c.matchAll(/<span class="tip" role="tooltip" id="([^"]+)">([^<]*)<\/span>/g)];
      assert.equal(tips.length, 3, "regtool, Save, Cancel");
      for (const t of tips) assert.match(c, new RegExp(`aria-describedby="${t[1]}"`), t[1]);
      assert.match(tips.map((t) => t[2]).join("|"), /box or freehand/i);
      if (id === "pcomp") { assert.match(tips[1]![2]!, /Enter/); assert.match(tips[2]![2]!, /Esc/); }
    });
  }
  it("the sticky note keeps (as the textarea placeholder, not a hover) the whole-task and text-selection rule", () => {
    assert.match(comp(html, "ncomp", 'id="pcomp"'), /<textarea id="nnote"[^>]*placeholder="[^"]*no spot[^"]*no text selected[^"]*whole task/i);
  });
  it("css: one outer border with one divider, filled selected state, tooltip on hover and focus, no green", async () => {
    const s = await css;
    assert.match(s, /\.tip\{[^}]*position:absolute/);
    assert.match(s, /:hover[^{]*\.tip[^{]*\{[^}]*display:block|:hover > \.tip/);
    assert.match(s, /:focus-within[^{]*\.tip|:focus-visible[^{]*\.tip/);
    assert.match(s, /\.regtool button\[aria-pressed=true\]\{[^}]*background:var\(--before-wash\)/); // the old --sky is the before wash token
    const block = s.split("\n").filter((l) => /^\.(regtool|pcomp|ncomp|tip)/.test(l)).join("\n");
    assert.doesNotMatch(block, /--pass|green/);
    assert.doesNotMatch(block, /--fail\b/);
  });
  it("a tooltip sits beside its control (left:100%), never above where the textarea is", async () => {
    const s = await css;
    assert.match(s, /\.tip\{[^}]*left:calc\(100% \+/);
    assert.doesNotMatch(s, /\.tip\{[^}]*bottom:100%/);
  });
});

// measured in headless Chrome. A tooltip never overlaps the textarea or another control of its composer, and
// stays inside the composer and the viewport, on hover and on Tab focus, at 420, 1280 and 1920 wide.
// T307_ROOT points the test at another checkout of the source (used to run it red against the old code).
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
type Box = [number, number, number, number];
const hit = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

describe("tooltip boxes measured in Chrome", { skip: CHROME ? false : "no Chrome installed" }, () => {
  it("no tooltip covers the textarea or a control, and all stay inside the composer and the viewport", async (t) => {
    const root = process.env.T307_ROOT ?? new URL("..", import.meta.url).pathname;
    const { renderReviewShell: render } = await import(join(root, "src/timeline/rail/page.ts"));
    const cssText = await readFile(join(root, "src/timeline/rail/assets/review.css"), "utf8");
    const base = render(7).replace(/<link[^>]*review\.css[^>]*>/, `<style>${cssText}</style>`).replace('id="pbar" role="group" aria-label="Review" hidden', 'id="pbar" role="group" aria-label="Review"');
    const dir = join(tmpdir(), "cocheck-chrome");
    await mkdir(dir, { recursive: true });
    const page = join(dir, "page.html");
    const { writeFile } = await import("node:fs/promises");
    await unlink(join(dir, "profile", "DevToolsActivePort")).catch(() => {});
    const chrome = spawn(CHROME!, chromeHeadlessArgs(join(dir, "profile")), { stdio: "ignore" });
    t.after(() => { chrome.kill(); });
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { port = Number((await readFile(join(dir, "profile", "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { /* not up yet */ }
    }
    assert.ok(port, "Chrome did not start");
    const tabs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const ws = new WebSocket(tabs.find((x) => x.type === "page")!.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0;
    const pend: Record<number, (v: any) => void> = {};
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend[m.id]) pend[m.id]!(m.result ?? m.error); };
    t.after(() => ws.close());
    const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true })).result?.value;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const rect = (sel: string) => `(()=>{const r=${sel}.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})()`;
    const composers = [["pcomp", "vnote"], ["ncomp", "nnote"]] as const;
    const fails: string[] = [];
    let seen = 0;
    for (const [cid, ta] of composers) {
      await writeFile(page, base.replace(`id="${cid}" hidden`, `id="${cid}"`));
      for (const w of [420, 1280, 1920]) {
        await send("Emulation.setDeviceMetricsOverride", { width: w, height: 700, deviceScaleFactor: 1, mobile: false });
        await send("Page.navigate", { url: "file://" + page });
        await wait(600);
        const q = `document.getElementById('${cid}')`;
        const comp = (await ev(rect(q))) as Box;
        const taBox = (await ev(rect(`document.getElementById('${ta}')`))) as Box;
        const ctrls = (await ev(`[...${q}.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})`)) as Box[];
        const buttons = (await ev(`[...${q}.querySelectorAll('button')].map(b=>b.id)`)) as string[];
        const check = async (how: string) => {
          const tip = (await ev(`(()=>{const t=[...${q}.querySelectorAll('.tip')].find(t=>getComputedStyle(t).display!=='none');if(!t)return null;const r=t.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})()`)) as Box | null;
          if (!tip) { fails.push(`${cid} ${w} ${how}: no tooltip shown`); return; }
          seen++;
          const tag = `${cid} ${w} ${how} tip ${tip.map(Math.round)}`;
          if (hit(tip, taBox)) fails.push(`${tag} covers the textarea ${taBox.map(Math.round)}`);
          ctrls.forEach((c, i) => { if (hit(tip, c)) fails.push(`${tag} covers #${buttons[i]} ${c.map(Math.round)}`); });
          if (tip[0] < comp[0] - 1 || tip[2] > comp[2] + 1 || tip[1] < comp[1] - 1 || tip[3] > comp[3] + 1) fails.push(`${tag} pokes out of the composer ${comp.map(Math.round)}`);
          if (tip[0] < 0 || tip[2] > w) fails.push(`${tag} leaves the viewport ${w}`);
        };
        for (let i = 0; i < ctrls.length; i++) {
          const c = ctrls[i]!;
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (c[0] + c[2]) / 2, y: (c[1] + c[3]) / 2 });
          await wait(80);
          await check(`hover #${buttons[i]}`);
        }
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
        await ev(`document.getElementById('${ta}').focus()`);
        for (let i = 0; i < ctrls.length; i++) {
          await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
          await wait(80);
          await check(`tab to #${await ev("document.activeElement.id")}`);
        }
      }
    }
    assert.ok(seen >= 30, `only ${seen} tooltips measured`);
    assert.deepEqual(fails, []);
  });
});
