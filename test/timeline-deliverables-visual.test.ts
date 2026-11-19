import { describe, it } from "node:test";
import { chromeHeadlessArgs } from "./helpers/chrome.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// the Deliverables view. (1) every node of the per-deliverable strip, and every track segment, on one line, with any node selected;
// (2) the list card keeps chips, mini rail and pills inside its padding (long chip text, 8+ versions); (3) a version shows the pass/fail
// mark of its own step and nothing when it has none; (4) the file-name tooltip is placed above, never over the node labels.
// Measured in headless Chrome on the real page shell, the real review.css and the real files-view.js. REVIEW_LAYOUT_ROOT points at another
// checkout (red runs).
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const ROOT = process.env.REVIEW_LAYOUT_ROOT ?? new URL("..", import.meta.url).pathname;

const ver = (k: number, lane: string, mark: string | null) => ({ change: "c" + k, stop: "s" + k, sha: "h" + k, lane, chip: lane === "x" ? "C" : "H", at: 1762000000000 + k * 60000, label: k === 1 ? "Created" : "Changed", kind: k === 1 ? "created" : "modified", kept: true, inferred: k % 2 === 0 ? true : undefined, mark });
const files = [
  { file: "t12/deck.pptx", name: "deck.pptx", sameAs: "same bytes as deck-recolored-final-version-for-the-board.pptx (top folder)", start: "none", versions: [ver(1, "x", "passed"), ver(2, "x", null)] },
  { file: "t12/many.xlsx", name: "many.xlsx", where: "a-very-long-folder-name", sameAs: "same bytes as an-extremely-long-file-name-that-keeps-going-and-going.xlsx (top folder)", start: "kept", versions: Array.from({ length: 9 }, (_, i) => ver(i + 1, i % 2 ? "x" : "y", i === 3 ? "failed" : i === 4 ? "passed" : null)) },
];

