// Spec v1.2 gains `issues`, `more` and the nothing-changed rule. The checker validates each new field (absent is always
// valid), conformance warns how they degrade, the built-in Office connectors decide "nothing changed" themselves, and the page draws the fields
// minimally: a quiet issue count that opens the list (text only, capped), "and N more" in place, and the nothing-changed line with no picture.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { unzipSync, zipSync } from "fflate";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { gradeLevel } from "../src/connector/conformance.ts";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { answerDiff, type ProgramDeps } from "../src/office/connector/program.ts";
import { fakePager, FIXTURES } from "./helpers/office-fake.ts";
import { ALL_PAIRS, drivePage, modelOf, type PageCapture } from "./helpers/connector-v1-page.ts";
import { workbookClaims } from "./helpers/claims.ts";
await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const VT = (globalThis as any).CoCheckViewTable;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SPEC = "cocheck.changes/1";
const fields = (doc: unknown, level: 1 | 2 | 3 = 3): string[] => checkChanges(doc, level).map((p) => p.field);
const pic = (id: string, side: string, extra: Json = {}): Json => ({ id, side, type: "image", ...extra });

describe("P1, P2: checkChanges validates issues and more; absent is always valid", () => {
  it("a v1 document without the fields stays valid", () => {
    assert.deepEqual(fields({ spec: SPEC, changes: [] }), []);
    assert.deepEqual(fields({ spec: SPEC, changes: [{ id: "c1", mark: "changed", label: "x" }] }), []);
  });
  it("issues at the document, on a picture and on a change, and more on the document and a change, are valid", () => {
    const doc = {
      spec: SPEC, more: 3, issues: [{ text: "Sheet2 has a broken reference", side: "after", where: "Sheet2!B4" }, { text: "no side, no where" }],
      pictures: [pic("b", "before", { issues: [{ text: "the before page would ask to repair", side: "before" }] }), pic("a", "after")],
      changes: [{ id: "c1", mark: "changed", label: "Inputs", more: 12, issues: [{ text: "this change broke a total", where: "Totals" }] }],
    };
    assert.deepEqual(fields(doc), []);
    assert.deepEqual(fields({ spec: SPEC, changes: [], issues: [], more: 0 }), []);
  });
  it("a malformed issues entry gets the checker's field path, at every level of the document", () => {
    assert.deepEqual(fields({ spec: SPEC, changes: [], issues: "broken" }), ["issues"]);
    assert.deepEqual(fields({ spec: SPEC, changes: [], issues: ["text only"] }), ["issues[0]"]);
    assert.deepEqual(fields({ spec: SPEC, changes: [], issues: [{ text: "" }] }), ["issues[0].text"]);
    assert.deepEqual(fields({ spec: SPEC, changes: [], issues: [{ text: "ok" }, { text: "x", side: "middle", where: 4 }] }), ["issues[1].side", "issues[1].where"]);
    assert.deepEqual(fields({ spec: SPEC, changes: [{ id: "c1", mark: "changed", label: "x", issues: [{ side: "after" }] }] }), ["changes[0].issues[0].text"]);
    assert.deepEqual(fields({ spec: SPEC, changes: [], pictures: [pic("b", "before", { issues: {} })] }), ["pictures[0].issues"]);
  });
  it("more is a whole number from 0, on the document and on a change", () => {
    assert.deepEqual(fields({ spec: SPEC, changes: [], more: -1 }), ["more"]);
    assert.deepEqual(fields({ spec: SPEC, changes: [], more: 2.5 }), ["more"]);
    assert.deepEqual(fields({ spec: SPEC, changes: [{ id: "c1", mark: "changed", label: "x", more: "5" }] }), ["changes[0].more"]);
  });
  it("guarded case (P6, too strict): a long issues list and long issue text are never rejected by the checker", () => {
    const issues = Array.from({ length: 80 }, (_, i) => ({ text: `issue ${i} ${"x".repeat(400)}` }));
    assert.deepEqual(fields({ spec: SPEC, changes: [], issues }), []);
  });
});

