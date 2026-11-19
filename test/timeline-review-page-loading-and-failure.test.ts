import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// The review page code run as is in a vm with a small DOM stub: the loading state before the model arrives, and what a failed
// picture says. Synthetic timeline; the "server" is a function.

const SHA = "a".repeat(64);
const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
function change(id: string, file: string, secret = false): Change {
  return { id, file, outside: false, at: null, kind: "modified", step: 1, before: ref(SHA), after: ref("b".repeat(64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}`, ...(secret ? { secret: true } : {}) } } as unknown as Change;
}
const request = (id: string, index: number, text: string, changes: Change[]) => ({
  id, index, session: "s", texts: [{ text, source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: `run-${id}`, rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [],
    calls: [{ id: `call-${id}`, index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: "t", source: "agent-description", label: "l" } }] }],
});
const timeline = (reqs: unknown[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: reqs }) as unknown as Timeline;

interface Node { textContent: string; hidden: boolean; children: unknown[]; [k: string]: unknown }
function makePage(model: unknown, fetchImpl: (u: string) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  const nodes = new Map<string, Node>();
  const make = (): Node => {
    let text = "";
    const base: Node = {
      children: [], hidden: false,
      get textContent() { return text; },
      set textContent(v: string) { text = v; (this as unknown as Node).children = []; },
      append(...c: unknown[]) { (this as unknown as Node).children.push(...c); },
      classList: { toggle: () => false, add() {}, remove() {}, contains: () => false },
      style: { setProperty() {} }, dataset: {},
      getAttribute: () => null,
    } as unknown as Node;
    return new Proxy(base, { get: (t, k) => (k in t ? (t as unknown as Record<PropertyKey, unknown>)[k] : typeof k === "string" ? () => make() : undefined), set: (t, k, v) => { (t as unknown as Record<PropertyKey, unknown>)[k] = v; return true; } });
  };
  const byId = (id: string): Node => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const body = make();
  body.getAttribute = (() => "7") as never;
  const document = {
    body, getElementById: byId, createElement: () => make(), createElementNS: () => make(), createTextNode: (t: string) => ({ nodeType: 3, textContent: t }),
    querySelectorAll: () => [], getElementById_: byId, fonts: undefined,
  };
  const g: Record<string, unknown> = {
    document, location: { search: "?t=tok", hash: "#1" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams,
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval, clearInterval, console,
    fetch: (u: string) => fetchImpl(u),
    ...extra,
  };
  g.window = g; g.globalThis = g;
  return { g, byId, handlers, nodes };
}

async function boot(tl: Timeline, views: (u: string) => Promise<unknown>, opts: { model?: Promise<unknown>; extra?: Record<string, unknown> } = {}) {
  const model = JSON.parse(JSON.stringify(buildRailModel(tl)));
  const page = makePage(model, (u) => (u.includes("/review/model") ? (opts.model ?? Promise.resolve({ ok: true, json: async () => model })) : views(u)), opts.extra);
  const ctx = vm.createContext(page.g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  const key = async (k: string) => { page.handlers.keydown!({ key: k, target: { tagName: "BODY" }, preventDefault() {} }); await settle(); };
  return { model, ...page, key, settle };
}


const all = (n: unknown): string => {
  if (typeof n !== "object" || n === null) return "";
  const o = n as Node;
  return (o.textContent ?? "") + (o.children ?? []).map(all).join(" | ");
};
const ok = (v: unknown) => ({ ok: true, status: 200, json: async () => v });
const bad = (status: number) => ({ ok: false, status, json: async () => ({}) });
const tl = timeline([request("r0", 0, "Do it", [change("c1", "a.txt")])]);
const goodView = (key: string) => ({ change: key, file: "a.txt", engine: "drawn by CoCheck from the cells, not by Excel", kind: "diff", before: [{ id: "p", label: "Sheet1", text: { lines: [{ n: 1, text: "old text", box: null }] } }], after: [{ id: "p", label: "Sheet1", text: { lines: [{ n: 1, text: "new text", box: null }] } }], boxes: [], caveats: [] });
const REAL = /\/view\//;
// No start stop; the page opens on the change, the first step that needs a verdict. Nothing to press to reach it.
const toChange = async (p: Awaited<ReturnType<typeof boot>>) => { await p.settle(); };
const shown = (p: Awaited<ReturnType<typeof boot>>) => ["h1", "h2", "caveats", "vb", "va", "eb", "ea", "tb", "ta", "notes"].map((id) => all(p.byId(id))).join(" || ");

describe("the page says it is reading the work until the model arrives", () => {
  it("shows the loading widget named 'Reading the work' with the elapsed seconds beside it, then the first moment", async () => {
    let now = 1_000_000; let tick: (() => void) | null = null;
    let release!: (v: unknown) => void;
    const model = new Promise((r) => { release = r; });
    const p = await boot(tl, async () => bad(404), { model, extra: { Date: { now: () => now }, setInterval: (f: () => void) => { tick = f; return 1; }, clearInterval: () => { tick = null; } } });
    assert.match(all(p.byId("h1")), /Reading the work/);
    assert.match(all(p.byId("h1")), /\b0 s$/);
    now += 7400; tick!();
    assert.match(all(p.byId("h1")), /\b7 s$/);
    release(ok(p.model));
    await p.settle();
    assert.equal(tick, null, "the timer stops when the model arrives");
    assert.doesNotMatch(all(p.byId("h1")), /Reading the work/);
  });

  it("while a moment's view is loading, both panes show the loading widget naming their side", async () => {
    const p = await boot(tl, () => new Promise(() => {}));
    await toChange(p);
    assert.match(all(p.byId("vb")), /Loading the before picture/);
    assert.match(all(p.byId("va")), /Loading the after picture/);
  });
});

