import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { writeSealed } from "../src/seal.ts";
import { decodePng } from "../src/timeline/render/png-crop.ts";
import { regionsById, regionsForVerdict } from "../src/timeline/rail/regions.ts";
import { encodePng } from "./fixtures/png-encode.ts";
import { PRODUCTION_BUILTIN_CONNECTORS, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";

// The region route, the server-side crop, the record and the links.
// The PDF page picture comes from a stand-in PDFKit helper (macOS only, so the PDF tests skip elsewhere); every pixel of a stand-in picture is
// [marker * 16 + page, x, y, 255], so a crop of the wrong state or the wrong place cannot match. Guarded against: the picture is never of a
// version other than the one the change key and side name.

const TOKEN = "t".repeat(40);
const mac = process.platform === "darwin";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);
const pdf = (m: number): Buffer => Buffer.from(`%PDF-1.4\n%MARK:${m}\n`);
// an image state is cut from its stored bytes, so the stored art is the stamped picture itself (100 by 100, stamped with its marker).
const art = (m: number): Buffer => stamped(100, 100, m);
const book = (v: number): Buffer => Buffer.from(zipSync({
  "xl/workbook.xml": enc(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
  "xl/_rels/workbook.xml.rels": enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
  "xl/worksheets/sheet1.xml": enc(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>${v}</v></c><c r="B1"><v>${v * 10}</v></c></row></sheetData></worksheet>`),
}, { mtime: new Date(2020, 0, 1) }));
const text = (v: number): Buffer => Buffer.from(`line one v${v}\nline two v${v}\nline three v${v}\nline four v${v}\n`);

/** A picture whose pixel (x, y) is [r, x, y, 255]. */
const stamped = (w: number, h: number, r: number): Buffer => {
  const raw = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r & 255, x, y, 255], (y * w + x) * 4);
  return encodePng({ width: w, height: h, colorType: 6, raw });
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
let scratch = "";
before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "cocheck-fake-"));
  for (const m of [0, 1, 2, 3]) for (const n of [1, 2]) await writeFile(path.join(scratch, `page-${m}-${n}.png`), stamped(80, 60, m * 16 + n));
  const script = path.join(scratch, "fake.mjs");
  await writeFile(script, `import { readFileSync, copyFileSync } from "node:fs";\nconst [file, flag, n, out] = process.argv.slice(2);\nif (flag === "--png") { const m = /%MARK:(\\d+)/.exec(readFileSync(file, "latin1"))[1]; copyFileSync(${JSON.stringify(scratch)} + "/page-" + m + "-" + n + ".png", out); } else console.log(JSON.stringify({ pages: [] }));\n`);
  const helper = path.join(scratch, "fake-pdfpages");
  await writeFile(helper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  await chmod(helper, 0o755);
  process.env.COCHECK_PDF_HELPER = helper;
});

interface Chg { id: string; file: string; kind: string; before: { sha256: string } | null; after: { sha256: string } }

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, {});
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const call = (method: string, p: string, o: { token?: string | null; origin?: string | null; host?: string; json?: unknown; raw?: string; type?: string | null } = {}): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> => {
    const token = o.token === undefined ? TOKEN : o.token;
    const url = token === null ? p : `${p}?t=${token}`;
    const body = o.raw ?? (o.json === undefined ? undefined : JSON.stringify(o.json));
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${port}` };
    if (body !== undefined && o.type !== null) headers["content-type"] = o.type ?? "application/json";
    const origin = o.origin === undefined ? `http://127.0.0.1:${port}` : o.origin;
    if (origin !== null) headers.origin = origin;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: url, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
  /**
   * One task. Step 1 creates doc.pdf (v1), art.png (v1), notes.txt, book.xlsx and .env; step 2 changes art, notes and book and doc.pdf (v2);
   * step 3 changes doc.pdf (v3); step 4 deletes doc.pdf. doc.pdf has four changes: created, modified, modified, deleted.
   */
  const task = async (name = "a", office = false): Promise<number> => {
    const work = path.join(home, "work", name);
    await mkdir(work, { recursive: true });
    const client = `claude-hook:${work}`;
    const id = ledger.openTask(client);
    const states = await ensureStoreDir(home, id);
    const callId = `toolu_${id}`;
    const f = (n: string) => path.join(work, n);
    ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit", clientName: client, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: ["doc.pdf", "art.png", "notes.txt", "book.xlsx", ".env"].map(f), description: "write", narration: { source: "none", text: "none" } } });
    ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: client, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Make files."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
    const env = Buffer.from("API_KEY=sk-live-SECRETVALUE\n");
    for (const b of [pdf(1), pdf(2), pdf(3), art(1), art(2), text(1), text(2), book(1), book(2), env]) await writeSealed(path.join(states, sha(b)), b);
    const st = (file: string, b: Buffer, prev: Buffer | null) => ({ filePath: f(file), sha256: sha(b), prevSha256: prev === null ? null : sha(prev), size: b.length, kept: "whole" as const, note: "" });
    const step = (seq: number, files: Array<ReturnType<typeof st> | { filePath: string; sha256: string; prevSha256: string; size: number; kept: "gone"; note: string }>) => ledger.recordStep({ taskId: id, client, seq, phase: "Post", callsOpen: [callId], credited: [callId], files });
    step(1, [st("doc.pdf", pdf(1), null), st("art.png", art(1), null), st("notes.txt", text(1), null), st("book.xlsx", book(1), null), st(".env", env, null)]);
    step(2, [st("doc.pdf", pdf(2), pdf(1)), st("art.png", art(2), art(1)), st("notes.txt", text(2), text(1)), st("book.xlsx", book(2), book(1))]);
    step(3, [st("doc.pdf", pdf(3), pdf(2))]);
    step(4, [{ filePath: f("doc.pdf"), sha256: "", prevSha256: sha(pdf(3)), size: 0, kept: "gone", note: "" }]);
    if (office) {
      // Office files (and the LibreOffice removal): a memo and a deck, created in step 5.
      const docx = Buffer.from("PK\u0003\u0004 memo docx bytes"), pptx = Buffer.from("PK\u0003\u0004 deck pptx bytes");
      for (const b of [docx, pptx]) await writeSealed(path.join(states, sha(b)), b);
      step(5, [st("memo.docx", docx, null), st("deck.pptx", pptx, null)]);
    }
    return id;
  };
  const changes = async (id: number): Promise<Chg[]> => {
    const t = JSON.parse((await call("GET", `/timeline/${id}`)).body.toString("utf8")) as { unplaced: Chg[]; requests: Array<{ runs: Array<{ calls: Array<{ changes: Chg[] }> }> }> };
    return [...t.unplaced, ...t.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))];
  };
  const region = (id: number, json: unknown, o: Parameters<typeof call>[2] = {}) => call("POST", `/timeline/${id}/review/region`, { json, ...o });
  const regionsDir = (id: number) => path.join(home, "tasks", String(id), "regions");
  const files = (id: number): string[] => (existsSync(regionsDir(id)) ? readdirSync(regionsDir(id)) : []);
  return { home, ledger, call, task, changes, region, regionsDir, files, port };
}
type S = Awaited<ReturnType<typeof setup>>;

const answer = (r: { body: Buffer }) => JSON.parse(r.body.toString("utf8")) as { id: number; where: string; picture: boolean; error?: string };
const RECT = [0.25, 0.5, 0.5, 0.25] as const;

/** The marker of the pdf pass a change shows: its after state's, found by hash. */
const markerOf = (c: Chg, side: "before" | "after"): number | null => {
  const s = side === "before" ? c.before?.sha256 : c.after.sha256;
  return [1, 2, 3].find((m) => s === sha(pdf(m))) ?? null;
};

describe("the region route cuts the version the change key and side name", { skip: !mac && "needs macOS" }, () => {
  it("UNIVERSE: every change of a four-pass pdf (created, modified, modified, deleted) on both sides: the picture is that state's, cut at the asked place, plain, 0600", async () => {
    const s = await setup();
    const id = await s.task();
    const pdfs = (await s.changes(id)).filter((c) => c.file.endsWith("doc.pdf"));
    assert.deepEqual(pdfs.map((c) => c.kind).sort(), ["created", "deleted", "modified", "modified"]);
    let made = 0;
    for (const c of pdfs) {
      for (const side of ["before", "after"] as const) {
        const m = markerOf(c, side);
        const before = s.ledger.regionsForTask(id).length;
        const r = await s.region(id, { change: c.id, side, kind: "picture", page: 2, rect: RECT });
        if (m === null) {
          // created has no before; deleted has no after: no picture, no row, no file
          assert.equal(r.status, 404, `${c.kind} ${side}`);
          assert.equal(s.ledger.regionsForTask(id).length, before);
          continue;
        }
        assert.equal(r.status, 200, `${c.kind} ${side}: ${r.body}`);
        const a = answer(r);
        assert.equal(a.picture, true);
        assert.match(a.where, new RegExp(`page 2 of the ${side} version of doc.pdf`));
        const file = path.join(s.regionsDir(id), `${a.id}.png`);
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(s.regionsDir(id)).mode & 0o777, 0o700);
        const d = decodePng(readFileSync(file));
        assert.ok("raw" in d, JSON.stringify(d));
        assert.deepEqual([d.width, d.height], [40, 15]);
        for (let j = 0; j < 15; j++) for (let i = 0; i < 40; i++) {
          const px: number[] = [...d.raw.subarray((j * 40 + i) * 4, (j * 40 + i) * 4 + 4)];
          assert.deepEqual(px, [(m * 16 + 2) & 255, 20 + i, 30 + j, 255], `${c.kind} ${side} pixel ${i},${j}`);
        }
        made++;
      }
    }
    assert.equal(made, 6, "created.after, modified x2 (both sides), deleted.before");
    assert.equal(s.files(id).length, made);
  });

  it("a before-side region on the second pass is the first state, never the final one", async () => {
    const s = await setup();
    const id = await s.task();
    const second = (await s.changes(id)).find((c) => c.file.endsWith("doc.pdf") && markerOf(c, "after") === 2)!;
    const r = await s.region(id, { change: second.id, side: "before", kind: "picture", page: 1, rect: [0, 0, 1, 1] });
    assert.equal(r.status, 200);
    const d = decodePng(readFileSync(path.join(s.regionsDir(id), `${answer(r).id}.png`)));
    assert.ok("raw" in d);
    assert.equal(d.raw[0], (1 * 16 + 1) & 255, "marker 1 (the first pass), not 3 (the last)");
    assert.notEqual(d.raw[0], (3 * 16 + 1) & 255);
  });

  it("a page the file does not need and a missing page are refused", async () => {
    const s = await setup();
    const id = await s.task();
    const cs = await s.changes(id);
    const doc = cs.find((c) => c.file.endsWith("doc.pdf") && c.kind === "created")!;
    assert.equal((await s.region(id, { change: doc.id, side: "after", kind: "picture", page: null, rect: RECT })).status, 400);
    // the refusal by workbook ending is replaced by the claimed rule; a claimed state's crop is pinned in
    // core-forgets-office-render and claimed-no-core-view (zero render calls), and nothing claims .xlsx in this test's home.
    assert.equal(s.ledger.regionsForTask(id).length, 0);
  });
});

