// The one program behind the three built-in Office connectors. It is a normal connector-v1 program: JSON lines on stdin and stdout,
// `hello` then `diff`, answering cocheck.changes/1 at level 3 (every app boxes its changes on its PDF pages):
//   - the change list comes from the readers this program lists (layerFor), never rewritten here;
//   - the pictures are the app's own PDF pages (office-job.ts drives the app through the platform driver, pictures.ts rasterizes with
//     the shipped pdfpages helper), each flagged changed or unchanged; boxes only for Word's paragraphs (word-boxes.ts, level 3);
//   - a broken file (preflight's skip verdicts) is answered with an error before Office is touched;
//   - an app the person has open is never touched: the answer is the change list with pendingRetry, so CoCheck asks again later;
//   - when Office cannot draw, the answer still carries the change list, plus the reason (a caveat, and a status when no side was drawn).
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { CHANGES_SPEC } from "../../../public-kit/helpers/spec.mjs";
import { createFilesLayer } from "./docx/layer.ts";
import { createPptxLayer } from "./pptx/layer.ts";
import { createXlsxLayer } from "./xlsx/layer.ts";
import type { LayerDiffRow } from "../../formats/layer.ts";
import { preflight } from "./shared/preflight.ts";
import { stageName, stagingExt, type OfficeApp } from "./apps.ts";
import { answerExcel } from "./excel/answer.ts";
import { installSignalCleanup, officePdfs, type OfficeExportDriver } from "./office-job.ts";
import { addPptxBoxes, type BoxChange } from "./pptx-boxes.ts";
import { reachOf } from "./reach.ts";
import { refusalWords } from "./refusal.ts";
import { structureIssues, type Issue } from "./issues.ts";
import { unlistedChange } from "./nothing-changed.ts";
import { helperPager, pdfPictures, stampRenderedBy, type PdfPager, type Picture } from "./pictures.ts";
import { placeWordBoxes, type WordBox } from "./word-boxes.ts";

export const CONNECTOR_SPEC = "cocheck.connector/1";
/** The level each app's hello declares. */
export const levelFor = (_app: OfficeApp): 2 | 3 => 3; // all three carry boxes on their PDF pages: Excel, Word (word-boxes.ts), PowerPoint (pptx-boxes.ts)
/** The answer line limit is 16 MB; pictures get what is left under this after the change list. */
export const ANSWER_BUDGET_BYTES = 15 * 1024 * 1024;
/** The manifest's diffMs. */
export const DIFF_MS = 60_000;
/**
 * How diffMs is spent. Everything ends `marginMs` before diffMs (to write the answer); drawing gets the last `drawMs` before that, cleanup
 * (count, quit, wait for the app to go) the `cleanupMs` before drawing, and the exports end there. CoCheck stops the program at diffMs.
 */
export const RESERVES = { marginMs: 5_000, cleanupMs: 12_000, drawMs: 10_000 };
/** How many more times CoCheck should ask when the app is open (the spec's most). */
export const PENDING_RETRY = 5;

export interface ProgramDeps {
  /** The platform's Office; undefined where no driver exists (every OS but macOS today): the answer is the change list with a caveat, and nothing else is touched (no lock, no window helper). */
  driver: OfficeExportDriver | undefined;
  pager: PdfPager;
  lockPath: string;
  now?: () => number;
  /** The reason given when `driver` is undefined (default: `NO_DRIVER_WHY`, which names no OS). */
  noDriverWhy?: string;
  /** diffMs and how it is spent (tests shorten them). */
  diffMs?: number;
  reserves?: { marginMs: number; cleanupMs: number; drawMs: number };
  /** Passed to the job (tests shorten them). */
  lockWaitMs?: number;
  goneWaitMs?: number;
  pollMs?: number;
  /** Excel's region pictures: how a printed page is cut and read (tests pass fakes; default: the shipped pdfpages helper). */
  crop?: import("./excel/answer.ts").Cropper;
  pages?: import("./excel/answer.ts").PageReader;
  /** Starts a helper used only for `windows {pid}` (the print route's prompt watch; no Screen Recording grant is read or asked). Absent or null: no prompt verdict there. */
  windows?: () => Promise<{ helper: import("./office-job.ts").WindowScreen; close(): Promise<void> } | null>;
  /** Test seams for the print route's prompt watch, ms. */
  promptTickMs?: number;
  promptHoldMs?: number;
}

/** Said when this computer has no Office driver (Windows and Linux): the answer is the change list alone, drawn at level 1. Names no OS. */
export const NO_DRIVER_WHY = (app: Pick<OfficeApp, "name">): string => `CoCheck does not draw ${app.name}'s pages on this computer, so this is the change list.`;

