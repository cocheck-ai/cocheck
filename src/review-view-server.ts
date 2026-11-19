// The second loopback listener: vendor html and image payloads are drawn in a sandboxed frame that points here, never at the review origin.
// Structural rule: isolation comes from the separate origin (its own port) plus the iframe sandbox plus this CSP, never from sanitizing the markup.
// The markup is served byte for byte. This listener holds no token, no cookie and no route but one one-time view id, so a view has nothing to read or reach.
import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Payload } from "./connector/diff-object.ts";

export const VIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
export const MAX_HTML_BYTES = 512 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 300;

/** What a payload becomes: a served document, or the reason it is not drawn. */
export type Prepared = { ok: true; html: string } | { ok: false; reason: string };

function rasterMime(b: Buffer): string | undefined {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

/** Decides how a html or image payload is shown. An image value is a base64 string or a base64 `data:` URL; a raster is shown only after a magic-number check (no re-encode: a stated gap). */
export function prepareFramePayload(p: Payload): Prepared {
  if (p.type === "html") {
    if (typeof p.value !== "string") return { ok: false, reason: "the html is not text" };
    const n = Buffer.byteLength(p.value);
    return n > MAX_HTML_BYTES ? { ok: false, reason: `the html is ${n} bytes, over the ${MAX_HTML_BYTES} byte limit` } : { ok: true, html: p.value };
  }
  if (p.type !== "image") return { ok: false, reason: "the content is not html or an image" };
  if (typeof p.value !== "string") return { ok: false, reason: "the image is not a base64 string" };
  // Cap before decoding: base64 is 4 chars per 3 bytes.
  if (p.value.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 256) return { ok: false, reason: `the image is over the ${MAX_IMAGE_BYTES} byte limit` };
  const m = /^data:([^;,]*)(;base64)?,/i.exec(p.value);
  const raw = m === null ? p.value : p.value.slice(m[0].length);
  let bytes: Buffer;
  try { bytes = m !== null && m[2] === undefined ? Buffer.from(decodeURIComponent(raw), "latin1") : Buffer.from(raw, "base64"); }
  catch { return { ok: false, reason: "the image data is malformed" }; }
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: `the image is ${bytes.length} bytes, over the ${MAX_IMAGE_BYTES} byte limit` };
  // SVG is markup: it is served as html under the same CSP, with the html cap.
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!doctype svg") || (m !== null && /svg/i.test(m[1] ?? ""))) {
    return bytes.length > MAX_HTML_BYTES ? { ok: false, reason: `the svg is ${bytes.length} bytes, over the ${MAX_HTML_BYTES} byte limit` } : { ok: true, html: bytes.toString("utf8") };
  }
  const mime = rasterMime(bytes);
  if (mime === undefined) return { ok: false, reason: "the image is not a PNG, JPEG, GIF or WebP file" };
  return { ok: true, html: `<!doctype html><meta charset="utf-8"><body style="margin:0"><img alt="" src="data:${mime};base64,${bytes.toString("base64")}">` };
}

export interface ViewServer {
  server: http.Server;
  port: number;
  /** The exact origin the page's frame-src names. */
  origin: string;
  /** Stores a document under an unguessable content id (HMAC under a per-server key: same document, same id) and returns the frame's src. */
  mint(html: string): string;
  /** How many minted views are stored. */
  pending(): number;
}

export function startViewServer(): Promise<ViewServer> {
  const views = new Map<string, string>(); // insertion order is the LRU order
  const key = randomBytes(32);
  let port = 0;
  const server = http.createServer((req, res) => {
    const deny = (code: number) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(); };
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return deny(403);
    if (req.method !== "GET") return deny(405);
    const m = /^\/v\/([0-9a-f]{32})$/.exec(req.url ?? "");
    const body = m === null ? undefined : views.get(m[1]!);
    if (m === null || body === undefined) return deny(404);
    views.delete(m[1]!); views.set(m[1]!, body); // reusable; refresh its place in the LRU
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": VIEW_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      port = (server.address() as AddressInfo).port;
      const origin = `http://127.0.0.1:${port}`;
      resolve({
        server, port, origin,
        mint(html) {
          const id = createHmac("sha256", key).update(html).digest("hex").slice(0, 32);
          views.delete(id); views.set(id, html);
          while (views.size > MAX_PENDING) views.delete(views.keys().next().value as string);
          return `${origin}/v/${id}`;
        },
        pending: () => views.size,
      });
    });
  });
}

// The running review process has one view server; the serve boundary (handleView) reads it here to mint a connector's html pictures.
let active: ViewServer | undefined;
export function setActiveViewServer(v: ViewServer | undefined): void { active = v; }
export function activeViewServer(): ViewServer | undefined { return active; }
