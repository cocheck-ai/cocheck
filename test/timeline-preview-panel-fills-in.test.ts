import { afterEach, describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import { asServed, served } from "./helpers/v1-served.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import type http from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { PENDING_SCRIPT } from "../src/timeline/page.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// A "still running" panel fills in by itself. Three levels, all without a browser:
// (1) the rail's own page code (review.js) run in a vm with a small DOM stub: it asks again for a pending view, with a bounded backoff,
//     and draws the finished one; (2) the general page's inline script run in a vm; (3) the real review server: a body with a pending
//     entry is never cached, so the finished picture is served on the next ask (late, not lost).

const SHA = "a".repeat(64);
const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const change = (id: string): Change => ({ id, file: "a.dat", outside: false, at: null, kind: "modified", step: 1, before: ref(SHA), after: ref("b".repeat(64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: "label", pending: true } }) as unknown as Change;
const tl = { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [],
    calls: [{ id: "call", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes: [change("c1")], line: { text: "t", source: "agent-description", label: "l" } }] }],
}] } as unknown as Timeline;

interface Node { textContent: string; hidden: boolean; children: unknown[]; [k: string]: unknown }
function makePage(fetchImpl: (u: string) => Promise<unknown>, extra: Record<string, unknown>) {
  const nodes = new Map<string, Node>();
  const make = (): Node => {
    let text = "";
    const base = {
      children: [], hidden: false,
      get textContent() { return text; },
      set textContent(v: string) { text = v; (this as unknown as Node).children = []; },
      append(...c: unknown[]) { (this as unknown as Node).children.push(...c); },
      classList: { toggle: () => false, add() {}, remove() {}, contains: () => false },
      style: { setProperty() {} }, dataset: {}, getAttribute: () => null,
    } as unknown as Node;
    return new Proxy(base, { get: (t, k) => (k in t ? (t as unknown as Record<PropertyKey, unknown>)[k] : typeof k === "string" ? () => make() : undefined), set: (t, k, v) => { (t as unknown as Record<PropertyKey, unknown>)[k] = v; return true; } });
  };
  const byId = (id: string): Node => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const body = make();
  body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: () => make(), createElementNS: () => make(), createTextNode: (t: string) => ({ nodeType: 3, textContent: t }), querySelectorAll: () => [], fonts: undefined };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "#1" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval, clearInterval, console, fetch: fetchImpl, ...extra };
  g.window = g; g.globalThis = g;
  return { g, byId, handlers };
}
const all = (n: unknown): string => (typeof n !== "object" || n === null ? "" : ((n as Node).textContent ?? "") + ((n as Node).children ?? []).map(all).join(" | "));
const ok = (v: unknown) => ({ ok: true, status: 200, json: async () => asServed(v) });
const pendingView = { change: "c1", file: "a.dat", engine: "your browser, from the stored file", kind: "card", before: [], after: [], boxes: [], caveats: ["The picture is still being drawn. It will appear here by itself."], pending: true };
const finishedView = { change: "c1", file: "a.dat", engine: "drawn by CoCheck from the cells, not by Excel", kind: "diff", before: [{ id: "p", label: "Sheet1", text: { lines: [{ n: 1, text: "old text", box: null }] } }], after: [{ id: "p", label: "Sheet1", text: { lines: [{ n: 1, text: "new text", box: null }] } }], boxes: [], caveats: [] };

async function rail(views: Array<unknown>) {
  const delays: number[] = [];
  let viewCalls = 0;
  const model = JSON.parse(JSON.stringify(buildRailModel(tl)));
  // Only the view route counts as a view call; the status route answers a shape the page reads as "no verdicts".
  const page = makePage(async (u: string) => (u.includes("/review/model") ? ok(model) : u.includes("/view/") ? ok(views[Math.min(viewCalls++, views.length - 1)]) : ok({})), {
    setTimeout: (f: () => void, ms: number) => { if (f.name !== "poll") delays.push(ms); return f.name === "poll" ? 0 : setTimeout(f, 0); },
  });
  const ctx = vm.createContext(page.g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 40));
  await settle();
  // No start stop; the page opens on the change (the first step that needs a verdict), so no key is pressed to reach it.
  await settle(); await settle();
  return { ...page, delays, calls: () => viewCalls };
}

describe("rail: a pending panel fills in by itself", () => {
  it("asks again with a bounded backoff, then draws the finished view", async () => {
    const p = await rail([pendingView, pendingView, finishedView]);
    assert.equal(p.calls(), 3, "the page did not ask again until the picture was ready");
    assert.deepEqual(p.delays.slice(0, 2), [1000, 2000]);
    assert.ok(p.delays.every((d) => d <= 8000));
    assert.match(all(p.byId("va")), /new text/);
    assert.doesNotMatch(all(p.byId("caveats")), /still being drawn/);
  });

  it("a preview that fails ends as the failure wording, not as a spinner", async () => {
    const failed = { ...pendingView, caveats: ["No picture of this file could be made, so nothing is boxed. No preview of this change: the stored file could not be read."], pending: undefined };
    const p = await rail([pendingView, failed]);
    assert.equal(p.calls(), 2);
    assert.match(all(p.byId("va")), /could not be read/);
  });

  it("a finished view is asked for once and never polled", async () => {
    const p = await rail([finishedView]);
    assert.equal(p.calls(), 1);
    assert.deepEqual(p.delays, []);
  });

  it("the polling is bounded: a picture that never finishes stops being asked for", async () => {
    const p = await rail([pendingView]);
    assert.ok(p.calls() <= 16, `asked ${p.calls()} times`);
  });
});

describe("general page: the inline script swaps in the finished card", () => {
  it("fetches the page again and replaces a pending card with the finished one", async () => {
    let replaced: unknown = null;
    const pendingCard = { id: "c1", replaceWith: (n: unknown) => { replaced = n; } };
    let stillPending = true;
    const delays: number[] = [];
    const ctx = vm.createContext({
      location: { href: "http://127.0.0.1:1/timeline/1/page?t=tok" },
      document: {
        querySelector: () => (stillPending ? pendingCard : null),
        querySelectorAll: () => [pendingCard],
        importNode: (n: unknown) => n,
      },
      DOMParser: class { parseFromString() { return { getElementById: () => ({ hasAttribute: () => false, finished: true }) }; } },
      fetch: async () => { stillPending = false; return { text: async () => "<html></html>" }; },
      setTimeout: (f: () => void, ms: number) => { if (f.name !== "poll") delays.push(ms); return f.name === "poll" ? 0 : setTimeout(f, 0); },
    });
    vm.runInContext(PENDING_SCRIPT, ctx);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(delays, [1000]);
    assert.ok(replaced && (replaced as { finished?: boolean }).finished, "the card was not swapped for the finished one");
  });
});
