// The body of `node src/hook.ts`, kept apart so tests can drive it in-process with a fault seam. It is journal-first:
// the raw stdin bytes go to the hook journal (hook-journal.ts) before the host argument, the folder or the JSON are checked, and any later
// failure writes a marker linked to that record. The contract toward the host: exit 0, or exit 1 on any failure (never 2: exit 2 would
// block the host's tool call); stdout stays empty except for the context text on a recorded UserPromptSubmit (see promptContext)
// and, on a recorded shell PreToolUse of a host with an argv tag, the tag (see tagOutput and src/attribution/tag.ts). A journal failure is one line on stderr and changes nothing else.
import { scrubPayloadBytes } from "./patch-secrets.ts";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME_REFUSAL, isUnsafeTaskFolder, userHomeDir } from "./platform/index.ts";
import { handleEvent, hookClientName, markTrackingStopped, parkedOpsOf, parseOutsideWatching, resolveAdapterHome } from "./hook-adapter.ts";
import { beforeSideOfCall, callTimesOfCall, JOURNAL_STEM, journalBeforeSide, journalDone, journalEvent, journalFailure, noteDegraded, sessionKeyOfBytes, type JournalRef } from "./hook-journal.ts";
import { markNotChecked, reconcileSession } from "./coverage.ts";
import { allProfiles, findProfile, hasCapability, isHostKey, loadOutsiderHarnesses, outsiderHarnessDir, profileWithExtra, runsOtherHostsHook } from "./hosts/index.ts";
import { openLedger } from "./ledger.ts";
import { normalize, type HookHost } from "./normalize.ts";
import { readRegistry, RegistryError, resolveFolder } from "./registry.ts";
import { writeOpenRecord } from "./open-pick.ts";
import { isShellTool } from "./credit-guard.ts";
import { isOpenCommand, setTracking, trackCommand, trackingOf, type Tracking } from "./tracking.ts";
import { cliCommand, sessionContextText } from "./session-context.ts";
import { helperGate, pruneHelperState } from "./helper-linker.ts";
import { AFTER_SNAPSHOT_ACCEPT_MS, AfterNotTaken, httpLocalProcess, type AfterNotTakenReason, type LocalProcess } from "./connector/local-process.ts";
import { recordNoSubject, recordNotTaken } from "./connector/after-gap.ts";
import { answerIsError, beforeReadMsFor, loadCallTemplates, loadSubjectTemplates, MAX_CALL_ANSWER_BYTES, renderSubject } from "./connector/subjects.ts";
import { DEFAULT_BEFORE_READ_MS } from "./connector/schema.ts";
import { callShell, markSessionTagged, sessionReady, parseTagSetting, prepareSession, stripTag, tagCommand, tagsInMode, type TagSetting } from "./attribution/tag.ts";

/**
 * The Pre hook output that tags a shell call of a host with an argv tag (`argvTag.preOutput`: the whole input with the command
 * tagged), or "" when the call is not tagged. No permission decision is returned: the call goes through the permission flow as it would.
 */
function tagOutput(raw: any, host: string, permissionMode: unknown, setting: TagSetting, env: NodeJS.ProcessEnv): string {
  const profile = findProfile(host);
  const tag = profile?.argvTag;
  if (profile === undefined || tag === undefined || raw === null || typeof raw !== "object") return "";
  const f = profile.fields;
  const eventName = raw[f.eventName];
  if (typeof eventName !== "string" || profile.eventKinds[eventName] !== "tool-pre" || raw[f.toolName] !== tag.tool) return "";
  if (!tagsInMode(setting, permissionMode)) return "";
  const input = raw[f.toolInput];
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "";
  const shell = callShell(env, tag.shellEnv);
  if (shell === undefined) return "";
  const tagged = tagCommand(input.command, raw[f.toolUseId], raw[f.agentId], shell);
  if (tagged === null) return "";
  return tag.preOutput(eventName, { ...input, command: tagged });
}

const shellCommandOf = (input: unknown): unknown => {
  if (input === null || typeof input !== "object") return undefined;
  const o = input as { command?: unknown; cmd?: unknown };
  return o.command ?? o.cmd;
};

