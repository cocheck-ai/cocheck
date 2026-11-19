// Who a sweep may credit, two guards shared by the hook adapter (new records) and the timeline builder (existing ledgers).
//
// 1. An internal agent call: its Pre carries an agent_id with no agent_type and no launcher (Claude Code's own internal agents, which are no
//    helper of the work, have no launch record and no transcript). It is non-crediting: a sweep at another call's event never credits it. It
//    credits only what its own Post sweep found, if a Post ever comes. A real helper's Pre carries agent_type, so it is never internal.
// 2. A call's own tool: a Write or Edit credits only its own file_path, and Read, Glob, Grep and SendMessage credit nothing.
//
// Credit only on evidence. More narrowings, shared the same way:
// 3. A tool that cannot write a file (WebFetch, WebSearch, ToolSearch, Skill, TodoWrite, read-only MCP tools, besides the four above) is never
//    credited. An Agent or Task launch is not credited at a sweep where a call of the agent it launched is open (that call carries its
//    work); with none of them open the launch stays a suspect.
// 4. A call the host's transcript shows done (`CallEvidence`): one that never ran (blocked by a PreToolUse hook, denied) is credited with
//    nothing; one that ran is credited only up to the first sweep at or after its result. A call closed by its own Post or failure keeps
//    the window it has: the record's own close is the better evidence. A call whose work can outlive its result (`runsOnAfterResult`:
//    run_in_background, `&`, nohup, setsid, disown, osascript, open, or a call the host moved to the background) is never closed on
//    evidence: it stays a suspect to Stop or expiry, as before.
// Seam for positive write evidence (a per-call tag on the writing process): `creditWithEvidence` takes it first, ahead of open-call windows.
//
// Both only narrow a credit to fewer calls. A change left with no call is "found during agent calls" while any call was open (never "outside
// the agents"), because the open list is kept whole and only the credit is narrowed.

import { realpathSync } from "node:fs";
import path from "node:path";
import { createPathKit, type PathKit } from "./paths.ts";
import { platform, platformFor, type Platform } from "./platform/index.ts";
import type { PatchSection, ReportedEdit } from "./attribution/reconstruct.ts";

/**
 * The path kit the credit guards compare with. Windows folds case; a Mac volume compares exactly in `PathKit`, but the credit
 * guards have always folded case on the Mac (APFS is case-insensitive by default, and a wrong "different file" would drop a real credit), so
 * a platform whose names are not case-sensitive folds here too. `plat` picks the platform (a test passes "win32" on any OS).
 */
export function guardKit(plat: Platform | string = platform()): PathKit {
  const p = typeof plat === "string" ? platformFor(plat) : plat;
  return createPathKit({ name: p.name, paths: { ...p.paths, foldsCase: p.paths.foldsCase || !p.paths.caseSensitive } });
}

/**
 * One comparison of two absolute paths for both the adapter and the timeline builder. Both sides are read through the path kit
 * (canonical "/" form, Git Bash `/c/x` on Windows) and NFC normalised, and compared with the kit's case folding. With `real` the adapter also
 * resolves symlinks first (the path itself, else its folder, so a deleted or not-yet-written file still resolves through its directory). The
 * timeline builder passes `real: false`: it reads historical paths that may no longer exist, so it cannot realpath them and compares by NFC
 * and case folding only; a symlinked alias in an old ledger is therefore not recognised there (the credit stays, the safe direction).
 */
export function samePath(a: string, b: string, real: boolean, kit: PathKit = guardKit()): boolean {
  return foldPath(a, real, kit) === foldPath(b, real, kit);
}

function foldPath(p: string, real: boolean, kit: PathKit): string {
  let q = kit.canon(p);
  if (real) {
    // the path in the platform's own form first, else as written (a posix-shaped path read with the win32 kit on another OS)
    const forms = [...new Set([kit.native(q), q])];
    const resolved = ((): string | undefined => {
      for (const f of forms) {
        try {
          return realpathSync(f);
        } catch {
          // try the folder
        }
      }
      for (const f of forms) {
        const dir = path.dirname(f);
        if (dir === ".") continue; // a form this OS cannot read as a path (backslashes on a Mac)
        try {
          return path.join(realpathSync(dir), path.basename(f));
        } catch {
          // neither exists: compared as written
        }
      }
      return undefined;
    })();
    if (resolved !== undefined) q = kit.canon(resolved);
  }
  return kit.key(q.normalize("NFC"));
}

