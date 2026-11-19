// Core forgets Office.
// The loader's own layers are the generic ones; a workbook or a document package is never read by core (no cell, paragraph, label, style or
// media rows). Every step a connector reads still draws words: a planted frozen-document step and a planted old row (connector NULL, captured at load) each show the connector's change list, never an error.
// Core's picture tier, the /preview/ route and the picture-crop route never draw a state whose row has a `connector`, whose file a known connector
// claims (built-in or installed), or which shares bytes with such a state. Must not happen either way: a claimed state drawn by Quick Look shows the
// reviewer something the app didn't draw (zero render calls); an unclaimed type (.png) still renders.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { freezeChanges } from "../src/connector/frozen.ts";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { writeSealed } from "../src/seal.ts";
import { ensureStoreDir, storeDirOf } from "../src/states.ts";
import { defaultLayers, formatChangesOf, loadTimeline } from "../src/timeline/load.ts";
import type { RawState } from "../src/timeline/runs.ts";
import { encodePng } from "./fixtures/png-encode.ts";

const TOKEN = "m".repeat(40);
const CLIENT = "claude-hook:/work";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  setBuiltinConnectorsForTest(undefined);
});

const DOC = { spec: "cocheck.changes/1", changes: [{ id: "c1", mark: "changed", label: "Sheet1!B2", before: "1", after: "2" }] };
/** A toy connector: hello at level 1, every diff answers DOC. Office is never run. */
const TOY = `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => { const m = JSON.parse(line);
  if (m.method === "hello") return process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.connector/1", level: 1, methods: ["diff"] } }) + "\\n");
  if (m.method === "diff") process.stdout.write(JSON.stringify({ id: m.id, result: ${JSON.stringify(DOC)} }) + "\\n");
});
`;
const OFFICE = [".xlsx", ".xlsm", ".docx", ".pptx", ".ppsx"];

async function connectorFolder(root: string, id: string, extensions: string[]): Promise<string> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id, version: "1.0.0", entry: "state", matches: { extensions }, run: ["node", "connector.mjs"] }));
  await writeFile(path.join(dir, "connector.mjs"), TOY);
  return dir;
}

/** A built-in claiming the Office endings (a toy: Office is never run) and an installed connector claiming `.foo`. */
async function claims(home: string): Promise<void> {
  const dir = await connectorFolder(await mkdtemp(path.join(tmpdir(), "builtin-")), "toy-office", OFFICE);
  setBuiltinConnectorsForTest([{ id: "toy-office", dir }]);
  await connectorFolder(path.join(home, "connectors"), "foo-reader", [".foo"]);
}

const bin = (tag: string): Buffer => Buffer.from(`PK\u0003\u0004\u0000${tag}`);

interface Planted { id: number; byFile: Map<string, { before: string; after: string }>; tagOf: Map<string, string> }

/** One task: each file goes from bin(<name>-1) to bin(<name>-2) in one step; `shared.bin` ends holding a.xlsx's after bytes. */
async function plant(ledger: Ledger, home: string, files: Array<{ name: string; connector?: string; after?: Buffer }>): Promise<Planted> {
  const id = ledger.openTask(CLIENT);
  const states = await ensureStoreDir(home, id);
  await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
  const byFile = new Map<string, { before: string; after: string }>();
  const tagOf = new Map<string, string>();
  const rows = [];
  for (const f of files) {
    // a real 40x40 png for the image, so it decodes and can be cut (images are read from the stored bytes)
    const png = (fill: number): Buffer => encodePng({ width: 40, height: 40, colorType: 6, raw: Buffer.alloc(40 * 40 * 4, fill) });
    const b = f.name.endsWith(".png") ? png(100) : bin(`${f.name}-1`), a = f.after ?? (f.name.endsWith(".png") ? png(200) : bin(`${f.name}-2`));
    for (const x of [b, a]) {
      await writeSealed(path.join(states, sha(x)), x);
      tagOf.set(sha(x), x.toString("latin1"));
    }
    byFile.set(f.name, { before: sha(b), after: sha(a) });
    rows.push({ filePath: `/work/${f.name}`, sha256: sha(a), prevSha256: sha(b), size: a.length, kept: "whole" as const, note: "", ...(f.connector ? { connector: f.connector } : {}) });
  }
  ledger.recordStep({ taskId: id, client: CLIENT, seq: 1, phase: "Post", callsOpen: [], credited: [], files: rows });
  return { id, byFile, tagOf };
}