export const defaultLockPath = (): string => path.join(tmpdir(), "cocheck-office-connector.lock");
export const defaultDeps = (driver: OfficeExportDriver | undefined): ProgramDeps => ({ driver, pager: helperPager, lockPath: defaultLockPath() });

/** An answer that is an error (`{ code, message }`), not a document. */
export class ConnectorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Change { id: string; mark: string; label: string; before?: string; after?: string; text?: string; kind?: string; boxes?: WordBox[]; unplaced?: Partial<Record<"before" | "after", string>> }
export interface OfficeDoc { spec: string; changes: Change[]; pictures?: Picture[]; caveats: string[]; issues?: Issue[]; pendingRetry?: number; status?: { kind: string; evidence: string } }

/** The reader that reads `file` (staged under the app's ending). The connector's own list; core keeps only the generic layer. */
function layerFor(file: string) {
  const layer = [createXlsxLayer({ openState: async () => "closed" }), createPptxLayer(), createFilesLayer()].find((l) => l.accepts(file));
  if (layer === undefined) throw new Error(`no CoCheck reader for ${path.extname(file)}`);
  return layer;
}

/** A value in words: text as it is, numbers and booleans printed, a cell's formula and value spelled out, anything else as JSON. */
export function words(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && ("formula" in v || "value" in v)) {
    const o = v as { formula?: unknown; value?: unknown };
    const f = typeof o.formula === "string" && o.formula !== "" ? `formula =${o.formula}` : undefined;
    const val = o.value === null || o.value === undefined ? (f !== undefined ? "no stored value" : undefined) : `value ${words(o.value)}`;
    const parts = [f, val].filter((x): x is string => x !== undefined);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return JSON.stringify(v);
}

/** A reader's row as a v1 change. The mark comes from the row's own kind and sides; a structural row says "inserted" or "deleted" in its description. */
export function rowChange(row: LayerDiffRow, describe: string, i: number): Change {
  const before = words(row.before), after = words(row.after);
  const kindText = `${row.kind} ${row.kind === "structure" ? describe : ""}`;
  const mark = /\b(new|added|inserted|insert|created)\b/i.test(kindText) ? "added"
    : /\b(deleted|removed|delete)\b/i.test(kindText) ? "removed"
    : before !== undefined && after !== undefined ? "changed"
    : after !== undefined ? "added"
    : before !== undefined ? "removed"
    : "described";
  const label = row.location === "file" ? "Whole file" : row.location;
  return {
    id: `c${i + 1}`,
    mark,
    label,
    ...(mark !== "added" && before !== undefined ? { before } : {}),
    ...(mark !== "removed" && after !== undefined ? { after } : {}),
    text: describe,
    kind: row.kind,
  };
}

async function readSide(file: string): Promise<Buffer | null> {
  const b = await readFile(file);
  return b.length === 0 ? null : b;
}

/** The answer to `diff` for one app. Throws ConnectorError for a file the app could not open. */
export async function answerDiff(app: OfficeApp, beforeFile: string, afterFile: string, deps: ProgramDeps): Promise<OfficeDoc> {
  const doc = await answerApp(app, beforeFile, afterFile, deps);
  // What the after state would reach when opened, first among the caveats (moved from core's pictures-off card). Nothing is fetched.
  const reach = reachOf(await readSide(afterFile), `after${stagingExt(app, afterFile)}`);
  return reach.length === 0 ? doc : { ...doc, caveats: [...reach, ...doc.caveats] };
}