describe("P4: conformance warns how the new fields degrade, and never fails a connector on them", () => {
  const ctx = { level: 1 as const, beforeText: "a", afterText: "a", dir: tmpdir() };
  it("over 50 issues and issue text over 300 characters are warnings, not failures", () => {
    const doc = { spec: SPEC, changes: [{ id: "c1", mark: "changed", label: "x" }], issues: Array.from({ length: 51 }, (_, i) => ({ text: i === 0 ? "y".repeat(301) : `issue ${i}` })) };
    const g = gradeLevel([doc, doc], ctx);
    assert.deepEqual(g.failures, []);
    assert.ok(g.warnings.some((w) => /51 issues, the page shows the first 50/.test(w)), g.warnings.join("|"));
    assert.ok(g.warnings.some((w) => /over 300 characters/.test(w)), g.warnings.join("|"));
  });
  it("an empty change list for two state files that differ is warned only for a connector whose hello declares nothingChanged; for equal files it is not", () => {
    const doc = { spec: SPEC, changes: [] };
    assert.ok(gradeLevel([doc, doc], { ...ctx, afterText: "b", nothingChanged: true }).warnings.some((w) => /page will say nothing changed/.test(w)));
    assert.equal(gradeLevel([doc, doc], { ...ctx, afterText: "b" }).warnings.length, 0, "no opt-in: an empty list claims nothing, so nothing to warn");
    assert.equal(gradeLevel([doc, doc], { ...ctx, nothingChanged: true }).warnings.length, 0);
    assert.deepEqual(gradeLevel([doc, doc], { ...ctx, afterText: "b", nothingChanged: true }).failures, []);
  });
});

// ---- P3: the built-in connectors decide "nothing changed" themselves ----------------------------------------------------------------------

const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-"));
const put = (name: string, bytes: Uint8Array): string => { const f = path.join(scratch, name); writeFileSync(f, bytes); return f; };
/** `file` repacked, with one part's text edited (the zip's own timestamps move with the repack). */
function repack(file: string, part?: string, edit?: (s: string) => string): Uint8Array {
  const parts: Record<string, Uint8Array> = unzipSync(readFileSync(file));
  if (part !== undefined && edit !== undefined) parts[part] = new TextEncoder().encode(edit(parts[part] ? Buffer.from(parts[part]!).toString("utf8") : ""));
  return zipSync(parts, { mtime: new Date(2031, 1, 2) });
}
const deps = (): ProgramDeps => ({ driver: undefined, pager: fakePager, lockPath: path.join(scratch, "lock") });
const NOTHING_LINE = (doc: Json): boolean => VT.coverageLine({ ...doc, source: { by: "connector", name: "x", level: 3, nothingChanged: true } }) === VT.NOTHING_CHANGED;

describe("P3: built-in connectors answer an empty list only when they compared everything", () => {
  it("xlsx: a conditional-format-only edit gives one described change, never the nothing-changed line", async () => {
    const v1 = path.join(FIXTURES, "v1.xlsx");
    const sheet = Object.keys(unzipSync(readFileSync(v1))).find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))!;
    const after = put("cf.xlsx", repack(v1, sheet, (s) => s.replace("</worksheet>", '<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting></worksheet>')));
    const doc = await answerDiff(OFFICE_APPS.excel, v1, after, deps());
    assert.equal(doc.changes.length, 1, JSON.stringify(doc.changes));
    assert.equal(doc.changes[0]!.mark, "described");
    assert.deepEqual(checkChanges(doc, 3), []);
    assert.equal(NOTHING_LINE(doc), false);
  });
  it("pptx: a presProps-only edit gives one described change, never the nothing-changed line", async () => {
    const v2 = "test/fixtures/long-html-deck-v2.pptx";
    const after = put("presprops.pptx", repack(v2, "ppt/presProps.xml", (s) => `${s}<!-- showPr loop -->`));
    const doc = await answerDiff(OFFICE_APPS.powerpoint, v2, after, deps());
    assert.equal(doc.changes.length, 1, JSON.stringify(doc.changes));
    assert.equal(doc.changes[0]!.mark, "described");
    assert.match(doc.changes[0]!.text ?? "", /does not show/);
    assert.deepEqual(checkChanges(doc, 3), []);
  });
  it("a re-save the connector can vouch for stays empty: identical parts (xlsx, docx), and a regenerated deck whose created time moved", async () => {
    const xlsx = path.join(FIXTURES, "v1.xlsx");
    assert.deepEqual((await answerDiff(OFFICE_APPS.excel, xlsx, put("same.xlsx", repack(xlsx)), deps())).changes, []);
    assert.deepEqual((await answerDiff(OFFICE_APPS.word, "test/fixtures/memo-v1.docx", "test/fixtures/memo-v2.docx", deps())).changes, []);
    // This recorded pair is a regenerated deck whose dcterms:created moved (in core.xml and in the embedded workbook's) and whose body is
    // byte-identical: the re-save check sets the creation time aside, so it is "nothing changed".
    const regenerated = (await answerDiff(OFFICE_APPS.powerpoint, "test/fixtures/long-html-deck-v2.pptx", "test/fixtures/long-html-deck-v3.pptx", deps())).changes;
    assert.deepEqual(regenerated, []);
  });
});

