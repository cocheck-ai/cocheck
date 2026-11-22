// The per-call tag on a Claude Code Bash call (built on a recorded probe).
//
// The form is a trailing shell comment line, `<command>\n# cocheck-call:<tool_use_id>:<agent_id|main>`, set by the PreToolUse hook through
// `hookSpecificOutput.updatedInput`. Chosen on evidence (see docs/attribution-tag.md):
// - A comment executes nothing and is not a subcommand, so the command's own subcommands are unchanged text: Claude Code's deny and ask
//   rules ("apply when any subcommand matches") still see every one of them, and an allow rule has no new subcommand to fail on. The
//   rejected forms each add or hide a subcommand: `export X=..;` and a pid-registry write are a new subcommand an allow rule must also
//   match (and the registry's `>>` redirect is checked as a file write); `X=.. cmd` stops allow rules ("An allow rule won't match past an
//   assignment of any other variable"); `env X=.. cmd` and `bash -c '..'` hide the command from deny rules, a security bug.
// - It is not in the environment, so no env dump prints it (the env form leaked in 5 of 30 probe cases).
// - Children find it in their ancestor shell's argv: Claude Code runs `<shell> -c "... eval '<command>' ..."`, so the comment is in the
//   command line of the shell that runs the call (observed on 2.1.309), and the Python and Node write hooks walk up to it.
// A trailing line, not a leading one, so every line number an error message quotes stays the same. A command whose end is not at the
// shell's top level (an unterminated heredoc, a trailing backslash) or that does not parse is left untagged: the comment would become data.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { platform } from "../platform/index.ts";

const TAG_PREFIX = "# cocheck-call:";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The tag as it appears anywhere (a process command line renders the newline as `\012` or a space); the last one wins. */
const TAG_ANYWHERE = /# cocheck-call:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})/g;
/** The tag exactly as `tagCommand` appends it, at the very end of a command. */
const TAG_AT_END = /\n# cocheck-call:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}$/;
/** Claude Code always prompts for a command past 10,000 characters; stay well clear so the tag never pushes one over. */
const MAX_COMMAND = 9_000;
const MAIN_AGENT = "main";

type ShellKind = ReturnType<typeof platform>["shellDialect"]["kind"];
export type TagSetting = "auto" | "on" | "off";

/**
 * `--attribution-tag on|auto|off` wins over `COCHECK_ATTRIBUTION_TAG`; `on` when neither says. `on` tags in every permission mode: the
 * a fenced live run showed a tagged `git status` still matched `Bash(git status:*)` under dontAsk and a tagged `rm -f x` was
 * still denied by `Bash(rm:*)`. `auto` tags only in bypassPermissions (the earlier, more cautious default); `off` never tags, sets no
 * environment and reads no evidence.
 */
export function parseTagSetting(argv: string[], env: NodeJS.ProcessEnv): TagSetting {
  const i = argv.indexOf("--attribution-tag");
  const raw = (i >= 0 ? argv[i + 1] : env.COCHECK_ATTRIBUTION_TAG)?.trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return "off";
  if (raw === "auto") return "auto";
  return "on";
}

/** Whether a call in this permission mode is tagged under `setting`. */
export function tagsInMode(setting: TagSetting, permissionMode: unknown): boolean {
  if (setting === "off") return false;
  if (setting === "on") return true;
  return permissionMode === "bypassPermissions";
}

/** The shell the host runs its shell calls in (`shellEnv` names the variable it sets), else `SHELL`; only bash and zsh are tagged. */
export function callShell(env: NodeJS.ProcessEnv, shellEnv?: string): string | undefined {
  for (const s of [shellEnv === undefined ? undefined : env[shellEnv], env.SHELL]) {
    if (!s || !path.isAbsolute(s)) continue;
    const base = path.basename(s);
    if ((base === "bash" || base === "zsh") && existsSync(s)) return s;
  }
  return undefined;
}

