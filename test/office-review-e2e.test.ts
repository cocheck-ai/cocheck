// one agent task edits an xlsx, a docx and a pptx; the three Office connectors' captures run through the real hook entry and settlePendingCaptures,
// with fake Office (no app is launched). (1) Excel's answer carries boxes and is accepted (the connector declares level 3 for Excel). (2)+(3) every file
// reaches captured with pictures and no time-out caveat: a capture that waits on another file's Office job does not lose its time to that wait.
// Must not (the other side): every capture still ends by its own diffMs; a connector that never answers does not hold the review past it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { settlePendingCaptures } from "../src/connector/file-capture.ts";
import { readFrozen } from "../src/connector/frozen.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger, type FileStateRow } from "../src/ledger.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";
import { workbookClaims } from "./helpers/claims.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OC = path.join(ROOT, "test", "fixtures", "office-connector");
const XL = path.join(ROOT, "test", "fixtures", "excel-look");
const HELPER = new URL("./helpers/office-e2e-connector.ts", import.meta.url).href;
const DIFF_MS = 8_000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  setKeyProvider(null);
  setBuiltinConnectorsForTest(undefined);
});

const APPS = [
  { id: "microsoft-excel", key: "excel", file: "fred.xlsx", before: path.join(XL, "answer-gdp-before.xlsx"), after: path.join(XL, "answer-gdp-after.xlsx") },
  { id: "microsoft-word", key: "word", file: "memo.docx", before: path.join(OC, "v1.docx"), after: path.join(OC, "v2.docx") },
  { id: "microsoft-powerpoint", key: "powerpoint", file: "deck.pptx", before: path.join(OC, "v1.pptx"), after: path.join(OC, "v2.pptx") },
] as const;

/** The three built-ins, each the real shipped manifest run through the test-only program, sharing one lock; diffMs shortened to DIFF_MS. */
async function builtins(diffMs = DIFF_MS, exportMs = 800): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "builtins-"));
  // CoCheck passes a connector only its allowed environment, so the shared settings are written into each launcher
  const env = { OFFICE_E2E_LOCK: path.join(root, "office.lock"), OFFICE_E2E_DIFF_MS: String(diffMs), OFFICE_E2E_EXPORT_MS: String(exportMs) };
  const list = [];
  for (const a of APPS) {
    const real = JSON.parse(await readFile(path.join(ROOT, "connectors", a.id, "cocheck-connector.json"), "utf8")) as Record<string, unknown>;
    const { requires: _r, ...manifest } = real;
    const dir = path.join(root, a.id);
    await mkdir(dir);
    await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ ...manifest, run: ["node", "connector.mjs"], diffMs }));
    await writeFile(path.join(dir, "connector.mjs"), `process.argv[2] = ${JSON.stringify(a.key)};\nObject.assign(process.env, ${JSON.stringify(env)});\nawait import(${JSON.stringify(HELPER)});\n`);
    list.push({ id: a.id, dir });
  }
  setBuiltinConnectorsForTest(list);
}

/** One task: one Bash call rewrites all three files, through the real hook entry. */
async function session(): Promise<Rig> {
  setKeyProvider(memoryKeyProvider());
  const r = await makeRig();
  cleanups.push(() => r.cleanup());
  for (const a of APPS) await writeFile(path.join(r.folder, a.file), await readFile(a.before));
  let clock = 1_700_000_000_000;
  const opts = { host: "claude" as const, home: r.home, claimed: workbookClaims, folder: r.folder, now: () => (clock += 1000) };
  const base = { session_id: "session-1", cwd: r.folder, transcript_path: "/x/t.jsonl", permission_mode: "default" };
  const call = (event: string, extra: Record<string, unknown> = {}) => ({ ...base, hook_event_name: event, tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "python3 build_all.py", description: "edit" }, ...extra });
  const send = (p: Record<string, unknown>) => handleHook(p as unknown as HookPayload, opts);
  await send({ ...base, hook_event_name: "UserPromptSubmit", prompt: "update the workbook, the memo and the deck" });
  await send(call("PreToolUse"));
  for (const a of APPS) await writeFile(path.join(r.folder, a.file), await readFile(a.after));
  await send(call("PostToolUse", { tool_response: { stdout: "ok" } }));
  return r;
}

const postRows = (home: string): FileStateRow[] => {
  const ledger = openLedger(home);
  try {
    return ledger.allTaskIds().flatMap((t) => ledger.fileStatesForTask(t)).filter((f) => f.phase === "Post");
  } finally {
    ledger.close();
  }
};

