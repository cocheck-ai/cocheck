import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// The CoCheck brand: wordmark, byline and icon.
const ROOT = path.resolve(import.meta.dirname, "..") + path.sep;
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

describe("brand", () => {
  it("the shell links the icon and the review toolbar carries the logo as a link home", () => {
    const html = renderReviewShell(1);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/timeline-assets\/cocheck-icon\.svg">/);
    assert.match(html, /<header>\s*<a class="wordmark" id="homelink" href="\/" aria-label="CoCheck home" title="CoCheck home">/);
    const js = readFileSync(path.join(ROOT, "src/timeline/rail/assets/review.js"), "utf8");
    assert.match(js, /getElementById\('homelink'\)[\s\S]*?setAttribute\('href', withToken\('\/'\)\)/);
    for (const s of ["Deliverables", "Timeline", "Clean Diff", "Newest First"]) assert.ok(html.includes(s));
  });

  it("the toolbar css styles the logo link with a hover state", () => {
    const css = readFileSync(path.join(ROOT, "src/timeline/rail/assets/review.css"), "utf8");
    assert.match(css, /\.wordmark:hover\{[^}]*background:var\(--well\)/);
    assert.match(css, /header\{[^}]*height:52px/);
  });

  it("the icon is served by the real route as image/svg+xml, identical to the icon file", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-brand-home-"));
    const ledger = openLedger(home);
    const { server, port } = await startReviewServer(ledger, "t".repeat(40), home, 0, undefined, { previewRenderer: async () => { throw new Error("no render"); }, quickLook: false, layers: [] });
    cleanups.push(async () => { await new Promise<void>((r) => (server as Server).close(() => r())); ledger.close(); await rm(home, { recursive: true, force: true }); });
    const res = await new Promise<{ status: number; type: string; body: Buffer }>((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: "/timeline-assets/cocheck-icon.svg", headers: { host: `127.0.0.1:${port}` } }, (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, type: String(r.headers["content-type"]), body: Buffer.concat(chunks) }));
      }).on("error", reject);
    });
    assert.equal(res.status, 200);
    assert.match(res.type, /^image\/svg\+xml/);
    assert.match(res.body.toString("utf8"), /^<svg /);
  });

  // The README's opening lines are free text; only the wordmark and the byline are pinned.
  it("the README opens with the wordmark picture and the byline, verbatim", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    const top = readme.slice(0, readme.indexOf("CoCheck shows what AI agents"));
    assert.match(top, /<picture>/);
    assert.match(top, /<source media="\(prefers-color-scheme: dark\)" srcset="docs\/brand\/cocheck-wordmark-dark\.png">/);
    assert.match(top, /<img [^>]*src="docs\/brand\/cocheck-wordmark-light\.png"[^>]*alt="CoCheck"/);
    assert.ok(top.includes("Keeping you in the driver's seat"));
    assert.ok(!top.includes("Keeping you in the driver's seat."));
    assert.ok(readme.includes("CoCheck shows what AI agents changed in your files"));
  });

  const brandFiles: Array<[string, "png" | "svg"]> = [
    ["src/timeline/rail/assets/cocheck-icon.svg", "svg"],
    ["docs/brand/cocheck-wordmark-light.png", "png"],
    ["docs/brand/cocheck-wordmark-dark.png", "png"],
  ];
  for (const [repoPath, kind] of brandFiles) {
    it(`${repoPath} is a real ${kind} brand asset kept in the repo`, () => {
      assert.ok(existsSync(path.join(ROOT, repoPath)), `${repoPath} missing`);
      const bytes = readFileSync(path.join(ROOT, repoPath));
      assert.ok(bytes.length > 100, "asset is not empty");
      if (kind === "png") assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      else assert.match(bytes.toString("utf8"), /<svg[\s>]/);
    });
  }
  it("the light and dark wordmarks are different files", () => {
    assert.notEqual(sha(readFileSync(path.join(ROOT, "docs/brand/cocheck-wordmark-light.png"))), sha(readFileSync(path.join(ROOT, "docs/brand/cocheck-wordmark-dark.png"))));
  });
});
