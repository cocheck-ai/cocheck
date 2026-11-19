import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { servedFor } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// the Point tool replaces drag-while-a-note-is-open. Off, no drag is captured; on (Box or Freehand), a drag posts a spot to the fail box of the step on show, else the task note (opened if closed).
// A drag on a picture or the text diff points at a spot. The page posts the
// region shape (serves it; here the server's answers are stubbed), shows a chip, and hands the chip ids to the verdict and the send-back.
// Guarded against: a drag on the before pane never posts side "after", and a chip never survives into a different step's fail box.
// The page code runs as is in a vm with a DOM stub that keeps attributes, parents, listeners and hidden state.

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, any> = { setProperty() {}, removeProperty() {} }; dataset = {}; _text = ""; value = ""; focused = false; nodeType = 1; rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  removeChild(c: N) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(sel: string): N | null { for (let n: N | null = this; n; n = n.parentNode) if (sel === ".vw[hidden]" && n.hidden && n.className.split(/\s+/).includes("vw")) return n; return null; }
  getBoundingClientRect() { return this.rect; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

const SHA = "a".repeat(64);
const textPane = (side: string) => ({ id: `${side}:t`, label: `${side} text`, text: { lines: [1, 2, 3, 4].map((n) => ({ n, text: `${side} line ${n}`, marks: [] })) } });
const picPane = (side: string, page: number | null) => ({ id: `${side}:p`, label: `${side} picture`, picture: { sha: SHA, width: 800, height: 1000, ...(page ? { page } : {}) } });
const view = (change: string, kind: string, before: unknown[], after: unknown[]) => ({ change, file: `${change}.bin`, engine: "", kind, before, after, boxes: [], caveats: [] });
const VIEWS: Record<string, unknown> = {
  k1: view("k1", "picture", [picPane("before", 2)], [picPane("after", 2)]),
  k3: view("k3", "text", [textPane("before")], [textPane("after")]),
  k4: view("k4", "picture", [picPane("before", null)], [picPane("after", null)]),
};
const stopOf = (key: string) => ({ id: `chg-${key}`, label: `${key}.bin`, lane: "main", head: `Claude changed ${key}.bin`, change: { key, file: `${key}.bin`, kind: "modified", note: `Changed ${key}.bin.`, rowNotes: [], moreNote: null, viewUrl: `/timeline/7/view/${key}`, secret: false, secretLine: null, failed: null, ask: null, newFile: null, treeBefore: null, treeAfter: null } });

interface Call { method: string; url: string; body: any }
async function boot(keys: string[], opts: { picture?: boolean; late?: boolean; tool?: boolean } = {}) {
  const files = keys.map((k) => ({ file: `${k}.bin`, name: `${k}.bin`, versions: [{ change: k, stop: `chg-${k}`, sha: "", lane: "main", chip: "C", at: null, label: "Changed", kind: "modified", kept: true }] }));
  const model = { task: 7, folder: "work", actors: [{ id: "main", name: "Claude", chip: "C", color: "#123456" }], stops: keys.map(stopOf), files };
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  for (const id of ["ncomp", "pcomp", "sbout", "toast"]) byId(id).hidden = true; // the page ships these hidden
  byId("stage").append(byId("pb"), byId("pa")); byId("pb").append(byId("tb"), byId("trb"), byId("vb")); byId("pa").append(byId("ta"), byId("tra"), byId("va"));
  const calls: Call[] = []; const listeners: Record<string, Array<(e: unknown) => void>> = {};
  let nextId = 0; const held: Array<() => void> = [];
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const answer = (j: unknown, status = 200) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(j)) });
  const fetchStub = async (u: string, o?: { method?: string; body?: string }) => {
    const b = o?.body ? JSON.parse(o.body) : null;
    calls.push({ method: o?.method ?? "GET", url: u, body: b });
    if (u.includes("/review/region")) {
      const id = ++nextId, picture = b.kind === "picture" && opts.picture !== false;
      const where = b.kind === "picture" ? `page ${b.page ?? 1} of the ${b.side} version` : b.kind === "cells" ? `${b.sheet}!${b.range}` : `lines ${b.from}-${b.to}`;
      const r = answer({ id, where, picture });
      if (opts.late) return new Promise((res) => held.push(() => res(r as never)));
      return r;
    }
    const json = u.includes("/review/status") ? { stops: {}, passes: null } : u.includes("/review/model") ? model : u.includes("/review/verdict") ? { state: { status: b.status, note: b.note, history: [] }, submit: null } : u.includes("/review/sendback") ? { id: 4, prompt: "p", stops: [], nonce: "ab12cd", marker: "m" } : u.includes("/view/") ? servedFor(VIEWS[u.split("/view/")[1]!.split("?")[0]!], model, u) : {};
    return answer(json);
  };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, setInterval, clearInterval, setTimeout, clearTimeout, fetch: fetchStub,
    addEventListener: (k: string, f: (e: unknown) => void) => { (listeners[k] ??= []).push(f); } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 25));
  await settle();
  byId("vsteps").click(); await settle(); // the page opens on Deliverables when the model lists files
  const find = (root: N, pred: (n: N) => boolean) => root.descendants().filter(pred);
  const pane = (side: "before" | "after") => byId(side === "before" ? "vb" : "va");
  const wrap = (side: "before" | "after", box = { left: 100, top: 50, width: 400, height: 500 }) => {
    const w = find(pane(side), (n) => n.className.split(/\s+/).includes("pagewrap")).find((n) => !n.closest(".vw[hidden]"))!;
    w.rect = { ...box, right: box.left + box.width, bottom: box.top + box.height };
    return w;
  };
  const lineAt = (side: "before" | "after", n: number) => find(pane(side), (x) => x.attrs["data-line"] === String(n))[0]!;
  const down = (target: N, x: number, y: number) => byId("stage").listeners.mousedown?.forEach((f) => f({ target, clientX: x, clientY: y, button: 0, preventDefault() {} }));
  const up = async (target: N, x: number, y: number) => { (listeners.mouseup ?? []).forEach((f) => f({ target, clientX: x, clientY: y, button: 0 })); await settle(); };
  const dragOn = async (a: N, ax: number, ay: number, b: N = a, bx = ax, by = ay) => { down(a, ax, ay); (listeners.mousemove ?? []).forEach((f) => f({ target: b, clientX: bx, clientY: by })); await up(b, bx, by); };
  const regionPosts = () => calls.filter((c) => c.url.includes("/review/region")).map((c) => c.body);
  const chips = (id: string) => byId(id).descendants().filter((n) => n.className.split(/\s+/).includes("rchip"));
  const openFail = async () => { byId("pbfail").click(); await settle(); };
  const openNote = async () => { byId("pbnote").click(); await settle(); };
  const free = () => byId("regfree").click();
  const box = () => byId("regbox").click();
  const key = (k: string) => (listeners.keydown ?? []).forEach((f) => f({ key: k, target: mkNode(), preventDefault() {} }));
  const next = async () => { byId("pbnext").click(); await settle(); };
  return { byId, calls, wrap, lineAt, dragOn, down, up, regionPosts, chips, openFail, openNote, next, body, free, box, key, listeners, settle, held, find, pane };
}

