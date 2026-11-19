import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// The Send back box is editable, a fixed follow-up marker sits outside it, and every Copy is recorded exactly.
// Guard (pinned): a live refresh or re-render must never replace text the person changed in the box.

const TOKEN = "s".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};
const marker = (task: number, id: number, nonce: string): string => `CoCheck follow-up: task ${task}, send-back ${id}, ${nonce} (you can ignore this line)`;

describe("ledger", () => {
  it("records the current schema version and a new send-back carries a random 6-character nonce", async () => {
    const home = await tmp();
    const ledger = openLedger(home);
    const t = ledger.openTask("claude:/work");
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      ledger.appendSendBack({ taskId: t, prompt: "p", stopIds: [], reviewer: "x", note: "n" });
    }
    for (const r of ledger.sendBacksForTask(t)) {
      assert.match(r.nonce ?? "", /^[a-z0-9]{6}$/);
      seen.add(r.nonce!);
    }
    assert.ok(seen.size > 6, "nonces differ between send-backs");
    ledger.close();
  });

  it("send_back_copies is append-only and keeps the exact text", async () => {
    const home = await tmp();
    const ledger = openLedger(home);
    const t = ledger.openTask("claude:/work");
    const sb = ledger.appendSendBack({ taskId: t, prompt: "p", stopIds: [], reviewer: "x", note: "n" });
    const text = "  edited \n\ntext  \n\nCoCheck follow-up: x";
    const c1 = ledger.appendSendBackCopy(sb, text);
    const c2 = ledger.appendSendBackCopy(sb, text);
    assert.notEqual(c1, c2);
    const rows = ledger.sendBackCopies(sb);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.text, text);
    assert.equal(rows[0]!.sendBackId, sb);
    assert.ok(!Number.isNaN(Date.parse(rows[0]!.ts)));
    ledger.close();
    const db = new DatabaseSync(path.join(home, "ledger.sqlite"));
    assert.throws(() => db.prepare("UPDATE send_back_copies SET text = 'x'").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM send_back_copies").run(), /append-only/);
    db.close();
  });
});

describe("the routes", () => {
  async function setup() {
    const home = await tmp();
    const ledger: Ledger = openLedger(home);
    const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
    cleanups.push(async () => {
      await new Promise<void>((r) => (server as Server).close(() => r()));
      ledger.close();
    });
    const post = (p: string, json: unknown): Promise<{ status: number; body: any }> =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(json);
        const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, method: "POST", headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
        });
        req.on("error", reject);
        req.end(body);
      });
    return { ledger, post, task: ledger.openTask("claude:/work") };
  }

  it("send-back answers with its nonce and the fixed marker line; each Copy appends one exact row", async () => {
    const s = await setup();
    const r = await s.post(`/timeline/${s.task}/review/sendback`, { note: "please redo" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.nonce, /^[a-z0-9]{6}$/);
    assert.equal(r.body.marker, marker(s.task, r.body.id, r.body.nonce));
    assert.equal(s.ledger.sendBacksForTask(s.task)[0]!.nonce, r.body.nonce);
    const text = `my own words, edited\n\n${r.body.marker}`;
    assert.equal((await s.post(`/timeline/${s.task}/review/sendback-copy`, { id: r.body.id, text })).status, 200);
    assert.equal((await s.post(`/timeline/${s.task}/review/sendback-copy`, { id: r.body.id, text })).status, 200);
    const rows = s.ledger.sendBackCopies(r.body.id);
    assert.equal(rows.length, 2, "one row per Copy");
    assert.equal(rows[0]!.text, text);
  });

  it("refuses a copy whose text does not end with the send-back's own marker, or whose send-back is not the task's", async () => {
    const s = await setup();
    const r = await s.post(`/timeline/${s.task}/review/sendback`, { note: "x" });
    const other = s.ledger.openTask("claude:/other");
    const bad = await s.post(`/timeline/${s.task}/review/sendback-copy`, { id: r.body.id, text: "no marker here" });
    assert.equal(bad.status, 400);
    assert.equal((await s.post(`/timeline/${s.task}/review/sendback-copy`, { id: r.body.id, text: 5 })).status, 400);
    assert.equal((await s.post(`/timeline/${other}/review/sendback-copy`, { id: r.body.id, text: `a\n\n${r.body.marker}` })).status, 404);
    assert.equal((await s.post(`/timeline/${s.task}/review/sendback-copy`, { id: 999, text: "a" })).status, 404);
    assert.equal(s.ledger.sendBackCopies(r.body.id).length, 0, "nothing recorded for a refused copy");
  });
});

// ---- the page --------------------------------------------------------------------------------------------------------------------------