/** A Post or failure payload carries the tagged command; the record keeps the command the agent wrote. Only a host with an argv tag has a tagged command. */
function untag(raw: any, host: string): any {
  const profile = findProfile(host);
  if (profile?.argvTag === undefined) return raw;
  const key = profile.fields.toolInput;
  const cmd = raw?.[key]?.command;
  if (typeof cmd !== "string") return raw;
  const plain = stripTag(cmd);
  return plain === cmd ? raw : { ...raw, [key]: { ...raw[key], command: plain } };
}

/**
 * The task folder: `--folder`, else the folder the session was started in, else the host's folder variable (an unknown host gets the default host's), else the payload's `cwd` when
 * the host's profile declares that as its folder source (Codex). Undefined when none of them names one.
 */
function taskFolder(argv: string[], env: NodeJS.ProcessEnv, hostArg: string | undefined, bytes: Buffer, started?: Tracking): string | undefined {
  const folderIdx = argv.indexOf("--folder");
  if (folderIdx >= 0) return argv[folderIdx + 1];
  // `cocheck track start` made the session's cwd its task folder.
  if (started?.folder !== undefined) return started.folder;
  const install = (findProfile(hostArg) ?? profileWithExtra("install-default")).install;
  const fromEnv = install?.projectDirEnv === undefined ? undefined : env[install.projectDirEnv];
  if (fromEnv) return fromEnv;
  if (install?.folderFromPayloadCwd !== true) return undefined;
  try {
    const cwd = JSON.parse(bytes.toString("utf8"))?.cwd;
    return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/** The `--event` argument of a hook command line (a host whose payload names no event is told it there). */
const eventArgOf = (argv: string[]): string | undefined => {
  const i = argv.indexOf("--event");
  return i >= 0 ? argv[i + 1] : undefined;
};

export interface HookRun {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdin: AsyncIterable<Buffer | string>;
  /** The clock in epoch ms, handed to the adapter (a test pins it). The journal's own times come from `journalNow`, else the wall clock. */
  now?: () => number;
  journalNow?: () => number;
  /** Test seam, passed to the adapter. */
  fault?: (step: string) => void;
  /** This run is a held helper call replayed after its helper finished (handed to the adapter as `heldReplay`). */
  heldReplay?: boolean;
  /** The folder holding `dist/` and `scripts/`, which picks the open command named in the context text; a test pins it. */
  root?: string;
  /** Client of the long-lived local CoCheck process (it owns the connector pool). Absent in production today. The hook never spawns a connector itself. */
  localProcess?: LocalProcess;
}

type BeforeSide =
  | { subject: string; state: "snapshot"; ref: string }
  /** The connector answered that the item does not exist before the call. Only from a local process answer whose `ref` is exactly null. */
  | { subject: string; state: "absent" }
  | { subject: string; state: "unknown"; confidence: "opaque" }
  /** A templated tool whose subject could not be rendered (a field missing, empty or not a URI): recorded, never silently dropped. */
  | { subject: null; state: "unknown"; confidence: "opaque"; reason: "subject not rendered" };
/** The before-read wait when no manifest says otherwise (a matched connector's `beforeReadMs` replaces it, `beforeReadMsFor`). */
const BEFORE_SNAPSHOT_BUDGET_MS = DEFAULT_BEFORE_READ_MS;
/** The most the hook waits for the review process to accept an after-snapshot or file-capture request (it does the work after answering). */
export { AFTER_SNAPSHOT_ACCEPT_MS };

export interface HookExit {
  exitCode: 0 | 1;
  stderr: string;
  /** Empty except on a recorded UserPromptSubmit of a tracked session, where it is the context text for the agent. */
  stdout: string;
  /** On a PreToolUse whose tool has a subject template in a valid installed manifest: the before side of that URI subject. Otherwise absent. */
  beforeSide?: BeforeSide;
}

/**
 * Asks the local process for a before-snapshot of `subject`. One timer bounds every await on it; a missing process, a throw, a bad
 * answer or the budget all give unknown/opaque. Never throws.
 */
async function beforeSideOf(subject: string, local: HookRun["localProcess"], budgetMs: number = BEFORE_SNAPSHOT_BUDGET_MS, tool?: string): Promise<BeforeSide> {
  const unknown: BeforeSide = { subject, state: "unknown", confidence: "opaque" };
  if (local === undefined) return unknown;
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race([
      (async () => local.request({ kind: "before-snapshot", subject, ...(tool !== undefined ? { tool } : {}), budgetMs }))(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), budgetMs); }),
    ]);
    const ref = answer !== null && typeof answer === "object" ? (answer as { ref?: unknown }).ref : undefined;
    if (ref === null && Object.prototype.hasOwnProperty.call(answer, "ref")) return { subject, state: "absent" };
    return typeof ref === "string" && ref !== "" ? { subject, state: "snapshot", ref } : unknown;
  } catch {
    return unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * On a PostToolUse of a call whose PreToolUse journaled a before side for a URI subject, tells the review process to snapshot the after state.
 * Waits at most AFTER_SNAPSHOT_ACCEPT_MS for the process to accept. When it does not (not running, refused, no answer in time), the hook writes
 * a gap row for the call itself, so the change is never silently missing; a late acceptance's own outcome replaces that row on the page. Never throws.
 */
async function postCallAfterSnapshot(event: ReturnType<typeof normalize>, ref: JournalRef | undefined, home: string, folder: string, local: HookRun["localProcess"]): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    if (event.kind !== "tool-post" || ref === undefined || typeof event.toolUseId !== "string" || event.toolUseId === "") return;
    const side = beforeSideOfCall(home, ref.session, event.toolUseId);
    const client = hookClientName(event.host, resolveFolder(folder), event.session);
    if (side === undefined && typeof event.toolName === "string" && loadCallTemplates(home).has(event.toolName)) return await postCallCreate(event, event.toolName, event.toolUseId, client, home, local, ref.session);
    if (side === undefined || typeof side.subject !== "string" || side.subject === "") return;
    let notTaken: AfterNotTakenReason | undefined;
    try {
      const target = local ?? httpLocalProcess(home);
      if (target.afterSnapshot === undefined) notTaken = "not running";
      else {
        const before = side.state === "snapshot" && typeof side.ref === "string" && side.ref !== "" ? side.ref : null;
        // Absent travels as its own flag, only with a null before; a record without the flag has no "absent" state.
        const beforeAbsent = before === null && side.state === "absent";
        const times = callTimesOfCall(home, ref.session, event.toolUseId);
        const sent = target.afterSnapshot({ client, task: null, call: event.toolUseId, subject: side.subject, ...(typeof event.toolName === "string" && event.toolName !== "" ? { tool: event.toolName } : {}), before, ...(beforeAbsent ? { beforeAbsent: true as const } : {}), ...(times.start !== undefined && times.end !== undefined ? { callStart: times.start, callEnd: times.end } : {}), budgetMs: AFTER_SNAPSHOT_ACCEPT_MS });
        const taken = await Promise.race([
          sent.then((): AfterNotTakenReason | undefined => undefined, (error: unknown): AfterNotTakenReason => (error instanceof AfterNotTaken ? error.reason : "refused")),
          new Promise<AfterNotTakenReason>((resolve) => { timer = setTimeout(() => resolve("no answer in time"), AFTER_SNAPSHOT_ACCEPT_MS); }),
        ]);
        notTaken = taken;
      }
    } catch {
      notTaken = "refused";
    } finally {
      clearTimeout(timer);
    }
    if (notTaken === undefined) return;
    const ledger = openLedger(home);
    try {
      await recordNotTaken(ledger, home, { client, call: event.toolUseId, subject: side.subject, reason: notTaken });
    } finally {
      ledger.close();
    }
  } catch {
    // best effort: the ledger itself is unwritable
  }
}

