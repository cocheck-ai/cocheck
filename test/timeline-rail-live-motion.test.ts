import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Rail live motion (prototype, feat/rail-animations): when a live poll adds steps, the new lane segments draw one after another in time order (a cascade
// capped at 600 ms), each new stop fades in as its line arrives, and nothing else moves. review.js runs as is in a vm with a small DOM; the poll timer, the clock
// (performance.now) and prefers-reduced-motion belong to the test. Models are written by hand in the page's own shape: the page reads nothing else.

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty(this: Record<string, unknown>, k: string, v: string) { this[k] = v; } }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; scrollTop = 0; clientHeight = 0; offsetHeight = 0; offsetWidth = 0; ever = new Set<string>(); /* every class ever added: the page's cleanup timers run at once here */
  transforms: string[] = []; /* every transform the page set, in order: the page sets a FLIP offset and clears it in one go */
  constructor(tag: string) {
    this.tag = tag;
    let t = ""; const self = this;
    Object.defineProperty(this.style, "transform", { get: () => t, set: (v: string) => { t = v; if (v) self.transforms.push(v); }, enumerable: true });
  }
  getTotalLength() { return 100; }
  fire(k: string) { (this.listeners[k] ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  focus() {} scrollIntoView() {} scrollTo() {}
  get classList() {
    const s = this; const list = () => s.className.split(/\s+/).filter(Boolean);
    return { toggle: () => false, add: (c: string) => { s.ever.add(c); if (!list().includes(c)) s.className = [...list(), c].join(" "); }, remove: (c: string) => { s.className = list().filter((x) => x !== c).join(" "); }, contains: (c: string) => list().includes(c) };
  }
  closest(): N | null { return null; }
  /* a row's place as the browser would report it: its top plus any translateY it carries (the page's FLIP offsets), so the page can see what moved */
  getBoundingClientRect() { const top = (parseFloat(String(this.style.top)) || 0) + (Number(/translateY\((-?[\d.]+)px\)/.exec(String(this.style.transform ?? ""))?.[1]) || 0); return { top, left: 0, right: 0, height: 0, width: 0, bottom: top }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  /* the selectors the page asks for, and only those */
  matches(sel: string): boolean {
    if (sel === "svg" || sel === "svg.graph") return this.tag === "svg" && (sel === "svg" || this.classList.contains("graph"));
    if (sel === "path[data-seg]") return this.tag === "path" && this.attrs["data-seg"] !== undefined;
    if (sel === ".mark") return this.classList.contains("mark");
    return false;
  }
  querySelectorAll(sel: string): N[] { return this.descendants().filter((d) => d.matches(sel)); }
  querySelector(sel: string): N | null { return this.querySelectorAll(sel)[0] ?? null; }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

// ---------- models ----------
type Stop = { id: string; label: string; lane: string; head: string; request?: { text: string }; quiet?: { count: number; calls: Array<{ id: string; text: string; lane: string }> }; call?: { id: string; text: string } };
const st = (id: string, lane: string): Stop => (lane === "you" ? { id, label: id, lane, head: id, request: { text: id } } : { id, label: id, lane, head: id });
const YOU = { id: "you", name: "You", chip: "Y", color: "#1c2740", fromStart: true };
const MAIN = { id: "claude", name: "Claude", chip: "C", color: "#6fb0e3", main: true, fromStart: true };
const helper = (startId: string | null, mergeId: string | null) => ({ id: "h1", name: "Helper", chip: "E", color: "#e0a458", parent: "claude", startId, mergeId });
const model = (stops: Stop[], h?: ReturnType<typeof helper>) => ({ stops, actors: h ? [YOU, MAIN, h] : [YOU, MAIN], live: true, folder: "work", files: [], quietMin: 0 });

const BASE = [st("r1", "you"), st("c1", "claude"), st("c2", "claude"), st("c3", "claude")];
// the helper branches off at c3 while the main lane goes on to c4
const M2 = model([...BASE, st("h1", "h1"), st("c4", "claude")], helper("c3", "c4"));
// one more step on the main lane
const M3 = model([...BASE, st("h1", "h1"), st("c4", "claude"), st("c5", "claude")], helper("c3", "c4"));
// a burst of 12 new stops in one poll: the helper branches, works, merges back at c8; a new request and the steps after it
const BIG = model([...BASE, st("h1", "h1"), st("c4", "claude"), st("h2", "h1"), st("c5", "claude"), st("h3", "h1"), st("c6", "claude"), st("h4", "h1"), st("c7", "claude"),
  st("c8", "claude"), st("r2", "you"), st("c9", "claude"), st("c10", "claude")], helper("c3", "c8"));

// a quiet call (one that changed nothing) filed under c3, then, once c4 exists, under c4: its row moves past c4's row
const quiet = { count: 1, calls: [{ id: "q1", text: "Listed the folder", lane: "claude" }] };
const Q1 = model([...BASE.slice(0, 3), { ...st("c3", "claude"), quiet }, st("c4", "claude")]);
const Q2 = model([...BASE, { ...st("c4", "claude"), quiet }, st("c5", "claude")]);
// one call that changes two files: c4 arrives alone, then c5 from the same call forms the closed header "hdr-c4" over both
const k1 = { id: "k1", text: "Edited two files" };
const H1 = model([...BASE, { ...st("c4", "claude"), call: k1 }]);
const H2 = model([...BASE, { ...st("c4", "claude"), call: k1 }, { ...st("c5", "claude"), call: k1 }]);
// a task with a changed file, for Deliverables (Files) mode
// (a.txt gets a new version from c4 in the poll: the file on show changes, which is what redraws the page behind Deliverables)
const withFile = (m: ReturnType<typeof model>, stops: string[]) => ({ ...m, files: [{ file: "work/a.txt", ref: "a", name: "a.txt", versions: stops.map((stop) => ({ stop, kind: "modified", lane: "claude" })) }] });

// ---------- the page ----------
type Passes = { markers: unknown[]; tags: Record<string, unknown> };
async function boot(first: unknown, opts: { reduce?: boolean; newest?: boolean; passes?: () => Passes; files?: boolean; hash?: string } = {}) {
  let served = first;
  let clock = 0;
  const polls: Array<() => void> = [];
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, headers: { get: () => null }, json: async () => v });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, activeElement: null, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [], hidden: false, addEventListener() {} };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: opts.hash ?? "#v=timeline" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    performance: { now: () => clock },
    matchMedia: (q: string) => ({ matches: !!opts.reduce && q.includes("reduce") }),
    addEventListener() {}, setInterval: () => 0, clearInterval() {},
    setTimeout: (f: () => void, ms: number) => { if (f.name === "poll") { polls.push(f); return 0; } return ms === 6000 ? 0 : setTimeout(f, 0); }, clearTimeout() {},
    fetch: async (u: string) => {
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(served)));
      if (u.includes("/review/status")) return json({ stops: {}, passes: { markers: [], tags: {}, answeredBy: {}, ...(opts.passes ? opts.passes() : {}) }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
      if (u.includes("/review/preferences")) return json({ railOrder: opts.newest ? "newest-first" : "oldest-first" });
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  ((g) as Record<string, unknown>).localStorage = { getItem: (k: string) => (k === "cocheck.showQuiet" ? "on" : null), setItem() {} }; // quiet rows are off by default; these tests are about them
  const ctx = vm.createContext(g);
  for (const f of opts.files ? ["view-table.js", "files-view.js", "review.js"] : ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const tl = () => byId("tl");
  return {
    tl, settle, byId, now: () => clock, setClock: (at: number) => { clock = at; },
    /** the clock moves to `at` ms, the server holds `m`, and the page's poll fires */
    poll: async (m: unknown, at: number) => { clock = at; served = m; polls.splice(0).forEach((f) => f()); await settle(); },
  };
}

type Anim = { name: string; dur: number; delay: number };
function anim(n: N): Anim | null {
  const a = n.style.animation; if (typeof a !== "string" || a === "") return null;
  const m = /^(\S+) (\d+)ms \S+ (-?\d+)ms both$/.exec(a); assert.ok(m, `an animation in the page's form: ${a}`);
  return { name: m[1]!, dur: Number(m[2]), delay: Number(m[3]) };
}
/** each segment once (the solid copy; the faint copy carries the same animation), keyed by its stop ids */
function segs(p: Awaited<ReturnType<typeof boot>>): Map<string, Anim | null> {
  const out = new Map<string, Anim | null>();
  const svg = p.tl().children.find((c) => c.tag === "svg")!;
  for (const n of svg.querySelectorAll("path[data-seg]")) if (n.parentNode?.getAttribute("class") !== "faint") out.set(n.attrs["data-seg"]!, anim(n));
  return out;
}
const rowsByKey = (p: Awaited<ReturnType<typeof boot>>) => new Map(p.tl().children.filter((c) => c.attrs["data-ak"]).map((c) => [c.attrs["data-ak"]!, c]));
const animated = (p: Awaited<ReturnType<typeof boot>>) => p.tl().descendants().filter((n) => anim(n) !== null);
const svgOf = (p: Awaited<ReturnType<typeof boot>>) => p.tl().children.find((c) => c.tag === "svg")!;
const pathOf = (p: Awaited<ReturnType<typeof boot>>, key: string) => svgOf(p).querySelectorAll("path[data-seg]").find((n) => n.attrs["data-seg"] === key && n.parentNode?.getAttribute("class") !== "faint")!;
const dy = (n: N | undefined) => Number(/translateY\((-?[\d.]+)px\)/.exec(n?.transforms[0] ?? "")?.[1] ?? 0);

describe("rail live motion: a poll's new steps cascade in", () => {
  it("a poll that adds stops draws only the new segments, one stop after another, and each new stop fades in as its line arrives", async () => {
    const p = await boot(model(BASE));
    assert.equal(animated(p).length, 0, "the first paint does not animate");
    await p.poll(M2, 1000);
    const s = segs(p);
    assert.deepEqual(s.get("B|h1|c3|h1"), { name: "railgrow", dur: 218, delay: 0 }, "the helper's branch draws first: h1 comes before c4 (two stops: 120 ms slots, 218 ms draws)");
    assert.deepEqual(s.get("L|claude|c3|c4"), { name: "railgrow", dur: 218, delay: 120 }, "then the main lane's new segment, as h1 appears");
    assert.equal(s.get("M|h1|h1|c4")?.delay, 120, "the merge into c4 draws with the other segment that reaches c4");
    for (const k of ["L|claude|c1|c2", "L|claude|c2|c3"]) assert.equal(s.get(k), null, `an old segment (${k}) does not move`);
    const grown = pathOf(p, "L|claude|c3|c4");
    assert.equal(grown.style["--len"], "102px", "the dash is the path's own length (getTotalLength 100, plus 2): never pathLength=1, which Chrome drew as 1px dashes");
    assert.equal(grown.attrs.pathLength, undefined, "no pathLength attribute");
    const rows = rowsByKey(p);
    assert.deepEqual(anim(rows.get("Sh1")!), { name: "railin", dur: 200, delay: 119 }, "h1 appears as its line gets there (55% of 218 ms), no later than the next segment starts");
    assert.deepEqual(anim(rows.get("Sc4")!), { name: "railin", dur: 200, delay: 239 });
    assert.equal(anim(rows.get("Sh1")!.querySelector(".mark")!)?.name, "railnode", "its node settles with it");
    for (const k of ["Sr1", "Sc1", "Sc2", "Sc3"]) assert.equal(anim(rows.get(k)!), null, `an old row (${k}) does not fade again`);
  });

  it("a poll that changes nothing animates nothing", async () => {
    const p = await boot(model(BASE));
    await p.poll(M2, 1000);
    await p.poll(M2, 2000); // the same model again: the rail is rebuilt (the page always rebuilds on an answer), but nothing in it is new
    assert.deepEqual(animated(p).map((n) => n.attrs["data-seg"] ?? n.attrs["data-ak"] ?? n.className), [], "no segment, row or node animates");
  });

  it("segments drawn by an earlier poll never draw again", async () => {
    const p = await boot(model(BASE));
    await p.poll(M2, 1000);
    await p.poll(M3, 2000);
    const s = segs(p);
    assert.deepEqual(s.get("L|claude|c4|c5"), { name: "railgrow", dur: 300, delay: 0 }, "only c5's segment draws");
    const again = [...s].filter(([k, a]) => a !== null && k !== "L|claude|c4|c5").map(([k]) => k);
    assert.deepEqual(again, [], "the branch, the merge and c4's segment stay drawn");
  });

  it("with reduced motion nothing animates and nothing is offset", async () => {
    const p = await boot(model(BASE), { reduce: true });
    await p.poll(M2, 1000);
    await p.poll(BIG, 2000);
    assert.equal(animated(p).length, 0, "no animation");
    assert.deepEqual(p.tl().descendants().filter((n) => typeof n.style.transform === "string" && n.style.transform !== "").length, 0, "no transform");
    assert.equal(p.tl().descendants().filter((n) => n.classList.contains("grow")).length, 0, "no dashed path");
  });

  it("a burst of any size ends inside 600 ms: 12 new stops with a helper branch and merge", async () => {
    const p = await boot(model(BASE));
    await p.poll(BIG, 1000);
    const s = segs(p);
    const fresh = [...s].filter(([, a]) => a !== null);
    const ends = new Set(fresh.map(([k]) => k.split("|").pop()));
    assert.ok(ends.size >= 10, `at least 10 stops get a drawn segment (${ends.size})`);
    assert.ok(s.get("B|h1|c3|h1"), "the branch draws");
    assert.ok(s.get("M|h1|h4|c8"), "the merge draws");
    const all = animated(p);
    const last = Math.max(...all.map((n) => { const a = anim(n)!; return a.delay + a.dur; }));
    assert.ok(last <= 600, `the last motion ends by 600 ms (${last})`);
    const order = BIG.stops.map((x) => x.id);
    const byStop = [...ends].map((e) => ({ e, d: Math.min(...fresh.filter(([k]) => k.endsWith("|" + e)).map(([, a]) => a!.delay)) })).sort((a, b) => order.indexOf(a.e!) - order.indexOf(b.e!));
    for (let i = 1; i < byStop.length; i++) assert.ok(byStop[i]!.d > byStop[i - 1]!.d, `segments draw in time order: ${byStop[i - 1]!.e} before ${byStop[i]!.e}`);
    // the chain: no segment leaves a new stop before that stop is on screen (its row has started to fade in)
    const rows = rowsByKey(p);
    for (const [k, a] of fresh) {
      const from = k.split("|").at(-2)!, row = rows.get("S" + from), ra = row ? anim(row) : null;
      if (ra) assert.ok(a!.delay >= ra.delay, `${k} starts (${a!.delay}) no earlier than ${from} appears (${ra.delay})`);
    }
  });

  it("a kept row that changes places with another fades in at its new place instead of gliding through it; the step keeps its glide", async () => {
    const p = await boot(Q1);
    await p.poll(Q2, 1000);
    const rows = rowsByKey(p);
    const q = rows.get("Qq1")!, c4 = rows.get("Sc4")!;
    assert.ok(q && c4, "the quiet row and c4 are on the rail");
    assert.ok(c4.ever.has("flipo"), "c4 moved up a slot: it glides");
    assert.ok(!q.ever.has("flipo"), "the quiet row that crossed it does not glide");
    assert.deepEqual(anim(q), { name: "railin", dur: 200, delay: 160 }, "it fades in at its new place once the glide is half done");
    assert.ok((anim(rows.get("Sc5")!)?.delay ?? 0) >= 160, "a new row never appears before the rows passing its slot are half way");
  });

  it("newest first: the lines move with their nodes (each path's ends follow its two rows), the drawing never fades, and no line leaves a stop before it shows", async () => {
    const p = await boot(model(BASE), { newest: true });
    await p.poll(M2, 1000);
    const rows = rowsByKey(p);
    const kept = ["Sr1", "Sc1", "Sc2", "Sc3"].map((k) => rows.get(k)!);
    assert.ok(kept.every((r) => dy(r) !== 0), "steps added above push every kept row: each glides from where it was");
    // the chain, with glides: rows that move make the cascade wait until they are half way; no line leaves a new stop before that stop appears
    const s = segs(p);
    const h1 = anim(rows.get("Sh1")!)!, merge = s.get("M|h1|h1|c4")!;
    assert.ok(merge.delay >= h1.delay, `the merge leaves h1 (${merge.delay}) no earlier than h1 appears (${h1.delay})`);
    assert.ok(h1.delay >= 160, "new rows wait for the glide to be half way");
    const svg = svgOf(p);
    assert.ok(!svg.classList.contains("enter") && svg.transforms.length === 0, "the drawing as a whole neither fades nor slides");
    // every path that moves maps its two ends exactly onto where its two rows were (in the mirrored drawing, screen down is drawing up)
    let checked = 0;
    for (const path of svg.querySelectorAll("path[data-seg]")) {
      const t = path.transforms[0]; if (!t) continue;
      const m = /^matrix\(1,0,0,(-?[\d.]+),0,(-?[\d.]+)\)$/.exec(t); assert.ok(m, `a y-only affine: ${t}`);
      const nums = String(path.attrs.d).match(/-?\d+(?:\.\d+)?/g)!.map(Number), yA = nums[1]!, yB = nums.at(-1)!;
      const gA = -dy(rows.get(path.attrs["data-from"]!)), gB = -dy(rows.get(path.attrs["data-to"]!));
      assert.ok(Math.abs(Number(m[1]) * yA + Number(m[2]) - (yA + gA)) < 0.05 && Math.abs(Number(m[1]) * yB + Number(m[2]) - (yB + gB)) < 0.05, `${path.attrs["data-seg"]}: both ends sit where their nodes were`);
      checked++;
    }
    assert.ok(checked >= 3, `the old lines follow their nodes (${checked} paths)`);
    const last = Math.max(...animated(p).map((n) => { const a = anim(n)!; return a.delay + a.dur; }));
    assert.ok(last <= 600, `inside the cap (${last})`);
  });

  it("newest first: a node that moves exactly one segment length never gives its line a zero vertical scale (a browser cannot interpolate a singular matrix)", async () => {
    const p = await boot(model(BASE), { newest: true });
    await p.poll(M2, 1000);
    let zeroCase = 0;
    for (const path of svgOf(p).querySelectorAll("path[data-seg]")) {
      const t = path.transforms[0]; if (!t) continue;
      const m = /^matrix\(1,0,0,(-?[\d.]+),0,(-?[\d.]+)\)$/.exec(t); assert.ok(m, `a y-only affine: ${t}`);
      const nums = String(path.attrs.d).match(/-?\d+(?:\.\d+)?/g)!.map(Number), len = nums.at(-1)! - nums[1]!;
      const move = Math.abs(dy(rowsByKey(p).get(path.attrs["data-from"]!)) - dy(rowsByKey(p).get(path.attrs["data-to"]!)));
      if (Math.abs(Math.abs(len) - move) < 0.5 || Math.abs(len + (dy(rowsByKey(p).get(path.attrs["data-to"]!)) - dy(rowsByKey(p).get(path.attrs["data-from"]!)))) < 0.5) zeroCase++;
      assert.ok(Math.abs(Number(m[1])) >= 1e-4, `${path.attrs["data-seg"]}: vertical scale ${m[1]} is not zero`);
    }
    assert.ok(zeroCase > 0, "the poll includes a line whose end node moves by its whole length");
  });

  it("rows far outside the view (over 60 px) are not transformed: only what can be seen glides", async () => {
    const p = await boot(model(BASE), { newest: true });
    p.byId("scroller").clientHeight = 1; // a 1 px window over the top of the rail: "far" is beyond 61 px, before and after
    await p.poll(M2, 1000); // two 30 px rows arrive above, so every kept row moves down 60 px
    const rows = rowsByKey(p);
    const far = ["Sr1", "Sc1", "Sc2", "Sc3"].map((k) => rows.get(k)!).filter((r) => parseFloat(String(r.style.top)) - 60 > 61);
    assert.ok(far.length > 0, "some kept rows sit far below the window");
    for (const r of far) assert.equal(r.transforms.length, 0, `${r.attrs["data-ak"]} far below the view is left alone`);
  });

  it("oldest first, a row pushed down mid-list: its incoming line stretches with it instead of waiting at the final place", async () => {
    const p = await boot(Q1);
    await p.poll(Q2, 1000); // the quiet row leaves c3's slot: c4 moves up, and the line c3 -> c4 must shorten with it
    const c4 = rowsByKey(p).get("Sc4")!, line = pathOf(p, "L|claude|c3|c4");
    assert.ok(dy(c4) !== 0, "c4 glides");
    assert.ok(line.transforms.length === 1 && line.transforms[0]!.startsWith("matrix("), "its line from c3 follows it");
  });

  it("a call's second file forming a header mid-cascade keeps the step's row and line: nothing redraws, nothing blanks; opening and closing it by hand cuts nothing", async () => {
    const p = await boot(model(BASE));
    await p.poll(H1, 1000); // c4 alone: its line draws (300 ms), its row appears at 165 ms
    await p.poll(H2, 1100); // c5 from the same call: the closed header hdr-c4 now stands where c4 was
    let s = segs(p);
    assert.equal(s.has("L|claude|c3|hdr-c4"), false, "a header has no line of its own: it stands for its first file");
    assert.deepEqual(s.get("L|claude|c3|c4"), { name: "railgrow", dur: 300, delay: -100 }, "c4's line carries on, 100 ms in");
    let rows = rowsByKey(p);
    assert.ok(rows.get("Sc4")?.classList.contains("hdr"), "the header row is the row c4 was: same row, handed over");
    assert.equal(anim(rows.get("Sc4")!)?.delay, 65, "and it keeps fading in on c4's clock (165 ms after 1000), never blank from the start again");
    assert.equal(rows.has("Shdr-c4"), false);
    rows.get("Sc4")!.fire("click"); await p.settle(); // open the header by hand, 100 ms into the cascade
    s = segs(p); rows = rowsByKey(p);
    assert.equal(s.get("L|claude|c3|c4")?.delay, -100, "opening re-attaches the line, it does not cut it");
    assert.equal(anim(rows.get("Sc4")!)?.delay, 65, "the c4 row (now under its open header) keeps its fade");
    p.setClock(1150);
    rows.get("Shdr-c4")!.fire("click"); await p.settle(); // and close it again
    assert.equal(segs(p).get("L|claude|c3|c4")?.delay, -150, "closing re-attaches it too");
  });

  it("a session with a send-back: the review status tagging the new stops rebuilds the rail mid-cascade, and the cascade carries on", async () => {
    let served = false;
    const passes = () => (served ? { markers: [{ kind: "sendback", label: "Sent back", pass: 2, beforeStop: "h1" }], tags: { h1: { tag: "new", text: "new" }, c4: { tag: "new", text: "new" } } } : { markers: [], tags: {} });
    const p = await boot(model(BASE), { passes });
    served = true;
    await p.poll(M2, 1000);
    assert.ok(p.tl().children.some((c) => c.classList.contains("pmark")), "the send-back marker is on the rail: the status rebuild happened");
    const s = segs(p);
    assert.equal(s.get("B|h1|c3|h1")?.name, "railgrow", "the branch still draws");
    assert.equal(s.get("L|claude|c3|c4")?.delay, 120, "c4's line still waits its turn");
    assert.equal(anim(rowsByKey(p).get("Sc4")!)?.delay, 239, "c4's row still waits for its line");
  });

  // the person has no lane or legend token any more (requests are section headers), so the non-poll rebuild here is the background-commands switch
  it("a non-poll rebuild mid-cascade re-attaches what runs on the lanes", async () => {
    const p = await boot(model(BASE));
    await p.poll(M2, 1000);
    p.setClock(1100);
    p.byId("quietbtn").fire("click"); await p.settle();
    const s = segs(p);
    assert.equal(s.get("B|h1|c3|h1")?.delay, -100, "the branch carries on, 100 ms in");
    assert.equal(s.get("L|claude|c3|c4")?.delay, 20, "c4's line still starts at 120 ms");
  });

  it("a poll while Deliverables is on show never animates the hidden rail, and switching back plays nothing stale", async () => {
    const p = await boot(withFile(model(BASE), ["c1"]), { files: true, hash: "#v=files" });
    assert.equal(p.byId("railcol").hidden, true, "Deliverables is on show; the rail column is hidden");
    await p.poll(withFile(M2, ["c1", "c4"]), 1000);
    assert.equal(animated(p).length, 0, "nothing animates on the hidden rail");
    p.setClock(1100);
    p.byId("vsteps").fire("click"); await p.settle();
    assert.equal(p.byId("railcol").hidden, false, "back on the Timeline");
    assert.equal(animated(p).filter((n) => anim(n)!.name === "railgrow").length, 0, "no line draws a cascade that belonged to a poll nobody saw");
  });

  it("a poll that lands mid-cascade carries the running motion on from where it is, and starts only the new segment", async () => {
    const p = await boot(model(BASE));
    await p.poll(M2, 1000); // branch starts at 1000, c4's segment at 1120, c4's row at 1285
    await p.poll(M3, 1150);
    const s = segs(p);
    assert.equal(s.get("B|h1|c3|h1")?.delay, -150, "the branch, 150 ms in, goes on from 150 ms");
    assert.equal(s.get("B|h1|c3|h1")?.dur, 218, "with the draw time it started with");
    assert.equal(s.get("L|claude|c3|c4")?.delay, -30, "c4's segment, 30 ms in, goes on from 30 ms");
    assert.deepEqual(s.get("L|claude|c4|c5"), { name: "railgrow", dur: 300, delay: 0 }, "c5's segment starts now: a lone new stop draws in 300 ms");
    const rows = rowsByKey(p);
    assert.equal(anim(rows.get("Sc4")!)?.delay, 89, "c4's row still waits for its line: 239 ms after 1000, so 89 ms from now");
    assert.equal(anim(rows.get("Sh1")!)?.delay, -31, "h1's row, already fading, goes on from 31 ms in");
    await p.poll(M3, 1800); // past every end: a later poll with nothing new leaves it all drawn
    assert.equal(animated(p).length, 0, "nothing runs once the cascade is over");
  });
});

describe("live motion keeps the stylesheet's resting opacity (muted rows)", () => {
  it("no rail keyframe pins opacity at its end, so a fill-mode both animation ends on the element's own resting value (.row.muted .mark is .55)", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /\.row\.muted \.lbl,\.row\.muted \.mark\{opacity:\.55\}/, "the resting rule this guards");
    for (const name of ["railin", "lanein", "railnode"]) {
      const body = css.slice(css.indexOf(`@keyframes ${name}{`)).split("\n")[0];
      assert.ok(body.startsWith(`@keyframes ${name}{`), `keyframes ${name} exists`);
      const to = body.match(/to\{([^}]*)\}/)?.[1] ?? "";
      assert.doesNotMatch(to, /opacity/, `${name}: the end frame must not set opacity (a fill-mode both end of 1 overrides the muted .55)`);
    }
  });
});
