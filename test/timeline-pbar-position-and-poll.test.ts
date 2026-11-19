import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// The review bar (#pbar), part 1. One position is one change stop, counted as the progress count counts them. The page code runs as is in a
// vm with a DOM stub; the "server" answers the model, the status and the verdict routes. Position and undo are keyed by stop id, never by index.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
function change(id: string, file: string, n: number): Change {
  return { id, file, outside: false, at: null, kind: "modified", step: 1, before: ref(`${n}`.repeat(64).slice(0, 64)), after: ref(`${n + 1}`.repeat(64).slice(0, 64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } } as unknown as Change;
}
const request = (id: string, index: number, text: string, changes: Change[]) => ({
  id, index, session: "s", texts: [{ text, source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: `run-${id}`, rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [],
    calls: [{ id: `call-${id}`, index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: `line ${id}`, source: "agent-description", label: "l" } }] }],
});
const timeline = (reqs: unknown[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: reqs }) as unknown as Timeline;
type M = { stops: Array<{ id: string; label: string; change?: unknown }> };
const modelOf = (reqs: unknown[], live: boolean): M => JSON.parse(JSON.stringify({ ...buildRailModel(timeline(reqs)), live, modelVerdicts: true }));
const changeIds = (m: M) => m.stops.filter((s) => s.change).map((s) => s.id);

interface Node { textContent: string; hidden: boolean; children: unknown[]; [k: string]: unknown }
const settle = () => new Promise((r) => setTimeout(r, 20));
const SUBMIT = { blocking: [] as string[], notReviewed: [] as string[], eligible: true, superseded: [] as string[] };

async function boot(script: Array<{ m: M; tag: string }>, hash: string, hold = false) {
  const nodes = new Map<string, Node>();
  const timers: Array<{ f: () => void; ms: number }> = [];
  const win: Record<string, unknown> = { pageYOffset: 0 };
  const make = (id: string | null): Node => {
    let text = "";
    const base = { children: [], hidden: false, get textContent() { return text; }, set textContent(v: string) { text = v; (this as unknown as Node).children = []; },
      append(...c: unknown[]) { (this as unknown as Node).children.push(...c); }, classList: { toggle: () => false, add() {}, remove() {}, contains: () => false }, style: { setProperty() {} }, dataset: {}, attrs: {} as Record<string, string>,
      setAttribute(k: string, v: string) { (this as unknown as { attrs: Record<string, string> }).attrs[k] = String(v); }, getAttribute(k: string) { return (this as unknown as { attrs: Record<string, string> }).attrs[k] ?? null; } };
    return new Proxy(base as unknown as Node, { get: (t, k) => (k in t ? (t as unknown as Record<PropertyKey, unknown>)[k] : typeof k === "string" ? () => make(null) : undefined), set: (t, k, v) => { (t as unknown as Record<PropertyKey, unknown>)[k] = v; return true; } });
  };
  const byId = (i: string): Node => { if (!nodes.has(i)) nodes.set(i, make(i)); return nodes.get(i)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const body = make(null); body.getAttribute = (() => "7") as never;
  const document: Record<string, unknown> = { body, getElementById: byId, createElement: () => make(null), createElementNS: () => make(null), createTextNode: (t: string) => ({ nodeType: 3, textContent: t }), querySelectorAll: () => [], fonts: undefined, hidden: false, activeElement: null, addEventListener() {} };
  let at = 0; const posted: Array<{ stop: string; status: string }> = []; const verd: Record<string, unknown> = {};
  const gate: { release: (() => void) | null; wait: Promise<void> | null } = { release: null, wait: null };
  const respond = (m: unknown, status = 200, tag: string | null = null) => ({ ok: status < 400, status, headers: { get: (k: string) => (k.toLowerCase() === "etag" ? tag : null) }, json: async () => m });
  const seenTag: { v: string | undefined } = { v: undefined };
  Object.assign(win, { document, location: { search: "?t=tok", hash }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, setInterval, clearInterval, scrollTo() {},
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; },
    setTimeout: (f: () => void, ms: number) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: (h: number) => { if (timers[h - 1]) timers[h - 1] = { f: () => {}, ms: -1 }; },
    fetch: async (u: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      if (u.includes("/review/model")) { seenTag.v = init?.headers?.["if-none-match"]; const cur = script[Math.min(at, script.length - 1)]!; return seenTag.v === cur.tag ? respond({}, 304) : respond(cur.m, 200, cur.tag); }
      if (u.includes("/review/verdict")) {
        const b = JSON.parse(init!.body!) as { stop: string; status: string; note: string };
        posted.push({ stop: b.stop, status: b.status });
        if (hold && gate.wait === null) { gate.wait = new Promise<void>((r) => { gate.release = r; }); }
        if (hold && gate.wait) await gate.wait;
        const state = { status: b.status, note: b.note, stale: false, history: [] }; verd[b.stop] = state;
        return respond({ state, submit: SUBMIT });
      }
      if (u.includes("/review/status")) return respond({ stops: verd, submitted: null, submitState: "none", earlier: [], submit: SUBMIT });
      return respond({}, 404);
    } });
  win.window = win; win.globalThis = win;
  const ctx = vm.createContext(win);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await settle();
  const key = async (k: string, extra: Record<string, unknown> = {}) => { handlers.keydown!({ key: k, target: { tagName: "BODY" }, preventDefault() {}, ...extra }); await settle(); };
  const poll = async (to: number) => { at = to; const t = timers.filter((x) => x.f.name === "poll").at(-1); assert.ok(t, "a poll is scheduled"); timers.splice(timers.indexOf(t), 1, { f: () => {}, ms: -1 }); t.f(); await settle(); };
  const text = (id: string) => byId(id).textContent;
  return { key, poll, posted, text, byId, gate, ctx };
}

