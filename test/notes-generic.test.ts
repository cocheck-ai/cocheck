// timeline/notes.ts keeps only the generic sentence engine. A connector step's note is worded from the connector's own
// document (each change's label, before, after and text), never from core's Office grammar, and never "can't read inside it" for a file a
// connector read. The rail note of a created file says what the connector listed; a document that vouches nothing changed says "saved again".
// Must not: an Office step whose wording came from core now shows nothing. A planted frozen-document step and a planted old
// row (connector NULL, captured at load) each draw words.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { freezeChanges } from "../src/connector/frozen.ts";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { writeSealed } from "../src/seal.ts";
import { ensureStoreDir } from "../src/states.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { Timeline } from "../src/timeline/timeline.ts";

const TOKEN = "n".repeat(40);
const CLIENT = "claude-hook:/work";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  setBuiltinConnectorsForTest(undefined);
});

const ONE = { spec: "cocheck.changes/1", changes: [{ id: "c1", mark: "changed", label: "Sheet1!B2", before: "1", after: "2", text: "B2: 1 -> 2" }] };
const TOY = `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => { const m = JSON.parse(line);
  if (m.method === "hello") return process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.connector/1", level: 1, methods: ["diff"] } }) + "\\n");
  if (m.method === "diff") process.stdout.write(JSON.stringify({ id: m.id, result: ${JSON.stringify(ONE)} }) + "\\n");
});
`;

async function toyBuiltin(): Promise<void> {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "builtin-")), "toy-office");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "toy-office", version: "1.0.0", entry: "state", matches: { extensions: [".xlsx", ".docx", ".pptx"] }, run: ["node", "connector.mjs"] }));
  await writeFile(path.join(dir, "connector.mjs"), TOY);
  setBuiltinConnectorsForTest([{ id: "toy-office", dir }]);
}

const bin = (tag: string): Buffer => Buffer.from(`PK\u0003\u0004\u0000${tag}`);

/** One step per entry: `doc` set plants a frozen-document connector row, absent plants an old row (connector NULL). `created` has no before side. */
async function plant(ledger: Ledger, home: string, files: Array<{ name: string; doc?: unknown; created?: boolean }>): Promise<number> {
  const id = ledger.openTask(CLIENT);
  const states = await ensureStoreDir(home, id);
  await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
  let seq = 0;
  for (const f of files) {
    const b = bin(`${f.name}-1`), a = bin(`${f.name}-2`);
    for (const x of [b, a]) await writeSealed(path.join(states, sha(x)), x);
    const frozen = f.doc === undefined ? null : await freezeChanges(home, id, f.doc);
    const conn = frozen === null ? {} : { connector: "toy-office", connectorVersion: "1.0.0", connectorSpec: "cocheck.connector/1", changesSha256: frozen.sha256 };
    ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [], credited: [], files: [{ filePath: `/work/${f.name}`, sha256: sha(a), prevSha256: f.created ? null : sha(b), size: a.length, kept: "whole", note: "", ...conn }] });
  }
  return id;
}

async function server() {
  const home = await mkdtemp(path.join(tmpdir(), "home-"));
  await toyBuiltin();
  const ledger = openLedger(home);
  const { server: srv, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (srv as Server).close(() => r()));
    ledger.close();
  });
  const get = (p: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, method: "GET", headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject);
      req.end();
    });
  return { home, ledger, get };
}

interface Chg { id: string; file: string; note?: { text: string }; diff?: { changes: unknown[]; unavailable?: string; pending?: boolean } }
const changesOf = (t: Timeline): Chg[] => [...(t.unplaced as unknown as Chg[]), ...t.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes as unknown as Chg[])))];
const railNote = (t: Timeline, file: string): string | undefined => {
  const m = buildRailModel(t) as unknown as { stops: Array<{ change?: { file: string; note: string } }> };
  return m.stops.find((s) => s.change?.file === file)?.change?.note;
};

async function timelineOf(s: Awaited<ReturnType<typeof server>>, id: number, ready: (cs: Chg[]) => boolean): Promise<Timeline> {
  let t = JSON.parse(await s.get(`/timeline/${id}`)) as Timeline;
  for (let i = 0; i < 60 && !ready(changesOf(t)); i++) {
    await new Promise((r) => setTimeout(r, 100));
    t = JSON.parse(await s.get(`/timeline/${id}`)) as Timeline;
  }
  return t;
}

const CANT_READ = "can't read inside it";

