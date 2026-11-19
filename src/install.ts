// The one install command: `node scripts/install.ts --home <dir> [--folder <dir>]` and `--uninstall`.
// It merges CoCheck's hook entries into the user-level Claude Code settings, registers a watched folder, fires the built hook once
// as a check, and only then prints "CoCheck records the folder your agent is opened in". Every entry it writes carries the marker COCHECK_MANAGED=1, and
// uninstall removes exactly the entries that carry it. Other keys, hooks and permissions are kept as values; the file is re-serialised,
// and the first backup (settings.json.cocheck-backup) holds the original bytes and is never overwritten.
// The hook command runs scripts/hook-launch.sh, which finds Node when the hook fires (a Node upgrade cannot break it) and writes
// <home>/not-recording.txt when the hook cannot record. A failed post-install check puts settings.json back to its pre-install bytes.
// The home the installer used is recorded in ~/.config/cocheck/install.json, which `cocheck open` and `cocheck status` read.
// Uninstall removes marked entries, stops the review process and says what stays on disk.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { KEYCHAIN_SERVICE } from "./seal.ts";
import path from "node:path";
import { resolveAdapterHome } from "./hook-adapter.ts";
import { platform, platformFor, type Platform } from "./platform/index.ts";
import { allProfiles, defaultProfile, findProfile, MARKER, type HostProfile } from "./hosts/index.ts";
import { addToRegistry, readRegistry, resolveFolder } from "./registry.ts";
import { heartbeatFilePath, isReviewProcessFor, lockFilePath, portFilePath, readPortFile } from "./review-server.ts";
import { cliCommand } from "./session-context.ts";
import { setTracking } from "./tracking.ts";
import { installSkill, missingSkillRoots, removeSkill, skillRootOf } from "./skill.ts";

export { MARKER };
const MIN_NODE = [22, 18, 0];
/** Where the launcher looks for Node after PATH. Same list as scripts/hook-launch.sh: Homebrew's stable opt/node paths first, then the plain bin links. */
const DEFAULT_NODE_SEARCH = "/opt/homebrew/opt/node/bin/node /usr/local/opt/node/bin/node /opt/homebrew/bin/node /usr/local/bin/node";
/** The cost the hook adds to every tool call of the hosts installed (`hosts` is their display names). docs/install.md states the same figure. */
export const hookTimingNote = (hosts: string[], windows = false): string => `every ${hosts.length === 0 ? "Claude Code" : hosts.join(" or ")} tool call runs CoCheck's hook twice, before and after it. ${windows ? "It adds a little time to each call; no timing has been measured on Windows yet." : "Together that is held under 1 second per call (median: 457 ms, measured on a Mac)."}`;

/** True when a file under the `src/` next to `dist/` is newer than the built hook. No `src/` (a packaged build) means not stale. */
export function builtHookIsStale(hookPath: string): boolean {
  const distDir = path.dirname(hookPath);
  if (path.basename(distDir) !== "dist") return false;
  const srcDir = path.join(path.dirname(distDir), "src");
  try {
    if (!statSync(srcDir).isDirectory()) return false;
    const builtAt = statSync(hookPath).mtimeMs;
    const newer = (dir: string): boolean => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() ? newer(full) : statSync(full).mtimeMs > builtAt) return true;
      }
      return false;
    };
    return newer(srcDir);
  } catch {
    return false;
  }
}

export interface InstallRun {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The built hook entry. Defaults to `dist/hook.js` of this checkout. */
  hookPath?: string;
  /** Runs the build when `hookPath` does not exist. Defaults to `npm run build` in this checkout. */
  build?: () => void;
  /** Test seam; defaults to the running Node. */
  nodeVersion?: string;
  /** Test seam; defaults to `process.platform`. */
  platform?: string;
  /** Test seam: the hook launcher. Defaults to `scripts/hook-launch.sh` of this checkout. */
  launcher?: string;
  /** Test seam: the install's own hook check, which spawns a process that knows only the built-in hosts. Defaults to `hookFires`. */
  hookFires?: typeof hookFires;
  /** Test seam: stops the review process recorded in a home (uninstall). Defaults to SIGTERM on a pid whose command line is a review process. */
  stopReview?: (home: string) => Promise<string>;
}

export interface InstallResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

class Refusal extends Error {}

const repoRoot = path.resolve(import.meta.dirname, "..");
/** The folder holding `dist/` and `scripts/`. The Homebrew wrapper exports COCHECK_ROOT as its stable `opt/cocheck/libexec`, so the hook command survives an upgrade (the Cellar path under it changes per version). */
function installRoot(env: NodeJS.ProcessEnv): string {
  const root = env.COCHECK_ROOT;
  return root !== undefined && path.isAbsolute(root) && existsSync(path.join(root, "package.json")) ? root : repoRoot;
}

