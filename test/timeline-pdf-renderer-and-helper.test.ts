import { after, afterEach, before, describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import { sceneOfBody } from "./helpers/v1-served.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { makePdf } from "./fixtures/make-pdf.ts";
import type { ChangeInfo, View } from "../src/timeline/render/types.ts";
import { ensurePdfHelper, pdfHelperForTest } from "../scripts/lib/pdf-helper-cache.ts";

// The PDF renderer, its helper and the page-image route. macOS only: the helper is built here with the system swiftc into a
// temp folder (which also tests scripts/build-helpers.mjs); nothing touches dist/ or the network.

const mac = process.platform === "darwin";
let scratch = ""; // temp dir for the build-script test; the helper itself comes from the shared cache
const info = (extra: Partial<ChangeInfo> = {}): ChangeInfo => ({ id: "c3", file: "doc.pdf", kind: "modified", ...extra });
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const body = (n: number, prefix: string): string[] => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1} of the contract text.`);
/** Three pages of 12 lines each. */
const doc = (page1: string[] = body(12, "Alpha"), figure = "Total fee: 1,200 USD"): string[][] => [[...page1], [...body(11, "Bravo"), figure], body(12, "Charlie")];

before(async () => {
  if (!mac) return;
  const helper = pdfHelperForTest(); // built once per run by scripts/run-tests.ts, else the shared cache
  assert.ok(helper, "the PDF helper could not be built");
  process.env.COCHECK_PDF_HELPER = helper;
  scratch = await mkdtemp(path.join(tmpdir(), "cocheck-pdf-scratch-"));
});
after(async () => {
  delete process.env.COCHECK_PDF_HELPER;
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("pdf renderer", { skip: !mac && "needs macOS" }, () => {
  it("an inserted paragraph on page 1 reflows every later page and boxes only the inserted lines, on the after side", async () => {
    const { pdfRenderer } = await import("../src/timeline/render/pdf.ts");
    const inserted = ["Inserted paragraph one.", "Inserted paragraph two.", "Inserted paragraph three."];
    const a = makePdf(doc());
    // every later line moves: 36 lines re-chunked into 12-line pages after three new lines at the top (a fourth page appears)
    const flat = [...inserted, ...doc().flat()];
    const b = makePdf([flat.slice(0, 12), flat.slice(12, 24), flat.slice(24, 36), flat.slice(36)]);
    const v = await pdfRenderer.view(a, b, info());
    assert.equal(v.kind, "pages");
    assert.equal(v.engine, "drawn by macOS PDFKit");
    assert.equal(v.boxes.length, 3, JSON.stringify(v.boxes));
    assert.ok(v.boxes.every((x) => x.side === "after" && x.confidence === "text-match" && x.pane === "after:page1" && x.rect!.w > 0 && x.rect!.h > 0));
    // The pages that only reflowed are shown, with no box, labelled as moved page breaks (they have no 1:1 partner)
    // change-first views: placeholders (absent) stand in where a page has no partner; the real pages are the same as before
    assert.deepEqual(v.before.filter((p) => !p.absent).map((p) => p.id), ["before:page1", "before:page2", "before:page3"]);
    assert.deepEqual(v.after.filter((p) => !p.absent).map((p) => p.id), ["after:page1", "after:page2", "after:page3", "after:page4"]);
    assert.ok(v.before.filter((p) => !p.absent).every((p) => /same text, page breaks moved/.test(p.label)));
    assert.equal(v.after[0]!.picture!.sha, sha(b));
    assert.equal(v.after[0]!.picture!.page, 1);
  });

  it("a changed figure is boxed on both sides, on its own page, and nothing else", async () => {
    const { pdfRenderer } = await import("../src/timeline/render/pdf.ts");
    const a = makePdf(doc());
    const b = makePdf(doc(undefined, "Total fee: 1,500 USD"));
    const v = await pdfRenderer.view(a, b, info());
    assert.equal(v.boxes.length, 2);
    assert.deepEqual(v.boxes.map((x) => `${x.side}:${x.pane}`).sort(), ["after:after:page2", "before:before:page2"]);
    assert.ok(v.boxes.every((x) => x.confidence === "text-match"));
    // the box is where the line is: page 2's last line, near the bottom of the text block, left margin 72pt at 2x = 144px
    const r = v.boxes[0]!.rect!;
    assert.ok(Math.abs(r.x - 144) < 4, JSON.stringify(r));
    assert.ok(v.caveats.some((c) => /whole document/.test(c)));
  });

  it("identical text with different bytes is an honest card, no box", async () => {
    const { pdfRenderer } = await import("../src/timeline/render/pdf.ts");
    const a = makePdf(doc());
    const b = Buffer.concat([a, Buffer.from("\n% trailing comment\n")]);
    const v = await pdfRenderer.view(a, b, info());
    // The pages are shown under a "No visible difference" banner, never "no picture"
    assert.equal(v.kind, "pages");
    assert.equal(v.banner?.title, "No visible difference");
    assert.deepEqual(v.boxes, []);
    assert.ok(v.before.length > 0 && v.after.length > 0);
  });

  it("a damaged PDF side is named and the readable side is drawn; both damaged is a card that says the reader could not read it", async () => {
    const { pdfRenderer } = await import("../src/timeline/render/pdf.ts");
    const v = await pdfRenderer.view(makePdf(doc()), Buffer.from("not a pdf at all"), info());
    assert.equal(v.kind, "pages");
    assert.ok(v.before.length > 0, "the readable before side is drawn");
    assert.deepEqual(v.after, []);
    assert.ok(v.caveats.some((c) => /^CoCheck could not open the after version of doc\.pdf \(the PDF reader could not open it\)/.test(c)), JSON.stringify(v.caveats));
    const both = await pdfRenderer.view(Buffer.from("junk"), Buffer.from("not a pdf at all"), info());
    assert.equal(both.kind, "card");
    assert.deepEqual(both.boxes, []);
    assert.ok(both.caveats.some((c) => /^CoCheck could not open the previous version of/.test(c)) && both.caveats.some((c) => /^CoCheck could not open the after version of/.test(c)));
  });

  it("a created PDF boxes its lines on the after side only; a missing side is a card", async () => {
    const { pdfRenderer } = await import("../src/timeline/render/pdf.ts");
    const b = makePdf([["Only line."]]);
    const v = await pdfRenderer.view(null, b, info({ kind: "created" }));
    assert.deepEqual(v.boxes.map((x) => x.side), ["after"]);
    const m = await pdfRenderer.view(null, b, info({ kind: "modified", missing: ["The before state is no longer in the store."] }));
    assert.equal(m.kind, "card");
    assert.ok(m.caveats.some((c) => /no longer in the store/.test(c)));
  });
});

describe("registry with and without the helper", { skip: !mac && "needs macOS" }, () => {
  it("registers .pdf when the helper exists and falls back when it does not", async () => {
    const { rendererFor, registeredExtensions } = await import("../src/timeline/render/registry.ts");
    const { fallbackRenderer } = await import("../src/timeline/render/fallback.ts");
    assert.equal(rendererFor("a/B.PDF").name, "pdfkit");
    assert.ok(registeredExtensions().includes(".pdf"));
    const saved = process.env.COCHECK_PDF_HELPER;
    process.env.COCHECK_PDF_HELPER = path.join(scratch, "does-not-exist");
    try {
      assert.equal(rendererFor("a.pdf"), fallbackRenderer);
      assert.ok(!registeredExtensions().includes(".pdf"));
    } finally {
      process.env.COCHECK_PDF_HELPER = saved;
    }
  });
});

describe("build script", { skip: !mac && "needs macOS" }, () => {
  it("exits 0 and builds nothing when swiftc is not on the path", () => {
    const out = path.join(scratch, "nope");
    const r = spawnSync("/bin/sh", ["-c", `exec "${process.execPath}" scripts/build-helpers.mjs "${out}"`], { encoding: "utf8", env: { PATH: "/nonexistent", HOME: process.env.HOME ?? "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /swiftc/);
    assert.equal(spawnSync("test", ["-e", path.join(out, "pdfpages")]).status, 1);
  });
});

describe("helper cache", { skip: !mac && "needs macOS" }, () => {
  it("a second ensurePdfHelper call is a hit that builds nothing and returns the same binary", () => {
    const lines: string[] = [];
    const first = ensurePdfHelper({ log: (l) => lines.push(l) });
    const second = ensurePdfHelper({ log: (l) => lines.push(l) });
    assert.ok(first && second);
    assert.equal(second, first);
    assert.match(lines[lines.length - 1]!, /cache hit .*swiftc builds this run: 0/);
  });
});

const TOKEN = "t".repeat(40);
const CLIENT = "claude:/work";
describe("route", { skip: !mac && "needs macOS" }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function setup() {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const ledger = openLedger(home);
    const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => null, quickLook: false });
    cleanups.push(async () => {
      await new Promise<void>((r) => (server as Server).close(() => r()));
      ledger.close();
      await rm(home, { recursive: true, force: true });
    });
    const get = (p: string, opts: { token?: string | null; host?: string; method?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: Buffer }> => {
      const token = opts.token === undefined ? TOKEN : opts.token;
      const url = token === null ? p : `${p}${p.includes("?") ? "&" : "?"}t=${token}`;
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, path: url, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.end();
      });
    };
    let seq = 0;
    const task = async (name: string, a: Buffer, b: Buffer): Promise<number> => {
      const id = ledger.openTask(CLIENT);
      const states = await ensureStoreDir(home, id);
      await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
      await writeSealed(path.join(states, sha(a)), a);
      await writeSealed(path.join(states, sha(b)), b);
      const file = `/work/${name}`;
      const callId = `toolu_${id}`;
      ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: [file], description: "edit", narration: { source: "none", text: "none" } } });
      ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Edit."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
      ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: file, sha256: sha(a), prevSha256: null, size: a.length, kept: "whole", note: "" }] });
      ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: file, sha256: sha(b), prevSha256: sha(a), size: b.length, kept: "whole", note: "" }] });
      return id;
    };
    const modifiedKey = async (id: number): Promise<string> => {
      const tl = JSON.parse((await get(`/timeline/${id}`)).raw.toString()) as { requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string; kind: string }> }> }> }> };
      return tl.requests[0]!.runs[0]!.calls[0]!.changes.find((c) => c.kind === "modified")!.id;
    };
    return { get, task, modifiedKey };
  }

  it("the view route boxes the changed figure and the page route serves that page as a PNG", async () => {
    const s = await setup();
    const a = makePdf(doc());
    const b = makePdf(doc(undefined, "Total fee: 1,500 USD"));
    const id = await s.task("doc.pdf", a, b);
    const key = await s.modifiedKey(id);
    const res = await s.get(`/timeline/${id}/view/${key}`);
    assert.equal(res.status, 200);
    const v = (await sceneOfBody(res.raw.toString())) as unknown as View & { boxes: Array<{ side: string }> };
    assert.equal(v.engine, "drawn by macOS PDFKit");
    assert.deepEqual(v.boxes.map((x) => x.side).sort(), ["after", "before"]);
    const pic = v.after[0]!.picture!;
    const img = await s.get(`/timeline/${id}/pdfpage/${pic.sha}/${pic.page}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers["content-type"], "image/png");
    // Page pictures stay uncached (no browser disk copy outlives the stored state); a refusal is no-store too
    assert.equal(img.headers["cache-control"], "private, no-store");
    assert.equal((await s.get(`/timeline/${id}/pdfpage/${"0".repeat(64)}/1`)).headers["cache-control"], "no-store");
    assert.equal(img.raw.subarray(1, 4).toString(), "PNG");
    assert.equal(img.raw.readUInt32BE(16), pic.width);
    assert.equal(img.raw.readUInt32BE(20), pic.height);
  });

  it("the page route refuses a bad token, foreign host, POST, a hash outside the task, a page outside the document, and a non-pdf or secret name", async () => {
    const s = await setup();
    const a = makePdf(doc());
    const b = makePdf(doc(undefined, "Total fee: 1,500 USD"));
    const id = await s.task("doc.pdf", a, b);
    const other = await s.task("notes.txt", Buffer.from("a"), Buffer.from("b"));
    const secret = await s.task("credentials.pdf", a, b);
    const p = `/timeline/${id}/pdfpage/${sha(b)}/1`;
    assert.equal((await s.get(p)).status, 200);
    assert.equal((await s.get(p, { token: null })).status, 403);
    assert.equal((await s.get(p, { host: "evil.example" })).status, 403);
    assert.equal((await s.get(p, { method: "POST" })).status, 405);
    assert.equal((await s.get(`/timeline/${id}/pdfpage/${"0".repeat(64)}/1`)).status, 404);
    assert.equal((await s.get(`/timeline/${id}/pdfpage/..%2F..%2Fx/1`)).status, 404);
    assert.equal((await s.get(`/timeline/${id}/pdfpage/${sha(b)}/99`)).status, 404);
    assert.equal((await s.get(`/timeline/${id}/pdfpage/${sha(b)}/0`)).status, 404);
    assert.equal((await s.get(`/timeline/${other}/pdfpage/${sha(Buffer.from("b"))}/1`)).status, 404);
    assert.equal((await s.get(`/timeline/${secret}/pdfpage/${sha(b)}/1`)).status, 404);
    assert.equal((await s.get(`/timeline/${other}/pdfpage/${sha(b)}/1`)).status, 404);
  });
});
