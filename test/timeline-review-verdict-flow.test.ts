import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// The review page v2 shell (the review page v2 design). No start stop: the page opens on the first step that needs a verdict.
// The verdict control is Pass and Fail with P, F and U; a call header's verdict covers the files under it that have none of their own.
// The page code runs as is in a vm with a DOM stub; the verdict route is a fake that keeps state like the real one (one row per POST).

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string, file: string, call: string): Change => ({ id, file, outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: [call], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } }) as unknown as Change;
const call = (id: string, start: number, text: string, changes: Change[]) => ({ id, index: 1, of: 1, host: "claude", tool: "Bash", start, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text, source: "agent-description", label: "l" } });
// One request; a lone change (a.txt), then one call that changed two files (b.txt, c.txt) and so gets a header, then another lone change (d.txt).
const tl = { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 3, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [
    call("k1", 1, "write a", [change("a", "a.txt", "k1")]),
    call("k2", 2, "Rerun the fetch", [change("b", "b.txt", "k2"), change("c", "c.txt", "k2")]),
    call("k3", 3, "write d", [change("d", "d.txt", "k3")]),
  ] }] }] } as unknown as Timeline;
const model = buildRailModel(tl);
// The page's steps: the model's stops with a header above the b, c run.
const STEPS = ["req-r0", "chg-a", "hdr", "chg-b", "chg-c", "chg-d"];

class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false; focused = false;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  fire(k: string, e: Record<string, unknown> = {}) { let prevented = false; (this.listeners[k] ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() { prevented = true; }, target: this, ...e })); return prevented; }
  click() { this.fire("click"); }
  focus() { this.focused = true; } select() {} scrollIntoView() {} showModal() { this.open = true; } close() { this.open = false; }
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });
const has = (n: N, c: string) => n.className.split(/\s+/).includes(c);

type St = { status: "passed" | "failed" | "not_reviewed"; note: string; stale: boolean; history: unknown[] };
async function boot(opts: { verdicts?: Record<string, ["passed" | "failed", string?]>; hash?: string; reduced?: boolean; live?: boolean; superseded?: string[]; notes?: unknown[] } = {}) {
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const loc = { search: "?t=tok", pathname: "/timeline/7/page", hash: opts.hash ?? "#1" };
  const handlers: Record<string, (e: unknown) => void> = {};
  const timers: Array<{ f: () => void; ms: number }> = [];
  const polls: Array<() => void> = [];
  const posts: Array<{ stop: string; status: string; note: string }> = [];
  const submits: unknown[] = [];
  const stops: Record<string, St> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  for (const [id, [status, note]] of Object.entries(opts.verdicts ?? {})) stops[`chg-${id}`] = { status, note: note ?? "", stale: false, history: [] };
  const summary = () => ({ anyFailed: Object.values(stops).some((s) => s.status === "failed"), submit: { blocking: [], superseded: opts.superseded ?? [], notReviewed: Object.keys(stops).filter((k) => stops[k]!.status === "not_reviewed"), eligible: true } });
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => v });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: loc, history: { replaceState(_a: unknown, _b: unknown, u: string) { loc.hash = u.includes("#") ? u.slice(u.indexOf("#")) : ""; } }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    ...(opts.reduced === undefined ? {} : { matchMedia: (q: string) => ({ matches: opts.reduced === true && q === "(prefers-reduced-motion: reduce)" }) }),
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval: () => 0, clearInterval() {},
    // the undo bar's six seconds are held here, so a test decides when they run out
    setTimeout: (f: () => void, ms: number) => { if (opts.live && f.name === "poll") { polls.push(f); return 1000 + polls.length; } if (ms === 6000) { timers.push({ f, ms }); return timers.length; } if (f.name === "poll") return 0; return setTimeout(f, 0); }, clearTimeout() {},
    fetch: async (u: string, init?: { body?: string }) => {
      if (u.includes("/review/model")) return json({ ...JSON.parse(JSON.stringify(model)), ...(opts.live ? { live: true } : {}) });
      if (u.includes("/review/status")) return json({ stops: JSON.parse(JSON.stringify(stops)), passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], notes: opts.notes ?? [], ...summary() });
      if (u.includes("/review/verdict")) {
        const b = JSON.parse(init!.body!);
        if (b.status === "failed" && String(b.note).trim() === "") return json({ error: "needs a note" }, false);
        posts.push({ stop: b.stop, status: b.status, note: b.note });
        if (!(b.stop in stops)) return json({ error: "no such stop" }, false);
        stops[b.stop] = { status: b.status, note: b.status === "failed" ? b.note : "", stale: false, history: [] };
        return json({ stop: b.stop, state: stops[b.stop], ...summary() });
      }
      if (u.includes("/review/submit")) { submits.push(JSON.parse(init!.body!)); return json({ submitted: true, n: 1, label: "soft sign-off, not verified" }); }
      if (u.includes("/view/")) return json({ change: "x", file: "f", engine: "e", kind: "card", before: [], after: [], boxes: [], caveats: [] });
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const press = async (k: string, target: unknown = { tagName: "BODY" }) => { let prevented = false; handlers.keydown!({ key: k, target, preventDefault() { prevented = true; } }); await settle(); return prevented; };
  const h1 = () => byId("h1").textContent;
  // the step on show, read from its heading (every step's heading differs here)
  const on = () => (h1() === "Rerun the fetch" ? "hdr" : model.stops.find((s) => (s.title ?? s.head) === h1())?.id);
  const expire = () => { timers.splice(0).forEach((t) => t.f()); };
  const poll = async () => { const f = polls.pop(); assert.ok(f, "a poll is scheduled"); f(); await settle(); };
  return { byId, press, settle, poll, posts, submits, stops, on, h1, expire, loc };
}

