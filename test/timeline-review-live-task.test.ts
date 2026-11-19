import { afterEach, describe, it } from "node:test";
import http from "node:http";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { isLive, liveState, LIVE_IDLE_MS, LIVE_MAX_QUIET_MS } from "../src/timeline/rail/live.ts";
import type { RawOp } from "../src/timeline/runs.ts";
import { call, prompt, stop, wakePrompt } from "./fixtures/timeline.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// The review page follows a task whose agent is still working. The page code (review.js and the files view) runs as is in a vm with a
// small DOM stub; the "server" is a function that answers each poll with the next model, or a 304. Models come from the real builder.

const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
function change(id: string, file: string, n: number): Change {
  return { id, file, outside: false, at: null, kind: "modified", step: 1, before: ref(`${n}`.repeat(64).slice(0, 64)), after: ref(`${n + 1}`.repeat(64).slice(0, 64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}` } } as unknown as Change;
}
const request = (id: string, index: number, text: string, changes: Change[]) => ({
  id, index, session: "s", texts: [{ text, source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: `run-${id}`, rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [],
    calls: [{ id: `call-${id}`, index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: "t", source: "agent-description", label: "l" } }] }],
});
const timeline = (reqs: unknown[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: reqs }) as unknown as Timeline;
const modelOf = (reqs: unknown[], live: boolean) => JSON.parse(JSON.stringify({ ...buildRailModel(timeline(reqs)), live }));

interface Node { textContent: string; hidden: boolean; children: unknown[]; [k: string]: unknown }
function makePage(answer: (u: string, init: { headers?: Record<string, string> } | undefined) => Promise<unknown>, hash: string) {
  const nodes = new Map<string, Node>();
  const writes: Record<string, number> = {};
  const timers: Array<{ f: () => void; ms: number }> = [];
  const replaced: string[] = [];
  const win: Record<string, unknown> = { pageYOffset: 0 };
  const make = (id: string | null): Node => {
    let text = "";
    const base: Node = {
      children: [], hidden: false,
      get textContent() { return text; },
      set textContent(v: string) {
        text = v; (this as unknown as Node).children = [];
        if (id) writes[id] = (writes[id] ?? 0) + 1;
        // the real DOM loses these places when the node is rebuilt: the stub says so, so a test fails when the page does not put them back
        if (id === "tl") byId("scroller").scrollTop = 0;
        if (id === "bodyview") win.pageYOffset = 0;
      },
      append(...c: unknown[]) { (this as unknown as Node).children.push(...c); },
      classList: { toggle: () => false, add() {}, remove() {}, contains: () => false },
      style: { setProperty() {} }, dataset: {},
      getAttribute: () => null,
    } as unknown as Node;
    return new Proxy(base, { get: (t, k) => (k in t ? (t as unknown as Record<PropertyKey, unknown>)[k] : typeof k === "string" ? () => make(null) : undefined), set: (t, k, v) => { (t as unknown as Record<PropertyKey, unknown>)[k] = v; return true; } });
  };
  const byId = (id: string): Node => { if (!nodes.has(id)) nodes.set(id, make(id)); return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const docHandlers: Record<string, () => void> = {};
  const body = make(null);
  body.getAttribute = (() => "7") as never;
  const document: Record<string, unknown> = {
    body, getElementById: byId, createElement: () => make(null), createElementNS: () => make(null), createTextNode: (t: string) => ({ nodeType: 3, textContent: t }),
    querySelectorAll: () => [], fonts: undefined, hidden: false, activeElement: null,
    addEventListener: (k: string, f: () => void) => { docHandlers[k] = f; },
  };
  Object.assign(win, {
    document, location: { search: "?t=tok", hash }, history: { replaceState: (_a: unknown, _b: unknown, u: string) => { replaced.push(u); } }, innerWidth: 1600, URLSearchParams,
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval, clearInterval, console,
    setTimeout: (f: () => void, ms: number) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: (h: number) => { if (timers[h - 1]) timers[h - 1] = { f: () => {}, ms: -1 }; },
    scrollTo: (_x: number, y: number) => { win.pageYOffset = y; },
    fetch: (u: string, init?: { headers?: Record<string, string> }) => answer(u, init),
  });
  win.window = win; win.globalThis = win;
  return { g: win, byId, handlers, docHandlers, document, writes, timers, replaced };
}

const ok = (m: unknown, etag: string) => ({ ok: true, status: 200, headers: { get: (k: string) => (k.toLowerCase() === "etag" ? etag : null) }, json: async () => m });
const NOT_MODIFIED = { ok: false, status: 304, headers: { get: () => null }, json: async () => { throw new Error("a 304 has no body"); } };
const settle = () => new Promise((r) => setTimeout(r, 20));

/** The model route answers from `script`: each poll takes the next entry; a 304 when the request's tag equals the current entry's. */
async function boot(script: Array<{ m: unknown; tag: string }>, hash: string) {
  let at = 0;
  const seen: Array<string | undefined> = [];
  let modelAsks = 0;
  const others: string[] = [];
  const page = makePage(async (u, init) => {
    if (!u.includes("/review/model")) { others.push(u); return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }; }
    modelAsks++;
    const sent = init?.headers?.["if-none-match"];
    seen.push(sent);
    const cur = script[Math.min(at, script.length - 1)]!;
    if (sent === cur.tag) return NOT_MODIFIED;
    return ok(cur.m, cur.tag);
  }, hash);
  const ctx = vm.createContext(page.g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await settle();
  const pending = () => page.timers.filter((t) => t.f.name === "poll" && t.ms === 1000);
  const slowPending = () => page.timers.filter((t) => t.f.name === "poll" && t.ms === 3000);
  /** The 15 s timer fires (the page between turns), the poll settles. */
  const advanceSlow = async (to?: number) => { if (to !== undefined) at = to; const t = slowPending().at(-1); assert.ok(t, "a slow poll is scheduled"); page.timers.splice(page.timers.indexOf(t), 1, { f: () => {}, ms: -1 }); t.f(); await settle(); };
  /** The server moves on to the next model; the page's 2 s timer fires; the poll settles. */
  const advance = async (to?: number) => { if (to !== undefined) at = to; const t = pending().at(-1); assert.ok(t, "a poll is scheduled"); page.timers.splice(page.timers.indexOf(t), 1, { f: () => {}, ms: -1 }); t.f(); await settle(); };
  const key = async (k: string) => { page.handlers.keydown!({ key: k, target: { tagName: "BODY" }, preventDefault() {} }); await settle(); };
  return { ...page, ctx, pending, advance, slowPending, advanceSlow, others, key, seen, asks: () => modelAsks };
}

const a1 = change("c1", "a.txt", 1), a2 = change("c2", "a.txt", 2), a3 = change("c3", "a.txt", 3), b1 = change("c4", "b.txt", 5);
const R1 = [request("r0", 0, "Make the sheet", [a1])];
const R2 = [request("r0", 0, "Make the sheet", [a1]), request("r1", 1, "Then the second", [a2])];
const R3 = [request("r0", 0, "Make the sheet", [a1]), request("r1", 1, "Then the second", [a2]), request("r2", 2, "And a third", [a3, b1])];

describe("the page follows a live task", () => {
  it("polls with the tag it holds; a 304 draws nothing; a new answer is merged in; Stop ends the polling", async () => {
    const p = await boot([{ m: modelOf(R1, true), tag: '"t1"' }, { m: modelOf(R2, true), tag: '"t2"' }, { m: modelOf(R3, false), tag: '"t3"' }], "#v=timeline");
    assert.equal(p.byId("livebanner").hidden, false, "the banner shows while the agent works");
    assert.equal(p.pending().length, 1, "a poll is scheduled about every 2 s");
    const railDraws = () => p.writes.tl ?? 0;
    const before = railDraws();
    await p.advance(0); // same tag: 304
    assert.equal(p.seen.at(-1), '"t1"', "the poll sends the tag of the answer it holds");
    assert.equal(railDraws(), before, "a 304 costs no re-render");
    assert.equal(p.pending().length, 1, "and the page goes on asking");
    await p.advance(1); // a new step arrives
    assert.ok(railDraws() > before, "a new step appears in place");
    assert.equal(p.byId("livebanner").hidden, false);
    await p.advance(2); // Stop: live is false
    assert.equal(p.byId("livebanner").hidden, true, "the banner goes at Stop");
    assert.equal(p.pending().length, 0, "the fast poll ends at Stop");
    assert.equal(p.slowPending().length, 1, "and the slow poll (every 15 s) takes over");
  });

  it("the step on show, the view and the scroll stay when steps arrive", async () => {
    const p = await boot([{ m: modelOf(R1, true), tag: '"t1"' }, { m: modelOf(R2, true), tag: '"t2"' }], "#v=timeline");
    const shown = p.byId("h1").textContent;
    assert.ok(shown.length > 0);
    p.byId("scroller").scrollTop = 140;
    (p.g as { pageYOffset: number }).pageYOffset = 260;
    await p.advance(1);
    assert.equal(p.byId("h1").textContent, shown, "the same step is still on show");
    assert.equal(p.byId("scroller").scrollTop, 140, "the rail keeps its scroll");
    assert.equal((p.g as { pageYOffset: number }).pageYOffset, 260, "the page keeps its scroll");
    assert.ok(p.replaced.every((u) => !u.startsWith("#v=files")), "the view did not switch to Deliverables");
  });

  it("Deliverables: the open file and version stay; Now keeps following the newest version", async () => {
    const p = await boot([{ m: modelOf(R2, true), tag: '"t2"' }, { m: modelOf(R3, true), tag: '"t3"' }], "");
    // a.txt has 2 versions: the page opens at Now (p=3). Step back to v2, then new versions arrive.
    await p.key("ArrowLeft");
    assert.match(p.replaced.at(-1)!, /^#v=files&f=a\.txt&p=2$/);
    await p.advance(1); // a.txt now has 3 versions
    await p.key("ArrowLeft");
    assert.match(p.replaced.at(-1)!, /^#v=files&f=a\.txt&p=1$/, "the selected version (v2) stayed v2");
  });

  it("Deliverables: a person on Now stays on Now as versions arrive", async () => {
    const p = await boot([{ m: modelOf(R2, true), tag: '"t2"' }, { m: modelOf(R3, true), tag: '"t3"' }], "");
    await p.advance(1);
    await p.key("ArrowLeft");
    assert.match(p.replaced.at(-1)!, /^#v=files&f=a\.txt&p=3$/, "Now moved to the new last version: one step back from it is v3");
  });

  it("a hidden tab asks nothing, and asks again when it shows", async () => {
    const p = await boot([{ m: modelOf(R1, true), tag: '"t1"' }], "#v=timeline");
    p.document.hidden = true;
    await p.advance(0);
    assert.equal(p.pending().length, 0, "nothing is scheduled while the tab is hidden");
    const asks = p.asks();
    p.document.hidden = false;
    p.docHandlers.visibilitychange!();
    await settle();
    assert.equal(p.asks(), asks + 1, "it asks at once when the tab shows again");
    assert.equal(p.pending().length, 1, "and goes on while the task is live");
  });

  it("a note being typed is not redrawn away, and a finished task is never polled", async () => {
    const p = await boot([{ m: modelOf(R1, true), tag: '"t1"' }, { m: modelOf(R2, true), tag: '"t2"' }], "#v=timeline");
    // the step on show changes under the person (the request step is replaced by the new model's text) while they type
    p.document.activeElement = { tagName: "TEXTAREA" };
    const draws = p.writes.reqtext ?? 0;
    await p.advance(1);
    assert.equal(p.writes.reqtext ?? 0, draws, "no pane is redrawn while a field has the keyboard");
    const done = await boot([{ m: modelOf(R1, false), tag: '"t1"' }], "#v=timeline");
    assert.equal(done.pending().length, 0, "a task that is not live is never polled fast");
    assert.equal(done.byId("livebanner").hidden, true);
  });

  it("while live the last version reads 'So far', never 'Now'; after Stop it reads 'Now'", async () => {
    const p = await boot([{ m: modelOf(R2, true), tag: '"t2"' }, { m: modelOf(R2, false), tag: '"t2f"' }], "");
    const FV = (p.ctx as unknown as { CoCheckFilesView: { nameOf(p: number, n: number): string } }).CoCheckFilesView;
    assert.equal(FV.nameOf(3, 2), "So far");
    await p.advance(1);
    assert.equal(FV.nameOf(3, 2), "Now");
  });

  it("a live task with no step yet says so and keeps asking; its first step draws the page", async () => {
    const empty = { ...modelOf(R1, true), stops: [], files: [] };
    const p = await boot([{ m: empty, tag: '"e"' }, { m: modelOf(R1, true), tag: '"t1"' }], "#v=timeline");
    // The heading is the loading widget; its words are in the widget's label
    const deep = (n: unknown): string => (n && typeof n === "object" ? String((n as Node).textContent ?? "") + (((n as Node).children ?? []) as unknown[]).map(deep).join("") : "");
    assert.match(deep(p.byId("h1")), /Waiting for the first step/);
    assert.equal(p.pending().length, 1);
    await p.advance(1);
    assert.doesNotMatch(deep(p.byId("h1")), /Waiting/);
  });

  it("silent for 20 minutes with no Stop: still polling (slowly) and the banner says how long", async () => {
    const quiet = { ...modelOf(R1, true), quietMin: 20 };
    const p = await boot([{ m: quiet, tag: '"q"' }], "#v=timeline");
    assert.equal(p.byId("livebanner").hidden, false);
    assert.equal(p.byId("livebanner").textContent, "Agent still working (quiet for 20 min)");
    const slow = p.timers.filter((t) => t.f.name === "poll" && t.ms === 3000);
    assert.equal(slow.length, 1, "the next poll is the slow one, about every 15 s");
    assert.equal(p.timers.filter((t) => t.f.name === "poll" && t.ms === 1000).length, 0);
    // the agent comes back: quiet disappears and the pace is 2 s again
    const t = slow[0]!; p.timers.splice(p.timers.indexOf(t), 1, { f: () => {}, ms: -1 });
    t.f(); await settle();
    assert.equal(p.byId("livebanner").hidden, false);
  });

  it("an idle page picks up the next turn within the slow poll, and the fast poll comes back", async () => {
    const p = await boot([{ m: modelOf(R1, false), tag: '"t1"' }, { m: modelOf(R2, true), tag: '"t2"' }, { m: modelOf(R3, false), tag: '"t3"' }], "#v=timeline");
    assert.equal(p.byId("livebanner").hidden, true, "the banner shows only while live");
    assert.equal(p.slowPending().length, 1, "a task opened while idle is asked about every 15 s");
    assert.equal(p.pending().length, 0);
    const before = p.writes.tl ?? 0;
    await p.advanceSlow(1); // a new turn begins
    assert.ok((p.writes.tl ?? 0) > before, "the new step appears without a reload");
    assert.equal(p.byId("livebanner").hidden, false);
    assert.equal(p.pending().length, 1, "fast polling resumes when live turns true");
    assert.equal(p.slowPending().length, 0);
    await p.advance(2); // Stop again
    assert.equal(p.byId("livebanner").hidden, true);
    assert.equal(p.slowPending().length, 1, "and the page goes back to waiting");
  });

  it("ten idle polls cost only 304s; nothing redraws, a typed note stays, nothing else is asked", async () => {
    const p = await boot([{ m: modelOf(R2, true), tag: '"t1"' }, { m: modelOf(R2, false), tag: '"t2"' }], "#v=timeline");
    await p.advance(1); // Stop: live turns false
    const otherAsks = p.others.length, asks = p.asks();
    p.document.activeElement = { tagName: "TEXTAREA" };
    const snap = JSON.stringify(p.writes), scroll = p.byId("scroller").scrollTop;
    for (let i = 0; i < 12; i++) { await p.advanceSlow(); assert.equal(p.seen.at(-1), '"t2"', "each idle poll sends the tag it holds"); }
    assert.equal(p.asks(), asks + 12, "one question per poll");
    assert.equal(JSON.stringify(p.writes), snap, "no pane was written across the idle polls");
    assert.equal(p.byId("scroller").scrollTop, scroll);
    assert.equal(p.others.length, otherAsks, "idle polls ask for nothing besides the model");
    assert.equal(p.slowPending().length, 1, "still waiting for the next turn");
  });

  it("a hidden idle tab asks nothing and asks once when shown", async () => {
    const p = await boot([{ m: modelOf(R1, false), tag: '"t1"' }], "#v=timeline");
    p.document.hidden = true;
    await p.advanceSlow(0);
    assert.equal(p.slowPending().length, 0, "nothing is scheduled while hidden");
    const asks = p.asks();
    p.document.hidden = false;
    p.docHandlers.visibilitychange!();
    await settle();
    assert.equal(p.asks(), asks + 1);
    assert.equal(p.slowPending().length, 1);
  });

  it("thirty failures in a row stop an idle page too", async () => {
    let n = 0;
    const page = makePage(async (u) => (u.includes("/review/model") ? (n++ === 0 ? ok(modelOf(R1, false), '"t1"') : Promise.reject(new Error("down"))) : { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }), "#v=timeline");
    const ctx = vm.createContext(page.g);
    for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
    await settle();
    for (let i = 0; i < 40; i++) {
      const t = page.timers.filter((x) => x.f.name === "poll" && x.ms === 3000).at(-1);
      if (!t) break;
      page.timers.splice(page.timers.indexOf(t), 1, { f: () => {}, ms: -1 });
      t.f();
      await settle();
    }
    assert.equal(n, 31, `stopped after 30 failures, asked ${n}`);
    assert.equal(page.timers.filter((x) => x.f.name === "poll" && x.ms === 3000).length, 0);
  });

  it("a failing poll many times in a row ends the polling", async () => {
    let n = 0;
    const page = makePage(async (u) => (u.includes("/review/model") ? (n++ === 0 ? ok(modelOf(R1, true), '"t1"') : Promise.reject(new Error("down"))) : { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }), "#v=timeline");
    const ctx = vm.createContext(page.g);
    for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
    await settle();
    for (let i = 0; i < 40; i++) {
      const t = page.timers.filter((x) => x.f.name === "poll" && x.ms === 1000).at(-1);
      if (!t) break;
      page.timers.splice(page.timers.indexOf(t), 1, { f: () => {}, ms: -1 });
      t.f();
      await settle();
    }
    assert.ok(n <= 31, `stopped after 30 failures, asked ${n}`);
    assert.equal(page.byId("livebanner").hidden, true);
  });
});

describe("the server says live or finished, and the request text is there before Stop", () => {
  const op = (id: number, args: Record<string, unknown>): RawOp => ({ id, tool: "hook", intent: "x", args });
  const NOW = 10_000_000;
  const prompt = (id: number, at: number, text = "do it", session = "s1") => op(id, { hookAdapter: 1, hookEvent: "UserPromptSubmit", session_id: session, at, prompts: [text], requests: [{ seq: id, at, firstStepSeq: null }] });
  const stop = (id: number, at: number, session = "s1") => op(id, { hookAdapter: 1, hookEvent: "Stop", session_id: session, at });

  it("live from the prompt until Stop; not live once Stop lands", () => {
    assert.equal(isLive([prompt(1, NOW - 1000)], NOW), true);
    assert.equal(isLive([prompt(1, NOW - 5000), stop(2, NOW - 1000)], NOW), false);
    assert.equal(isLive([prompt(1, NOW - 5000), stop(2, NOW - 4000), prompt(3, NOW - 1000, "again")], NOW), true, "a later turn is live again");
  });

  it("a long silent call keeps the task live and says how long it has been quiet; only Stop, or 2 hours of silence, ends it", () => {
    assert.deepEqual(liveState([prompt(1, NOW - LIVE_IDLE_MS + 1000)], NOW), { live: true, quietMin: null });
    assert.deepEqual(liveState([prompt(1, NOW - 20 * 60000)], NOW), { live: true, quietMin: 20 });
    assert.equal(isLive([prompt(1, NOW - LIVE_MAX_QUIET_MS - 1)], NOW), false, "a turn that never reached Stop ends after 2 hours");
    assert.equal(isLive([prompt(1, NOW - 30 * 60000), stop(2, NOW - 20 * 60000)], NOW), false, "Stop ends it whatever the silence");
  });

  it("no time known means not live, and no turn open means not live", () => {
    assert.equal(isLive([op(1, { hookEvent: "UserPromptSubmit", session_id: "s1", at: "unknown", prompts: ["x"] })], NOW), false);
    assert.equal(isLive([], NOW), false);
  });

  it("a wake notification does not make a task live; another session's Stop does not end this one's turn", () => {
    assert.equal(isLive([prompt(1, NOW - 1000, "<task-notification>agent done</task-notification>")], NOW), false);
    assert.equal(isLive([prompt(1, NOW - 3000, "do it", "s1"), stop(2, NOW - 1000, "s2")], NOW), true);
  });

  it("the model holds the request text from the prompt op alone, before any Stop", () => {
    const tl = buildTimeline({ taskId: 1, build: "t", ops: [prompt(1, NOW - 1000, "Make the totals row")], fileStates: [], folder: null, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false } as never);
    const reqs = buildRailModel(tl).stops.filter((s) => s.request);
    assert.deepEqual(reqs.map((s) => s.request!.text), ["Make the totals row"]);
  });
});

describe("the model route, in-process", () => {
  const TOKEN = "t".repeat(40), CLIENT = "claude:/work";
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
  async function setup() {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const ledger = openLedger(home);
    const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => "", quickLook: false });
    cleanups.push(async () => { await new Promise<void>((r) => (server as Server).close(() => r())); ledger.close(); await rm(home, { recursive: true, force: true }); });
    const id = ledger.openTask(CLIENT);
    const prompt = (n: number, text: string) => ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: Date.now(), earlier: 0, prompts: [text], requests: [{ seq: n, at: Date.now(), firstStep: null }] } });
    const stop = () => ledger.recordOp({ taskId: id, tool: "hook", intent: "stop", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "Stop", host: "claude", session_id: "sess", at: Date.now() } });
    const get = (headers: Record<string, string> = {}) => new Promise<{ status: number; etag: string | undefined; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: `/timeline/${id}/review/model?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, etag: res.headers.etag, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject); req.end();
    });
    return { prompt, stop, get };
  }

  it("200 with an ETag; the same ETag gets 304; a new op changes body and tag; after Stop live is false and the request text was there before it", async () => {
    const s = await setup();
    s.prompt(1, "Make the totals row");
    const first = await s.get();
    assert.equal(first.status, 200);
    assert.match(first.etag!, /^"[0-9a-f]{32}"$/);
    const m1 = JSON.parse(first.body) as { live: boolean; stops: Array<{ request?: { text: string } }> };
    assert.equal(m1.live, true);
    assert.deepEqual(m1.stops.filter((x) => x.request).map((x) => x.request!.text), ["Make the totals row"], "the request text shows before Stop");
    const again = await s.get({ "if-none-match": first.etag! });
    assert.equal(again.status, 304);
    assert.equal(again.body, "");
    s.prompt(2, "And a second ask");
    const next = await s.get({ "if-none-match": first.etag! });
    assert.equal(next.status, 200);
    assert.notEqual(next.etag, first.etag);
    s.stop();
    const done = await s.get({ "if-none-match": next.etag! });
    assert.equal(done.status, 200, "the live flag turning off changes the tag, so a 304 never hides Stop");
    assert.equal((JSON.parse(done.body) as { live: boolean }).live, false);
  });
});

