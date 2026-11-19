import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asServed, served } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import { PENDING_SCRIPT, renderGenericPage } from "../src/timeline/page.ts";
import { LOADING_CSS, LOADING_MOTION_CSS, loadingHtml } from "../src/timeline/loading.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// one CoCheck loading widget for every place that is still waiting. The page code runs as is in a vm with a DOM stub that keeps
// classes, attributes and children; the "server" is a function and every timer waits for the test to fire it. Guarded against: a state
// that has finished or failed never keeps the widget, and a screen reader always gets the state in words (the widget's own label included).

const SHA = "a".repeat(64);
const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
function change(id: string, file: string, generic: Record<string, unknown> = { tier: "fingerprint", label: `label of ${id}` }): Change {
  return { id, file, outside: false, at: null, kind: "modified", step: 1, before: ref(SHA), after: ref("b".repeat(64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic } as unknown as Change;
}
const request = (id: string, index: number, text: string, changes: Change[]) => ({
  id, index, session: "s", texts: [{ text, source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: `run-${id}`, rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [],
    calls: [{ id: `call-${id}`, index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: "t", source: "agent-description", label: "l" } }] }],
});
const timeline = (reqs: unknown[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: reqs }) as unknown as Timeline;
const TL = timeline([request("r0", 0, "Do it", [change("c1", "a.txt")])]);
const baseModel = () => JSON.parse(JSON.stringify(buildRailModel(TL)));

interface Node { tag: string; className: string; attrs: Record<string, string>; children: Node[]; hidden: boolean; textContent: string; [k: string]: unknown }
function makePage(answer: (u: string) => unknown, hash: string) {
  const nodes = new Map<string, Node>();
  const timers: Array<() => void> = [];
  const make = (tag: string): Node => {
    let text = "";
    const base = {
      tag, className: "", attrs: {} as Record<string, string>, children: [] as unknown[], hidden: false, nodeType: 1, dataset: {}, style: { setProperty() {}, removeProperty() {} },
      get textContent(): string { return text + (this.children as Node[]).map((c) => (c && typeof c === "object" ? c.textContent : "")).join(""); },
      set textContent(v: string) { text = v; this.children = []; },
      append(...c: unknown[]) { (this.children as unknown[]).push(...c); },
      setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); },
      getAttribute(k: string) { return this.attrs[k] ?? null; },
      get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; },
    };
    return new Proxy(base, { get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : typeof k === "string" ? () => make("div") : undefined), set: (t, k, v) => { (t as Record<PropertyKey, unknown>)[k] = v; return true; } }) as unknown as Node;
  };
  const byId = (id: string): Node => { if (!nodes.has(id)) nodes.set(id, make("div")); return nodes.get(id)!; };
  const body = make("body"); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => make(t), createElementNS: (_: string, t: string) => make(t), createTextNode: (t: string) => ({ nodeType: 3, textContent: t, children: [] }), querySelectorAll: () => [], addEventListener() {} };
  const g: Record<string, unknown> = {
    document, location: { search: "?t=tok", hash }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
    addEventListener() {}, setInterval: () => 1, clearInterval() {}, setTimeout: (f: () => void) => { timers.push(f); return timers.length; }, clearTimeout() {},
    fetch: async (u: string) => {
      const v = await answer(u);
      if (v instanceof Error) throw v;
      if (v && typeof v === "object" && "__status" in v) return { ok: false, status: (v as { __status: number }).__status, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(asServed(v))) };
    },
  };
  g.window = g; g.globalThis = g;
  return { g, byId, timers };
}
const settle = () => new Promise((r) => setTimeout(r, 15));
async function boot(answer: (u: string) => unknown, hash = "#1") {
  const page = makePage(answer, hash);
  const ctx = vm.createContext(page.g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await settle();
  /* fire every timer queued so far (not the ones they queue), then let the answers land */
  const tick = async () => { const fs = page.timers.splice(0); for (const f of fs) f(); await settle(); };
  return { ...page, tick };
}
const tree = (n: Node): Node[] => (n && typeof n === "object" && Array.isArray(n.children) ? n.children.flatMap((c) => (c && typeof c === "object" && "className" in c ? [c, ...tree(c)] : [])) : []);
/** every widget under a node, as its label */
const widgets = (n: Node): string[] => tree(n).filter((c) => c.className.split(/\s+/).includes("iload")).map((c) => {
  assert.equal(c.attrs.role, "status", "the widget is a status region");
  const sr = tree(c).find((x) => x.className === "iload-sr");
  assert.ok(sr && sr.textContent.trim() !== "", "the widget carries its label in words");
  return sr!.textContent;
});
const viewOf = (u: string) => decodeURIComponent(u.split("/view/")[1]!.split("?")[0]!);
const pendingView = (key: string) => ({ change: key, file: "a.txt", engine: "your browser, from the stored file", kind: "card", before: [], after: [], boxes: [], caveats: [], pending: true });
const goodView = (key: string) => ({ change: key, file: "a.txt", engine: "drawn by CoCheck", kind: "diff", before: [{ id: "p", label: "Sheet1", text: { lines: [{ n: 1, text: "old text", box: null }] } }], after: [{ id: "p", label: "Sheet1", text: { lines: [{ n: 1, text: "new text", box: null }] } }], boxes: [], caveats: [] });

describe("the widget itself", () => {
  it("the page script's builder and the server's builder make the same markup", async () => {
    const ctx = vm.createContext({});
    vm.runInContext(await readFile(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url), "utf8"), ctx);
    const html = (tag: string, attrs: Record<string, string> = {}, ...kids: string[]) => `<${tag}${Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join("")}>${kids.join("")}</${tag}>`;
    const fromScript = (ctx as { CoCheckViewTable: { loader(make: typeof html, label: string): string } }).CoCheckViewTable.loader(html, "Drawing the after picture");
    assert.equal(fromScript, loadingHtml("Drawing the after picture"));
    assert.match(loadingHtml("a <b>"), /title="a &lt;b&gt;"/);
  });

  it("review.css carries the widget's rules verbatim, and the icon holds still under reduced motion on both pages", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.ok(css.includes(LOADING_CSS), "review.css lost or changed the widget rules");
    // the review page's last rule turns every animation off; the older page carries its own rule for the icon
    assert.match(css.trimEnd(), /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important;transition:none!important\}\}$/);
    assert.equal(LOADING_MOTION_CSS, "@media (prefers-reduced-motion:reduce){.iload-mark *{animation:none!important}}");
    assert.ok(renderGenericPage(TL, "tok").includes(LOADING_MOTION_CSS));
    // with animation off the icon rests at its own pose (test/timeline-loader-motion.test.ts checks that pose against cocheck-icon.svg)
    assert.match(LOADING_CSS, /\.ild-p\{transform:translate\(54\.7px,52\.7px\)\}\n\.ild-s\{transform:scale\(\.7\)\}/);
  });

  it("the shell's heading is the widget, named, before the script runs", () => {
    const shell = renderReviewShell(7);
    assert.ok(shell.includes(`<h1 id="h1">${loadingHtml("Reading the work")}</h1>`));
    assert.doesNotMatch(shell, /Reading the work\.\.\./);
  });
});