describe("no start stop; the page opens on the first request", () => {
  it("the model has no start stop and the rail draws the origin as a marker, not a row", async () => {
    assert.ok(!model.stops.some((s) => s.id === "start" || s.label === "Start"));
    assert.equal(model.stops[0]!.id, "req-r0");
    const p = await boot();
    const rows = p.byId("tl").children.filter((n) => has(n, "row"));
    assert.equal(rows.length, STEPS.length - 2, "one row per step, none for the origin; the two files under the closed header have none");
    assert.ok(!rows.some((r) => /Start/.test(r.textContent)));
    const origin = p.byId("tl").children.filter((n) => has(n, "origin"));
    assert.equal(origin.length, 1);
    assert.equal(origin[0]!.tag, "div", "not a button: nothing to select");
    assert.equal(origin[0]!.attrs["aria-hidden"], "true");
  });

  // There is no jump to the first unreviewed change. The tests below pass hash: "" (no #n),
  // which is a plain visit; every other test in this file names its step with #n (default "#1", the first change) so it starts where it always did.
  it("with no verdict it opens on the first request, at the top", async () => {
    const p = await boot({ hash: "" });
    assert.equal(p.on(), "req-r0");
  });

  it("with verdicts already given it still opens on the first request, whatever the verdicts are", async () => {
    for (const verdicts of [{ a: ["passed"] }, { b: ["passed"], c: ["passed"] }, { a: ["passed"], b: ["passed"], c: ["passed"], d: ["passed"] }, { a: ["failed", "bad"] }] as Array<Record<string, ["passed" | "failed", string?]>>) {
      const p = await boot({ hash: "", verdicts });
      assert.equal(p.on(), "req-r0", JSON.stringify(verdicts));
    }
  });

  it("it stays there once the status route has answered, and a key press is the only thing that moves it", async () => {
    const p = await boot({ hash: "", verdicts: { a: ["passed"] } });
    await p.settle(); await p.settle();
    assert.equal(p.on(), "req-r0");
    await p.press("ArrowRight");
    assert.notEqual(p.on(), "req-r0", "the keys move as they did");
  });

  // The page keeps no position in the URL, so a reload (a boot with the location the page left behind) opens at the top.
  it("moving with the keys leaves no step number in the URL, so the next visit opens on the first request", async () => {
    const p = await boot({ hash: "" });
    await p.press("ArrowRight"); await p.press("ArrowRight");
    assert.notEqual(p.on(), "req-r0");
    assert.doesNotMatch(p.loc.hash, /^#\d+$/);
    const again = await boot({ hash: p.loc.hash, verdicts: { a: ["passed"] } });
    assert.equal(again.on(), "req-r0");
    // a page that was opened on a named step and then moved forgets it too
    const named = await boot({ hash: "#3" });
    await named.press("ArrowRight");
    assert.equal(named.loc.hash, "");
  });

  it("a #n in the URL wins", async () => {
    const p = await boot({ hash: "#3" });
    assert.equal(p.on(), "chg-b");
  });
});

describe("the verdict control", () => {
  it("is two buttons with key hints P and F, with no Mark not reviewed", () => {
    const html = renderReviewShell(7);
    assert.match(html, /id="pbpass"[^>]*aria-keyshortcuts="P"[^>]*>[\s\S]*?Pass <kbd>P<\/kbd>/);
    assert.match(html, /id="pbfail"[^>]*aria-keyshortcuts="F"[^>]*>[\s\S]*?Fail <kbd>F<\/kbd>/);
    // The header's own Pass/Fail and their container are gone; the bar holds the only pair
    assert.doesNotMatch(html, /id="(vpass|vfail|verdict|vcover)"/);
    assert.doesNotMatch(html, /Mark not reviewed|id="vreset"/);
  });

  it("shows no verdict control on a request", async () => {
    const p = await boot({ hash: "#0" });
    assert.equal(await p.press("p"), false, "P does nothing on a step that takes no verdict");
    assert.deepEqual(p.posts, []);
  });

  it("P passes the change and jumps to the next step that needs a verdict", async () => {
    const p = await boot();
    assert.equal(p.on(), "chg-a");
    assert.equal(await p.press("p"), true);
    assert.deepEqual(p.posts, [{ stop: "chg-a", status: "passed", note: "" }]);
    assert.equal(p.on(), "hdr", "the next step needing a verdict is the header over b and c");
  });

  it("P skips a step that already has a verdict", async () => {
    const p = await boot({ verdicts: { b: ["passed"], c: ["failed", "bad"] }, hash: "#1" });
    await p.press("p");
    assert.equal(p.on(), "chg-d", "the header and both files under it have verdicts");
  });

  it("a header's verdict covers each file under it that has none, and a file's own verdict wins", async () => {
    const p = await boot({ verdicts: { a: ["passed"], b: ["failed", "wrong total"] }, hash: "#2" });
    assert.equal(p.on(), "hdr");
    await p.press("p");
    assert.deepEqual(p.posts, [{ stop: "chg-c", status: "passed", note: "" }], "b keeps its own fail; only c is posted");
    assert.deepEqual([p.stops["chg-b"]!.status, p.stops["chg-c"]!.status], ["failed", "passed"]);
    assert.ok(!p.posts.some((x) => x.stop.startsWith("hdr")), "the header's id never reaches the server");
    await p.press("ArrowLeft"); await p.press("ArrowLeft"); await p.press("ArrowLeft");
    assert.equal(p.on(), "hdr");
  });

  it("a fail on the header needs one note, which goes to every file it covers", async () => {
    const p = await boot({ verdicts: { a: ["passed"] }, hash: "#2" });
    assert.equal(p.on(), "hdr");
    await p.press("f");
    assert.equal(p.byId("pcomp").hidden, false);
    p.byId("vnote").value = "Both files are empty.";
    p.byId("vfailgo").click(); await p.settle();
    assert.deepEqual(p.posts, [{ stop: "chg-b", status: "failed", note: "Both files are empty." }, { stop: "chg-c", status: "failed", note: "Both files are empty." }]);
    assert.equal(p.byId("pbfail").attrs["aria-pressed"], "true");
  });

  it("F opens the note; a fail with no note is refused and nothing is posted", async () => {
    const p = await boot();
    assert.equal(p.byId("pcomp").hidden, true);
    assert.equal(await p.press("f"), true);
    assert.equal(p.byId("pcomp").hidden, false);
    assert.equal(p.byId("vnote").focused, true);
    for (const v of ["", "   "]) {
      p.byId("vnote").value = v;
      p.byId("vfailgo").click(); await p.settle();
    }
    assert.deepEqual(p.posts, []);
    assert.match(p.byId("vmsg").textContent, /wrong/);
    assert.equal(p.byId("pcomp").hidden, false, "the note stays open");
  });

  it("Enter in the note saves the fail, Escape cancels it, and neither leaves the note", async () => {
    const p = await boot();
    await p.press("f");
    p.byId("vnote").value = "Off by one.";
    assert.equal(p.byId("vnote").fire("keydown", { key: "Escape" }), true);
    await p.settle(); // the note fades out before it hides
    assert.equal(p.byId("pcomp").hidden, true);
    assert.deepEqual(p.posts, []);
    await p.press("f");
    p.byId("vnote").value = "Off by one.";
    assert.equal(p.byId("vnote").fire("keydown", { key: "Enter", shiftKey: true }), false, "Shift+Enter is a new line");
    assert.deepEqual(p.posts, []);
    assert.equal(p.byId("vnote").fire("keydown", { key: "Enter" }), true);
    await p.settle();
    assert.deepEqual(p.posts, [{ stop: "chg-a", status: "failed", note: "Off by one." }]);
    assert.equal(p.on(), "chg-a", "a fail does not move on");
  });

  it("pressing the chosen button again clears the verdict", async () => {
    const p = await boot({ verdicts: { a: ["passed"] }, hash: "#1" });
    assert.equal(p.byId("pbpass").attrs["aria-pressed"], "true");
    p.byId("pbpass").click(); await p.settle();
    assert.deepEqual(p.posts, [{ stop: "chg-a", status: "not_reviewed", note: "" }]);
    assert.equal(p.byId("pbpass").attrs["aria-pressed"], "false");
  });
});

describe("undo", () => {
  it("every verdict shows the bar; U puts back what each file had and returns to that step", async () => {
    const p = await boot({ verdicts: { a: ["passed"], b: ["failed", "wrong total"] }, hash: "#2" });
    await p.press("p");
    assert.equal(p.byId("toast").hidden, false);
    assert.match(p.byId("toasttext").textContent, /^Passed the 1 file under .Rerun the fetch.\.$/);
    assert.equal(p.on(), "chg-d", "P moved on");
    assert.equal(await p.press("u"), true);
    assert.deepEqual(p.posts.slice(1), [{ stop: "chg-c", status: "not_reviewed", note: "" }], "only what the verdict changed is put back");
    assert.equal(p.stops["chg-b"]!.status, "failed", "the file's own fail is untouched");
    assert.equal(p.on(), "hdr", "back on the step the verdict was given on");
    assert.equal(p.byId("toast").hidden, true);
  });

  it("undo puts back a fail with its note", async () => {
    const p = await boot({ verdicts: { a: ["failed", "first note"] }, hash: "#1" });
    p.byId("pbfail").click(); await p.settle();
    assert.deepEqual(p.posts, [{ stop: "chg-a", status: "not_reviewed", note: "" }]);
    p.byId("undo").click(); await p.settle();
    assert.deepEqual(p.posts[1], { stop: "chg-a", status: "failed", note: "first note" });
  });

  it("after six seconds the bar is gone and U does nothing", async () => {
    const p = await boot();
    await p.press("p");
    p.expire();
    await p.settle(); // the bar fades out before it hides
    assert.equal(p.byId("toast").hidden, true);
    assert.equal(await p.press("u"), false);
    assert.equal(p.posts.length, 1);
  });
});

describe("the task bar", () => {
  it("counts changes only, and Send back shows the count of failed changes", async () => {
    const p = await boot({ verdicts: { a: ["passed"], b: ["failed", "x"] } });
    assert.equal(p.byId("progtext").textContent, "2 of 4 changes reviewed");
    assert.equal(p.byId("failcount").textContent, "1");
    assert.equal(p.byId("failcount").hidden, false);
    assert.equal(p.byId("sendback").disabled, false);
  });

  it("Submit asks once, naming the unreviewed changes, and acknowledges every step the server lists", async () => {
    const p = await boot({ verdicts: { a: ["passed"] } });
    p.byId("submit").click(); await p.settle();
    assert.equal(p.byId("subdlg").open, true);
    assert.match(p.byId("subdlgtext").textContent, /^3 of 4 changes have no verdict yet\./);
    assert.deepEqual(p.submits, [], "nothing is submitted before the answer");
    p.byId("subgo").click(); await p.settle();
    assert.deepEqual(p.submits, [{ acknowledge: ["req-r0", "chg-b", "chg-c", "chg-d"] }]);
    assert.equal(p.byId("submsg").textContent, "Signed off. You can still add to it.", "no soft sign-off wording on the page");
  });

  it("with every change reviewed it submits without asking; the request, which takes no verdict, is acknowledged with it", async () => {
    const p = await boot({ verdicts: { a: ["passed"], b: ["passed"], c: ["passed"], d: ["passed"] } });
    p.byId("submit").click(); await p.settle();
    assert.equal(p.byId("subdlg").open, false);
    assert.deepEqual(p.submits, [{ acknowledge: ["req-r0"] }]);
  });
});

// Small transitions. A leaving part fades out for about 140 ms before it hides; under reduced motion it hides at once.
describe("motion", () => {
  it("with motion, the fail note and the bar fade out first: still shown, marked leaving, hidden a moment later", async () => {
    const p = await boot({ reduced: false });
    await p.press("f");
    p.byId("vnote").fire("keydown", { key: "Escape" });
    assert.equal(p.byId("pcomp").hidden, false);
    assert.match(p.byId("pcomp").className, /\bleaving\b/);
    await p.settle();
    assert.equal(p.byId("pcomp").hidden, true);
  });

  it("under reduced motion the fail note, the bar and the sticky-note composer hide at once, with no leaving step", async () => {
    const p = await boot({ reduced: true });
    await p.press("f");
    p.byId("vnote").fire("keydown", { key: "Escape" });
    assert.equal(p.byId("pcomp").hidden, true);
    await p.press("p");
    p.expire();
    assert.equal(p.byId("toast").hidden, true);
    p.byId("pbnote").click();
    assert.equal(p.byId("ncomp").hidden, false);
    p.byId("nno").click();
    assert.equal(p.byId("ncomp").hidden, true);
    for (const id of ["pcomp", "toast", "ncomp"]) assert.doesNotMatch(p.byId(id).className, /leaving/);
  });

  it("the stylesheet turns every animation and transition off under reduced motion, in its last rule", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css.trimEnd(), /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important;transition:none!important\}\}$/);
    assert.equal((css.match(/prefers-reduced-motion/g) ?? []).length, 1);
  });
});