async function answerApp(app: OfficeApp, beforeFile: string, afterFile: string, deps: ProgramDeps): Promise<OfficeDoc> {
  // Excel answers with its own change list and one picture per change area (excel/answer.ts)
  if (app.key === "excel") return answerExcel(app, beforeFile, afterFile, deps);
  const now = deps.now ?? Date.now;
  const r = deps.reserves ?? RESERVES;
  const drawBy = now() + (deps.diffMs ?? DIFF_MS) - r.marginMs;
  const cleanupBy = drawBy - r.drawMs;
  const deadline = cleanupBy - r.cleanupMs;
  const [before, after] = await Promise.all([readSide(beforeFile), readSide(afterFile)]);
  if (before === null && after === null) return { spec: CHANGES_SPEC, changes: [], caveats: [] };
  for (const [side, bytes] of [["before", before], ["after", after]] as const) {
    if (bytes === null) continue;
    const p = preflight(bytes, `${side}${stagingExt(app, side === "before" ? beforeFile : afterFile)}`);
    if (p.action === "skip") throw new ConnectorError("unreadable-file", `The ${side} file is not a ${app.noun} ${app.name} can open: ${p.reason}`);
  }

  // The change list, from CoCheck's own reader, over private copies under each side's own ending (the reader picks its granularity by the name).
  const tmp = await mkdtemp(path.join(tmpdir(), "cocheck-office-diff-"));
  const files: Partial<Record<"before" | "after", string>> = {};
  let changes: Change[];
  let rows: LayerDiffRow[] = [];
  try {
    for (const [side, bytes] of [["before", before], ["after", after]] as const) {
      if (bytes === null) continue;
      files[side] = path.join(tmp, `${side}${stagingExt(app, side === "before" ? beforeFile : afterFile)}`);
      await writeFile(files[side]!, bytes, { mode: 0o600 });
    }
    const layer = layerFor(files.after ?? files.before!);
    rows = await layer.diff(files.before ?? null, files.after ?? null);
    changes = rows.map((r, i) => rowChange(r, layer.describe(r), i));
  } finally {
    for (const f of Object.values(files)) await unlink(f).catch(() => undefined);
    await rmdir(tmp).catch(() => undefined);
  }

  // the nothing-changed rule (spec v1.2): an empty list stands only when nothing differs that the reader does not list
  const unlisted = unlistedChange(app, before, after, changes.length);
  if (unlisted !== null) changes.push(unlisted);
  const doc: OfficeDoc = { spec: CHANGES_SPEC, changes, caveats: [] };
  // migration X1 (spec v1.2 `issues`): what the app would ask to repair in the after state; tolerated findings and a clean file give none
  const issues = structureIssues(after, `after${stagingExt(app, afterFile)}`);
  if (issues.length > 0) doc.issues = issues;
  // Identical bytes: nothing to show, and no reason to start Office.
  if (before !== null && after !== null && before.equals(after)) return doc;
  // A plain re-save (the rule above left the list empty: only saved-file details differ) has nothing to draw either, so the
  // answer is the bare empty list, which is how the page and the lane rule hear "saved again, nothing changed" (P3).
  if (changes.length === 0 && before !== null && after !== null) return doc;
  if (deps.driver === undefined) {
    doc.caveats.push(deps.noDriverWhy ?? NO_DRIVER_WHY(app));
    return doc;
  }
  const sides = (["before", "after"] as const).filter((s) => (s === "before" ? before : after) !== null).map((s) => ({ side: s, file: s === "before" ? beforeFile : afterFile, name: stageName(s === "before" ? beforeFile : afterFile, s, app) }));
  // the sides the app would not open (a prompt): said once, as a finding
  const refused = new Map<"before" | "after", { kind: "prompt" | "refused"; why: string }>();
  const here = sides.map((x) => x.side);
  const said = (): string[] => refusalWords(app, refused, here, true).caveats;
  // the finding at the spec's level (refusal.ts): a placeholder picture's status when the other side is pictured, the document's status when nothing is
  const withStatus = (d: OfficeDoc): OfficeDoc => {
    if (refused.size === 0) return d;
    const rw = refusalWords(app, refused, here, (d.pictures ?? []).length > 0);
    return { ...d, ...(rw.status !== undefined ? { status: rw.status } : {}), ...(rw.standIns.length > 0 ? { pictures: [...(d.pictures ?? []), ...rw.standIns] as unknown as Picture[] } : {}) };
  };
  // The deadlines are this program's own end (CoCheck stops it at diffMs). The engine runs one capture at a time (file-capture.ts), so within a review the lock is free when this starts.
  const printWin = await deps.windows?.().catch(() => null) ?? null;
  let job: Awaited<ReturnType<typeof officePdfs>>;
  try {
    job = await officePdfs(app, sides, { driver: deps.driver, lockPath: deps.lockPath, deadline, cleanupBy, ...(printWin !== null ? { windows: printWin.helper } : {}), ...(deps.promptTickMs !== undefined ? { promptTickMs: deps.promptTickMs } : {}), ...(deps.promptHoldMs !== undefined ? { promptHoldMs: deps.promptHoldMs } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.lockWaitMs !== undefined ? { lockWaitMs: deps.lockWaitMs } : {}), ...(deps.goneWaitMs !== undefined ? { goneWaitMs: deps.goneWaitMs } : {}), ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}) });
  } finally {
    await printWin?.close().catch(() => undefined);
  }
  if (job.pending === true) return { ...doc, pendingRetry: PENDING_RETRY, caveats: [job.why] };
  const pdfs: { before?: Buffer; after?: Buffer } = {};
  const failed: string[] = [];
  const machine: string[] = []; // a sentence about this computer, said once per file
  let hang: string | undefined;
  for (const s of job.sides) {
    if ("pdf" in s) pdfs[s.side] = s.pdf;
    else if ("caveat" in s) { if (!machine.includes(s.caveat)) machine.push(s.caveat); }
    else if ("prompt" in s && s.prompt === true) refused.set(s.side, { kind: "prompt", why: s.why });
    else if ("targets" in s) failed.push(`${s.side === "before" ? "Before" : "After"}: not drawn: printed by sheet, which this answer does not read.`);
    else {
      failed.push(`${s.side === "before" ? "Before" : "After"}: not drawn: ${s.why.replace(/\.$/, "")}.`);
      if ("hang" in s && s.hang === true) hang = s.why;
    }
  }
  const budget = ANSWER_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(doc));
  const { pictures, caveats } = await pdfPictures(pdfs, deps.pager, budget, app.name, { drawBy, now });
  doc.caveats.push(...machine, ...failed, ...caveats);
  // a prompt the print route saw: said once, in the app's terms (refusal.ts)
  doc.caveats.push(...said());
  if (job.sides.some((s) => "pdf" in s && s.commentsHidden === true)) doc.caveats.push("Word prints comments in a side pane, so comments are hidden on these pages");
  // Word only: boxes from where the paragraph's own words sit on the page; every other change stays in words
  if (app.key === "word" && pictures.length > 0) {
    const placed = await placeWordBoxes({ rows, ...(before !== null ? { before } : {}), ...(after !== null ? { after } : {}), pdfs, pager: deps.pager, pictures });
    for (const [i, p] of placed) {
      const c = doc.changes[i];
      if (c === undefined) continue;
      if (p.boxes !== undefined) c.boxes = p.boxes;
      else if (p.unplaced !== undefined) c.unplaced = p.unplaced;
    }
  }
  if (pictures.length > 0 && app.key === "powerpoint") addPptxBoxes({ ...(before ? { before } : {}), ...(after ? { after } : {}), rows, changes: doc.changes as unknown as BoxChange[], pictures, caveats: doc.caveats });
  if (pictures.length > 0) doc.pictures = pictures;
  else doc.status = { kind: hang !== undefined ? "hang" : "unavailable", evidence: hang ?? (machine[0] ?? failed[0] ?? caveats[0] ?? `${app.name} drew no pages`) };
  const out = withStatus(doc);
  await stampRenderedBy(out, app, deps.driver);
  return out;
}

