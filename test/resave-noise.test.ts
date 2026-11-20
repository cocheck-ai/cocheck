// Resave noise, end to end. The built-in Office connectors' own code (run here with no Office driver, as on a machine
// without Office) vouches a plain Excel, PowerPoint or Word re-save as "nothing changed" (P3); the hook keeps claimed files whole on their own
// allowance; the lane rule mutes the vouched state. Fixtures: real files (an Excel-saved workbook, a real PowerPoint re-save pair from the
// live spike, a memo); the 300 MB and 1.1 GB folders are generated in temp folders at test time and removed after.
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { settleFileCapture } from "../src/connector/file-capture.ts";
import { removeHome } from "./helpers/remove-home.ts";
import { vouchesNothingChanged } from "../src/connector/nothing-changed-rule.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { answerDiff, type ProgramDeps } from "../src/office/connector/program.ts";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { docxOnlySavedDetailsDiffer, pptxOnlySavedDetailsDiffer, xlsxOnlySavedDetailsDiffer } from "../src/office/connector/shared/package-media.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { buildTimeline, type Timeline } from "../src/timeline/timeline.ts";
import { buildRailModel, SAVED_AGAIN_NOTHING_CHANGED, type RailModel, type RailStop } from "../src/timeline/rail/model.ts";
import { summarize } from "../src/timeline/rail/stop-status.ts";
import { readFrozen } from "../src/connector/frozen.ts";

await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
const VT = (globalThis as unknown as { CoCheckViewTable: { coverageLine: (doc: unknown) => string; NOTHING_CHANGED: string } }).CoCheckViewTable;
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { OUTSIDE_LANE, UNSURE_LANE } from "../src/timeline/attribution.ts";

const ROOT = path.join(import.meta.dirname, "..");
const FIX = path.join(import.meta.dirname, "fixtures");
const MB = 1024 * 1024;

// ---- real files and app-style re-saves ----
const XLSX = readFileSync(path.join(FIX, "lbo-excel-saved-f5-hardcoded.xlsx"));
const PPTX = readFileSync(path.join(FIX, "deck-resave.pptx"));
const PPTX_RESAVED = readFileSync(path.join(FIX, "deck-resave-resaved.pptx")); // a real PowerPoint re-save (live spike): core.xml and the sldGuideLst
const DOCX = readFileSync(path.join(FIX, "memo-v1.docx"));

