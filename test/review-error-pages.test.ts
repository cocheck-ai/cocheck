import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";

// An address a person can land on in a browser (a wrong or missing token, a task that
// is not on this computer, an unknown address) answers with a plain page in the review page's own styling and plain words, never raw JSON.
// A caller that does not ask for a page (the review page's own fetches, scripts, curl) keeps the JSON answer, so nothing that reads it breaks.
const TOKEN = "t".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-errpage-home-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => { throw new Error("no render"); }, quickLook: false });
  cleanups.push(async () => { await new Promise<void>((r) => (server as Server).close(() => r())); ledger.close(); await rm(home, { recursive: true, force: true }); });
  const id = ledger.openTask("claude:/work");
  const get = (p: string, accept?: string) => new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: p, method: "GET", headers: { host: `127.0.0.1:${port}`, ...(accept ? { accept } : {}) } }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body }));
    });
    req.on("error", reject); req.end();
  });
  return { id, get };
}
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

describe("error pages a person can land on", () => {
  it("a wrong or missing token on a review page is a plain page: what happened and the one command that fixes it", async () => {
    const { id, get } = await setup();
    for (const p of [`/timeline/${id}/review?t=wrong`, `/timeline/${id}/review`, `/?t=wrong`]) {
      const r = await get(p, BROWSER);
      assert.equal(r.status, 403, p);
      assert.match(r.type, /^text\/html/, p);
      assert.match(r.body, /<h1>This link has expired<\/h1>/, p);
      assert.match(r.body, /Run <code>cocheck open<\/code> in your terminal to open a fresh one\./, p);
      assert.doesNotMatch(r.body, /\{"error"|missing or wrong token/, `${p}: no raw JSON`);
      assert.match(r.body, /--font:/, "the page carries the review page's tokens");
    }
  });
  it("a task that is not on this computer, and an unknown address, are plain pages too", async () => {
    const { get } = await setup();
    const t = await get(`/timeline/999/review?t=${TOKEN}`, BROWSER);
    assert.equal(t.status, 404); assert.match(t.type, /^text\/html/);
    assert.match(t.body, /<h1>Task 999 isn&#39;t on this computer<\/h1>/);
    assert.doesNotMatch(t.body, /\{"error"/);
  });
  it("a caller that does not ask for a page still gets JSON (the page's own fetches, scripts)", async () => {
    const { id, get } = await setup();
    for (const accept of [undefined, "*/*", "application/json"]) {
      const r = await get(`/timeline/${id}/review/model?t=wrong`, accept);
      assert.equal(r.status, 403); assert.match(r.type, /^application\/json/, String(accept));
      assert.deepEqual(JSON.parse(r.body), { error: "missing or wrong token" });
      const n = await get(`/timeline/999/review/model?t=${TOKEN}`, accept);
      assert.equal(n.status, 404); assert.deepEqual(JSON.parse(n.body), { error: "not found" });
    }
  });
  it("the page escapes what it is given (no markup from a path)", async () => {
    const { renderErrorPage } = await import("../src/timeline/rail/page.ts");
    const html = renderErrorPage("<b>x</b>", "a <script> b", "<script>");
    assert.doesNotMatch(html, /<b>x<\/b>|<script>/);
    assert.match(html, /<code>&#60;script&#62;<\/code>/);
  });
});
