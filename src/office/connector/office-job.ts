// One Office job: both sides of one file through the app's own PDF export. What the app is told lives in the platform driver, the order and the
// safety rules live here, so a fake driver in tests exercises exactly this code:
//   - one job at a time across processes (OwnerLock with a heartbeat; a job never waits past its own budget for another);
//   - the app already running means it is the person's: it is never touched, and the answer is "ask again later" (pendingRetry);
//   - a hidden launch; the job remembers the pid it started, and only that app is ever quit or killed; a launch whose process the driver
//     cannot verify as started by this launch is treated as the person's (pendingRetry, nothing more is sent to it);
//   - every step has a budget: exports end by `deadline`, cleanup by `cleanupBy` (an app this job launched that was asked to quit and is
//     still there at `cleanupBy` is stopped by its pid), so the program can answer inside the manifest's diffMs;
//   - SIGTERM or SIGINT (CoCheck stopping the program) kills only the pid this job launched and clears this job's staging, synchronously;
//   - at job start, holding the lock, staging folders left by dead jobs (exactly `CoCheck <uuid>`) are swept: plain files only, then rmdir;
//   - each side is staged in a new folder under the driver's stage root, its PDF named `~$<name>.pdf` (the one name the sandbox lets the
//     app write anywhere); the folder's files are unlinked and the empty folder removed in `finally`, never a recursive delete;
//   - a side that runs out of time stops the app this job launched (kill by its pid), and that side reads the app's `hangWhy` when the call ran its own full time, or
//     `budgetWhy` when the job's deadline cut it shorter (CoCheck's budget, not the app, ran out);
//   - an app that puts up a prompt instead of opening a copy (open-watch.ts) is stopped by its pid and nothing in the prompt is answered.
//   - at the end the app is quit only when this job launched it, it was not killed, and it holds zero documents.
import { randomUUID } from "node:crypto";
import { readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { OfficeOwner } from "./shared/owner.ts";
import { budgetWhy, promptWhy, type OfficeApp } from "./apps.ts";
import { PROMPT_CONFIRM_MS, watchedOpen } from "./open-watch.ts";
import { printCopy } from "./print-copy.ts";
import { helperPager, type PdfPager } from "./pictures.ts";

/** `caveat`: a sentence about this computer (no PDF printer, PowerShell restricted), said to the person as it is, once per file, not blamed on a side. */
export type ExportOutcome = { ok: true } | { ok: false; timedOut: boolean; why: string; caveat?: string };

/** One print job inside an open workbook: one sheet, printed alone, with its page setup replaced (Excel's region pictures). */
export interface ExportTarget {
  sheet: string;
  kind: "worksheet" | "chartsheet";
  /** The print area, A1 ranges joined by commas ($-absolute); absent for a chart sheet. */
  area?: string;
  zoom: number;
  landscape: boolean;
}
/** Per target: the PDF it wrote (and the print area Excel read back), or why it has none. */
export type TargetResult = { ok: true; readBack?: string } | { ok: false; why: string };
export type TargetsOutcome = { ok: true; results: TargetResult[] } | { ok: false; timedOut: boolean; why: string; caveat?: string };

/** Answers of the native helper are `{ok:true,...}` or `{ok:false,why}`. */
export type WindowAnswer<T> = ({ ok: true } & T) | { ok: false; why: string };
/** What the print route's prompt watch needs from the native helper (screen-macos.ts ScreenHelper satisfies it): an app's windows by pid, and nothing else. */
export interface WindowScreen {
  windows(pid: number): Promise<WindowAnswer<{ windows: { id: number; layer: number; bounds: { x: number; y: number; w: number; h: number }; onscreen: boolean; title: string }[] }>>;
}

/** What the shared job needs from one platform's Office. Every method is about `app` only. */
export interface OfficeExportDriver {
  /** How a saved PDF is opened to count its pages. Absent: the shipped pdfpages helper. A test seam too. */
  pager?: PdfPager;
  /** Where staged copies may go with no sandbox prompt (on the Mac, ~/Pictures). Each job makes a new folder inside it. */
  stageRoot(): string;
  /** The app's version as installed, read without starting or scripting the app (the Mac: its Info.plist); undefined when it cannot be read. Names the pictures' `renderedBy`. */
  appVersion?(app: OfficeApp): Promise<string | undefined>;
  /**
   * Called once per job while holding the lock, after sweepOwned and before the isRunning gate: a sentence when this computer cannot draw at all
   * (Windows: PowerShell restricted by policy, or its host cannot start), which ends the job with that sentence as the file's caveat; null to go on. Absent: go on.
   */
  preflight?(app: OfficeApp): Promise<string | null>;
  /** Whether the app has a running process at all (the gate; on the Mac, `pgrep -x`). */
  isRunning(app: OfficeApp): Promise<boolean>;
  /**
   * Starts the app hidden; the pid of the process this launch started, null when it did not start, or "not-ours" when a process was found
   * that cannot be verified as started by this launch (the person may have started the app in the gap): the job then touches nothing more.
   */
  launch(app: OfficeApp): Promise<number | null | "not-ours">;
  /** True once the app answers, false at the deadline (epoch ms). */
  ready(app: OfficeApp, deadline: number): Promise<boolean>;
  /** Opens `input` read-only (no link updates, no recents), saves its PDF at `pdf`, closes it by name saving nothing. */
  exportPdf(app: OfficeApp, input: string, pdf: string, timeoutMs: number): Promise<ExportOutcome>;
  /**
   * Opens `input` read-only, and for each target sets that sheet's page setup on the open copy, shows only that sheet, and saves the PDF
   * at `pdfs[i]`; closes it by name saving nothing. Optional: only Excel's driver has it.
   */
  exportTargets?(app: OfficeApp, input: string, targets: ExportTarget[], pdfs: string[], timeoutMs: number): Promise<TargetsOutcome>;
  /** The names (or full names) of the documents the app holds, or null when it did not answer in time (it is busy opening). The print route's prompt watch confirms with it. */
  openDocuments?(app: OfficeApp, timeoutMs: number): Promise<string[] | null>;
  /** The documents open in the app, or null when it did not answer. Asked only of an app this job launched. */
  documentCount(app: OfficeApp, timeoutMs: number): Promise<number | null>;
  /** Asks the app to quit, saving nothing. Asked only of an app this job launched, with zero documents. */
  quit(app: OfficeApp, timeoutMs: number): Promise<void>;
  /** Whether the process this job launched is still alive; nothing more is sent to an app whose process is gone. Absent: assumed alive. */
  alive?(pid: number): boolean;
  /**
   * Stops exactly this pid (the one `launch` returned). `signal` defaults to KILL; the cleanup asks TERM first for an app that ignored its quit.
   * With `startedAtMs`, the pid is signalled only while its start time still matches (a reused pid is someone else's process).
   */
  kill(pid: number, signal?: "TERM" | "KILL", startedAtMs?: number): void;
  /**
   * Called once per job while holding the lock, before the isRunning gate, with the lock's folder: clears what a dead connector left of this
   * app (Windows: the owned record beside the lock, and the hidden Office it names), and records this job's launch there. Absent: nothing to sweep.
   */
  sweepOwned?(app: OfficeApp, lockDir: string): Promise<void>;
  /** Ends whatever the driver itself runs for the job (Windows: its PowerShell host). Called once at job end, whatever the outcome. Absent: nothing to end. */
  close?(): Promise<void>;
  /** The same, synchronously: on process exit and in the signal cleanup. */
  closeSync?(): void;
}

export interface JobOptions {
  driver: OfficeExportDriver;
  /** The cross-process lock file. */
  lockPath: string;
  /** Epoch ms by which every export must be done (the program leaves room after it for cleanup and drawing). */
  deadline: number;
  /** Epoch ms by which cleanup (count, quit, wait for the app to go) must be done. Default deadline + 30 s. */
  cleanupBy?: number;
  /** Longest wait for another job's lock before answering "ask again". Default 15 s. */
  lockWaitMs?: number;
  /** Opens a saved PDF to count its pages; default: the driver's, then the shipped pdfpages helper. */
  pager?: PdfPager;
  /** The gap between the two size reads of a saved PDF, ms (default 200). */
  stableGapMs?: number;
  /** The wait between a PDF's two size reads (tests count it); default a real timer. */
  stableSleep?: (ms: number) => Promise<void>;
  /** Longest one side's export may take. Default 25 s (20 s per call, plus the open). */
  sideTimeoutMs?: number;
  /** How long to wait for a launched app to be gone after quit or kill. Default 10 s. */
  goneWaitMs?: number;
  /** Poll interval. Default 250 ms. */
  pollMs?: number;
  now?: () => number;
  /**
   * The print route's prompt watch: a screen helper used ONLY for `windows {pid}`, started with no Screen Recording check or request (titles may come back empty, and
   * the rule never reads them). Absent: no prompt verdict on the print route.
   */
  windows?: WindowScreen;
  /** Test seams for the open watch (open-watch.ts): how often the window list is read while an open is pending, and how long a stray window must stay. */
  promptTickMs?: number;
  promptHoldMs?: number;
}

export interface SideInput {
  side: "before" | "after";
  /** The bytes' file on disk. */
  file: string;
  /** The name to stage it under (the real base name, ending in the app's ending). */
  name: string;
  /** Print these targets (one PDF each) instead of one PDF of the whole file. */
  targets?: ExportTarget[];
}

export type TargetPdf = { pdf: Buffer; readBack?: string } | { why: string };
export type SidePdf =
  /** `commentsHidden`: Word printed a copy with the file's comments taken out, so the page says so. */
  | { side: "before" | "after"; pdf: Buffer; commentsHidden?: true }
  | { side: "before" | "after"; targets: TargetPdf[] }
  /** A person's Excel appeared before this entry's launch: nothing was sent to it. */
  | { side: "before" | "after"; why: string; pending: true }
  | { side: "before" | "after"; why: string; hang?: true }
  /** The app put up a prompt while the open of this side was pending (open-watch.ts); `why` is promptWhy. The app was stopped by its pid. */
  | { side: "before" | "after"; why: string; prompt: true }
  /** The driver says this computer cannot draw (`caveat` is the whole plain sentence, the same on every side): said once per file, never "Before: not drawn: ...". */
  | { side: "before" | "after"; why: string; caveat: string };

export type JobResult = { pending: true; why: string } | { pending?: false; sides: SidePdf[] };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Removes the files of a folder this job made, then the empty folder. Never recursive: a subfolder (which the job never makes) stays. */
export async function clearStage(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const n of names) await unlink(path.join(dir, n)).catch(() => undefined);
  await rmdir(dir).catch(() => undefined);
}