type Doc = { changes: { id: string; boxes?: unknown[]; unplaced?: unknown }[]; pictures?: unknown[]; caveats?: string[]; status?: unknown; pendingRetry?: number };

describe("the engine accepts Excel's level 3 answer; Word and PowerPoint stay at level 2", () => {
  const box = { spec: "cocheck.changes/1", pictures: [{ id: "p1", type: "image", side: "after", src: "data:image/png;base64,iVBORw0KGgo=", width: 10, height: 10, changed: true }], changes: [{ id: "c1", mark: "changed", label: "GDP!F5", before: "506", after: "55555", boxes: [{ picture: "p1", rect: { x: 1, y: 1, w: 2, h: 2 } }] }, { id: "c2", mark: "changed", label: "GDP!F7", before: "706", after: "99999", unplaced: { after: "in hidden row 7" } }], caveats: [] };
  it("an answer with boxes and unplaced passes changes-v1 at the level Excel's hello declares", async () => {
    const { levelFor } = await import("../src/office/connector/program.ts");
    // Excel's print pages carry boxes again, so Excel declares level 3 (the level 3 check itself is unchanged)
    assert.equal(levelFor(OFFICE_APPS.excel), 3);
    assert.deepEqual(checkChanges(box, 3), []);
  });
  it("Word and PowerPoint declare level 3, so their boxes are accepted", async () => {
    const { levelFor } = await import("../src/office/connector/program.ts");
    for (const a of [OFFICE_APPS.word, OFFICE_APPS.powerpoint]) {
      assert.equal(levelFor(a), 3);
      assert.deepEqual(checkChanges(box, levelFor(a)), []);
    }
  });
});

describe("one task editing an xlsx, a docx and a pptx: every Office file is captured with pictures", () => {
  const cases = [
    { name: "all three reach captured with pictures and no time-out caveat; Word and PowerPoint answers carry no level 3 field, the xlsx answer is valid at level 3", diffMs: DIFF_MS, exportMs: 800 },
    // each file fits its own diffMs (Word or PowerPoint about 3.3 s of a 4 s export window), the three together do not: run at once, the last one's diffMs runs out waiting
    { name: "each file fits its own diffMs but not the three together: still all captured, none waits out its time on another", diffMs: 6_000, exportMs: 1_500 },
  ];
  for (const k of cases) it(k.name, { timeout: 120_000 }, async () => {
    await builtins(k.diffMs, k.exportMs);
    const r = await session();
    const rows = postRows(r.home);
    assert.equal(rows.length, 3, JSON.stringify(rows.map((x) => x.filePath)));
    for (const row of rows) assert.equal(row.capture, "pending", `${row.filePath}: ${row.connector}`);
    const ledger = openLedger(r.home);
    try {
      await settlePendingCaptures(ledger, r.home, rows[0]!.taskId, k.diffMs);
    } finally {
      ledger.close();
    }
    for (const row of postRows(r.home)) {
      const name = path.basename(row.filePath);
      let pendingWhy = "";
      if (row.capture === "pending") { const l = openLedger(r.home); const t = l.captureTries(row.id); l.close(); if (t.latest) pendingWhy = JSON.stringify(((await readFrozen(r.home, row.taskId, t.latest)) as Doc).caveats); }
      assert.equal(row.capture, "captured", `${name}: ${row.capture} ${row.captureReason ?? ""} ${pendingWhy}`);
      const doc = (await readFrozen(r.home, row.taskId, row.changesSha256!)) as Doc;
      assert.ok((doc.pictures ?? []).length > 0, `${name}: no pictures; caveats: ${(doc.caveats ?? []).join(" | ")}`);
      assert.equal(doc.pendingRetry, undefined, `${name}: pending`);
      assert.equal(doc.status, undefined, `${name}: status ${JSON.stringify(doc.status)}`);
      for (const c of doc.caveats ?? []) assert.doesNotMatch(c, /out of time|time-out|timed out|did not answer|another CoCheck job/i, `${name}: ${c}`);
      // and: Excel's and Word's pages carry boxes and unplaced words (level 3 fields, declared in their hello); PowerPoint's stays at level 2, where those fields are refused
      if (name.endsWith(".xlsx") || name.endsWith(".docx")) assert.deepEqual(checkChanges(doc as never, 3), [], `${name}: not valid at level 3`);
      else assert.ok(doc.changes.every((c) => c.boxes === undefined && c.unplaced === undefined), `${name}: a level 3 field below level 3`);
    }
  });
});
