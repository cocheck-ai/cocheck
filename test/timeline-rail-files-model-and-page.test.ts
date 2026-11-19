import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { ASSETS, renderReviewShell } from "../src/timeline/rail/page.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// the review model's `files` list: per changed file, its versions in time order, each with sha, actor chip and lane, time, a short
// label and the change id. Built from the same ledger-shaped rows the lane tests use: two actors changing one file in order, and a file
// changed while Claude and a helper overlapped (the "?" lane).

const W = "/w/";
const helper = { agent_id: "ag1", agent_type: "general-purpose" };
const sha = (c: string): string => c.repeat(64);

function fixture(stored: string[] = []) {
  const c = (id: string, at: number, end: number, named: string[], extra: Record<string, unknown> = {}) => call(id, { desc: id, at, end, named, extra: { startSeq: at, ...extra } });
  const ops = [
    c("x1", 10, 15, [W + "shared.csv"]),
    c("h1", 20, 25, [W + "shared.csv"], helper),
    c("j", 30, 60, [W + "joint.csv"]),
    c("jh", 40, 50, [W + "joint.csv"], helper),
    prompt("s1", ["Build it."], { requests: [{ seq: 1, at: 5, firstStep: null }] }),
    stop("s1", "done"),
  ];
  const fileStates = [
    state(W + "shared.csv", sha("a"), null, { step: 1 }),
    state(W + "joint.csv", sha("d"), null, { step: 1 }),
    state(W + "shared.csv", sha("b"), sha("a"), { open: ["x1"], credited: ["x1"] }),
    state(W + "shared.csv", sha("c"), sha("b"), { open: ["h1"], credited: ["h1"] }),
    state(W + "joint.csv", sha("e"), sha("d"), { open: ["j", "jh"], credited: ["j", "jh"] }),
  ];
  const input: TimelineInput = { taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(stored.map((s) => [sha(s), 4])), formats: new Map(), quickLook: false };
  return buildRailModel(buildTimeline(input));
}

describe("the model's files list", () => {
  it("lists each changed file once, its versions in time order with sha, chip, lane, time, label and change id", () => {
    const m = fixture(["b"]);
    assert.deepEqual(m.files.map((f) => f.file).sort(), ["joint.csv", "shared.csv"]);
    const shared = m.files.find((f) => f.file === "shared.csv")!;
    assert.deepEqual(shared.versions.map((v) => [v.sha, v.lane, v.chip]), [[sha("b"), "claude", "C"], [sha("c"), "agent:1", "1"]]);
    assert.deepEqual(shared.versions.map((v) => v.kept), [true, false]);
    for (const v of shared.versions) {
      assert.equal(typeof v.at, "number");
      assert.equal(v.label, "Changed");
      assert.match(v.change, /\S/);
      assert.equal(m.stops.find((s) => s.id === v.stop)!.change!.key, v.change, "the version points at its own step and change");
    }
    assert.ok(shared.versions[0]!.at! < shared.versions[1]!.at!);
  });

  it("a file changed by the Unknown lane carries lane unsure and chip U", () => {
    const joint = fixture().files.find((f) => f.file === "joint.csv")!;
    assert.deepEqual(joint.versions.map((v) => [v.lane, v.chip]), [["unsure", "U"]]);
  });

  it("every version's lane is an actor of the model", () => {
    const m = fixture();
    for (const f of m.files) for (const v of f.versions) assert.ok(m.actors.some((a) => a.id === v.lane && a.chip === v.chip));
  });
});

describe("the shell", () => {
  it("serves the files-view script and style through the whitelist, with the Steps/Files switch in the header", () => {
    assert.ok("files-view.js" in ASSETS);
    const html = renderReviewShell(3);
    assert.match(html, /id="viewswitch"/);
    assert.match(html, /\/timeline-assets\/files-view\.js/);
    assert.match(html, /id="filesview"/);
  });
});

// The page: review.js and files-view.js run as they are in a vm with a DOM stub; a fetch spy records which per-change view each click asks for.
class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; nodeType = 1;
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() {}
  scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

async function boot(hash: string, stored: string[] = ["b"]) {
  const model = JSON.parse(JSON.stringify(fixture(stored)));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const body = mkNode(); body.getAttribute = (() => "1") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const spy = { hashes: [] as string[], views: [] as string[], intervals: [] as unknown[] };
  const handlers: Record<string, (e: unknown) => void> = {};
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash }, history: { replaceState(_a: unknown, _b: unknown, h: string) { spy.hashes.push(h); } }, innerWidth: 1600, URLSearchParams, console,
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; },
    setInterval: (f: () => void, ms: number) => { const id = setInterval(f, ms); spy.intervals.push(id); return id; }, clearInterval,
    fetch: async (u: string) => {
      if (u.includes("/review/model")) return { ok: true, status: 200, json: async () => model };
      if (u.includes("/view/")) { spy.views.push(decodeURIComponent(u.split("/view/")[1]!.split("?")[0]!)); return { ok: true, status: 200, json: async () => ({ change: "c", file: "shared.csv", engine: "drawn by CoCheck", kind: "grid", before: [], after: [], boxes: [], caveats: [] }) }; }
      return { ok: false, status: 404, json: async () => ({}) };
    } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 30));
  const cleanup = () => spy.intervals.forEach((i) => clearInterval(i as never));
  return { byId, spy, model, handlers, cleanup, settle: () => new Promise((r) => setTimeout(r, 30)) };
}
const strip = (p: Awaited<ReturnType<typeof boot>>) => p.byId("strip").children;