/** The one staging folder name a job makes: `CoCheck <uuid>`. Nothing else under the stage root is ever touched. */
const STAGE_NAME = /^CoCheck [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Removes staging folders left by jobs that died (killed before their `finally`). Called only while holding the cross-process lock, so no
 * live job is staging. Only folders named exactly `CoCheck <uuid>`; inside, only plain files are unlinked; then rmdir, which fails (and
 * the folder stays) when anything else is left. Never recursive.
 */
export async function sweepStale(root: string): Promise<void> {
  for (const n of await readdir(root).catch(() => [] as string[])) {
    if (!STAGE_NAME.test(n)) continue;
    const dir = path.join(root, n);
    if (!(await lstat(dir).catch(() => null))?.isDirectory()) continue;
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const p = path.join(dir, f);
      if ((await lstat(p).catch(() => null))?.isFile()) await unlink(p).catch(() => undefined);
    }
    await rmdir(dir).catch(() => undefined);
  }
}

/** What a signal handler must undo for the job in flight in this process: the pid it launched and the staging folders it holds. */
const live: { driver: OfficeExportDriver | null; pid: number | null; started: number | undefined; dirs: Set<string> } = { driver: null, pid: null, started: undefined, dirs: new Set() };
let liveOwner: OfficeOwner | null = null;

