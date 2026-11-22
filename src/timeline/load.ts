import { isKeyMissing, readSealed } from "../seal.ts";
import { pathKit } from "../paths.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { maskArgsJson, type Ledger } from "../ledger.ts";
import { createRegistry, wholeFileLayer } from "../connector/registry.ts";
import { storedLevelOf } from "../connector/doc-level.ts";
import { connectorById } from "../connector/builtins.ts";
import type { FormatLayer } from "../formats/layer.ts";
import { scrubPatchText } from "../patch-secrets.ts";
import { storedShas, storeDirOf } from "../states.ts";
import { HOOK_PREFIX, hookFolderOf, stripHookSession, readFolderMarker } from "../tasks.ts";
import { redactSecrets } from "../secret-scan.ts";
import { isSecretPath, secretLine } from "../secret-files.ts";
import { secretShasOf } from "../secret-hashes.ts";
import { statSync } from "node:fs";
import { isUriSubject } from "../connector/subject.ts";
import { toDiffObject, type DiffObject } from "../connector/diff-object.ts";
import { OPEN_CAP_BYTES, readState } from "./broken.ts";
import { hostOfClient } from "./attribution.ts";
import { MAX_READ_BYTES, NUL_HEAD_BYTES, chooseGeneric, textTier, type Generic, type Side, type Tier } from "./generic.ts";
import { pictureTier } from "./picture.ts";
import { noCorePicture } from "../connector/claimed-state.ts";
import { markFailedFromSessionFile } from "./rollout-failures.ts";
import { backfillAgentLanes, callEvidenceOf, type AgentSource } from "../agent-transcripts.ts";
import { writeEvidenceFromOps } from "../attribution/evidence.ts";
import type { CallEvidence } from "../credit-guard.ts";
import { GAP_OUTCOMES } from "../connector/after-snapshot.ts";
import { captureGapsOf } from "../connector/after-gap.ts";
import { readFrozen } from "../connector/frozen.ts";
import { MAX_CAPTURE_ASKS } from "../connector/file-capture.ts";
import { oldRowClaimsFor } from "../connector/old-rows.ts";
import { checkChanges, CHANGES_SPEC, issuesOf } from "../connector/changes-v1.ts";
import { docToChanges } from "../connector/row-doc.ts";
// The page's own coverage rule (one function, shared with the review page): the nothing-changed lines a frozen document earns.
import "./rail/assets/view-table.js";
const VT = (globalThis as unknown as { CoCheckViewTable: { coverageLine(doc: unknown): string; NOTHING_CHANGED: string; NOTHING_VISIBLE: string } }).CoCheckViewTable;
import { vouchesNothingChanged } from "../connector/nothing-changed-rule.ts";
import { readRecord, type RawOp, type RawState } from "./runs.ts";
import { imageTypeOf } from "./stored-image.ts";
import { buildTimeline, timelineEtag, type FormatChanges, type FormatRow, type Timeline, type TimelineInput } from "./timeline.ts";

/** The most format-layer rows listed for one change; the rest are counted in the change's missing list. */
export const MAX_FORMAT_ROWS = 100;
/** How many picture entries are built at once while a timeline loads. */
const PICTURE_CONCURRENCY = 4;

export function defaultLayers(): FormatLayer[] {
  // The registry's built-in layers: the generic ones only. A format a connector claims is read by that connector.
  return createRegistry().layers();
}