function parseArgs(args: string[]): { home?: string; folder?: string; for?: string; uninstall: boolean } {
  const out: { home?: string; folder?: string; for?: string; uninstall: boolean } = { uninstall: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--uninstall") out.uninstall = true;
    else if (a === "--for") {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Refusal("--for needs a host (claude, codex, copilot), a comma list such as claude,copilot, both, all or none");
      out.for = v;
    } else if (a === "--home" || a === "--folder") {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Refusal(`${a} needs a directory`);
      out[a === "--home" ? "home" : "folder"] = v;
    } else throw new Refusal(`unknown argument ${a}`);
  }
  return out;
}

function checkNode(version: string): void {
  const have = version.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) > MIN_NODE[i]) return;
    if ((have[i] ?? 0) < MIN_NODE[i]) throw new Refusal(`Node ${MIN_NODE.join(".")} or newer is required; this is ${version}`);
  }
}

type HostInstall = NonNullable<HostProfile["install"]>;

/**
 * The folder that marks a host as present: the host's own config folder (~/.claude or $CLAUDE_CONFIG_DIR, ~/.codex or $CODEX_HOME,
 * ~/.copilot or $COPILOT_HOME). A host whose config file CoCheck owns (Copilot's hooks/cocheck.json) is marked by the folder above `hooks`.
 */
export function hostDir(profile: HostProfile, env: NodeJS.ProcessEnv, userHome: string): string {
  const file = profile.install!.configFile(env, userHome);
  return profile.install!.ownsFile === true ? path.dirname(path.dirname(file)) : path.dirname(file);
}
/** A host is present when its config folder exists on disk. A host's binary on PATH does not count: an install never creates a host's folder. */
export const hostPresent = (profile: HostProfile, env: NodeJS.ProcessEnv, userHome: string): boolean => profile.install !== undefined && existsSync(hostDir(profile, env, userHome));

/** Per host, whether its hooks ran lately, read from the hook journal's event lines (the newest `at` of each host). */
export function lastHookRuns(home: string): Map<string, number> {
  return new Map([...lastHookRunsDetailed(home)].map(([host, r]) => [host, r.at]));
}