describe("the region route refuses an Office file outright", () => {
  it("a docx or pptx picture region is a flat 404, with or without a page, and nothing is recorded", async (t) => {
    // the refusal follows the connectors' claims; the shipped built-ins claim .docx and .pptx (the test bootstrap registers none by default)
    setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
    t.after(() => setBuiltinConnectorsForTest(undefined));
    const s = await setup();
    const id = await s.task("o", true);
    const cs = await s.changes(id);
    for (const name of ["memo.docx", "deck.pptx"]) {
      const c = cs.find((x) => x.file.endsWith(name))!;
      assert.ok(c, name);
      for (const page of [null, 1]) {
        const r = await s.region(id, { change: c.id, side: "after", kind: "picture", page, rect: RECT });
        assert.equal(r.status, 404, `${name} page ${page}`);
        assert.equal(answer(r).error, "not found");
      }
    }
    assert.equal(s.ledger.regionsForTask(id).length, 0);
    assert.deepEqual(s.files(id), []);
  });
});

describe("the region route: one-picture files, cells, lines", () => {
  it("UNIVERSE: an image (art.png), both sides of its modified change: that state's picture, page must be null", async () => {
    const s = await setup();
    const id = await s.task();
    const arts = (await s.changes(id)).filter((c) => c.file.endsWith("art.png"));
    assert.equal(arts.length, 2);
    const modified = arts.find((c) => c.kind === "modified")!;
    for (const [side, m] of [["before", 1], ["after", 2]] as const) {
      const r = await s.region(id, { change: modified.id, side, kind: "picture", page: null, rect: [0.1, 0.1, 0.5, 0.5] });
      assert.equal(r.status, 200, r.body.toString());
      const d = decodePng(readFileSync(path.join(s.regionsDir(id), `${answer(r).id}.png`)));
      assert.ok("raw" in d);
      assert.deepEqual([d.width, d.height], [50, 50]);
      assert.deepEqual([...d.raw.subarray(0, 4)], [m, 10, 10, 255]);
      assert.match(answer(r).where, new RegExp(`the ${side} version of art.png`));
    }
    assert.equal((await s.region(id, { change: modified.id, side: "after", kind: "picture", page: 1, rect: RECT })).status, 400);
    const created = arts.find((c) => c.kind === "created")!;
    assert.equal((await s.region(id, { change: created.id, side: "before", kind: "picture", page: null, rect: RECT })).status, 404);
  });

  // the cell-region kind is deleted (no page sends it)

  it("lines: where names the line range and the side; no file; the listed lines are that side's", async () => {
    const s = await setup();
    const id = await s.task();
    const tx = (await s.changes(id)).find((c) => c.file.endsWith("notes.txt") && c.kind === "modified")!;
    for (const [side, v] of [["before", 1], ["after", 2]] as const) {
      const r = await s.region(id, { change: tx.id, side, kind: "lines", from: 2, to: 3 });
      assert.equal(r.status, 200, r.body.toString());
      const a = answer(r);
      assert.equal(a.where, `lines 2 to 3 of the ${side} version of notes.txt`);
      assert.deepEqual((s.ledger.regionsForTask(id).find((x) => x.id === a.id)!.rect as { lines: string[] }).lines, [`2: line two v${v}`, `3: line three v${v}`]);
    }
    assert.deepEqual(s.files(id), []);
  });

  it("a kind the file cannot take is refused: cells on text, lines on a workbook", async () => {
    const s = await setup();
    const id = await s.task();
    const cs = await s.changes(id);
    assert.equal((await s.region(id, { change: cs.find((c) => c.file.endsWith("notes.txt"))!.id, side: "after", kind: "cells", sheet: "S1", range: "A1" })).status, 400);
    assert.equal((await s.region(id, { change: cs.find((c) => c.file.endsWith("book.xlsx"))!.id, side: "after", kind: "lines", from: 1, to: 2 })).status, 400);
    assert.equal(s.ledger.regionsForTask(id).length, 0);
  });

  it("a secret file (by name) gets no region of any kind: 404, no row, no file, no folder", async () => {
    const s = await setup();
    const id = await s.task();
    const env = (await s.changes(id)).find((c) => c.file.endsWith(".env"))!;
    for (const body of [
      { change: env.id, side: "after", kind: "picture", page: null, rect: RECT },
      { change: env.id, side: "after", kind: "lines", from: 1, to: 1 },
    ]) {
      const r = await s.region(id, body);
      assert.equal(r.status, 404);
      assert.doesNotMatch(r.body.toString(), /SECRETVALUE|sk-live/);
    }
    assert.equal(s.ledger.regionsForTask(id).length, 0);
    assert.equal(existsSync(s.regionsDir(id)), false);
  });

  it("an unknown change key is a 404 with nothing recorded; a task keeps at most 50 regions (409)", async () => {
    const s = await setup();
    const id = await s.task();
    assert.equal((await s.region(id, { change: "nope", side: "after", kind: "lines", from: 1, to: 1 })).status, 404);
    const tx = (await s.changes(id)).find((c) => c.file.endsWith("notes.txt") && c.kind === "modified")!;
    for (let i = 0; i < 50; i++) assert.equal((await s.region(id, { change: tx.id, side: "after", kind: "lines", from: 1, to: 1 })).status, 200);
    assert.equal((await s.region(id, { change: tx.id, side: "after", kind: "lines", from: 1, to: 1 })).status, 409);
    assert.equal(s.ledger.regionsForTask(id).length, 50);
  });
});