/** The ledger's rows for one task, in the shape the pure model reads. This is the only place the timeline touches the ledger. */
export function readRows(ledger: Ledger, taskId: number): { ops: RawOp[]; fileStates: RawState[] } {
  const ops: RawOp[] = ledger.okOpsForTask(taskId, 0, ledger.maxOpId()).map((o) => ({ id: o.id, tool: o.tool, intent: redactSecrets(scrubPatchText(o.intent)), args_json: maskArgsJson(o.argsJson) }));
  const stepTs = new Map(ledger.stepsForTask(taskId).map((st) => [st.id, st.ts]));
  const rows = ledger.fileStatesForTask(taskId);
  // a row the hook recorded with no connector that has a capture was queued at load and is read with today's built-in claimant; it is drawn
  // as a connector row, marked read later. The file_states row itself still says connector NULL. A type no built-in claims now keeps an empty name.
  const claimNow = rows.some((s) => s.connector === null && s.capture != null) && ledger.home !== undefined ? oldRowClaimsFor(ledger.home) : undefined;
  const fileStates: RawState[] = rows.map((s) => ({
    id: s.id,
    step_id: s.stepId,
    task_id: s.taskId,
    file_path: s.filePath,
    sha256: s.sha256,
    prev_sha256: s.prevSha256,
    phase: s.phase,
    calls_open_json: s.callsOpen,
    credited_json: s.credited,
    size: s.size,
    kept: s.kept,
    note: s.note,
    mtime_ns: s.mtimeNs,
    credit_basis: s.creditBasis,
    ...(s.connector !== null ? { connector: s.connector } : s.capture != null && claimNow !== undefined ? { connector: claimNow(s.filePath) ?? "", read_later: true as const } : {}),
    ...(s.connectorVersion === null ? {} : { connector_version: s.connectorVersion }),
    ...(s.connectorSpec === null ? {} : { connector_spec: s.connectorSpec }),
    ...(s.changesSha256 === null ? {} : { changes_sha256: s.changesSha256 }),
    ...(s.capture == null ? {} : { capture: s.capture }),
    ...(s.captureReason == null ? {} : { capture_reason: s.captureReason }),
    ...(s.captureDetail == null ? {} : { capture_detail: s.captureDetail }),
    ...(s.captureTries === undefined || s.captureTries === 0 ? {} : { capture_tries: s.captureTries }),
    ...(s.captureTrySha == null ? {} : { capture_try_sha: s.captureTrySha }),
    ts: stepTs.get(s.stepId) ?? null,
  }));
  return { ops, fileStates };
}

export interface LoadOptions {
  layers?: FormatLayer[];
  build: string;
  /** No effect (the browser shows images on every OS); kept so existing callers compile. */
  quickLook?: boolean;
  /** No effect (nothing is rendered); kept so existing callers compile. */
  render?: (file: string, outDir: string) => Promise<string | null>;
  /** Extra "is text" judgement by path for the picture tier; text is already decided by content before the picture tier runs. */
  isText?: (filePath: string) => boolean;
  /**
   * Whether a file is a secret file, by its path. A secret file is never opened, never read by a format layer and never rendered; it
   * is a fingerprint with `secret: true`. Defaults to `isSecretPath` (src/secret-files.ts).
   */
  isSecret?: (filePath: string) => boolean;
  /**
   * What a connector says about one change to its subject (the function is supplied by the caller). Asked for every file_states row whose `connector` column is set;
   * with no function, or when it throws, the change still gets a DiffObject, with `unavailable` naming why.
   */
  connectorDiff?: (row: { subject: string; connector: string; before: { ref: string | null }; after: { ref: string | null } }) => Promise<DiffObject>;
}