/** An agent call with no agent type and no launcher: Claude Code's internal agent. */
export function isInternalAgentCall(call: { agentId: string | null | undefined; agentType: string | null | undefined; launchId: string | null | undefined }): boolean {
  return call.agentId != null && call.agentType == null && call.launchId == null;
}

/**
 * Tools that cannot write a file in the folder. The guard adds the launcher (an Agent or Task call: its agent's own calls carry its work), the web
 * tools (they write only the host's own tool-results cache), the host's bookkeeping tools, and reads of a background shell.
 */
const NO_CREDIT_TOOLS = new Set([
  "Read", "Glob", "Grep", "SendMessage", "LS", "NotebookRead",
  "WebFetch", "WebSearch", "ToolSearch", "Skill", "TodoWrite", "TodoRead",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "BashOutput", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode",
  "ListMcpResourcesTool", "ReadMcpResourceTool",
  // Copilot's read-only tools, as named in the recorded 1.0.103 run (platforms/copilot-cli/versions/1.0.103/hook-calls.jsonl)
  "glob", "rg", "view",
]);
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** An MCP tool's own name (`mcp__<server>__<tool>`) that only reads: a read verb first, and no write verb anywhere in it. */
const MCP_READ_VERB = /^(get|list|search|read|query|fetch|find|describe|count|aggregate|view|show|lookup|inspect|check|validate|preview|export)(_|-|$)/i;
const MCP_WRITE_WORD = /(^|_|-)(create|update|write|set|delete|remove|save|put|post|upload|apply|insert|edit|move|rename|copy|send|run|exec|execute|import|add|patch|replace|modify|append|trash|merge|publish|deploy|download)(_|-|$)/i;

/** An MCP tool that by its name only reads (`mcp__github__get_file_contents`, `mcp__x__list_items`). Unknown shapes are not read-only. */
export function isReadOnlyMcpTool(tool: string): boolean {
  if (!tool.startsWith("mcp__")) return false;
  const own = tool.slice(tool.lastIndexOf("__") + 2);
  return own !== "" && MCP_READ_VERB.test(own) && !MCP_WRITE_WORD.test(own);
}

/** A tool that can never write a file: never credited with any change. */
export function toolNeverWrites(tool: string | null | undefined): boolean {
  return tool != null && (NO_CREDIT_TOOLS.has(tool) || isReadOnlyMcpTool(tool));
}

/**
 * Whether the call's own tool allows it to be credited with a change to `file`. `filePath` is the call's file_path input, when known;
 * `same` compares two paths; `kit` says what an absolute path is on this platform. A file tool with no usable path (absent, relative, masked) stays creditable: unknown is the safe direction.
 */
export function toolMayCredit(tool: string | null | undefined, filePath: string | null | undefined, file: string, same: (a: string, b: string) => boolean, kit: PathKit = guardKit()): boolean {
  if (toolNeverWrites(tool)) return false;
  if (tool != null && FILE_TOOLS.has(tool) && typeof filePath === "string" && kit.isAbs(filePath) && kit.isAbs(file)) return same(filePath, file);
  return true;
}

/** The host tool names that run a shell command (Claude Code and Codex `Bash`, Copilot `bash`, Claude Code `PowerShell`, Copilot `powershell`, `pwsh`). The one set hook-cli, src/timeline/describe.ts and `isShellTool` all read. */
export const SHELL_TOOLS = /^(bash|shell|sh|zsh|exec|exec_command|local_shell|container\.exec|run_shell_command|terminal|powershell|pwsh)$/i;
export const isShellTool = (tool: string | null | undefined): boolean => tool != null && SHELL_TOOLS.test(tool);

/** Tools whose own input names the file they write, by the field that holds it: Claude Write/Edit/MultiEdit, Copilot create/edit (`path`). */
const WRITE_PATH_FIELD: Record<string, readonly string[]> = { write: ["file_path", "path"], edit: ["file_path", "path"], multiedit: ["file_path"], create: ["path", "file_path"], notebookedit: ["notebook_path"] };
/**
 * The absolute paths a host file-edit call's own input reports (unresolved), or undefined when the tool is not one that names its file
 * (a shell call, anything unlisted) or any target is not absolute (a relative path proves nothing). `isAbs` is the path kit's.
 */