// ---- the page ---------------------------------------------------------------------------------------------------------------------------

const src = (level: number, nothingChanged = true) => ({ by: "connector", name: "toy", level, ...(nothingChanged ? { nothingChanged: true } : {}) });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
async function drive(doc: unknown): Promise<PageCapture> {
  const pm = await modelOf(ALL_PAIRS.find((p) => p.name === "xlsx-value-edit")!);
  return drivePage(pm, async () => clone(doc), undefined, { noPanes: true });
}

describe("P3: the nothing-changed line follows the document, with or without pictures", () => {
  it("an empty list with no picture from a connector that opted in, at level 2 and 3: the reworded line; with unchanged pictures: the existing line", () => {
    for (const level of [2, 3]) assert.equal(VT.coverageLine({ spec: SPEC, changes: [], pictures: [], caveats: [], source: src(level) }), VT.NOTHING_CHANGED);
    const pics = [pic("b", "before", { unchanged: true }), pic("a", "after", { unchanged: true })];
    assert.equal(VT.coverageLine({ spec: SPEC, changes: [], pictures: pics, caveats: [], source: src(2) }), VT.NOTHING_VISIBLE);
  });
  it("guarded case (P6): an empty list the connector does not vouch for is never the line (status, pending, failed, a caveat, more, a changed picture)", () => {
    const base = { spec: SPEC, changes: [], pictures: [], caveats: [], source: src(3) };
    for (const extra of [{ status: { kind: "crash", evidence: "x" } }, { pendingRetry: 2 }, { pending: true }, { failed: true }, { caveats: ["not compared: macros"] }, { more: 4 }, { pictures: [pic("a", "after", { changed: true })] }]) {
      const line = VT.coverageLine({ ...base, ...extra });
      assert.notEqual(line, VT.NOTHING_CHANGED, JSON.stringify(extra));
      assert.notEqual(line, VT.NOTHING_VISIBLE, JSON.stringify(extra));
    }
    assert.notEqual(VT.coverageLine({ ...base, more: 2, pictures: [pic("a", "after", { unchanged: true })] }), VT.NOTHING_VISIBLE);
  });
  it("the page draws the reworded line on the banner for a no-picture empty document", async () => {
    const cap = await drive({ spec: SPEC, changes: [], pictures: [], caveats: [], source: src(3) });
    assert.equal(cap.node("banner").text, VT.NOTHING_CHANGED);
    assert.equal(cap.node("banner").hidden, false);
  });
});