describe("the step on show stays when an earlier-started call is recorded later", () => {
  const W = "/w/";
  const ids = { n: 5000 };
  const finish = (agentId: string, at: number, text: string): RawOp => ({ id: ++ids.n, tool: "hook", intent: "helper finished", args_json: JSON.stringify({ hookAdapter: 1, hookEvent: "SubagentStop", host: "claude", session_id: "s1", agent_id: agentId, agent_type: "general-purpose", at, seq: 1, finish: { text } }) });
  const c = (id: string, seq: number, extra: Record<string, unknown>, tool: string, at: number) => call(id, { session: "s1", tool, desc: id, at, named: [], extra: { startSeq: seq, ...extra } });
  const launch = (id: string, desc: string, at: number) => c(id, at / 10, { toolLabel: { fields: { subagent_type: "general-purpose", description: desc } } }, "Agent", at);
  const msg = (id: string, text: string, at: number) => c(id, at / 10, { toolLabel: { fields: { to: "memo-writer", message: text } } }, "SendMessage", at);
  const stopAt = (text: string, at: number): RawOp => { const o = stop("s1", text); return { ...o, args_json: JSON.stringify({ ...JSON.parse(o.args_json as string), at }) }; };
  const ops: RawOp[] = [
    prompt("s1", ["Build."], { requests: [{ seq: 1, at: 10, firstStep: null }] }),
    launch("B", "Fetch the memo data", 30), msg("M1", "Rewrite the memo.", 80), finish("agB", 90, "Data fetched."),
    stopAt("Round one done.", 100),
  ];
  // recorded later, started earlier: a launch, a message, a finish, a wake and a reply
  const late: RawOp[] = [launch("A", "Fetch the rates", 20), msg("M0", "An earlier note.", 25), finish("agA", 28, "Rates fetched."), wakePrompt("s1", { toolUseId: "A", summary: 'Agent "Fetch the rates" finished' }, 2, 29), stopAt("An earlier turn.", 27)];
  const modelOfOps = (o: RawOp[]) => JSON.parse(JSON.stringify({ ...buildRailModel(buildTimeline({ taskId: 1, build: "t", ops: o, fileStates: [], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false } as never)), live: true, modelVerdicts: false }));
  for (const kind of [/^Started/, /sent a message|Sent a message/, /replied|Replied/]) {
    it(`a ${kind.source.slice(1, 8)} step stays on show after the next answer`, async () => {
      const m1 = modelOfOps(ops), m2 = modelOfOps([...ops, ...late]);
      const target = m1.stops.find((x: { title?: string; head: string }) => kind.test(x.title ?? x.head));
      assert.ok(target, m1.stops.map((x: { id: string }) => x.id).join(","));
      const p = await boot([{ m: m1, tag: '"a"' }, { m: m2, tag: '"b"' }], "#v=timeline");
      for (let i = 0; i < 20 && p.byId("h1").textContent !== (target.title ?? target.head); i++) await p.key("ArrowRight");
      const shown = p.byId("h1").textContent;
      assert.equal(shown, target.title ?? target.head, "the step is selected");
      await p.advance(1);
      assert.equal(p.byId("h1").textContent, shown, "the same step is still on show");
    });
  }
});
