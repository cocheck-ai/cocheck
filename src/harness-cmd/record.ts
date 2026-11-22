// `cocheck harness record <key> --manifest <path> --out <dir> [-- <harness command...>]`: records the raw hook calls a harness makes, for a manifest to be written from.
//
// Safety invariant:
//  - It writes only under <out> and its own scratch folder. The manifest's install path is resolved against the scratch folder only (a scratch HOME, and a scratch
//    folder for each environment variable the path names), and a path that lands outside the scratch folder is refused. The person's real config files are never written.
//  - It signals only the process it spawned, by that process's handle (timeout, interrupt), never by name or by a recorded pid.
//  - It removes nothing recursively except its own scratch folder at the end, and only one that carries its marker file.
//  - On an interrupt it stops its child, writes what was recorded so far to <out>, and removes its scratch folder.
// Every file written to <out> is scrubbed (emails, the home path); a token-shaped string left over fails the run and nothing is written.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { platform } from "../platform/index.ts";
import { INSTALL_OWN, MANIFEST_FILE, validateManifest, type HarnessManifest } from "../hosts/manifest.ts";
import { jsonHookEditor, validateInstallBlock } from "../hosts/install-block.ts";
import { findTokenShapes, scrubText } from "./scrub.ts";
import type { HarnessIo } from "./index.ts";

export const RECORD_USAGE = "usage: cocheck harness record <key> --manifest <path> --out <dir> [--timeout <seconds>] [-- <harness command...>]\n       cocheck harness record --stop <scratch>";
const SCRATCH_PREFIX = "cocheck-record-";
export const MARKER = ".cocheck-record-scratch";
const DEFAULT_TIMEOUT_S = 600;

// The logging hook: one line per call. Its arguments are the payload file, the payload path of the event name ("-" when the command names it), then what the harness passed.
const LOG_HOOK = `import { appendFileSync } from "node:fs";
const [file, evPath, ...rest] = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let event = "";
  const i = rest.indexOf("--event");
  if (i >= 0) event = rest[i + 1] ?? "";
  else if (evPath !== "-") {
    try {
      let v = JSON.parse(input);
      for (const part of evPath.split(/[.\\[\\]]+/).filter(Boolean)) v = v?.[/^\\d+$/.test(part) ? Number(part) : part];
      if (typeof v === "string") event = v;
    } catch {}
  }
  appendFileSync(file, JSON.stringify({ event, argv: rest, stdin: input, ts: Date.now() / 1000 }) + "\\n");
});
`;

/** The `{...}` tokens of a path template at its top level (a token inside a fallback is not one). */
function topTokens(template: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== "{") continue;
    let depth = 1;
    let j = i + 1;
    for (; j < template.length && depth > 0; j++) depth += template[j] === "{" ? 1 : template[j] === "}" ? -1 : 0;
    out.push(template.slice(i + 1, j - 1));
    i = j - 1;
  }
  return out;
}

const within = (parent: string, child: string): boolean => child === parent || child.startsWith(parent + path.sep);
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const real = (p: string): string => {
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur) && path.dirname(cur) !== cur) {
    rest.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  return path.join(realpathSync(cur), ...rest);
};

export interface RecordOptions {
  key: string;
  manifest: string;
  out: string;
  command?: string[];
  timeoutSeconds?: number;
  /** The environment the harness command starts with (the scratch overrides are added). Default: this process's. */
  env?: NodeJS.ProcessEnv;
  /** Where scratch folders are made. Default: the OS temp folder. */
  tmpRoot?: string;
  /** The real home, which `out` may not be inside the harness's config folder of. Default: this process's home. */
  realHome?: string;
  signal?: AbortSignal;
  cwd?: string;
}

export interface RecordResult {
  exitCode: number;
  /** Set when the harness command was not run: the scratch folder, for `--stop`. */
  scratch?: string;
  lines: number;
  interrupted?: boolean;
  messages: string[];
}

