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
import { openLedger, MAX_NOTE_REGIONS } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { writeSealed } from "../src/seal.ts";
import { encodePng } from "./fixtures/png-encode.ts";


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

// The data layer and routes of the sticky notes. Guarded against: an old client body or an older ledger breaks, or a note's picture
// is stranded by expiry. Every line below goes through the real routes against a temp home.

type Json = Record<string, any>;
const j = (r: { body: Buffer }): Json => JSON.parse(r.body.toString("utf8")) as Json;

describe("sticky notes", () => {
  const mkRegion = async (s: S, id: number, from: number, to: number): Promise<number> => {
    const c = (await s.changes(id)).find((x) => x.file.endsWith("notes.txt") && x.kind === "modified")!;
    const r = await s.region(id, { change: c.id, side: "after", kind: "lines", from, to });
    assert.equal(r.status, 200, r.body.toString());
    return j(r).id as number;
  };
  const note = (s: S, id: number, json: unknown) => s.call("POST", `/timeline/${id}/review/notes`, { json });
  const edit = (s: S, id: number, n: number, json: unknown) => s.call("POST", `/timeline/${id}/review/notes/${n}`, { json });
  const status = async (s: S, id: number): Promise<Json> => j(await s.call("GET", `/timeline/${id}/review/status`));

  it("(4) three notes on three regions, edit one, delete one, send back: the prompt carries exactly the two that remain; a second send-back repeats none", async () => {
    const s = await setup();
    const id = await s.task();
    const regs = [await mkRegion(s, id, 1, 1), await mkRegion(s, id, 2, 2), await mkRegion(s, id, 3, 4)];
    const ids: number[] = [];
    for (const [i, r] of regs.entries()) {
      const a = await note(s, id, { text: `alpha${i}`, regionId: r });
      assert.equal(a.status, 200, a.body.toString());
      ids.push(j(a).id);
    }
    assert.equal(new Set(ids).size, 3);
    assert.equal((await edit(s, id, ids[1]!, { text: "beta edited" })).status, 200);
    assert.equal((await edit(s, id, ids[2]!, { deleted: true })).status, 200);
    // (1) persists across a reload: the status route shows exactly the live ones, in the shape reads; region_links untouched.
    const st = await status(s, id);
    assert.deepEqual(st.notes.map((n: Json) => [n.id, n.text, n.regionId]), [[ids[0], "alpha0", regs[0]], [ids[1], "beta edited", regs[1]]]);
    assert.equal(st.notes[0].region.kind, "lines");
    assert.equal(st.notes[0].region.from, 1);
    assert.equal(st.notes[0].region.side, "after");
    assert.equal(st.notes[0].picture, false);
    assert.match(st.notes[0].where, /line 1 of the after version/);
    assert.equal(s.ledger.regionsForTask(id).filter((r) => r.linked).length, 0);
    // a region held by a live note is taken; the deleted note's region is free again
    assert.equal((await note(s, id, { text: "dup", regionId: regs[0] })).status, 400);
    const reused = await note(s, id, { text: "reuse", regionId: regs[2] });
    assert.equal(reused.status, 200);
    assert.equal((await edit(s, id, j(reused).id, { deleted: true })).status, 200);
    const sent = await s.call("POST", `/timeline/${id}/review/sendback`, { json: {} });
    assert.equal(sent.status, 200, sent.body.toString());
    const prompt = j(sent).prompt as string;
    assert.match(prompt, /alpha0/);
    assert.match(prompt, /beta edited/);
    assert.doesNotMatch(prompt, /alpha1|alpha2|reuse/);
    assert.equal((prompt.match(/^Note \d+:/gm) ?? []).length, 2);
    assert.match(prompt, /Reviewer pointed at: line 1 of the after version/);
    assert.deepEqual((await status(s, id)).notes, []);
    assert.equal(s.ledger.regionsForTask(id).filter((r) => r.linked).length, 2);
    // a second send-back with nothing new: 409, and with a new note on a fresh region: carries only that one
    assert.equal((await s.call("POST", `/timeline/${id}/review/sendback`, { json: {} })).status, 409);
    const r4 = await mkRegion(s, id, 4, 4);
    assert.equal((await note(s, id, { text: "gamma", regionId: r4 })).status, 200);
    const again = await s.call("POST", `/timeline/${id}/review/sendback`, { json: {} });
    assert.equal(again.status, 200, again.body.toString());
    assert.match(j(again).prompt, /gamma/);
    assert.doesNotMatch(j(again).prompt, /alpha0|beta edited/);
    // a sent note can no longer be edited or deleted; a note of another task is a 404
    assert.equal((await edit(s, id, ids[0]!, { text: "late" })).status, 404);
    assert.equal((await note(s, id, { text: "x", regionId: regs[0] })).status, 400);
  });

  it("(2) notes without a region, only notes (no 409), old {note, regions} body still works, MAX_NOTE_REGIONS does not apply to notes", async () => {
    const s = await setup();
    const id = await s.task();
    for (let i = 0; i < MAX_NOTE_REGIONS + 2; i++) assert.equal((await note(s, id, { text: `free ${i}` })).status, 200);
    const sent = await s.call("POST", `/timeline/${id}/review/sendback`, { json: {} });
    assert.equal(sent.status, 200, sent.body.toString());
    assert.equal((j(sent).prompt.match(/^Note \d+:/gm) ?? []).length, MAX_NOTE_REGIONS + 2);
    const r = await mkRegion(s, id, 1, 1);
    const old = await s.call("POST", `/timeline/${id}/review/sendback`, { json: { note: "old overall", regions: [r] } });
    assert.equal(old.status, 200, old.body.toString());
    assert.match(j(old).prompt, /Overall note: old overall/);
    assert.match(j(old).prompt, /Reviewer pointed at/);
  });

  it("validation: text 1-2000 characters, regionId must be this task's unlinked region", async () => {
    const s = await setup();
    const id = await s.task("a");
    const other = await s.task("b");
    assert.equal((await note(s, id, { text: "   " })).status, 400);
    assert.equal((await note(s, id, { text: "x".repeat(2001) })).status, 400);
    assert.equal((await note(s, id, { text: "x".repeat(2000) })).status, 200);
    assert.equal((await note(s, id, { text: "ok", regionId: 9999 })).status, 400);
    const foreign = await mkRegion(s, other, 1, 1);
    assert.equal((await note(s, id, { text: "ok", regionId: foreign })).status, 400);
    assert.equal((await note(s, id, { text: "ok", regionId: "1" })).status, 400);
    const n = j(await note(s, id, { text: "mine" })).id;
    assert.equal((await edit(s, other, n, { text: "steal" })).status, 404);
    assert.equal((await edit(s, id, n, { text: "" })).status, 400);
    assert.equal((await s.call("POST", `/timeline/${id}/review/notes`, { json: { text: "x" }, token: "wrong" })).status, 403);
  });

  it("anchor: a note records the step it was made on (stop), keeps it through an edit, and a note without one reads stop null", async () => {
    const s = await setup();
    const id = await s.task();
    const a = j(await note(s, id, { text: "on a step", stop: "chg-abc" })).id;
    assert.equal((await note(s, id, { text: "no step" })).status, 200);
    assert.equal((await note(s, id, { text: "bad", stop: 7 })).status, 400);
    assert.equal((await note(s, id, { text: "bad", stop: "" })).status, 400);
    assert.equal((await note(s, id, { text: "bad", stop: "x".repeat(301) })).status, 400);
    assert.equal((await edit(s, id, a, { text: "on a step, edited" })).status, 200);
    assert.deepEqual((await status(s, id)).notes.map((n: Json) => [n.text, n.stop]), [["on a step, edited", "chg-abc"], ["no step", null]]);
  });

  it("(3) the expiry refusal leaves the notes alone before the point (blanking itself is pinned in everything-expires)", async () => {
    const s = await setup();
    const id = await s.task();
    const a = j(await note(s, id, { text: "secret words" })).id;
    assert.throws(() => s.ledger.expireValues(id, new Date(Date.now() + 400 * 86_400_000)), /values expire only 30 days after a task closed/);
    assert.deepEqual(s.ledger.liveNotes(id).map((n) => [n.id, n.text]), [[a, "secret words"]]);
  });
});