describe("Fail on a header always lands; a live poll keeps the fail note", () => {
  it("Pass the header, then Fail it: every file is failed with the note, one POST each, Fail pressed, Pass not", async () => {
    const p = await boot({ hash: "#2" });
    assert.equal(p.on(), "hdr");
    await p.press("p");
    assert.deepEqual(p.posts.map((x) => [x.stop, x.status]), [["chg-b", "passed"], ["chg-c", "passed"]]);
    await p.press("ArrowLeft"); await p.press("ArrowLeft"); await p.press("ArrowLeft");
    assert.equal(p.on(), "hdr");
    assert.equal(p.byId("pbpass").attrs["aria-pressed"], "true");
    p.posts.length = 0;
    await p.press("f");
    p.byId("vnote").value = "Both are wrong.";
    p.byId("vfailgo").click(); await p.settle();
    assert.deepEqual(p.posts, [{ stop: "chg-b", status: "failed", note: "Both are wrong." }, { stop: "chg-c", status: "failed", note: "Both are wrong." }]);
    assert.equal(p.byId("pbfail").attrs["aria-pressed"], "true");
    assert.equal(p.byId("pbpass").attrs["aria-pressed"], "false");
    assert.deepEqual([p.stops["chg-b"]!.status, p.stops["chg-c"]!.status], ["failed", "failed"]);
  });

  it("a header Fail never rewrites a file's own fail and never touches files outside the header", async () => {
    const p = await boot({ verdicts: { a: ["passed"], b: ["failed", "own note"], c: ["passed"], d: ["passed"] }, hash: "#2" });
    assert.equal(p.on(), "hdr");
    await p.press("f");
    p.byId("vnote").value = "Header note.";
    p.byId("vfailgo").click(); await p.settle();
    assert.deepEqual(p.posts, [{ stop: "chg-c", status: "failed", note: "Header note." }], "only c, the one file not already failed");
    assert.deepEqual([p.stops["chg-a"]!.status, p.stops["chg-d"]!.status], ["passed", "passed"]);
    assert.equal(p.stops["chg-b"]!.note, "own note");
  });

  it("a header Pass never turns a failed file passed", async () => {
    const p = await boot({ verdicts: { b: ["failed", "own note"] }, hash: "#2" });
    assert.equal(p.on(), "hdr");
    await p.press("p");
    assert.deepEqual(p.posts, [{ stop: "chg-c", status: "passed", note: "" }]);
    assert.equal(p.stops["chg-b"]!.status, "failed");
  });

  it("a header Pass with nothing to change says so in the verdict message line and posts nothing", async () => {
    const p = await boot({ verdicts: { b: ["failed", "own note"], c: ["passed"] }, hash: "#2" });
    assert.equal(p.on(), "hdr");
    assert.equal(p.byId("pbpass").attrs["aria-pressed"], "false");
    await p.press("p");
    assert.deepEqual(p.posts, []);
    assert.match(p.byId("vmsg").textContent, /nothing to pass/i);
  });

  it("while the fail note is open, a live poll keeps the box open and the typed note intact", async () => {
    const p = await boot({ live: true, hash: "#1" });
    assert.equal(p.on(), "chg-a");
    await p.press("f");
    assert.equal(p.byId("pcomp").hidden, false);
    p.byId("vnote").value = "Half-typed note";
    await p.poll();
    assert.equal(p.byId("pcomp").hidden, false, "the box stays open");
    assert.equal(p.byId("vnote").value, "Half-typed note");
  });

  it("a live poll still closes a fail note that was left open on another step", async () => {
    const p = await boot({ live: true, hash: "#1" });
    await p.press("f");
    p.byId("vnote").value = "stale";
    await p.press("Escape", { tagName: "BODY" });
    p.byId("vfailno").click(); await p.settle(); await p.settle();
    await p.poll();
    assert.equal(p.byId("pcomp").hidden, true);
  });
});