/** The DiffObject of one connector row: the connector's answer made safe (the producer and the row's own identity are the loader's, a `builtin` part is dropped), or an `unavailable` one saying why. */
async function connectorDiffOf(s: RawState, opts: LoadOptions, home: string, taskId: number): Promise<DiffObject> {
  const subject = s.file_path, connector = s.connector!;
  const before = { ref: s.prev_sha256 }, after = { ref: s.kept === "gone" ? null : s.sha256 };
  const unavailable = (why: string): DiffObject => ({ spec: "cocheck.diff/1", subject, connector, producer: "connector", before, after, changes: [], caveats: [], unavailable: why });
  // a file row the review process has not read yet says so (the page asks again); one it could not read says why, and is never asked again.
  // a row whose connector said "not ready, ask again" shows that answer's change list while it waits; the page keeps asking, and a load after the gap since the last try (file-capture.ts CAPTURE_ASK_GAPS_MS) asks the connector again.
  if (s.capture === "pending" && s.capture_try_sha != null) {
    try {
      const stored = (await readFrozen(home, taskId, s.capture_try_sha)) as { spec?: unknown; caveats?: unknown; status?: { evidence?: unknown } };
      if (stored.spec === CHANGES_SPEC && checkChanges(stored).length === 0) {
        const evidence = typeof stored.status?.evidence === "string" && stored.status.evidence !== "" ? ` It said: ${stored.status.evidence}` : "";
        const waiting = `Waiting: the connector said it was not ready yet, so CoCheck asks again (asked ${s.capture_tries ?? 1} of ${MAX_CAPTURE_ASKS} times).${evidence}`;
        const d = toStoredDiff({ changes: docToChanges(stored as { changes?: unknown }), caveats: [waiting, ...(Array.isArray(stored.caveats) ? stored.caveats : [])] }, { subject, connector, before: { ref: null }, after }, before);
        return { ...d, pending: true, served: { kind: "frozen", ref: s.capture_try_sha, level: storedLevelOf(stored) } };
      }
    } catch {
      // fall through to "still reading"
    }
  }
  if (s.capture === "pending") return { ...unavailable("CoCheck is still reading the change list"), pending: true };
  if (s.capture === "failed") return { ...unavailable(s.capture_reason ?? "the change list could not be read"), failed: true, caveats: s.capture_detail == null ? [] : [`It said: ${s.capture_detail}`] };
  // a row captured with a frozen change list is read from it, never from the connector: an uninstalled or upgraded connector changes nothing here.
  if (s.changes_sha256 != null) {
    try {
      const stored = (await readFrozen(home, taskId, s.changes_sha256)) as { spec?: unknown; level?: unknown; changes?: unknown; caveats?: unknown };
      // an export connector's row holds a marker (CoCheck draws the stored text); a cocheck.changes/1 answer is held as the document and served as it is.
      if (stored.spec === "cocheck.export/1") return { spec: "cocheck.diff/1", subject, connector, producer: "connector", before, after, changes: [], caveats: [], served: { kind: "export" } };
      if (stored.spec === "cocheck.export/2") {
        const t = stored as { before?: unknown; after?: unknown };
        const text = (v: unknown): string | null | undefined => (v === null || typeof v === "string" ? v : undefined);
        const b = text(t.before), a = text(t.after);
        if (b === undefined || a === undefined) return unavailable("the export kept for this step is not readable");
        return { spec: "cocheck.diff/1", subject, connector, producer: "connector", before, after, changes: [], caveats: [], served: { kind: "export-text", before: b, after: a } };
      }
      if (stored.spec === CHANGES_SPEC) {
        if (checkChanges(stored).length > 0) return unavailable("the change list kept for this step is not a valid change document");
        // migration X1: the connector's issues (spec v1.2, every level) ride on the step, so the send-back prompt can name them
        const issues = issuesOf(stored);
        const nothing = nothingOf(stored, connector);
        // the claiming connector's frozen answer vouches "nothing changed" (P3); the lane rule reads it
        return { ...toStoredDiff({ changes: docToChanges(stored), caveats: stored.caveats }, { subject, connector, before: { ref: null }, after }, before), served: { kind: "frozen", ref: s.changes_sha256, level: storedLevelOf(stored) }, ...(issues.length > 0 ? { issues } : {}), ...(nothing !== undefined ? { nothing } : {}) };
      }
      return unavailable("the change list kept for this step is not a cocheck.changes/1 document");
    } catch {
      return unavailable("the change list kept for this step could not be read");
    }
  }
  // A row captured since schema 7 with no list kept has none to show, and the connector is not asked again.
  if (s.connector_spec != null) return unavailable("no change list was kept when this step was captured");
  if (opts.connectorDiff === undefined) return unavailable(`no reader for the connector '${connector}' is available`);
  let answer: DiffObject;
  try {
    answer = await opts.connectorDiff({ subject, connector, before: { ...before }, after: { ...after } });
  } catch (e) {
    return unavailable(`the connector '${connector}' failed: ${(e as Error).message}`);
  }
  if (typeof answer !== "object" || answer === null || !Array.isArray(answer.changes)) return unavailable(`the connector '${connector}' gave no diff object`);
  const { builtin: _b, v1doc: _v, ...rest } = answer as DiffObject & { v1doc?: unknown };
  return { ...rest, spec: "cocheck.diff/1", subject, connector, producer: "connector", before, after, caveats: Array.isArray(answer.caveats) ? answer.caveats : [], changes: answer.changes.map(({ builtin: _c, ...c }) => c) };
}

