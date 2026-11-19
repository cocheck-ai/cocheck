// How CoCheck launches a connector program on any OS: an argv array, no shell, no shebang reliance. Not per-OS: the OS name is a parameter,
// so the Windows rules run (and are pinned) on every machine. A bare name resolves through PATH (and PATHEXT on Windows). A `.cmd` or `.bat` file
// runs through `cmd.exe /d /s /c` with every argument escaped, because Node refuses to spawn a batch file without a shell (CVE-2024-27980).
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export interface SpawnPlan {
  command: string;
  args: string[];
  /** True when `args` is a ready command line cmd.exe must not re-quote (Windows batch files). */
  verbatim: boolean;
}

export interface ResolveOptions {
  /** The OS name (`process.platform` values). */
  os: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Whether a regular file that may be run exists at `file`. Injected by tests. */
  isRunnable?: (file: string) => boolean;
}

function envValue(env: NodeJS.ProcessEnv, key: string, os: string): string | undefined {
  if (os !== "win32") return env[key];
  const found = Object.keys(env).find((k) => k.toUpperCase() === key);
  return found === undefined ? undefined : env[found];
}

function defaultRunnable(os: string): (file: string) => boolean {
  return (file) => {
    try {
      if (!statSync(file).isFile()) return false;
      if (os !== "win32") accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

/** The file a program name runs, or undefined when none is found. Relative names with a separator resolve from `cwd`; bare names through PATH. */
export function resolveProgram(name: string, options: ResolveOptions): string | undefined {
  const win = options.os === "win32";
  const sep = win ? /[\\/]/ : /\//;
  const runnable = options.isRunnable ?? defaultRunnable(options.os);
  const pathMod = win ? path.win32 : path.posix;
  const exts = win ? (envValue(options.env, "PATHEXT", "win32") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "") : [""];
  const candidates = (base: string): string[] => {
    if (!win) return [base];
    const hasExt = exts.some((e) => base.toUpperCase().endsWith(e.toUpperCase()));
    return hasExt ? [base] : [...exts.map((e) => base + e), base];
  };
  const isPath = sep.test(name);
  const dirs = isPath ? [] : (envValue(options.env, "PATH", options.os) ?? "").split(win ? ";" : ":").filter((d) => d !== "");
  const bases = isPath ? [pathMod.isAbsolute(name) ? name : pathMod.resolve(options.cwd, name)] : dirs.map((d) => pathMod.join(d.replace(/^"(.*)"$/, "$1"), name));
  for (const base of bases) for (const c of candidates(base)) if (runnable(c)) return c;
  return undefined;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument as cmd.exe and then the child's C runtime read it back unchanged (the cross-spawn scheme): quote for the CRT, then ^-escape every cmd metacharacter, the quotes included. */
export function escapeCmdArgument(arg: string): string {
  if (/[\0\r\n]/.test(arg)) throw new Error("an argument with a newline or NUL cannot be passed to a .cmd or .bat file");
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1");
}

/** The command and arguments that start `argv` (program first), as Node's `spawn` takes them with no shell. */
export function planSpawn(argv: string[], options: ResolveOptions): SpawnPlan {
  if (argv.length === 0 || argv[0] === "") throw new Error("the connector's run command is empty");
  const program = resolveProgram(argv[0] as string, options);
  if (program === undefined) {
    throw new Error(`the program "${argv[0]}" was not found${options.os === "win32" ? " on PATH (tried PATHEXT)" : " on PATH"}`);
  }
  const rest = argv.slice(1);
  if (options.os === "win32" && /\.(?:cmd|bat)$/i.test(program)) {
    const comspec = envValue(options.env, "COMSPEC", "win32") ?? "cmd.exe";
    const line = [escapeCmdArgument(program), ...rest.map(escapeCmdArgument)].join(" ");
    return { command: comspec, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
  }
  return { command: program, args: rest, verbatim: false };
}

/** The variables every connector gets (when the machine has them), whatever its manifest says: where programs are found, where temp and home are, and the language. */
export const CONNECTOR_BASE_ENV = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "COMSPEC", "PATHEXT", "LANG"] as const;

/**
 * The variables CoCheck sets on every connector itself (spec v1 "Helpers"), never copied from its own environment, so a value planted
 * in CoCheck's environment never reaches a connector. With CONNECTOR_BASE_ENV this is the spec's "fixed base set" (Manifest additions, `permissions`).
 */
export const CONNECTOR_SET_ENV = ["COCHECK_HELPERS_DIR"] as const;
/** The fixed base set every connector may see, whatever its manifest says: the copied base plus the variables CoCheck sets. */
export const CONNECTOR_FIXED_ENV = [...CONNECTOR_BASE_ENV, ...CONNECTOR_SET_ENV] as const;

/** The entries of `source` whose names are in `names`, and no others. A name matches exactly, except on Windows, where variable names are case-insensitive. */
export function pickEnv(source: NodeJS.ProcessEnv, names: readonly string[], os: string = process.platform): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const key = os === "win32" ? Object.keys(source).find((k) => k.toUpperCase() === name.toUpperCase()) : Object.hasOwn(source, name) ? name : undefined;
    const value = key === undefined ? undefined : source[key];
    if (key !== undefined && typeof value === "string") out[key] = value;
  }
  return out;
}

/** The environment a connector is started with: the fixed base plus the names its manifest lists in `permissions.env`, taken from `source`. Nothing else of `source`. */
export function connectorEnv(source: NodeJS.ProcessEnv, permitted: readonly string[] = [], os: string = process.platform): Record<string, string> {
  return pickEnv(source, [...CONNECTOR_BASE_ENV, ...permitted], os);
}

/**
 * `base` with `override` laid over it. On Windows variable names are case-insensitive: a `base` key that matches an `override` key in any case is
 * dropped first, so a caller's PATH replaces the inherited Path instead of sitting beside it as a second key the child never reads.
 */
export function mergeEnv(base: NodeJS.ProcessEnv, override: NodeJS.ProcessEnv = {}, os: string = process.platform): NodeJS.ProcessEnv {
  if (os !== "win32") return { ...base, ...override };
  const replaced = new Set(Object.keys(override).map((k) => k.toUpperCase()));
  return { ...Object.fromEntries(Object.entries(base).filter(([k]) => !replaced.has(k.toUpperCase()))), ...override };
}

/**
 * Starts a program with piped stdio and no shell. Throws (naming the program) when it cannot be found. The child gets `process.env` plus `options.env`;
 * with `exactEnv` it gets `options.env` alone (a connector's allow-listed environment).
 */
export function spawnPiped(argv: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; exactEnv?: boolean }): ChildProcess {
  const env = options.exactEnv === true ? { ...options.env } : mergeEnv(process.env, options.env);
  const plan = planSpawn(argv, { os: process.platform, env, cwd: options.cwd });
  return spawn(plan.command, plan.args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: plan.verbatim, shell: false });
}