/** Resolves where the harness's hook config goes inside `scratch` and the environment that makes the harness read it from there. */
function scratchConfig(m: HarnessManifest, scratch: string): { file: string; env: Record<string, string>; home: string } {
  const install = m.install;
  if (install === undefined || install.editorExtra !== undefined) throw new Error("the manifest has no JSON install block, so record cannot set up the hooks. Add an install block, or log the harness's hook calls by hand.");
  const home = path.join(scratch, "home");
  const env: Record<string, string> = {};
  const tokens = topTokens(install.path as string);
  for (const t of tokens) if (t.startsWith("env:")) {
    const name = (t.slice(4).split("|")[0] ?? "").trim();
    env[name] = path.join(scratch, "env", name);
  }
  if (tokens.includes("home")) env.HOME = home;
  // A workspace-scoped config ({project}) goes in the scratch work folder, where the harness command runs.
  const project = path.join(scratch, "work");
  const block = validateInstallBlock(Object.fromEntries(Object.entries(install).filter(([k]) => !(INSTALL_OWN as readonly string[]).includes(k))), "install");
  const file = jsonHookEditor(block).configFile(env, home, project);
  if (!within(real(scratch), real(file))) throw new Error(`the manifest's install path resolves outside the scratch folder (${file}); refusing to write it`);
  return { file, env, home };
}

function writeSetup(m: HarnessManifest, scratch: string, payloads: string): { env: Record<string, string>; configFile: string } {
  const { file, env, home } = scratchConfig(m, scratch);
  const block = validateInstallBlock(Object.fromEntries(Object.entries(m.install!).filter(([k]) => !(INSTALL_OWN as readonly string[]).includes(k))), "install");
  const hookScript = path.join(scratch, "log-hook.mjs");
  writeFileSync(hookScript, LOG_HOOK);
  const evPath = "payload" in m.eventFrom ? m.eventFrom.payload : "-";
  const base = `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)} ${JSON.stringify(payloads)} ${JSON.stringify(evPath)}`;
  const plat = platform();
  const shim = { ...plat, hookCommand: { ...plat.hookCommand, build: () => base } };
  const text = jsonHookEditor(block).addHooks("", file, {} as never, shim as never);
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(file, text);
  return { env, configFile: file };
}

/** Scrubs the recorded lines into <out>/payloads.jsonl and removes the scratch folder. Returns the line count, or a failure message. */
function finish(scratch: string, out: string, realHome: string): { lines: number; failure?: string } {
  const marker = path.join(scratch, MARKER);
  const payloads = path.join(scratch, "payloads.jsonl");
  let failure: string | undefined;
  let lines = 0;
  try {
    if (existsSync(payloads)) {
      const homes = [realHome, real(realHome), homedir(), real(homedir())];
      const clean = scrubText(readFileSync(payloads, "utf8"), homes);
      const shapes = findTokenShapes(clean);
      if (shapes.length > 0) failure = `token-shaped string left after scrubbing (${shapes.join(", ")}); nothing was written to ${out}`;
      else {
        lines = clean.split("\n").filter(Boolean).length;
        const dst = path.join(out, "payloads.jsonl");
        if (existsSync(dst)) failure = `${dst} already exists; nothing was written`;
        else if (lines > 0) {
          mkdirSync(out, { recursive: true });
          writeFileSync(dst, clean);
        }
      }
    }
  } finally {
    // Only a folder this command made: a real folder (not a link) that carries the marker.
    if (existsSync(marker) && lstatSync(scratch).isDirectory() && !lstatSync(scratch).isSymbolicLink() && path.basename(scratch).startsWith(SCRATCH_PREFIX)) rmSync(scratch, { recursive: true, force: true });
  }
  return failure === undefined ? { lines } : { lines: 0, failure };
}

