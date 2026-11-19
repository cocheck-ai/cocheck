import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { redactSecrets } from "../../src/secret-scan.ts";
import { maskArgsJson, type Ledger, type ReviewRowRecord } from "../../src/ledger.ts";
import { isAnotherSessionRow, isLowPriorityRow, itemStates, needsReviewer, requestStates, type ItemState } from "../../src/items.ts";
import { agentReason, opReason } from "../../src/reason.ts";
import { cellText, fileBase, joinShown, ownProse, ownText, plural, userText, words, type Shown } from "../../src/display.ts";
import { hookCallOf, stripHookSession } from "../../src/tasks.ts";
import { closureOf } from "../../src/signoff.ts";
import { beforeAfterText } from "./xlsx-shown.ts";

/**
 * Test helper: the row half of the round engine's `reviewModel`. The hook and round tests still assert on a round's rows, open counts, hook rounds, requests and closed notes, all read
 * from the ledger (live data); this rebuilds them the way the model did. The check flags, "what moved", unrecalculated
 * notices and check notices are not rebuilt: their fields stay in the shape, always empty, so `legacy-review-page.ts` still renders.
 */

/** A check flag as the model carried it (no row carries one). */
interface CheckFlag {
  code: string;
  label: string;
  plural: string;
  detail: string;
}

/** What an item's answer says when the agent gave no reason in words. */
const NO_REASON = words`(no reason in words)`;

/** The newest round among `states`, or null when there are none. A loop, not `Math.max(...)`: a spread of 125k+ arguments overflows the call stack. */
function latestRound(states: ItemState[]): number | null {
  let round: number | null = null;
  for (const s of states) if (round === null || s.row.roundSeq > round) round = s.row.roundSeq;
  return round;
}

/**
 * Rule 2: the rows the model carries: every row of the latest round, plus every earlier-round row for which `needsReviewer` holds
 * (the rows that block sign-off). The one definition the model, the item check and the sign-off blockers agree on.
 */
export function pageStates(states: ItemState[]): ItemState[] {
  const round = latestRound(states);
  return states.filter((s) => s.row.roundSeq === round || needsReviewer(s));
}

/** A host-hook call as the page shows it: how it closed, whether it ran in the background, when it opened and closed (epoch ms). */
export interface HookCallView {
  id: string;
  closedBy: string;
  background: boolean;
  openedAt?: number;
  closedAt?: number;
}

/** One round's hook calls whose ops own no row (a ghost-post, a call that changed nothing, an expiry with no cells). */
export interface NoCellCalls {
  round: number;
  calls: HookCallView[];
}

/** One round's hook calls and their reach beyond the watched folder. */
/** What the user asked in a round, from the host's UserPromptSubmit hook; empty `prompts` when none was captured. */
export interface RoundRequest {
  round: number;
  prompts: Shown[];
  /** Per captured request, in submit order across the round's sessions: the stamp, time and first step after it. Empty when none carries one. */
  requests: RequestStamp[];
}

/** When a request was sent: `seq` is the hook counter it was stamped with (shared with steps and calls), `at` epoch ms or "unknown", `firstStep` the ledger step id written after it in its session (null when none exists). A step found after the turn's Stop is read from the calls under the request. */
export interface RequestStamp {
  session: string;
  seq: number;
  at: number | "unknown";
  firstStep: number | null;
}

export interface HookRoundView {
  round: number;
  /** Distinct tool calls the round logged. */
  calls: number;
  /** Rows the round put on the page, whatever their status. */
  rows: number;
  /** Other paths calls named outside the folder, with the calling command (outside watching on). */
  outside: Array<{ name: Shown; reason: Shown; path: string; command: string }>;
  /** Calls that named no path at all (outside watching on). */
  unknown: Array<{ reason: Shown; command: string }>;
  /** Calls that touched paths outside the folder while outside watching was off; nothing else is kept. */
  offCalls: number;
  /** Where the agent worked when that was outside the folder (outside watching on), once per round. */
  workedIn: Array<{ name: Shown; reason: Shown; path: string }>;
}

