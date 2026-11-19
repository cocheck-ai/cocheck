import { describe, it } from "node:test";
import { chromeHeadlessArgs } from "./helpers/chrome.ts";
import { servedFor } from "./helpers/v1-served.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Change-first focus layer measured in headless Chrome : the real review shell, the real review.css, review.js and view-table.js, served by a
// throwaway http server on port 0 with a stub model and view. The change is W1 change c1 of the round-1 probe (newboxes/W1.json): a paragraph with a box and word
// highlights on each side of page 1 (rect in picture pixels, 1224 x 1584), plus one after-only change. Screenshots go to CFV_SHOTS (default: a temp dir).
// Chrome is started with its own temp profile and a debugging port of 0; nothing of the user's is read. REVIEW_LAYOUT_ROOT points at another checkout (red runs).
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const ROOT = process.env.REVIEW_LAYOUT_ROOT ?? new URL("..", import.meta.url).pathname;
const SHA_B = "b".repeat(64), SHA_A = "a".repeat(64);
const hlB = [{ x: 235.1, y: 211.1, w: 76.8, h: 26.8 }, { x: 351.6, y: 211.1, w: 77.9, h: 26.8 }, { x: 649.2, y: 211.1, w: 150.4, h: 26.8 }, { x: 879.8, y: 211.1, w: 125.6, h: 26.8 }];
const hlA = [{ x: 235.1, y: 211.1, w: 76.0, h: 26.8 }, { x: 565.9, y: 211.1, w: 131.9, h: 26.8 }, { x: 778.1, y: 211.1, w: 91.6, h: 26.8 }, { x: 201.5, y: 242.0, w: 68.8, h: 26.8 }, { x: 303.5, y: 242.0, w: 124.9, h: 26.8 }];
const LONG = "This report sets out the delivery approach, the milestones, the staffing plan and the risks we expect, in full sentences that run past the old two hundred and forty character clip so the whole comment must be visible when the box is hovered, including this very last clause.";
const pic = (sha: string) => ({ sha, width: 1224, height: 1584, page: 1 });
const view = {
  change: "k1", file: "report.docx", engine: "LibreOffice", kind: "pages", caveats: [], boxes: [],
  before: [{ id: "before:page1", label: "Before, page 1", picture: pic(SHA_B) }], after: [{ id: "after:page1", label: "After, page 1", picture: pic(SHA_A) }],
  changes: [
    { id: "c1", loc: "paragraph 4", kind: "paragraph", parent: null, boxes: [{ side: "before", pane: "before:page1", rect: { x: 129.8, y: 211.1, w: 951.6, h: 57.7 }, highlights: hlB }, { side: "after", pane: "after:page1", rect: { x: 129.8, y: 211.1, w: 925.3, h: 57.7 }, highlights: hlA }] },
    { id: "c2", loc: "paragraph 9", kind: "paragraph", parent: null, boxes: [{ side: "after", pane: "after:page1", rect: { x: 130, y: 600, w: 700, h: 80 } }] },
    { id: "c3", loc: "paragraph 12", kind: "paragraph", parent: null, boxes: [], unplaced: { after: "not marked" } },
    { id: "c4", loc: "paragraph 20", kind: "paragraph", parent: null, boxes: [{ side: "before", pane: "before:page1", rect: { x: 129.8, y: 1440, w: 500, h: 60 } }] },
    { id: "c5", loc: "paragraph 21", kind: "paragraph", parent: null, boxes: [{ side: "after", pane: "after:page1", rect: { x: 980, y: 300, w: 180, h: 60 } }] },
  ],
};
const card = (loc: string, before: string | null, after: string, full: [string | null, string]) => ({ place: "", verb: before ? null : "Added", before, after, text: null, loc, full: { before: full[0], after: full[1] } });
const model = {
  task: 7, folder: "work", files: [], actors: [{ id: "main", name: "Claude", chip: "C", color: "#123456" }],
  stops: [{ id: "chg-k1", label: "report.docx", lane: "main", head: "Claude changed report.docx", change: { key: "k1", file: "report.docx", kind: "modified", note: "Changed report.docx.", rowNotes: [], moreNote: null, viewUrl: "/timeline/7/view/k1", secret: false, secretLine: null, failed: null, ask: null, newFile: null, treeBefore: null, treeAfter: null,
    cards: [card("paragraph 4", "This report outlines", "This report sets out", ["This report outlines the delivery approach", LONG]), card("paragraph 9", null, "A new closing paragraph", [null, "A new closing paragraph, whole"]), card("paragraph 12", null, "Words with no box", [null, "Words with no box at all"]), card("paragraph 20", "Bottom old", "Bottom new words near the foot of the page", ["Bottom old", "Bottom new words near the foot of the page"]), card("paragraph 21", null, "Right edge words", [null, "Right edge words"])] } }],
};

