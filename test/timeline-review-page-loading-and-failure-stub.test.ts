import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asServed, served } from "./helpers/v1-served.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// The review page code run as is in a vm with a small DOM stub: the loading state before the model arrives, and what a failed
// picture says. Synthetic timeline; the "server" is a function.

const SHA = "a".repeat(64);
const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
function change(id: string, file: string, secret = false, kind = "modified"): Change {
  return { id, file, outside: false, at: null, kind, step: 1, before: ref(SHA), after: ref("b".repeat(64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}`, ...(secret ? { secret: true } : {}) } } as unknown as Change;
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
const ok = (v: unknown) => ({ ok: true, status: 200, json: async () => asServed(v) });
const bad = (status: number) => ({ ok: false, status, json: async () => ({}) });
const tl = timeline([request("r0", 0, "Do it", [change("c1", "a.txt")])]);
const goodView = (key: string) => ({ change: key, file: "a.txt", engine: "drawn by CoCheck from the cells, not by Excel", kind: "diff", before: [{ id: "p", label: "Sheet1", text: { lines: [{ n: 1, text: "old text", box: null }] } }], after: [{ id: "p", label: "Sheet1", text: { lines: [{ n: 1, text: "new text", box: null }] } }], boxes: [], caveats: [] });
const REAL = /\/view\//;
// No start stop; the page opens on the change, the first step that needs a verdict. Nothing to press to reach it.
const toChange = async (p: Awaited<ReturnType<typeof boot>>) => { await p.settle(); };
const shown = (p: Awaited<ReturnType<typeof boot>>) => ["h1", "h2", "caveats", "vb", "va", "eb", "ea", "tb", "ta", "notes"].map((id) => all(p.byId(id))).join(" || ");

// The page also asks the status route at boot; only the view route's calls are counted.
const VIEW = /\/view\//;
describe("a failed picture says what happened", () => {
  it("a network error reads 'cannot be reached', is tried twice, and leaves no bare 'CoCheck.' caption", async () => {
    let calls = 0;
    const p = await boot(tl, async (u) => { if (!VIEW.test(u)) return bad(404); calls++; throw new TypeError("Failed to fetch"); });
    await toChange(p);
    assert.equal(calls, 2);
    assert.match(all(p.byId("va")), /server cannot be reached/);
    assert.doesNotMatch(shown(p), /CoCheck\./);
    assert.equal(p.byId("eb").textContent, ""); assert.equal(p.byId("ea").textContent, "");
  });

  it("an error status reads with the status it returned", async () => {
    let calls = 0;
    const p = await boot(tl, async (u) => { if (!VIEW.test(u)) return bad(404); calls++; return bad(500); });
    await toChange(p);
    assert.equal(calls, 2);
    assert.match(all(p.byId("va")), /server answered 500/);
    assert.doesNotMatch(shown(p), /CoCheck\./);
  });

  it("a view that fails once and then answers is drawn from the retry", async () => {
    let calls = 0;
    const p = await boot(tl, async (u) => { if (!VIEW.test(u)) return bad(404); calls++; return calls === 1 ? bad(503) : ok(goodView("c1")); });
    await toChange(p);
    assert.equal(calls, 2);
    assert.match(all(p.byId("vb")), /old text/);
    assert.match(all(p.byId("va")), /new text/);
    assert.doesNotMatch(all(p.byId("caveats")), /not available/);
  });

  it("a failure is not remembered: stepping away and back asks again and draws the answer", async () => {
    let up = false; let calls = 0;
    const p = await boot(tl, async () => { calls++; return up ? ok(goodView("c1")) : bad(500); }, { extra: { setTimeout } });
    await toChange(p);
    assert.match(all(p.byId("va")), /server answered 500/);
    const before = calls;
    up = true;
    await p.key("ArrowLeft"); await p.key("ArrowRight");
    await new Promise((r) => setTimeout(r, 300)); // a step that follows another within 150 ms is asked for once the keys settle
    assert.ok(calls > before, "asked again");
    assert.match(all(p.byId("va")), /new text/);
  });

  it("a view that works renders as before: tabs, text, no engine line, no failure words", async () => {
    const p = await boot(tl, async () => ok(goodView("c1")));
    await toChange(p);
    assert.match(all(p.byId("vb")), /old text/);
    assert.equal(p.byId("engine").textContent, "", "no engine line is drawn");
    assert.match(all(p.byId("tb")), /Sheet1/);
    assert.equal(p.byId("caveats").textContent, "");
    assert.doesNotMatch(shown(p), /cannot be reached|server answered|not available/);
  });
});

describe("a created or deleted file's missing side", () => {
  // one full-width pane (critique F1): the side that did not exist is not drawn, no striped pane and no "There was nothing here yet"
  const created = { ...goodView("c1"), before: [{ id: "before:empty", label: "There was nothing here yet" }] };
  const tlOf = (kind: string) => timeline([request("r0", 0, "Do it", [change("c1", "a.txt", false, kind)])]);
  it("a created file shows its after side alone, labelled New and its name, and never 'There was nothing here yet' or 'Nothing to draw'", async () => {
    const p = await boot(tlOf("created"), async () => ok(created));
    await toChange(p);
    assert.equal(all(p.byId("vb")), "", "the before side draws nothing");
    assert.doesNotMatch(shown(p), /nothing here yet|Nothing to draw/);
    assert.match(all(p.byId("va")), /new text/);
    assert.equal(p.byId("lsa").textContent, "New"); assert.equal(p.byId("lna").textContent, "a.txt");
  });
  it("a deleted file shows its before side alone, labelled Removed", async () => {
    const deleted = { ...goodView("c1"), after: [{ id: "after:empty", label: "There is nothing here now, the file was deleted" }] };
    const p = await boot(tlOf("deleted"), async () => ok(deleted));
    await toChange(p);
    assert.equal(all(p.byId("va")), "");
    assert.doesNotMatch(shown(p), /nothing here now|Nothing to draw/);
    assert.match(all(p.byId("vb")), /old text/);
    assert.equal(p.byId("lsb").textContent, "Removed");
  });
});