describe("the review page waits with the widget, and drops it when the wait ends", () => {
  it("before the model: the heading is the widget, then the first moment replaces it", async () => {
    let release!: (v: unknown) => void;
    const model = new Promise((r) => { release = r; });
    const p = await boot((u) => (u.includes("/review/model") ? model : new Promise(() => {})));
    assert.deepEqual(widgets(p.byId("h1")), ["Reading the work"]);
    release(baseModel()); await settle();
    assert.deepEqual(widgets(p.byId("h1")), [], "the heading kept the widget after the model came");
  });

  it("while a moment's view loads, each pane is the widget naming its side", async () => {
    const p = await boot((u) => (u.includes("/review/model") ? baseModel() : u.includes("/view/") ? new Promise(() => {}) : {}));
    assert.deepEqual(widgets(p.byId("vb")), ["Loading the before picture"]);
    assert.deepEqual(widgets(p.byId("va")), ["Loading the after picture"]);
    assert.doesNotMatch(p.byId("vb").textContent + p.byId("va").textContent, /Loading the pictures\./);
  });

  it("a picture still being drawn is the widget, not 'no picture' words; the finished picture replaces it", async () => {
    let done = false;
    const p = await boot((u) => (u.includes("/review/model") ? baseModel() : u.includes("/view/") ? (done ? goodView(viewOf(u)) : pendingView(viewOf(u))) : {}));
    assert.deepEqual(widgets(p.byId("va")), ["Drawing the after picture"]);
    assert.deepEqual(widgets(p.byId("vb")), ["Drawing the before picture"]);
    assert.doesNotMatch(p.byId("va").textContent, /no picture/);
    done = true; await p.tick();
    assert.deepEqual(widgets(p.byId("va")), []);
    assert.match(p.byId("va").textContent, /new text/);
  });

  it("a picture that never finishes ends in words, never a stuck widget", async () => {
    const p = await boot((u) => (u.includes("/review/model") ? baseModel() : u.includes("/view/") ? pendingView(viewOf(u)) : {}));
    for (let i = 0; i < 20 && p.timers.length; i++) await p.tick();
    assert.deepEqual(widgets(p.byId("va")), [], "the pane still shows the widget after the page stopped asking");
    assert.match(p.byId("va").textContent, /Reload the page/);
  });

  it("a live task with no step yet is the widget; a lost connection ends in words", async () => {
    let fail = false;
    const p = await boot((u) => (u.includes("/review/model") ? (fail ? new Error("down") : { stops: [], live: true }) : {}));
    assert.deepEqual(widgets(p.byId("h1")), ["Waiting for the first step"]);
    fail = true;
    for (let i = 0; i < 40 && p.timers.length; i++) await p.tick();
    assert.deepEqual(widgets(p.byId("h1")), [], "the heading still waits after the page gave up");
    assert.notEqual(p.byId("h1").textContent.trim(), "");
  });

  it("an older server that still sends the retired model-verdict fields draws no verdict widget or words in the file list", async () => {
    const p = await boot((u) => (u.includes("/review/model") ? { ...baseModel(), live: true, modelVerdicts: true } : u.includes("/verdicts") ? { enabled: true, verdicts: {}, failed: [], unavailable: false, pending: true } : u.includes("/view/") ? goodView(viewOf(u)) : {}), "");
    await p.tick(); await p.tick();
    assert.deepEqual(widgets(p.byId("fileslist")), []);
    assert.doesNotMatch(p.byId("fileslist").textContent, /verdict/i);
  });
});

