import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// A request stop shows the request itself as the central element. The model is built by the real builder, the page code
// (review.js, view-table.js) is run as is in a vm with a small DOM stub, and the stops are stepped through its own keyboard handler.

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
function makePage(model: unknown, hash = "") {
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
    document, location: { search: "?t=tok", hash }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams,
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval, clearInterval, console,
    fetch: async (u: string) => (u.includes("/review/model") ? { ok: true, json: async () => model } : { ok: false, status: 404, json: async () => ({}) }),
  };
  g.window = g; g.globalThis = g;
  return { g, byId, handlers, nodes };
}

// No start stop, and the page opens on the first change; `hash` (#n) names the step to open on instead, as a URL does.
async function boot(tl: Timeline, hash = "") {
  const model = JSON.parse(JSON.stringify(buildRailModel(tl)));
  const page = makePage(model, hash);
  const ctx = vm.createContext(page.g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  const key = async (k: string) => { page.handlers.keydown!({ key: k, target: { tagName: "BODY" }, preventDefault() {} }); await settle(); };
  return { model, ...page, key, settle };
}

const text = (n: Node): string => n.textContent + n.children.map((c) => (typeof c === "object" && c ? ((c as Node).textContent ?? "") : "")).join("");

describe("model: a request stop is its text", () => {
  const tl = timeline([request("r0", 0, "Fix the totals\n  and the <b>dates</b>", [change("c1", "a.txt")]), request("r1", 1, "Second one", [change("c2", "b.txt")])]);
  it("carries the text verbatim, no side card, and counts requests from 1 whatever the record's index", () => {
    const m = buildRailModel(tl);
    const reqs = m.stops.filter((s) => s.id.startsWith("req-"));
    assert.deepEqual(reqs.map((s) => s.request!.text), ["Fix the totals\n  and the <b>dates</b>", "Second one"]);
    assert.ok(reqs.every((s) => s.card === undefined && s.change === undefined));
    assert.deepEqual(reqs.map((s) => s.head), ["You made request 1", "You made request 2"]);
    assert.ok(!m.stops.some((s) => /request 0\b/.test(s.head)));
  });
  it("the shell has a request area apart from the panes", () => {
    const html = renderReviewShell(7);
    assert.match(html, /id="reqview"[^>]*hidden/);
    assert.match(html, /id="reqtext"/);
  });
});

describe("page: a request stop in the real page code", () => {
  const hostile = "<script>alert(1)</script><img src=x onerror=alert(2)>\nline two\n\n" + "long ".repeat(400);
  const tl = timeline([request("r0", 0, hostile, [change("c1", "a.txt", true)]), request("r1", 1, "Plain second", [change("c2", "b.txt", true)])]);

  it("shows the text as text, whole, with no panes, no view fetch, no clamp", async () => {
    const p = await boot(tl, "#0");
    assert.equal(p.model.stops[0].id, "req-r0");
    assert.equal(p.byId("h1").textContent, "Made request 1");
    assert.equal(p.byId("reqview").hidden, false);
    assert.equal(p.byId("stage").hidden, true);
    assert.equal(p.byId("reqtext").textContent, hostile);
    assert.equal(p.byId("reqtext").children.length, 0, "text only, no element built from it");
    assert.equal(p.byId("notes").children.length, 0, "no side card");
    assert.equal(p.byId("vb").children.length, 0);
    assert.equal(p.byId("va").children.length, 0);
    assert.doesNotMatch(text(p.byId("notes")), /show all/);
  });

  it("never fetches a view for a request stop", async () => {
    const p = await boot(tl, "#1");
    const urls: string[] = [];
    const real = p.g.fetch as (u: string) => Promise<unknown>;
    p.g.fetch = (u: string) => { urls.push(u); return real(u); };
    await p.key("ArrowLeft"); // the secret change -> request 1
    assert.equal(p.byId("h1").textContent, "Made request 1");
    assert.deepEqual(urls, []);
  });

  it("request -> change -> request -> change leaves nothing of the previous stop", async () => {
    const p = await boot(tl, "#0"); // request 1
    assert.equal(p.byId("reqtext").textContent, hostile);
    await p.key("ArrowRight"); // change c1 (secret)
    assert.equal(p.byId("reqview").hidden, true);
    assert.equal(p.byId("stage").hidden, false);
    assert.equal(p.byId("reqtext").textContent, "", "the request text is cleared on a change stop");
    assert.equal(p.byId("caveats").textContent, "", "the secret file's note is in the Details panel, not under the panes");
    await p.key("ArrowRight"); // request 2
    assert.equal(p.byId("h1").textContent, "Made request 2");
    assert.equal(p.byId("reqtext").textContent, "Plain second");
    assert.equal(p.byId("stage").hidden, true);
    assert.equal(p.byId("caveats").textContent, "", "no note from the change before");
    assert.equal(p.byId("vb").children.length, 0, "no pane from the change before");
    assert.equal(p.byId("notes").children.length, 0);
    await p.key("ArrowRight"); // change c2
    assert.equal(p.byId("reqview").hidden, true);
    assert.equal(p.byId("reqtext").textContent, "");
    assert.equal(p.byId("caveats").textContent, "", "the secret file's note is in the Details panel, not under the panes");
    await p.key("ArrowLeft"); // back to request 2
    assert.equal(p.byId("reqtext").textContent, "Plain second");
  });
});

describe("page: a drawn (non-secret) change followed by a request", () => {
  it("clears the change's panes, notes and caveats when the request stop comes", async () => {
    const tl = timeline([request("r0", 0, "First", [change("c1", "a.txt")]), request("r1", 1, "Second", [change("c2", "b.txt")])]);
    const p = await boot(tl, "#0"); // request 1
    await p.key("ArrowRight"); // change c1: view fetch fails, the plain card is drawn
    const deep = (n: unknown): string => { const x = n as { textContent?: string; children?: unknown[] }; return (x.textContent ?? "") + (x.children ?? []).map(deep).join(""); };
    assert.match(deep(p.byId("va")), /not available/, "the failed view says why in its pane (fix/notes-panel: no caveats line)");
    assert.equal(p.byId("stage").hidden, false);
    await p.key("ArrowRight"); // request 2
    assert.equal(p.byId("reqtext").textContent, "Second");
    assert.equal(p.byId("caveats").textContent, "");
    assert.equal(p.byId("notes").children.length, 0);
    assert.equal(p.byId("vb").children.length, 0);
    assert.equal(p.byId("va").children.length, 0);
  });
});
