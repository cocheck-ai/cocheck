// `cocheck harness test --cases <dir> [--manifest <path>]`: replays each case's recorded hook calls through the real hook path in a temporary
// data home and folder, then compares what the hook made of them (the normalized events and the credit of each file) with what the case expects.
// Nothing of the person's own data home, hook configs or folders is read or written: HOME, the data home and the agent homes all point into the temp tree.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HarnessIo } from "./index.ts";
import { runHook } from "../hook-cli.ts";
import { normalize } from "../normalize.ts";
import { allProfiles, isHostKey, loadOutsiderHarnesses, skippedHarnesses } from "../hosts/index.ts";
import { MANIFEST_FILE } from "../hosts/manifest.ts";
import { setTracking } from "../tracking.ts";
import { memoryKeyProvider, setKeyProvider } from "../seal.ts";
import { stopWarmConnectors } from "../connector/diff.ts";
import { stopAllConnectors } from "../connector/runner.ts";

export const CASE_SCHEMA = "cocheck-harness-case/1";
export const LEVELS = ["L0", "L1", "L2", "L3"] as const;

export interface CaseCall {
  /** The host's own event name (for the reader and the messages). */
  event: string;
  /** The payload text exactly as the hook received it. `<folder>` and `<root>` stand for the temp task folder and temp root. */
  stdin: string;
  /** Extra words of the hook command, for a harness whose command names its event: `["--event", "preToolUse"]`. */
  argv: string[];
}