export interface PageRow {
  id: number;
  layer: string;
  location: string;
  /** The cell or position within the sheet (or the whole location for a sheet-less layer). */
  place: Shown;
  kind: string;
  status: ReviewRowRecord["status"];
  before: Shown;
  after: Shown;
  description: Shown;
  /** The row's workbook is outside the watched folder (a call named it; outside watching). */
  outsideFolder: boolean;
  /** The reasons to show, in plain words (see `opReason`): never a command. */
  intents: Shown[];
  /** The raw commands behind hook-call reasons, shown only behind a "show command" control. */
  commands: string[];
  /** Host-hook calls behind the row, with how each closed; empty for ops logged through CoCheck's own tools. */
  calls: HookCallView[];
  agents: string[];
  open: boolean;
  /** A "re-saved or changed outside CoCheck" row: shown in the file's Low priority group. */
  lowPriority: boolean;
  stateText: Shown;
  /** Check flags (see `src/checks`): what a reviewer should look at first on this row. */
  flags: Array<{ code: string; label: Shown; plural: Shown; detail: Shown }>;
}

/** One check's flagged rows on one sheet, shown under a single collapsible header. */
export interface FlagGroup {
  code: string;
  label: Shown;
  plural: Shown;
  /** Rows in the group (`rows` plus `derived`). A row with several flags sits under its first one. */
  count: number;
  /** Explained, unlogged and open rows: the group is expanded by default when there are any. */
  rows: PageRow[];
  /** Closed derived rows, collapsed by default but always present. */
  derived: PageRow[];
}

export interface SheetGroup {
  /** Empty for a layer without sheets. */
  sheet: Shown;
  /** Flagged rows, grouped by check; shown before everything else. */
  flagged: FlagGroup[];
  /** Per-check flag counts on this sheet, e.g. "41 errors introduced"; "" when none. */
  flagCounts: Shown;
  /** Unflagged explained and unlogged rows, and open derived ones; open ones first. */
  rows: PageRow[];
  /** Closed derived (recalculated) rows, shown collapsed. */
  derived: PageRow[];
}

export interface FileGroup {
  /** The full path: shown only behind a "show path" control. */
  file: string;
  name: Shown;
  sheets: SheetGroup[];
  /** Low-priority rows (decided or not), shown last in their own collapsed group, outside the flagged section. */
  lowPriority: PageRow[];
}

/** An edit a moved output depends on: the round's own explained or unlogged change. */
export interface MovedEdit {
  id: number;
  /** `Sheet!B3`. */
  place: Shown;
  intents: Shown[];
  status: ReviewRowRecord["status"];
}

/** A recalculated cell nothing else refers to, with the edits upstream of it. */
export interface MovedOutput {
  id: number;
  kind: "cell" | "row" | "grid";
  /** `Sheet!B3` for a cell, `Sheet!C24:G28` for a row or grid. */
  place: Shown;
  /** What to call it: "IRR (Summary!B21)", "Returns: Sensitivity 1 (C24:G28)", "Debt Schedule!Total debt / EBITDA". */
  title: Shown;
  /** What happened, in a line: "was 18.5%, now 20.1% (+8.6%)", "14 cells moved, largest C24 1.5% -> 5.0% (+228%)". */
  detail: Shown;
  /** How many cells the entry stands for. */
  cells: number;
  edits: MovedEdit[];
  /** Set when `edits` may be incomplete or empty for a reason the reviewer should know. */
  traceNote?: Shown;
  /** Earlier rounds' edits that were never recalculated until now and that this output depends on; the result may include them. */
  priorEdits: Array<{ round: number; place: Shown }>;
}

