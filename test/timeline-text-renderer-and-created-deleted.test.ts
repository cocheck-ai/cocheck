import { afterEach, describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import { sceneOfBody } from "./helpers/v1-served.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { fallbackRenderer } from "../src/timeline/render/fallback.ts";
import { rendererFor } from "../src/timeline/render/registry.ts";
import { textRenderer } from "../src/timeline/render/text.ts";
import type { ChangeInfo, TextLine, View } from "../src/timeline/render/types.ts";

// The folder prefix, the text renderer, and created/deleted files drawn on their one side. In-memory workbooks; the route runs
// against a temp home. Nothing here opens Excel, Quick Look or the network.

const info = (extra: Partial<ChangeInfo> = {}): ChangeInfo => ({ id: "c1", file: "data.csv", kind: "modified", ...extra });
const buf = (s: string): Buffer => Buffer.from(s, "utf8");
const lines = (n: number, tag = "row"): string[] => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`);
const nums = (ls: TextLine[] | undefined): number[] => (ls ?? []).flatMap((l) => ("n" in l ? [l.n] : []));
const textOf = (v: View, side: "before" | "after"): TextLine[] | undefined => v[side].find((p) => p.text)?.text?.lines;

describe("text renderer", () => {
  it("a changed line far from another: panes crop to plus or minus two with a gap, boxes on exactly the changed lines", async () => {
    const a = lines(30);
    const b = [...a];
    b[4] = "row five EDITED";
    b[24] = "row 25 EDITED";
    const v = await textRenderer.view(buf(a.join("\n") + "\n"), buf(b.join("\n") + "\n"), info());
    assert.equal(v.engine, "drawn by CoCheck from the lines of the file");
    assert.deepEqual(nums(textOf(v, "after")), [3, 4, 5, 6, 7, 23, 24, 25, 26, 27]);
    assert.deepEqual(textOf(v, "after")!.map((l) => ("gap" in l ? "gap" : "n" in l ? l.n : "filler")).slice(4, 8), [6, 7, "gap", 23]);
    assert.deepEqual(v.boxes.map((x) => `${x.side}:${x.line}:${x.confidence}`).sort(), ["after:25:exact", "after:5:exact", "before:25:exact", "before:5:exact"]);
    // Every boxed line is a line whose text differs from the other side's line
    for (const x of v.boxes) {
      const own = x.side === "before" ? a : b;
      const other = x.side === "before" ? b : a;
      assert.ok(!other.includes(own[x.line! - 1]!), `box on an unchanged line ${x.line}`);
    }
    assert.ok(v.boxes.every((x) => x.pane === `${x.side}:text`));
  });

  it("both panes hold the same rows; edits, additions and removals are told apart", async () => {
    const a = [...lines(20), "total = price * qty", "gone line", ...lines(20, "tail")];
    const b = [...lines(20), "total = price * quantity", ...lines(20, "tail"), "added at end"];
    const v = await textRenderer.view(buf(a.join("\n") + "\n"), buf(b.join("\n") + "\n"), info());
    const bl = v.before[0]!.text!.lines;
    const al = v.after[0]!.text!.lines;
    assert.equal(bl.length, al.length);
    const kinds = (ls: TextLine[]) => ls.map((l) => ("filler" in l ? "filler" : "gap" in l ? `gap${l.hidden}` : l.kind ?? "same"));
    assert.deepEqual(kinds(bl).slice(0, 2), ["gap18", "same"]);
    assert.deepEqual(kinds(bl).filter((k) => k !== "same"), ["gap18", "edit", "del", "gap16", "filler"]);
    const edit = al.find((l) => "kind" in l && l.kind === "edit")! as Extract<TextLine, { n: number }>;
    assert.equal(edit.text.slice(edit.marks![0]![0], edit.marks![0]![1]), "quantity");
    const del = bl.findIndex((l) => "kind" in l && l.kind === "del");
    assert.deepEqual(al[del], { filler: true });
    const add = al.findIndex((l) => "kind" in l && l.kind === "add");
    assert.deepEqual(bl[add], { filler: true });
    // boxes: the edited line and the removed line before; the edited line and the added line after
    assert.deepEqual(v.boxes.map((x) => `${x.side}:${x.line}`).sort(), ["after:21", "after:42", "before:21", "before:22"]);
  });

  it("a pure insertion is one column: a quiet before side, the added line marked add, no filler", async () => {
    const a = lines(10);
    const b = [...a.slice(0, 5), "brand new", ...a.slice(5)];
    const v = await textRenderer.view(buf(a.join("\n")), buf(b.join("\n")), info());
    assert.deepEqual(v.before, []);
    assert.ok(!v.after[0]!.text!.lines.some((l) => "filler" in l));
    assert.ok(v.after[0]!.text!.lines.some((l) => "kind" in l && l.kind === "add" && l.text === "brand new"));
  });

  it("a pure insertion boxes only the new line, on the after side", async () => {
    const a = lines(10);
    const b = [...a.slice(0, 5), "brand new", ...a.slice(5)];
    const v = await textRenderer.view(buf(a.join("\n")), buf(b.join("\n")), info());
    assert.deepEqual(v.boxes.map((x) => `${x.side}:${x.line}`), ["after:6"]);
  });

  it("a created file draws its first 40 lines on the after side, nothing was here before, no boxes; a deleted file mirrors it", async () => {
    const body = buf(lines(100).join("\n"));
    const c = await textRenderer.view(null, body, info({ kind: "created" }));
    assert.deepEqual(c.boxes, []);
    assert.equal(c.before[0]!.label, "There was nothing here yet");
    assert.equal(c.before[0]!.text, undefined);
    const ls = textOf(c, "after")!;
    assert.deepEqual(nums(ls), Array.from({ length: 40 }, (_, i) => i + 1));
    assert.ok(ls.every((l) => !("kind" in l)), "a new file's lines are plain text: the New label carries the meaning, no per-line added tint");
    assert.deepEqual(ls[ls.length - 1], { gap: true });
    assert.ok(c.caveats.some((x) => /first 40 of 100 lines/.test(x)));
    const d = await textRenderer.view(body, null, info({ kind: "deleted" }));
    assert.deepEqual(d.boxes, []);
    assert.deepEqual(nums(textOf(d, "before")), nums(ls));
    assert.match(d.after[0]!.label, /deleted/);
  });

  it("line endings only, equal bytes, binary and oversize are cards with no box", async () => {
    const lf = await textRenderer.view(buf("a\nb\n"), buf("a\r\nb\r\n"), info());
    assert.deepEqual([lf.kind, lf.boxes.length], ["card", 0]);
    // One side that is not text is named and the text side is drawn; both not text is a card.
    const bin = await textRenderer.view(buf("a\n"), Buffer.from([0, 1, 2]), info());
    assert.deepEqual([bin.kind, bin.boxes.length], ["pages", 0]);
    assert.ok(bin.caveats.some((c) => c.startsWith("The after version of ") && c.includes("are not text")));
    const binBoth = await textRenderer.view(Buffer.from([0, 1]), Buffer.from([0, 1, 2]), info());
    assert.deepEqual([binBoth.kind, binBoth.boxes.length], ["card", 0]);
    const big = await textRenderer.view(buf("a\n"), Buffer.alloc(3 * 1024 * 1024, 97), info());
    assert.equal(big.kind, "card");
    const miss = await textRenderer.view(null, buf("a\n"), info({ missing: ["The before state is no longer in the store."] }));
    assert.deepEqual([miss.kind, miss.boxes.length], ["card", 0]);
    assert.ok(miss.caveats.includes("The before state is no longer in the store."));
  });
});

describe("registry picks the text renderer by the text tier, not the name", () => {
  it("text tier gets text, no tier gets the fallback, an xlsx with no tier gets the fallback card", () => {
    const text = { tier: "text", label: "Text" } as ChangeInfo["generic"];
    assert.equal(rendererFor("a/b.csv", text), textRenderer);
    assert.equal(rendererFor("Makefile", text), textRenderer);
    assert.equal(rendererFor("a/b.csv"), fallbackRenderer);
    assert.equal(rendererFor("a.png", { tier: "picture", label: "p" } as ChangeInfo["generic"]), fallbackRenderer);
    // core has no Office renderer; a workbook (never a text tier) gets the fallback card.
    assert.equal(rendererFor("m.xlsx"), fallbackRenderer);
  });
});

// ---- xlsx created / deleted ----

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
function book(rowCount: number, sheets = 1): Buffer {
  const names = Array.from({ length: sheets }, (_, i) => `S${i + 1}`);
  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": enc(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`),
  };
  names.forEach((_, i) => {
    const rows = Array.from({ length: rowCount }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}" t="inlineStr"><is><t>Item ${r + 1}</t></is></c><c r="B${r + 1}"><v>${(r + 1) * 10}</v></c></row>`).join("");
    files[`xl/worksheets/sheet${i + 1}.xml`] = enc(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  return Buffer.from(zipSync(files, { mtime: new Date(2020, 0, 1) }));
}


// ---- the route, with the client name a hook-adapter task really has ----

const TOKEN = "t".repeat(40);
const CLIENT = "claude-hook:/work";
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Tl = { folder: string | null; unplaced: Array<{ id: string; file: string; outside: boolean; kind: string }>; requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string; file: string; outside: boolean; kind: string }> }> }> }> };