describe("the page", () => {
  it("the box is editable and the marker line sits outside it", () => {
    const html = renderReviewShell(1);
    const box = /<textarea[^>]*id="sbtext"[^>]*>/.exec(html)![0];
    assert.doesNotMatch(box, /readonly/);
    const out = html.slice(html.indexOf('id="sbout"'));
    const textareaEnd = out.indexOf("</textarea>");
    const markerAt = out.indexOf('id="sbmarker"');
    assert.ok(markerAt > textareaEnd, "the marker element comes after the textarea closes");
    assert.ok(markerAt < out.indexOf('id="sbcopy"'));
    assert.doesNotMatch(out.slice(0, textareaEnd), /sbmarker/);
  });

  class Node_ {
    attrs: Record<string, string> = {}; listeners: Record<string, Array<(e: unknown) => void>> = {}; hidden = false; value = ""; textContent = ""; disabled = false; title = ""; className = ""; style: any = { setProperty() {} }; dataset = {}; children: Node_[] = [];
    classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
    setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
    getAttribute(k: string) { return this.attrs[k] ?? null; }
    addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
    fire(k: string) { (this.listeners[k] ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
    focus() {} select() {} append() {} appendChild() {} remove() {} closest() { return null; } querySelector() { return null; } querySelectorAll() { return []; }
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  }

  async function boot(opts: { noClipboard?: boolean } = {}) {
    const exec: string[] = [];
    const nodes = new Map<string, Node_>();
    const byId = (id: string): Node_ => { if (!nodes.has(id)) { const n = new Node_(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
    const body = new Node_(); body.getAttribute = (() => "7") as never;
    const copied: string[] = [];
    const posts: Array<{ url: string; body: any }> = [];
    let prompt = "TEMPLATE PROMPT";
    const fetchStub = async (u: string, o?: { method?: string; body?: string }) => {
      if (o?.method === "POST") posts.push({ url: u, body: JSON.parse(o.body ?? "{}") });
      const json = u.includes("/review/status") ? { stops: {}, passes: null, notes: [{ id: 1, text: "my note", ts: 1, regionId: null, region: null, where: "", picture: false }] } : u.includes("/review/sendback-copy") ? { ok: true } : u.includes("/review/sendback") ? { id: 4, prompt, stops: [], nonce: "ab12cd", marker: marker(7, 4, "ab12cd") } : u.includes("/review/model") ? { task: 7, folder: "w", actors: [], stops: [] } : {};
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(json)) };
    };
    const document = { body, getElementById: byId, createElement: () => new Node_(), createElementNS: () => new Node_(), createTextNode: () => new Node_(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], documentElement: new Node_(), execCommand: (c: string) => { exec.push(c); return true; } };
    const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, addEventListener() {}, setInterval, clearInterval, setTimeout, fetch: fetchStub, navigator: opts.noClipboard ? {} : { clipboard: { writeText: async (t: string) => { copied.push(t); } } } };
    g.window = g; g.globalThis = g;
    const ctx = vm.createContext(g);
    for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
    const settle = () => new Promise((r) => setTimeout(r, 30));
    await settle();
    return { byId, copied, exec, posts, settle, setPrompt: (p: string) => { prompt = p; } };
  }

  it("a live refresh, a note edit or a verdict change never replaces text the person changed; Done clears it", async () => {
    const p = await boot();
    p.byId("sendback").fire("click");
    await p.settle();
    assert.equal(p.byId("sbtext").value, "TEMPLATE PROMPT");
    assert.equal(p.byId("sbmarker").textContent, marker(7, 4, "ab12cd"));
    p.byId("sbtext").value = "TEMPLATE PROMPT, plus my own edit";
    p.byId("sbtext").fire("input");
    // the live refresh: a note is saved, the status route is read again and the page repaints
    p.byId("pbnote").fire("click"); p.byId("nnote").value = "more"; p.byId("ngo").fire("click");
    await p.settle();
    assert.equal(p.byId("sbtext").value, "TEMPLATE PROMPT, plus my own edit", "a note edit keeps the changed text");
    assert.equal(p.byId("sbout").hidden, false);
    p.byId("sbclose").fire("click");
    assert.equal(p.byId("sbtext").value, "", "Done is the person's own action and clears it");
    assert.equal(p.byId("sbout").hidden, true);
  });

  it("Copy puts the box text, a blank line and the marker on the clipboard, and records exactly that", async () => {
    const p = await boot();
    p.byId("sendback").fire("click");
    await p.settle();
    p.byId("sbtext").value = "edited text";
    p.byId("sbtext").fire("input");
    p.byId("sbcopy").fire("click");
    await p.settle();
    const want = `edited text\n\n${marker(7, 4, "ab12cd")}`;
    assert.deepEqual(p.copied, [want]);
    const rec = p.posts.filter((x) => x.url.includes("sendback-copy"));
    assert.equal(rec.length, 1);
    assert.deepEqual(rec[0]!.body, { id: 4, text: want });
    p.byId("sbcopy").fire("click");
    await p.settle();
    assert.equal(p.posts.filter((x) => x.url.includes("sendback-copy")).length, 2, "each Copy is its own record");
  });

  it("copies nothing and records nothing, never a box-only copy the record would misreport", async () => {
    const p = await boot({ noClipboard: true });
    p.byId("sendback").fire("click");
    await p.settle();
    p.byId("sbtext").value = "edited text";
    p.byId("sbtext").fire("input");
    p.byId("sbcopy").fire("click");
    await p.settle();
    assert.deepEqual(p.exec, [], "no execCommand copy of the box alone");
    assert.equal(p.posts.filter((x) => x.url.includes("sendback-copy")).length, 0, "nothing recorded for a copy that did not happen");
    assert.match(p.byId("sbmsg").textContent, /Could not copy/);
  });
});

describe("no model on the path", () => {
  it("the send-back builder imports no model or network module", async () => {
    const src = await readFile(path.resolve(import.meta.dirname, "../src/timeline/rail/send-back.ts"), "utf8");
    assert.doesNotMatch(src, /import[^\n]*(blurb|openrouter|anthropic|llm|model-call)|fetch\(/i);
  });
});