function repack(bytes: Uint8Array, edits: Record<string, (text: string) => string>, add: Record<string, string> = {}, drop: string[] = []): Buffer {
  const parts = unzipSync(bytes);
  for (const [name, f] of Object.entries(edits)) parts[name] = strToU8(f(strFromU8(parts[name]!)));
  for (const [name, text] of Object.entries(add)) parts[name] = strToU8(text);
  for (const name of drop) delete parts[name];
  return Buffer.from(zipSync(parts, { mtime: new Date(2026, 10, 17) }));
}
const coreSaved = (t: string) => t.replace(/(<dcterms:modified[^>]*>)[^<]*</, "$12026-11-17T12:00:00Z<").replace(/(<cp:lastModifiedBy>)[^<]*</, "$1Someone Else<");
/** What a save rewrites in app.xml: the application version (and TotalTime where it is kept). */
const appSaved = (t: string) => t.replace(/<AppVersion>[^<]*<\/AppVersion>/, "<AppVersion>16.0400</AppVersion>").replace(/<TotalTime>\d+<\/TotalTime>/, "<TotalTime>7</TotalTime>");
/** What Excel rewrites on a plain save: core.xml, app.xml and the revisionPtr attributes. */
const excelResave = (b: Uint8Array) => repack(b, { "docProps/core.xml": coreSaved, "docProps/app.xml": appSaved, "xl/workbook.xml": (t) => t.replace(/revIDLastSave="\d+"/, 'revIDLastSave="7"').replace(/documentId="[^"]*"/, 'documentId="13_ncr:1_{11111111-2222-3333-4444-555555555555}"') });
/** What Word rewrites on a plain save: core.xml and app.xml. */
const wordResave = (b: Uint8Array) => repack(b, { "docProps/core.xml": coreSaved, "docProps/app.xml": appSaved });
/** One cell's value changed (the first plain numeric constant of the first sheet that has one). */
function cellEdit(b: Uint8Array): Buffer {
  const parts = unzipSync(b);
  for (const name of Object.keys(parts).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()) {
    const was = strFromU8(parts[name]!);
    const now = was.replace(/(<c (?![^>]* t=)[^>]*>)<v>[-\d.]+<\/v>/, (_m, head) => `${head}<v>4242</v>`);
    if (now !== was) return repack(b, { [name]: () => now });
  }
  throw new Error("no numeric constant to edit");
}

const deps = (): ProgramDeps => ({ driver: undefined, pager: undefined as never, lockPath: path.join(tmpdir(), "f8-office.lock") });
const withOptIn = (doc: object) => ({ ...doc, source: { by: "connector", name: "x", level: 3, nothingChanged: true } });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function scratch(prefix: string): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  cleanups.push(() => removeHome(d));
  return d;
}

describe("the built-in Office connectors vouch a plain re-save, and only that (P3)", () => {
  const cases: Array<[keyof typeof OFFICE_APPS, string, Uint8Array, Uint8Array]> = [
    ["excel", "xlsx", XLSX, excelResave(XLSX)],
    ["powerpoint", "pptx", PPTX, PPTX_RESAVED],
    ["word", "docx", DOCX, wordResave(DOCX)],
  ];
  for (const [app, ext, was, now] of cases) {
    it(`${ext}: an ${app}-style re-save is the bare empty list, which vouches nothing changed`, async () => {
      const d = await scratch("ans-");
      await writeFile(path.join(d, `a.${ext}`), was);
      await writeFile(path.join(d, `b.${ext}`), now);
      const doc = await answerDiff(OFFICE_APPS[app], path.join(d, `a.${ext}`), path.join(d, `b.${ext}`), deps());
      assert.deepEqual(doc.changes, []);
      assert.deepEqual(doc.caveats, []);
      assert.equal(vouchesNothingChanged(withOptIn(doc)), true);
    });
  }

  // A file regenerated by a script (the body written again unchanged) carries a fresh creation time as well as the save fields.
  const regenerated = (b: Uint8Array) => repack(b, { "docProps/core.xml": (t) => t.replace(/(<dcterms:created[^>]*>)[^<]*</, "$12026-11-19T21:00:00Z<") });
  for (const [app, ext, was, now] of cases) {
    it(`${ext}: a regenerated file with an identical body (new creation time) vouches nothing changed`, async () => {
      const d = await scratch("regen-");
      const again = regenerated(now);
      assert.notEqual(strFromU8(unzipSync(again)["docProps/core.xml"]!), strFromU8(unzipSync(now)["docProps/core.xml"]!), "the creation time moved");
      await writeFile(path.join(d, `a.${ext}`), was);
      await writeFile(path.join(d, `b.${ext}`), again);
      const doc = await answerDiff(OFFICE_APPS[app], path.join(d, `a.${ext}`), path.join(d, `b.${ext}`), deps());
      assert.deepEqual(doc.changes, []);
      assert.equal(vouchesNothingChanged(withOptIn(doc)), true);
    });
  }

  it("xlsx: a one-cell edit is a change in the list, never vouched", async () => {
    const d = await scratch("ans-");
    await writeFile(path.join(d, "a.xlsx"), XLSX);
    await writeFile(path.join(d, "b.xlsx"), cellEdit(excelResave(XLSX)));
    const doc = await answerDiff(OFFICE_APPS.excel, path.join(d, "a.xlsx"), path.join(d, "b.xlsx"), deps());
    assert.ok(doc.changes.length > 0);
    assert.equal(vouchesNothingChanged(withOptIn(doc)), false);
  });

  // Rule 39: the allow-lists are exact over the whole package. Every part outside them, mutated beside a full re-save, is never "saved details only".
  const allow: Array<[string, Uint8Array, (a: Uint8Array, b: Uint8Array) => boolean, (b: Uint8Array) => Buffer, string[]]> = [
    ["xlsx", XLSX, xlsxOnlySavedDetailsDiffer, excelResave, ["docProps/core.xml", "docProps/app.xml", "xl/workbook.xml"]],
    ["docx", DOCX, docxOnlySavedDetailsDiffer, wordResave, ["docProps/core.xml", "docProps/app.xml"]],
    ["pptx", PPTX, pptxOnlySavedDetailsDiffer, () => PPTX_RESAVED, ["docProps/core.xml", "docProps/app.xml", "ppt/presentation.xml"]],
  ];
  for (const [ext, base, rule, resave, listed] of allow) {
    it(`${ext}: any byte changed in any other part (rels, media, binaries included), a part added or removed, is never saved details only`, () => {
      const saved = resave(base);
      assert.equal(rule(base, saved), true, "the re-save itself passes");
      const parts = unzipSync(saved);
      const others = Object.keys(parts).filter((n) => !listed.includes(n) && !n.endsWith("/"));
      assert.ok(others.length >= 5, others.join(", "));
      for (const name of others) {
        const p = { ...parts, [name]: new Uint8Array([...parts[name]!, 0x20]) };
        assert.equal(rule(base, Buffer.from(zipSync(p))), false, `${name} changed`);
        const q = { ...parts };
        delete q[name];
        assert.equal(rule(base, Buffer.from(zipSync(q))), false, `${name} removed`);
      }
      assert.equal(rule(base, Buffer.from(zipSync({ ...parts, "customXml/item9.xml": strToU8("<x/>") }))), false, "a part added");
    });
  }

  // core.xml is not a saved detail as a whole. An agent setting a title, subject, author or keywords must
  // never read as "nothing changed"; only the per-save fields (modified time, last modified by, revision, app.xml's TotalTime...) are set aside.
  const titled = (t: string, title = "Board pack Q4") =>
    /<dc:title\b/.test(t) ? t.replace(/<dc:title\s*\/>|<dc:title>[^<]*<\/dc:title>/, `<dc:title>${title}</dc:title>`) : t.replace(/(<cp:coreProperties\b[^>]*>)/, `$1<dc:title>${title}</dc:title>`);
  const edits: Array<[string, (t: string) => string]> = [
    ["title", (t) => titled(t)],
    ["subject", (t) => t.replace(/(<cp:coreProperties\b[^>]*>)/, "$1<dc:subject>Confidential</dc:subject>")],
    ["author", (t) => (/<dc:creator>[^<]*<\/dc:creator>/.test(t) ? t.replace(/<dc:creator>[^<]*<\/dc:creator>/, "<dc:creator>Someone Else</dc:creator>") : t.replace(/(<cp:coreProperties\b[^>]*>)/, "$1<dc:creator>Someone Else</dc:creator>"))],
    ["keywords", (t) => t.replace(/(<cp:coreProperties\b[^>]*>)/, "$1<cp:keywords>draft</cp:keywords>")],
  ];
  for (const [app, ext, was, now] of cases) {
    it(`${ext}: a re-save that also sets the title, subject, author or keywords is a change, never "nothing changed"`, async () => {
      const d = await scratch("title-");
      await writeFile(path.join(d, `a.${ext}`), was);
      for (const [what, edit] of edits) {
        await writeFile(path.join(d, `b.${ext}`), repack(now, { "docProps/core.xml": edit }));
        const doc = await answerDiff(OFFICE_APPS[app], path.join(d, `a.${ext}`), path.join(d, `b.${ext}`), deps());
        assert.ok(doc.changes.length > 0, `${what}: ${JSON.stringify(doc.changes)}`);
        assert.equal(vouchesNothingChanged(withOptIn(doc)), false, what);
      }
    });
  }

  it("xlsx: workbook.xml outside the revisionPtr attributes is never set aside; pptx: presentation.xml beyond the guide list is never set aside", () => {
    assert.equal(xlsxOnlySavedDetailsDiffer(XLSX, repack(excelResave(XLSX), { "xl/workbook.xml": (t) => t.replace(/<sheet name="([^"]+)"/, '<sheet name="$1 renamed"') })), false, "a sheet renamed");
    assert.equal(xlsxOnlySavedDetailsDiffer(XLSX, repack(excelResave(XLSX), { "xl/workbook.xml": (t) => t.replace("<xr:revisionPtr ", '<xr:revisionPtr hidden="1" ').replace("</workbook>", '<definedNames><definedName name="X">Sheet1!$A$1</definedName></definedNames></workbook>') })), false, "a defined name beside a revisionPtr edit");
    // a revisionPtr whose prefix is not bound to the revision namespace is content like any other element
    const unbound = (b: Uint8Array) => repack(b, { "xl/workbook.xml": (t) => t.replace(/xmlns:xr="[^"]*"/, 'xmlns:xr="urn:not-the-revision-namespace"') });
    assert.equal(xlsxOnlySavedDetailsDiffer(unbound(XLSX), unbound(excelResave(XLSX))), false, "revisionPtr outside its namespace");
    const pres = (f: (t: string) => string) => repack(PPTX_RESAVED, { "ppt/presentation.xml": f });
    assert.equal(pptxOnlySavedDetailsDiffer(PPTX, pres((t) => t.replace(/<p:sldSz [^>]*\/>/, '<p:sldSz cx="9144000" cy="5143500"/>'))), false, "slide size");
    assert.equal(pptxOnlySavedDetailsDiffer(PPTX, pres((t) => t.replace("</p15:sldGuideLst>", "</p15:sldGuideLst>").replace(/<p15:sldGuideLst ([^>]*)\/>/, '<p15:sldGuideLst $1/></p:ext><p:ext uri="{OTHER}"><p:x/>'))), false, "another extension beside the guides");
  });
});

// ---- the whole chain: real hook, real capture (the built-in Office connector code with no driver), real timeline ----

/** Three connectors with the production ids, each serving the real Office connector program with no Office driver. */
async function officeNoDriver(): Promise<void> {
  const root = await scratch("conn-");
  const list: Array<{ id: string; dir: string }> = [];
  for (const [key, app] of Object.entries(OFFICE_APPS)) {
    const dir = path.join(root, app.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: app.id, version: "1.0.0", entry: "state", matches: { extensions: app.exts }, run: ["node", "connector.mjs"] }));
    await writeFile(path.join(dir, "connector.mjs"), `import { serve } from ${JSON.stringify(path.join(ROOT, "src/office/connector/program.ts"))};
import { OFFICE_APPS } from ${JSON.stringify(path.join(ROOT, "src/office/connector/apps.ts"))};
await serve(OFFICE_APPS[${JSON.stringify(key)}], { driver: undefined, pager: undefined, lockPath: ${JSON.stringify(path.join(dir, "lock"))} });
`);
    list.push({ id: app.id, dir });
  }
  setBuiltinConnectorsForTest(list);
}

/** An outside connector, installed in the home, claiming `.foo`: opts into the rule and answers an empty list when the two files are the same apart from a "saved" line. */
async function fooConnector(home: string, answer: "rule" | "error"): Promise<void> {
  const dir = path.join(home, "connectors", "foo-notes");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "foo-notes", version: "1.0.0", entry: "state", matches: { extensions: [".foo"] }, run: ["node", "connector.mjs"] }));
  await writeFile(path.join(dir, "connector.mjs"), `import readline from "node:readline";
import { readFileSync } from "node:fs";
const body = (f) => readFileSync(f, "utf8").split("\\n").filter((l) => !l.startsWith("saved:")).join("\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => { const m = JSON.parse(line);
  if (m.method === "hello") return process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.connector/1", level: 2, methods: ["diff"], nothingChanged: true } }) + "\\n");
  if (m.method === "diff") {
    ${answer === "error" ? 'return process.stdout.write(JSON.stringify({ id: m.id, error: { code: "failed", message: "the notes file could not be read" } }) + "\\n");' : ""}
    const same = body(m.params.before) === body(m.params.after);
    process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.changes/1", changes: same ? [] : [{ id: "c1", mark: "changed", label: "Notes" }] } }) + "\\n");
  }
});
`);
}

/** `count` claimed bulk files of `each` bytes, distinct, never touched; made once per size and cloned into each folder. */
const bulkCache = new Map<string, string[]>();
let bulkRoot: string | undefined;
async function bulk(folder: string, count: number, each: number, prefix: string): Promise<void> {
  const key = `${count}x${each}`;
  let files = bulkCache.get(key);
  if (files === undefined) {
    bulkRoot ??= await realpath(await mkdtemp(path.join(tmpdir(), "f8-bulk-")));
    files = [];
    const block = randomBytes(MB);
    for (let i = 0; i < count; i++) {
      const f = path.join(bulkRoot, `${key}-${i}.xlsx`);
      const buf = Buffer.alloc(each);
      for (let o = 0; o < each; o += MB) block.copy(buf, o);
      buf.writeUInt32BE(i + 1, 0);
      await writeFile(f, buf);
      files.push(f);
    }
    bulkCache.set(key, files);
  }
  for (const [i, f] of files.entries()) await copyFile(f, path.join(folder, `${prefix}${String(i).padStart(2, "0")}.xlsx`), constants.COPYFILE_FICLONE);
}
after(async () => { if (bulkRoot !== undefined) await rm(bulkRoot, { recursive: true, force: true }); });

type Ev = Record<string, unknown>;
async function chain(opts: { files: Record<string, Uint8Array | string>; bulk?: { count: number; each: number }; foo?: "rule" | "error"; caps?: Record<string, number> }) {
  const home = await scratch("home-");
  const folder = await scratch("folder-");
  if (opts.bulk) await bulk(folder, opts.bulk.count, opts.bulk.each, "a-bulk-");
  for (const [n, b] of Object.entries(opts.files)) await writeFile(path.join(folder, n), b);
  if (opts.foo) await fooConnector(home, opts.foo);
  let clock = 1_700_000_000_000;
  // No `claimed` option: the hook asks the connectors' own claims (claimedFor), so a claim is a manifest's, built-in or installed.
  const hookOpts = { host: "claude" as const, home, folder, perSession: false, now: () => (clock += 1000), ...(opts.caps ? { caps: opts.caps } : {}) };
  const base = { session_id: "session-1", cwd: folder, transcript_path: "/x/t.jsonl", permission_mode: "default" };
  const send = (p: Ev) => handleHook({ ...base, ...p } as unknown as HookPayload, hookOpts);
  const pre = (id: string, command: string, extra: Ev = {}) => send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command, description: id }, ...extra });
  const post = (id: string, command: string, extra: Ev = {}) => send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command, description: id }, tool_response: { stdout: "ok" }, ...extra });
  const put = (n: string, b: Uint8Array | string) => writeFile(path.join(folder, n), b);
  await send({ hook_event_name: "UserPromptSubmit", prompt: "tidy the files" });
  const finish = async (): Promise<{ timeline: Timeline; model: RailModel }> => {
    await send({ hook_event_name: "Stop" });
    const ledger = openLedger(home);
    try {
      const id = ledger.allTaskIds().at(-1)!;
      for (const row of ledger.pendingCapturesForTask(id)) await settleFileCapture(ledger, home, row, 20_000);
      const input = await loadTimelineInput(ledger, home, loadRows(ledger, id, "t"), { build: "t", quickLook: false, render: async () => null });
      const timeline = buildTimeline(input);
      return { timeline, model: buildRailModel(timeline) };
    } finally {
      ledger.close();
    }
  };
  const store = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const t of await readdir(path.join(home, "tasks")).catch(() => [] as string[])) out.push(...(await readdir(path.join(home, "tasks", t, "states")).catch(() => [] as string[])));
    return out;
  };
  return { home, folder, pre, post, put, send, finish, store };
}
const stopFor = (m: RailModel, file: string): RailStop | undefined => m.stops.find((s) => s.change?.file === file);
const RESAVED: Record<string, () => Buffer> = { "book.xlsx": () => excelResave(XLSX), "deck.pptx": () => PPTX_RESAVED, "memo.docx": () => wordResave(DOCX) };
const START = { "book.xlsx": XLSX, "deck.pptx": PPTX, "memo.docx": DOCX };

