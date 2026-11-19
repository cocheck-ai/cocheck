import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { writeSealed } from "../src/seal.ts";
import { decodePng } from "../src/timeline/render/png-crop.ts";
import { regionsById } from "../src/timeline/rail/regions.ts";
import { encodePng } from "./fixtures/png-encode.ts";

// The lasso picture region
// and the cells list. Rule for the boundary: a pixel is inside when its centre is inside the path by the even-odd rule; the tests sample only
// pixels clearly inside or clearly outside. Guarded against: a pixel inside the path is never dimmed and a pixel outside is never left undimmed.

const TOKEN = "t".repeat(40);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);
// an image state is cut from its stored bytes: the solid picture, plus one trailing byte so the two versions differ.
const art = (m: number): Buffer => Buffer.concat([solid(100, 100), Buffer.from([m])]);
const SOLID = [200, 100, 50, 255];
const solid = (w: number, h: number): Buffer => {
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) raw.set(SOLID, i * 4);
  return encodePng({ width: w, height: h, colorType: 6, raw });
};
const cell = (ref: string, v: number) => `<c r="${ref}"><v>${v}</v></c>`;
const book = (v: number): Buffer => Buffer.from(zipSync({
  "xl/workbook.xml": enc(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
  "xl/_rels/workbook.xml.rels": enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
  "xl/worksheets/sheet1.xml": enc(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="4">${cell("B4", v)}</row><row r="5">${cell("C5", v + 1)}</row><row r="6">${cell("C6", v + 2)}</row><row r="7">${cell("C7", v + 3)}</row></sheetData></worksheet>`),
}, { mtime: new Date(2020, 0, 1) }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Chg { id: string; file: string; kind: string }

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, {});
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const call = (method: string, p: string, json?: unknown): Promise<{ status: number; body: Buffer }> => {
    const body = json === undefined ? undefined : JSON.stringify(json);
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
  const work = path.join(home, "work", "a");
  await mkdir(work, { recursive: true });
  const client = `claude-hook:${work}`;
  const id = ledger.openTask(client);
  const states = await ensureStoreDir(home, id);
  const callId = `toolu_${id}`;
  const f = (n: string) => path.join(work, n);
  ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit", clientName: client, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: ["art.png", "book.xlsx"].map(f), description: "write", narration: { source: "none", text: "none" } } });
  ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: client, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Make files."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
  for (const b of [art(1), art(2), book(1), book(2)]) await writeSealed(path.join(states, sha(b)), b);
  const st = (file: string, b: Buffer, prev: Buffer | null) => ({ filePath: f(file), sha256: sha(b), prevSha256: prev === null ? null : sha(prev), size: b.length, kept: "whole" as const, note: "" });
  const step = (seq: number, files: Array<ReturnType<typeof st>>) => ledger.recordStep({ taskId: id, client, seq, phase: "Post", callsOpen: [callId], credited: [callId], files });
  step(1, [st("art.png", art(1), null), st("book.xlsx", book(1), null)]);
  step(2, [st("art.png", art(2), art(1)), st("book.xlsx", book(2), book(1))]);
  const t = JSON.parse((await call("GET", `/timeline/${id}`)).body.toString("utf8")) as { unplaced: Chg[]; requests: Array<{ runs: Array<{ calls: Array<{ changes: Chg[] }> }> }> };
  const all = [...t.unplaced, ...t.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))];
  const artC = all.find((c) => c.file.endsWith("art.png") && c.kind === "modified")!;
  const artNew = all.find((c) => c.file.endsWith("art.png") && c.kind === "created")!;
  const xlC = all.find((c) => c.file.endsWith("book.xlsx") && c.kind === "modified")!;
  const region = (json: unknown) => call("POST", `/timeline/${id}/review/region`, json);
  return { home, ledger, id, artC, artNew, xlC, region };
}

const answer = (r: { body: Buffer }) => JSON.parse(r.body.toString("utf8")) as { id: number; where: string; picture: boolean; error?: string };
const TRI: Array<[number, number]> = [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8]];
const pic = (c: Chg, shape: unknown, rect?: unknown) => ({ change: c.id, side: "after", kind: "picture", page: null, ...(rect === undefined ? {} : { rect }), shape });

describe("lasso picture region", () => {
  it("a known triangle on a solid picture: clearly inside pixels equal the source, clearly outside pixels are dimmed (not removed), the outline is drawn", async () => {
    const s = await setup();
    const r = await s.region(pic(s.artC, { type: "lasso", points: TRI }));
    assert.equal(r.status, 200, r.body.toString());
    const a = answer(r);
    assert.equal(a.picture, true);
    const d = decodePng(readFileSync(path.join(s.home, "tasks", String(s.id), "regions", `${a.id}.png`)));
    assert.ok("raw" in d);
    assert.deepEqual([d.width, d.height], [60, 60], "cropped to the path's bounding box");
    const px = (i: number, j: number): number[] => [...d.raw.subarray((j * 60 + i) * 4, (j * 60 + i) * 4 + 4)];
    let inside = 0, outside = 0;
    for (let j = 0; j < 60; j += 2) for (let i = 0; i < 60; i += 2) {
      // the path is the triangle (0,0) (60,0) (0,60) in crop pixels; a pixel's centre is (i + .5, j + .5)
      const sum = i + j + 1;
      const edge = Math.min(i, j, Math.abs(60 - sum) / Math.SQRT2);
      if (edge < 3) continue;
      if (sum < 60) {
        assert.deepEqual(px(i, j), SOLID, `inside ${i},${j} must not be dimmed`);
        inside++;
      } else {
        const p = px(i, j);
        assert.equal(p[3], 255);
        for (let k = 0; k < 3; k++) assert.ok(p[k]! < SOLID[k]! && p[k]! > 0, `outside ${i},${j} must be dimmed, not removed or untouched: ${p}`);
        outside++;
      }
    }
    assert.ok(inside > 100 && outside > 100, `${inside} ${outside}`);
    let outline = 0;
    for (let j = 0; j < 60; j++) for (let i = 0; i < 60; i++) if (px(i, j).join() === "255,0,0,255") outline++;
    assert.ok(outline > 100, `the outline is drawn: ${outline}`);
    assert.match(a.where, /^the after version of art\.png$/);
  });

  it("the row keeps the shape; the box region and the no-shape region are today's rect crop", async () => {
    const s = await setup();
    const a = answer(await s.region(pic(s.artC, { type: "lasso", points: TRI })));
    const row = s.ledger.regionsForTask(s.id).find((x) => x.id === a.id)!;
    assert.deepEqual((row.rect as { points: unknown }).points, TRI);
    for (const shape of [undefined, { type: "box" }]) {
      const b = answer(await s.region(pic(s.artC, shape, [0.1, 0.1, 0.5, 0.5])));
      const d = decodePng(readFileSync(path.join(s.home, "tasks", String(s.id), "regions", `${b.id}.png`)));
      assert.ok("raw" in d);
      assert.deepEqual([d.width, d.height], [50, 50]);
      for (let i = 0; i < 2500; i++) assert.deepEqual([...d.raw.subarray(i * 4, i * 4 + 4)], SOLID);
    }
  });

  it("bad points are refused 400 with nothing recorded: too few, too many, outside 0..1, not finite, a box under 8 pixels, a bad shape", async () => {
    const s = await setup();
    const many = Array.from({ length: 401 }, (_, i) => [0.2 + (i % 7) * 0.1, 0.2 + (i % 5) * 0.1]);
    const bad: unknown[] = [
      { type: "lasso", points: [[0.1, 0.1], [0.5, 0.5]] },
      { type: "lasso", points: many },
      { type: "lasso", points: [[0.1, 0.1], [1.2, 0.5], [0.3, 0.9]] },
      { type: "lasso", points: [[0.1, 0.1], [-0.1, 0.5], [0.3, 0.9]] },
      { type: "lasso", points: [[0.1, 0.1], [null, 0.5], [0.3, 0.9]] },
      { type: "lasso", points: [[0.1, 0.1], ["0.5", 0.5], [0.3, 0.9]] },
      { type: "lasso", points: [[0.1, 0.1], [0.5], [0.3, 0.9]] },
      { type: "lasso", points: [[0.1, 0.1], [0.15, 0.1], [0.12, 0.15]] },
      { type: "lasso" },
      { type: "blob", points: TRI },
      "lasso",
    ];
    for (const shape of bad) assert.equal((await s.region(pic(s.artC, shape))).status, 400, JSON.stringify(shape).slice(0, 80));
    assert.equal((await s.region(pic(s.artC, { type: "lasso", points: Array.from({ length: 400 }, (_, i) => [0.2 + (i % 7) * 0.1, 0.2 + (i % 5) * 0.1]) }))).status, 200, "400 points pass");
    assert.equal(s.ledger.regionsForTask(s.id).length, 1);
  });

  it("the version-and-side rule holds: a lasso on a created change's before is a 404", async () => {
    const s = await setup();
    const shape = { type: "lasso", points: TRI };
    assert.equal((await s.region({ ...pic(s.artC, shape), side: "before" })).status, 200);
    assert.equal((await s.region({ ...pic(s.artNew, shape), side: "before" })).status, 404);
    assert.equal((await s.region({ ...pic(s.artNew, shape), side: "after" })).status, 200);
    assert.equal((await s.region({ ...pic(s.artC, shape), change: "nope" })).status, 404);
    assert.equal(s.ledger.regionsForTask(s.id).length, 2);
  });
});

describe("cells list", () => {
  // the cell-region kind is deleted (no page sends it)

  // the cell-region kind is deleted (no page sends it)
});