/** Synchronously stops the pid this process's job launched (if any) and clears its staging folders (files, then rmdir; never recursive). */
export function cleanupLiveJobSync(): void {
  if (live.pid !== null && live.driver !== null) {
    // The program is being stopped and this runs synchronously: there is no grace period to wait out, so this is the one KILL that is not for a hang or a failed hide.
    try { live.driver.kill(live.pid, "KILL", live.started); } catch { /* gone, or refused */ }
    live.pid = null;
  }
  try { live.driver?.closeSync?.(); } catch { /* best effort */ }
  for (const dir of live.dirs) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* gone */ }
    for (const n of names) try { unlinkSync(path.join(dir, n)); } catch { /* gone */ }
    try { rmdirSync(dir); } catch { /* gone, or not empty */ }
  }
  live.dirs.clear();
  try { liveOwner?.release(); } catch { /* best effort */ }
  liveOwner = null;
}

let signalsInstalled = false;
/** On SIGTERM or SIGINT (CoCheck stopping the program at diffMs), undo this process's job, then exit. Installed once per process. */
export function installSignalCleanup(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    process.on(sig, () => {
      cleanupLiveJobSync();
      process.exit(code);
    });
  }
}

async function takeLock(lockPath: string, until: number, pollMs: number, now: () => number): Promise<OfficeOwner | null> {
  const owner = new OfficeOwner({ path: lockPath, staleMs: 15_000, heartbeatMs: 5_000 });
  for (;;) {
    if (owner.tryBecomeOwner()) return owner;
    if (now() >= until) return null;
    await sleep(pollMs);
  }
}

