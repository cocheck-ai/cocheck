import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asServed } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// Spaced pendingRetry asks, the page's half: a connector row that said "not ready, ask again" (the view is pending and carries the connector's
// pendingRetry) is asked for every 30 s, well past the ~80 s a picture still being drawn gets, because the server only asks the connector again after a
// doubling gap (30 s to 240 s, about 7.5 minutes for all five asks). A newer waiting answer is drawn when it comes; the frozen answer replaces it.
// Harness: the vm page of test/timeline-loading-widget.test.ts, with each timer's delay and each fetch recorded.

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
const textOf = (n: Node): string => (n && typeof n === "object" ? n.textContent : "");
// the page's words plus the Details panel's notes (fix/notes-panel: a waiting view's caveat is a note there, not words under the panes)
const allText = (p: { nodes: Map<string, Node>; g: Record<string, unknown> }): string => [...p.nodes.values()].map(textOf).join("\n") + "\n" + ((p.g.CoCheckDetails as { entries(): Array<{ text: string }> } | undefined)?.entries() ?? []).map((e) => e.text).join("\n");
const waitingDoc = (n: number) => ({ spec: "cocheck.changes/1", changes: [{ id: "c1", mark: "changed", label: "row 1", before: "a", after: "b" }], caveats: [`Waiting: the connector said it was not ready yet, so CoCheck asks again (asked ${n} of 5 times).`], pending: true, pendingRetry: 2 });
const doneDoc = () => ({ spec: "cocheck.changes/1", changes: [{ id: "c1", mark: "changed", label: "row 1 final", before: "a", after: "c" }], caveats: [] });
const pictureStillDrawing = (key: string) => ({ change: key, file: "a.txt", engine: "your browser, from the stored file", kind: "card", before: [], after: [], boxes: [], caveats: [], pending: true });

describe("spaced pendingRetry asks: the page keeps asking", () => {
  it("a waiting connector view is asked for every 30 s, past the picture wait's 14 asks, and never ends in 'stopped asking' words while it waits", async () => {
    const p = await boot((u) => (u.includes("/review/model") ? baseModel() : u.includes("/view/") ? waitingDoc(1) : {}));
    const views = () => p.asked.filter((u) => u.includes("/view/")).length;
    const first = views();
    for (let i = 0; i < 30; i++) {
      const queued = p.delays.slice(-p.timers.length);
      assert.ok(queued.includes(30_000), `round ${i}: the next ask waits 30 s (queued: ${queued.join(", ")})`);
      await p.tick();
    }
    assert.equal(views() - first, 30);
    assert.doesNotMatch(allText(p), /stopped asking/);
  });

  it("a newer waiting answer is drawn when it comes, and the frozen answer replaces it", async () => {
    let n = 1, done = false;
    const p = await boot((u) => (u.includes("/review/model") ? baseModel() : u.includes("/view/") ? (done ? doneDoc() : waitingDoc(n)) : {}));
    assert.match(allText(p), /asked 1 of 5 times/);
    await p.tick();
    n = 2; await p.tick(); await p.tick();
    assert.match(allText(p), /asked 2 of 5 times/);
    assert.doesNotMatch(allText(p), /asked 1 of 5 times/);
    done = true;
    for (let i = 0; i < 3 && p.timers.length; i++) await p.tick();
    assert.match(allText(p), /row 1 final/);
    assert.doesNotMatch(allText(p), /Waiting:/);
    const views = () => p.asked.filter((u) => u.includes("/view/")).length, after = views();
    for (let i = 0; i < 5; i++) await p.tick();
    assert.equal(views(), after, "no more asks once the answer is frozen");
  });

  it("guarded case kept: a picture still being drawn (pending, no pendingRetry) still stops after its ~80 s and says so", async () => {
    const p = await boot((u) => (u.includes("/review/model") ? baseModel() : u.includes("/view/") ? pictureStillDrawing(viewOf(u)) : {}));
    assert.ok(p.delays.includes(1000));
    for (let i = 0; i < 20 && p.timers.length; i++) await p.tick();
    assert.ok(!p.delays.includes(30_000), "a picture wait never switches to the connector wait");
    assert.match(p.byId("va").textContent, /Reload the page/);
  });
});
