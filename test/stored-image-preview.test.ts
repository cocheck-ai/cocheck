import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { writeSealed } from "../src/seal.ts";
import { ensureStoreDir } from "../src/states.ts";

// Image states are shown by the browser from the stored bytes, by content hash, on every OS, with no
// renderer. Guard: an SVG or a mislabelled file running script in the page's origin, vs an image that shows no picture.

const TOKEN = "t".repeat(40);
const CLIENT = "claude:/work";
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const SVG_WITH_SCRIPT = `<svg xmlns="http://www.w3.org/2000/svg"><script>document.title="PWNED"</script><rect width="9" height="9"/></svg>`;
const HTML_AS_PNG = `<html><script>alert(1)</script></html>`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const ledger: Ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0);
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as http.Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  let seq = 0;
  const task = async (name: string, before: string, after: string): Promise<{ id: number; before: string; after: string }> => {
    const id = ledger.openTask(CLIENT);
    const states = await ensureStoreDir(home, id);
    await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
    for (const t of [before, after]) await writeSealed(path.join(states, sha(t)), Buffer.from(t));
    const file = `/work/${name}`;
    const callId = `toolu_${id}`;
    ledger.recordOp({ taskId: id, tool: "Bash", intent: "make it", clientName: CLIENT, durationMs: 1, resultCode: "OK",
      args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: [file], description: "make it", narration: { source: "none", text: "none" } } });
    ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: file, sha256: sha(before), prevSha256: null, size: before.length, kept: "whole", note: "" }] });
    ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: file, sha256: sha(after), prevSha256: sha(before), size: after.length, kept: "whole", note: "" }] });
    return { id, before: sha(before), after: sha(after) };
  };
  const get = (p: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: `${p}${p.includes("?") ? "&" : "?"}t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
  return { home, task, get };
}

describe("image states are served from the store, by hash, to the browser", () => {
  const types: Array<[string, string]> = [["a.png", "image/png"], ["a.jpg", "image/jpeg"], ["a.JPEG", "image/jpeg"], ["a.gif", "image/gif"], ["a.webp", "image/webp"], ["a.svg", "image/svg+xml"]];
  for (const [name, type] of types) {
    it(`${name}: the stored bytes, ${type}, nosniff, locked-down CSP, one code path`, async () => {
      const s = await setup();
      const t = await s.task(name, "\0before-bytes", "\0after-bytes");
      const res = await s.get(`/timeline/${t.id}/preview/${t.after}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-type"], type);
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.match(res.headers["content-security-policy"] as string, /default-src 'none'/);
      assert.match(res.headers["content-security-policy"] as string, /sandbox/);
      assert.equal(res.body, "\0after-bytes");
      const page = await s.get(`/timeline/${t.id}/page`);
      assert.match(page.body, new RegExp(`<img src="/timeline/${t.id}/preview/${t.after}\\?t=`), "the page draws the stored state through an img element");
      assert.match(page.body, new RegExp(`<img src="/timeline/${t.id}/preview/${t.before}\\?t=`));
      assert.ok(!existsSync(path.join(s.home, "tasks", String(t.id), "previews")), "no cache was made");
    });
  }

  it("an SVG holding a script is only ever an img source, never inlined, and is served sandboxed", async () => {
    const s = await setup();
    const t = await s.task("evil.svg", "<svg/>", SVG_WITH_SCRIPT);
    const page = await s.get(`/timeline/${t.id}/page`);
    assert.equal(page.status, 200);
    console.log(page.body.slice(page.body.indexOf("<h4>")));
assert.ok(!page.body.includes("<script>document"), "the SVG's script is in the page as markup");
    assert.ok(!/<svg\b/i.test(page.body), "an svg element is in the page");
    assert.ok(!/<(object|embed|iframe)\b/i.test(page.body));
    assert.match(page.body, /<img src="[^"]*\/preview\//);
    const res = await s.get(`/timeline/${t.id}/preview/${t.after}`);
    assert.equal(res.headers["content-type"], "image/svg+xml");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(res.headers["content-security-policy"] as string, /sandbox/);
  });

  it("a mislabelled file (HTML named .png) is served as image/png with nosniff, never as HTML", async () => {
    const s = await setup();
    const t = await s.task("fake.png", "<b>x</b>", HTML_AS_PNG);
    const res = await s.get(`/timeline/${t.id}/preview/${t.after}`);
    assert.equal(res.headers["content-type"], "image/png");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.doesNotMatch(String(res.headers["content-type"]), /html/);
  });

  it("a secret-named image is never served, whatever the hash asked", async () => {
    const s = await setup();
    const t = await s.task("credentials.png", "one", "two");
    assert.equal((await s.get(`/timeline/${t.id}/preview/${t.after}`)).status, 404);
    assert.equal((await s.get(`/timeline/${t.id}/preview/${t.before}`)).status, 404);
  });

  it("the opposite miss - an image the person can open shows a picture (not a fingerprint) on this OS", async () => {
    const s = await setup();
    const t = await s.task("shot.png", "\0p1", "\0p2");
    const page = await s.get(`/timeline/${t.id}/page`);
    assert.match(page.body, /<img /);
    assert.doesNotMatch(page.body, /macOS|Quick Look/);
  });

  it("any other file type keeps the fingerprint card, naming no OS, with no route", async () => {
    const s = await setup();
    const t = await s.task("data.bin", "\0one", "\0two");
    const page = await s.get(`/timeline/${t.id}/page`);
    assert.doesNotMatch(page.body, /<img /);
    assert.match(page.body, /fingerprint|Kind/i);
    assert.doesNotMatch(page.body, /macOS|Quick Look/);
    assert.equal((await s.get(`/timeline/${t.id}/preview/${t.after}`)).status, 404);
  });
});

describe("no OS branch and no old wording in the preview path", () => {
  const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  it("the preview path has no process.platform, qlmanage or Quick Look string", () => {
    for (const f of ["timeline/stored-image.ts", "timeline/picture.ts", "timeline/timeline.ts", "timeline/load.ts", "timeline/render/fallback.ts"]) {
      const text = read(f);
      assert.doesNotMatch(text, /process\.platform/, f);
      assert.doesNotMatch(text, /qlmanage|rendered on macOS only|Quick Look/, f);
    }
    assert.ok(!existsSync(new URL("../src/timeline/preview.ts", import.meta.url)), "the Quick Look renderer is gone");
  });
});