describe("guards on the region routes", () => {
  const good = (c: Chg) => ({ change: c.id, side: "after", kind: "lines", from: 1, to: 2 });
  it("wrong or missing token, wrong Host, foreign or absent Origin, non-JSON, bad JSON, GET: each refused with the existing code, nothing recorded", async () => {
    const s = await setup();
    const id = await s.task();
    const tx = (await s.changes(id)).find((c) => c.file.endsWith("notes.txt") && c.kind === "modified")!;
    const body = good(tx);
    assert.equal((await s.region(id, body, { token: "x".repeat(40) })).status, 403);
    assert.equal((await s.region(id, body, { token: null })).status, 403);
    assert.equal((await s.region(id, body, { host: "evil.example" })).status, 403);
    assert.equal((await s.region(id, body, { origin: "http://evil.example" })).status, 403);
    assert.equal((await s.region(id, body, { origin: null })).status, 403);
    assert.equal((await s.region(id, body, { type: "text/plain" })).status, 415);
    assert.equal((await s.region(id, undefined, { raw: "{not json", type: "application/json" })).status, 400);
    assert.equal((await s.call("GET", `/timeline/${id}/review/region`)).status, 405);
    assert.equal((await s.region(9999, body)).status, 404);
    assert.equal(s.ledger.regionsForTask(id).length, 0);
    assert.equal((await s.region(id, body)).status, 200);
  });

  it("bad fractions, bad page, a range too large or not a range, a line span too long: 400 each, nothing recorded", async () => {
    const s = await setup();
    const id = await s.task();
    const cs = await s.changes(id);
    const art2 = cs.find((c) => c.file.endsWith("art.png") && c.kind === "modified")!;
    const xl = cs.find((c) => c.file.endsWith("book.xlsx") && c.kind === "modified")!;
    const tx = cs.find((c) => c.file.endsWith("notes.txt") && c.kind === "modified")!;
    const pic = (rect: unknown, page: unknown = null) => ({ change: art2.id, side: "after", kind: "picture", page, rect });
    const bad: unknown[] = [
      pic([0.5, 0, 0.6, 0.5]), pic([-0.1, 0, 0.5, 0.5]), pic([0, 0, 0, 0.5]), pic([0, 0, 0.5]), pic([0, 0, "x", 0.5]), pic([0, 0, 1.01, 1]), pic("rect"),
      pic([0, 0, 0.05, 0.5]), pic([0, 0, 0.5, 0.05]), pic(RECT, "1"), pic(RECT, 0), pic(RECT, 1.5),
      { change: xl.id, side: "after", kind: "cells", sheet: "S1", range: "A1:Z100" },
      { change: xl.id, side: "after", kind: "cells", sheet: "S1", range: "A1:XFE5" },
      { change: xl.id, side: "after", kind: "cells", sheet: "S1", range: "A0" },
      { change: xl.id, side: "after", kind: "cells", sheet: "S1", range: "A1:B2:C3" },
      { change: xl.id, side: "after", kind: "cells", sheet: "", range: "A1" },
      { change: xl.id, side: "after", kind: "cells", sheet: "S1" },
      { change: tx.id, side: "after", kind: "lines", from: 1, to: 500 },
      { change: tx.id, side: "after", kind: "lines", from: 3, to: 2 },
      { change: tx.id, side: "after", kind: "lines", from: 0, to: 2 },
      { change: tx.id, side: "after", kind: "lines", from: 1.5, to: 2 },
      { change: tx.id, side: "middle", kind: "lines", from: 1, to: 2 },
      { change: tx.id, side: "after", kind: "video", from: 1, to: 2 },
      { change: 7, side: "after", kind: "lines", from: 1, to: 2 },
    ];
    for (const b of bad) assert.equal((await s.region(id, b)).status, 400, JSON.stringify(b));
    // the largest allowed span passes (the cell-region kind is deleted, so every cells body above is refused as a kind)
    assert.equal((await s.region(id, { change: tx.id, side: "after", kind: "lines", from: 1, to: 400 })).status, 200);
    assert.equal(s.ledger.regionsForTask(id).length, 1);
  });

  it("GET /region/<id>: the PNG, private and no-store, behind the token and Origin check; another task's id, a non-digit id and a no-picture region are 404", { skip: !mac && "needs macOS" }, async () => {
    const s = await setup();
    const id = await s.task("a");
    const other = await s.task("b");
    const cs = await s.changes(id);
    const doc = cs.find((c) => c.file.endsWith("doc.pdf") && c.kind === "created")!;
    const r = answer(await s.region(id, { change: doc.id, side: "after", kind: "picture", page: 1, rect: RECT }));
    const lines = answer(await s.region(id, { change: cs.find((c) => c.file.endsWith("notes.txt") && c.kind === "modified")!.id, side: "after", kind: "lines", from: 1, to: 1 }));
    const got = await s.call("GET", `/timeline/${id}/region/${r.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers["content-type"], "image/png");
    assert.match(String(got.headers["cache-control"]), /private/);
    assert.match(String(got.headers["cache-control"]), /no-store/);
    assert.ok(got.body.equals(readFileSync(path.join(s.regionsDir(id), `${r.id}.png`))));
    assert.equal((await s.call("GET", `/timeline/${id}/region/${r.id}`, { token: "x".repeat(40) })).status, 403);
    assert.equal((await s.call("GET", `/timeline/${id}/region/${r.id}`, { token: null })).status, 403);
    assert.equal((await s.call("GET", `/timeline/${id}/region/${r.id}`, { origin: "http://evil.example" })).status, 403);
    assert.equal((await s.call("GET", `/timeline/${id}/region/${r.id}`, { host: "evil.example" })).status, 403);
    assert.equal((await s.call("POST", `/timeline/${id}/region/${r.id}`)).status, 405);
    assert.equal((await s.call("GET", `/timeline/${other}/region/${r.id}`)).status, 404, "another task's id");
    assert.equal((await s.call("GET", `/timeline/${id}/region/${lines.id}`)).status, 404, "a region with no picture");
    for (const bad of ["abc", "1x", "..%2f..%2fledger.sqlite", "-1", "1.5"]) assert.equal((await s.call("GET", `/timeline/${id}/region/${bad}`)).status, 404, bad);
  });
});

describe("notes take regions: verdict and send-back", () => {
  /** Makes one lines region on a change of the task; returns its id. */
  const lineRegion = async (s: S, id: number, file: string, kind = "modified"): Promise<number> => {
    const c = (await s.changes(id)).find((x) => x.file.endsWith(file) && x.kind === kind)!;
    const r = await s.region(id, { change: c.id, side: "after", kind: "lines", from: 1, to: 2 });
    assert.equal(r.status, 200, r.body.toString());
    return answer(r).id;
  };
  const verdict = (s: S, id: number, stopOf: Chg, json: Record<string, unknown>) => s.call("POST", `/timeline/${id}/review/verdict`, { json: { stop: `chg-${stopOf.id}`, status: "failed", note: "wrong here", ...json } });
  const linked = (s: S, id: number) => s.ledger.regionsForTask(id).filter((r) => r.linked).length;

  it("a failed verdict links the regions it is given, and regionsForVerdict reads them back with the stop", async () => {
    const s = await setup();
    const id = await s.task();
    const tx = (await s.changes(id)).find((c) => c.file.endsWith("notes.txt") && c.kind === "modified")!;
    const a = await lineRegion(s, id, "notes.txt");
    const b = await lineRegion(s, id, "notes.txt");
    const r = await verdict(s, id, tx, { regions: [a, b] });
    assert.equal(r.status, 200, r.body.toString());
    const v = s.ledger.stopVerdictsForTask(id).at(-1)!;
    const refs = regionsForVerdict(s.ledger, s.home, v.id);
    assert.deepEqual(refs.map((x) => x.id), [a, b]);
    assert.ok(refs.every((x) => x.stop === `chg-${tx.id}` && x.picture === null));
    assert.deepEqual(refs[0]!.lines, ["1: line one v2", "2: line two v2"]);
    assert.match(refs[0]!.where, /lines 1 to 2 of the after version of notes.txt/);
    assert.deepEqual(regionsById(s.ledger, s.home, id, [b, a, 9999]).map((x) => [x.id, x.stop]), [[b, `chg-${tx.id}`], [a, `chg-${tx.id}`]]);
  });

  it("a picture region reads back with its absolute path while the file is there, and null once it is gone", { skip: !mac && "needs macOS" }, async () => {
    const s = await setup();
    const id = await s.task();
    const doc = (await s.changes(id)).find((c) => c.file.endsWith("doc.pdf") && c.kind === "created")!;
    const pr = answer(await s.region(id, { change: doc.id, side: "after", kind: "picture", page: 1, rect: RECT }));
    assert.equal((await verdict(s, id, doc, { regions: [pr.id] })).status, 200);
    const ref = regionsForVerdict(s.ledger, s.home, s.ledger.stopVerdictsForTask(id).at(-1)!.id)[0]!;
    assert.equal(ref.picture, path.join(s.regionsDir(id), `${pr.id}.png`));
    assert.ok(path.isAbsolute(ref.picture!) && existsSync(ref.picture!));
    await rm(ref.picture!);
    assert.equal(regionsById(s.ledger, s.home, id, [pr.id])[0]!.picture, null);
  });

  it("a region of another stop, another task, one already linked, a fifth, a duplicate, an unknown id or a non-failed verdict is refused 400 and links nothing, records no verdict", async () => {
    const s = await setup();
    const id = await s.task("a");
    const other = await s.task("b");
    const cs = await s.changes(id);
    const tx = cs.find((c) => c.file.endsWith("notes.txt") && c.kind === "modified")!;
    const mine = await lineRegion(s, id, "notes.txt");
    const book1 = await lineRegion(s, id, "notes.txt", "created");
    const theirs = await lineRegion(s, other, "notes.txt");
    const verdictsBefore = s.ledger.stopVerdictsForTask(id).length;
    const refuse = async (regions: unknown, json: Record<string, unknown> = {}) => {
      const r = await verdict(s, id, tx, { regions, ...json });
      assert.equal(r.status, 400, `${JSON.stringify(regions)}: ${r.body}`);
      assert.equal(linked(s, id), 0);
      assert.equal(linked(s, other), 0);
      assert.equal(s.ledger.stopVerdictsForTask(id).length, verdictsBefore);
    };
    await refuse([book1], {});
    await refuse([theirs]);
    await refuse([9999]);
    await refuse([mine, mine]);
    await refuse([mine, book1]);
    await refuse("1");
    await refuse([0]);
    await refuse([1.5]);
    const five = [mine, mine + 100, mine + 101, mine + 102, mine + 103];
    await refuse(five);
    await refuse([mine], { status: "passed" });
    await refuse([mine], { status: "not_reviewed" });
    // the good save works, and then the same region cannot be linked again
    assert.equal((await verdict(s, id, tx, { regions: [mine] })).status, 200);
    assert.equal(linked(s, id), 1);
    const count = s.ledger.stopVerdictsForTask(id).length;
    const again = await verdict(s, id, tx, { regions: [mine] });
    assert.equal(again.status, 400);
    assert.equal(s.ledger.stopVerdictsForTask(id).length, count);
    // a stop that is not a file change has nothing to point at
    assert.equal((await s.call("POST", `/timeline/${id}/review/verdict`, { json: { stop: "chg-nope", status: "failed", note: "x", regions: [mine] } })).status, 404);
  });

  it("a fifth region is refused even when all are this step's (the cap is four)", async () => {
    const s = await setup();
    const id = await s.task();
    const tx = (await s.changes(id)).find((c) => c.file.endsWith("notes.txt") && c.kind === "modified")!;
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await lineRegion(s, id, "notes.txt"));
    assert.equal((await verdict(s, id, tx, { regions: ids })).status, 400);
    assert.equal(linked(s, id), 0);
    assert.equal((await verdict(s, id, tx, { regions: ids.slice(0, 4) })).status, 200);
    assert.equal(linked(s, id), 4);
  });

  it("send-back takes overall regions (any change of the task); another task's, an already linked one and a fifth are refused and record no send-back", async () => {
    const s = await setup();
    const id = await s.task("a");
    const other = await s.task("b");
    const a = await lineRegion(s, id, "notes.txt");
    const bk = await lineRegion(s, id, "notes.txt", "created");
    const theirs = await lineRegion(s, other, "notes.txt");
    const send = (regions: unknown) => s.call("POST", `/timeline/${id}/review/sendback`, { json: { note: "see these", regions } });
    for (const bad of [[theirs], [9999], [a, a], "1", [a, a + 1, a + 2, a + 3, a + 4]]) {
      assert.equal((await send(bad)).status, 400, JSON.stringify(bad));
      assert.equal(s.ledger.sendBacksForTask(id).length, 0);
      assert.equal(linked(s, id), 0);
    }
    const ok = await send([a, bk]);
    assert.equal(ok.status, 200, ok.body.toString());
    const sb = s.ledger.sendBacksForTask(id);
    assert.equal(sb.length, 1);
    const rows = s.ledger.regionsForTask(id);
    assert.deepEqual(rows.map((r) => r.sendBackId), [sb[0]!.id, sb[0]!.id]);
    assert.equal((await send([a])).status, 400, "already linked");
    assert.equal(s.ledger.sendBacksForTask(id).length, 1);
    assert.deepEqual(regionsById(s.ledger, s.home, id, [a, bk]).map((r) => r.stop), [null, null]);
    // no regions: the same body as before the feature
    assert.equal((await s.call("POST", `/timeline/${id}/review/sendback`, { json: { note: "plain" } })).status, 200);
  });
});