async function setup(opts: { markerDir?: string } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => null, quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const get = (p: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }).on("error", reject);
    });
  /** One task whose steps create each file (prev null) in the order given. */
  const task = async (files: Array<{ name: string; bytes: Buffer }>, client = CLIENT): Promise<number> => {
    const id = ledger.openTask(client);
    const states = await ensureStoreDir(home, id);
    if (opts.markerDir !== undefined) await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: opts.markerDir }));
    const callId = `toolu_${id}`;
    ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit", clientName: client, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: files.map((f) => `/work/${f.name}`), description: "write", narration: { source: "none", text: "none" } } });
    ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: client, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Make files."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
    let seq = 0;
    for (const f of files) {
      await writeSealed(path.join(states, sha(f.bytes)), f.bytes);
      ledger.recordStep({ taskId: id, client, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: `/work/${f.name}`, sha256: sha(f.bytes), prevSha256: null, size: f.bytes.length, kept: "whole", note: "" }] });
    }
    return id;
  };
  const changes = async (id: number): Promise<Tl["unplaced"]> => {
    const tl = JSON.parse((await get(`/timeline/${id}`)).body) as Tl;
    return [...tl.unplaced, ...tl.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))];
  };
  return { get, task, changes };
}

describe("the task folder under a hook-adapter client name", () => {
  it("a file under the folder is inside and relative, though the client is 'claude-hook:<folder>' and the marker names none", async () => {
    const s = await setup();
    const id = await s.task([{ name: "sub/a.csv", bytes: buf("x,y\n1,2\n") }]);
    const [c] = await s.changes(id);
    assert.equal(c!.outside, false);
    assert.equal(c!.file, "sub/a.csv");
  });

  it("a marker dir that itself carries the prefix reads the same", async () => {
    const s = await setup({ markerDir: "claude-hook:/work" });
    const id = await s.task([{ name: "a.csv", bytes: buf("x\n1\n") }], "claude:other");
    const [c] = await s.changes(id);
    assert.deepEqual([c!.outside, c!.file], [false, "a.csv"]);
  });

  it("a file really outside the folder is still outside", async () => {
    const s = await setup();
    const id = await s.task([{ name: "../elsewhere/a.csv", bytes: buf("x\n1\n") }]);
    const [c] = await s.changes(id);
    assert.equal(c!.outside, true);
  });

  it("view: a new csv is drawn, a new xlsx is a card with no grid and no picture; a secret file is 404", async () => {
    const s = await setup();
    const id = await s.task([
      { name: "a.csv", bytes: buf("name,qty\nbolt,4\nnut,9\n") },
      { name: "new.xlsx", bytes: book(5) },
      { name: ".env", bytes: buf("API_KEY=abc\n") },
    ]);
    const cs = await s.changes(id);
    const by = (n: string) => cs.find((c) => c.file.endsWith(n))!;
    const csv = await s.get(`/timeline/${id}/view/${by("a.csv").id}`);
    assert.equal(csv.status, 200);
    const cv = (await sceneOfBody(csv.body)) as unknown as View;
    assert.notEqual(cv.kind, "card");
    assert.deepEqual(nums(textOf(cv, "after")), [1, 2, 3]);
    assert.equal(cv.before[0]!.label, "There was nothing here yet");
    const x = (await sceneOfBody((await s.get(`/timeline/${id}/view/${by("new.xlsx").id}`)).body)) as unknown as View;
    assert.equal(x.kind, "card");
    assert.deepEqual([x.before, x.after, x.boxes], [[], [], []]);
    assert.ok(x.caveats.some((c) => c.startsWith("No picture of this file could be made")), JSON.stringify(x.caveats));
    const env = await s.get(`/timeline/${id}/view/${by(".env").id}`);
    assert.equal(env.status, 404);
    assert.ok(!env.body.includes("abc"));
  });
});