export async function recordRun(o: RecordOptions): Promise<RecordResult> {
  const messages: string[] = [];
  const res = (exitCode: number, extra: Partial<RecordResult> = {}): RecordResult => ({ exitCode, lines: 0, messages, ...extra });
  const cwd = o.cwd ?? process.cwd();
  const realHome = o.realHome ?? homedir();
  let m: HarnessManifest;
  try {
    const manifestPath = path.resolve(cwd, o.manifest);
    m = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")), path.basename(path.dirname(manifestPath)) + "/" + MANIFEST_FILE, { outsider: true });
  } catch (error) {
    messages.push(`cannot use the manifest ${o.manifest}: ${error instanceof Error ? error.message : String(error)}`);
    return res(1);
  }
  if (m.key !== o.key) {
    messages.push(`the manifest's key is ${JSON.stringify(m.key)}, not ${JSON.stringify(o.key)}`);
    return res(1);
  }
  const out = path.resolve(cwd, o.out);
  if (existsSync(path.join(out, "payloads.jsonl"))) {
    messages.push(`${path.join(out, "payloads.jsonl")} already exists; pick a new --out folder. Nothing was written.`);
    return res(1);
  }
  const baseEnv = o.env ?? process.env;
  // `out` may not sit inside the folder of the harness's real config.
  try {
    const realCfg = jsonHookEditor(validateInstallBlock(Object.fromEntries(Object.entries(m.install ?? {}).filter(([k]) => !(INSTALL_OWN as readonly string[]).includes(k))), "install")).configFile(baseEnv, realHome, cwd);
    if (within(real(path.dirname(realCfg)), real(out))) {
      messages.push(`refusing to write inside ${path.dirname(realCfg)}, the folder of the harness's own config: ${out}`);
      return res(1);
    }
  } catch {
    // no JSON install block, or an unset required variable: scratchConfig reports it below
  }
  const root = o.tmpRoot ?? tmpdir();
  mkdirSync(root, { recursive: true });
  const scratch = real(mkdtempSync(path.join(root, SCRATCH_PREFIX)));
  writeFileSync(path.join(scratch, MARKER), JSON.stringify({ schema: "cocheck-record-scratch/1", key: o.key, out }) + "\n");
  if (within(scratch, real(out))) {
    finish(scratch, out, realHome);
    messages.push("--out may not be inside the scratch folder");
    return res(1);
  }
  const work = path.join(scratch, "work");
  const payloads = path.join(scratch, "payloads.jsonl");
  let setup: { env: Record<string, string>; configFile: string };
  try {
    mkdirSync(work);
    writeFileSync(payloads, "");
    setup = writeSetup(m, scratch, payloads);
  } catch (error) {
    finish(scratch, out, realHome);
    messages.push(error instanceof Error ? error.message : String(error));
    return res(1);
  }
  const env = { ...baseEnv, ...setup.env } as NodeJS.ProcessEnv;
  if (o.command === undefined || o.command.length === 0) {
    messages.push(
      `Scratch folder: ${scratch}\nHook config written for the harness (scratch only): ${setup.configFile}\nIn the shell you will run the harness from:\n` +
        `${Object.entries(setup.env).map(([k, v]) => `  export ${k}=${shq(v)}`).join("\n")}${Object.keys(setup.env).length ? "\n" : ""}  cd ${shq(work)}\n` +
        `Run your harness there, then finish with:\n  cocheck harness record --stop ${shq(scratch)}`,
    );
    return res(0, { scratch });
  }
  // The harness command runs in the scratch work folder; only this child, by its handle, is ever signalled.
  const timeoutMs = (o.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000;
  const child = spawn(o.command[0]!, o.command.slice(1), { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderrTail = "";
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (c) => (stderrTail = (stderrTail + c).slice(-500)));
  let timedOut = false;
  let interrupted = false;
  const stop = (): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 3000).unref();
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const onAbort = (): void => {
    interrupted = true;
    stop();
  };
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener("abort", onAbort);
  const status = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.on("error", (error) => resolve({ code: null, error }));
    child.on("close", (code) => resolve({ code }));
  });
  clearTimeout(timer);
  o.signal?.removeEventListener("abort", onAbort);
  const fin = finish(scratch, out, realHome);
  if (fin.failure !== undefined) {
    messages.push(fin.failure);
    return res(1, { interrupted });
  }
  if (status.error) messages.push(`could not start the harness command: ${status.error.message}`);
  else if (interrupted) messages.push("interrupted: the harness command was stopped");
  else if (timedOut) messages.push(`the harness command was stopped after ${o.timeoutSeconds ?? DEFAULT_TIMEOUT_S} seconds`);
  else if (status.code !== 0) messages.push(`the harness command exited with ${status.code}: ${stderrTail.trim()}`);
  if (fin.lines === 0) messages.push("no hook call was recorded; the harness did not run the hooks. Check that it reads the hook config the manifest's install path names.");
  else messages.push(`Recorded ${fin.lines} hook call${fin.lines === 1 ? "" : "s"} to ${path.join(out, "payloads.jsonl")}`);
  const ok = !status.error && !interrupted && !timedOut && status.code === 0 && fin.lines > 0;
  return res(interrupted ? 130 : ok ? 0 : 1, { lines: fin.lines, interrupted });
}