describe("change-first focus measured in Chrome", { skip: CHROME ? false : "no Chrome installed" }, () => {
  it("outlines, no fill, padding, box draw-in, hover callout on the hovered box, other boxes at 40% and no frost, the line on the box edges, words list, region mode, reduced motion, no console errors", async (t) => {
    const { renderReviewShell, REVIEW_CSP } = await import(join(ROOT, "src/timeline/rail/page.ts"));
    const assets = join(ROOT, "src/timeline/rail/assets");
    const imgs = join(new URL("..", import.meta.url).pathname, "test/fixtures/change-first");
    const shell = renderReviewShell(7);
    const server = createServer(async (rq, rs) => {
      const u = new URL(rq.url ?? "/", "http://x");
      const send = (type: string, body: string | Buffer, code = 200) => { rs.writeHead(code, { "content-type": type, "content-security-policy": REVIEW_CSP }); rs.end(body); };
      try {
        if (u.pathname === "/") return send("text/html", shell);
        if (u.pathname.startsWith("/timeline-assets/")) {
          const f = u.pathname.slice("/timeline-assets/".length);
          if (/^[\w-]+\.(js|css)$/.test(f) && existsSync(join(assets, f))) return send(f.endsWith(".js") ? "text/javascript" : "text/css", await readFile(join(assets, f)));
          return send("text/plain", "", 204);
        }
        if (u.pathname.includes("/pdfpage/")) return send("image/png", await readFile(join(imgs, u.pathname.includes(SHA_B) ? "page1-before.png" : "page1-after.png")));
        if (u.pathname.endsWith("/review/model")) return send("application/json", JSON.stringify(model));
        if (u.pathname.endsWith("/review/status")) return send("application/json", JSON.stringify({ stops: {}, passes: null }));
        if (u.pathname.includes("/view/")) return send("application/json", JSON.stringify(servedFor(view, model, u.pathname)));
        return send("application/json", "{}", 404);
      } catch { send("text/plain", "", 500); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => { server.close(); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/?t=tok`;
    const dir = await mkdtemp(join(tmpdir(), "cocheck-cfchrome-"));
    const shots = process.env.CFV_SHOTS ?? join(dir, "shots"); await mkdir(shots, { recursive: true });
    const chrome = spawn(CHROME!, chromeHeadlessArgs(join(dir, "profile")), { stdio: "ignore" });
    t.after(() => { chrome.kill(); });
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) { await new Promise((r) => setTimeout(r, 100)); try { port = Number((await readFile(join(dir, "profile", "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { /* not up yet */ } }
    assert.ok(port, "Chrome did not start");
    const tabs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const ws = new WebSocket(tabs.find((x) => x.type === "page")!.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0; const pend: Record<number, (v: any) => void> = {}; const problems: string[] = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && pend[m.id]) pend[m.id]!(m.result ?? m.error);
      if (m.method === "Runtime.exceptionThrown") problems.push("exception: " + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push("console.error: " + JSON.stringify(m.params.args).slice(0, 300));
    };
    t.after(() => ws.close());
    const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (x: string) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const shot = async (name: string) => { const r = await send("Page.captureScreenshot", { format: "png" }); await writeFile(join(shots, name), Buffer.from(r.data, "base64")); };
    await send("Runtime.enable"); await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI.slice(0,40)))" });
    await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    // the page follows prefers-color-scheme; the colours below are the light scheme's, whatever the machine is set to
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await send("Page.navigate", { url: base });
    let n = 0;
    for (let i = 0; i < 60 && !n; i++) { await wait(200); n = await ev(`document.querySelectorAll('.bx.cf').length`); }
    await wait(500);
    assert.equal(n, 5, "c1 on both sides, c2 and c5 on the after side, c4 on the before side");

    const R = `const R=(e)=>{const b=e.getBoundingClientRect();return {l:b.left,t:b.top,r:b.right,b:b.bottom,w:b.width,h:b.height}};`;
    const rest = await ev(`(()=>{${R}
      const bx=[...document.querySelectorAll('.bx.cf')].map(e=>{const cs=getComputedStyle(e),pw=e.parentNode.getBoundingClientRect();return {an:cs.animationName,ad:cs.animationDuration,at:cs.animationTimingFunction,op:cs.opacity,ch:e.dataset.change,side:e.dataset.side,ol:cs.outlineStyle,ow:cs.outlineWidth,oc:cs.outlineColor,bg:cs.backgroundColor,bi:cs.backgroundImage,sh:cs.boxShadow,r:R(e),pw:{l:pw.left,t:pw.top,w:pw.width},z:cs.zIndex}});
      const hl=[...document.querySelectorAll('.hl')].map(e=>({bg:getComputedStyle(e).backgroundColor,n:e.dataset.change}));
      return {bx,hl,leaders:document.querySelectorAll('svg.leaders path, .grp, .dot').length,cards:document.querySelectorAll('#notes .note').length,words:document.getElementById('cfwords')?'a words list in the page flow':window.CoCheckDetails.entries().filter(e=>e.kind==='unplaced').map(e=>e.text).join('|'),cm:document.querySelectorAll('.cm.hv').length}})()`);
    await shot("at-rest.png");
    // one box style both sides: 2px solid side colour, a 1.5px white keyline, a 7px halo of the side colour, no fill.
    // Guarded against: a box harder to see than today on any background. The line must hold 3:1 on white (today's After pink held 2.10)
    // and on a near-black slide, where the white keyline also sits between the line and the content.
    const rgb = (c: string): number[] => { const m = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)/.exec(c); assert.ok(m, `a colour: ${c}`); return [Number(m![1]), Number(m![2]), Number(m![3])]; };
    const lum = (c: number[]): number => { const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
    const ratio = (a: number[], b: number[]): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
    const WHITE = [255, 255, 255], NEAR_BLACK = [17, 17, 17];
    const boxChecks = (list: any[], scheme: string) => {
      for (const b of list) {
        assert.equal(b.ol, "solid"); assert.equal(b.ow, "2px", "solid 2px outline");
        assert.equal(b.bg, "rgba(0, 0, 0, 0)", "no fill"); assert.equal(b.bi, "none");
        const parts = String(b.sh).split(/,(?![^(]*\))/).map((x: string) => x.trim());
        assert.equal(parts.length, 2, `keyline and halo: ${b.sh}`);
        assert.match(parts[0]!, /^rgb\(255, 255, 255\) 0px 0px 0px 1\.5px$/, `a 1.5px white keyline first: ${parts[0]}`);
        assert.match(parts[1]!, / 0px 0px 0px 7px$/, `a 7px halo: ${parts[1]}`);
        const line = rgb(b.oc), key = rgb(parts[0]!);
        assert.ok(ratio(line, WHITE) >= 3, `${scheme} ${b.side} line ${b.oc} on white: ${ratio(line, WHITE).toFixed(2)}`);
        assert.ok(ratio(line, NEAR_BLACK) >= 3, `${scheme} ${b.side} line ${b.oc} on near-black: ${ratio(line, NEAR_BLACK).toFixed(2)}`);
        assert.ok(ratio(key, NEAR_BLACK) >= 3, `${scheme} ${b.side} keyline on near-black`);
      }
      const sides = new Set(list.map((b: any) => b.side)); assert.deepEqual([...sides].sort(), ["after", "before"]);
      const strip = (b: any) => ({ ol: b.ol, ow: b.ow, sh: String(b.sh).replace(/(?:rgba?|color)\([^)]*\)/g, "C") });
      assert.deepEqual(strip(list.find((b: any) => b.side === "before")), strip(list.find((b: any) => b.side === "after")), "one style on both sides, only the colour differs");
    };
    boxChecks(rest.bx, "light");
    // arriving at the step, every change box draws in once: opacity 0 to 1 and scale 1.03 to 1 over 180 ms, ease-out
    for (const b of rest.bx) { assert.equal(b.an, "cfdraw", `${b.ch} ${b.side} draws in`); assert.equal(b.ad, "0.18s"); assert.equal(b.at, "ease-out"); assert.equal(b.op, "1", "at full strength at rest"); }
    const bb = rest.bx.find((b: any) => b.ch === "c1" && b.side === "before"), ba = rest.bx.find((b: any) => b.ch === "c1" && b.side === "after");
    assert.notEqual(bb.oc, ba.oc, "Before blue and After pink");
    assert.match(bb.oc, /rgb\(47, 107, 216\)/); assert.match(ba.oc, /rgb\(204, 47, 118\)/); // the before and after tokens
    // padding: 0.7% of the page width at the sides of the unpadded rect, a quarter of that above and below (picture px scaled to the shown width)
    const k = bb.pw.w / 1224, pad = 0.007 * bb.pw.w;
    assert.ok(Math.abs(bb.r.w - (951.6 * k + 2 * pad)) < 1, `before width ${bb.r.w} vs ${951.6 * k + 2 * pad}`);
    assert.ok(Math.abs(bb.r.l - (bb.pw.l + 129.8 * k - pad)) < 1 && Math.abs(bb.r.t - (bb.pw.t + 211.1 * k - pad / 4)) < 1, "padded origin");
    assert.equal(rest.hl.length, 9, "word highlights of both sides"); assert.ok(rest.hl.every((h: any) => h.bg === "rgba(255, 200, 40, 0.38)"));
    assert.equal(rest.leaders, 0, "no leaders, dots or group outlines"); assert.equal(rest.cards, 0, "no side cards"); assert.equal(rest.cm, 0, "no comment at rest");
    assert.match(rest.words, /^unplaced after: not marked \| .*Words with no box at all/, "the unplaced change is a Details log line (fix/notes-panel), once");
    // fix/notes-panel: the Details control in the bar opens one panel over the page, inside the viewport, its count shown
    const det = await ev(`(()=>{${R} const b=document.getElementById('pbdetails'),c=document.getElementById('pbdcount');b.click();const p=document.getElementById('detpanel');
      return {count:c.hidden?null:c.textContent,open:!p.hidden&&getComputedStyle(p).display!=='none',r:R(p),txt:p.textContent,btn:R(b)}})()`);
    await wait(300); await shot("details-open.png");
    assert.equal(det.open, true); assert.ok(Number(det.count) >= 1, String(det.count));
    assert.ok(det.r.t >= 0 && det.r.b <= det.btn.t && det.r.l >= 0 && det.r.r <= 1600, JSON.stringify(det));
    assert.match(det.txt, /\[cocheck\]\s*unplaced after: not marked/);
    await ev(`document.getElementById('pbdetails').click()`); await wait(200);

    // hover the before box of c1
    const cx = bb.r.l + bb.r.w / 2, cy = bb.r.t + 8;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy }); await wait(500);
    const hov = await ev(`(()=>{${R}
      const st=R(document.getElementById('stage')),cms=[...document.querySelectorAll('.cm.hv')].map(e=>({side:e.dataset.side,txt:e.textContent,d:getComputedStyle(e).display,z:getComputedStyle(e).zIndex,r:R(e),pane:R(e.closest('.pane'))}));
      const fr=document.querySelectorAll('.cf-frost').length,filt=[...document.querySelectorAll('#stage, #stage *')].filter(e=>{const cs=getComputedStyle(e);return (cs.backdropFilter&&cs.backdropFilter!=='none')||(cs.filter&&cs.filter!=='none')}).map(e=>e.className);
      const ops=[...document.querySelectorAll('.bx.cf')].map(e=>({ch:e.dataset.change,side:e.dataset.side,op:getComputedStyle(e).opacity}));
      const cm=document.querySelector('.cm.hv'),host=document.querySelector('.bx.cf[data-change="c1"][data-side="before"]');
      const call=cm&&{w:R(cm).w,r:R(cm),box:R(host),rad:getComputedStyle(cm).borderTopLeftRadius,bg:getComputedStyle(cm).backgroundColor,bw:getComputedStyle(cm).borderTopWidth,sh:getComputedStyle(cm).boxShadow,sameParent:cm.parentNode===host.parentNode,
        del:[...cm.querySelectorAll('del')].map(e=>({t:e.textContent,bg:getComputedStyle(e).backgroundColor,td:getComputedStyle(e).textDecorationLine,rad:getComputedStyle(e).borderTopLeftRadius})),ins:[...cm.querySelectorAll('ins')].map(e=>({t:e.textContent,bg:getComputedStyle(e).backgroundColor,td:getComputedStyle(e).textDecorationLine}))};
      const bxs=[...document.querySelectorAll('.bx.cf.hv')].map(e=>({side:e.dataset.side,ch:e.dataset.change,z:getComputedStyle(e).zIndex,r:R(e)}));
      const ln=document.querySelector('svg.cf-line path.cf-ln');const stops=[...document.querySelectorAll('svg.cf-line stop')].map(s=>getComputedStyle(s).stopColor);
      return {cms,fr,filt,ops,call,bxs,d:ln&&ln.getAttribute('d'),w:ln&&getComputedStyle(ln).strokeWidth,stops,st,lz:getComputedStyle(document.querySelector('svg.cf-line')).zIndex,other:[...document.querySelectorAll('.bx.cf:not(.hv)')].map(e=>e.dataset.change)}})()`);
    await shot("hover-c1.png");
    assert.deepEqual(hov.cms.map((c: any) => c.side), ["before"], "one callout, on the hovered box's side");
    for (const c of hov.cms) { assert.equal(c.d, "block"); assert.ok(c.txt.includes("including this very last clause"), "the added words in full"); assert.ok(c.r.l >= c.pane.l - 1 && c.r.r <= c.pane.r + 1, "never wider than the pane"); assert.equal(c.z, "10"); }
    // the callout: attached to the hovered box (just above or below it), at most 280 px wide, surface, 10 px radius, a hairline and a soft shadow
    const cl = hov.call;
    assert.ok(cl.sameParent, "the callout sits in the page of its box, so it scrolls with it");
    assert.ok(cl.w <= 280.5, `max 280 px wide: ${cl.w}`);
    assert.ok(Math.abs(cl.r.t - (cl.box.b + 8)) <= 2 || Math.abs(cl.r.b - (cl.box.t - 8)) <= 2, `attached below or above its box: ${JSON.stringify(cl.r)} vs ${JSON.stringify(cl.box)}`);
    assert.equal(cl.rad, "10px"); assert.equal(cl.bg, "rgb(255, 255, 255)"); assert.equal(cl.bw, "1px"); assert.notEqual(cl.sh, "none");
    // the changed words marked inside the sentence: "outlines" struck in a 28% before-blue tint, "sets out" in a 28% after-pink tint, 2 px radius
    assert.deepEqual(cl.del.map((d: any) => d.t), ["outlines", "approach"]); assert.ok(cl.ins[0].t === "sets out" && cl.ins.length === 2, JSON.stringify(cl.ins.map((i: any) => i.t)));
    for (const d of cl.del) { assert.equal(d.td, "line-through"); assert.equal(d.rad, "2px"); assert.match(d.bg, /^(rgba\(47, 107, 216, 0\.28\)|color\(srgb 0\.18\d* 0\.41\d* 0\.84\d* \/ 0\.28\))$/, d.bg); }
    for (const i of cl.ins) { assert.equal(i.td, "none"); assert.match(i.bg, /^(rgba\(204, 47, 118, 0\.28\)|color\(srgb 0\.8 0\.18\d* 0\.46\d* \/ 0\.28\))$/, i.bg); }
    // no frost: nothing blurs, filters or covers the picture
    assert.equal(hov.fr, 0, "no frost layer"); assert.deepEqual(hov.filt, [], "no filter or backdrop filter anywhere on the stage");
    assert.deepEqual(hov.bxs.map((b: any) => b.side).sort(), ["after", "before"]); assert.ok(hov.bxs.every((b: any) => b.z === "9"));
    assert.deepEqual(hov.other, ["c4", "c2", "c5"], "other changes stay unfocused");
    // the hovered box and its partner on the other side at full strength, every other change box at 40%
    for (const o of hov.ops) assert.equal(o.op, o.ch === "c1" ? "1" : "0.4", `${o.ch} ${o.side} opacity ${o.op}`);
    // the line: first point on the before box's right edge, last on the after box's left edge, within 1 px
    const pts = [...hov.d.matchAll(/[ML]([-\d.]+),([-\d.]+)/g)].map((m: RegExpMatchArray) => [Number(m[1]), Number(m[2])]);
    const fb = hov.bxs.find((b: any) => b.side === "before").r, fa = hov.bxs.find((b: any) => b.side === "after").r;
    assert.ok(Math.abs(pts[0]![0]! + hov.st.l - fb.r) <= 1 && Math.abs(pts[0]![1]! + hov.st.t - (fb.t + fb.h / 2)) <= 1, `line start ${pts[0]} vs before edge ${fb.r},${fb.t + fb.h / 2}`);
    const last = pts[pts.length - 1]!;
    assert.ok(Math.abs(last[0]! + hov.st.l - fa.l) <= 1 && Math.abs(last[1]! + hov.st.t - (fa.t + fa.h / 2)) <= 1, `line end ${last} vs after edge ${fa.l},${fa.t + fa.h / 2}`);
    assert.equal(hov.w, "3px"); assert.deepEqual(hov.stops, ["rgb(47, 107, 216)", "rgb(204, 47, 118)"], "the line runs from the before token to the after token");
    assert.deepEqual(await ev("window.__csp"), [], "no securitypolicyviolation event (the CSP is the real REVIEW_CSP)");
    // pixels: with no frost, a clip inside the focused box and a clip of the page away from every box and the callout are both identical hovered and at rest
    const clipOf = async (x: number, y: number, w: number, h: number) => (await send("Page.captureScreenshot", { format: "png", clip: { x, y, width: w, height: h, scale: 1 } })).data as string;
    const inside = { x: bb.r.l + 12, y: bb.r.t + 12, w: Math.max(8, bb.r.w - 24), h: Math.max(8, bb.r.h - 24) };
    const outside = { x: bb.r.l, y: bb.r.t + bb.r.h + 300, w: 120, h: 60 };
    const hovIn = await clipOf(inside.x, inside.y, inside.w, inside.h), hovOut = await clipOf(outside.x, outside.y, outside.w, outside.h);
    const cover = await ev(`(()=>{const r=document.querySelector('.bx.cf[data-change="c1"][data-side="before"]').closest('.pane').getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom}})()`);
    assert.ok(outside.y + outside.h < cover.b, "the outside sample lies on the pane");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }); await wait(500);
    const gone = await ev(`({cm:document.querySelectorAll('.cm').length,on:document.getElementById('stage').classList.contains('cfon'),line:document.querySelectorAll('svg.cf-line path').length,op:[...new Set([...document.querySelectorAll('.bx.cf')].map(e=>getComputedStyle(e).opacity))]})`);
    assert.deepEqual(gone, { cm: 0, on: false, line: 0, op: ["1"] }, "leaving puts everything away and restores every box");
    await shot("after-leave.png");
    assert.equal(await clipOf(inside.x, inside.y, inside.w, inside.h), hovIn, "inside the hole the page is as sharp as at rest");
    assert.equal(await clipOf(outside.x, outside.y, outside.w, outside.h), hovOut, "away from the boxes the page is untouched while a box is focused (no frost)");

    // a one-sided change: comment on its side only, no line
    const c2 = rest.bx.find((b: any) => b.ch === "c2");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c2.r.l + c2.r.w / 2, y: c2.r.t + 8 }); await wait(500);
    const one = await ev(`({sides:[...document.querySelectorAll('.cm.hv')].map(e=>e.dataset.side),line:document.querySelectorAll('svg.cf-line path').length})`);
    await shot("hover-c2.png");
    assert.deepEqual(one, { sides: ["after"], line: 0 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }); await wait(300);

    // keyboard focus shows what the pointer shows
    await ev(`document.querySelector('.bx.cf[data-change="c1"][data-side="after"]').focus()`); await wait(400);
    assert.deepEqual(await ev(`[...document.querySelectorAll('.cm.hv')].map(e=>e.dataset.side)`), ["after"], "keyboard focus shows the callout on the focused box");
    await ev(`document.activeElement.blur()`); await wait(300);
    assert.equal(await ev(`document.querySelectorAll('.cm').length`), 0);

    // Point region mode: boxes and comments take no pointer, so a drag starts on the page under them (guarded case 5)
    await ev(`document.body.classList.add('regon')`);
    const under = await ev(`(()=>{const e=document.querySelector('.bx.cf[data-change="c1"][data-side="before"]'),b=e.getBoundingClientRect(),t=document.elementFromPoint(b.left+b.width/2,b.top+8);return {box:!!(t&&t.closest('.bx.cf')),tag:t&&t.tagName,pw:!!(t&&t.closest('.pagewrap'))}})()`);
    assert.deepEqual(under, { box: false, tag: "IMG", pw: true }, "under region mode the point lands on the page image");
    await ev(`document.body.classList.remove('regon')`);

    // comments stay fully inside the visible part of their pane / scroll column: a box at the page foot (before) and one at the right edge (after)
    const contained = async (ch: string, side: string) => {
      await ev(`(()=>{const b=document.querySelector('.bx.cf[data-change="${ch}"][data-side="${side}"]');b.scrollIntoView({block:'end'})})()`); await wait(300);
      const r = await ev(`(()=>{${R}const b=document.querySelector('.bx.cf[data-change="${ch}"][data-side="${side}"]');const q=R(b);return {x:q.l+q.w/2,y:q.t+Math.min(8,q.h/2)}})()`);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }); await wait(300);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y }); await wait(500);
      const m = await ev(`(()=>{${R}return [...document.querySelectorAll('.cm.hv')].map(c=>{let v=R(c.closest('.pane'));for(let n=c.parentNode;n&&!n.classList.contains('pane');n=n.parentNode){const o=getComputedStyle(n);if(o.overflowX!=='visible'||o.overflowY!=='visible'){const a=R(n);v={l:Math.max(v.l,a.l),t:Math.max(v.t,a.t),r:Math.min(v.r,a.r),b:Math.min(v.b,a.b)}}}return {side:c.dataset.side,r:R(c),v}})})()`);
      await shot(`hover-${ch}.png`);
      assert.ok(m.length >= 1, "a comment is shown");
      for (const c of m) assert.ok(c.r.l >= c.v.l - 1 && c.r.r <= c.v.r + 1 && c.r.t >= c.v.t - 1 && c.r.b <= c.v.b + 1, `${ch} ${c.side} comment ${JSON.stringify(c.r)} inside its visible column ${JSON.stringify(c.v)}`);
    };
    await contained("c4", "before"); await contained("c5", "after");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }); await wait(300);
    await ev(`document.querySelectorAll('.pscroll').forEach(e=>{e.scrollTop=0})`); await wait(200);

    // Clean view hides everything
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy }); await wait(400);
    await ev(`document.getElementById('cleanbtn').click()`); await wait(900);
    const clean = await ev(`({bx:[...document.querySelectorAll('.bx.cf')].every(e=>getComputedStyle(e).display==='none'),cm:document.querySelectorAll('.cm').length,hl:[...document.querySelectorAll('.hl')].every(e=>getComputedStyle(e).display==='none')})`);
    await shot("clean.png");
    assert.deepEqual(clean, { bx: true, cm: 0, hl: true });
    assert.deepEqual(await ev("window.__csp"), [], "no CSP violation anywhere");
    // the same box checks under the dark scheme (last, so the scheme switch cannot touch the pixel comparisons above)
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }); await wait(300);
    boxChecks(await ev(`[...document.querySelectorAll('.bx.cf')].map(e=>{const cs=getComputedStyle(e);return {side:e.dataset.side,ol:cs.outlineStyle,ow:cs.outlineWidth,oc:cs.outlineColor,bg:cs.backgroundColor,bi:cs.backgroundImage,sh:cs.boxShadow}})`), "dark");
    // stepping to a change pulses its boxes
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }); await wait(200);
    await ev(`document.getElementById('cleanbtn').click()`); await wait(900);
    await ev(`window.CoCheckFocus.focusChange('c2')`);
    assert.deepEqual(await ev(`[...document.querySelectorAll('.bx.cf.cf-pulse')].map(e=>e.dataset.change+':'+getComputedStyle(e).animationName)`), ["c2:cfpulse"], "the stepped-to box pulses");
    await ev(`window.CoCheckFocus.clearFocus()`);
    // under prefers-reduced-motion the boxes do not draw in (no class, no animation) and stepping does not pulse
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
    await send("Page.navigate", { url: base + "&rm=1" });
    let m = 0;
    for (let i = 0; i < 60 && !m; i++) { await wait(200); m = await ev(`document.querySelectorAll('.bx.cf').length`); }
    assert.equal(m, 5);
    const rm = await ev(`(()=>{window.CoCheckFocus.focusChange('c2');return [...document.querySelectorAll('.bx.cf')].map(e=>({cls:e.className,an:getComputedStyle(e).animationName,n:e.getAnimations().length,op:getComputedStyle(e).opacity}))})()`);
    for (const b of rm) { assert.doesNotMatch(b.cls, /cf-in|cf-pulse/, b.cls); assert.equal(b.an, "none"); assert.equal(b.n, 0, "no running animation"); }
    assert.deepEqual(problems, [], "no console errors or exceptions");
  });
});
