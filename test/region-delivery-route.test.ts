import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { writeSealed } from "../src/seal.ts";
import { decodePng } from "../src/timeline/render/png-crop.ts";
import { encodePng } from "./fixtures/png-encode.ts";

// Route tests with the task folder OUTSIDE the data home. A reviewer selects a region of the diff (basically a screenshot) and submits it along with their
// notes, so the agent knows exactly what they mean: the region route, the server-side crop, the record and the links.
// The PDF page picture comes from a stand-in PDFKit helper (macOS only, so the PDF tests skip elsewhere); every pixel of a stand-in picture is
// [marker * 16 + page, x, y, 255], so a crop of the wrong state or the wrong place cannot match. Guard: the picture is never of a
// version other than the one the change key and side name.

const TOKEN = "t".repeat(40);
const mac = process.platform === "darwin";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);
const pdf = (m: number): Buffer => Buffer.from(`%PDF-1.4\n%MARK:${m}\n`);
// An image state is cut from its stored bytes, so the stored art is the stamped picture itself (100 by 100, stamped with its marker).
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
  const outside = await mkdtemp(path.join(tmpdir(), "cocheck-work-"));
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
    const work = path.join(outside, name);
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
  return { home, outside, ledger, call, task, changes, region, regionsDir, files, port };
}
type S = Awaited<ReturnType<typeof setup>>;
const answer = (r: { body: Buffer }) => JSON.parse(r.body.toString("utf8")) as { id: number; where: string; picture: boolean; error?: string };
const RECT = [0.25, 0.5, 0.5, 0.25] as const;

describe("a send-back names a delivery copy inside the task folder", { skip: !mac && "needs macOS" }, () => {
  const pictureFail = async (s: S) => {
    const id = await s.task();
    const doc = (await s.changes(id)).find((c) => c.file.endsWith("art.png") && c.kind === "modified")!;
    const pr = answer(await s.region(id, { change: doc.id, side: "after", kind: "picture", page: null, rect: RECT }));
    assert.ok(pr.picture);
    const r = await s.call("POST", `/timeline/${id}/review/verdict`, { json: { stop: `chg-${doc.id}`, status: "failed", note: "bad", regions: [pr.id] } });
    assert.equal(r.status, 200, r.body.toString());
    return { id, rid: pr.id };
  };
  const prompt = async (s: S, id: number) => (JSON.parse((await s.call("POST", `/timeline/${id}/review/sendback`, { json: {} })).body.toString("utf8")) as { prompt: string }).prompt;

  it("the prompt names <task>/.cocheck/regions/<name>.png, an owner-only copy of the home picture, and the home copy stays", async () => {
    const s = await setup();
    const { id, rid } = await pictureFail(s);
    const p = await prompt(s, id);
    const dir = path.join(s.outside, "a", ".cocheck", "regions");
    const m = new RegExp(`, picture (${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9a-f]{32}\\.png)`).exec(p);
    assert.ok(m, p);
    const home = path.join(s.regionsDir(id), `${rid}.png`);
    assert.ok(existsSync(home));
    assert.deepEqual(readFileSync(m[1]!), readFileSync(home));
    assert.equal(statSync(m[1]!).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.ok(!p.includes(home));
    // a second send-back reuses the copy
    assert.ok((await prompt(s, id)).includes(m[1]!));
    assert.equal(readdirSync(dir).length, 1);
    // no git repository around the temp folder: no .gitignore
    assert.ok(!existsSync(path.join(s.outside, "a", ".cocheck", ".gitignore")));
  });

  it("a .cocheck that is a symbolic link is refused: the prompt falls back to the home path and nothing is written through the link", async () => {
    const s = await setup();
    const id = await s.task();
    const away = await mkdtemp(path.join(tmpdir(), "cocheck-away-"));
    await symlink(away, path.join(s.outside, "a", ".cocheck"));
    const doc = (await s.changes(id)).find((c) => c.file.endsWith("art.png") && c.kind === "modified")!;
    const pr = answer(await s.region(id, { change: doc.id, side: "after", kind: "picture", page: null, rect: RECT }));
    await s.call("POST", `/timeline/${id}/review/verdict`, { json: { stop: `chg-${doc.id}`, status: "failed", note: "bad", regions: [pr.id] } });
    const p = await prompt(s, id);
    assert.ok(p.includes(`, picture ${path.join(s.regionsDir(id), `${pr.id}.png`)}`), p);
    assert.deepEqual(readdirSync(away), []);
  });

  it("a delivery copy that is gone is not named: the next prompt re-copies, and a refused home path stays the home path", async () => {
    const s = await setup();
    const { id } = await pictureFail(s);
    const first = /, picture (\S+\.png)/.exec(await prompt(s, id))![1]!;
    await rm(first);
    const second = /, picture (\S+\.png)/.exec(await prompt(s, id))![1]!;
    assert.ok(existsSync(second));
  });
});