export function editTargetsOf(tool: string | null | undefined, input: unknown, isAbs: (p: string) => boolean, resolveRel?: (p: string) => string): string[] | undefined {
  if (tool == null || !(tool.toLowerCase() in WRITE_PATH_FIELD) && !FILE_TOOLS.has(tool) && !/^(apply_patch|patch)$/i.test(tool)) return undefined;
  const isPatch = /^(apply_patch|patch)$/i.test(tool);
  const targets = writeTargetsOf(tool, input).map((p) => (isPatch && resolveRel !== undefined && !isAbs(p) && !p.startsWith("~") ? resolveRel(p) : p));
  return targets.length > 0 && targets.every(isAbs) ? targets : undefined;
}
const EDIT_CAP = 64 * 1024;

/**
 * What a host file-edit call's own input reports it did to each file it names by an absolute path (`isAbs`), in the shape
 * `reconstruct` replays: a Write/create's whole content (as its hash), an Edit/MultiEdit's old to new replacements, an apply_patch's sections.
 * A file the input does not describe exactly (a field missing, a move, a delete, a relative path), or a call whose strings pass the size cap,
 * gets nothing: it stays inferred. A relative apply_patch header is resolved with `resolveRel` (the host's cwd) when given. Bound: read from the input only.
 */
export function reportedEditsOf(tool: string | null | undefined, input: unknown, isAbs: (p: string) => boolean, sha256: (text: string) => string, resolveRel?: (p: string) => string): ReportedEdit[] {
  if (tool == null || input == null) return [];
  const t = tool.toLowerCase();
  const rec = typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const out: ReportedEdit[] = [];
  if (t === "apply_patch" || t === "patch") {
    const text = typeof input === "string" ? input : rec === undefined ? "" : (["input", "patch", "command", "diff"].map((k) => rec[k]).find((v) => typeof v === "string") as string | undefined) ?? "";
    let cur: ReportedEdit | undefined;
    let section: PatchSection | undefined;
    const dropped = new Set<string>();
    const rows = text.split("\n");
    if (rows[rows.length - 1] === "") rows.pop();
    for (const line of rows) {
      const h = /^\*\*\* (Add File|Update File|Delete File|Move to):[ \t]*(.+?)[ \t]*$/.exec(line.replace(/\r$/, ""));
      if (h) {
        // Codex writes apply_patch paths relative to the session cwd; `resolveRel` (apply_patch only, never a file tool) makes them absolute.
        const p = resolveRel !== undefined && !isAbs(h[2]!) && !h[2]!.startsWith("~") ? resolveRel(h[2]!) : h[2]!;
        if (h[1] === "Move to" || h[1] === "Delete File" || !isAbs(p)) {
          if (h[1] === "Move to" && cur !== undefined) dropped.add(cur.path);
          dropped.add(p);
          cur = undefined;
          section = undefined;
          continue;
        }
        cur = out.find((e) => e.path === p);
        if (cur === undefined) out.push((cur = { path: p, sections: [] }));
        section = { add: h[1] === "Add File", lines: [] };
        cur.sections!.push(section);
      } else if (/^\*\*\* End Patch\s*$/.test(line)) {
        cur = undefined;
        section = undefined;
      } else if (section !== undefined && !/^\*\*\* (Begin Patch|End of File)\s*$/.test(line)) section.lines.push(line.replace(/\r$/, "")); // a CRLF patch: the row ends are the patch's, not the file's
    }
    return limit(out.filter((e) => !dropped.has(e.path) && e.sections!.every((s) => s.lines.length > 0)));
  }
  if (rec === undefined) return [];
  const target = writeTargetsOf(tool, input)[0];
  if (target === undefined || !isAbs(target)) return [];
  const content = str(rec.content) ?? str(rec.file_text);
  if (content !== undefined) return [{ path: target, sha: sha256(content) }];
  const items = Array.isArray(rec.edits) ? (rec.edits as unknown[]) : [rec];
  const edits: ReportedEdit["edits"] = [];
  for (const e of items) {
    const r = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : undefined;
    const o = r && (str(r.old_string) ?? str(r.old_str));
    const n = r && (str(r.new_string) ?? str(r.new_str));
    if (o === undefined || n === undefined) return [];
    edits.push({ old: o, new: n, all: r!.replace_all === true });
  }
  return edits.length === 0 ? [] : limit([{ path: target, edits }]);
  function limit(list: ReportedEdit[]): ReportedEdit[] {
    const size = list.reduce((n, e) => n + (e.edits ?? []).reduce((m, x) => m + x.old.length + x.new.length, 0) + (e.sections ?? []).reduce((m, x) => m + x.lines.reduce((k, l) => k + l.length + 1, 0), 0), 0);
    return size > EDIT_CAP ? [] : list;
  }
}
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to):[ \t]*(.+?)[ \t]*$/gm;