/**
 * the one nothing-changed signal of a frozen document. "changed" is P3 (`vouchesNothingChanged`, no level
 * test: a captured empty list is drawn at level 1), which the step's note, the lane rule and the page's NOTHING_CHANGED line all read; "visible"
 * is the page's NOTHING_VISIBLE line (every picture unchanged), a note only, never muting.
 */
function nothingOf(stored: unknown, connector: string): "changed" | "visible" | undefined {
  if (vouchesNothingChanged(stored)) return "changed";
  const held = (stored as { source?: { nothingChanged?: unknown } }).source?.nothingChanged === true;
  const line = VT.coverageLine({ ...(stored as object), source: { by: "connector", name: connector, level: storedLevelOf(stored), ...(held ? { nothingChanged: true } : {}) } });
  return line === VT.NOTHING_VISIBLE ? "visible" : undefined;
}

function toStoredDiff(a: { changes: DiffObject["changes"]; caveats?: unknown }, id: { subject: string; connector: string; before: { ref: string | null }; after: { ref: string | null } }, before?: { ref: string | null }): DiffObject {
  return { spec: "cocheck.diff/1", ...id, ...(before === undefined ? {} : { before }), producer: "connector", caveats: Array.isArray(a.caveats) ? (a.caveats as string[]) : [], changes: a.changes.map(({ builtin: _c, ...c }) => c) };
}

/** The rows a timeline is built from: cheap to read, and enough for the ETag. */
export interface Loaded {
  taskId: number;
  ops: RawOp[];
  fileStates: RawState[];
  valuesExpiredAt: string | null;
  removals: Array<{ sha256: string; ts: string; reason: string }>;
  /** failed known-subject captures, call id to plain reason (the latest per call). */
  captureGaps: ReadonlyMap<string, string>;
  etag: string;
  /** How calls ended, from the sessions' transcripts (only with `transcripts`). */
  evidence?: ReadonlyMap<string, CallEvidence>;
}

/**
 * `transcripts` is where Claude Code keeps its project folders; with it, calls recorded before subagent lanes were stored get their subagent lanes back from the
 * session's subagent transcripts (in memory only). Without it the ops are read as stored. `sessionsDir` points the host's session-file reads at a
 * temp tree.
 */
export function loadRows(ledger: Ledger, taskId: number, build: string, transcripts?: { transcriptsRoot: string; sessionsDir?: string }): Loaded {
  const rows = readRows(ledger, taskId);
  const { fileStates } = rows;
  const source: AgentSource | null = transcripts === undefined ? null : { root: transcripts.transcriptsRoot, folder: ledger.home === undefined ? null : taskFolderOf(ledger, ledger.home, taskId) };
  // With the host's session files in reach, a call whose failure reached them after its Post is read as failed (in memory only).
  const ops = source === null ? rows.ops : markFailedFromSessionFile(backfillAgentLanes(rows.ops, source), transcripts!.sessionsDir);
  const evidence = source === null ? undefined : callEvidenceOf(ops, source);
  const valuesExpiredAt = ledger.valuesExpiredAt(taskId) ?? null;
  const removals = ledger.stateRemovalsForTask(taskId);
  // A later outcome of the same call (a retry that recorded, or was unchanged) replaces an earlier failure; a gap the hook wrote shows only when the review process recorded nothing for the call.
  const captureGaps = captureGapsOf(ledger.captureOutcomesForTask(taskId), GAP_OUTCOMES);
  // a file row's capture finishes without a new row, so where each read stands is part of the tag (only tasks that have such rows).
  const captures = fileStates.filter((s) => s.capture != null).map((s) => `${s.id}:${s.capture}:${s.changes_sha256 ?? ""}:${s.capture_tries ?? 0}`).join(",");
  return { taskId, ops, fileStates, valuesExpiredAt, removals, captureGaps, ...(evidence === undefined ? {} : { evidence }), etag: timelineEtag({ ops, fileStates, valuesExpiredAt, removals, build, captureGaps, ...(evidence === undefined ? {} : { evidence }), ...(captures === "" ? {} : { captures }) }) };
}