describe("re-saves in a folder with 300 MB of claimed files", () => {
  before(() => setKeyProvider(memoryKeyProvider()));
  after(() => { setKeyProvider(null); setBuiltinConnectorsForTest(undefined); });

  it("one Bash call open: each re-save stays on the agent's lane, muted, 'saved again, nothing changed'", async () => {
    await officeNoDriver();
    const t = await chain({ files: START, bulk: { count: 6, each: 50 * MB } });
    await t.pre("toolu_1", "osascript save-all.scpt");
    for (const [n, b] of Object.entries(RESAVED)) await t.put(n, b());
    await t.post("toolu_1", "osascript save-all.scpt");
    const { model, timeline } = await t.finish();
    for (const n of Object.keys(RESAVED)) {
      const s = stopFor(model, n);
      assert.ok(s, `${n} has its step: ${model.stops.map((x) => x.change?.file).join(", ")}`);
      assert.ok(s.lane !== null && s.lane !== OUTSIDE_LANE && s.lane !== UNSURE_LANE, `${n} on the agent's lane (${s.lane})`);
      assert.equal(s.muted, true, n);
      assert.equal(s.sub, SAVED_AGAIN_NOTHING_CHANGED, n);
    }
    assert.doesNotMatch(timeline.missing.join(" "), /shown under no call/);
    // One nothing-changed signal the real captures are level-1 empty lists; the note, the lane rule and the page line all say it.
    const changes = timeline.requests.flatMap((r) => r.runs.flatMap((x) => x.calls.flatMap((c) => c.changes)));
    const ledger = openLedger(t.home);
    try {
      for (const n of Object.keys(RESAVED)) {
        const c = changes.find((x) => x.file === n)!;
        assert.equal(c.diff?.served && "level" in c.diff.served ? c.diff.served.level : null, 1, `${n}: a real capture is drawn at level 1`);
        assert.equal(c.diff?.nothing, "changed", n);
        assert.match(c.note.text, /saved .* again: nothing changed/, n);
        const row = ledger.allTaskIds().flatMap((id) => ledger.fileStatesForTask(id)).find((r) => r.filePath.endsWith(`/${n}`) && r.changesSha256 !== null)!;
        const frozen = (await readFrozen(t.home, row.taskId, row.changesSha256!)) as { source: object };
        assert.equal(VT.coverageLine(frozen), VT.NOTHING_CHANGED, `${n}: the page draws "saved again, nothing changed"`);
      }
    } finally {
      ledger.close();
    }
  });

  it("two helper calls open: no lane stop, a muted line in each file's history", async () => {
    await officeNoDriver();
    const t = await chain({ files: START, bulk: { count: 6, each: 50 * MB } });
    const h = (n: string) => ({ agent_id: `agent-${n}`, agent_type: "general-purpose" });
    await t.pre("toolu_h1", "python3 tidy.py", h("1"));
    await t.pre("toolu_h2", "python3 check.py", h("2"));
    for (const [n, b] of Object.entries(RESAVED)) await t.put(n, b());
    await t.post("toolu_h1", "python3 tidy.py", h("1"));
    await t.post("toolu_h2", "python3 check.py", h("2"));
    const { model, timeline } = await t.finish();
    for (const n of Object.keys(RESAVED)) {
      const s = stopFor(model, n)!;
      assert.equal(s.lane, null, `${n}: no stop on any lane`);
      assert.equal(s.muted, true);
      assert.ok(s.history !== undefined);
      assert.equal(model.files.find((f) => f.file === n)?.versions.at(-1)?.muted, true, `${n} in its history, muted`);
    }
    assert.ok(!model.stops.some((s) => s.lane === UNSURE_LANE), "nothing on the '?' lane");
    assert.doesNotMatch(timeline.missing.join(" "), /shown under no call/);
  });

  it("between calls: no outside stop", async () => {
    await officeNoDriver();
    const t = await chain({ files: START, bulk: { count: 6, each: 50 * MB } });
    await t.pre("toolu_1", "ls");
    await t.post("toolu_1", "ls");
    for (const [n, b] of Object.entries(RESAVED)) await t.put(n, b());
    await t.pre("toolu_2", "ls");
    await t.post("toolu_2", "ls");
    const { model, timeline } = await t.finish();
    for (const n of Object.keys(RESAVED)) assert.equal(stopFor(model, n)?.lane, null, n);
    assert.ok(!model.stops.some((s) => s.lane === OUTSIDE_LANE), "nothing on the outside lane");
    assert.doesNotMatch(timeline.missing.join(" "), /shown under no call/);
  });

  it("F6: a person's no-edit save of an untouched claimed file opens no item: the sign-off gate asks for nothing, and the TaskStore writes no outside row", async () => {
    await officeNoDriver();
    const t = await chain({ files: { ...START, "notes.txt": "n\n" }, bulk: { count: 6, each: 50 * MB } });
    await t.pre("toolu_1", "echo a > notes.txt");
    await t.put("notes.txt", "a\n");
    await t.post("toolu_1", "echo a > notes.txt");
    // Stop cuts the TaskStore's round with the claimed files as they are; the person then saves them again in the apps, and the agent works on.
    await t.send({ hook_event_name: "Stop" });
    for (const [n, b] of Object.entries(RESAVED)) await t.put(n, b());
    await t.send({ hook_event_name: "UserPromptSubmit", prompt: "one more" });
    await t.pre("toolu_2", "echo b > notes.txt");
    await t.put("notes.txt", "b\n");
    await t.post("toolu_2", "echo b > notes.txt");
    const { model, timeline } = await t.finish();
    const resaves = Object.keys(RESAVED).map((n) => stopFor(model, n)!);
    for (const s of resaves) assert.ok(s.history !== undefined, `${s.change?.file}: a muted line, no lane`);
    const sum = summarize(model, timeline, []);
    for (const s of resaves) assert.ok(!sum.submit.notReviewed.includes(s.id), `${s.change?.file} is no open item at sign-off`);
    assert.equal(sum.submit.notReviewed.length, sum.counts.not_reviewed, "the counts leave it out too");
    assert.ok(sum.submit.notReviewed.length > 0, "the agent's own steps still ask to be looked at");
    const ledger = openLedger(t.home);
    try {
      const rows = ledger.allTaskIds().flatMap((id) => ledger.reviewRowsForTask(id)).filter((r) => Object.keys(RESAVED).some((n) => r.filePath.endsWith(`/${n}`)) && /outside/.test(r.kind));
      assert.deepEqual(rows.map((r) => `${path.basename(r.filePath)}: ${r.description}`), [], "no 'changed outside CoCheck' row for a file the chain tracks");
    } finally {
      ledger.close();
    }
  });

  it("a one-cell edit in the same setup is a normal change with a change list", async () => {
    await officeNoDriver();
    const t = await chain({ files: START, bulk: { count: 6, each: 50 * MB } });
    await t.pre("toolu_1", "python3 edit.py book.xlsx");
    await t.put("book.xlsx", cellEdit(XLSX));
    await t.post("toolu_1", "python3 edit.py book.xlsx");
    const { model, timeline } = await t.finish();
    const s = stopFor(model, "book.xlsx")!;
    assert.ok(s.lane !== null && s.lane !== OUTSIDE_LANE);
    assert.equal(s.muted, undefined);
    const change = timeline.requests.flatMap((r) => r.runs.flatMap((x) => x.calls.flatMap((c) => c.changes))).find((c) => c.file === "book.xlsx")!;
    assert.ok((change.diff?.changes.length ?? 0) > 0, "a change list");
    assert.equal(change.resave, undefined);
  });
});