/** A file whose round changed inputs without their results being recalculated (the agent edited the file directly, so Excel never ran). */
export interface StaleNotice {
  file: string;
  name: Shown;
  /** The latest round that left an edit of this file pending. */
  round: number;
  /** How many changed inputs, from this and earlier rounds, are still not recalculated. */
  inputs: number;
  /** `Sheet!B3` of the first few. */
  places: Shown[];
  /** The same few with the round each came from, oldest round first. */
  edits: Array<{ round: number; place: Shown }>;
  /** Every round that has an edit still pending, oldest first. */
  rounds: number[];
}

export interface MovedGroup {
  file: string;
  name: Shown;
  outputs: MovedOutput[];
  /** Further terminal outputs past the cap. */
  more: number;
  /** The largest-change output among the `more` hidden ones; absent when none are hidden. */
  moreLargest?: { title: Shown; detail: Shown };
}

export interface ReviewModel {
  taskId: number;
  /** The current (latest) round, or null before the first submit. */
  round: number | null;
  total: number;
  open: number;
  /** "What moved": per workbook, the terminal recalculated outputs traced to the round's edits. Empty when none. */
  moved: MovedGroup[];
  /** Files whose current round changed inputs the formulas downstream of never recalculated; shown above "what moved" and at sign-off. */
  unrecalculated: StaleNotice[];
  /** Rows carrying at least one check flag, in the current round. */
  flagged: number;
  /** Per-label flag counts for the summary line, e.g. "2 errors introduced"; "" when none. */
  flagSummary: Shown;
  files: FileGroup[];
  /** Per round, the hook calls that own no row, so a ghost or cell-less call is never invisible. */
  noCellCalls: NoCellCalls[];
  /** Per round with hook calls: how many ran, and what they reached outside the watched folder. */
  hookRounds: HookRoundView[];
  /** Per round, the user's prompts in order. A round with none captured has an empty list, never an earlier round's. */
  roundRequests: RoundRequest[];
  /** Checks and "what moved" that could not run for a file, with the reason (current round). */
  checkNotices: Shown[];
  /** Why the task is no longer live, and what happened to its files since: expired, values expired, changed after it closed. */
  closedNotes: Shown[];
  /** Round notes on what the review couldn't see (e.g. an unwatched folder), across all rounds. */
  notes: Shown[];
}

/** Splits a location into sheet and place: `Sheet1!B3` -> ["Sheet1", "B3"], `'Q3 !x'!A1` unquoted. */
function splitLocation(row: ReviewRowRecord): [string, string] {
  const bang = row.location.lastIndexOf("!");
  if (bang > 0) {
    return [row.location.slice(0, bang).replace(/^'(.*)'$/, "$1").replace(/''/g, "'"), row.location.slice(bang + 1)];
  }
  return [typeof row.detail.sheet === "string" ? row.detail.sheet : "", row.location];
}

/** The row's review state in one plain line. */
function stateText(s: ItemState): Shown {
  const parts: Shown[] = [];
  if (s.decision) {
    const verb = s.decision.decision === "reject" ? words`Rejected` : words`Approved`;
    const note = s.decision.note ? words`: "${userText(s.decision.note)}"` : words``;
    parts.push(words`${verb} by ${userText(s.decision.reviewer)}${note}`);
  }
  if (s.resolution) {
    const verb = s.resolution.resolution === "fixed" ? words`fixed it` : words`kept it`;
    parts.push(words`Agent ${verb}: "${agentReason(s.resolution.intent, NO_REASON)}"`);
  }
  if (isAnotherSessionRow(s.row) && parts.length === 0) return words`Changed by another session`;
  if (s.openReason) {
    parts.push(words`Needs a look`);
  } else if (s.lowPriority) {
    parts.push(words`Low priority: decide before sign-off`);
  } else if (s.awaiting) {
    parts.push(words`Waiting for your confirmation`);
  }
  return parts.length > 0 ? joinShown(parts, words`. `) : s.row.status === "derived" ? words`Recalculated` : words`Not reviewed yet`;
}