describe("no loading words outlive the wait", () => {
  const STILL = "The preview of this change is still running.";
  const pendingChange = () => change("c1", "pic.dat", { tier: "fingerprint", label: STILL, pending: true, fingerprint: { before: null, after: null, kind: "file", note: "the preview is still being drawn; reload in a moment." } });
  const words = (p: { byId(id: string): Node }) => ["notes", "va", "vb", "h2", "caveats"].map((id) => p.byId(id).textContent).join(" | ");

  it("a pending preview's still-running label is never a note, before or after the picture is drawn", async () => {
    const m = JSON.parse(JSON.stringify(buildRailModel(timeline([request("r0", 0, "Do it", [pendingChange()])]))));
    const stop = m.stops.find((x: { change?: unknown }) => x.change);
    assert.doesNotMatch(String(stop.change.note), /still running/, "the model carries the loading words as the change's note");
    let done = false;
    const p = await boot((u) => (u.includes("/review/model") ? m : u.includes("/view/") ? (done ? goodView(viewOf(u)) : pendingView(viewOf(u))) : {}));
    assert.deepEqual(widgets(p.byId("va")), ["Drawing the after picture"]);
    assert.doesNotMatch(words(p), /still running/);
    done = true; await p.tick();
    assert.match(p.byId("va").textContent, /new text/);
    assert.doesNotMatch(words(p), /still running/, "the loading words stayed after the picture was drawn");
  });
});

describe("the older timeline page", () => {
  const pendingTl = timeline([request("r0", 0, "Do it", [change("c1", "pic.dat", { tier: "fingerprint", label: "The preview of this change is still running.", pending: true, fingerprint: { before: null, after: null, kind: "file", note: "the preview is still being drawn; reload in a moment." } })])]);

  it("a preview still being drawn is the widget, not the still-running words", () => {
    const html = renderGenericPage(pendingTl, "tok");
    assert.ok(html.includes(loadingHtml("Drawing the preview of this change")));
    assert.doesNotMatch(html.replace(/<script>[\s\S]*?<\/script>/g, ""), /still being drawn|still running/, "the card still says it in words");
    assert.ok(html.includes(".iload-mark"), "the page carries the widget's styles");
  });

  it("when the page stops asking, a widget left on a card becomes words", async () => {
    const swapped: string[] = [];
    const widget = { replaceWith: (n: { textContent: string }) => { swapped.push(n.textContent); } };
    const ctx = vm.createContext({
      location: { href: "http://127.0.0.1:1/timeline/1/page?t=tok" },
      document: {
        querySelector: () => ({ id: "c1" }),
        querySelectorAll: (sel: string) => (sel.includes(".iload") ? (swapped.length ? [] : [widget]) : [{ id: "c1", replaceWith() {} }]),
        importNode: (n: unknown) => n,
        createElement: () => ({ className: "", textContent: "" }),
      },
      DOMParser: class { parseFromString() { return { getElementById: () => ({ hasAttribute: () => true }) }; } },
      fetch: async () => ({ text: async () => "<html></html>" }),
      setTimeout: (f: () => void) => setTimeout(f, 0),
    });
    vm.runInContext(PENDING_SCRIPT, ctx);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(swapped.length, 1, "the widget stayed after the last ask");
    assert.match(swapped[0]!, /Reload the page/);
  });
});