/** `record --stop <scratch>`: finishes a hand-run recording. Only a folder this command made (its marker names the output) is read and removed. */
export function recordStop(scratch: string, opts: { realHome?: string; cwd?: string } = {}): RecordResult {
  const messages: string[] = [];
  const dir = path.resolve(opts.cwd ?? process.cwd(), scratch);
  let out: string;
  try {
    if (lstatSync(dir).isSymbolicLink() || !path.basename(dir).startsWith(SCRATCH_PREFIX)) throw new Error("not a record scratch folder");
    const marker = JSON.parse(readFileSync(path.join(dir, MARKER), "utf8")) as { out?: unknown };
    if (typeof marker.out !== "string") throw new Error("marker unreadable");
    out = marker.out;
  } catch {
    messages.push(`${scratch} is not a scratch folder made by cocheck harness record; nothing was changed`);
    return { exitCode: 1, lines: 0, messages };
  }
  const fin = finish(dir, out, opts.realHome ?? homedir());
  if (fin.failure !== undefined) {
    messages.push(fin.failure);
    return { exitCode: 1, lines: 0, messages };
  }
  messages.push(fin.lines === 0 ? "no hook call was recorded; nothing was written" : `Recorded ${fin.lines} hook call${fin.lines === 1 ? "" : "s"} to ${path.join(out, "payloads.jsonl")}`);
  return { exitCode: fin.lines === 0 ? 1 : 0, lines: fin.lines, messages };
}

export async function runHarnessRecord(argv: string[], io: HarnessIo): Promise<number> {
  const dd = argv.indexOf("--");
  const head = dd < 0 ? argv : argv.slice(0, dd);
  const command = dd < 0 ? undefined : argv.slice(dd + 1);
  const fail = (m: string): number => (io.err(m), 2);
  let key: string | undefined;
  let manifest: string | undefined;
  let out: string | undefined;
  let stopDir: string | undefined;
  let timeout: number | undefined;
  for (let i = 0; i < head.length; i++) {
    const a = head[i]!;
    const val = (): string | undefined => head[++i];
    if (a === "--manifest") manifest = val();
    else if (a === "--out") out = val();
    else if (a === "--stop") stopDir = val();
    else if (a === "--timeout") {
      const t = Number(val());
      if (!(t > 0)) return fail("--timeout needs a number of seconds");
      timeout = t;
    } else if (a.startsWith("--")) return fail(`unknown option ${a}`);
    else if (key === undefined) key = a;
    else return fail(RECORD_USAGE);
  }
  if (stopDir !== undefined) {
    if (key !== undefined || manifest !== undefined || out !== undefined || command !== undefined) return fail(RECORD_USAGE);
    const r = recordStop(stopDir, { cwd: io.cwd });
    for (const line of r.messages) (r.exitCode === 0 ? io.out : io.err)(line);
    return r.exitCode;
  }
  if (key === undefined || manifest === undefined || out === undefined || (command !== undefined && command.length === 0)) return fail(RECORD_USAGE);
  const r = await recordRun({ key, manifest, out, command, timeoutSeconds: timeout, env: io.env, signal: io.signal, cwd: io.cwd });
  for (const line of r.messages) (r.exitCode === 0 ? io.out : io.err)(line);
  return r.exitCode;
}