function callView(op: { callId?: string; closedBy?: string; background?: boolean; openedAt?: number; closedAt?: number }): HookCallView {
  return {
    id: op.callId!,
    closedBy: op.closedBy ?? "unknown",
    background: op.background === true,
    ...(op.openedAt !== undefined ? { openedAt: op.openedAt } : {}),
    ...(op.closedAt !== undefined ? { closedAt: op.closedAt } : {}),
  };
}


/** Each round's hook-call ops that no review row names, one entry per call. */
function noCellCalls(ledger: Ledger, taskId: number, states: ItemState[]): NoCellCalls[] {
  const owned = new Set(states.flatMap((s) => s.row.ops.map((op) => op.opId)));
  const out: NoCellCalls[] = [];
  let after = 0;
  for (const r of ledger.roundsForTask(taskId)) {
    const ops = ledger.okOpsForTask(taskId, after, r.lastOpId);
    after = r.lastOpId;
    const withRow = new Set<string>();
    const lone = new Map<string, HookCallView>();
    for (const op of ops) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(maskArgsJson(op.argsJson));
      } catch {
        continue;
      }
      const call = parsed !== null && typeof parsed === "object" ? hookCallOf(parsed as Record<string, unknown>) : undefined;
      if (!call) continue;
      if (owned.has(op.id)) withRow.add(call.callId);
      else lone.set(`${call.callId}|${call.closedBy}`, callView({ ...call, callId: call.callId }));
    }
    const calls = [...lone.values()].filter((c) => !withRow.has(c.id));
    if (calls.length > 0) out.push({ round: r.seq, calls });
  }
  return out;
}

/** Per round, what the hook calls did beyond the watched folder, read from the ops' own args. */
function hookRounds(ledger: Ledger, taskId: number, states: ItemState[]): HookRoundView[] {
  const out: HookRoundView[] = [];
  let after = 0;
  for (const r of ledger.roundsForTask(taskId)) {
    const ops = ledger.okOpsForTask(taskId, after, r.lastOpId);
    after = r.lastOpId;
    const seen = new Set<string>();
    const outside = new Map<string, HookRoundView["outside"][number]>();
    const unknown = new Map<string, HookRoundView["unknown"][number]>();
    const workedIn = new Map<string, HookRoundView["workedIn"][number]>();
    let offCalls = 0;
    for (const op of ops) {
      const args = parseHookArgs(op.argsJson);
      if (!args || typeof args.tool_use_id !== "string" || seen.has(args.tool_use_id)) continue;
      seen.add(args.tool_use_id);
      const why = opReason({ tool: op.tool, intent: redactSecrets(op.intent), callId: args.tool_use_id, ...(typeof args.description === "string" ? { description: args.description } : {}), ...(typeof args.reasonFallback === "string" ? { reasonFallback: args.reasonFallback } : {}) }, "");
      const command = (why.command ?? redactSecrets(op.intent)).replace(/\s+/g, " ").slice(0, 400);
      for (const p of Array.isArray(args.outsideRefs) ? args.outsideRefs : []) if (typeof p === "string") outside.set(`${p}|${args.tool_use_id}`, { name: fileBase(p), reason: why.reason, path: p, command });
      if (typeof args.workedIn === "string" && !workedIn.has(args.workedIn)) workedIn.set(args.workedIn, { name: fileBase(args.workedIn), reason: why.reason, path: args.workedIn });
      if (args.pathUnknown === true) unknown.set(args.tool_use_id, { reason: why.reason, command });
      if (typeof args.outsideCount === "number" && args.outsideCount > 0) offCalls++;
    }
    if (seen.size === 0) continue;
    out.push({ round: r.seq, calls: seen.size, rows: states.filter((s) => s.row.roundSeq === r.seq).length, outside: [...outside.values()], unknown: [...unknown.values()], offCalls, workedIn: [...workedIn.values()] });
  }
  return out;
}

/**
 * Per round, the prompts its own ops carry: a round reads only the ops between the previous round's last op and its
 * own. The adapter logs one op per calling session; with more than one session the lines carry the session.
 */
