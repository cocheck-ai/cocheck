import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asServed } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// Connector image pictures that carry page numbers (v1 picture field `page`) draw as scrolled pages, the way Word and PowerPoint pictures do, from the
// document alone: no connector id, no file ending. The picture is still asked for at its cpic/<sha> address, never a pdfpage one. A connector picture with
// no page, or a document mixing paged and unpaged pictures, keeps the tabs. Harness: the vm page of test/timeline-loading-widget.test.ts.

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
  const timers: Array<() => void> = [], delays: number[] = [], asked: string[] = [];
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
    addEventListener() {}, setInterval: () => 1, clearInterval() {}, setTimeout: (f: () => void, ms?: number) => { timers.push(f); delays.push(ms ?? 0); return timers.length; }, clearTimeout() {},
    fetch: async (u: string) => {
      asked.push(u);
      const v = await answer(u);
      if (v instanceof Error) throw v;
      if (v && typeof v === "object" && "__status" in v) return { ok: false, status: (v as { __status: number }).__status, headers: { get: () => null }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(asServed(v))) };
    },
  };
  g.window = g; g.globalThis = g;
  return { g, byId, timers, delays, asked, nodes };
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
const S1 = "1".repeat(64), S2 = "2".repeat(64), S3 = "3".repeat(64);
const img = (id: string, side: "before" | "after", sha: string, page?: number) => ({ id, side, type: "image", label: `${side} page ${page ?? "?"}`, src: `cpic/${sha}`, width: 100, height: 140, ...(page === undefined ? {} : { page, pageCount: 2 }) });
const docOf = (pictures: unknown[]) => ({ spec: "cocheck.changes/1", source: { by: "connector", name: "toy-pages", level: 2 }, pictures, changes: [{ id: "c1", mark: "changed", label: "page 2 text" }], caveats: [] });
const PAGED = docOf([img("b1", "before", S1, 1), img("a1", "after", S2, 1), img("a2", "after", S3, 2)]);
const tree2 = (n: Node): Node[] => (n && typeof n === "object" && Array.isArray(n.children) ? n.children.flatMap((c) => (c && typeof c === "object" && "className" in c ? [c, ...tree2(c)] : [])) : []);
const all = (nodes: Map<string, Node>): Node[] => [...nodes.values()].flatMap((n) => [n, ...tree2(n)]);

describe("connector pictures with page numbers draw as pages", () => {
  it("sceneOf: a cpic picture with page carries it into the pane (still a cpic picture), and a document of paged pictures is kind 'pages'", async () => {
    const ctx = vm.createContext({ console });
    vm.runInContext(await readFile(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url), "utf8"), ctx);
    const VT = (ctx as { CoCheckViewTable: { sceneOf(d: unknown): { kind: string; before: Array<{ picture?: Record<string, unknown> }>; after: Array<{ picture?: Record<string, unknown> }> } } }).CoCheckViewTable;
    const s = VT.sceneOf(JSON.parse(JSON.stringify(PAGED)));
    assert.equal(s.kind, "pages");
    assert.deepEqual(JSON.parse(JSON.stringify(s.after.map((p) => p.picture))), [{ sha: S2, width: 100, height: 140, cpic: true, page: 1, pageCount: 2 }, { sha: S3, width: 100, height: 140, cpic: true, page: 2, pageCount: 2 }]);
    // an absent stand-in (no src) beside paged pictures is still pages
    assert.equal(VT.sceneOf(docOf([{ id: "b2", side: "before", type: "image", absent: true }, img("a1", "after", S2, 1), img("a2", "after", S3, 2)])).kind, "pages");
    // no page, or a mix: tabs as before
    assert.equal(VT.sceneOf(docOf([img("b1", "before", S1), img("a1", "after", S2)])).kind, "card");
    assert.equal(VT.sceneOf(docOf([img("b1", "before", S1, 1), img("a1", "after", S2)])).kind, "card");
    // a document that names its own kind keeps it
    assert.equal(VT.sceneOf({ ...JSON.parse(JSON.stringify(PAGED)), kind: "diff" }).kind, "diff");
  });

  it("the page draws them as scrolled pages with data-page, each image at its cpic address", async () => {
    const p = await boot((u) => (u.includes("/review/model") ? baseModel() : u.includes("/view/") ? PAGED : {}));
    const nodes = all(p.nodes);
    const wraps = nodes.filter((n) => n.className.split(/\s+/).includes("pagewrap"));
    assert.ok(nodes.some((n) => n.className.split(/\s+/).includes("pscroll")), "a scrolled page column");
    assert.deepEqual(wraps.map((w) => w.attrs["data-page"]).sort(), ["1", "1", "2"]);
    const srcs = nodes.filter((n) => n.tag === "img").map((n) => n.attrs.src ?? "");
    for (const sha of [S1, S2, S3]) assert.ok(srcs.some((s) => s.includes(`/cpic/${sha}`)), `${sha.slice(0, 4)} asked at cpic: ${srcs.join(" ")}`);
    assert.ok(!srcs.some((s) => s.includes("/pdfpage/")), "never a pdfpage address");
  });
});
