import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { reviewModel, type PageRow, type ReviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { cellSourced, pageViolations, taskCommands, visibleTextNodes } from "../scripts/lib/page-invariant.ts";
import { workbookClaims } from "./helpers/claims.ts";

/**
 * The second-run Claude leg as a permanent page check. A recorded live run (Claude Code driving the
 * casebook workbook through three turns) is replayed through the real hook adapter, TaskStore and review
 * model; nothing is reimplemented. The 21,143 rows that run produced were mostly two byte-identical workbook copies
 * (casebook.backup.xlsx in Claude's scratch folder, outside/casebook-backup.xlsx); each copy is one row.
 *
 * What is replayed, and from where (test/fixtures/replay-claude-casebook/README.md has the full recipe):
 * - The hook events: `events.json`, rebuilt once from the run's ledger ops (the adapter keeps no raw
 *   payloads: call id, tool, open and close times, and command plus description survive; a non-Bash call's input is
 *   rebuilt from the paths the op named). Paths are `{FOLDER}`-style tokens here and become a temp tree.
 * - The workbook states: casebook S0, S1, S3, S4 and the two outside copies are the run's own snapshots (S3 and the
 *   outside copy are the same bytes), shared with the casebook-rerun fixtures; notes S0 and S3 are in this folder.
 * - The real ledger's own row counts for the two workbooks (`ledger-rows.json`) are the cross-check that the
 *   reconstructed states made the adapter see what it saw live.
 *
 * Reconstructed states (the run kept no copy of them; each is marked RECONSTRUCTED below):
 * - S2, the workbook after the user saved it in Excel between turn 1 and turn 2 (B31 changed to 850, everything
 *   recalculated). No snapshot was taken. S3 is Excel's save plus the agent's turn-2 XML edits, and those edits
 *   touch only the Sensitivity sheet and Scenario log rows 7 to 11, so S3 with them removed is S2.
 * - The in-between states inside a turn. Turn 1's five single-cell edits: S0 with the first k cells taken from S1.
 *   Turn 2's Sensitivity sheet: axes first (call 73), the H cells next (call 84), the log rows last (call 85).
 *   The last call of each turn lands the real snapshot bytes. An in-between state carries only the cell change,
 *   not whatever else a script touched in workbook.xml.
 * - Prompt hooks fire at the start of each turn: the adapter records the Stop's time, not the prompt's.
 * - A Write call's content is gone, so its input is only its file path (its page row set is unaffected).
 */
const HERE = import.meta.dirname;
const REPLAY = path.join(HERE, "fixtures", "replay-claude-casebook");
const RERUN = path.join(HERE, "fixtures", "casebook-rerun");

interface Ev {
  at: number;
  type: "pre" | "post" | "stop";
  session: string;
  id?: string;
  tool?: string;
  input?: unknown;
  round?: number;
}
interface Events {
  session: string;
  prompts: Array<{ session: string; prompts: string[] }>;
  events: Ev[];
}
interface RoundCounts {
  round: number;
  /** Rows shown open on the page: explained, unlogged and open rows, flagged or not. */
  visible: number;
  /** Rows behind a collapsed control: recalculated rows and the low-priority group. */
  collapsed: number;
  total: number;
  /** Per file basename, the rows the round itself produced, by status. */
  produced: Record<string, Record<string, number>>;
  copyRows: string[];
  html: string;
  model: ReviewModel;
  /** Every command the task recorded up to this round. */
  commands: string[];
  /** Model plus page, in ms. */
  pageMs: number;
}

const bytes = (dir: string, name: string): Promise<Buffer> => readFile(path.join(dir, name));

// The step calls (see the description of each in events.json).
const ID = {
  backup: "toolu_01PNJ65ZaF9gnlOVEL61hdxq", // cp casebook.xlsx to the scratch folder
  set: [
    "toolu_01v1oJBE6KOtWIR4LVHJDq3T", // step 2: B39
    "toolu_01TnrKW6SqYMdWbsV9xMMYCo", // step 3: B17
    "toolu_01p1vDeVAiAGqXQZSa2tFYeb", // step 4: B18
    "toolu_011Ejqbxweu9Sz966OMy66dK", // step 5: B46
    "toolu_01rM3J5LJ8YUzxeHfayCUdnE", // step 6: B58
  ],
  scenarioLog: "toolu_01LCcgORVHBp9fD0D7jGVYSE", // step 7
  backup2: "toolu_01BpSXk2kuWWrbjyCRozekRk", // cp casebook.xlsx to casebook.backup2.xlsx, a path built from $S
  sensitivity: "toolu_016E65zqqAYXCYj1SNGshR7K", // step 9: axes
  monteCarlo: "toolu_01a05zL64Csa9KU38q31qWBn", // step 10: mc.py, which also wrote notes.xlsx!A2
  results: "toolu_01V4TwBNB8vBnDu39dXUyegF", // step 10b: H2:H4
  logRows: "toolu_010dLz1OqMEIym1VJ9V4g2Rq", // step 11
  outsideCopy: "toolu_01LE0wHxz3rZKHYM9czbZGwh", // step 13: copy to outside/casebook-backup.xlsx
  logRow13: "toolu_01pU98JDXbf2cbsstNlXmhmi", // step 14
};
const SET_CELLS = ["B39", "B17", "B18", "B46", "B58"];

/** RECONSTRUCTED: S0 with its first `k` edited cells taken from S1 (sheet2.xml is the only part of S0 and S1 that differs in a cell). */
function s0WithEdits(s0: Uint8Array, s1: Uint8Array, k: number): Uint8Array {
  const parts = unzipSync(s0);
  const donor = strFromU8(unzipSync(s1)["xl/worksheets/sheet2.xml"]!);
  let xml = strFromU8(parts["xl/worksheets/sheet2.xml"]!);
  const cell = (text: string, a: string): string => new RegExp(`<c r="${a}"(?: [^>]*)?>.*?</c>`).exec(text)![0];
  for (const a of SET_CELLS.slice(0, k)) xml = xml.replace(cell(xml, a), cell(donor, a));
  return zipSync({ ...parts, "xl/worksheets/sheet2.xml": strToU8(xml) }, { mtime: new Date(2020, 0, 1) });
}

/** RECONSTRUCTED: S3 without the agent's turn-2 edits. `sensitivity` keeps none, the axes only, or the whole sheet; `logRows` keeps Scenario log rows 7 to 11. */
function s3Without(s3: Uint8Array, keep: { sensitivity: "none" | "axes" | "full"; logRows: boolean }): Uint8Array {
  const parts = unzipSync(s3);
  const edit = (name: string, fn: (xml: string) => string): void => {
    parts[name] = strToU8(fn(strFromU8(parts[name]!)));
  };
  const drop = (xml: string, what: string | RegExp): string => {
    const out = xml.replace(what, "");
    assert.notEqual(out, xml, `reconstruction: ${what} was not in the part`);
    return out;
  };
  if (keep.sensitivity === "none") {
    delete parts["xl/worksheets/sheet18.xml"];
    edit("xl/workbook.xml", (x) => drop(x, /<sheet name="Sensitivity"[^>]*\/>/));
    edit("xl/_rels/workbook.xml.rels", (x) => drop(x, /<Relationship Id="rId23"[^>]*\/>/));
    edit("[Content_Types].xml", (x) => drop(x, /<Override PartName="\/xl\/worksheets\/sheet18\.xml"[^>]*\/>/));
    edit("docProps/app.xml", (x) => drop(x, "<vt:lpstr>Sensitivity</vt:lpstr>").replace("<vt:i4>18</vt:i4>", "<vt:i4>17</vt:i4>").replace('size="18"', 'size="17"'));
  } else if (keep.sensitivity === "axes") {
    edit("xl/worksheets/sheet18.xml", (x) => drop(x, /<c r="H[234]"><v>[^<]*<\/v><\/c>/g));
  }
  if (!keep.logRows) edit("xl/worksheets/sheet17.xml", (x) => drop(x, /<row r="(?:7|8|9|10|11)">.*?<\/row>/g));
  return zipSync(parts, { mtime: new Date(2020, 0, 1) });
}

function pageRows(model: ReviewModel): { visible: Array<{ file: string; row: PageRow }>; collapsed: Array<{ file: string; row: PageRow }> } {
  const visible: Array<{ file: string; row: PageRow }> = [];
  const collapsed: Array<{ file: string; row: PageRow }> = [];
  for (const f of model.files) {
    for (const s of f.sheets) {
      for (const r of s.rows) visible.push({ file: f.file, row: r });
      for (const g of s.flagged) {
        for (const r of g.rows) visible.push({ file: f.file, row: r });
        for (const r of g.derived) collapsed.push({ file: f.file, row: r });
      }
      for (const r of s.derived) collapsed.push({ file: f.file, row: r });
    }
    for (const r of f.lowPriority) collapsed.push({ file: f.file, row: r });
  }
  return { visible, collapsed };
}

describe("replay of the second-run Claude leg", () => {
  let root = "";
  const rounds: RoundCounts[] = [];
  let ms = 0;
  let files = { folder: "", outside: "", scratch: "", home: "" };

  before(async () => {
    const started = performance.now();
    root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
    files = { folder: path.join(root, "claude"), outside: path.join(root, "outside"), scratch: path.join(root, "session", "scratchpad"), home: path.join(root, "home") };
    for (const d of Object.values(files)) await mkdir(d, { recursive: true });
    const ev = JSON.parse(await readFile(path.join(REPLAY, "events.json"), "utf8")) as Events;
    const sub = (text: string, inJson = false): string => {
      const asText = (v: string): string => (inJson ? JSON.stringify(v).slice(1, -1) : v);
      return text
        .replaceAll("{SCRATCH}", asText(files.scratch))
        .replaceAll("{SESSION}", asText(path.join(root, "session")))
        .replaceAll("{OUTSIDE}", asText(files.outside))
        .replaceAll("{FOLDER}", asText(files.folder))
        .replaceAll("{PROBE}", asText(root));
    };
    const real = (v: unknown): unknown => JSON.parse(sub(JSON.stringify(v), true));

    const s0 = await bytes(RERUN, "claude-S0.xlsx");
    const s1 = await bytes(RERUN, "claude-S1.xlsx");
    const s3 = await bytes(RERUN, "claude-S3.xlsx");
    const s4 = await bytes(RERUN, "claude-S4.xlsx");
    const notes0 = await bytes(REPLAY, "notes-S0.xlsx");
    const notes3 = await bytes(REPLAY, "notes-S3.xlsx");
    const s2 = s3Without(s3, { sensitivity: "none", logRows: false }); // RECONSTRUCTED: the user's Excel save
    const casebook = path.join(files.folder, "casebook.xlsx");
    const put = (target: string, data: Uint8Array): Promise<void> => writeFile(target, data);

    await put(casebook, s0);
    await put(path.join(files.folder, "notes.xlsx"), notes0);

    /** What each call did to the files between its Pre and its Post. */
    const effects: Record<string, () => Promise<void>> = {
      [ID.backup]: () => put(path.join(files.scratch, "casebook.backup.xlsx"), s0),
      ...Object.fromEntries(ID.set.map((id, i) => [id, () => put(casebook, s0WithEdits(s0, s1, i + 1))])),
      [ID.scenarioLog]: () => put(casebook, s1),
      [ID.backup2]: () => copyFile(casebook, path.join(files.scratch, "casebook.backup2.xlsx")),
      [ID.sensitivity]: () => put(casebook, s3Without(s3, { sensitivity: "axes", logRows: false })),
      [ID.monteCarlo]: () => put(path.join(files.folder, "notes.xlsx"), notes3),
      [ID.results]: () => put(casebook, s3Without(s3, { sensitivity: "full", logRows: false })),
      [ID.logRows]: () => put(casebook, s3),
      [ID.outsideCopy]: () => copyFile(casebook, path.join(files.outside, "casebook-backup.xlsx")),
      [ID.logRow13]: () => put(casebook, s4),
    };

    let clock = 0;
    const opts = { perSession: false, host: "claude" as const, home: files.home, claimed: workbookClaims, folder: files.folder, now: () => clock };
    const send = (e: Pick<Ev, "at" | "tool" | "id" | "input">, name: string, extra: Record<string, unknown> = {}): ReturnType<typeof handleHook> => {
      clock = e.at;
      const payload: HookPayload = { session_id: ev.session, cwd: files.folder, hook_event_name: name, ...extra };
      return handleHook(payload, opts);
    };

    let round = 0;
    for (const e of ev.events) {
      if (e.type === "pre" && round < ev.prompts.length && !startedRounds.has(round)) {
        // The prompts of the turn this call begins.
        startedRounds.add(round);
        for (const text of ev.prompts[round]!.prompts) await send({ at: e.at - 1 }, "UserPromptSubmit", { prompt: sub(text) });
      }
      if (e.type === "pre") {
        await send(e, "PreToolUse", { tool_name: e.tool, tool_input: real(e.input), tool_use_id: e.id });
        await effects[e.id!]?.();
      } else if (e.type === "post") {
        await send(e, "PostToolUse", { tool_name: e.tool, tool_input: real(e.input), tool_use_id: e.id });
      } else {
        const out = await send(e, "Stop");
        assert.ok(out.summary, `Stop ${e.round} cut a round`);
        rounds.push(await measure(out.summary.taskId, files.home));
        round++;
        // The user opened and saved the workbook in Excel between turn 1 and turn 2.
        if (round === 1) await put(casebook, s2);
      }
    }
    ms = performance.now() - started;
  });

  const startedRounds = new Set<number>();

  after(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  async function measure(taskId: number, home: string): Promise<RoundCounts> {
    const ledger = openLedger(home);
    try {
      const t0 = performance.now();
      const model = reviewModel(ledger, taskId);
      const { visible, collapsed } = pageRows(model);
      const produced: RoundCounts["produced"] = {};
      const round = model.round!;
      for (const r of ledger.reviewRowsForTask(taskId).filter((x) => x.roundSeq === round)) {
        const name = path.basename(r.filePath);
        produced[name] ??= {};
        produced[name]![r.status] = (produced[name]![r.status] ?? 0) + 1;
      }
      const copyRows = [...visible, ...collapsed].filter((x) => /^copy of /.test(x.row.description)).map((x) => `${path.basename(x.file)}: ${x.row.description}`);
      return { round, visible: visible.length, collapsed: collapsed.length, total: model.total, produced, copyRows, html: renderReviewPage(model), model, commands: taskCommands(ledger, taskId), pageMs: performance.now() - t0 };
    } finally {
      ledger.close();
    }
  }

  const ledgerRows = async (): Promise<Array<{ round: number; file: string; status: string; n: number }>> =>
    JSON.parse(await readFile(path.join(REPLAY, "ledger-rows.json"), "utf8"));

  it("no round's page shows command text, a path or a tool id outside a details control, and Claude's own descriptions still show", () => {
    for (const r of rounds) {
      assert.ok(r.commands.length > 0, `round ${r.round} recorded commands to check against`);
      const allow = cellSourced(r.model);
      assert.deepEqual(pageViolations(r.html, r.commands, { allow }), [], `round ${r.round}`);
    }
    // The Why cells are not hidden: a row whose call carried a description shows it (the page text holds the descriptions of the run).
    const seen = rounds.flatMap((r) => visibleTextNodes(r.html)).join("\n");
    assert.match(seen, /Step \d|Update|Set |Verify|Backup|Copy|Add /i, "at least one genuine description is visible");
  });

  it("the model and the page take under 1 s (median) on casebook", () => {
    const sorted = rounds.map((r) => r.pageMs).sort((a, b) => a - b);
    assert.ok(sorted[Math.floor(sorted.length / 2)]! < 1000, `page times ${sorted.map((x) => x.toFixed(0)).join(", ")} ms`);
  });

  it("every request sits before its round's first call, carries its time, and points at the first step after it", () => {
    const ledger = openLedger(files.home);
    try {
      const model = rounds.at(-1)!.model;
      const ranges = ledger.roundsForTask(model.taskId);
      let after = 0;
      for (const r of ranges) {
        const stamps = model.roundRequests.find((q) => q.round === r.seq)!.requests;
        assert.ok(stamps.length > 0, `round ${r.seq} has stamped requests`);
        const calls = ledger.okOpsForTask(model.taskId, after, r.lastOpId).map((o) => JSON.parse(o.argsJson) as Record<string, string>).filter((a) => a.tool_use_id !== undefined);
        const first = Math.min(...calls.map((a) => Number(a.startSeq)));
        for (const q of stamps) {
          assert.ok(q.seq > 0 && q.seq < first, `round ${r.seq}: request ${q.seq} before first call ${first}`);
          assert.equal(typeof q.at, "number");
          assert.notEqual(q.firstStep, null, `round ${r.seq}: a step exists after the request`);
          assert.notEqual(q.firstStep, ledger.stepsForTask(model.taskId)[0]!.id, `round ${r.seq}: never the baseline copy`);
        }
        assert.deepEqual(stamps.map((q) => q.seq), [...stamps.map((q) => q.seq)].sort((a, b) => a - b));
        after = r.lastOpId;
      }
      assert.equal(ranges.length, 3);
    } finally {
      ledger.close();
    }
  });

  it("each round produces one row per workbook the live run's ledger recorded rows for, unlogged where it had an unlogged row, and one row per copy", async () => {
    // ledger-rows.json is the live run's own review_rows grouped by round, file and status. Its two copies had 10,383
    // and 10,457 rows then; every other row must come back the same, which also proves the reconstructed S2 and the
    // in-between states made the adapter see what it saw live.
    const live = await ledgerRows();
    const copies = live.filter((r) => /casebook\.backup\.xlsx$|casebook-backup\.xlsx$/.test(r.file));
    assert.deepEqual(copies.map((r) => r.n), [10383, 10457]);
    for (const r of rounds) {
      const want: Record<string, Record<string, number>> = {};
      // One whole-file row per workbook, unlogged exactly when the
      // live run had an unlogged cell row for it that round (a change no call made), else explained.
      const live1: Record<string, Set<string>> = {};
      for (const row of live.filter((l) => l.round === r.round && !copies.includes(l))) (live1[path.basename(row.file)] ??= new Set()).add(row.status);
      for (const [name, statuses] of Object.entries(live1)) want[name] = { [statuses.has("unlogged") ? "unlogged" : "explained"]: 1 };
      for (const copy of copies.filter((c) => c.round === r.round)) want[path.basename(copy.file)] = { explained: 1 };
      assert.deepEqual(r.produced, want, `round ${r.round}`);
    }
  });

  // Was 162 cell and copy rows (70 visible, 92 recalculated); now one row per workbook per round.
  // Before and after are the displayed text under B31's number format ("$"#,##0.00_);[Red]("$"#,##0.00)), not the stored 804.14 and 850.
  // The user's save (B31) is inside casebook's one whole-file row,
  // which stays unlogged because a change no call made is in it; the notes row is the agent's.
  it("every one of the 10 casebook changes and the notes change has its own before and after state", async () => {
    const ledger = openLedger(files.home);
    try {
      const taskId = ledger.allTaskIds()[0]!;
      const states = ledger.fileStatesForTask(taskId);
      const ops = ledger.okOpsForTask(taskId, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>);
      const casebook = path.join(files.folder, "casebook.xlsx");
      const notes = path.join(files.folder, "notes.xlsx");
      const changing = [...ID.set, ID.scenarioLog, ID.sensitivity, ID.results, ID.logRows, ID.logRow13];
      assert.equal(changing.length, 10);
      const chain = states.filter((s) => s.filePath === casebook);
      for (const id of changing) {
        // The state the call's Post wrote: a different hash from the one before, credited to the call.
        const mine = chain.filter((s) => s.credited.includes(id));
        assert.equal(mine.length, 1, `call ${id} has one state event on casebook`);
        assert.notEqual(mine[0]!.sha256, mine[0]!.prevSha256, `call ${id}: after differs from before`);
        assert.equal(chain.find((s) => s.sha256 === mine[0]!.prevSha256) !== undefined, true, `call ${id}: its before is a stored state`);
        const op = ops.find((a) => a.tool_use_id === id && a.path === casebook)!;
        assert.ok(op.steps.includes(mine[0]!.stepId), `call ${id}: the op points at its step`);
        // The op carries no cells; its before and after are the states above.
        assert.equal(op.hookCells, undefined, `call ${id}: no cell list`);
      }
      const noteState = states.find((s) => s.filePath === notes && s.credited.includes(ID.monteCarlo))!;
      assert.notEqual(noteState.sha256, noteState.prevSha256);
      const noteOp = ops.find((a) => a.tool_use_id === ID.monteCarlo && a.path === notes)!;
      assert.ok(noteOp.steps.includes(noteState.stepId), "the notes op points at its step");
      const store = (await readdir(path.join(files.home, "tasks", String(taskId), "states"))).filter((n) => !n.startsWith("."));
      for (const s of states.filter((x) => x.kept === "whole")) assert.ok(store.includes(s.sha256), "each state's bytes are in the store");
    } finally {
      ledger.close();
    }
  });

  it("the fixtures hold no real user path beyond the probe run's, and the replay is quick", async () => {
    for (const name of ["events.json", "ledger-rows.json"]) {
      const text = await readFile(path.join(REPLAY, name), "utf8");
      assert.doesNotMatch(text, /\/Users\/|\/private\//, `${name} holds a real path`);
    }
    assert.ok(ms < 10_000, `replay took ${Math.round(ms)} ms`);
  });
});