/**
 * On a PostToolUse of a tool named in `matches.calls`, hands the tool's answer to the review process, which renders the subject from it and reads the
 * item once (a declared creation). A failed call or an answer marked isError sends nothing and records nothing. An answer over MAX_CALL_ANSWER_BYTES is a gap
 * the hook writes; a request the process does not take is a gap, recorded the same way. Waits at most AFTER_SNAPSHOT_ACCEPT_MS. Never throws.
 */
async function postCallCreate(event: ReturnType<typeof normalize>, tool: string, call: string, client: string, home: string, local: HookRun["localProcess"], journal: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    if (event.failure !== undefined || answerIsError(event.toolResponse)) return;
    const response = event.toolResponse ?? null;
    let notTaken: AfterNotTakenReason | undefined;
    if (Buffer.byteLength(JSON.stringify(response) ?? "") > MAX_CALL_ANSWER_BYTES) {
      const ledger = openLedger(home);
      try {
        await recordNoSubject(ledger, home, { client, call });
      } finally {
        ledger.close();
      }
      return;
    }
    try {
      const target = local ?? httpLocalProcess(home);
      if (target.afterSnapshot === undefined) notTaken = "not running";
      else {
        // The journal stem lets the review process find what this session already read of the subject (a shared bucket names no session, so it is not sent)
        const sent = target.afterSnapshot({ client, task: null, call, tool, response, before: null, ...(JOURNAL_STEM.test(journal) ? { journal } : {}), budgetMs: AFTER_SNAPSHOT_ACCEPT_MS });
        notTaken = await Promise.race([
          sent.then((): AfterNotTakenReason | undefined => undefined, (error: unknown): AfterNotTakenReason => (error instanceof AfterNotTaken ? error.reason : "refused")),
          new Promise<AfterNotTakenReason>((resolve) => { timer = setTimeout(() => resolve("no answer in time"), AFTER_SNAPSHOT_ACCEPT_MS); }),
        ]);
      }
    } catch {
      notTaken = "refused";
    } finally {
      clearTimeout(timer);
    }
    if (notTaken === undefined) return;
    const ledger = openLedger(home);
    try {
      await recordNotTaken(ledger, home, { client, call, subject: "", reason: notTaken });
    } finally {
      ledger.close();
    }
  } catch {
    // best effort: the ledger itself is unwritable
  }
}