/**
 * The paths a call's own tool input names as write targets, as written (relative ones are the caller's to resolve): the file field of
 * Write/Edit/MultiEdit/create, and the headers of an `apply_patch` patch (`*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`),
 * whether the input is the patch text itself (Copilot) or an object holding it. Bound: read from the call's input only, never from a shell
 * command; a tool or shape not listed names nothing.
 */
export function writeTargetsOf(tool: string | null | undefined, input: unknown): string[] {
  if (tool == null) return [];
  const t = tool.toLowerCase();
  const out: string[] = [];
  const fields = WRITE_PATH_FIELD[t];
  if (fields !== undefined && typeof input === "object" && input !== null) {
    for (const f of fields) {
      const v = (input as Record<string, unknown>)[f];
      if (typeof v === "string" && v !== "") {
        out.push(v);
        break;
      }
    }
  }
  if (t === "apply_patch" || t === "patch") {
    const texts: string[] = typeof input === "string" ? [input] : typeof input === "object" && input !== null ? ["input", "patch", "command", "diff"].map((k) => (input as Record<string, unknown>)[k]).filter((v): v is string => typeof v === "string") : [];
    for (const text of texts) for (const m of text.matchAll(PATCH_HEADER)) out.push(m[1]!);
  }
  return out;
}

/**
 * The one launcher predicate, by name only: Claude Code's `Agent` and `Task`, Copilot's `task`, and Codex's `spawn_agent` in any recorded form
 * (`collaborationspawn_agent`, or namespaced as `isWaitTool` matches `wait_agent`). A name that merely contains "task" or "agent" (`TaskCreate`,
 * `TodoWrite`, `read_agent`, `wait_agent`) is not a launch.
 */
export const isLauncherTool = (tool: string | null | undefined): boolean => tool != null && (tool === "Agent" || tool === "Task" || tool === "task" || /(^|[.:/]|collaboration)spawn_agent$/i.test(tool));

/** Codex's `wait_agent` (recorded as `collaborationwait_agent`): a call whose only work is waiting on helpers. */
export const isWaitTool = (tool: string | null | undefined): boolean => tool != null && /(^|[.:/]|collaboration)wait_agent$/i.test(tool);

/**
 * Whether a call waits on helpers and so writes nothing: Codex `wait_agent`, or Copilot's `read_agent` called with `wait: true`
 * (`read_agent` without it is a status read, which keeps today's credit). The adapter records the answer on the call (`waits`) because the
 * timeline's tool label keeps field names, never values.
 */
export function waitsOnHelpers(tool: string | null | undefined, input: unknown): boolean {
  if (isWaitTool(tool)) return true;
  return tool === "read_agent" && typeof input === "object" && input !== null && (input as { wait?: unknown }).wait === true;
}

/**
 * An Agent or Task launch is not credited at a sweep where a call of the agent it launched is open (`helperOpen`): that call carries
 * the agent's work and is the suspect. With none of its helper's calls open (between them, or a helper whose hooks never fired) the launch
 * stays a suspect, so a change found then is never narrowed to someone else alone.
 */
export function launcherMayCredit(tool: string | null | undefined, helperOpen: boolean): boolean {
  return !(isLauncherTool(tool) && helperOpen);
}

/**
 * A call whose work can go on after its tool_result: a background flag, a shell command that detaches (`&` at a command's end, nohup,
 * setsid, disown), an osascript or `open` (the app it drives keeps going), or a result saying the host moved it to the background. Such a
 * call is never closed on transcript evidence. When unsure, it runs on.
 */