describe("the page", () => {
  it("#v=files opens the Files view: list, strip with Before task, v1..vN and Now, actor chips", async () => {
    const p = await boot("#v=files&f=shared.csv&p=1");
    try {
      assert.equal(p.byId("filesview").hidden, false);
      assert.equal(p.byId("listcol").hidden, false);
      assert.equal(p.byId("railcol").hidden, true);
      assert.equal(p.byId("vfiles").attrs["aria-pressed"], "true");
      const names = p.byId("fileslist").descendants().filter((n) => n.className === "nm").map((n) => n.textContent);
      assert.deepEqual(names.sort(), ["joint.csv", "shared.csv"]);
      const f = p.model.files.find((x: { file: string }) => x.file === "shared.csv");
      assert.equal(strip(p).length, f.versions.length + 2);
      assert.deepEqual(strip(p).map((b: N) => b.attrs["data-p"]), ["0", ...f.versions.map((_: unknown, i: number) => String(i + 1)), String(f.versions.length + 1)], "oldest first, newest on the right");
      assert.deepEqual([strip(p)[0]!, strip(p).at(-1)!].map((b: N) => b.children[0]!.children[0]!.textContent), ["Before task", "Now"]);
      const chips = strip(p).slice(1, -1).map((b: N) => b.descendants().find((d) => d.className === "chip")!.textContent);
      assert.deepEqual(chips, f.versions.map((v: { chip: string }) => v.chip));
      assert.ok(p.spy.views.includes(f.versions[0].change), "the selected version's change is the one the per-change view fetched");
    } finally { p.cleanup(); }
  });

  it("clicking a version shows that change's view; a version whose bytes are not kept says content not kept", async () => {
    const p = await boot("#v=files&f=shared.csv&p=1");
    try {
      const f = p.model.files.find((x: { file: string }) => x.file === "shared.csv");
      assert.equal(f.file, "shared.csv");
      assert.doesNotMatch(p.byId("fvorder").textContent, /content not kept/, "v1 is kept");
      strip(p).find((b: N) => b.attrs["data-p"] === "2")!.click();
      await p.settle();
      assert.equal(p.spy.views.at(-1), f.versions[1].change);
      assert.match(p.byId("fvorder").textContent, /content not kept/);
      assert.ok(p.spy.hashes.at(-1)!.startsWith("#v=files"), "the Files hash is kept; the Steps hash is not written");
    } finally { p.cleanup(); }
  });

  it("two actors changing one file in order: the strip shows both chips in time order", async () => {
    const p = await boot("#v=files&f=shared.csv&p=2");
    try {
      const chips = strip(p).slice(1, -1).map((b: N) => b.descendants().find((d) => d.className === "chip")!.textContent);
      assert.deepEqual(chips, ["C", "1"]);
    } finally { p.cleanup(); }
  });

  it("a file changed by the Unknown lane shows the U chip", async () => {
    const p = await boot("#v=files&f=joint.csv&p=1");
    try {
      assert.equal(p.model.files[0].file, "joint.csv", "joint.csv changed last");
      const chips = strip(p).slice(1, -1).map((b: N) => b.descendants().find((d) => d.className === "chip")!.textContent);
      assert.deepEqual(chips, ["U"]);
    } finally { p.cleanup(); }
  });

  it("with no hash a task with deliverables opens on Deliverables, at the first changed file's Now", async () => {
    const p = await boot("");
    try {
      assert.equal(p.byId("vfiles").attrs["aria-pressed"], "true");
      assert.equal(p.byId("vsteps").attrs["aria-pressed"], "false");
      assert.equal(p.byId("listcol").hidden, false);
      assert.equal(p.byId("railcol").hidden, true);
      assert.ok(p.spy.hashes.at(-1)!.startsWith("#v=files&f="), p.spy.hashes.at(-1) ?? "");
    } finally { p.cleanup(); }
  });

  it("a #n step link still opens the Timeline on that step", async () => {
    const p = await boot("#1");
    try {
      assert.equal(p.byId("vsteps").attrs["aria-pressed"], "true");
      assert.equal(p.byId("vfiles").attrs["aria-pressed"], "false");
      assert.ok(p.spy.hashes.every((h) => !h.startsWith("#v=files")), "nothing wrote a Files hash");
      assert.equal(p.byId("railcol").hidden, false);
    } finally { p.cleanup(); }
  });

  it("#v=timeline (and #v=steps) opens on the Timeline, hides the Files parts, and the switch moves to Files and back", async () => {
    for (const hash of ["#v=timeline", "#v=steps"]) {
      const p = await boot(hash);
      try {
        assert.equal(p.byId("filesview").hidden, false, "the stub starts visible; Steps never sets it, so nothing in Steps touched it");
        assert.equal(p.byId("vfiles").attrs["aria-pressed"], "false");
        assert.equal(p.byId("vsteps").attrs["aria-pressed"], "true");
        assert.ok(p.spy.hashes.every((h) => !h.startsWith("#v=files")), "nothing wrote a Files hash");
        p.byId("vfiles").click();
        await p.settle();
        assert.equal(p.byId("listcol").hidden, false);
        assert.equal(p.byId("railcol").hidden, true);
        p.byId("vsteps").click();
        await p.settle();
        assert.equal(p.byId("railcol").hidden, false);
        // back on the Timeline the URL names the view and keeps no step number (the Timeline always opens at the top)
        assert.ok(p.spy.hashes.at(-1)!.endsWith("#v=timeline"), p.spy.hashes.at(-1) ?? "");
      } finally { p.cleanup(); }
    }
  });
});