/**
 * A round's stamps in submit order across sessions. A stamp with `seq` 0 (held before the stamp existed) has no place in the
 * counter, so it takes its own session's next stamped request's place (it was sent before that one); with none after it in its
 * session it goes last, since nothing says it was sent before another session's request. Ties keep each session's own order.
 */
function submitOrder(stamps: RequestStamp[]): RequestStamp[] {
  const key = stamps.map((s, i) => {
    if (s.seq > 0) return s.seq;
    const next = stamps.slice(i + 1).find((t) => t.session === s.session && t.seq > 0);
    return next === undefined ? Infinity : next.seq;
  });
  return stamps.map((s, i) => ({ s, i })).sort((a, b) => key[a.i]! - key[b.i]! || a.i - b.i).map((x) => x.s);
}

function roundRequests(ledger: Ledger, taskId: number): RoundRequest[] {
  const out: RoundRequest[] = [];
  let after = 0;
  for (const r of ledger.roundsForTask(taskId)) {
    const found: Array<{ session: string; lines: Shown[] }> = [];
    const stamps: RequestStamp[] = [];
    const told = new Map<number, number>();
    for (const op of ledger.okOpsForTask(taskId, after, r.lastOpId)) {
      const args = parseHookArgs(op.argsJson);
      if (args?.hookEvent === "RequestFirstStep") {
        // The step a request written at its round's first call was told later.
        for (const q of Array.isArray(args.requests) ? (args.requests as unknown[]) : []) {
          const r = q as { seq?: unknown; firstStep?: unknown } | null;
          if (r !== null && typeof r === "object" && typeof r.seq === "number" && typeof r.firstStep === "number") told.set(r.seq, r.firstStep);
        }
        continue;
      }
      if (args?.hookEvent !== "UserPromptSubmit" || !Array.isArray(args.prompts)) continue;
      const lines = (args.prompts as unknown[]).filter((p): p is string => typeof p === "string").map(userText);
      const earlier = typeof args.earlier === "number" ? args.earlier : 0;
      if (earlier > 0) lines.unshift(words`${plural(earlier, words`earlier prompt`, words`earlier prompts`)} not kept`);
      const session = typeof args.session_id === "string" ? args.session_id : "unknown";
      found.push({ session, lines });
      for (const q of Array.isArray(args.requests) ? (args.requests as unknown[]) : []) {
        const r = q as { seq?: unknown; at?: unknown; firstStep?: unknown } | null;
        if (r === null || typeof r !== "object" || typeof r.seq !== "number") continue;
        stamps.push({ session, seq: r.seq, at: typeof r.at === "number" ? r.at : "unknown", firstStep: typeof r.firstStep === "number" ? r.firstStep : null });
      }
    }
    after = r.lastOpId;
    for (const s of stamps) if (s.firstStep === null && told.has(s.seq)) s.firstStep = told.get(s.seq)!;
    const sessions = [...new Set(found.map((f) => f.session))];
    const label = sessions.length > 1;
    out.push({ round: r.seq, requests: submitOrder(stamps), prompts: found.flatMap((f) => (label ? f.lines.map((l) => words`[session ${sessions.indexOf(f.session) + 1}] ${l}`) : f.lines)) });
  }
  completeFirstSteps(ledger, taskId, out.flatMap((r) => r.requests));
  return out;
}

/**
 * A request's op is written at the Stop that ends its turn, so a step that comes later (an agent it launched keeps working
 * after the Stop) is not in it: the op says null for good. Fill each such stamp from the steps of the calls that sit under it: the
 * first step credited to calls of its session, every one of which started after the request was submitted and before the session's
 * next request. A stamp that already carries a step is left as the hook wrote it; one with no such step stays null.
 */