export function runsOnAfterResult(call: { tool: string | null | undefined; command?: string | null; background?: boolean }): boolean {
  if (call.background) return true;
  if (call.tool !== "Bash") return false;
  const cmd = call.command ?? "";
  if (/(^|[^&|>])&\s*($|[;\n)]|\bdone\b|\bfi\b)/.test(cmd.replace(/&&|\|&|&>|>&\d?|\d>&\d/g, " "))) return true;
  return /(^|[\s;&|(`$])(nohup|setsid|disown|osascript|open)(\s|$)/.test(cmd);
}

// ---- Rule 4: a call's end, from the host's transcript ----

/**
 * What the host's transcript says about a call's end. `at` is epoch ms. `result`: its tool_result (it ran); `interrupted`: the person
 * stopped it (it may have run part way); `turn`: the agent's next turn began (its result came before); `blocked`: a PreToolUse hook
 * refused it, or the host refused the input; `denied`: a permission prompt or rule refused it. The last two never ran.
 */
export type EvidenceKind = "result" | "interrupted" | "turn" | "blocked" | "denied";
export interface CallEvidence {
  at: number;
  kind: EvidenceKind;
}

export const neverRan = (e: CallEvidence | undefined): boolean => e !== undefined && (e.kind === "blocked" || e.kind === "denied");

/** The kind of a tool_result, from its text and error flag. Anything not known to have stopped the call before it ran is a result. */
export function classifyToolResult(text: string, isError: boolean): EvidenceKind {
  if (!isError) return "result";
  const t = text.trimStart().replace(/^Error:\s*/, "");
  if (/^PreToolUse:\S+ hook (error|blocking error|returned blocking error)/i.test(t) || /^Hook PreToolUse:\S+ (denied|blocked)/i.test(t)) return "blocked";
  // only the host's own refusals before the tool starts; anything else in <tool_use_error> (a sibling call that errored, a tool's own error) ran
  if (/^<tool_use_error>\s*(Blocked:|Error: No such tool available|InputValidationError)/.test(t)) return "blocked";
  if (/^The user doesn't want to proceed with this tool use/i.test(t) || /^Permission to use \S+.* (has been|was) denied/i.test(t) || /^Permission for this tool use was denied/i.test(t)) return "denied";
  if (/^The user doesn't want to take this action right now/i.test(t) || /interrupted by user/i.test(t)) return "interrupted";
  return "result";
}

/** A tool_result saying the call goes on in the background (run_in_background, or moved there by the person or the host): no end evidence. */
export function resultRunsOn(text: string): boolean {
  return /moved to the background|manually backgrounded|running in background|run_in_background/i.test(text);
}

/** How far after a ran call's result a sweep may still credit it, besides the first sweep at or after the result. */
export const EVIDENCE_SLACK_MS = 1000;

/**
 * Whether evidence of a call's end allows crediting it with a change found at `foundAt` (epoch ms, null when unknown). `closedByOwnEvent` is
 * true when the record closed the call at its own Post or failure (its window stands). `firstSweepAtOrAfter` gives the first sweep at or
 * after a time. A background call is never closed on a result; a call that never ran is never credited.
 */
export function evidenceMayCredit(ev: CallEvidence | undefined, call: { background: boolean; closedByOwnEvent: boolean }, foundAt: number | null, firstSweepAtOrAfter: (t: number) => number | null): boolean {
  if (ev === undefined) return true;
  if (neverRan(ev)) return false;
  if (call.background || call.closedByOwnEvent || foundAt === null) return true;
  const first = firstSweepAtOrAfter(ev.at);
  const limit = Math.max(ev.at + EVIDENCE_SLACK_MS, first ?? -Infinity);
  return foundAt <= limit;
}

// ---- Seam: positive write evidence ranks ahead of open-call windows ----

/**
 * Positive evidence of which calls wrote `file` (the per-call tag on the writing process): the writers among `candidates`, or undefined
 * when there is none for this change. `stepId` is the ledger step the change was found at, when the caller knows it: the timeline matches a
 * recorded proof by it.
 * The live adapter's provider is `#proven` (hook-adapter.ts), the timeline's `writeEvidenceFromOps` (attribution/evidence.ts).
 */
export type WriteEvidence = (file: string, candidates: readonly string[], stepId?: number | null) => readonly string[] | undefined;

/**
 * Negative evidence: whether the call `id` provably cannot have written or removed `file` (its command's write scope is known and
 * does not hold the file: attribution/write-scope.ts, `cannotHaveWritten`). False whenever in doubt. The live adapter's provider is
 * `#cannotWrite` (hook-adapter.ts); the timeline takes one through `TimelineInput.cannotWrite` (the replay harness builds it from recorded
 * commands).
 */
export type CannotWrite = (id: string, file: string, stepId?: number | null) => boolean;

/**
 * Who a change found with `candidates` open is credited to: the writers positive evidence names, when it names any; else the candidates
 * every window guard (`allowed`) lets through, less those that provably cannot have written the file (`cannot`). More than one left
 * stays joint; none left reads "during agent calls" (never "outside").
 */
export function creditWithEvidence(candidates: readonly string[], file: string, writers: WriteEvidence | undefined, allowed: (id: string) => boolean, stepId?: number | null, cannot?: (id: string) => boolean): string[] {
  const tagged = writers?.(file, candidates, stepId);
  if (tagged !== undefined && tagged.length > 0) return [...tagged];
  return candidates.filter((id) => allowed(id) && !(cannot?.(id) ?? false));
}