describe("a connector step's note comes from the connector's document", () => {
  it("a frozen step with one change is worded from its label, before and after; never 'can't read inside it'", async () => {
    const s = await server();
    const id = await plant(s.ledger, s.home, [{ name: "frozen.xlsx", doc: ONE }]);
    const t = await timelineOf(s, id, () => true);
    const c = changesOf(t).find((x) => x.file === "frozen.xlsx");
    assert.ok(c?.note?.text, JSON.stringify(c));
    assert.ok(!c.note.text.includes(CANT_READ), c.note.text);
    assert.match(c.note.text, /changed Sheet1!B2 from 1 to 2/);
    assert.ok(!(railNote(t, "frozen.xlsx") ?? "").includes(CANT_READ), String(railNote(t, "frozen.xlsx")));
  });

  it("a planted old row (connector NULL, captured at load) and a planted frozen-document step each draw words", async () => {
    const s = await server();
    const id = await plant(s.ledger, s.home, [{ name: "old.pptx" }, { name: "frozen.docx", doc: ONE }]);
    const t = await timelineOf(s, id, (cs) => cs.some((x) => x.file === "old.pptx" && x.diff !== undefined && x.diff.pending !== true));
    for (const file of ["old.pptx", "frozen.docx"]) {
      const c = changesOf(t).find((x) => x.file === file);
      assert.equal(c?.diff?.unavailable, undefined, `${file}: ${JSON.stringify(c?.diff)}`);
      assert.match(c?.note?.text ?? "", /changed Sheet1!B2 from 1 to 2/, `${file}: ${JSON.stringify(c?.note)}`);
      const rail = railNote(t, file) ?? "";
      assert.ok(rail !== "" && !rail.includes(CANT_READ), `${file} rail: ${rail}`);
    }
  });

  it("a created file's note says what the connector listed, so the rail note is not empty", async () => {
    const s = await server();
    const doc = { spec: "cocheck.changes/1", changes: [{ id: "c1", mark: "added", label: "Whole file", text: "new workbook: 2 sheets, 310 cells" }] };
    // a step before it, so the new file is not the task's starting copy
    const id = await plant(s.ledger, s.home, [{ name: "first.txt" }, { name: "made.xlsx", doc, created: true }]);
    const t = await timelineOf(s, id, () => true);
    const c = changesOf(t).find((x) => x.file === "made.xlsx");
    assert.match(c?.note?.text ?? "", /created made\.xlsx.* with new workbook: 2 sheets, 310 cells/, JSON.stringify(c?.note));
    assert.equal(railNote(t, "made.xlsx"), "New workbook: 2 sheets, 310 cells");
  });

  it("a document that vouches nothing changed (nothingChanged at capture, empty list) says saved again; one without the opt-in claims nothing", async () => {
    const s = await server();
    const same = { spec: "cocheck.changes/1", changes: [], caveats: [], source: { by: "connector", name: "toy-office", level: 2, nothingChanged: true } };
    const bare = { spec: "cocheck.changes/1", changes: [], caveats: [], source: { by: "connector", name: "toy-office", level: 2 } };
    const id = await plant(s.ledger, s.home, [{ name: "same.pptx", doc: same }, { name: "bare.pptx", doc: bare }]);
    const t = await timelineOf(s, id, () => true);
    const sameNote = changesOf(t).find((x) => x.file === "same.pptx")?.note?.text ?? "";
    assert.match(sameNote, /saved same\.pptx again: nothing changed\.$/, sameNote);
    const bareNote = changesOf(t).find((x) => x.file === "bare.pptx")?.note?.text ?? "";
    assert.ok(bareNote !== "" && !/saved .* again|nothing changed/.test(bareNote) && !bareNote.includes(CANT_READ), bareNote);
  });
});

describe("notes.ts is the generic engine only", () => {
  it("no cell-address grammar, sheet words, media kinds, deck-or-doc cards or Office saved-again wording; review.ts has no numfmt import", async () => {
    const notes = await readFile(new URL("../src/timeline/notes.ts", import.meta.url), "utf8");
    for (const gone of ["MEDIA_KINDS", "CELL_KINDS", "DECK_OR_DOC", "A1_CELL", "labelAt", "on the sheet", "the sheet", "docx", "pptx", "xlsx", "slide", "workbook", "formats/xlsx", "savedAgain"]) assert.ok(!notes.includes(gone), `notes.ts still has ${gone}`);
    const review = await readFile(new URL("../src/review.ts", import.meta.url), "utf8");
    assert.ok(!review.includes("numfmt"), "review.ts still imports numfmt");
  });
});
