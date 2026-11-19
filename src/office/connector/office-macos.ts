import { execFile, execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { OfficeApp, OfficeAppKey } from "./apps.ts";
import type { ExportOutcome, ExportTarget, OfficeExportDriver, TargetResult, TargetsOutcome } from "./office-job.ts";
import { macAppVersion } from "../../platform/index.ts";
import { guard, parseLstartUtc } from "./mac-guard.ts";
import { SCREEN_HELPER } from "./screen-macos.ts";

/**
 * The Mac half of the built-in Office connectors: what Excel, Word and PowerPoint are told, through AppleScript, for one PDF export. The
 * order and the safety rules (gate, lock, quit only what the job launched, staging cleanup) are in src/office/connector/office-job.ts.
 *
 * Never used here, on purpose: `set display alerts` and `screen updating` (app-wide: they would reach the person's own documents),
 * `calculate full rebuild` (the picture is the file as saved), `close every`, `killall`, and any script that hides, shows or activates the app. Every document is closed by name, saving no.
 * Every real call checks the test guard first: under the test bootstrap (COCHECK_TEST_NO_OFFICE=1, which the manifests pass through
 * `permissions.env`) the driver throws instead of reaching an app.
 */

const CALL_S = 20;
/** An AppleScript string literal. */
export const asLiteral = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** What an app calls its open files, in its own dictionary. */
const DOCS: Record<OfficeAppKey, string> = { excel: "workbooks", word: "documents", powerpoint: "presentations" };

/**
 * One export as one AppleScript program: open read-only, save the PDF, close by name saving no. Answers "OK", or
 * "ERR<tab>step<tab>number<tab>message". TB is set outside the tell block: inside Excel's, "tab" is Excel's own term (observed on Excel).
 */
export function exportScript(key: OfficeAppKey, input: string, pdf: string, callS: number = CALL_S): string {
  const t = `with timeout of ${callS} seconds`;
  const err = (step: string): string => `return "ERR" & TB & "${step}" & TB & n & TB & e`;
  const pdfName = asLiteral(path.basename(pdf));
  if (key === "excel")
    return `set TB to tab
tell application "Microsoft Excel"
	try
		${t}
			set wb to open workbook workbook file name ${asLiteral(input)} update links do not update links read only true add to mru false
			set dn to name of wb
		end timeout
	on error e number n
		${err("open")}
	end try
	try
		${t}
			save workbook as workbook dn filename ${asLiteral(pdf)} file format PDF file format
		end timeout
	on error e number n
		try
			${t}
				close workbook dn saving no
			end timeout
		end try
		${err("pdf")}
	end try
	try
		${t}
			close workbook dn saving no
		end timeout
	on error
		-- a save-as can rename the workbook inside Excel (seen live): close it under the PDF's name
		try
			${t}
				close workbook ${pdfName} saving no
			end timeout
		end try
	end try
end tell
return "OK"`;
  // Word and PowerPoint: the document is found by its full name equal to the staged path (Word's dictionary: "full name ... in HFS path
  // style"; both forms are matched), never as "the active one", and exported and closed through that reference only. Not found: the side
  // fails and nothing is closed.
  const inP = asLiteral(input);
  const app = key === "word" ? "Microsoft Word" : "Microsoft PowerPoint";
  const openCmd = key === "word" ? `open file name inP read only true add to recent files false confirm conversions false` : `open (POSIX file inP)`;
  const cls = key === "word" ? "document" : "presentation";
  // the found document is then named by its name, as a working recipe needs: a "whose" reference handed to PowerPoint's save fails with -1750,
  // and closing through it then fails too, leaving the app holding the file
  const saveCmd = key === "word" ? `save as ${cls} dn file name ${asLiteral(pdf)} file format format PDF` : `save ${cls} dn in (POSIX file ${asLiteral(pdf)}) as save as PDF`;
  return `set TB to tab
set inP to ${inP}
set inH to (POSIX file inP) as text
tell application "${app}"
	try
		${t}
			${openCmd}
		end timeout
	on error e number n
		${err("open")}
	end try
	try
		${t}
			set dn to name of (first ${cls} whose full name is inH or full name is inP)
		end timeout
	on error e number n
		${err("find")}
	end try
	try
		${t}
			${saveCmd}
		end timeout
	on error e number n
		try
			${t}
				close ${cls} dn saving no
			end timeout
		end try
		${err("pdf")}
	end try
	try
		${t}
			close ${cls} dn saving no
		end timeout
	end try
end tell
return "OK"`;
}

/**
 * Excel's region pictures: one AppleScript program that opens the staged copy read-only and, per target, replaces that sheet's page setup
 * on the open copy (print titles cleared, the print area, zoom, gridlines and headings on, the six header and footer fields cleared,
 * 0.25 in margins, orientation, manual page breaks reset; a chart sheet: orientation, headers and footers, margins), shows only that sheet
 * (the target first, then the others hidden: Excel refuses to hide the last visible sheet), saves the PDF, and finally closes the copy by
 * name saving no. The copy is thrown away; nothing reaches the person's file. Observed on real Excel: every setter reads back, `save as sheet` exports the whole workbook (so hiding is the single-sheet route), touching print
 * ranges are merged by Excel at set time. Answers one line per target, "OK<tab>i<tab>read-back print area" or "ERR<tab>i<tab>n<tab>message",
 * or "ERR<tab>open<tab>n<tab>message".
 */
const PRINT_FLAGS = ["black and white", "center horizontally", "center vertically", "draft"];

export function targetsScript(input: string, targets: ExportTarget[], pdfs: string[], callS: number = CALL_S): string {
  const t = `with timeout of ${callS} seconds`;
  const lines: string[] = [];
  targets.forEach((g, i) => {
    const nm = asLiteral(g.sheet);
    const ref = g.kind === "chartsheet" ? `chart sheet ${nm} of wb` : `worksheet ${nm} of wb`;
    const zoom = Math.max(10, Math.min(400, Math.round(g.zoom)));
    // zoom goes after "reset all page breaks": the reset puts the zoom back to 100. The flags are the file's own
    // print settings that would otherwise leak into the picture; each is set false and read back, as is the zoom, just before the save.
    const setup = g.kind === "chartsheet"
      ? `set page orientation of ps to landscape`
      : `set print title rows of ps to ""
				set print title columns of ps to ""
				set print area of ps to ${asLiteral(g.area ?? "")}
				set print gridlines of ps to true
				set print headings of ps to true
				set page orientation of ps to ${g.landscape ? "landscape" : "portrait"}
				reset all page breaks sh
				set zoom of ps to ${zoom}
				set black and white of ps to false
				set center horizontally of ps to false
				set center vertically of ps to false
				set draft of ps to false`;
    const check = g.kind === "chartsheet" ? "" : `set zb to zoom of ps
			if zb is not ${zoom} then error "the print zoom read back as " & (zb as text) & ", not ${zoom}" number 9001
			${PRINT_FLAGS.map((f) => `set fb to ${f} of ps
			if fb is not false then error "the print setting ${f} read back as " & (fb as text) & ", not false" number 9002`).join("\n\t\t\t")}
			`;
    lines.push(`	try
		${t}
			set sh to ${ref}
			set ps to page setup object of sh
			${setup}
			set left header of ps to ""
			set center header of ps to ""
			set right header of ps to ""
			set left footer of ps to ""
			set center footer of ps to ""
			set right footer of ps to ""
			set left margin of ps to 18
			set right margin of ps to 18
			set top margin of ps to 18
			set bottom margin of ps to 18
			set header margin of ps to 0
			set footer margin of ps to 0
			set visible of sh to sheet visible
			repeat with s in (get every sheet of wb)
				if (name of s) is not ${nm} and (visible of s) is sheet visible then set visible of s to sheet hidden
			end repeat
			${check}save workbook as wb filename ${asLiteral(pdfs[i]!)} file format PDF file format
			${g.kind === "chartsheet" ? `set rb to ""` : `set rb to (print area of ps) as text`}
		end timeout
		set out to out & "OK" & TB & ${i} & TB & rb & LF
	on error e number n
		set out to out & "ERR" & TB & ${i} & TB & n & TB & e & LF
	end try
	-- every sheet that was shown is shown again before the next target
	try
		${t}
			repeat with v in shown
				set visible of sheet (v as text) of wb to sheet visible
			end repeat
		end timeout
	end try`);
  });
  return `set TB to tab
set LF to linefeed
set inP to ${asLiteral(input)}
set inH to (POSIX file inP) as text
set out to ""
tell application "Microsoft Excel"
	try
		${t}
			set wb to open workbook workbook file name ${asLiteral(input)} update links do not update links read only true add to mru false
			set dn to name of wb
			set shown to {}
			repeat with s in (get every sheet of wb)
				if (visible of s) is sheet visible then set end of shown to (name of s)
			end repeat
		end timeout
	on error e number n
		return "ERR" & TB & "open" & TB & n & TB & e
	end try
${lines.join("\n")}
	try
		${t}
			close workbook dn saving no
		end timeout
	on error
		-- by the exact staged path, in both forms Excel's full name can take; never a substring of a name
		try
			${t}
				repeat with w in (get every workbook)
					if (full name of w) is inP or (full name of w) is inH then
						close w saving no
						exit repeat
					end if
				end repeat
			end timeout
		end try
	end try
end tell
return out`;
}

/** The answer of `targetsScript`, read line by line; a target with no line failed. */
export function readTargets(stdout: string, count: number, appName: string): TargetsOutcome {
  const lines = stdout.split(/\r?\n/).filter((l) => l !== "");
  if (lines[0]?.startsWith(`ERR\topen\t`)) return { ok: false, timedOut: false, why: `${appName} could not open this file (it answered error ${lines[0].split("\t")[2]})` };
  const results: TargetResult[] = Array.from({ length: count }, (): TargetResult => ({ ok: false, why: `${appName} did not print this sheet` }));
  for (const l of lines) {
    const f = l.split("\t");
    const i = Number(f[1]);
    if (!Number.isInteger(i) || i < 0 || i >= count) continue;
    if (f[0] === "OK") results[i] = { ok: true, ...(f[2] ? { readBack: f[2] } : {}) };
    else if (f[0] === "ERR") results[i] = { ok: false, why: `${appName} could not set up this sheet for printing (error ${f[2]}${f[3] ? `: ${f[3]}` : ""})` };
  }
  return { ok: true, results };
}

/**
 * How many documents the app holds. Asked only of an app this job launched: the blank document a hidden launch may open (no path,
 * unmodified; Excel's seen on a real run, Word's and PowerPoint's by the same rule) is closed by name first, saving no, or
 * the app could never be quit. A document with a path, or with changes, is never closed here.
 */
export function countScript(key: OfficeAppKey): string {
  const t = `with timeout of ${CALL_S} seconds`;
  const cls = DOCS[key].slice(0, -1);
  return `tell application "${key === "excel" ? "Microsoft Excel" : key === "word" ? "Microsoft Word" : "Microsoft PowerPoint"}"
	${t}
		repeat with nm in (get name of every ${cls} whose path is "" and saved is true)
			close ${cls} (nm as text) saving no
		end repeat
		count of ${DOCS[key]}
	end timeout
end tell`;
}

export const quitScript = (app: OfficeApp): string => `tell application ${asLiteral(app.name)} to with timeout of ${CALL_S} seconds
	quit saving no
end timeout`;

export type Ran = { ok: boolean; stdout: string; stderr: string; timedOut: boolean };
/** Answer of a script that found the app not running: it sent the app nothing (and so could not have started it). */
export const GONE = "GONE";
/**
 * Every script runs behind its own "is it running" gate, inside AppleScript: a tell to an app that is not running starts it, so a script
 * that comes late (after a quit, or after the app this job launched died) would start a new copy that no job owns (seen live:
 * a PowerPoint appeared a second after a run ended). `application "X" is running` asks the system, never the app.
 */
export const gated = (appName: string, script: string): string => `if application ${asLiteral(appName)} is not running then return "${GONE}"\n${script}`;

/** Optional trace of every call, for live diagnosis: COCHECK_OFFICE_TRACE names a file the lines are appended to. Never script text. */
function trace(line: string): void {
  const f = process.env.COCHECK_OFFICE_TRACE;
  if (!f) return;
  try { appendFileSync(f, `${new Date().toISOString()} pid=${process.pid} ${line}\n`); } catch { /* best effort */ }
}

export function ask(appName: string, step: string, script: string, timeoutMs: number): Promise<Ran> {
  guard();
  trace(`ask ${step} start`);
  return new Promise((resolve) => {
    execFile("osascript", ["-e", gated(appName, script)], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const r = { ok: error === null, stdout: String(stdout).trim(), stderr: String(stderr), timedOut: error !== null && (error as { killed?: boolean }).killed === true };
      trace(`ask ${step} end ok=${r.ok} timedOut=${r.timedOut} out=${r.stdout.slice(0, 40).replace(/\s+/g, " ")}`);
      resolve(r);
    });
  });
}