describe("the fail count and Send back skip a fail on a replaced file version", () => {
  const TITLE = "Fail a change or write a note to send the work back.";
  it("one fail on a replaced state and no note: count hidden, Send back disabled with its title, the step still shows failed", async () => {
    const p = await boot({ verdicts: { a: ["failed", "old"] }, superseded: ["chg-a"], hash: "#1" });
    assert.equal(p.on(), "chg-a");
    assert.equal(p.byId("failcount").hidden, true);
    assert.equal(p.byId("sendback").disabled, true);
    assert.equal(p.byId("sendback").title, TITLE);
    assert.equal(p.byId("pbfail").attrs["aria-pressed"], "true", "history is not hidden");
  });

  it("a fail on the current state is counted and enables Send back", async () => {
    const p = await boot({ verdicts: { a: ["failed", "bad"] }, hash: "#1" });
    assert.equal(p.byId("failcount").hidden, false);
    assert.equal(p.byId("failcount").textContent, "1");
    assert.equal(p.byId("sendback").disabled, false);
    assert.equal(p.byId("sendback").title, "");
  });

  it("a replaced fail beside a current fail leaves the count at the current one and Send back enabled", async () => {
    const p = await boot({ verdicts: { a: ["failed", "old"], d: ["failed", "bad"] }, superseded: ["chg-a"], hash: "#1" });
    assert.equal(p.byId("failcount").textContent, "1");
    assert.equal(p.byId("sendback").disabled, false);
  });

  it("with only a replaced fail, a note still enables Send back", async () => {
    const p = await boot({ verdicts: { a: ["failed", "old"] }, superseded: ["chg-a"], hash: "#1", notes: [{ id: 1, text: "Redo the totals.", ts: 1, regionId: null, region: null, where: "", picture: false }] });
    await p.settle();
    assert.equal(p.byId("sendback").disabled, false);
  });
});