/** Waits for the app to be gone; true when it is (a check that cannot answer counts as gone: nothing more is done to it then). */
async function waitGone(driver: OfficeExportDriver, app: OfficeApp, until: number, pollMs: number, now: () => number): Promise<boolean> {
  for (;;) {
    if (!(await driver.isRunning(app).catch(() => false))) return true;
    if (now() >= until) return false;
    await sleep(pollMs);
  }
}

const notSavedWhy = (app: OfficeApp): string => `not drawn: ${app.name} reported the save, but no PDF appeared (tried twice)`;
/** Word's answer when the save call itself fails with -1708 (the same single retry as a save that left no file). */
const word1708 = (why: string): boolean => /-1708/.test(why);

/**
 * A saved PDF counts only when it is non-empty, the same size on two reads a short gap apart (inside the deadline), and opens as a PDF
 * with at least one page (the pager the connector already uses). The bytes read, or null.
 */
async function settledPdf(file: string, o: JobOptions, d: OfficeExportDriver, now: () => number): Promise<Buffer | null> {
  return (await settledPdfs([file], o, d, now))[0] ?? null;
}

/**
 * The same proof for every file of one save call, with ONE gap wait: each file's first size read, then one `stableGapMs` wait, then each file's
 * second read (so every file still gets two reads at least the gap apart); the page check runs per file. One answer per file, in order.
 */