// A pair of stored states diffed once per process: the ledger is append-only, so the same two hashes always give the same answer.
const diffCache = new Map<string, FormatChanges>();
const DIFF_CACHE_MAX = 500;

export async function formatChangesOf(home: string, taskId: number, s: RawState, layers: FormatLayer[], stored: ReadonlyMap<string, number>, secretShas: ReadonlySet<string>, claimed = false): Promise<FormatChanges> {
  if (isSecretPath(s.file_path) || secretShas.has(s.sha256) || (s.prev_sha256 !== null && secretShas.has(s.prev_sha256))) return { unavailable: "this file looks like it holds a secret, so its contents are not read" };
  // a state a connector reads is listed as one whole-file row, never by lines, whatever its bytes are.
  const layer = claimed ? wholeFileLayer() : layers.find((l) => l.accepts(s.file_path));
  if (!layer) return { unavailable: "no reader exists for this file type" };
  if (!stored.has(s.sha256)) return { unavailable: "the state after this change is not in the store" };
  if (s.prev_sha256 !== null && !stored.has(s.prev_sha256)) return { unavailable: "the state before this change is not in the store" };
  const key = `${layer.name}${claimed ? "+claimed" : ""}:${s.prev_sha256 ?? ""}:${s.sha256}:${path.extname(s.file_path).toLowerCase()}`;
  const hit = diffCache.get(key);
  if (hit) return hit;
  // Layers pick their granularity by the file name, so each side is read from a copy that keeps the extension. Copies live in a temp dir only.
  const ext = path.extname(s.file_path).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-timeline-"));
  try {
    const states = storeDirOf(home, taskId);
    const beforePath = s.prev_sha256 === null ? null : path.join(dir, `before${ext}`);
    const afterPath = path.join(dir, `after${ext}`);
    // Decrypted here and written to the private temp folder: the differ never sees (or copies) the ciphertext.
    if (beforePath !== null) await writeFile(beforePath, await readSealed(path.join(states, s.prev_sha256!)), { mode: 0o600 });
    await writeFile(afterPath, await readSealed(path.join(states, s.sha256)), { mode: 0o600 });
    // core's layers are the generic ones (text, csv, a whole-file row); a format's labels, look, pictures and "saved again" come from its
    // connector's document, never from here.
    const found = await layer.diff(beforePath, afterPath);
    // A value empty on both sides ("", null or missing) changed nothing: no row, so no note and no count.
    const blank = (v: unknown): boolean => v === undefined || v === null || v === "";
    const rows = found.filter((r) => !(blank(r.before) && blank(r.after) && r.kind === "value"));
    const shown = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));
    const listed: FormatRow[] = rows.slice(0, MAX_FORMAT_ROWS).map((row) => ({ location: row.location, kind: row.kind, before: shown(row.before), after: shown(row.after), text: layer.describe(row) }));
    const out: FormatChanges = { module: layer.name, rows: listed, more: Math.max(0, rows.length - listed.length) };
    if (diffCache.size >= DIFF_CACHE_MAX) diffCache.delete(diffCache.keys().next().value!);
    diffCache.set(key, out);
    return out;
  } catch (error) {
    if (isKeyMissing(error)) throw error;
    return { unavailable: `the ${layer.name} reader could not compare the two states (${error instanceof Error ? error.constructor.name : "error"})` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The generic shape of a pair of stored states, computed once per process like the format diffs: the ledger is append-only.
const genericCache = new Map<string, Generic>();

/** A side whose bytes are deliberately not opened (a secret file). */
const unread = (sha: string): Side => ({ sha, size: null, bytes: null, why: "secret file" });

/** Reads one stored state. A NUL byte in the first 64 KB marks it binary without reading the rest. */
async function readSide(home: string, taskId: number, sha: string, stored: ReadonlyMap<string, number>): Promise<Side> {
  if (!stored.has(sha)) return { sha, size: null, bytes: null, why: "not in the store" };
  const size = stored.get(sha) ?? null;
  const over = size !== null && size > MAX_READ_BYTES;
  try {
    // The state is ciphertext on disk: decrypted whole in memory, then cut down to what the caller keeps.
    const all = await readSealed(path.join(storeDirOf(home, taskId), sha));
    const head = all.subarray(0, Math.min(NUL_HEAD_BYTES, size ?? NUL_HEAD_BYTES, all.length));
    if (head.includes(0)) return { sha, size, bytes: null, why: "not plain text", binary: true };
    // Over the cap only the head is kept: enough to tell text from binary, never the whole file.
    if (over) return { sha, size, bytes: Buffer.from(head), why: null, head: true };
    return { sha, size, bytes: all, why: null };
  } catch (error) {
    if (isKeyMissing(error)) throw error;
    return { sha, size, bytes: null, why: "it could not be read" };
  }
}

/** What the reader that draws this file's view says about one stored state: a reason when it fails, else null. Never throws; a bug in a reader is a caveat line and no claim. */
export async function unopenedOfState(home: string, taskId: number, sha: string, file: string, stored: ReadonlyMap<string, number>, caveats: string[], reader: typeof readState = readState): Promise<string | null> {
  if (!stored.has(sha) || (stored.get(sha) ?? 0) > OPEN_CAP_BYTES) return null;
  try {
    const r = await reader(file, await readSealed(path.join(storeDirOf(home, taskId), sha)));
    return "failed" in r ? r.failed : null;
  } catch (error) {
    if (isKeyMissing(error)) throw error;
    caveats.push(`CoCheck could not check whether it can open a version of ${file}, so it says nothing about it.`);
    return null;
  }
}

/**
 * The folder a task watches, as a plain absolute path, or null. A hook-adapter task's folder is the tail of its client name, always: a marker
 * `dir` recorded from some other file never overrides it. Any other task: the folder marker's `dir`, else the client name. The hook prefix
 * is stripped here and nowhere else, so every inside/outside test reads one value.
 */
export function taskFolderOf(ledger: Ledger, home: string, taskId: number): string | null {
  const hook = hookFolderOf(ledger.taskClient(taskId));
  if (hook !== null) return hook;
  const raw = readFolderMarker(home, taskId).dir ?? ledger.taskClient(taskId) ?? null;
  if (raw === null) return null;
  const dir = pathKit().trimEnd(stripHookSession(raw).replace(HOOK_PREFIX, ""));
  return pathKit().isAbs(dir) ? dir : null;
}

/** The task's host, from the `<host>-hook:` prefix of the client its steps were written under (the task's own, when it has no step); null unless exactly one host is named. */
export function taskHostOf(ledger: Ledger, taskId: number): string | null {
  const steps = ledger.stepsForTask(taskId).map((st) => st.client);
  const hosts = new Set((steps.length > 0 ? steps : [ledger.taskClient(taskId) ?? null]).map(hostOfClient));
  return hosts.size === 1 ? [...hosts][0]! : null;
}

/** Script files whose text the review reads, and the size past which one is not read. */
const SCRIPT_FILE = /\.(py|js|mjs|cjs|rb|pl|php|R|r)$/;
const SCRIPT_CAP_BYTES = 512 * 1024;

export async function loadTimelineInput(ledger: Ledger, home: string, loaded: Loaded, opts: LoadOptions): Promise<TimelineInput> {
  const { taskId } = loaded;
  const layers = opts.layers ?? defaultLayers();
  const stored = storedShas(home, taskId);
  const folder = taskFolderOf(ledger, home, taskId);
  // Read before the first await, like the folder: a caller may close the ledger once this function yields.
  const host = taskHostOf(ledger, taskId);
  const isSecret = opts.isSecret ?? isSecretPath;
  // A file the task read and never changed counts as "found at task start" when it is a plain file, not secret, last modified before the task's first step.
  const firstStep = Date.parse(ledger.stepsForTask(taskId)[0]?.ts ?? "");
  const existsAtStart = (file: string): boolean => {
    // A connector's URI subject is not on disk: no filesystem call names it.
    if (!Number.isFinite(firstStep) || isUriSubject(file) || isSecret(file)) return false;
    try {
      const st = statSync(file);
      return st.isFile() && st.mtimeMs <= firstStep;
    } catch {
      return false;
    }
  };
  // A secret is its bytes: a state holding the bytes of a secret-named file is secret under any name.
  const secretShas = secretShasOf(loaded.fileStates.map((r) => ({ path: r.file_path, sha: r.sha256, prev: r.prev_sha256, note: r.note })), isSecret);
  const holdsSecret = (s: { file_path: string; sha256: string; prev_sha256: string | null }): boolean => isSecret(s.file_path) || secretShas.has(s.sha256) || (s.prev_sha256 !== null && secretShas.has(s.prev_sha256));
  const formats = new Map<number, FormatChanges>();
  const generics = new Map<number, Generic>();
  const diffs = new Map<number, DiffObject>();
  if (loaded.valuesExpiredAt === null) {
    const changes = readRecord(loaded.ops, loaded.fileStates).states.filter((s) => s.change);
    const secretIds = new Set(changes.filter(holdsSecret).map((s) => s.id));
    // A secret file is read by no layer: its format entry says so and nothing from its bytes is kept.
    // the states core may not draw or read by lines, read once per load (the claims as they stand at view time).
    const blocked = noCorePicture(home, loaded.fileStates.map((r) => ({ filePath: r.file_path, sha256: r.sha256, prevSha256: r.prev_sha256, connector: r.connector ?? null })));
    const done = new Map<number, FormatChanges>();
    for (const s of loaded.fileStates) {
      // A connector's row is not read by a format layer or the store: its DiffObject comes from the connector (below).
      if (s.connector != null) continue;
      done.set(s.id, secretIds.has(s.id) ? { unavailable: "this is a secret file" } : await formatChangesOf(home, taskId, s, layers, stored, secretShas, blocked.file(s.file_path) || blocked.sha(s.prev_sha256) || blocked.sha(s.sha256)));
    }
    for (const s of loaded.fileStates) if (s.connector == null) formats.set(s.id, done.get(s.id)!);
    // One DiffObject per change: a built-in file's from its FormatChanges, a connector's from the connector.
    const rowById = new Map(loaded.fileStates.map((r) => [r.id, r] as const));
    for (const s of changes) {
      const row = rowById.get(s.id)!;
      const d = row.connector != null ? await connectorDiffOf(row, opts, home, taskId) : toDiffObject(s.file_path, "builtin", formats.get(s.id)!);
      // an old row's list was read later than its step; the page says so (view-table.js READ_LATER).
      diffs.set(s.id, row.read_later === true ? { ...d, readLater: true } : d);
    }
    const sizeOf = (sha: string | null): number | null => loaded.fileStates.find((r) => r.sha256 === sha)?.size ?? null;
    let next = 0;
    const work = async (): Promise<void> => {
      while (next < changes.length) {
        const s = changes[next++]!;
        const secret = secretIds.has(s.id);
        const deleted = s.kept === "gone";
        const afterSha = deleted ? null : s.sha256;
        const rel = (folder === null ? null : pathKit().rel(folder, s.file_path)) ?? pathKit().baseName(s.file_path);
        const key = secret ? null : `${s.prev_sha256 ?? ""}:${afterSha ?? ""}:${path.extname(s.file_path).toLowerCase()}:${blocked.file(s.file_path) || blocked.sha(s.prev_sha256) || blocked.sha(s.kept === "gone" ? null : s.sha256)}`;
        const hit = key === null ? undefined : genericCache.get(key);
        if (hit) {
          generics.set(s.id, hit);
          continue;
        }
        // Text first, by content; then the picture tier; the fingerprint is the floor. A secret file's bytes are not opened.
        const before = s.prev_sha256 === null ? null : secret ? unread(s.prev_sha256) : await readSide(home, taskId, s.prev_sha256, stored);
        const after = afterSha === null ? null : secret ? unread(afterSha) : await readSide(home, taskId, afterSha, stored);
        // A version missing from the store is the floor's to explain ("bytes not available"), not the picture tier's.
        const absent = [before, after].some((x) => x !== null && x.bytes === null && !x.binary && x.why === "not in the store");
        const claimed = blocked.file(s.file_path) || blocked.sha(s.prev_sha256) || blocked.sha(afterSha);
        const picture: Tier = async () =>
          absent ? null : pictureTier({ claimed,
            home, taskId, filePath: s.file_path, before: s.prev_sha256, after: afterSha,
            stored, sizes: { before: sizeOf(s.prev_sha256), after: deleted ? null : (typeof s.size === "number" ? s.size : null) },
            isText: opts.isText, isSecret: () => false,
          });
        // an image file (svg is text by its bytes) is drawn by the browser, so the picture tier goes first for it.
        // the text tier decides by bytes and never asks the claim, so a claimed state skips it: no lines of a state a connector reads.
        const g = await chooseGeneric(
          { file: s.file_path, kind: s.prev_sha256 === null ? "created" : deleted ? "deleted" : "modified", before, after, secret, secretLabel: secretLine(rel) },
          claimed ? [picture] : imageTypeOf(s.file_path) !== null ? [picture, textTier] : [textTier, picture],
        );
        if (claimed && !secret) g.claimed = true;
        // A state the view's own reader fails on is named on the change; the bytes are the stored ones, read whole under the view's cap.
        const bad: NonNullable<Generic["unopened"]> = [];
        const caveats: string[] = [];
        if (!secret) {
          for (const [side, sha] of [["before", s.prev_sha256], ["after", afterSha]] as const) {
            const why = sha === null ? null : await unopenedOfState(home, taskId, sha, s.file_path, stored, caveats);
            if (why !== null) bad.push({ side, why });
          }
        }
        if (bad.length > 0) g.unopened = bad;
        if (caveats.length > 0) g.readerCaveats = caveats;
        generics.set(s.id, g);
        if (key !== null && g.tier !== "picture" && g.pending !== true) {
          if (genericCache.size >= DIFF_CACHE_MAX) genericCache.delete(genericCache.keys().next().value!);
          genericCache.set(key, g);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PICTURE_CONCURRENCY, changes.length) }, work));
  }
  // The text of each stored version of a script file, for the calls that ran it ("Built from" reads the script for the files it opens).
  const scriptTexts = new Map<string, string>();
  for (const r of loaded.fileStates) {
    if (!SCRIPT_FILE.test(r.file_path) || scriptTexts.has(r.sha256) || !stored.has(r.sha256) || (stored.get(r.sha256) ?? 0) > SCRIPT_CAP_BYTES || holdsSecret(r)) continue;
    try {
      const bytes = await readSealed(path.join(storeDirOf(home, taskId), r.sha256));
      if (!bytes.includes(0)) scriptTexts.set(r.sha256, bytes.toString("utf8"));
    } catch (error) {
      if (isKeyMissing(error)) throw error;
    }
  }
  return {
    taskId,
    build: opts.build,
    scriptTexts,
    ops: loaded.ops,
    fileStates: loaded.fileStates,
    folder,
    valuesExpiredAt: loaded.valuesExpiredAt,
    removals: loaded.removals,
    ...(loaded.captureGaps.size === 0 ? {} : { captureGaps: loaded.captureGaps }),
    stored,
    formats,
    diffs,
    generics,
    host,
    existsAtStart,
    ...(loaded.evidence === undefined ? {} : { evidence: loaded.evidence }),
    // The writes the live adapter proved with the per-call tag, matched to each change by file and ledger step.
    writeEvidence: writeEvidenceFromOps(loaded.ops),
  };
}

export async function loadTimeline(ledger: Ledger, home: string, taskId: number, opts: LoadOptions): Promise<{ timeline: Timeline; etag: string }> {
  const loaded = loadRows(ledger, taskId, opts.build);
  return { timeline: buildTimeline(await loadTimelineInput(ledger, home, loaded, opts)), etag: loaded.etag };
}

/** The raw command of one call, for an explicit expand; undefined when the task has no such call. `null` when the call ran no command. */
export function commandOfCall(loaded: Loaded, callId: string): { command: string | null; tool: string | null } | undefined {
  if (loaded.valuesExpiredAt !== null) return undefined;
  const c = readRecord(loaded.ops, []).calls.get(callId);
  if (!c) return undefined;
  return { command: c.command && c.command !== c.tool ? c.command : null, tool: c.tool };
}