describe("the planted TaskStore case", () => {
  it("an untouched file the hook's chain tracks gets no 'changed outside CoCheck' row when it moves between rounds; a file outside the chain still does", async () => {
    const home = await scratch("home-");
    const folder = await scratch("folder-");
    const ledger = openLedger(home);
    cleanups.push(async () => ledger.close());
    const tasks = new TaskStore(ledger, home, [createFilesLayer()]);
    const f = (n: string) => path.join(folder, n);
    await writeFile(f("a.txt"), "anchor\n");
    await writeFile(f("chained.txt"), "one\n");
    await writeFile(f("plain.txt"), "one\n");
    const id = await tasks.touch("c", f("a.txt"));
    // The hook's chain tracks chained.txt (its baseline state); plain.txt is a file only the TaskStore watches.
    ledger.recordStep({ taskId: id, client: "c", seq: 1, phase: "Pre", callsOpen: [], credited: [], files: [{ filePath: f("chained.txt"), sha256: "a".repeat(64), prevSha256: null, size: 4, kept: "whole", note: "" }] });
    await writeFile(f("chained.txt"), "one\n\n");
    await writeFile(f("plain.txt"), "one\n\n");
    await tasks.submit("c", "round", false);
    const rows = ledger.reviewRowsForTask(id).map((r) => `${path.basename(r.filePath)}: ${r.kind}`);
    assert.ok(!rows.some((r) => r.startsWith("chained.txt")), rows.join(" | "));
    assert.ok(rows.some((r) => r.startsWith("plain.txt") && /outside/.test(r)), rows.join(" | "));
  });
});