/** `sh -n` on `text`: true when it parses. Nothing runs (noexec). Any failure to check is "does not parse". */
function parses(shell: string, text: string): boolean {
  const args = path.basename(shell) === "zsh" ? ["-f", "-n", "-c", text] : ["-n", "-c", text];
  const r = spawnSync(shell, args, { stdio: ["ignore", "ignore", "ignore"], timeout: 2_000, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" } });
  return r.status === 0 && r.error === undefined;
}

/** Bash's `set -v` / `set -o verbose` (and zsh's `setopt verbose`) echo every line read, the comment included: such a command is left untagged. */
const VERBOSE = /(^|[^\w-])set\s+[^;&|\n]*(-[A-Za-z]*v|-o\s*verbose)|setopt\s+[^;&|\n]*v_?e_?r_?b_?o_?s_?e/i;

/**
 * The command with the tag appended, or null when it is left as it is: an id that is not plain, an empty or oversized command, one that
 * turns on verbose echo, still holds `# cocheck-call:` after any trailing tag lines are stripped, ends in a backslash, does not parse in
 * `shell`, or whose end is not at the top level (appending an unmatched quote still parses, so the end sits inside a heredoc body). A
 * command that already ends in tag lines (copied from an earlier call) has them replaced by this call's.
 */
export function tagCommand(raw: unknown, callId: unknown, agentId: unknown, shell: string): string | null {
  if (typeof raw !== "string" || typeof callId !== "string" || !ID.test(callId)) return null;
  const agent = agentId === undefined || agentId === null || agentId === "" ? MAIN_AGENT : agentId;
  if (typeof agent !== "string" || !ID.test(agent)) return null;
  let command = raw;
  while (TAG_AT_END.test(command)) command = command.replace(TAG_AT_END, "");
  if (command.trim() === "" || command.length > MAX_COMMAND || command.includes("\0") || command.includes(TAG_PREFIX)) return null;
  if (VERBOSE.test(command)) return null;
  if (/\\\s*$/.test(command)) return null;
  if (!parses(shell, command)) return null;
  if (parses(shell, `${command}\n'`)) return null;
  const tagged = `${command}\n${TAG_PREFIX}${callId}:${agent}`;
  if (!parses(shell, tagged)) return null;
  return tagged;
}

/** The command without a tag `tagCommand` appended; anything else is returned unchanged. */
export function stripTag(command: string): string {
  return command.replace(TAG_AT_END, "");
}

/** The call and agent of the last tag in a process command line, if any. */
export function tagInCommandLine(text: string): { call: string; agent: string } | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(TAG_ANYWHERE)) last = m as RegExpExecArray;
  return last ? { call: last[1]!, agent: last[2]! } : undefined;
}

/** Where the write hooks append their records: `<home>/attribution/`, never inside a watched folder (the home is refused there). */
export const evidenceDir = (home: string): string => path.join(home, "attribution");
/** The write hooks as shipped (src/ or dist/). Never named in the environment: a Homebrew upgrade can remove this folder mid-session. */
export const writeHooksDir = (): string => path.join(import.meta.dirname, "hooks");
/** The stable guard loaders the environment names, under the CoCheck home: each runs its target only if the target still exists. */
export const guardDir = (home: string): string => path.join(evidenceDir(home), "hooks");
/** Per session, a marker that a Pre tagged one of its calls; the write hooks look for nothing (no process walk) in a session without one. */
export const activeDir = (home: string): string => path.join(evidenceDir(home), "active");
/** Per session, a marker that SessionStart set the write hooks' environment; a Pre tags only a session that has one. */
const readyDir = (home: string): string => path.join(evidenceDir(home), "ready");
/** Per session, a file that exists only while the session is tracked (made by `cocheck track start`, removed by `stop`); the environment lines load no guard without it. */
export const onDir = (home: string): string => path.join(evidenceDir(home), "on");
export const rootsFile = (home: string): string => path.join(evidenceDir(home), "roots.json");
export const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const KEEP_MS = 3 * 86_400_000;

const dq = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The Node guard: requires the shipped preload when it exists, else does nothing. It never throws into the program. */
const nodeGuard = (target: string): string =>
  `"use strict";\n// CoCheck guard: loads the attribution write hook only while it exists (an upgrade can remove it).\ntry {\n  const t = ${JSON.stringify(target)};\n  if (require("node:fs").existsSync(t)) require(t);\n} catch {}\n`;

/** The Python guard: runs the shipped sitecustomize when it exists, then chains to the next sitecustomize on sys.path either way. */
const pythonGuard = (target: string): string => `# CoCheck guard: runs the attribution write hook only while it exists (an upgrade can remove it).
import os as _o
import sys as _s
_t = ${JSON.stringify(target)}
try:
    if _o.path.isfile(_t):
        with open(_t, "rb") as _f:
            exec(compile(_f.read(), _t, "exec"), {"__file__": _t, "__name__": "_cocheck_write_hook", "_COCHECK_GUARDED": True})
except Exception:
    pass


def _cocheck_chain():
    import importlib.machinery
    import importlib.util
    here = _o.path.dirname(_o.path.abspath(__file__))
    rest = [p for p in _s.path if _o.path.abspath(p or ".") != here]
    spec = importlib.machinery.PathFinder.find_spec("sitecustomize", rest)
    if spec is None or spec.loader is None or not spec.origin or _o.path.dirname(_o.path.abspath(spec.origin)) == here:
        return
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


try:
    _cocheck_chain()
except Exception:
    pass
`;