async function settledPdfs(files: string[], o: JobOptions, d: OfficeExportDriver, now: () => number): Promise<(Buffer | null)[]> {
  const size = async (file: string): Promise<number> => (await stat(file).catch(() => null))?.size ?? 0;
  const first = await Promise.all(files.map(size));
  const out: (Buffer | null)[] = files.map(() => null);
  if (!first.some((a) => a > 0)) return out;
  const gap = o.stableGapMs ?? 200;
  if (now() + gap > o.deadline) return out;
  await (o.stableSleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(gap);
  for (let i = 0; i < files.length; i++) {
    const a = first[i]!;
    if (a === 0 || (await size(files[i]!)) !== a) continue;
    const buf = await readFile(files[i]!).catch(() => null);
    if (buf === null || buf.length !== a) continue;
    const pages = await (o.pager ?? d.pager ?? helperPager).pages(buf).catch(() => null);
    out[i] = pages !== null && pages.length >= 1 ? buf : null;
  }
  return out;
}

/** Office's PDF of each side, or why there is none; `pending` when the app is the person's (already running) or another job holds Office. */
export async function officePdfs(app: OfficeApp, sides: SideInput[], o: JobOptions): Promise<JobResult> {
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? 100;
  const d = o.driver;
  const owner = await takeLock(o.lockPath, Math.min(o.deadline, now() + (o.lockWaitMs ?? 15_000)), pollMs, now);
  if (owner === null) return { pending: true, why: `another CoCheck job is using ${app.name}, so its pages will be drawn when it is done` };
  let pid: number | null = null;
  let killed = false;
  const cleanupBy = o.cleanupBy ?? o.deadline + 30_000;
  live.driver = d;
  liveOwner = owner;
  try {
    await sweepStale(d.stageRoot());
    await d.sweepOwned?.(app, path.dirname(o.lockPath)).catch(() => undefined);
    const cannot = await d.preflight?.(app).catch(() => null);
    if (cannot !== null && cannot !== undefined) return { sides: sides.map((s) => ({ side: s.side, why: cannot, caveat: cannot })) };
    const personsWhy = `${app.name} is open, so CoCheck will draw its pages once it is closed`;
    // The gate. An app that is already running is the person's: no tell, no open, no quit, nothing.
    if (await d.isRunning(app)) return { pending: true, why: personsWhy };
    const launched = await d.launch(app);
    // A process this launch cannot prove it started is the person's too: nothing more is sent to it.
    if (launched === "not-ours") return { pending: true, why: personsWhy };
    pid = launched;
    live.pid = pid;
    if (pid === null) return { sides: sides.map((s) => ({ side: s.side, why: `${app.name} did not start` })) };
    if (!(await d.ready(app, Math.min(o.deadline, now() + 20_000)))) return { sides: sides.map((s) => ({ side: s.side, why: `${app.name} did not answer after starting` })) };
    const out: SidePdf[] = [];
    const PROMPT = Symbol("prompt");
    // While the app's open of the staged copy is pending (inside the export call), the open-watch rule runs (windows {pid} only; titles are never needed). A confirmed
    // prompt ends the side at once; the app is stopped by its pid and nothing in the prompt is answered.
    const guarded = async <T>(call: () => Promise<T>, input: string): Promise<T | typeof PROMPT> => {
      const wl = o.windows, od = d.openDocuments;
      if (wl === undefined || od === undefined || pid === null) return call();
      const first = await wl.windows(pid).catch(() => ({ ok: false as const, why: "no answer" }));
      if (!first.ok) return call();
      const base = path.parse(input).name;
      const holds = (names: string[]): boolean => names.some((n) => n === input || path.parse(n.split(/[/:]/).pop() ?? "").name === base);
      const confirm = async (t: number): Promise<"absent" | "present" | "no-answer"> => { const l = await od.call(d, app, t).catch(() => null); return l === null ? "no-answer" : holds(l) ? "present" : "absent"; };
      const w = await watchedOpen(call(), { helper: wl, pid, before: new Set(first.windows.map((q) => q.id)), names: [base], now, confirm, confirmMs: Math.min(PROMPT_CONFIRM_MS, Math.max(100, o.deadline - now())), ...(o.promptTickMs !== undefined ? { tickMs: o.promptTickMs } : {}), ...(o.promptHoldMs !== undefined ? { holdMs: o.promptHoldMs } : {}) });
      if ("prompt" in w) { d.kill(pid); killed = true; return PROMPT; }
      return w.done;
    };
    for (const s of sides) {
      if (killed) {
        out.push({ side: s.side, why: `not drawn: ${app.name} was stopped on the other side` });
        continue;
      }
      // the process this job launched is gone: nothing more is sent, so a staged copy never reaches a copy the person may have started since
      if (!(d.alive?.(pid) ?? true)) {
        out.push({ side: s.side, why: `not drawn: ${app.name} closed before this side` });
        continue;
      }
      const left = o.deadline - now();
      if (left <= 1_000) {
        out.push({ side: s.side, why: `not drawn: CoCheck's time for pictures ran out before ${app.name} reached this side` });
        continue;
      }
      const dir = path.join(d.stageRoot(), `CoCheck ${randomUUID()}`);
      live.dirs.add(dir);
      try {
        await mkdir(dir, { mode: 0o700 });
        const input = path.join(dir, s.name);
        const pdf = path.join(dir, `~$${path.parse(s.name).name}.pdf`);
        // The app prints CoCheck's own copy, rewritten for the print (Excel: paper size and print-errors-as out of each pageSetup; Word: comments out),
        // or the plain copy when there is nothing to rewrite or it cannot be done safely. A failure on a rewritten copy never blames the agent's file.
        const bytes = await readFile(s.file).catch(() => null);
        const pc = bytes === null ? null : printCopy(app.key, bytes);
        if (pc !== null) await writeFile(input, pc.bytes, { mode: 0o600 });
        else await copyFile(s.file, input);
        const blame = (why: string): string => (pc === null ? why : `${why} (this was CoCheck's own copy of the ${app.noun}, made for printing with ${app.key === "word" ? "comments" : "paper size and print-error settings"} taken out)`);
        if (s.targets !== undefined) {
          if (d.exportTargets === undefined) { out.push({ side: s.side, why: `${app.name} cannot print sheets one by one here` }); continue; }
          const pdfs = s.targets.map((_, i) => path.join(dir, `~$${path.parse(s.name).name}-${i + 1}.pdf`));
          const cut = left < (o.sideTimeoutMs ?? 25_000);
          const r0 = await guarded(() => d.exportTargets!(app, input, s.targets!, pdfs, Math.min(left, o.sideTimeoutMs ?? 25_000)), input);
          if (r0 === PROMPT) { out.push({ side: s.side, why: promptWhy(app), prompt: true }); continue; }
          const r = r0;
          if (!r.ok) {
            if (r.timedOut) { d.kill(pid); killed = true; out.push(cut ? { side: s.side, why: budgetWhy(app) } : { side: s.side, why: app.hangWhy, hang: true }); }
            else if (r.caveat !== undefined) out.push({ side: s.side, why: r.why, caveat: r.caveat });
            else out.push({ side: s.side, why: blame(r.why) });
            continue;
          }
          const got: TargetPdf[] = [];
          const bad: number[] = [];
          const okIdx: number[] = [];
          for (let i = 0; i < pdfs.length; i++) {
            const res = r.results[i];
            if (res === undefined || !res.ok) got[i] = { why: res === undefined ? `${app.name} did not answer for this sheet` : blame(res.why) };
            else okIdx[okIdx.length] = i;
          }
          const settled = await settledPdfs(okIdx.map((i) => pdfs[i]!), o, d, now);
          for (const [k, i] of okIdx.entries()) {
            const res = r.results[i];
            const pdf = settled[k] ?? null;
            if (pdf === null || res === undefined || !res.ok) bad[bad.length] = i;
            else got[i] = { pdf, ...(res.readBack !== undefined ? { readBack: res.readBack } : {}) };
          }
          // a save the file does not prove is asked for once more (only those targets), inside the deadline, never after a timeout or kill
          if (bad.length > 0) {
            const left2 = o.deadline - now();
            if (left2 <= 1_000) for (const i of bad) got[i] = { why: budgetWhy(app) };
            else {
              for (const i of bad) await unlink(pdfs[i]!).catch(() => undefined);
              const r2g = await guarded(() => d.exportTargets!(app, input, bad.map((i) => s.targets![i]!), bad.map((i) => pdfs[i]!), Math.min(left2, o.sideTimeoutMs ?? 25_000)), input);
              if (r2g === PROMPT) { out.push({ side: s.side, why: promptWhy(app), prompt: true }); continue; }
              const r2 = r2g;
              if (!r2.ok && r2.timedOut) {
                d.kill(pid); killed = true;
                for (const i of bad) got[i] = { why: left2 < (o.sideTimeoutMs ?? 25_000) ? budgetWhy(app) : app.hangWhy };
              } else {
                const okK = bad.map((_, k) => k).filter((k) => r2.ok && r2.results[k]?.ok === true);
                const settled2 = await settledPdfs(okK.map((k) => pdfs[bad[k]!]!), o, d, now);
                for (const [k, i] of bad.entries()) {
                  const res = r2.ok ? r2.results[k] : undefined;
                  const pdf = res !== undefined && res.ok ? (settled2[okK.indexOf(k)] ?? null) : null;
                  got[i] = pdf !== null && res !== undefined && res.ok ? { pdf, ...(res.readBack !== undefined ? { readBack: res.readBack } : {}) } : { why: notSavedWhy(app) };
                }
              }
            }
          }
          out.push({ side: s.side, targets: got });
          continue;
        }
        const cut = left < (o.sideTimeoutMs ?? 25_000);
        const r0 = await guarded(() => d.exportPdf(app, input, pdf, Math.min(left, o.sideTimeoutMs ?? 25_000)), input);
        if (r0 === PROMPT) { out.push({ side: s.side, why: promptWhy(app), prompt: true }); continue; }
        const r = r0;
        const hung = (): SidePdf => { d.kill(pid!); killed = true; return cut ? { side: s.side, why: budgetWhy(app) } : { side: s.side, why: app.hangWhy, hang: true }; };
        if (!r.ok && r.caveat !== undefined) { out.push({ side: s.side, why: r.why, caveat: r.caveat }); continue; }
        if (!r.ok && r.timedOut) { out.push(hung()); continue; }
        if (!r.ok && !word1708(r.why)) { out.push({ side: s.side, why: blame(r.why) }); continue; }
        // A save the app did not finish can still answer "ok"; the file is the only proof. Not proven (or Word's -1708): asked once more.
        let got = r.ok ? await settledPdf(pdf, o, d, now) : null;
        if (got === null) {
          const left2 = o.deadline - now();
          if (left2 <= 1_000) { out.push({ side: s.side, why: budgetWhy(app) }); continue; }
          await unlink(pdf).catch(() => undefined);
          const cut2 = left2 < (o.sideTimeoutMs ?? 25_000);
          const r2g = await guarded(() => d.exportPdf(app, input, pdf, Math.min(left2, o.sideTimeoutMs ?? 25_000)), input);
          if (r2g === PROMPT) { out.push({ side: s.side, why: promptWhy(app), prompt: true }); continue; }
          const r2 = r2g;
          if (!r2.ok && r2.timedOut) { d.kill(pid); killed = true; out.push(cut2 ? { side: s.side, why: budgetWhy(app) } : { side: s.side, why: app.hangWhy, hang: true }); continue; }
          if (!r2.ok && !word1708(r2.why)) { out.push({ side: s.side, why: blame(r2.why) }); continue; }
          got = r2.ok ? await settledPdf(pdf, o, d, now) : null;
        }
        out.push(got !== null ? { side: s.side, pdf: got, ...(pc?.commentsHidden === true ? { commentsHidden: true as const } : {}) } : { side: s.side, why: notSavedWhy(app) });
      } catch (error) {
        out.push({ side: s.side, why: `${app.name} could not be asked: ${(error as Error).message}` });
      } finally {
        await clearStage(dir);
        live.dirs.delete(dir);
      }
    }
    return { sides: out };
  } finally {
    try {
      const step = (): number => Math.min(10_000, cleanupBy - now());
      const goneBy = (): number => Math.min(cleanupBy, now() + (o.goneWaitMs ?? 10_000));
      // Asked only while the process this job launched is still alive: once it is gone, nothing more is sent (a late tell would start a copy).
      if (pid !== null && !killed && step() > 0 && (d.alive?.(pid) ?? true)) {
        const n = await d.documentCount(app, step()).catch(() => null);
        if (n === 0) {
          if (step() > 0 && (d.alive?.(pid) ?? true)) await d.quit(app, step()).catch(() => undefined);
          // Zero documents, asked to quit, still here at its time: the app this job launched is stopped by its pid.
          if (!(await waitGone(d, app, goneBy(), pollMs, now))) d.kill(pid);
        }
      } else if (pid !== null && killed) await waitGone(d, app, goneBy(), pollMs, now);
    } finally {
      live.pid = null;
      live.driver = null;
      liveOwner = null;
      owner.release();
      // the driver's own helper (Windows: the PowerShell host) ends with the job, never left running after it
      await d.close?.().catch(() => undefined);
    }
  }
}