/** On process exit, ends what the driver runs (Windows: its PowerShell host) synchronously, so nothing it started outlives this program. */
export function closeDriverOnExit(driver: Pick<OfficeExportDriver, "closeSync"> | undefined): void {
  if (driver?.closeSync === undefined) return;
  process.once("exit", () => {
    try { driver.closeSync?.(); } catch { /* best effort */ }
  });
}

/** Serves the JSON-lines protocol on `input`/`output`, one request at a time, until `input` ends. */
export function serve(app: OfficeApp, deps: ProgramDeps, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  // CoCheck stops a program past diffMs with SIGTERM, then SIGKILL: undo the job in flight (its launched pid, its staging) on the first.
  installSignalCleanup();
  closeDriverOnExit(deps.driver);
  const rl = createInterface({ input });
  let chain = Promise.resolve();
  const reply = (o: unknown): void => void output.write(`${JSON.stringify(o)}\n`);
  rl.on("line", (line) => {
    chain = chain.then(async () => {
      let msg: { id?: unknown; method?: unknown; params?: { before?: unknown; after?: unknown } };
      try {
        msg = JSON.parse(line.replace(/\r$/, ""));
      } catch {
        return;
      }
      const id = msg.id;
      try {
        if (msg.method === "hello") reply({ id, result: { spec: CONNECTOR_SPEC, level: levelFor(app), methods: ["diff"], nothingChanged: true } }); // opts into the nothing-changed rule; nothing-changed.ts keeps the promise
        else if (msg.method === "diff") {
          const { before, after } = msg.params ?? {};
          if (typeof before !== "string" || typeof after !== "string") throw new ConnectorError("bad-request", "diff needs before and after paths");
          reply({ id, result: await answerDiff(app, before, after, deps) });
        } else reply({ id, error: { code: "unknown-method", message: String(msg.method) } });
      } catch (error) {
        reply({ id, error: { code: error instanceof ConnectorError ? error.code : "failed", message: (error as Error).message } });
      }
    });
  });
  return new Promise((resolve) => rl.on("close", () => void chain.then(resolve)));
}
