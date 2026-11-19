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
import { setTracking } from "../src/tracking.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { writeSealed } from "../src/seal.ts";
import { decodePng } from "../src/timeline/render/png-crop.ts";
import { regionsById, regionsForVerdict } from "../src/timeline/rail/regions.ts";
import { encodePng } from "./fixtures/png-encode.ts";

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
  // the fixture's session is a tracked one (an untracked one adds a closing sentence to every prompt).
  setTracking(home, "claude", "sess", true, "/work");
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
  const task = async (name = "a"): Promise<number> => {
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

describe("the send-back route carries the regions into the prompt the page shows", () => {
  const linesRegion = async (s: S, id: number, kind = "modified"): Promise<number> => {
    const c = (await s.changes(id)).find((x) => x.file.endsWith("notes.txt") && x.kind === kind)!;
    const r = await s.region(id, { change: c.id, side: "after", kind: "lines", from: 1, to: 2 });
    assert.equal(r.status, 200, r.body.toString());
    return answer(r).id;
  };
  const sendBack = (s: S, id: number, json: Record<string, unknown>) => s.call("POST", `/timeline/${id}/review/sendback`, { json });
  const failTxt = async (s: S, id: number, json: Record<string, unknown> = {}) => {
    const tx = (await s.changes(id)).find((c) => c.file.endsWith("notes.txt") && c.kind === "modified")!;
    const r = await s.call("POST", `/timeline/${id}/review/verdict`, { json: { stop: `chg-${tx.id}`, status: "failed", note: "wrong here", ...json } });
    assert.equal(r.status, 200, r.body.toString());
  };

  it("a failed step's regions print under its note, and the send-back's own regions under the overall note", async () => {
    const s = await setup();
    const id = await s.task();
    await failTxt(s, id, { regions: [await linesRegion(s, id)] });
    const overallId = await linesRegion(s, id);
    const j = JSON.parse((await sendBack(s, id, { note: "also this", regions: [overallId] })).body.toString("utf8")) as { prompt: string };
    assert.match(j.prompt, /Reviewer's note: wrong here\n {3}Reviewer pointed at: lines 1 to 2 of the after version of notes.txt\n {5}- 1: line one v2\n {5}- 2: line two v2\n/);
    assert.match(j.prompt, /Overall note: also this\nReviewer pointed at: lines 1 to 2 of the after version of notes.txt\n {2}- 1: line one v2\n {2}- 2: line two v2$/);
    assert.equal(s.ledger.sendBacksForTask(id).at(-1)!.prompt, j.prompt);
  });

  it("a picture region names its absolute path in the prompt, and the locator alone once the file is gone", { skip: !mac && "needs macOS" }, async () => {
    const s = await setup();
    const id = await s.task();
    const doc = (await s.changes(id)).find((c) => c.file.endsWith("art.png") && c.kind === "modified")!;
    const pr = answer(await s.region(id, { change: doc.id, side: "after", kind: "picture", page: null, rect: RECT }));
    assert.ok(pr.picture);
    const r = await s.call("POST", `/timeline/${id}/review/verdict`, { json: { stop: `chg-${doc.id}`, status: "failed", note: "bad page", regions: [pr.id] } });
    assert.equal(r.status, 200, r.body.toString());
    const file = path.join(s.regionsDir(id), `${pr.id}.png`);
    const raw = await sendBack(s, id, {}); assert.equal(raw.status, 200, raw.body.toString());
    const withPic = (JSON.parse((await sendBack(s, id, {})).body.toString("utf8")) as { prompt: string }).prompt;
    assert.ok(withPic.includes(`, picture ${file}`));
    await rm(file);
    const without = (JSON.parse((await sendBack(s, id, {})).body.toString("utf8")) as { prompt: string }).prompt;
    assert.ok(!without.includes(`${pr.id}.png`) && !without.includes(", picture ") && /Reviewer pointed at: /.test(without));
  });

  it("a send-back with no regions is the same prompt as before the regions existed", async () => {
    const s = await setup();
    const id = await s.task();
    await failTxt(s, id);
    const p = (JSON.parse((await sendBack(s, id, { note: "n" })).body.toString("utf8")) as { prompt: string }).prompt;
    assert.doesNotMatch(p, /Reviewer pointed at/);
  });
});

describe("a failed stop's draft saves again against the real verdict route", () => {
  const sendBack = (s: S, id: number, json: Record<string, unknown>) => s.call("POST", `/timeline/${id}/review/sendback`, { json });
  const verdict = (s: S, id: number, stop: string, json: Record<string, unknown>) => s.call("POST", `/timeline/${id}/review/verdict`, { json: { stop, ...json } });
  const chg = async (s: S, id: number, file: string, kind: string) => (await s.changes(id)).find((c) => c.file.endsWith(file) && c.kind === kind)!;
  const lines = async (s: S, id: number, c: Chg): Promise<number> => {
    const r = await s.region(id, { change: c.id, side: "after", kind: "lines", from: 1, to: 2 });
    assert.equal(r.status, 200, r.body.toString());
    return answer(r).id;
  };

  it("fail with a region, not_reviewed (U), fail again with the same region id: 200, and the send-back carries its picture line", async () => {
    const s = await setup();
    const id = await s.task();
    const c = await chg(s, id, "notes.txt", "modified");
    const stop = `chg-${c.id}`;
    const r1 = await lines(s, id, c);
    assert.equal((await verdict(s, id, stop, { status: "failed", note: "first note", regions: [r1] })).status, 200);
    assert.equal((await verdict(s, id, stop, { status: "not_reviewed" })).status, 200);
    const again = await verdict(s, id, stop, { status: "failed", note: "second note", regions: [r1] });
    assert.equal(again.status, 200, again.body.toString());
    const p = (JSON.parse((await sendBack(s, id, {})).body.toString("utf8")) as { prompt: string }).prompt;
    assert.match(p, /Reviewer's note: second note\n {3}Reviewer pointed at: lines 1 to 2 of the after version of notes.txt\n {5}- 1: line one v2\n/);
    assert.doesNotMatch(p, /first note/);
  });

  it("the region-taken rule holds: a region of a stop's LIVE fail is refused on that stop and on another stop, and a superseded one is refused on another stop", async () => {
    const s = await setup();
    const id = await s.task();
    const c = await chg(s, id, "notes.txt", "modified");
    const other = await chg(s, id, "notes.txt", "created");
    const stop = `chg-${c.id}`;
    const r1 = await lines(s, id, c);
    assert.equal((await verdict(s, id, stop, { status: "failed", note: "n", regions: [r1] })).status, 200);
    // live fail: reuse on the same stop (a second fail while the first is live) and elsewhere are both refused
    const live = await verdict(s, id, stop, { status: "failed", note: "n2", regions: [r1] });
    assert.equal(live.status, 400); assert.match(live.body.toString(), /already part of a note/);
    const elsewhere = await verdict(s, id, `chg-${other.id}`, { status: "failed", note: "n3", regions: [r1] });
    assert.equal(elsewhere.status, 400);
    // superseded (U), still refused for another stop
    assert.equal((await verdict(s, id, stop, { status: "not_reviewed" })).status, 200);
    const stillElsewhere = await verdict(s, id, `chg-${other.id}`, { status: "failed", note: "n4", regions: [r1] });
    assert.equal(stillElsewhere.status, 400);
    // a region held by a live sticky note is refused too
    const r2 = await lines(s, id, c);
    const made = await s.call("POST", `/timeline/${id}/review/notes`, { json: { text: "held", regionId: r2 } });
    assert.equal(made.status, 200, made.body.toString());
    const held = await verdict(s, id, stop, { status: "failed", note: "n5", regions: [r2] });
    assert.equal(held.status, 400); assert.match(held.body.toString(), /already part of a note/);
  });

  it("a send-back of two failed stops carries both notes and both pictures, one Box and one Freehand", { skip: !mac && "needs macOS" }, async () => {
    const s = await setup();
    const id = await s.task();
    const a = await chg(s, id, "art.png", "modified");
    // a second picture file, created last so its change is a live step (doc.pdf's changes are all replaced by its later deletion)
    const states = await ensureStoreDir(s.home, id);
    const work = path.join(s.home, "work", "a");
    await writeSealed(path.join(states, sha(art(3))), art(3));
    s.ledger.recordStep({ taskId: id, client: `claude-hook:${work}`, seq: 5, phase: "Post", callsOpen: [`toolu_${id}`], credited: [`toolu_${id}`], files: [{ filePath: path.join(work, "art2.png"), sha256: sha(art(3)), prevSha256: null, size: art(3).length, kept: "whole" as const, note: "" }] });
    const b = await chg(s, id, "art2.png", "created");
    const box = answer(await s.region(id, { change: a.id, side: "after", kind: "picture", page: null, rect: RECT }));
    const free = answer(await s.region(id, { change: b.id, side: "after", kind: "picture", page: null, shape: { type: "lasso", points: [[0.2, 0.2], [0.8, 0.25], [0.7, 0.8], [0.25, 0.7]] } }));
    assert.ok(box.picture && free.picture);
    assert.equal((await verdict(s, id, `chg-${a.id}`, { status: "failed", note: "box note", regions: [box.id] })).status, 200);
    assert.equal((await verdict(s, id, `chg-${b.id}`, { status: "failed", note: "free note", regions: [free.id] })).status, 200);
    const p = (JSON.parse((await sendBack(s, id, {})).body.toString("utf8")) as { prompt: string }).prompt;
    assert.ok(p.includes("box note") && p.includes("free note"), p);
    assert.ok(p.includes(`, picture ${path.join(s.regionsDir(id), `${box.id}.png`)}`), p);
    assert.ok(p.includes(`, picture ${path.join(s.regionsDir(id), `${free.id}.png`)}`), p);
  });
});