const round = (r: number[]) => r.map((v) => Math.round(v * 1000) / 1000);

describe("the page", () => {
  it("the hint is a tooltip on the Box/Freehand control, once in the fail box and once in the task note, never a caption", () => {
    const html = renderReviewShell(7);
    const hint = "Mark a spot with a box or freehand.";
    assert.equal(html.split(hint).length - 1, 2);
    assert.equal(html.split(`role="tooltip" id="rtip">${hint}`).length - 1, 1);
    assert.doesNotMatch(html, /class="rhint"/);
  });

  it("a picture drag with the fail box open posts the picture shape and adds a thumbnail chip", async () => {
    const p = await boot(["k1"]);
    await p.openFail();
    const w = p.wrap("before");
    await p.dragOn(w, 200, 100, w, 300, 300);
    assert.deepEqual(p.regionPosts().map((b) => ({ ...b, rect: round(b.rect) })), [{ change: "k1", side: "before", kind: "picture", page: 2, rect: [0.25, 0.1, 0.25, 0.4] }]);
    const chip = p.chips("vchips");
    assert.equal(chip.length, 1);
    const img = chip[0]!.descendants().find((n) => n.tag === "img")!;
    assert.match(img.attrs.src!, /\/timeline\/7\/region\/1\?t=tok$/);
  });

  it("a picture with no page posts page null, and an answer of picture false shows the range text", async () => {
    const p = await boot(["k4"], { picture: false });
    await p.openFail();
    const w = p.wrap("after");
    await p.dragOn(w, 150, 100, w, 400, 400);
    assert.equal(p.regionPosts()[0].page, null);
    assert.equal(p.regionPosts()[0].side, "after");
    assert.equal(p.chips("vchips")[0]!.descendants().some((n) => n.tag === "img"), false);
    assert.match(p.chips("vchips")[0]!.textContent, /page 1 of the after version/);
  });

  it("the same spot at two zoom widths posts the same rect within 0.5%", async () => {
    const small = await boot(["k1"]); await small.openFail();
    const a = small.wrap("after", { left: 100, top: 50, width: 400, height: 500 });
    await small.dragOn(a, 100 + 400 * 0.3, 50 + 500 * 0.2, a, 100 + 400 * 0.7, 50 + 500 * 0.6);
    const big = await boot(["k1"]); await big.openFail();
    const b = big.wrap("after", { left: 30, top: 10, width: 900, height: 1125 });
    await big.dragOn(b, 30 + 900 * 0.3, 10 + 1125 * 0.2, b, 30 + 900 * 0.7, 10 + 1125 * 0.6);
    const r1 = small.regionPosts()[0].rect as number[], r2 = big.regionPosts()[0].rect as number[];
    r1.forEach((v, i) => assert.ok(Math.abs(v - r2[i]!) <= 0.005, `component ${i}: ${v} vs ${r2[i]}`));
  });

  it("with neither the composer nor the task note open, a drag posts nothing and opens nothing (no Point toggle)", async () => {
    const p = await boot(["k1"]);
    const w = p.wrap("before");
    await p.dragOn(w, 200, 100, w, 300, 300);
    assert.equal(p.regionPosts().length, 0);
    assert.equal(p.byId("ncomp").hidden, true);
  });

  it("a drag that goes nowhere (a click) posts nothing", async () => {
    const p = await boot(["k1"]); await p.openFail();
    const w = p.wrap("before");
    await p.dragOn(w, 200, 100, w, 201, 101);
    assert.deepEqual(p.regionPosts(), []);
  });

  it("text drags snap to data-line numbers", async () => {
    const p = await boot(["k3"]); await p.openFail();
    await p.dragOn(p.lineAt("before", 4), 10, 10, p.lineAt("before", 2), 10, 60);
    assert.deepEqual(p.regionPosts(), [{ change: "k3", side: "before", kind: "lines", from: 2, to: 4 }]);
    assert.match(p.chips("vchips")[0]!.textContent, /lines 2-4/);
  });

  it("a drag on the before pane never posts side after, for every pane kind", async () => {
    // the grid's cell drags went with the grid; pictures and text diffs keep theirs
    for (const [key, target] of [["k1", "pic"], ["k3", "line"]] as const) {
      const p = await boot([key]); await p.openFail();
      if (target === "pic") { const w = p.wrap("before"); await p.dragOn(w, 200, 100, w, 300, 300); }
      else await p.dragOn(p.lineAt("before", 1), 1, 1, p.lineAt("before", 3), 1, 40);
      assert.deepEqual(p.regionPosts().map((b) => b.side), ["before"], key);
      // a line drag that starts on the before pane and ends on the after pane points at nothing
      if (target === "line") await p.dragOn(p.lineAt("before", 1), 1, 1, p.lineAt("after", 3), 1, 40);
      assert.equal(p.regionPosts().length, 1, `${key}: a cross-pane drag posts nothing`);
    }
  });

  it("Save as failed carries the chip ids; removing a chip drops its id", async () => {
    const p = await boot(["k1"]); await p.openFail();
    const w = p.wrap("before");
    await p.dragOn(w, 200, 100, w, 300, 300);
    await p.dragOn(w, 120, 80, w, 220, 280);
    assert.equal(p.chips("vchips").length, 2);
    p.chips("vchips")[0]!.descendants().find((n) => n.tag === "button")!.click(); await p.settle();
    assert.equal(p.chips("vchips").length, 1);
    p.byId("vnote").value = "Wrong spot."; p.byId("vfailgo").click(); await p.settle();
    const v = p.calls.find((c) => c.url.includes("/review/verdict"))!;
    assert.deepEqual(v.body, { stop: "chg-k1", status: "failed", note: "Wrong spot.", regions: [2] });
    assert.equal(p.chips("vchips").length, 0, "saved chips leave the box");
  });

  it("a fail box with no spot posts no regions key, and a cancelled box carries none into the next one", async () => {
    const p = await boot(["k1"]); await p.openFail();
    const w = p.wrap("before");
    await p.dragOn(w, 200, 100, w, 300, 300);
    p.byId("vfailno").click(); await p.settle();
    assert.equal(p.chips("vchips").length, 0);
    await p.openFail();
    assert.equal(p.chips("vchips").length, 0);
    p.byId("vnote").value = "Plain."; p.byId("vfailgo").click(); await p.settle();
    assert.equal("regions" in p.calls.find((c) => c.url.includes("/review/verdict"))!.body, false);
  });

  it("at most four chips; the fifth drag posts nothing", async () => {
    const p = await boot(["k1"]); await p.openFail();
    const w = p.wrap("before");
    for (let i = 0; i < 5; i++) await p.dragOn(w, 120 + i, 80, w, 300, 300);
    assert.equal(p.regionPosts().length, 4);
    assert.equal(p.chips("vchips").length, 4);
  });

  it("a chip never survives into a different step's fail box", async () => {
    const p = await boot(["k1", "k4"]); await p.openFail();
    const w = p.wrap("before");
    await p.dragOn(w, 200, 100, w, 300, 300);
    assert.equal(p.chips("vchips").length, 1);
    await p.next();
    assert.equal(p.chips("vchips").length, 0, "the box closed with the step");
    await p.openFail();
    assert.equal(p.chips("vchips").length, 0);
    p.byId("vnote").value = "Other step."; p.byId("vfailgo").click(); await p.settle();
    const v = p.calls.filter((c) => c.url.includes("/review/verdict")).at(-1)!;
    assert.equal(v.body.stop, "chg-k4");
    assert.equal("regions" in v.body, false);
  });

  it("a drag answered after the step changed is dropped, not added to the next box", async () => {
    const p = await boot(["k1", "k4"], { late: true }); await p.openFail();
    const w = p.wrap("before");
    await p.dragOn(w, 200, 100, w, 300, 300);
    await p.next(); await p.openFail();
    p.held.forEach((f) => f()); await p.settle();
    assert.equal(p.chips("vchips").length, 0);
  });

  it("a view switch (Deliverables, then Timeline) to another step leaves no chip in that step's fail box, and a spot drawn in Deliverables goes into the open fail box", async () => {
    const p = await boot(["k1", "k4"]); await p.openFail();
    const w = p.wrap("before");
    await p.dragOn(w, 200, 100, w, 300, 300);
    assert.equal(p.chips("vchips").length, 1);
    p.byId("vfiles").click(); await p.settle();
    assert.equal(p.byId("head").hidden, true, "the Deliverables view is showing");
    const w2 = p.wrap("before");
    await p.dragOn(w2, 10, 10, w2, 200, 200);
    // the fail box now shows in Deliverables too (it sits beside the heading, not in it), so a spot drawn there goes into it
    assert.equal(p.regionPosts().length, 2, "in Deliverables the fail box is in sight, so the spot goes to it");
    assert.equal(p.chips("nchips").length, 0);
    assert.equal(p.chips("vchips").length, 2);
    p.find(p.byId("fileslist"), (n) => n.tag === "button" && /k4\.bin/.test(n.textContent)).at(-1)!.click(); await p.settle();
    p.byId("vsteps").click(); await p.settle();
    assert.equal(p.chips("vchips").length, 0);
    await p.openFail();
    assert.equal(p.chips("vchips").length, 0);
    p.byId("vnote").value = "Back."; p.byId("vfailgo").click(); await p.settle();
    const v = p.calls.filter((c) => c.url.includes("/review/verdict")).at(-1)!;
    assert.equal(v.body.stop, "chg-k4");
    assert.equal("regions" in v.body, false);
  });

  it("the sticky note takes drags too, and its spot rides on the note", async () => {
    const p = await boot(["k1"]); await p.openNote();
    const w = p.wrap("after");
    await p.dragOn(w, 200, 100, w, 300, 300);
    assert.equal(p.regionPosts()[0].side, "after");
    assert.equal(p.chips("nchips").length, 1);
    assert.equal(p.chips("vchips").length, 0);
    p.byId("nnote").value = "look here"; p.byId("ngo").click(); await p.settle(); // the spot rides on the sticky note, which Send back then carries
    assert.deepEqual(p.calls.find((c) => c.url.includes("/review/notes"))!.body, { text: "look here", regionId: 1, stop: "chg-k1" });
    assert.equal(p.chips("nchips").length, 0);
    p.byId("sendback").click(); await p.settle();
    assert.deepEqual(p.calls.find((c) => c.url.includes("/review/sendback"))!.body, {});
  });

  it("a send-back with no spots carries no regions key", async () => {
    const p = await boot(["k1"]); await p.openNote();
    p.byId("sendback").click(); await p.settle();
    assert.equal("regions" in p.calls.find((c) => c.url.includes("/review/sendback"))!.body, false);
  });
});