export interface HarnessCase {
  schema: typeof CASE_SCHEMA;
  harness: string;
  description: string;
  level: (typeof LEVELS)[number];
  recording: CaseCall[];
  files: { before?: Record<string, string>; writes?: Array<{ afterEvent: number; path: string; content: string }> };
  expect: {
    /** One entry per recorded call (same order); each lists fields the normalized event must have. An empty entry checks nothing for that call. */
    normalized: Array<Record<string, unknown>>;
    /** File (relative to the task folder) to the credit its last recorded state ends with. */
    credit: Record<string, { creditedTo: string; basis: string }>;
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
/** A relative path that stays inside the folder it is joined to. */
const inside = (p: string): boolean => p !== "" && !path.isAbsolute(p) && !p.split(/[\\/]/).includes("..") && !/^[A-Za-z]:/.test(p);

/** Checks a parsed case file; returns the case or a plain sentence saying what is wrong. */
export function checkCaseShape(v: unknown): HarnessCase | string {
  if (!isObject(v)) return "the case is not a JSON object";
  if (v.schema !== CASE_SCHEMA) return `schema: expected "${CASE_SCHEMA}"`;
  if (typeof v.harness !== "string" || v.harness === "") return "harness: expected the harness key";
  if (typeof v.description !== "string" || v.description === "") return "description: expected a sentence";
  if (!(LEVELS as readonly unknown[]).includes(v.level)) return `level: expected one of ${LEVELS.join(", ")}`;
  if (!Array.isArray(v.recording) || v.recording.length === 0) return "recording: expected a list of recorded hook calls";
  for (const [i, c] of v.recording.entries()) {
    if (!isObject(c) || typeof c.event !== "string" || typeof c.stdin !== "string" || !isStrings(c.argv)) return `recording[${i}]: expected {event, stdin (text), argv (list of words)}`;
  }
  const files = v.files ?? {};
  if (!isObject(files)) return "files: expected an object";
  const before = files.before ?? {};
  if (!isObject(before) || Object.entries(before).some(([p, c]) => !inside(p) || typeof c !== "string")) return "files.before: expected file names inside the folder, each with its text";
  const writes = files.writes ?? [];
  if (!Array.isArray(writes)) return "files.writes: expected a list";
  for (const [i, w] of writes.entries()) {
    if (!isObject(w) || !Number.isInteger(w.afterEvent) || (w.afterEvent as number) < 1 || (w.afterEvent as number) > v.recording.length) return `files.writes[${i}].afterEvent: expected the number (from 1) of a recorded call`;
    if (typeof w.path !== "string" || !inside(w.path)) return `files.writes[${i}].path: expected a file name inside the folder`;
    if (typeof w.content !== "string") return `files.writes[${i}].content: expected text`;
  }
  const expect = v.expect;
  if (!isObject(expect)) return "expect: expected an object";
  if (!Array.isArray(expect.normalized) || expect.normalized.length !== v.recording.length || expect.normalized.some((e) => !isObject(e))) return "expect.normalized: expected one object per recorded call";
  if (!isObject(expect.credit)) return "expect.credit: expected an object";
  for (const [f, c] of Object.entries(expect.credit)) {
    if (!inside(f)) return `expect.credit: ${JSON.stringify(f)} is not a file name inside the folder`;
    if (!isObject(c) || typeof c.creditedTo !== "string" || typeof c.basis !== "string") return `expect.credit.${f}: expected {creditedTo, basis}`;
  }
  const credited = Object.values(expect.credit as Record<string, { creditedTo: string }>).filter((c) => c.creditedTo.startsWith("call:"));
  if (credited.length === 0 && !/\bno credit\b/i.test(v.description)) return 'expect.credit holds no credited file; a case with none says why in its description (use the words "no credit")';
  return v as unknown as HarnessCase;
}

/** What the replay made of a case. */
export interface Observed {
  /** The normalized event of each recorded call (scrubbed of the temp paths), plus `callId` for its call id. `null` where the payload could not be read. */
  normalized: Array<Record<string, unknown> | null>;
  credit: Record<string, { creditedTo: string; basis: string }>;
  /** A hook call that exited non-zero, or a manifest that did not load: replay stopped there. */
  fatal?: string;
  /** Something the person should know that does not fail the case (a manifest passed for a built-in harness, which is not used). */
  warning?: string;
}

const jsonText = (s: string): string => JSON.stringify(s).slice(1, -1);
const SAVED_ENV = ["HOME", "USERPROFILE", "COCHECK_HARNESS_DIR", "COCHECK_HOME"];

/** Replays `c` in a temporary tree. `manifest`: the harness's manifest file, for a harness that is not built in. */
export async function replayCase(c: HarnessCase, manifest?: string): Promise<Observed> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cocheck-harness-")));
  const home = path.join(root, "home");
  const folder = path.join(root, "ws");
  mkdirSync(home);
  mkdirSync(folder);
  const saved: Record<string, string | undefined> = Object.fromEntries(SAVED_ENV.map((k) => [k, process.env[k]]));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.COCHECK_HOME = home;
  delete process.env.COCHECK_HARNESS_DIR;
  // Every harness's own folders (named by its profile) move into the temp tree: a variable a profile names is saved, pointed at an empty folder there, and put back.
  const pointHomes = (): void => {
    for (const name of allProfiles().flatMap((p) => p.homeEnv ?? [])) {
      if (!(name in saved)) saved[name] = process.env[name];
      const dir = path.join(root, "agent-homes", name);
      mkdirSync(dir, { recursive: true });
      process.env[name] = dir;
    }
  };
  const out: Observed = { normalized: [], credit: {} };
  // The key that seals stored file copies lives in the login Keychain per data home; a temp home gets a key held in memory, so the Keychain is never touched.
  setKeyProvider(memoryKeyProvider());
  try {
    loadOutsiderHarnesses(undefined);
    pointHomes();
    if (manifest !== undefined && isHostKey(c.harness)) out.warning = `${c.harness} is a built-in harness: its built-in profile is used, not the manifest at ${manifest}`;
    if (!isHostKey(c.harness)) {
      if (manifest === undefined) return { ...out, fatal: `${c.harness} is not a built-in harness: pass --manifest <path to its ${MANIFEST_FILE}>` };
      const target = path.join(home, "harnesses", c.harness);
      mkdirSync(target, { recursive: true });
      cpSync(manifest, path.join(target, MANIFEST_FILE));
      const skipped = loadOutsiderHarnesses(path.join(home, "harnesses"));
      if (skipped.length > 0) return { ...out, fatal: `the manifest did not load: ${skipped.join("; ")}` };
      pointHomes();
      if (!isHostKey(c.harness)) return { ...out, fatal: `the manifest's key is not ${JSON.stringify(c.harness)}` };
    }
    for (const [file, text] of Object.entries(c.files.before ?? {})) {
      mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
      writeFileSync(path.join(folder, file), text);
    }
    const start = Date.UTC(2026, 10, 21, 12, 0, 0);
    let clock = start;
    for (const [i, call] of c.recording.entries()) {
      const text = call.stdin.split("<folder>").join(jsonText(folder)).split("<root>").join(jsonText(root));
      const eventIdx = call.argv.indexOf("--event");
      const eventArg = eventIdx >= 0 ? call.argv[eventIdx + 1] : undefined;
      let ev: ReturnType<typeof normalize> | undefined;
      try {
        ev = normalize(c.harness, JSON.parse(text), eventArg);
      } catch {
        out.normalized.push(null);
      }
      if (ev !== undefined) {
        const scrubbed = JSON.parse(JSON.stringify({ ...ev, callId: ev.toolUseId }).split(jsonText(folder)).join("<folder>").split(jsonText(root)).join("<root>")) as Record<string, unknown>;
        out.normalized.push(scrubbed);
        if (typeof ev.session === "string" && ev.session !== "") setTracking(home, c.harness, ev.session, true, undefined);
      }
      const argv = ["node", "hook.ts", "--host", c.harness, ...call.argv, "--folder", folder];
      const res = await runHook({ argv, env: { ...process.env, COCHECK_HOME: home }, now: () => (clock += 1000), journalNow: () => start + i * 1000, stdin: (async function* () { yield Buffer.from(text); })() });
      if (res.exitCode !== 0) return { ...out, fatal: `call ${i + 1} (${call.event}): the hook exited ${res.exitCode}: ${res.stderr.trim()}` };
      for (const w of c.files.writes ?? []) {
        if (w.afterEvent !== i + 1) continue;
        mkdirSync(path.dirname(path.join(folder, w.path)), { recursive: true });
        writeFileSync(path.join(folder, w.path), w.content);
      }
    }
    out.credit = readCredit(home, folder);
    return out;
  } finally {
    setKeyProvider(null);
    loadOutsiderHarnesses(undefined);
    await stopWarmConnectors();
    await stopAllConnectors();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** The credit each file ends with: the last state recorded after a call (Post) for it, read from the temp ledger. */
function readCredit(home: string, folder: string): Observed["credit"] {
  const dbFile = path.join(home, "ledger.sqlite");
  if (!existsSync(dbFile)) return {};
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, file_path, credited_json, credit_basis FROM file_states WHERE phase = 'Post' ORDER BY id").all() as Array<{ id: number; file_path: string; credited_json: string; credit_basis: string | null }>;
    const proofs = new Set((db.prepare("SELECT file_state_id AS id FROM file_state_proofs").all() as Array<{ id: number }>).map((p) => p.id));
    const credit: Observed["credit"] = {};
    for (const r of rows) {
      const rel = path.relative(folder, r.file_path).split(path.sep).join("/");
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const ids = JSON.parse(r.credited_json) as string[];
      const basis = proofs.has(r.id) ? "host-reported-edit" : r.credit_basis === "argv-tag" || r.credit_basis === "host-reported-edit" ? r.credit_basis : "inferred";
      credit[rel] = { creditedTo: ids.length === 0 ? "unattributed" : ids.map((id) => `call:${id}`).join(","), basis };
    }
    return credit;
  } finally {
    db.close();
  }
}

/** The fields of an observed normalized event a generated case records. */
export function normalizedProjection(ev: Record<string, unknown> | null): Record<string, unknown> {
  if (ev === null) return {};
  const out: Record<string, unknown> = {};
  for (const k of ["kind", "eventName", "session", "toolName", "callId", "agentId", "agentType", "prompt", "lastAssistantMessage"]) if (ev[k] !== undefined) out[k] = ev[k];
  if (isObject(ev.failure)) out.failure = { interrupted: ev.failure.interrupted };
  return out;
}

/** Every key of `want` holds in `got` (objects compared key by key, anything else exactly). Returns the first difference, in words. */
function subsetDiff(want: unknown, got: unknown, at: string): string | undefined {
  if (isObject(want)) {
    if (!isObject(got)) return `${at}: expected an object, got ${JSON.stringify(got)}`;
    for (const [k, w] of Object.entries(want)) {
      const d = subsetDiff(w, got[k], at === "" ? k : `${at}.${k}`);
      if (d !== undefined) return d;
    }
    return undefined;
  }
  return JSON.stringify(want) === JSON.stringify(got) ? undefined : `${at}: expected ${JSON.stringify(want)}, got ${got === undefined ? "nothing" : JSON.stringify(got)}`;
}

/** The first difference between what a case expects and what the replay saw, in plain words; undefined when they agree. */
export function firstDifference(c: HarnessCase, seen: Observed): string | undefined {
  if (seen.fatal !== undefined) return seen.fatal;
  for (const [i, want] of c.expect.normalized.entries()) {
    const got = seen.normalized[i];
    const label = `call ${i + 1} (${c.recording[i]!.event})`;
    if (got === null || got === undefined) {
      if (Object.keys(want).length > 0) return `${label}: the harness's payload could not be read into an event`;
      continue;
    }
    const d = subsetDiff(want, got, "");
    if (d !== undefined) return `${label}: normalized event ${d}`;
  }
  for (const [file, want] of Object.entries(c.expect.credit)) {
    const got = seen.credit[file];
    if (got === undefined) return `file ${file}: expected credit to ${want.creditedTo}, but no state was recorded for it`;
    if (got.creditedTo !== want.creditedTo) return `file ${file}: expected credit to ${want.creditedTo}, got ${got.creditedTo}`;
    if (got.basis !== want.basis) return `file ${file}: expected credit basis ${want.basis}, got ${got.basis}`;
  }
  return undefined;
}

/** The case files under `target` (a folder of `.json` files, or one file), sorted. */
function caseFiles(target: string): string[] {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];
  return readdirSync(target).filter((n) => n.endsWith(".json")).sort().map((n) => path.join(target, n));
}

const TEST_USAGE = "usage: cocheck harness test --cases <dir> [--manifest <path>]";

export async function runHarnessTest(args: string[], io: HarnessIo): Promise<number> {
  let cases: string | undefined;
  let manifest: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--cases" && args[i + 1] !== undefined) cases = args[++i];
    else if (a === "--manifest" && args[i + 1] !== undefined) manifest = args[++i];
    else {
      io.err(`unexpected ${JSON.stringify(a)}\n${TEST_USAGE}`);
      return 1;
    }
  }
  if (cases === undefined) {
    io.err(TEST_USAGE);
    return 1;
  }
  const manifestFile = manifest === undefined ? undefined : path.resolve(existsSync(manifest) && statSync(manifest).isDirectory() ? path.join(manifest, MANIFEST_FILE) : manifest);
  if (manifestFile !== undefined && !existsSync(manifestFile)) {
    io.err(`no manifest at ${manifestFile}`);
    return 1;
  }
  const files = caseFiles(path.resolve(cases));
  if (files.length === 0) {
    io.err(`no case files (*.json) in ${path.resolve(cases)}`);
    return 1;
  }
  let failed = 0;
  const warned = new Set<string>();
  for (const file of files) {
    const name = path.basename(file);
    let problem: string | undefined;
    let level = "";
    try {
      const parsed = checkCaseShape(JSON.parse(readFileSync(file, "utf8")));
      if (typeof parsed === "string") problem = parsed;
      else {
        level = ` (${parsed.harness} ${parsed.level})`;
        const seen = await replayCase(parsed, manifestFile);
        if (seen.warning !== undefined && !warned.has(seen.warning)) {
          warned.add(seen.warning);
          io.err(`warning: ${seen.warning}`);
        }
        problem = firstDifference(parsed, seen);
      }
    } catch (error) {
      problem = error instanceof SyntaxError ? "not valid JSON" : `could not run: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (problem === undefined) io.out(`pass  ${name}${level}`);
    else {
      failed++;
      io.out(`FAIL  ${name}${level}: ${problem}`);
    }
  }
  io.out(failed === 0 ? `${files.length} cases passed` : `${failed} of ${files.length} cases failed`);
  return failed === 0 ? 0 : 1;
}