/** This user's processes named exactly `name` (another user's app is never this job's, nor counted as running for it). */
function pids(name: string): Promise<number[]> {
  const uid = process.getuid?.() ?? 0;
  return new Promise((resolve) =>
    execFile("pgrep", ["-U", String(uid), "-x", name], { timeout: 5_000 }, (error, stdout) => resolve(error ? [] : String(stdout).split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0))));
}

/** When `pid` started, epoch ms (whole seconds), or null. Locale and time zone pinned in the call (a value two processes compare is environment-independent). */
export function startedAt(pid: number): Promise<number | null> {
  return new Promise((resolve) =>
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }, (error, stdout) => resolve(error ? null : parseLstartUtc(String(stdout)))));
}

/** When `pid` started, epoch ms with its fraction, from the kernel through the screen helper's read-only `--start-of`; null when the helper is not built or the pid cannot be read. */
export function startedAtExact(pid: number): Promise<number | null> {
  return new Promise((resolve) =>
    execFile(SCREEN_HELPER, ["--start-of", String(pid)], { timeout: 5_000 }, (error, stdout) => {
      const m = error ? null : /^(\d+)\.(\d{6})\s*$/.exec(String(stdout));
      resolve(m === null ? null : Number(m[1]) * 1000 + Number(m[2]) / 1000);
    }));
}