describe("P1, P2, P6: issues and more on the page", () => {
  it("the header's issue pill counts them and Details lists them; issues from every level of the document are counted; an absent or empty list shows nothing", async () => {
    const doc = { spec: SPEC, source: src(3), caveats: [], pictures: [], issues: [{ text: "doc issue", where: "Sheet2" }], changes: [{ id: "c1", mark: "changed", label: "Inputs!B3", before: "1", after: "2", issues: [{ text: "change issue", side: "after" }] }] };
    const cap = await drive(doc);
    const x = cap.node("detissues");
    assert.equal(x.hidden, false);
    assert.equal(cap.node("hissues").text, "2 issues");
    assert.equal(cap.node("hissues").hidden, false);
    assert.match(x.text, /^Issues/);
    assert.match(x.text, /Sheet2: doc issue/);
    assert.match(x.text, /\(after\) change issue/);
    assert.ok(!cap.node("extras").tags.includes("details"), "no issues disclosure in the stage");
    for (const none of [{ issues: undefined }, { issues: [] }]) {
      const c = await drive({ ...doc, ...none, changes: [{ id: "c1", mark: "changed", label: "x", before: "1", after: "2" }] });
      assert.equal(c.node("detissues").hidden, true, JSON.stringify(none));
      assert.equal(c.node("detissues").text, "");
      assert.equal(c.node("hissues").hidden, true, JSON.stringify(none));
      assert.equal(c.node("hissues").text, "");
    }
  });
  it("guarded case (P6): a planted <img onerror> issue renders as text, and the list is capped at 50 entries of 300 characters, then 'and N more'", async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const issues = [{ text: evil }, ...Array.from({ length: 59 }, (_, i) => ({ text: `${i}:${"z".repeat(400)}` }))];
    const cap = await drive({ spec: SPEC, source: src(3), caveats: [], pictures: [], issues, changes: [{ id: "c1", mark: "changed", label: "x", before: "1", after: "2" }] });
    const x = cap.node("detissues");
    assert.ok(x.text.includes(evil), "the issue's text is shown as written");
    assert.ok(!x.tags.includes("img"), "no element made from issue text");
    assert.equal(cap.node("hissues").text, "60 issues");
    // The list ends "and 10 more", then the step's "Copy fix prompt" button (made from these issues)
    assert.match(x.text, /and 10 moreCopy fix prompt$/);
    const scene = VT.sceneOf({ spec: SPEC, changes: [], issues });
    assert.equal(scene.issues.shown.length, 50);
    assert.ok(scene.issues.shown.every((s: { text: string }) => s.text.length <= 301));
  });
  it("more: 'and N more' in place with the connector's labels, on the document and on a change; the page invents no place word", async () => {
    const doc = { spec: SPEC, source: src(1), caveats: [], more: 7, changes: [{ id: "c1", mark: "changed", label: "Sheet1", before: "1", after: "2", more: 12 }] };
    const cap = await drive(doc);
    const body = cap.node("bodyview").text;
    assert.match(body, /Sheet1/);
    // no place word after the count: the change's own label says where
    const PLACE = /and (12|7) more\s*(sheets?|slides?|pages?|cells?|rows?|paragraphs?)\b/i;
    assert.match(body, /and 12 more/, body);
    assert.match(body, /and 7 more/, body);
    assert.doesNotMatch(body, PLACE, body);
    // a level-1 list of none with changes left out is never "Nothing changed."
    const none = await drive({ spec: SPEC, source: src(1), caveats: [], more: 3, changes: [] });
    assert.match(none.node("bodyview").text, /and 3 more/);
    assert.doesNotMatch(none.node("bodyview").text, /Nothing changed/);
  });
});