/**
 * SessionStart: writes the guard loaders and the folders the hooks may log (the registered folders, as given and resolved), prunes old
 * session markers, and returns the lines for `CLAUDE_ENV_FILE`. Every path the lines name lives under the CoCheck home, and each line
 * re-checks its file before each Bash call (the env file runs before every command), so a missing file sets nothing.
 */
export function prepareSession(home: string, session: unknown, roots: string[], nowMs: number, hooksDir = writeHooksDir(), dialect: ShellKind = platform().shellDialect.kind): string {
  const dir = guardDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(activeDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(readyDir(home), { recursive: true, mode: 0o700 });
  writeAtomic(path.join(dir, "cocheck-preload.cjs"), nodeGuard(path.join(hooksDir, "cocheck-preload.cjs")));
  writeAtomic(path.join(dir, "sitecustomize.py"), pythonGuard(path.join(hooksDir, "sitecustomize.py")));
  const all = new Set<string>();
  for (const r of roots) {
    if (!path.isAbsolute(r)) continue;
    all.add(path.resolve(r));
    try {
      all.add(realpathSync(r));
    } catch {
      // a folder that is gone logs nothing
    }
  }
  writeAtomic(rootsFile(home), JSON.stringify([...all].sort()) + "\n");
  for (const d of [activeDir(home), readyDir(home)]) {
    for (const name of readdirSync(d)) {
      const f = path.join(d, name);
      try {
        if (nowMs - statSync(f).mtimeMs > KEEP_MS) rmSync(f, { force: true });
      } catch {
        // raced with another session
      }
    }
  }
  if (typeof session !== "string" || !SESSION.test(session)) return "";
  writeFileSync(path.join(readyDir(home), session), "", { mode: 0o600 });
  return sessionEnvLines(home, session, dialect);
}

/** Whether SessionStart set the write hooks' environment for `session` (an install from before the write hooks has no SessionStart entry). */
export function sessionReady(home: string, session: unknown): boolean {
  return typeof session === "string" && SESSION.test(session) && existsSync(path.join(readyDir(home), session));
}

/** Marks `session` as tagged, so its Bash calls' children look for the tag. Throws when it cannot: the call is then left untagged. */
export function markSessionTagged(home: string, session: unknown): void {
  if (typeof session !== "string" || !SESSION.test(session)) throw new Error("session id is not plain");
  mkdirSync(activeDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(activeDir(home), session), "", { mode: 0o600 });
}

/**
 * The lines a SessionStart hook appends to `CLAUDE_ENV_FILE`. They are session-wide and carry no call id. Each export is guarded by a
 * file test, so a guard that is gone sets nothing; the Node path is quoted again inside NODE_OPTIONS.
 */
export function sessionEnvLines(home: string, session: string | undefined, dialect: ShellKind = platform().shellDialect.kind): string {
  if (session === undefined) return "";
  // The per-call tag is posix-only (the platform's shell dialect says so), so a session on any other dialect sets nothing:
  // a preload or a guard path that the session's node cannot load would break every node, python and `cocheck` run in it.
  if (dialect !== "posix") return "";
  const dir = guardDir(home);
  const preload = path.join(dir, "cocheck-preload.cjs");
  const nodeOpt = `--require ${JSON.stringify(preload)}`;
  // Every line tests the session's `on` file, so an untracked or stopped session loads no guard and sets nothing (the env file is
  // read before every Bash call, so the switch takes effect on the next call). One statement per line: callers may join the lines.
  const on = `[ -f ${dq(path.join(onDir(home), session))} ]`;
  // The call's tag, read from this shell's own command line while the shell is alive, for a child that outlives it (a forked pipeline
  // stage whose shell aborted: no ancestor is left for the hook to read). Set per call, and cleared on an untagged one. The value is
  // "<call>:<agent>", with no "cocheck-call" in it; it shows in an env dump.
  const callTag =
    `_it=$(/bin/ps -ww -o command= -p $$ 2>/dev/null | /usr/bin/grep -Eo '# cocheck-call:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}' | /usr/bin/tail -n 1); ` +
    `if [ -n "$_it" ]; then export COCHECK_WRITE_CALL="\${_it#*:}"; else unset COCHECK_WRITE_CALL; fi; unset _it`;
  return [
    `if ${on}; then ${callTag}; fi`,
    `if ${on}; then export COCHECK_WRITE_LOG=${dq(evidenceDir(home))} COCHECK_TAG_SESSION=${dq(session)}; fi`,
    `if ${on} && [ -f ${dq(path.join(dir, "sitecustomize.py"))} ]; then export PYTHONPATH=${dq(dir)}"\${PYTHONPATH:+:\$PYTHONPATH}"; fi`,
    `if ${on} && [ -f ${dq(preload)} ]; then export NODE_OPTIONS=${dq(nodeOpt)}"\${NODE_OPTIONS:+ \$NODE_OPTIONS}"; fi`,
    "",
  ].join("\n");
}