function completeFirstSteps(ledger: Ledger, taskId: number, stamps: RequestStamp[]): void {
  if (!stamps.some((s) => s.firstStep === null && s.seq > 0)) return;
  const calls = new Map<string, { session: string; start: number }>();
  for (const op of ledger.okOpsForTask(taskId, 0, ledger.maxOpId())) {
    const a = parseHookArgs(op.argsJson);
    if (a === undefined || typeof a.tool_use_id !== "string" || typeof a.session_id !== "string" || typeof a.startSeq !== "number") continue;
    calls.set(a.tool_use_id, { session: a.session_id, start: a.startSeq });
  }
  const steps = ledger.stepsForTask(taskId).filter((st) => st.credited.length > 0);
  for (const s of stamps) {
    if (s.firstStep !== null || s.seq <= 0) continue;
    let next = Infinity;
    for (const o of stamps) if (o.session === s.session && o.seq > s.seq && o.seq < next) next = o.seq;
    const found = steps.find((st) => {
      const mine = st.callsOpen.map((id) => calls.get(id)).filter((c) => c !== undefined && c.session === s.session);
      return mine.length > 0 && mine.every((c) => c!.start > s.seq && c!.start < next);
    });
    if (found) s.firstStep = found.id;
  }
}

function parseHookArgs(argsJson: string): Record<string, unknown> | undefined {
  try {
    const a = JSON.parse(maskArgsJson(argsJson)) as Record<string, unknown>;
    return a !== null && typeof a === "object" && a.hookAdapter === 1 ? a : undefined;
  } catch {
    return undefined;
  }
}

function rowReasons(row: ReviewRowRecord): ReturnType<typeof opReason>[] {
  return row.ops.filter((op) => op.intent !== "").map((op) => opReason(op, row.filePath));
}

function pageRow(s: ItemState, flags: CheckFlag[] = []): PageRow {
  const { row } = s;
  const [, place] = splitLocation(row);
  const reasons = rowReasons(row);
  const fmtBefore = row.detail.numFmtBefore ?? row.detail.numFmt;
  const fmtAfter = row.detail.numFmtAfter ?? row.detail.numFmt;
  return {
    id: row.id,
    layer: row.layer,
    location: row.location,
    place: cellText(place),
    kind: row.kind,
    status: row.status,
    ...shownBeforeAfter(beforeAfterText(row.before, row.after, fmtBefore, fmtAfter, row.detail.dateSystem === 1904 ? 1904 : 1900)),
    description: ownText(row.description),
    outsideFolder: row.ops.some((op) => op.outsideFolder === true),
    intents: [...new Set(reasons.map((r) => r.reason).filter(Boolean))],
    commands: [...new Set(reasons.flatMap((r) => (r.command === null ? [] : [r.command])))],
    calls: [...new Map(row.ops.filter((op) => op.callId !== undefined && op.closedBy !== undefined).map((op) => [`${op.callId}|${op.closedBy}`, callView(op)])).values()],
    agents: [...new Set(row.ops.map((op) => op.client).filter((c): c is string => !!c).map(stripHookSession))],
    open: s.openReason !== undefined,
    lowPriority: isLowPriorityRow(row),
    stateText: stateText(s),
    flags: flags.map((f) => ({ code: f.code, label: ownText(f.label), plural: ownText(f.plural), detail: ownText(f.detail) })),
  };
}

function shownBeforeAfter(t: { before: string; after: string }): { before: Shown; after: Shown } {
  return { before: cellText(t.before), after: cellText(t.after) };
}