/** The before side for a PreToolUse whose tool has a subject template; undefined when it has none. Never throws. */
async function preCallBeforeSide(event: ReturnType<typeof normalize>, home: string, local: HookRun["localProcess"]): Promise<BeforeSide | undefined> {
  try {
    if (event.kind !== "tool-pre" || typeof event.toolName !== "string") return undefined;
    const template = loadSubjectTemplates(home).get(event.toolName);
    if (template === undefined) return undefined;
    const subject = renderSubject(template, event.toolInput);
    return subject === undefined ? { subject: null, state: "unknown", confidence: "opaque", reason: "subject not rendered" } : await beforeSideOf(subject, local ?? httpLocalProcess(home), beforeReadMsFor(home, event.toolName), event.toolName);
  } catch {
    return undefined;
  }
}

/**
 * The context text for a UserPromptSubmit of a tracked session (an untracked session never reaches here). It runs
 * only after the event was recorded, and any error in it yields "": the text is a nicety and never changes capture or the exit code.
 */
function promptContext(run: HookRun, folder: string): string {
  try {
    run.fault?.("context");
    return sessionContextText(folder, cliCommand(run.root ?? path.resolve(import.meta.dirname, ".."))) + "\n";
  } catch {
    return "";
  }
}

const safeJson = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
};

/** Class-level wording for a marker: a JSON error's own message quotes the payload, so it is replaced. */
const markerText = (error: unknown): string => (error instanceof SyntaxError ? "payload is not valid JSON" : error instanceof Error ? error.message : String(error));