describe("no built-in privilege, failures and the caps", () => {
  before(() => setKeyProvider(memoryKeyProvider()));
  after(() => { setKeyProvider(null); setBuiltinConnectorsForTest(undefined); });

  it("an outside connector claiming .foo gets the allowance (kept whole past the general caps) and the muting", async () => {
    setBuiltinConnectorsForTest([]);
    const t = await chain({ files: { "notes.foo": "a\nb\nsaved: monday\n", "x.txt": "x\n" }, foo: "rule", caps: { scanFiles: 0 } });
    await t.pre("toolu_1", "notes-app save");
    await t.put("notes.foo", "a\nb\nsaved: tuesday\n");
    await t.post("toolu_1", "notes-app save");
    const { model } = await t.finish();
    const ledger = openLedger(t.home);
    try {
      const first = ledger.fileStatesForTask(ledger.allTaskIds().at(-1)!).filter((r) => r.prevSha256 === null);
      assert.equal(first.find((r) => r.filePath.endsWith("notes.foo"))!.kept, "whole", "the claimed allowance, though the general caps keep nothing");
      assert.equal(first.find((r) => r.filePath.endsWith("x.txt"))!.kept, "hash");
    } finally {
      ledger.close();
    }
    const s = stopFor(model, "notes.foo")!;
    assert.ok(s.lane !== null && s.lane !== OUTSIDE_LANE && s.lane !== UNSURE_LANE);
    assert.equal(s.muted, true);
  });

  it("a failed connector answer on a re-save gives a normal stop", async () => {
    setBuiltinConnectorsForTest([]);
    const t = await chain({ files: { "notes.foo": "a\nsaved: monday\n" }, foo: "error" });
    await t.pre("toolu_1", "ls");
    await t.post("toolu_1", "ls");
    await t.put("notes.foo", "a\nsaved: tuesday\n");
    await t.pre("toolu_2", "ls");
    await t.post("toolu_2", "ls");
    const { model, timeline } = await t.finish();
    const s = stopFor(model, "notes.foo")!;
    assert.equal(s.lane, OUTSIDE_LANE, "a normal stop on the outside lane");
    assert.equal(s.muted, undefined);
    assert.match(timeline.missing.join(" "), /shown under no call/);
  });

  it("1.1 GB of claimed files: past 1 GB, hash only; one named by the editing call gets both sides; one not named reads 'changed or saved again'", async () => {
    await officeNoDriver();
    const t = await chain({ files: { "zz-named.xlsx": XLSX, "zz-quiet.xlsx": excelResave(XLSX) }, bulk: { count: 11, each: Math.floor((1024 * MB) / 10) } }); // ten fill the 1 GB allowance to the last few bytes; 1.1 GB in all
    await t.pre("toolu_0", "ls");
    await t.post("toolu_0", "ls");
    const ledger0 = openLedger(t.home);
    let first: Map<string, { kept: string; note: string }>;
    try {
      first = new Map(ledger0.fileStatesForTask(ledger0.allTaskIds().at(-1)!).filter((r) => r.prevSha256 === null).map((r) => [path.basename(r.filePath), { kept: r.kept, note: r.note }]));
    } finally {
      ledger0.close();
    }
    assert.equal(first.get("a-bulk-00.xlsx")!.kept, "whole");
    assert.equal(first.get("a-bulk-10.xlsx")!.kept, "hash", "the 11th file is past the 1 GB allowance");
    assert.match(first.get("a-bulk-10.xlsx")!.note, /files a connector reads/);
    assert.equal(first.get("zz-named.xlsx")!.kept, "hash");
    assert.equal(first.get("zz-quiet.xlsx")!.kept, "hash");
    await t.pre("toolu_1", "python3 edit.py zz-named.xlsx");
    await t.put("zz-named.xlsx", cellEdit(XLSX));
    await t.put("zz-quiet.xlsx", cellEdit(excelResave(XLSX)));
    await t.post("toolu_1", "python3 edit.py zz-named.xlsx");
    const stored = await t.store();
    const { timeline } = await t.finish();
    const changes = timeline.requests.flatMap((r) => r.runs.flatMap((x) => x.calls.flatMap((c) => c.changes)));
    const named = changes.find((c) => c.file === "zz-named.xlsx")!;
    assert.ok(named.before?.stored === true && named.after.stored === true, "both sides kept (copy on name)");
    assert.ok(stored.length > 0);
    const quiet = changes.find((c) => c.file === "zz-quiet.xlsx")!;
    assert.equal(quiet.before?.stored, false);
    assert.match(quiet.note.text, /changed or saved again zz-quiet\.xlsx; its earlier contents weren't kept/);
  });
});