/** As `lastHookRuns`, with the CoCheck version the newest event line names (`version`), when the line carries one. */
export function lastHookRunsDetailed(home: string): Map<string, { at: number; version?: string }> {
  const out = new Map<string, { at: number; version?: string }>();
  const dir = path.join(home, "journal");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return out;
  }
  const files = names.map((n) => ({ f: path.join(dir, n), m: statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 50);
  for (const { f } of files) {
    try {
      const size = statSync(f).size;
      const tail = readFileSync(f, "utf8").slice(-Math.min(size, 65536));
      for (const l of tail.split("\n")) {
        if (!l.includes('"k":"event"')) continue;
        const r = JSON.parse(l) as { host?: string; at?: string; version?: unknown };
        const at = Date.parse(r.at ?? "");
        if (r.host !== undefined && !Number.isNaN(at) && at > (out.get(r.host)?.at ?? 0)) out.set(r.host, typeof r.version === "string" && r.version !== "" ? { at, version: r.version } : { at });
      }
    } catch {
      // a partial first line of the tail or an unreadable file: skipped
    }
  }
  return out;
}
/** "just now", "12 min ago", "9 h ago", "3 days ago". */
export function ageText(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} days ago`;
}

/**
 * The hosts `--for` names: one key, a comma list (`claude,copilot`), `both` (an alias for `claude,codex`), `all` (every host with an installer)
 * or `none` (no host: the data home and review page only). No flag installs every host that is present (see hostPresent). Order and repeats do not matter.
 */
function hostsFor(value: string | undefined, env: NodeJS.ProcessEnv, userHome: string): HostProfile[] {
  const withInstaller = allProfiles().filter((p) => p.install !== undefined);
  if (value === undefined) return withInstaller.filter((p) => hostPresent(p, env, userHome));
  if (value === "none") return [];
  const keys = new Set<string>();
  for (const part of value.split(",")) {
    if (part === "both") {
      for (const p of withInstaller) if (p.install?.inBothAlias === true) keys.add(p.key);
    } else if (part === "all") for (const p of withInstaller) keys.add(p.key);
    else if (withInstaller.some((p) => p.key === part)) keys.add(part);
    else throw new Refusal(`--for must be ${withInstaller.map((p) => p.key).join(", ")}, a comma list of them, both, all or none, not ${JSON.stringify(value)}`);
  }
  return withInstaller.filter((p) => keys.has(p.key));
}

function writeAtomic(file: string, text: string | Buffer): void {
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, target);
}

/** Keep-first: the backup is written once, from the original bytes, and never replaced. */
function backupOnce(file: string, backup: string): void {
  if (existsSync(file) && !existsSync(backup)) copyFileSync(realpathSync(file), backup);
}

/**
 * Fires the hook once through the same launcher the settings will call, against a scratch home and folder, and returns an error text, or
 * undefined when it recorded the event. The person's own PATH is used, so a Node that only the installer could find fails here too.
 */
export function hookFires(launcher: string, hookPath: string, env: NodeJS.ProcessEnv = process.env, install: HostInstall = defaultProfile().install!, plat: Platform = platform()): string | undefined {
  const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-install-check-"));
  try {
    const home = path.join(scratch, "home");
    const folder = path.join(scratch, "folder");
    mkdirSync(folder);
    addToRegistry(home, folder);
    setTracking(home, install.hostFlag, "install-check", true, folder);
    const check = install.checkPayload?.(folder) ?? { payload: { session_id: "install-check", cwd: folder, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "install-check-1", tool_input: { command: "true" } } };
    const payload = JSON.stringify(check.payload);
    const hookArgs = ["--host", install.hostFlag, ...(check.event === undefined ? [] : ["--event", check.event]), ...(install.folderFromPayloadCwd === true ? [] : ["--folder", folder])];
    // On Windows the host starts `node hook-launch.mjs ...` itself (no shell script), so the check does the same, with the data home as a launcher option.
    const windows = plat.shellDialect.kind === "cmd";
    const res = spawnSync(windows ? "node" : plat.shellDialect.shell, windows ? [launcher, "COCHECK_MANAGED=1", "--home", home, hookPath, ...hookArgs] : [launcher, hookPath, ...hookArgs], {
      input: payload,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: env.PATH ?? "", HOME: scratch, ...(windows ? { USERPROFILE: scratch, ...(env.SystemRoot === undefined ? {} : { SystemRoot: env.SystemRoot }), TEMP: scratch, TMP: scratch } : {}), COCHECK_HOME: home, COCHECK_MANAGED: "1", ...(env.COCHECK_NODE_SEARCH === undefined ? {} : { COCHECK_NODE_SEARCH: env.COCHECK_NODE_SEARCH }), ...(env.COCHECK_NODE === undefined ? {} : { COCHECK_NODE: env.COCHECK_NODE }) },
    });
    if (res.status !== 0) return `the hook exited ${res.status ?? "abnormally"}: ${(res.stderr || res.error?.message || "").trim()}`;
    const journal = path.join(home, "journal");
    const wrote = existsSync(journal) && readdirSync(journal).some((n) => n.endsWith(".jsonl"));
    return wrote ? undefined : "the hook ran but recorded nothing in a registered folder";
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface InstallRecord {
  home: string;
  hookPath: string;
  launcher: string;
  /** Claude Code's settings file and its backup; `hosts` is the list of hosts this install put hooks into. */
  settingsFile: string;
  backupFile: string;
  hosts: Array<{ host: string; configFile: string; backupFile: string }>;
  /** The folder the last install watched; a later `--for codex` install reuses it. */
  folder: string;
  /** Folders the install created (a host's hooks folder, a `skills` folder); uninstall removes only these, and only when empty. */
  createdDirs: string[];
  installedAt: string;
}

export const installRecordPath = (userHome: string) => path.join(userHome, ".config", "cocheck", "install.json");

/** The record the installer wrote, or undefined when CoCheck is not installed for this user. */
export function readInstallRecord(userHome: string): InstallRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(installRecordPath(userHome), "utf8"));
    return typeof value?.home === "string" && typeof value?.hookPath === "string" && typeof value?.launcher === "string" && typeof value?.settingsFile === "string" && Array.isArray(value?.hosts) && Array.isArray(value?.createdDirs) && typeof value?.folder === "string" ? (value as InstallRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** Where the launcher looks for Node when `node` is not on the hook's PATH. Same list as scripts/hook-launch.sh. */
function nodeCandidates(env: NodeJS.ProcessEnv): string[] {
  return (env.COCHECK_NODE_SEARCH ?? DEFAULT_NODE_SEARCH).split(/\s+/).filter(Boolean);
}

/** The node the Homebrew wrapper exports as COCHECK_NODE: Homebrew's stable `opt/node` path, which survives a Node upgrade. */
function pinnedNode(env: NodeJS.ProcessEnv): string | undefined {
  const node = env.COCHECK_NODE;
  return node !== undefined && path.isAbsolute(node) && existsSync(node) ? node : undefined;
}

function findNode(env: NodeJS.ProcessEnv, plat: Platform = platform()): string | undefined {
  const pinned = pinnedNode(env);
  if (pinned !== undefined) return pinned;
  if (plat.shellDialect.kind === "cmd") {
    // Windows has no `sh`; `where node` lists every match, the first is the one a hook would start. The running Node is the fallback.
    const first = (spawnSync("where", ["node"], { encoding: "utf8", env: { PATH: env.PATH ?? "", ...(env.SystemRoot === undefined ? {} : { SystemRoot: env.SystemRoot }) } }).stdout ?? "").split(/\r?\n/)[0]!.trim();
    return first !== "" && existsSync(first) ? first : process.execPath;
  }
  const onPath = (spawnSync(plat.shellDialect.shell, ["-c", "command -v node"], { encoding: "utf8", env: { PATH: env.PATH ?? "" } }).stdout ?? "").trim();
  if (onPath !== "" && existsSync(onPath)) return onPath;
  return nodeCandidates(env).find((c) => existsSync(c));
}

export interface Status {
  /** True only when at least one installed host can record and nothing shared (hook files, Node, the launcher's note) is broken. */
  recording: boolean;
  /** Why something is not recording; empty when everything is. Includes the per-host reasons. */
  reasons: string[];
  /** The hosts that cannot record while another installed host can: one line each, "<Host> is not recording: <reason>". Empty unless the status is partial. */
  hostProblems?: string[];
  record?: InstallRecord;
  text: string;
}

/** What `cocheck status` prints and `cocheck open` prints first. Reads only; the reasons are the same ones the launcher writes and these checks add. */
export function installStatus(env: NodeJS.ProcessEnv, userHome: string, readHooksList?: (codexHome: string, env: NodeJS.ProcessEnv) => unknown, plat: Platform = platform()): Status {
  const record = readInstallRecord(userHome);
  if (record === undefined) {
    const reason = "CoCheck is not installed (no install record). Run: cocheck install --home <dir> --for <host>";
    return { recording: false, reasons: [reason], text: `CoCheck: not recording. ${reason}\n` };
  }
  const reasons: string[] = [];
  // Reasons that stop one host only; every other reason (hook files, Node, the launcher's note) stops them all. `full` is the line the whole-setup list prints.
  const hostBroken: { name: string; reason: string; full: string }[] = [];
  let installedHosts = 0;
  const recorded = record.hosts;
  if (recorded.length > 0 && (!existsSync(record.launcher) || !existsSync(record.hookPath))) {
    reasons.push(`the hook files are missing (${!existsSync(record.hookPath) ? record.hookPath : record.launcher}); the CoCheck folder moved or was rebuilt away. Run the installer again`);
  }
  // Each host's state: installed when the install put hooks in it and its config still carries them.
  const states: string[] = [];
  const ran = lastHookRunsDetailed(record.home);
  const fired = (key: string): string => {
    const last = ran.get(key);
    if (last === undefined) return "hooks have not fired yet";
    return `hooks last fired ${ageText(Date.now() - last.at)} (${new Date(last.at).toISOString()})${last.version === undefined ? "" : `, by CoCheck ${last.version}`}`;
  };
  for (const profile of allProfiles()) {
    const install = profile.install;
    const entry = recorded.find((h) => h.host === profile.key);
    if (install === undefined || entry === undefined) {
      states.push(`  ${profile.displayName}: not installed\n`);
      continue;
    }
    installedHosts++;
    try {
      const missing = install.missingEvents(existsSync(entry.configFile) ? readFileSync(entry.configFile, "utf8") : "", entry.configFile, plat);
      if (missing.length > 0) {
        const reason = `config files (${entry.configFile}) no longer carry CoCheck's hook for ${missing.join(", ")}. Run the installer again`;
        hostBroken.push({ name: profile.displayName, reason, full: `${profile.displayName} ${reason}` });
        states.push(`  ${profile.displayName}: hooks missing, run the installer again\n`);
      } else {
        // A host that skips untrusted hooks silently: its own trust state, read live when a reader is given.
        const trust = install.trustProblem?.(entry.configFile, env, record.hookPath, readHooksList);
        if (trust !== undefined) {
          hostBroken.push({ name: profile.displayName, reason: trust, full: trust });
          states.push(`  ${profile.displayName}: installed, hooks not trusted (${entry.configFile})\n`);
        } else states.push(`  ${profile.displayName}: installed (${entry.configFile}); ${fired(profile.key)}\n`);
      }
      const note = install.notes?.({ launcherDir: path.dirname(path.dirname(record.launcher)), home: record.home });
      if (note !== undefined) states.push(`    ${note}\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      hostBroken.push({ name: profile.displayName, reason, full: reason });
      states.push(`  ${profile.displayName}: config unreadable\n`);
    }
  }
  if (recorded.length === 0) reasons.push("no host has CoCheck's hooks (it was installed with --for none), so nothing is recorded. Run the installer again with --for (claude, codex, copilot, both or all)");
  // What this OS cannot do, one plain line each. The per-call tag finds its call through the process tree and a POSIX shell comment, so it works on macOS only.
  const absent = `${plat.office.liveExcel ? "" : "  Live Excel: not available on this system; CoCheck reads saved files only, not a workbook that is open.\n"}${plat.shellDialect.kind === "posix" ? "" : "  Per-call tag: not available on this system; writes are attributed by timing, not by which command made them.\n"}`;
  const node = findNode(env, plat);
  if (node === undefined) {
    reasons.push(`Node was not found on PATH or in ${nodeCandidates(env).join(", ")}; install Node ${MIN_NODE.join(".")} or newer`);
  } else {
    const version = (spawnSync(node, ["--version"], { encoding: "utf8" }).stdout ?? "").trim();
    try {
      checkNode(version);
    } catch (error) {
      reasons.push(`${error instanceof Error ? error.message : String(error)} (${node})`);
    }
  }
  try {
    const noted = readFileSync(path.join(record.home, "not-recording.txt"), "utf8").trim().split("\n");
    reasons.push(`the last hook run failed (${noted[0]}): ${noted.slice(1).join(" ")}`);
  } catch {
    // no note: the last hook that ran recorded
  }
  // "Not recording" is the whole setup: a shared fault, or every installed host broken. One broken host among working ones is named alone.
  if (reasons.length > 0 || (installedHosts > 0 && hostBroken.length === installedHosts)) {
    const all = [...reasons, ...hostBroken.map((h) => h.full)];
    return { recording: false, reasons: all, record, text: `CoCheck: not recording.\n${all.map((r) => `  ${r}\n`).join("")}${states.join("")}${absent}` };
  }
  const hostProblems = hostBroken.map((h) => `${h.name} is not recording: ${h.reason}`);
  let watching = "";
  try {
    watching = (readRegistry(record.home) ?? []).join(", ");
  } catch {
    // an unreadable registry is the hook's own refusal; the status stays about the hook
  }
  // Nothing has called the hook yet (no host fired): say installed-and-unseen, not "recording"; a host's first fire flips this line.
  const unseen = recorded.filter((h) => ran.get(h.host) === undefined).map((h) => allProfiles().find((p) => p.key === h.host)?.displayName ?? h.host);
  const lead = hostProblems.length === 0 && unseen.length === recorded.length && recorded.length > 0 ? `CoCheck: installed; not seen yet. Restart ${unseen.join(" and ")}, then say 'start tracking'` : `CoCheck: recording to ${record.home}`;
  return { recording: true, reasons: hostBroken.map((h) => h.full), hostProblems, record, text: `${hostProblems.map((l) => `${l}\n`).join("")}${lead}${watching === "" ? "" : ` (watching ${watching})`}.\n${states.join("")}${absent}` };
}

/** Bytes under `dir`, links not followed. */
function dirBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const st = lstatSync(path.join(dir, name));
    total += st.isDirectory() ? dirBytes(path.join(dir, name)) : st.size;
  }
  return total;
}

const sizeText = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Stops the review process recorded in `home`, only when that pid's command line is a review process. Returns a sentence for the output. */
export async function stopReviewProcess(home: string, plat: Platform = platform()): Promise<string> {
  const recorded = readPortFile(home);
  if (recorded === undefined) return "no review process was running";
  // Only a review process serving this home is signalled; any other pid (recycled, or another home's) is reported as not CoCheck's.
  if (!isReviewProcessFor(recorded.pid, home, plat)) return "no review process was running (the recorded pid is not CoCheck's review process for this data home, so it was left alone)";
  try {
    plat.process.terminate(recorded.pid);
  } catch {
    // Gone between the check and the signal is a stop; still alive (refused) is not.
    if (plat.process.alive(recorded.pid)) return `could not stop the review process (pid ${recorded.pid}); it is still running`;
    for (const f of [lockFilePath(home), portFilePath(home), heartbeatFilePath(home)]) rmSync(f, { force: true });
    return `stopped the review process (pid ${recorded.pid})`;
  }
  for (let i = 0; i < 50; i++) {
    if (!plat.process.alive(recorded.pid)) {
      // A hard kill (Windows) skips the process's own cleanup. Only a pid just verified as CoCheck's review process reaches here; review-port and review-token stay.
      for (const f of [lockFilePath(home), portFilePath(home), heartbeatFilePath(home)]) rmSync(f, { force: true });
      return `stopped the review process (pid ${recorded.pid})`;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return `asked the review process (pid ${recorded.pid}) to stop; it is still running`;
}

/** The path with symlinks resolved as far as it exists, so a link or a trailing slash cannot hide where it points. */
function realish(p: string): string {
  const rest: string[] = [];
  let cur = path.resolve(p);
  while (!existsSync(cur) && path.dirname(cur) !== cur) {
    rest.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  return path.join(existsSync(cur) ? realpathSync(cur) : cur, ...rest);
}

/** Whether `inner` is `outer` or lies inside it by resolved real path. */
function sameOrInside(inner: string, outer: string, plat: Platform): boolean {
  const fold = (x: string) => (plat.paths.foldsCase ? x.toLowerCase() : x);
  const rel = path.relative(fold(realish(outer)), fold(realish(inner)));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export async function runInstall(run: InstallRun): Promise<InstallResult> {
  let stdout = "";
  try {
    const args = parseArgs(run.argv.slice(2));
    const plat = platformFor(run.platform ?? process.platform);
    const windows = plat.shellDialect.kind === "cmd";
    const userHome = (windows ? run.env.USERPROFILE : undefined) || run.env.HOME || homedir();
    // An uninstall with no --for reverses every host the install record lists (else the hosts present); an install detects the hosts present.
    const recordedKeys = args.uninstall && args.for === undefined ? readInstallRecord(userHome) : undefined;
    const targets = recordedKeys !== undefined ? allProfiles().filter((p) => p.install !== undefined && recordedKeys.hosts.some((h) => h.host === p.key)) : hostsFor(args.for, run.env, userHome);
    const claudeInstall = defaultProfile().install!;
    const settingsFile = claudeInstall.configFile(run.env, userHome);
    const backupFile = `${settingsFile}.cocheck-backup`;
    const readText = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");
    const placeOf = (profile: HostProfile) => {
      const configFile = profile.install!.configFile(run.env, userHome);
      return { profile, install: profile.install!, configFile, backupFile: `${configFile}.cocheck-backup` };
    };

    if (args.uninstall) {
      const record = readInstallRecord(userHome);
      // Everything that can refuse runs before anything is written.
      const removals = targets.map((profile) => {
        const place = placeOf(profile);
        const done = existsSync(place.configFile) ? place.install.removeHooks(readText(place.configFile), place.configFile, plat) : { text: "", changed: false };
        return { ...place, ...done };
      });
      const home = args.home !== undefined ? path.resolve(args.home) : record?.home;
      const removed = removals.some((r) => r.changed);
      if (!removed && record === undefined && home === undefined) {
        const gone = removeSkill(userHome);
        return { exitCode: 0, stdout: `CoCheck: no hook entries to remove.\n${gone.map((f) => `CoCheck: removed the skill ${f}.\n`).join("")}`, stderr: "" };
      }
      for (const r of removals) {
        if (!r.changed) continue;
        // An install that created the file (no backup was ever made, since a backup is taken only of a file that existed) leaves nothing
        // behind when nothing but CoCheck's entries were in it: an absent config stays absent. A config that existed, even an empty one, is restored.
        const created = r.install.ownsFile !== true && r.text === "" && !existsSync(r.backupFile);
        // A file that is wholly CoCheck's (and carries its marker) has nothing of the person's in it to keep, so no backup is left behind for it.
        if (r.install.ownsFile !== true && !created) backupOnce(r.configFile, r.backupFile);
        // A file that is wholly CoCheck's goes whole; any other config is rewritten without CoCheck's entries.
        if (r.install.ownsFile === true) {
          rmSync(r.configFile, { force: true });
          // The folder CoCheck's install made for it goes too when it holds nothing else (a folder that was there before never does).
          try {
            if ((record?.createdDirs ?? []).includes(path.dirname(r.configFile))) rmdirSync(path.dirname(r.configFile));
          } catch {
            // not empty: it holds something of the person's
          }
        } else if (created) rmSync(r.configFile, { force: true });
        else writeAtomic(r.configFile, r.text);
        stdout += `CoCheck: hook entries removed from ${r.configFile}. Your other settings are untouched.\n`;
      }
      if (!removed) stdout += "CoCheck: no hook entries to remove.\n";
      // A host the install put hooks in and this uninstall did not name stays installed: the record, the review process and the data stay.
      const stays = record === undefined ? [] : record.hosts.filter((h) => !targets.some((t) => t.key === h.host));
      if (record !== undefined && stays.length > 0) {
        writeAtomic(installRecordPath(userHome), JSON.stringify({ ...record, hosts: stays }, null, 2) + "\n");
        stdout += `CoCheck is still installed for ${stays.map((h) => findProfile(h.host)?.displayName ?? h.host).join(" and ")}. Uninstall it with --for ${stays.map((h) => h.host).join(",")}.\n`;
        return { exitCode: 0, stdout, stderr: "" };
      }
      if (home !== undefined) stdout += `CoCheck: ${await (run.stopReview ?? ((h: string) => stopReviewProcess(h, plat)))(home)}.\n`;
      for (const f of removeSkill(userHome, record?.createdDirs ?? [])) stdout += `CoCheck: removed the skill ${f}.\n`;
      rmSync(installRecordPath(userHome), { force: true });
      try {
        rmdirSync(path.dirname(installRecordPath(userHome)));
        // ~/.config too, only when this install made it and nothing else is in it.
        if ((record?.createdDirs ?? []).includes(path.dirname(path.dirname(installRecordPath(userHome))))) rmdirSync(path.dirname(path.dirname(installRecordPath(userHome))));
      } catch {
        // not empty: it holds something of the person's
      }
      stdout += `What stays on this ${windows ? "PC" : "Mac"}:\n`;
      if (home !== undefined && existsSync(home)) stdout += `  your data: ${home} (${sizeText(dirBytes(home))}). Delete the folder to remove it.\n`;
      else stdout += `  your data: ${home === undefined ? "the data folder is unknown (no install record); look for the folder you gave --home" : `${home} (already gone)`}.\n`;
      stdout += windows
        ? `  The key that seals your data is a DPAPI-protected file in ${path.join(userHome, "AppData", "Local", "CoCheck", "secrets")}, one per data folder. Delete it only after deleting the data.\n`
        : `  Keychain item: "${KEYCHAIN_SERVICE}" in your login Keychain, one per data folder, holds the key that seals your data. Delete it in Keychain Access only after deleting the data.\n`;
      stdout += `  review-port and review-token in ${home === undefined ? "the data folder" : home}: the review page's port and access token. They stay with your data and are reused by a reinstall.\n`;
      for (const r of removals) stdout += `  settings backup: ${existsSync(r.backupFile) ? `${r.backupFile}, a copy of your settings made by the first install` : "none was made"}.\n`;
      if (removals.length === 0) stdout += "  settings backup: none was made.\n";
      return { exitCode: 0, stdout, stderr: "" };
    }

    if (!["darwin", "win32"].includes(run.platform ?? process.platform)) throw new Refusal("CoCheck runs on a Mac or Windows only");
    // An install for Codex reuses --home and --folder from the record a first install wrote, so the person need not repeat them.
    // Codex's hook has no --folder, so this folder is only the one registered as watched. Other hosts keep the strict rules.
    const reuse = targets.some((t) => t.install?.reusesRecord === true) ? readInstallRecord(userHome) : undefined;
    const homeArg = args.home ?? reuse?.home;
    if (!homeArg) throw new Refusal("--home <dir> is required: CoCheck picks no default place for its data");
    if (!path.isAbsolute(homeArg)) throw new Refusal("--home must be an absolute path");
    const dataHome = path.resolve(homeArg);
    resolveAdapterHome({ COCHECK_HOME: dataHome }, path.join(userHome, ".cocheck"));
    let recordedFolder = reuse?.folder;
    if (reuse !== undefined && recordedFolder === undefined) {
      try {
        recordedFolder = readRegistry(reuse.home)?.at(-1);
      } catch {
        // an unreadable registry: fall back to the folder the command runs from
      }
    }
    const folderArg = args.folder ?? recordedFolder ?? run.cwd;
    if (!existsSync(folderArg) || !statSync(folderArg).isDirectory()) throw new Refusal(`${folderArg} is not a folder`);
    const folder = resolveFolder(folderArg);
    // CoCheck owns every file in its data folder (it sets their modes), so that folder must be one nothing of the person's lives in.
    const homeOwners = [userHome, plat.paths.userHome()];
    for (const owner of homeOwners) {
      if (sameOrInside(owner, dataHome, plat)) throw new Refusal("--home must be a folder only for CoCheck's data, not your home folder or one that holds it");
    }
    if (sameOrInside(folder, dataHome, plat)) throw new Refusal("--home must be a folder only for CoCheck's data, not the watched folder or one that holds it");

    checkNode(run.nodeVersion ?? process.version);
    stdout += `Node: ${run.nodeVersion ?? process.version}\n`;

    // Everything that can refuse runs before anything is written, for every host: a config CoCheck cannot edit stops the whole install.
    const plans = targets.map((profile) => {
      const place = placeOf(profile);
      place.install.addHooks(readText(place.configFile), place.configFile, undefined, plat);
      const original = existsSync(place.configFile) ? readFileSync(realpathSync(place.configFile)) : undefined;
      return { ...place, original, hadBackup: existsSync(place.backupFile), written: "" };
    });
    readRegistry(dataHome);
    const root = installRoot(run.env);
    const hookPath = run.hookPath ?? path.join(root, "dist", "hook.js");
    const launcher = run.launcher ?? path.join(root, "scripts", windows ? "hook-launch.mjs" : "hook-launch.sh");
    if (plans.length > 0) {
      if (!existsSync(launcher)) throw new Refusal(`the hook launcher ${launcher} does not exist`);
      if (!existsSync(hookPath) || builtHookIsStale(hookPath)) {
        (run.build ?? (() => { const r = spawnSync("npm", ["run", "build"], { cwd: repoRoot, encoding: "utf8" }); if (r.status !== 0) throw new Refusal(`build failed: ${(r.stderr || "").slice(-400)}`); }))();
      }
      if (!existsSync(hookPath)) throw new Refusal(`the built hook ${hookPath} does not exist; run npm run build`);
    }

    // No Node path is pinned, so a Node upgrade cannot break the entry, except under Homebrew: the wrapper exports COCHECK_NODE (its
    // stable opt/node path), and the entry carries it so the hook runs the same Node as `cocheck` and never a Cellar path.
    const pinned = pinnedNode(run.env);
    for (const plan of plans) plan.written = plan.install.addHooks(readText(plan.configFile), plan.configFile, { dataHome, launcher, hookPath, host: plan.install.hostFlag, ...(pinned === undefined ? {} : { node: pinned }) }, plat);

    // From here a failure puts every config back as it was. If the person edited one meanwhile, only CoCheck's marked entries come out of it.
    const skillSkipped: string[] = [];
    const touched: typeof plans = [];
    const rollBackOne = (plan: (typeof plans)[number]): string => {
      const name = path.basename(plan.configFile);
      const target = existsSync(plan.configFile) ? realpathSync(plan.configFile) : plan.configFile;
      if (existsSync(target) && readFileSync(target, "utf8") === plan.written) {
        if (plan.original === undefined) rmSync(target, { force: true });
        else writeAtomic(plan.configFile, plan.original);
        if (!plan.hadBackup) rmSync(plan.backupFile, { force: true });
        return `${name} is back to how it was before the install`;
      }
      try {
        const now = plan.install.removeHooks(readText(plan.configFile), plan.configFile, plat);
        if (now.changed) writeAtomic(plan.configFile, now.text);
        return `${name} changed during the install, so only CoCheck's own entries were removed`;
      } catch {
        return `${name} could not be restored; run --uninstall to remove CoCheck's entries`;
      }
    };
    const rollBack = (): string => touched.map(rollBackOne).join("; ");
    // The folders this install creates, noted before anything is written, so uninstall removes only those.
    const made = [path.dirname(path.dirname(installRecordPath(userHome))), ...plans.filter((p) => p.install.ownsFile === true).map((p) => path.dirname(p.configFile)), ...missingSkillRoots(userHome, plans.map((p) => skillRootOf(p.profile.key))), ...plans.map((p) => path.dirname(path.join(userHome, skillRootOf(p.profile.key))))].filter((d) => !existsSync(d));
    try {
      for (const plan of plans) {
        backupOnce(plan.configFile, plan.backupFile);
        touched.push(plan);
        writeAtomic(plan.configFile, plan.written);
      }
      for (const plan of plans) {
        const failed = (run.hookFires ?? hookFires)(launcher, hookPath, run.env, plan.install, plat);
        if (failed !== undefined) {
          return { exitCode: 1, stdout, stderr: `cocheck install: the hook check failed (${plans.length > 1 ? `${plan.profile.displayName}: ` : ""}${failed}). Nothing was installed: ${rollBack()}.\n` };
        }
      }
      addToRegistry(dataHome, folder);
      // The Node this install resolved, for the launcher's last-resort lookup (scripts/hook-launch.sh). The hook command itself is unchanged.
      if (!windows) writeAtomic(path.join(dataHome, "installed-node.txt"), `${findNode(run.env, plat) ?? process.execPath}\n`);
      installSkill(userHome, cliCommand(root), plans.map((p) => skillRootOf(p.profile.key)), skillSkipped, windows);
      const previous = readInstallRecord(userHome);
      const record: InstallRecord = {
        home: dataHome,
        hookPath,
        launcher,
        settingsFile,
        backupFile,
        // Hosts an earlier run installed stay recorded: this run's entry replaces the same host's, and `--for none` drops nothing.
        hosts: [
          ...(previous === undefined ? [] : previous.hosts).filter((h) => !plans.some((p) => p.profile.key === h.host)),
          ...plans.map((p) => ({ host: p.profile.key, configFile: p.configFile, backupFile: p.backupFile })),
        ],
        folder,
        createdDirs: [...new Set([...(previous?.createdDirs ?? []), ...made])],
        installedAt: new Date().toISOString(),
      };
      writeAtomic(installRecordPath(userHome), JSON.stringify(record, null, 2) + "\n");
    } catch (error) {
      const how = rollBack();
      throw new Refusal(`${error instanceof Error ? error.message : String(error)}. Nothing was installed: ${how}`);
    }
    stdout += `CoCheck records the folder your agent is opened in. The install check ran in ${folder}\n`;
    // What was written where, per host; a host that was not present is named so the person sees why nothing went there.
    if (args.for === undefined) {
      const absent = allProfiles().filter((p) => p.install !== undefined && !plans.some((x) => x.profile.key === p.key));
      if (plans.length === 0) stdout += `No host found: none of ${absent.map((p) => hostDir(p, run.env, userHome)).join(", ")} exists, so no hooks or skill were installed. Start the host once, or name it with --for.\n`;
      else if (absent.length > 0) stdout += `Not installed (no config folder found): ${absent.map((p) => p.displayName).join(", ")}.\n`;
    }
    for (const p of plans) {
      const skillFile = path.join(userHome, skillRootOf(p.profile.key), "cocheck", "SKILL.md");
      stdout += `${p.profile.displayName}: hooks in ${p.configFile}; ${skillSkipped.includes(skillFile) ? `skill NOT written, ${skillFile} is not CoCheck's and stays` : `skill in ${skillFile}`}.\n`;
    }
    stdout += "Every session starts untracked. In a session, say \"start tracking\" (the cocheck skill runs `cocheck track start`) and \"stop tracking\" to switch it.\n";
    // A source checkout is run as `node scripts/cocheck.ts`; a packaged install (no scripts/cocheck.ts) has `cocheck` on PATH.
    const cli = cliCommand(root);
    stdout += `Open the review page: ${cli} open\n`;
    stdout += `Check that it is recording: ${cli} status\n`;
    stdout += `${plans.map((p) => p.install.afterInstall).filter((t) => t !== undefined).join(" ")}${plans.some((p) => p.install.afterInstall !== undefined) ? " " : ""}Good to know:\n`;
    for (const p of plans) {
      const note = p.install.notes?.({ launcherDir: root, home: dataHome });
      if (note !== undefined) stdout += `  ${p.profile.displayName}: ${note}\n`;
    }
    stdout += `  Needs Node ${MIN_NODE[0]}.${MIN_NODE[1]} or newer; an upgrade of Node does not break the hook.\n`;
    stdout += `  Key: the key that seals your data is kept in ${plat.secretStore.location(KEYCHAIN_SERVICE)}, one per data folder. It stays when you uninstall.\n`;
    stdout += "  Disk: up to 1 GB per task for the saved file states, in your data folder.\n";
    if (plans.length > 0) {
      stdout += `  Hook timing: ${hookTimingNote(plans.map((p) => (p.install.timingLabel ?? p.profile.displayName)), windows)}\n`;
      const telling = plans.filter((p) => p.install.promptContext !== false);
      if (telling.length > 0) stdout += `  CoCheck tells ${telling.map((p) => p.profile.displayName).join(" or ")}, at the start of each request in a tracked session, to save its work inside that folder and to run the open command when you ask to see the review.\n`;
    }
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    return { exitCode: 1, stdout, stderr: `cocheck install: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}