describe("P4: the kit guide shows issues and more, and its snippets are valid", () => {
  it("the guide's issues and more snippets make a valid document", () => {
    const guide = readFileSync("public-kit/GUIDE.md", "utf8");
    const issues = /`("issues": \[[^`]+\])`/.exec(guide)?.[1], more = /`("more": \d+)`/.exec(guide)?.[1];
    assert.ok(issues !== undefined && more !== undefined, "the guide shows both fields");
    const doc = JSON.parse(`{ "spec": "${SPEC}", "changes": [], ${issues}, ${more} }`);
    assert.deepEqual(checkChanges(doc, 1), []);
    assert.match(guide, /`"nothingChanged": true` to your hello answer; then answer `"changes": \[\]` only when you compared everything/);
  });
});

// ---- the opt-in (a declared limit): only a connector whose hello declares nothingChanged, recorded at capture, gets the line ----------

import { connectorRowDoc } from "../src/connector/row-doc.ts";
import { setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { captureFileRow } from "../src/connector/file-capture.ts";
import { readFrozen } from "../src/connector/frozen.ts";
import { serve } from "../src/office/connector/program.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger, type FileStateRow } from "../src/ledger.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { makeRig } from "./hook-corpus.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { after } from "node:test";

/** A frozen document as the row-doc route serves it (readFrozen stubbed), then the page's scene of it. */
async function served(frozen: unknown): Promise<Json> {
  const d = { spec: "cocheck.diff/1", subject: "/w/book.xlsx", connector: "microsoft-excel", producer: "connector", before: { ref: "a" }, after: { ref: "b" }, changes: [], caveats: [], served: { kind: "frozen", ref: "x" } };
  return (await connectorRowDoc(d as never, { before: null, after: null, readFrozen: async () => clone(frozen) })) as unknown as Json;
}

describe("opt-in: the nothing-changed line needs the connector's hello declaration, recorded at capture", () => {
  it("an old frozen built-in document (empty list, no picture, no flag in its envelope, as stored before the nothing-changed rule) draws what main draws: no line", async () => {
    const old = { spec: SPEC, changes: [], caveats: [], source: { by: "connector", name: "microsoft-excel", level: 3 } };
    const doc = await served(old);
    assert.equal(doc.source.nothingChanged, undefined);
    const scene = VT.sceneOf(doc);
    assert.notEqual(scene.coverage, VT.NOTHING_CHANGED);
    assert.equal(scene.banner, undefined);
    const cap = await drive(doc);
    assert.equal(cap.node("banner").hidden, true);
    assert.doesNotMatch(cap.node("banner").text, /Saved again/);
  });
  it("the same document with the flag in its envelope draws the line; a flag the connector wrote into its own document is never trusted (capture replaces source)", async () => {
    const flagged = await served({ spec: SPEC, changes: [], caveats: [], source: { by: "connector", name: "microsoft-excel", level: 3, nothingChanged: true } });
    assert.equal(VT.sceneOf(flagged).banner, VT.NOTHING_CHANGED);
    const { frozenDocOf } = await import("../src/connector/diff.ts");
    const selfClaimed = frozenDocOf({ changes: [], caveats: [], v1doc: { spec: SPEC, changes: [], source: { by: "connector", name: "x", level: 3, nothingChanged: true } }, v1level: 3 } as never, "x");
    assert.equal((selfClaimed.source as Json).nothingChanged, undefined);
  });
  it("the built-in Office connectors' hello declares nothingChanged: true", async () => {
    const input = new PassThrough(), output = new PassThrough();
    let out = "";
    output.on("data", (b) => (out += String(b)));
    const done = serve(OFFICE_APPS.excel, deps(), input, output);
    input.end(`${JSON.stringify({ id: 1, method: "hello", params: {} })}\n`);
    await done;
    assert.equal(JSON.parse(out.trim().split("\n")[0]!).result.nothingChanged, true);
  });
});

/** A toy connector answering an empty v1 list, its hello with or without the opt-in. */
const toy = (optIn: boolean) => `import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", (line) => { const m = JSON.parse(line);
  if (m.method === "hello") return process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.connector/1", level: 1, methods: ["diff"]${optIn ? ", nothingChanged: true" : ""} } }) + "\\n");
  if (m.method === "diff") process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.changes/1", changes: [] } }) + "\\n");
});
`;

describe("opt-in through a real capture: hello -> frozen envelope -> page", () => {
  after(() => { setKeyProvider(null); setBuiltinConnectorsForTest(undefined); });
  for (const optIn of [true, false]) {
    it(optIn ? "a connector that declares it: the frozen envelope carries nothingChanged and the page says the line" : "a connector without it answering empty: no flag, never the line", async () => {
      setKeyProvider(memoryKeyProvider());
      const r = await makeRig();
      const id = optIn ? "toy-optin" : "toy-plain";
      const dir = path.join(scratch, id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id, version: "1.0.0", entry: "state", matches: { extensions: [".csv"] }, run: ["node", "connector.mjs"] }));
      await writeFile(path.join(dir, "connector.mjs"), toy(optIn));
      setBuiltinConnectorsForTest([{ id, dir }]);
      // one Bash call rewrites t.csv through the real hook
      await writeFile(path.join(r.folder, "t.csv"), "a,b\n1,2\n");
      let clock = 1_700_000_000_000;
      const opts = { host: "claude" as const, home: r.home, claimed: workbookClaims, folder: r.folder, now: () => (clock += 1000) };
      const base = { session_id: "session-1", cwd: r.folder, transcript_path: "/x/t.jsonl", permission_mode: "default" };
      const call = (event: string, extra: Json = {}) => ({ ...base, hook_event_name: event, tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "python3 edit.py", description: "edit" }, ...extra });
      const send = (p: Json) => handleHook(p as unknown as HookPayload, opts);
      await send({ ...base, hook_event_name: "UserPromptSubmit", prompt: "edit" });
      await send(call("PreToolUse"));
      await writeFile(path.join(r.folder, "t.csv"), "a,b\n1,3\n");
      await send(call("PostToolUse", { tool_response: { stdout: "ok" } }));
      const ledger = openLedger(r.home);
      let row: FileStateRow;
      try { row = ledger.allTaskIds().flatMap((t) => ledger.fileStatesForTask(t)).filter((f) => f.phase === "Post")[0]!; } finally { ledger.close(); }
      const got = await captureFileRow({ home: r.home, taskId: row.taskId, subject: row.filePath, connector: id, before: row.prevSha256, after: row.sha256 });
      assert.ok(got?.changesSha256 !== undefined, JSON.stringify(got));
      const frozen = (await readFrozen(r.home, row.taskId, got!.changesSha256!)) as Json;
      assert.equal(frozen.source.nothingChanged, optIn ? true : undefined);
      const doc = await served(frozen);
      // level 1 draws its own card list; the line is judged as level 2 would (no picture) so the opt-in alone decides
      const asTwo = { ...doc, source: { ...doc.source, level: 2 } };
      assert.equal(VT.coverageLine(asTwo) === VT.NOTHING_CHANGED, optIn);
      await r.cleanup();
    });
  }
});