/** Flagged rows first (open, then closed), then open unflagged, then the rest; otherwise stable. */
function orderRows(rows: PageRow[]): PageRow[] {
  const rank = (r: PageRow) => (r.flags.length > 0 ? (r.open ? 0 : 1) : r.open ? 2 : 3);
  return rows.map((r, i) => [r, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([r]) => r);
}

const sha256OnDisk = (file: string): string | undefined => {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
};

/** Plain lines on a closed task: expired, values expired, and each file that changed after the copies were deleted. */
function closedNotes(ledger: Ledger, taskId: number): Shown[] {
  const notes: Shown[] = [];
  const closure = closureOf(ledger, taskId);
  const expired = closure?.kind === "expired";
  if (expired) notes.push(words`This task expired, not signed off: it had no activity for 7 days, so it was closed and its file copies were deleted.`);
  if (ledger.valuesExpiredAt(taskId)) notes.push(words`The values were expired: this task closed over 30 days ago, so the before and after values were removed. Locations and file fingerprints remain.`);
  if (closure) {
    const latest = new Map<string, ReturnType<Ledger["snapshotsForTask"]>[number]>();
    for (const s of ledger.snapshotsForTask(taskId)) latest.set(s.filePath, s);
    const touched = new Set(ledger.reviewRowsForTask(taskId).map((r) => r.filePath));
    for (const s of latest.values()) {
      if (!s.removed || s.sha256 === null || !touched.has(s.filePath)) continue;
      if (sha256OnDisk(s.filePath) !== s.sha256) {
        notes.push(words`${fileBase(s.filePath)}: changed after the task closed; its earlier contents weren't kept.`);
      }
    }
  }
  return notes;
}

/** The current round's rows of `taskId`, grouped by file then sheet, open items first. */
export function reviewModel(ledger: Ledger, taskId: number): ReviewModel {
  const states = itemStates(ledger, taskId);
  const requests = requestStates(ledger, taskId);
  const round = latestRound(states);
  const current = pageStates(states);
  const flags = new Map<number, CheckFlag[]>();
  const files = new Map<string, Map<string, SheetGroup>>();
  const lowByFile = new Map<string, PageRow[]>();
  for (const s of current) {
    const [sheet] = splitLocation(s.row);
    const sheets = files.get(s.row.filePath) ?? new Map<string, SheetGroup>();
    files.set(s.row.filePath, sheets);
    if (isLowPriorityRow(s.row)) {
      const low = lowByFile.get(s.row.filePath);
      if (low) low.push(pageRow(s));
      else lowByFile.set(s.row.filePath, [pageRow(s)]);
      continue;
    }
    const group = sheets.get(sheet) ?? { sheet: cellText(sheet), flagged: [], flagCounts: words``, rows: [], derived: [] };
    sheets.set(sheet, group);
    const r = pageRow(s, flags.get(s.row.id));
    const closedDerived = r.status === "derived" && !r.open;
    const first = r.flags[0];
    if (first) {
      // Flagged rows leave the plain lists and group by their first flag; derived ones stay collapsed inside it.
      let fg = group.flagged.find((g) => g.code === first.code);
      if (!fg) {
        fg = { code: first.code, label: first.label, plural: first.plural, count: 0, rows: [], derived: [] };
        group.flagged.push(fg);
      }
      fg.count++;
      (closedDerived ? fg.derived : fg.rows).push(r);
    } else {
      (closedDerived ? group.derived : group.rows).push(r);
    }
  }
  const fileGroups: FileGroup[] = [...files].map(([file, sheets]) => ({
    file,
    name: fileBase(file),
    lowPriority: lowByFile.get(file) ?? [],
    sheets: [...sheets.values()].map((g) => ({
      ...g,
      rows: orderRows(g.rows),
      flagCounts: words``,
      // Groups with something to act on first, then the biggest.
      flagged: [...g.flagged]
        .map((fg) => ({ ...fg, rows: orderRows(fg.rows) }))
        .sort((a, b) => Number(b.rows.length > 0) - Number(a.rows.length > 0) || b.count - a.count),
    })),
  }));
  const notes = [...new Set(ledger.roundNotesForTask(taskId).map((n) => n.note))].map(ownProse);
  return {
    taskId,
    round,
    total: current.length,
    open: current.filter((s) => s.openReason).length + requests.filter((q) => q.open).length,
    moved: [],
    unrecalculated: [],
    checkNotices: [],
    closedNotes: closedNotes(ledger, taskId),
    flagged: flags.size,
    flagSummary: words``,
    files: fileGroups,
    noCellCalls: noCellCalls(ledger, taskId, states),
    hookRounds: hookRounds(ledger, taskId, states),
    roundRequests: roundRequests(ledger, taskId),
    notes,
  };
}