/** The skipped-manifest lines for `cocheck status`, kept in the data home beside the other notes; the file is emptied when nothing is skipped. */
function noteSkippedHarnesses(home: string | undefined, skipped: readonly string[]): void {
  if (home === undefined) return;
  try {
    const file = path.join(home, "harness-skipped.txt");
    if (skipped.length > 0) {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writeFileSync(file, skipped.map((l) => `${l}\n`).join(""), { mode: 0o600 });
    } else if (existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
  } catch {
    // a note that cannot be written changes nothing else
  }
}

export async function runHook(run: HookRun): Promise<HookExit> {
  const now = run.journalNow ?? Date.now;
  let stderr = "";
  let home: string | undefined;
  let ref: JournalRef | undefined;
  let failure: unknown;
  let registered: string[] | undefined;
  let started: Tracking | undefined;
  try {
    try {
      home = resolveAdapterHome(run.env, path.join(homedir(), ".cocheck"));
    } catch (error) {
      // No home, no journal: the error below is the one the host has always seen.
      failure = error;
    }
    process.umask(0o077);
    // The person's own harness manifests. One that does not load is skipped; no other host's hook is affected. It is noted after the tracking gate (nothing is written before it).
    const skippedHarnesses = loadOutsiderHarnesses(outsiderHarnessDir(run.env, home));
    const hostArg = run.argv[run.argv.indexOf("--host") + 1];
    // The payload is read first: the tracking gate below needs the session id. Nothing is written before the gate.
    const chunks: Buffer[] = [];
    if (home !== undefined) for await (const chunk of run.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    // The entry: the payload is scrubbed here, before anything reads, journals, holds or replays it (see patch-secrets.ts).
    let bytes: Buffer = scrubPayloadBytes(Buffer.concat(chunks));
    // What Copilot helper state is past its bound goes at every hook run, whatever the host or the session's tracking.
    if (home !== undefined) {
      try {
        await pruneHelperState(home, (run.journalNow ?? Date.now)());
      } catch {
        // a prune that cannot run changes nothing else
      }
    }
    // Copilot also runs the hooks of a repo's `.claude/settings.json`, and Cursor those of ~/.claude/settings.json; a run of another host's hook that such a host started
    // records nothing (that host's own entry does). An outsider harness's fingerprint counts only while its own CoCheck hook is installed for the payload's folder.
    if (home !== undefined && isHostKey(hostArg) && runsOtherHostsHook(hostArg, safeJson(bytes), { env: run.env, userHome: userHomeDir(run.env) })) return { exitCode: 0, stderr, stdout: "" };
    // The tracking gate. Every session starts untracked: nothing is journaled, recorded or injected until `cocheck track start` ran
    // in it. The switch commands are recognised here, keyed by the hook's own session id, and are themselves never recorded. A payload
    // that names no session (not JSON, no id) is not a session and falls through to the loud failure below.
    if (home !== undefined && failure === undefined && isHostKey(hostArg)) {
      let ev: ReturnType<typeof normalize> | undefined;
      try {
        const eventIdx = run.argv.indexOf("--event");
        ev = normalize(hostArg, untag(JSON.parse(bytes.toString("utf8")), hostArg), eventIdx >= 0 ? run.argv[eventIdx + 1] : undefined);
      } catch {
        ev = undefined;
      }
      if (ev !== undefined && typeof ev.session === "string" && ev.session !== "") {
        const verb = isShellTool(ev.toolName, ev.host) && ev.kind !== "other" ? trackCommand(shellCommandOf(ev.toolInput)) : undefined;
        if (verb !== undefined) {
          if (ev.kind === "tool-pre" && verb !== "status") {
            try {
              // A stop ends the session's work in its task before the switch goes, since the turn's own Stop will arrive untracked.
              if (verb === "stop") {
                const was = trackingOf(home, hostArg, ev.session);
                const folder = taskFolder(run.argv, run.env, hostArg, bytes, was);
                if (was !== undefined && folder !== undefined) {
                  try {
                    markTrackingStopped(home, hostArg, folder, ev.session, run.journalNow);
                  } catch {
                    // the switch still goes off; the page falls back to the idle window
                  }
                }
              }
              const startFolder = verb === "start" ? (ev.cwd !== undefined && path.isAbsolute(ev.cwd) ? ev.cwd : taskFolder(run.argv, run.env, hostArg, bytes)) : undefined;
              // A home folder, a filesystem root or a folder containing the home is never a task folder; no switch is made (exit 0: the contract never uses 2); the agent reads the refusal from the `cocheck track start` command itself, which runs and prints it.
              if (startFolder !== undefined && isUnsafeTaskFolder(startFolder, userHomeDir(run.env))) return { exitCode: 0, stderr: `${stderr}${HOME_REFUSAL}\n`, stdout: "" };
              setTracking(home, hostArg, ev.session, verb === "start", startFolder, run.journalNow);
            } catch (error) {
              return { exitCode: 1, stderr: `cocheck hook: could not switch tracking ${verb}: ${(error as NodeJS.ErrnoException).code ?? "error"}\n`, stdout: "" };
            }
          }
          return { exitCode: 0, stderr, stdout: "" };
        }
        // `cocheck open` names no session; the hook writes who asked, before the tracking check so it also fires after `track stop`.
        if (ev.kind === "tool-pre" && isShellTool(ev.toolName, ev.host) && isOpenCommand(shellCommandOf(ev.toolInput))) {
          try {
            writeOpenRecord(home, hostArg, ev.session, (run.journalNow ?? Date.now)());
          } catch {
            // no record: `cocheck open` shows the list when two sessions share a folder
          }
        }
        started = trackingOf(home, hostArg, ev.session);
        if (hasCapability(hostArg, "helperSessions")) {
          // A helper's calls under a session id of their own are linked to their main session, or held until they are (src/helper-linker.ts).
          const eventName = typeof ev.eventName === "string" ? ev.eventName : "";
          const gate = await helperGate(home, started, ev, bytes, eventName, (run.journalNow ?? Date.now)());
          if (gate.stop) return { exitCode: 0, stderr, stdout: "" };
          bytes = gate.bytes;
          started = gate.started;
          for (const held of gate.replay) {
            const argv = run.argv.filter((a, i, all) => a !== "--event" && all[i - 1] !== "--event");
            const again = await runHook({ ...run, heldReplay: true, argv: [...argv, "--event", held.event], stdin: (async function* () { yield held.bytes; })() });
            stderr += again.stderr;
          }
        }
        const sessionStart = hasCapability(hostArg, "argvTag") && ev.eventName === findProfile(hostArg)?.argvTag?.sessionStartEvent;
        if (started === undefined && !sessionStart) return { exitCode: 0, stderr, stdout: "" };
      }
    }
    if (home !== undefined && failure === undefined) {
      try {
        // watched.json does not switch recording on; it serves as extra scope for the write guards, and a registry that
        // cannot be read still fails loud for a tracked session.
        registered = readRegistry(home);
        if (registered === undefined && run.env.COCHECK_MANAGED === "1") {
          throw new RegistryError(`watched-folder registry ${path.join(home, "watched.json")} is missing; reinstall CoCheck`);
        }
      } catch (error) {
        failure = error;
      }
    }
    noteSkippedHarnesses(home, skippedHarnesses);
    const tagSetting = parseTagSetting(run.argv, run.env);
    if (home !== undefined && failure === undefined && hasCapability(hostArg, "argvTag")) {
      // SessionStart only sets the write hooks' environment for the session's Bash calls (CLAUDE_ENV_FILE); it records nothing.
      let start: any;
      try {
        start = JSON.parse(bytes.toString("utf8"));
      } catch {
        start = undefined;
      }
      const tagParams = findProfile(hostArg)?.argvTag;
      if (tagParams !== undefined && start?.[findProfile(hostArg)!.fields.eventName] === tagParams.sessionStartEvent) {
        const envFile = run.env[tagParams.envFileVar];
        // The SessionStart payload carries no permission_mode (the hooks reference's SessionStart input lists none), and the mode can
        // change mid-session, so the environment is set whenever the setting is not off. The hooks stay inert (no process walk, no
        // record) until a Pre tags one of the session's calls and marks the session (markSessionTagged).
        if (envFile && path.isAbsolute(envFile) && tagSetting !== "off") {
          try {
            const roots = [...(registered ?? []), taskFolder(run.argv, run.env, hostArg, bytes, started)].filter((f): f is string => typeof f === "string");
            appendFileSync(envFile, prepareSession(home, start[findProfile(hostArg)!.fields.session], roots, now()));
          } catch (error) {
            stderr += `cocheck hook: could not set the write hooks' environment: ${(error as NodeJS.ErrnoException).code ?? "error"}\n`;
          }
        }
        return { exitCode: 0, stderr, stdout: "" };
      }
    }
    if (home !== undefined) {
      try {
        ref = journalEvent(home, bytes, isHostKey(hostArg) ? hostArg : "unknown", now, eventArgOf(run.argv));
      } catch (error) {
        stderr += `cocheck hook: journal unavailable: ${(error as NodeJS.ErrnoException).code ?? "error"}\n`;
        noteDegraded(home, (error as NodeJS.ErrnoException).code ?? "error", now, sessionKeyOfBytes(bytes, isHostKey(hostArg) ? hostArg : "unknown", eventArgOf(run.argv)));
      }
    }
    if (!isHostKey(hostArg)) {
      throw new Error(`usage: hook.ts --host ${allProfiles().map((p) => p.key).join("|")}  (hook payload JSON on stdin)`);
    }
    if (failure !== undefined) throw failure;
    const folder = taskFolder(run.argv, run.env, hostArg, bytes, started);
    if (!folder) {
      const sources = allProfiles().flatMap((p) => [...(p.install?.projectDirEnv === undefined ? [] : [`${p.fullName ?? p.displayName} sets ${p.install.projectDirEnv}`]), ...(p.install?.folderFromPayloadCwd === true ? [`${p.displayName}'s payload carries a cwd`] : [])]);
      throw new Error(`no task folder: pass --folder <dir> in the hook command (${sources.join("; ")})`);
    }
    const eventIdx = run.argv.indexOf("--event");
    const parsed = JSON.parse(bytes.toString("utf8"));
    const event = normalize(hostArg as HookHost, untag(parsed, hostArg), eventIdx >= 0 ? run.argv[eventIdx + 1] : undefined);
    let tag = "";
    if (event.kind === "tool-pre" && hasCapability(hostArg, "argvTag")) {
      try {
        // Only a session whose SessionStart set the write hooks' environment is tagged: a tag without hooks would read as observed.
        tag = sessionReady(home!, parsed[findProfile(hostArg)!.fields.session]) ? tagOutput(parsed, hostArg, event.extra.permissionMode, tagSetting, run.env) : "";
        // The session is marked before the call is recorded as tagged: a call is never believed tagged unless its children will look.
        if (tag !== "") markSessionTagged(home!, parsed[findProfile(hostArg)!.fields.session]);
      } catch {
        tag = "";
      }
    }
    const beforeSide = await preCallBeforeSide(event, home!, run.localProcess);
    if (beforeSide !== undefined && ref !== undefined) {
      try {
        journalBeforeSide(ref, beforeSide, now);
      } catch (error) {
        stderr += `cocheck hook: could not record the before side: ${(error as NodeJS.ErrnoException).code ?? "error"}\n`;
        noteDegraded(home!, (error as NodeJS.ErrnoException).code ?? "error", now, sessionKeyOfBytes(bytes, isHostKey(hostArg) ? hostArg : "unknown", eventArgOf(run.argv)));
      }
    }
    await handleEvent(event, { host: event.host, home: home!, folder, outsideWatching: parseOutsideWatching(run.argv, run.env), now: run.now, fault: run.fault, attributionTag: tagSetting, taggedCall: tag !== "", ...(run.heldReplay === true ? { heldReplay: true } : {}) });
    await postCallAfterSnapshot(event, ref, home!, folder, run.localProcess);
    if (ref !== undefined) {
      try {
        journalDone(ref, now);
      } catch (error) {
        stderr += `cocheck hook: journal housekeeping failed: ${(error as NodeJS.ErrnoException).code ?? "error"}\n`;
      }
    }
    if (event.kind === "stop") {
      // A failed reconciliation overwrites the session's row with "not checked", so an earlier "complete" never outlives a Stop that could not check.
      let ledger: ReturnType<typeof openLedger> | undefined;
      try {
        ledger = openLedger(home!);
        run.fault?.("reconcile");
        reconcileSession({ home: home!, ledger, host: event.host, sessionId: event.session, transcriptPath: event.transcriptPath, now, parkedOps: parkedOpsOf(home!, event.host, folder, event.session) });
      } catch (error) {
        stderr += `cocheck hook: coverage reconciliation failed: ${error instanceof Error ? error.message.slice(0, 120) : "error"}\n`;
        try {
          if (ledger !== undefined) markNotChecked(ledger, event.host, event.session, "reconciliation failed", now);
        } catch {
          // the events-since-check rule in the sign-off lines still catches a stale row
        }
      } finally {
        ledger?.close();
      }
    }
    if (event.kind === "tool-pre" && hasCapability(hostArg, "argvTag")) return { exitCode: 0, stderr, stdout: tag, ...(beforeSide !== undefined ? { beforeSide } : {}) };
    return { exitCode: 0, stderr, ...(beforeSide !== undefined ? { beforeSide } : {}), stdout: event.kind === "prompt" && findProfile(hostArg)?.install?.promptContext !== false ? promptContext(run, folder) : "" };
  } catch (error) {
    stderr += `cocheck hook: ${error instanceof Error ? error.message : String(error)}\n`;
    if (ref !== undefined) {
      try {
        journalFailure(ref, markerText(error), now);
      } catch {
        // the marker is best effort
      }
    }
    return { exitCode: 1, stderr, stdout: "" };
  }
}