// The bar's Pass/Fail click toggles off only when every covered file already holds that verdict (the earlier rule), not when the
// bar's displayed pressed state (any failed => Fail pressed) says so. Must not happen: a click that clears a verdict the user did not ask to clear.
describe("bar Pass/Fail clicks on a header over mixed verdicts", () => {
  type V = Record<string, ["passed" | "failed", string?]>;
  const mixes: Array<{ name: string; v: V; passPosts: Array<[string, string]>; failOpens: boolean; failPosts: Array<[string, string]> }> = [
    { name: "none judged", v: {}, passPosts: [["chg-b", "passed"], ["chg-c", "passed"]], failOpens: true, failPosts: [] },
    { name: "all passed", v: { b: ["passed"], c: ["passed"] }, passPosts: [["chg-b", "not_reviewed"], ["chg-c", "not_reviewed"]], failOpens: true, failPosts: [] },
    { name: "all failed", v: { b: ["failed", "n1"], c: ["failed", "n2"] }, passPosts: [], failOpens: false, failPosts: [["chg-b", "not_reviewed"], ["chg-c", "not_reviewed"]] },
    { name: "one failed one passed", v: { b: ["failed", "own note"], c: ["passed"] }, passPosts: [], failOpens: true, failPosts: [] },
    { name: "one passed one unjudged", v: { b: ["passed"] }, passPosts: [["chg-c", "passed"]], failOpens: true, failPosts: [] },
    { name: "one failed one unjudged", v: { b: ["failed", "own note"] }, passPosts: [["chg-c", "passed"]], failOpens: true, failPosts: [] },
  ];
  for (const m of mixes) {
    it(`header, ${m.name}: Pass click`, async () => {
      const p = await boot({ verdicts: m.v, hash: "#2" });
      assert.equal(p.on(), "hdr");
      p.byId("pbpass").click(); await p.settle();
      assert.deepEqual(p.posts.map((x) => [x.stop, x.status]), m.passPosts);
    });
    it(`header, ${m.name}: Fail click`, async () => {
      const p = await boot({ verdicts: m.v, hash: "#2" });
      assert.equal(p.on(), "hdr");
      p.byId("pbfail").click(); await p.settle();
      assert.deepEqual(p.posts.map((x) => [x.stop, x.status]), m.failPosts);
      assert.equal(p.byId("pcomp").hidden, !m.failOpens, "the fail note opens unless the click clears");
    });
    it(`header, ${m.name}: P key posts what the Pass click posts when the click does not clear; F key opens the note`, async () => {
      const p = await boot({ verdicts: m.v, hash: "#2" });
      await p.press("p");
      const allPassed = m.v.b?.[0] === "passed" && m.v.c?.[0] === "passed";
      if (!allPassed) assert.deepEqual(p.posts.map((x) => [x.stop, x.status]), m.passPosts);
      const q = await boot({ verdicts: m.v, hash: "#2" });
      await q.press("f");
      assert.equal(q.byId("pcomp").hidden, false);
      assert.deepEqual(q.posts, []);
    });
  }
  it("single file: Pass click passes and, on a passed file, clears; Fail click opens the note and, on a failed file, clears", async () => {
    const p = await boot({ hash: "#3" });
    assert.equal(p.on(), "chg-b");
    p.byId("pbpass").click(); await p.settle();
    assert.deepEqual(p.posts.map((x) => [x.stop, x.status]), [["chg-b", "passed"]]);
    const p2 = await boot({ verdicts: { b: ["passed"] }, hash: "#3" });
    p2.byId("pbpass").click(); await p2.settle();
    assert.deepEqual(p2.posts.map((x) => [x.stop, x.status]), [["chg-b", "not_reviewed"]]);
    const q = await boot({ hash: "#3" });
    q.byId("pbfail").click(); await q.settle();
    assert.equal(q.byId("pcomp").hidden, false);
    assert.deepEqual(q.posts, []);
    const r = await boot({ verdicts: { b: ["failed", "x"] }, hash: "#3" });
    r.byId("pbfail").click(); await r.settle();
    assert.deepEqual(r.posts.map((x) => [x.stop, x.status]), [["chg-b", "not_reviewed"]]);
  });
});