async function server() {
  const home = await mkdtemp(path.join(tmpdir(), "home-"));
  await claims(home);
  const ledger = openLedger(home);
  const { server: srv, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined);
  cleanups.push(async () => {
    await new Promise<void>((r) => (srv as Server).close(() => r()));
    ledger.close();
  });
  const call = (method: string, p: string, json?: unknown): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const body = json === undefined ? undefined : JSON.stringify(json);
      const headers: Record<string, string> = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  return { home, ledger, call };
}

interface Chg { id: string; file: string; diff?: { changes: Array<{ anchors?: Array<{ label?: string }> }>; unavailable?: string; pending?: boolean; before?: { ref: string | null }; served?: { kind: string } }; generic?: { tier: string; label?: string } }
const labels = (c: Chg | undefined): string[] => (c?.diff?.changes ?? []).flatMap((x) => (x.anchors ?? []).map((a) => a.label ?? ""));
const changesOf = (body: string): Chg[] => {
  const t = JSON.parse(body) as { unplaced: Chg[]; requests: Array<{ runs: Array<{ calls: Array<{ changes: Chg[] }> }> }> };
  return [...t.unplaced, ...t.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))];
};

const settle = async (ms = 600): Promise<void> => {
  for (let i = 0; i < ms / 50; i++) await new Promise((r) => setTimeout(r, 50));
};

describe("core draws no state a connector reads", () => {
  const files = (): Array<{ name: string; connector?: string; after?: Buffer }> => [
    ...OFFICE.flatMap((e) => [{ name: `a${e}` }, { name: `b${e}`, connector: "toy-office" }]),
    { name: "c.foo" },
    { name: "shared.bin", after: bin("a.xlsx-2") },
    { name: "pic.png" },
  ];
  const claimedNames = (): string[] => files().map((f) => f.name).filter((n) => n !== "pic.png");

  it("the picture tier (the timeline), /preview/ and the picture-crop route are 404 for every claimed state; a .png is still served and cut", async () => {
    const s = await server();
    const p = await plant(s.ledger, s.home, files());
    const first = await s.call("GET", `/timeline/${p.id}`);
    assert.equal(first.status, 200, first.body);
    await settle();
    await s.call("GET", `/timeline/${p.id}`);
    for (const name of claimedNames()) {
      const { before, after } = p.byFile.get(name)!;
      // shared.bin is unclaimed: only its after state (a.xlsx's bytes) is blocked; its before state is checked in the other direction below
      for (const st of name === "shared.bin" ? [after] : [before, after]) assert.equal((await s.call("GET", `/timeline/${p.id}/preview/${st}`)).status, 404, `${name} /preview/`);
    }
    const cs = changesOf((await s.call("GET", `/timeline/${p.id}`)).body);
    for (const name of claimedNames()) {
      const c = cs.find((x) => x.file === name);
      assert.ok(c, name);
      for (const side of ["before", "after"]) {
        if (name === "shared.bin" && side === "before") continue;
        const r = await s.call("POST", `/timeline/${p.id}/review/region`, { change: c.id, side, kind: "picture", page: null, rect: [0.1, 0.1, 0.5, 0.5] });
        assert.ok(r.status === 404 || r.status === 400, `${name} crop ${side}: ${r.status} ${r.body}`);
      }
    }
    // the other direction: an unclaimed type keeps its picture on every path
    const png = p.byFile.get("pic.png")!;
    assert.equal((await s.call("GET", `/timeline/${p.id}/preview/${png.after}`)).status, 200);
    const pc = cs.find((x) => x.file === "pic.png")!;
    assert.equal((await s.call("POST", `/timeline/${p.id}/review/region`, { change: pc.id, side: "after", kind: "picture", page: null, rect: [0, 0, 1, 1] })).status, 200);
    // shared.bin is not an image: no picture of its before state either
    assert.equal((await s.call("GET", `/timeline/${p.id}/preview/${p.byFile.get("shared.bin")!.before}`)).status, 404);
  });

  it("a claimed state's picture-tier entry is a fingerprint that names why, never a picture (loader)", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "load-"));
    await claims(home);
    const ledger = openLedger(home);
    cleanups.push(async () => ledger.close());
    const p = await plant(ledger, home, files());
    const { timeline } = await loadTimeline(ledger, home, p.id, { build: "t" });
    const cs = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))] as unknown as Chg[];
    for (const name of claimedNames()) {
      const c = cs.find((x) => x.file === name)!;
      assert.equal(c.generic?.tier, "fingerprint", name);
      assert.match(c.generic?.label ?? "", /a connector reads this type of file/, name);
    }
    // the .png is not refused for a claim (its picture is pinned on the server paths above)
    assert.ok(!(cs.find((x) => x.file === "pic.png")!.generic?.label ?? "").includes("a connector reads this type of file"));
  });
});