describe("the Point tool", () => {
  const free = async (p: Awaited<ReturnType<typeof boot>>, target: N, path: Array<[number, number]>) => {
    p.free();
    p.down(target, path[0]![0], path[0]![1]);
    for (const [x, y] of path.slice(1, -1)) (p.listeners.mousemove ?? []).forEach((f) => f({ target, clientX: x, clientY: y }));
    const l = path.at(-1)!; await p.up(target, l[0], l[1]);
  };
  const ring: Array<[number, number]> = [[200, 100], [300, 100], [350, 200], [300, 300], [200, 300], [150, 200], [200, 100]];
  const lineRects = (p: Awaited<ReturnType<typeof boot>>, side: "before" | "after") => { for (const n of [1, 2, 3, 4]) p.lineAt(side, n).rect = { left: 100, top: 100 + n * 20, width: 300, height: 20, right: 400, bottom: 120 + n * 20 }; };

  it("no Point button or #regtool; Box and Freehand sit once in the composer and once in the task note", () => {
    const html = renderReviewShell(7);
    for (const id of ["regtool", "regpoint", "vfailbox"]) assert.equal(html.split(`id="${id}"`).length - 1, 0, id);
    for (const id of ["regbox", "regfree", "nregbox", "nregfree"]) assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
    const comp = html.slice(html.indexOf('id="pcomp"'), html.indexOf('id="pbact"'));
    assert.match(comp, />Box</); assert.match(comp, />Freehand</); assert.match(comp, />Save</); assert.match(comp, />Cancel</);
    assert.doesNotMatch(comp.toLowerCase(), /submit|commit|soft|verified/);
  });

  it("with the composer and the note closed (the tool is off), no drag, click or selection posts a region or is swallowed, on every pane kind and both sides", async () => {
    for (const [key, kind] of [["k1", "pic"], ["k3", "line"]] as const) {
      for (const side of ["before", "after"] as const) {
        const p = await boot([key]);
        let prevented = 0;
        const go = async (t: N, x: number, y: number, t2: N = t, x2 = x, y2 = y) => { (p.byId("stage").listeners.mousedown ?? []).forEach((f) => f({ target: t, clientX: x, clientY: y, button: 0, preventDefault() { prevented++; } })); (p.listeners.mousemove ?? []).forEach((f) => f({ target: t2, clientX: x2, clientY: y2 })); await p.up(t2, x2, y2); };
        if (kind === "pic") { const w = p.wrap(side); await go(w, 200, 100, w, 300, 300); await go(w, 200, 100); }
        else await go(p.lineAt(side, 1), 1, 1, p.lineAt(side, 3), 1, 40);
        assert.deepEqual(p.regionPosts(), [], `${key} ${side}`);
        assert.equal(prevented, 0, `${key} ${side}: the drag is left to the browser`);
      }
    }
  });

  it("drawing is on only while the composer is open: Escape closes it and stops drawing; F brings it back; the tool stays on across posts", async () => {
    const p = await boot(["k1"]); await p.openFail();
    const w = p.wrap("before");
    await p.dragOn(w, 200, 100, w, 300, 300); await p.dragOn(w, 120, 80, w, 220, 280);
    assert.equal(p.regionPosts().length, 2, "still on after a post");
    p.key("Escape"); await p.settle();
    await p.dragOn(w, 200, 100, w, 300, 300);
    assert.equal(p.regionPosts().length, 2, "off after Escape");
    await p.openFail(); await p.dragOn(w, 200, 100, w, 300, 300);
    assert.equal(p.regionPosts().length, 3);
  });

  it("the drawn shape shows while drawing, for Box and for Freehand, and is gone after release", async () => {
    for (const mode of ["box", "free"] as const) {
      const p = await boot(["k1"]); await p.openFail();
      const w = p.wrap("before");
      if (mode === "free") p.free();
      p.down(w, 200, 100); (p.listeners.mousemove ?? []).forEach((f) => f({ target: w, clientX: 300, clientY: 300 }));
      assert.equal(p.body.children.length, 1, mode);
      assert.match(p.body.children[0]!.className + p.body.children[0]!.attrs.class, mode === "box" ? /regsel/ : /regsvg/);
      await p.up(w, 300, 300);
      assert.equal(p.body.children.length, 0, mode);
    }
  });

  it("Freehand on a picture posts the lasso shape as fractions, with the bounding box as rect; Box posts no shape key", async () => {
    const p = await boot(["k1"]); await p.openFail();
    const w = p.wrap("after");
    p.free(); p.down(w, 200, 100);
    (p.listeners.mousemove ?? []).forEach((f) => f({ target: w, clientX: 300, clientY: 100 }));
    await p.up(w, 300, 300);
    const post = p.regionPosts()[0];
    assert.equal(post.side, "after"); assert.equal(post.kind, "picture"); assert.equal(post.shape.type, "lasso");
    assert.deepEqual(post.shape.points.map((q: number[]) => round(q)), [[0.25, 0.1], [0.5, 0.1], [0.5, 0.5]]);
    assert.deepEqual(round(post.rect), [0.25, 0.1, 0.25, 0.4]);
    p.box(); await p.dragOn(w, 200, 100, w, 300, 300);
    assert.equal("shape" in p.regionPosts()[1], false);
  });

  it("a freehand path under 3 points, or under 8 by 8 source pixels, posts nothing", async () => {
    const p = await boot(["k1"]); await p.openFail();
    const w = p.wrap("before"); // 400 screen px show 800 source px: 1 screen px is 2 source px
    await free(p, w, [[200, 100], [300, 300]]);
    assert.equal(p.regionPosts().length, 0, "two points");
    await free(p, w, [[200, 100], [203, 100], [203, 103], [200, 103]]);
    assert.equal(p.regionPosts().length, 0, "6 by 6 source pixels");
    await free(p, w, [[200, 100], [205, 100], [205, 105], [200, 105]]);
    assert.equal(p.regionPosts().length, 1, "10 by 10 source pixels posts");
  });

  it("a long freehand path is thinned to at most 400 points, ends kept", async () => {
    const p = await boot(["k1"]); await p.openFail();
    const w = p.wrap("before");
    const path: Array<[number, number]> = [];
    for (let i = 0; i < 1500; i++) path.push([200 + (i % 300), 100 + Math.floor(i / 6)]);
    await free(p, w, path);
    const pts = p.regionPosts()[0].shape.points as number[][];
    assert.ok(pts.length <= 400 && pts.length >= 3, `${pts.length}`);
    assert.deepEqual(round(pts[0]!), round([(200 - 100) / 400, (100 - 50) / 500]));
  });

  it("Freehand on the text diff posts the lines it touches", async () => {
    const p = await boot(["k3"]); await p.openFail();
    lineRects(p, "before");
    await free(p, p.lineAt("before", 2), [[120, 145], [300, 145], [300, 185], [120, 185], [120, 145]]);
    assert.deepEqual(p.regionPosts(), [{ change: "k3", side: "before", kind: "lines", from: 2, to: 4 }]);
  });

  it("a Freehand drag on the before pane never posts side after, for every pane kind", async () => {
    for (const key of ["k1", "k3"]) {
      const p = await boot([key]); await p.openFail();
      if (key === "k1") await free(p, p.wrap("before"), ring);
      else { lineRects(p, "before"); await free(p, p.lineAt("before", 1), ring); }
      assert.deepEqual(p.regionPosts().map((b) => b.side), ["before"], key);
    }
    // a path that starts on the before pane and ends on the after pane points at nothing
    const q = await boot(["k3"]);
    lineRects(q, "before");
    q.free(); q.down(q.lineAt("before", 1), 120, 125); await q.up(q.lineAt("after", 3), 300, 185);
    assert.equal(q.regionPosts().length, 0);
  });

  it("a spot drawn on one step is not posted when the step changed before release", async () => {
    const p = await boot(["k1", "k4"]);
    const w = p.wrap("before");
    p.down(w, 200, 100); await p.next();
    await p.up(w, 300, 300);
    assert.equal(p.regionPosts().length, 0);
  });
});