describe("Deliverables view measured in Chrome", { skip: CHROME ? false : "no Chrome installed" }, () => {
  it("strip on one line, card inside its padding, marks on the right versions, tooltip above", async (t) => {
    const { renderReviewShell } = await import(join(ROOT, "src/timeline/rail/page.ts"));
    const cssText = await readFile(join(ROOT, "src/timeline/rail/assets/review.css"), "utf8");
    const fv = await readFile(join(ROOT, "src/timeline/rail/assets/files-view.js"), "utf8");
    const rv = await readFile(join(ROOT, "src/timeline/rail/assets/review.js"), "utf8");
    let html = renderReviewShell(7).replace(/<link[^>]*review\.css[^>]*>/, `<style>${cssText}</style>`).replace(/<script[^>]*src=[^>]*><\/script>/g, "");
    html = html.replace('id="listcol" hidden', 'id="listcol"').replace('id="filesview" hidden', 'id="filesview"');
    const elSrc = /function el\(tag, attrs\) \{[\s\S]*?\n  \}\n/.exec(rv)![0];
    const boot = `<script>${fv}</script><script>
var FILES=${JSON.stringify(files)};
${elSrc}
var cols={x:'#7fb0e0',y:'#e0a87f'};
var FH={el:el,chip:function(l){var b=el('b',{class:'chip'},l==='x'?'C':'H');b.style.background=cols[l];return b},name:function(l){return l==='x'?'Codex':'Helper'},color:function(l){return cols[l]},pick:function(){},go:function(){},
 markOf:function(f){var v=f.versions[f.versions.length-1];return v.mark},markOfVersion:function(v){return v.mark},verdictOf:function(){return {yes:true,p:.9}}};
window.draw=function(fi,p){var f=FILES[fi];CoCheckFilesView.paintList(document.getElementById('fileslist'),FILES,fi,FH);CoCheckFilesView.paintStrip(document.getElementById('strip'),f,p,FH);CoCheckFilesView.paintHead(document.getElementById('fvname'),document.getElementById('fvorder'),f,p,FH)};
</script>`;
    html = html.replace("</body>", boot + "</body>");
    const dir = join(tmpdir(), "cocheck-chrome");
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
    const ev = async (x: string) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };

    const measure = `(()=>{
      const R=(e)=>e.getBoundingClientRect();
      const nodes=[...document.querySelectorAll('#strip .vn')];
      const lines=nodes.map(n=>{const t=R(n.querySelector('.top'));return {mk:t.top,seg:t.top}});
      const marks=nodes.map(n=>{const j=n.querySelector('.jm');return j?j.textContent+':'+j.className:''});
      const labels=nodes.map(n=>[...n.children].map(c=>R(c)).map(b=>[b.left,b.top,b.right,b.bottom]));
      const nrect=nodes.map(n=>{const b=R(n);return [b.left,b.top,b.right,b.bottom]});
      const col=R(document.getElementById('fileslist'));
      const cards=[...document.querySelectorAll('#fileslist .fi')].map(c=>{const cb=R(c),cs=getComputedStyle(c),pr=cb.right-parseFloat(cs.paddingRight)-parseFloat(cs.borderRightWidth);
        const kids=[...c.querySelectorAll('.nm,.wh,.vv,.jm,.mv,.vchip')].map(k=>({c:k.className,r:R(k).right,w:R(k).width}));
        return {right:cb.right,pr,kids,wh:[...c.querySelectorAll('.wh')].map(w=>R(w).width)}});
      return {lines,marks,labels,nrect,colRight:col.right,cards,sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}})()`;
    const fails: string[] = [];
    for (const w of [1250, 1600, 1920]) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: "file://" + page });
      await new Promise((r) => setTimeout(r, 400));
      for (const [fi, n] of [[0, 2], [1, 9]] as const) {
        for (let p = 0; p <= n + 1; p++) {
          await ev(`draw(${fi},${p})`);
          const m = await ev(measure);
          const tag = `w${w} file${fi} sel${p}`;
          const ref = m.lines[0].mk;
          m.lines.forEach((l: any, k: number) => {
            if (Math.abs(l.mk - ref) > 1) fails.push(`${tag}: node ${k} centre ${l.mk.toFixed(1)} vs ${ref.toFixed(1)}`);
            if (Math.abs(l.seg - ref) > 1) fails.push(`${tag}: segment ${k} centre ${l.seg.toFixed(1)} vs ${ref.toFixed(1)}`);
          });
          // labels of a node stay inside it and never overlap each other
          m.labels.forEach((ls: number[][], k: number) => { for (let a = 0; a < ls.length; a++) { if (ls[a]![3]! > m.nrect[k][3] + 0.5 || ls[a]![2]! > m.nrect[k][2] + 0.5) fails.push(`${tag}: node ${k} label ${a} leaves its node`); if (a && ls[a]![1]! < ls[a - 1]![3]! - 0.5) fails.push(`${tag}: node ${k} labels ${a - 1}/${a} collide`); } });
          // marks: strip reads Before task, v1..vN, Now; version v(q) is at index q
          const f = files[fi]!;
          m.marks.forEach((mk: string, idx: number) => {
            const q = idx;
            const want = q >= 1 && q <= n ? f.versions[q - 1]!.mark : null;
            const got = mk.includes("pass") ? "passed" : mk.includes("fail") ? "failed" : mk === "" ? null : "?";
            if (got !== want) fails.push(`${tag}: step mark at position ${q} is ${got}, want ${want}`);
          });
          for (const c of m.cards) {
            if (c.right > m.colRight + 0.5) fails.push(`${tag}: card right ${c.right} past its column ${m.colRight}`);
            for (const k of c.kids) if (k.r > c.pr + 0.5) fails.push(`${tag}: card child .${k.c} ends ${k.r.toFixed(1)} past padding edge ${c.pr.toFixed(1)}`);
            for (const x of c.wh) if (x < 20) fails.push(`${tag}: a chip was squeezed to ${x}px`);
          }
          if (m.sw > m.cw + 0.5) fails.push(`${tag}: page scrolls sideways`);
        }
      }
    }
    // the tooltip: the name carries its path as a custom tip hung above the heading, not a native one that lands on the strip
    await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await ev("draw(0,3)");
    const tip = await ev(`(()=>{const h=document.getElementById('fvname');return {title:h.getAttribute('title'),tip:h.getAttribute('data-tip')}})()`);
    if (tip.title) fails.push("the heading still has a native title tooltip");
    if (tip.tip !== "t12/deck.pptx") fails.push(`data-tip is ${tip.tip}`);
    const hb = await ev(`(()=>{const h=document.getElementById('fvname');h.scrollIntoView({block:'center'});const b=h.getBoundingClientRect();return [b.left+5,b.top+b.height/2]})()`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hb[0] - 1, y: hb[1] - 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hb[0], y: hb[1] });
    await new Promise((r) => setTimeout(r, 150));
    const geo = await ev(`(()=>{const h=document.getElementById('fvname'),cs=getComputedStyle(h,'::after');return {display:cs.display,pos:cs.position,bottom:parseFloat(cs.bottom),h:h.getBoundingClientRect().height}})()`);
    if (geo.display === "none" || geo.pos !== "absolute" || !(geo.bottom >= geo.h - 0.5)) fails.push(`tooltip not hung above the heading: ${JSON.stringify(geo)}`);
    assert.deepEqual(fails, []);
  });
});