const A = change("c1", "a.txt", 1), B = change("c2", "b.txt", 3), C = change("c3", "c.txt", 5), X = change("cx", "x.txt", 7);
const R3 = [request("r0", 0, "First", [A]), request("r1", 1, "Second", [B]), request("r2", 2, "Third", [C])];
const R3X = [request("r0", 0, "First", [A]), request("rx", 1, "Newly arrived", [X]), request("r1", 2, "Second", [B]), request("r2", 3, "Third", [C])];

describe("the review bar", () => {
  it("the shell has one #pbar container with the stepper, label, Pass and Fail", () => {
    const html = renderReviewShell(7);
    for (const id of ["pbar", "pbpos", "pblabel", "pbprev", "pbnext", "pbpass", "pbfail"]) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.equal((html.match(/id="pbar"/g) ?? []).length, 1);
  });

  it("Timeline: the bar counts change stops like the progress count; Pass records the stop on show and moves to the next unjudged one", async () => {
    const m = modelOf(R3, false); const ids = changeIds(m);
    const hash = `#${m.stops.findIndex((s) => s.id === ids[0])}`;
    const p = await boot([{ m, tag: '"a"' }], hash);
    assert.equal(p.text("pbpos"), "1 of 3");
    assert.equal(p.text("progtext"), "0 of 3 changes reviewed");
    await p.key("p");
    assert.deepEqual(p.posted, [{ stop: ids[0]!, status: "passed" }]);
    assert.equal(p.text("pbpos"), "2 of 3", "the bar moved to the next unjudged stop");
    assert.equal(p.text("pblabel"), m.stops.find((s) => s.id === ids[1])!.label);
  });

  it("Deliverables: P judges the stop of the version on show and the bar follows to the next file", async () => {
    const m = modelOf(R3, false); const ids = changeIds(m);
    const p = await boot([{ m, tag: '"a"' }], "");
    const first = p.text("pbpos");
    assert.match(first, /^\d of 3$/);
    await p.key("p");
    assert.equal(p.posted.length, 1);
    assert.ok(ids.includes(p.posted[0]!.stop), "a change stop was judged");
    assert.notEqual(p.text("pbpos"), first, "the bar moved on");
    await p.key("p");
    await p.key("p");
    assert.deepEqual(new Set(p.posted.map((x) => x.stop)), new Set(ids), "three Ps judged three different stops");
  });

  it("a poll inserts a stop before the current one, then P: the verdict goes to the intended stop id", async () => {
    const m1 = modelOf(R3, true), m2 = modelOf(R3X, true); const ids = changeIds(m1);
    const hash = `#${m1.stops.findIndex((s) => s.id === ids[1])}`; // on the second change (c2)
    const p = await boot([{ m: m1, tag: '"a"' }, { m: m2, tag: '"b"' }], hash);
    assert.equal(p.text("pbpos"), "2 of 3");
    await p.poll(1);
    assert.equal(p.text("pbpos"), "3 of 4", "the new stop joined the count and the current stop did not move");
    assert.equal(p.text("pblabel"), m1.stops.find((s) => s.id === ids[1])!.label);
    await p.key("p");
    assert.deepEqual(p.posted, [{ stop: ids[1]!, status: "passed" }], "not the stop that now sits at the old index");
  });

  it("a poll lands between P and its answer: the verdict stands on the right stop and the bar moves on from it", async () => {
    const m1 = modelOf(R3, true), m2 = modelOf(R3X, true); const ids = changeIds(m1);
    const hash = `#${m1.stops.findIndex((s) => s.id === ids[1])}`;
    const p = await boot([{ m: m1, tag: '"a"' }, { m: m2, tag: '"b"' }], hash, true);
    p.key("p"); await settle();
    await p.poll(1); // the new stop arrives while the verdict is in flight
    p.gate.release!(); await settle();
    assert.deepEqual(p.posted, [{ stop: ids[1]!, status: "passed" }]);
    assert.equal(p.text("pblabel"), m1.stops.find((s) => s.id === ids[2])!.label, "moved on from c2 to c3 by id");
    assert.equal(p.text("pbpos"), "4 of 4");
  });

  it("U clears the current stop's verdict by id when no undo toast is showing", async () => {
    const m = modelOf(R3, false); const ids = changeIds(m);
    const p = await boot([{ m, tag: '"a"' }], `#${m.stops.findIndex((s) => s.id === ids[0])}`);
    await p.key("p");
    await p.key("ArrowLeft"); // back to c1
    await p.key("u"); // the toast undo reverts the last verdict (c1)
    assert.deepEqual(p.posted.map((x) => `${x.stop}:${x.status}`), [`${ids[0]}:passed`, `${ids[0]}:not_reviewed`]);
  });

  it("after the last stop the bar offers Send back when a stop failed, Sign off when none did", async () => {
    const m = modelOf([R3[0]!], false); const ids = changeIds(m);
    const p = await boot([{ m, tag: '"a"' }], `#${m.stops.findIndex((s) => s.id === ids[0])}`);
    assert.equal(p.byId("pbact").hidden, true);
    await p.key("p");
    assert.equal(p.byId("pbact").hidden, false);
    assert.equal(p.text("pbact"), "Sign off");
  });
});