/** Synchronous `startedAt` (the kill path is sync): `ps -o lstart=` with LC_ALL=C and TZ=UTC, epoch ms, or null. */
function startedAtNow(pid: number): number | null {
  try {
    return parseLstartUtc(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000, encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }));
  } catch { return null; }
}

/** What the app calls one open document, for the print route's prompt watch: Excel's workbook name, Word's and PowerPoint's full name. One a line. */
export function docListScript(app: OfficeApp, callS: number): string {
  const cls = app.key === "excel" ? "workbook" : app.key === "word" ? "document" : "presentation";
  const prop = app.key === "excel" ? "name" : "full name";
  return `set LF to linefeed
set o to ""
tell application ${asLiteral(app.name)}
	with timeout of ${Math.max(1, Math.floor(callS))} seconds
		repeat with d in (get every ${cls})
			set o to o & (${prop} of d) & LF
		end repeat
	end timeout
end tell
return o`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The `open` arguments for a fresh, background launch. Word gets `-NSRequiresAquaSystemAppearance YES` in its argument domain (found by trying it live): that one process draws in
 * the light appearance, so a dark-theme Mac still gets the file's own white page; nothing is written to Word's or the system's preferences, and a Word the person starts later is untouched.
 * The arguments reach only a new process, and every launch here is fresh (the gate refuses a running app).
 */
export const launchArgs = (app: { key: string; name: string }): string[] => ["-g", "-j", "-a", app.name, ...(app.key === "word" ? ["--args", "-NSRequiresAquaSystemAppearance", "YES"] : [])];

/** The process and clock reads `launch` makes, so a test can supply them (the defaults are the real ones). */
export interface LaunchPrims {
  /** This user's pids named exactly `name`. */
  pids(name: string): Promise<number[]>;
  /** A pid's start time from the kernel, epoch ms with its fraction (the screen helper's `--start-of`); null when the helper is not built or the pid cannot be read. */
  startedAtExact(pid: number): Promise<number | null>;
  /** A pid's start time from `ps`, epoch ms in whole seconds, or null. */
  startedAt(pid: number): Promise<number | null>;
  /** Runs `open` with these arguments; true when it succeeded. */
  open(args: string[]): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
}
const REAL_LAUNCH: LaunchPrims = {
  pids,
  startedAtExact,
  startedAt,
  open: (args) => new Promise<boolean>((resolve) => execFile("open", args, { timeout: 30_000 }, (error) => resolve(error === null))),
  now: () => Date.now(),
  sleep,
};

/**
 * Whether a process that started at `startedMs` is provably this launch's. With exact start times (the screen helper) it compares as they are. Without the helper `ps` gives
 * whole seconds, floored, while `sinceMs` has milliseconds: a launch in the same second as `sinceMs` reads a start time below it, so both are floored to the second before they
 * are compared (a launch in the same second is ours; the launch waited for a second boundary first, so one the person started earlier is in an earlier second). A start time that
 * cannot be read is not proof.
 */
export const startedByLaunch = (startedMs: number | null, sinceMs: number, exact: boolean): boolean =>
  startedMs !== null && (exact ? startedMs >= sinceMs : Math.floor(startedMs / 1000) >= Math.floor(sinceMs / 1000));

export const macOfficeDriver = (prims: LaunchPrims = REAL_LAUNCH): OfficeExportDriver => ({
  // Word and PowerPoint read ~/Pictures and write `~$` names anywhere; Excel writes ~/Pictures too: a new subfolder there raises no prompt.
  stageRoot: () => path.join(homedir(), "Pictures"),
  appVersion: (app) => macAppVersion(app.name), // a file read, never a launch or a script to the app
  async isRunning(app) {
    return (await prims.pids(app.name)).length > 0;
  },
  async launch(app) {
    guard();
    // A process this launch started has a start time at or after `since`; one the person started before it does not. With the screen helper built, start times are read
    // from the kernel to the microsecond, so `since` is this moment. Without it they are whole seconds (`ps`), so the launch waits for a whole second first and
    // compares seconds with seconds (startedByLaunch).
    // The gate is asked again right before `open`, closing the gap since the job's first check.
    const precise = (await prims.startedAtExact(process.pid)) !== null;
    if (!precise) await prims.sleep(1000 - (prims.now() % 1000));
    const since = prims.now();
    const startOf = precise ? prims.startedAtExact : prims.startedAt;
    if ((await prims.pids(app.name)).length > 0) return "not-ours";
    const opened = await prims.open(launchArgs(app));
    trace(`launch opened=${opened}`);
    if (!opened) return null;
    for (const t0 = prims.now(); prims.now() - t0 < 10_000;) {
      const found = await prims.pids(app.name);
      if (found.length > 0) {
        // Every process found must be provably this launch's; one that is not, or whose start cannot be read, makes the app the person's.
        for (const p of found) if (!startedByLaunch(await startOf(p), since, precise)) return "not-ours";
        return found[0]!;
      }
      await prims.sleep(50);
    }
    return null;
  },
  async ready(app, deadline) {
    while (Date.now() < deadline) {
      const r = await ask(app.name, "ready", `tell application ${asLiteral(app.name)} to with timeout of 3 seconds\ncount of ${DOCS[app.key]}\nend timeout`, 5_000);
      // not registered as running yet right after the launch: ask again until the deadline (nothing was sent to the app)
      if (r.ok && r.stdout !== GONE) return true;
      await sleep(100);
    }
    return false;
  },
  async exportPdf(app, input, pdf, timeoutMs): Promise<ExportOutcome> {
    const r = await ask(app.name, "export", exportScript(app.key, input, pdf, Math.max(1, Math.floor(timeoutMs / 1000) - 1)), timeoutMs);
    if (r.stdout === GONE) return { ok: false, timedOut: false, why: `${app.name} was no longer running` };
    if (r.timedOut || /-1712\b/.test(r.stdout)) return { ok: false, timedOut: true, why: `${app.name} did not answer in time` };
    if (!r.ok) return { ok: false, timedOut: false, why: `${app.name} could not be asked` };
    if (r.stdout === "OK") return { ok: true };
    const f = r.stdout.split("\t");
    if (f[0] === "ERR" && f[1] === "open") return { ok: false, timedOut: false, why: `${app.name} could not open this file (it answered error ${f[2]})` };
    return { ok: false, timedOut: false, why: `${app.name} could not save its PDF (error ${f[2] ?? "unknown"})` };
  },
  async exportTargets(app, input, targets, pdfs, timeoutMs): Promise<TargetsOutcome> {
    if (app.key !== "excel") return { ok: false, timedOut: false, why: `${app.name} cannot print sheets one by one` };
    const r = await ask(app.name, "targets", targetsScript(input, targets, pdfs, Math.max(1, Math.floor(timeoutMs / 1000) - 1)), timeoutMs);
    if (r.stdout === GONE) return { ok: false, timedOut: false, why: `${app.name} was no longer running` };
    if (r.timedOut || /-1712\b/.test(r.stdout)) return { ok: false, timedOut: true, why: `${app.name} did not answer in time` };
    if (!r.ok) return { ok: false, timedOut: false, why: `${app.name} could not be asked` };
    return readTargets(r.stdout, targets.length, app.name);
  },
  async openDocuments(app, timeoutMs) {
    // null when the app did not answer in time (it is busy opening: open-watch.ts)
    const r = await ask(app.name, "docList", docListScript(app, timeoutMs / 1000), timeoutMs + 500);
    if (!r.ok || r.timedOut || r.stdout === GONE) return null;
    return r.stdout.split(/\r?\n/).filter((l) => l !== "");
  },
  async documentCount(app, timeoutMs) {
    const r = await ask(app.name, "count", countScript(app.key), timeoutMs);
    const n = Number(r.stdout);
    return r.ok && Number.isInteger(n) ? n : null;
  },
  async quit(app, timeoutMs) {
    await ask(app.name, "quit", quitScript(app), timeoutMs);
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  kill(pid, signal, startedAtMs) {
    guard();
    // Only the pid this job's launch found; signal it only while it is still a live process, and (when the caller knows it) still the process that started then.
    trace(`kill ${pid} ${signal ?? "KILL"}`);
    if (startedAtMs !== undefined) {
      const now = startedAtNow(pid);
      if (now === null || Math.floor(now / 1000) !== Math.floor(startedAtMs / 1000)) return; // gone, reused, or unreadable: not provably ours
    }
    try {
      process.kill(pid, 0);
      process.kill(pid, signal === "TERM" ? "SIGTERM" : "SIGKILL");
    } catch {
      // already gone
    }
  },
});