describe("the loader reads no Office file itself", () => {
  const book = (v: number): Buffer => Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Total</t></is></c><c r="B1"><v>${v}</v></c></row></sheetData></worksheet>`),
  }, { mtime: new Date(2020, 0, 1) }));
  const memo = (t: string): Buffer => Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:body></w:document>`),
  }, { mtime: new Date(2020, 0, 1) }));

  async function rowsOf(name: string, b: Buffer, a: Buffer) {
    const home = await mkdtemp(path.join(tmpdir(), "fc-"));
    const states = await ensureStoreDir(home, 1);
    for (const x of [b, a]) await writeSealed(path.join(states, sha(x)), x);
    const s = { id: 1, step_id: 1, task_id: 1, file_path: `/work/${name}`, sha256: sha(a), prev_sha256: sha(b), phase: "Post", calls_open_json: "[]", credited_json: "[]", size: a.length, kept: "whole", note: "" } as unknown as RawState;
    return formatChangesOf(home, 1, s, defaultLayers(), new Map([[sha(a), a.length], [sha(b), b.length]]), new Set());
  }

  it("a workbook edit through core's layers is one whole-file row: no cell row, no label", async () => {
    const out = await rowsOf("book.xlsx", book(1), book(2));
    assert.ok("rows" in out, JSON.stringify(out));
    assert.deepEqual(out.rows.map((r) => r.kind), ["binary file changed"]);
    assert.ok(out.rows.every((r) => !/B1|Total/.test(`${r.location} ${r.text} ${r.label ?? ""}`)), JSON.stringify(out.rows));
    assert.equal("identicalParts" in out, false);
  });

  it("a document edit through core's layers is one whole-file row: no paragraph row", async () => {
    const out = await rowsOf("memo.docx", memo("one"), memo("two"));
    assert.ok("rows" in out, JSON.stringify(out));
    assert.deepEqual(out.rows.map((r) => r.kind), ["binary file changed"]);
  });

  it("text and csv keep their generic rows (the other direction)", async () => {
    const t = await rowsOf("notes.txt", Buffer.from("a\nb\n"), Buffer.from("a\nc\n"));
    assert.ok("rows" in t && t.rows.length > 0 && t.rows[0]!.kind !== "binary file changed", JSON.stringify(t));
    const c = await rowsOf("t.csv", Buffer.from("a,b\n1,2\n"), Buffer.from("a,b\n1,3\n"));
    assert.ok("rows" in c && c.rows.length > 0 && c.rows[0]!.kind !== "binary file changed", JSON.stringify(c));
  });

  it("must not: a planted frozen-document Office step and a planted old row (connector NULL, captured at load) each draw the connector's words", async () => {
    const s = await server();
    const p = await plant(s.ledger, s.home, [{ name: "old.xlsx" }, { name: "frozen.pptx", connector: "toy-office" }]);
    // the frozen step: its change list is the sealed document captured with it
    const frozen = await freezeChanges(s.home, p.id, DOC);
    const fr = p.byFile.get("frozen.pptx")!;
    const third = bin("frozen.pptx-3");
    await writeSealed(path.join(storeDirOf(s.home, p.id), sha(third)), third);
    s.ledger.recordStep({ taskId: p.id, client: CLIENT, seq: 2, phase: "Post", callsOpen: [], credited: [], files: [{ filePath: "/work/frozen.pptx", sha256: sha(third), prevSha256: fr.after, size: third.length, kept: "whole", note: "", connector: "toy-office", connectorVersion: "1.0.0", connectorSpec: "cocheck.connector/1", changesSha256: frozen.sha256 }] });
    await s.call("GET", `/timeline/${p.id}`);
    let cs: Chg[] = [];
    for (let i = 0; i < 40; i++) {
      await settle(100);
      cs = changesOf((await s.call("GET", `/timeline/${p.id}`)).body);
      if (cs.filter((c) => labels(c).includes("Sheet1!B2")).length >= 3) break;
    }
    const old = cs.find((c) => c.file === "old.xlsx");
    assert.equal(old?.diff?.unavailable, undefined, JSON.stringify(old?.diff));
    assert.deepEqual(labels(old), ["Sheet1!B2"], "the old row draws its change list, read later");
    const fz = cs.find((c) => c.file === "frozen.pptx" && c.diff?.before?.ref === fr.after);
    assert.equal(fz?.diff?.served?.kind, "frozen", JSON.stringify(fz?.diff));
    assert.deepEqual(labels(fz), ["Sheet1!B2"], "the frozen step draws its sealed document");
  });
});
