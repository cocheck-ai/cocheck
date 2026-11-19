import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// as left it: every entry point opens the rail, and the rail carries no link to the removed legacy page. When the rail has nothing to show
// it says so in plain words. The rail script runs as is in a vm with a small DOM stub; the "server" is a function. The routes run on a scratch home.

interface Node { textContent: string; children: unknown[]; href?: string; [k: string]: unknown }
async function boot(fetchImpl: (u: string) => Promise<unknown>) {
  const nodes = new Map<string, Node>();
  const make = (): Node => {
    let text = "";
    const base = {
      children: [] as unknown[], hidden: false,
      get textContent() { return text; },
      set textContent(v: string) { text = v; (this as unknown as Node).children = []; },
      append(...c: unknown[]) { (this as unknown as Node).children.push(...c); },
      classList: { toggle: () => false, add() {}, remove() {}, contains: () => false }, style: {}, dataset: {}, getAttribute: () => null,
    } as unknown as Node;
    return new Proxy(base, { get: (t, k) => (k in t ? (t as unknown as Record<PropertyKey, unknown>)[k] : typeof k === "string" ? () => make() : undefined), set: (t, k, v) => { (t as unknown as Record<PropertyKey, unknown>)[k] = v; return true; } });
  };
  const byId = (id: string): Node => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id)!; };
  const body = make();
  body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: () => make(), createElementNS: () => make(), createTextNode: (t: string) => ({ nodeType: 3, textContent: t }), querySelectorAll: () => [], fonts: undefined };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, addEventListener() {}, setInterval: () => 0, clearInterval() {}, console, fetch: (u: string) => fetchImpl(u) };
  g.window = g; g.globalThis = g;
  ((g) as Record<string, unknown>).localStorage = { getItem: (k: string) => (k === "cocheck.showQuiet" ? "on" : null), setItem() {} }; // quiet rows are off by default; these tests are about them
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 20));
  return { byId };
}
const ok = (v: unknown) => ({ ok: true, status: 200, json: async () => v });

describe("the rail's failure states, with no link to the removed page", () => {
  it("keeps a heading and a plain reason when the model fetch is not OK", async () => {
    const { byId } = await boot(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    assert.equal(byId("h1").textContent, "Nothing to show for this task yet.");
    assert.equal(byId("h2").textContent, "CoCheck couldn't load this task's timeline.");
  });

  it("keeps a heading and a plain reason when the model fetch throws", async () => {
    const { byId } = await boot(async () => { throw new Error("offline"); });
    assert.equal(byId("h1").textContent, "Nothing to show for this task yet.");
    assert.equal(byId("h2").textContent, "CoCheck couldn't load this task's timeline.");
  });

  it("says why when the model has no stops (an older ledger)", async () => {
    const { byId } = await boot(async () => ok({ stops: [], actors: [], folder: "" }));
    assert.equal(byId("h1").textContent, "Nothing to show for this task yet.");
    assert.equal(byId("h2").textContent, "No steps were recorded for this task.");
  });
});

describe("plain no-data state", () => {
  const banned = /railroad|model|stops|\b500\b|offline|Error/i;
  for (const [name, f] of [
    ["fetch not ok", async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ["fetch throws", async () => { throw new Error("offline"); }],
    ["empty timeline", async () => ok({ stops: [], actors: [], folder: "" })],
  ] as const) {
    it(`${name}: plain words, no raw error, panes hidden`, async () => {
      const { byId } = await boot(f as never);
      assert.doesNotMatch(byId("h1").textContent + byId("h2").textContent, banned);
      assert.equal(byId("stage").hidden, true);
    });
  }
  it("the error still reaches the console", async () => {
    const seen: unknown[][] = [];
    const orig = console.error; console.error = (...a: unknown[]) => { seen.push(a); };
    try { await boot(async () => { throw new Error("offline"); }); } finally { console.error = orig; }
    assert.ok(seen.some((a) => a.some((x) => String((x as Error)?.message ?? x).includes("offline"))));
  });
  it("shell: no playback buttons above the rail (the bottom bar's arrows step), and hidden things stay hidden", async () => {
    const html = renderReviewShell(7);
    assert.doesNotMatch(html, /id="(ctl|play|prev|next)"/);
    assert.match(html, /id="pbprev"/);
    assert.match(html, /id="pbnext"/);
    assert.doesNotMatch(html, /Decisions, requests and sign-off/);
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /\[hidden\]\{display:none!important\}/);
  });
});

const TOKEN = "t".repeat(32);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

describe("the routes", () => {
  it("serves the rail shell without the link, and serves nothing under /review/", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const ledger = openLedger(home);
    const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
    cleanups.push(async () => { await new Promise<void>((r) => (server as Server).close(() => r())); ledger.close(); await rm(home, { recursive: true, force: true }); });
    const id = ledger.openTask("claude:/work");
    const get = (p: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }).on("error", reject);
    });
    const shell = await get(`/timeline/${id}/review?t=${TOKEN}`);
    assert.equal(shell.status, 200);
    assert.ok(!shell.body.includes("/review/") && !shell.body.includes("Decisions, requests and sign-off"));
    assert.equal((await get(`/timeline/${id}/review`)).status, 403, "no token, no shell");
    assert.equal((await get(`/review/${id}?t=${TOKEN}`)).status, 404, "nothing is served under /review/");
    assert.equal((await get(`/review/${id}/decision?t=${TOKEN}`)).status, 404);
  });
});
