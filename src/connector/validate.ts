// `validateConnector` runs a connector folder over stdio on the toy state pairs and returns every problem a
// first contributor would hit, each as { file, field, expected, found, fix } with one fix sentence. Built on schema.ts (document checks) and
// runner.ts (the child process). A malformed state answered with an empty diff is a problem (a false clean); a leaked credential-shaped string is
// reported by its place, never repeated.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "../platform/index.ts";
import { ownNode, resolveRun } from "./run-argv.ts";
import { startConnector, type ConnectorHandle } from "./runner.ts";
import { CHANGES_FILE, checkChanges } from "./changes-v1.ts";
import { ANSWER_FILE, MANIFEST_FILE, checkManifest, type Problem } from "./schema.ts";

export interface ValidateOptions {
  dir: string;
  /** Folder with the toy pairs `<name>.before.json` and `<name>.after.json`. Defaults to public-kit/toy-product/states. */
  statesDir?: string;
  /** Per request. Default 10000. */
  timeoutMs?: number;
}
export interface ValidateResult {
  ok: boolean;
  problems: Problem[];
}

const DEFAULT_STATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public-kit/toy-product/states");
type Expect = "create" | "edit" | "delete" | "none" | "error";
const PAIRS: { name: string; expect: Expect }[] = [
  { name: "create", expect: "create" },
  { name: "edit", expect: "edit" },
  { name: "delete", expect: "delete" },
  { name: "no-change", expect: "none" },
  { name: "malformed", expect: "error" },
];

// Credential-shaped strings: common vendor prefixes, bearer headers, private key blocks.
const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/;

function runScript(run: unknown): string {
  const argv = Array.isArray(run) ? run : typeof run === "object" && run !== null ? ((run as Record<string, unknown>)[platform().name] ?? Object.values(run)[0]) : undefined;
  if (!Array.isArray(argv)) return MANIFEST_FILE;
  const args = argv.slice(1).filter((a): a is string => typeof a === "string" && !a.startsWith("-"));
  return args[0] ?? (typeof argv[0] === "string" ? argv[0] : MANIFEST_FILE);
}

const pickArgv = resolveRun;

function walkStrings(v: unknown, at: string, visit: (s: string, at: string) => void): void {
  if (typeof v === "string") visit(v, at);
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${at}[${i}]`, visit));
  else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walkStrings(x, at === "" ? k : `${at}.${k}`, visit);
}

export async function validateConnector(opts: ValidateOptions): Promise<ValidateResult> {
  const dir = path.resolve(opts.dir);
  const statesDir = path.resolve(opts.statesDir ?? DEFAULT_STATES);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const id = `validate:${dir}`;
  // A message never carries an absolute path or the runner id: the folders are shown relative, the runner id is dropped.
  const scrub = (t: string): string =>
    t.split(`connector ${id}`).join("the connector").split(id).join("the connector").split(dir).join(".").split(statesDir).join("the states folder");
  const add = (p0: Problem): void => {
    const p: Problem = { ...p0, field: scrub(p0.field), found: scrub(p0.found) };
    const key = `${p.file}|${p.field}|${p.expected}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(p);
  };
  const done = (): ValidateResult => ({ ok: problems.length === 0, problems });

  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    add({ file: ".", field: MANIFEST_FILE, expected: `a ${MANIFEST_FILE} file in the folder`, found: "no manifest", fix: `Add a ${MANIFEST_FILE} file to the folder naming the connector, what it matches and how to run it.` });
    return done();
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    add({ file: MANIFEST_FILE, field: "", expected: "valid JSON", found: "text that does not parse", fix: `Make ${MANIFEST_FILE} valid JSON, for example by checking it for a missing comma or quote.` });
    return done();
  }
  for (const p of checkManifest(manifest)) add(p);
  if (problems.length > 0) return done();

  const m = manifest as { id: string; run: unknown; credentials?: { name: string }[] };
  const script = runScript(m.run);
  const argv = pickArgv(m.run);
  if (argv === undefined) {
    add({ file: MANIFEST_FILE, field: "run", expected: "an argv list for this platform", found: "no entry for this platform", fix: "Add a run entry for this platform, or use one argv list for every platform." });
    return done();
  }
  // A pair that is not in the states folder cannot be run, so it is a problem, never a pass (a missing or partial folder is not a clean connector).
  const missingPairs = new Set<string>();
  for (const pair of PAIRS) {
    const missing = ["before", "after"].filter((side) => !existsSync(path.join(statesDir, `${pair.name}.${side}.json`)));
    if (missing.length === 0) continue;
    missingPairs.add(pair.name);
    add({
      file: `${pair.name}.${missing[0]}.json`,
      field: "states",
      expected: `the ${pair.name} pair in the states folder (${pair.name}.before.json and ${pair.name}.after.json)`,
      found: missing.length === 2 ? "neither file" : `no ${pair.name}.${missing[0]}.json`,
      fix: `Add ${missing.map((side) => `${pair.name}.${side}.json`).join(" and ")} to the states folder, or point the check at a folder that has all five pairs.`,
    });
  }
  const answer = (p: Problem): Problem => ({ ...p, file: p.file === ANSWER_FILE || p.file === CHANGES_FILE ? script : p.file });

  let handle: ConnectorHandle;
  try {
    // Credentials are not read: the validator never touches a credential store, and the toy pairs need none.
    handle = await startConnector({ dir, run: ownNode(argv), id, helloTimeoutMs: timeoutMs });
  } catch (error) {
    add({ file: script, field: "hello", expected: "an object answer to hello", found: helloFound((error as Error).message, timeoutMs), fix: "Make the connector answer the hello request with a JSON object on one line of standard output." });
    return done();
  }
  try {
    // A declared level must be 1, 2 or 3 (the field is named in public-kit/spec/v1.md; read with brackets).
    const declared = handle.hello["level"];
    if (declared !== undefined && declared !== 1 && declared !== 2 && declared !== 3) add({ file: script, field: "hello.level", expected: "1, 2 or 3", found: JSON.stringify(declared), fix: "Declare level 1 (change list), 2 (plus pictures) or 3 (plus anchors) in hello, or leave it out." });
    walkStrings(handle.hello, "hello", (s, at) => {
      if (SECRET.test(s)) leak(add, script, at);
    });
    for (const pair of PAIRS) {
      const beforeFile = path.join(statesDir, `${pair.name}.before.json`);
      const afterFile = path.join(statesDir, `${pair.name}.after.json`);
      if (missingPairs.has(pair.name)) continue;
      let result: unknown;
      let errorText: string | undefined;
      try {
        result = await handle.call("diff", { before: beforeFile, after: afterFile }, { timeoutMs });
      } catch (error) {
        const msg = (error as Error).message;
        if (/timed out/.test(msg)) {
          add({ file: script, field: "diff", expected: `an answer to a diff request within ${timeoutMs / 1000} seconds`, found: "no answer", fix: "Answer every diff request, with a result or an error, before the timeout." });
          break;
        }
        if (/answered with an error/.test(msg)) errorText = msg;
        else {
          add({ file: script, field: "diff", expected: "a connector that stays running", found: "the connector exited", fix: "Keep the connector running and answer a bad input with an error instead of exiting." });
          break;
        }
      }
      if (pair.expect === "error") {
        if (errorText === undefined) {
          const empty = isEmptyChanges(result);
          add({
            file: script,
            field: empty ? "changes" : "error",
            expected: "an error for a malformed state",
            found: empty ? "an empty list of changes" : "a normal answer",
            fix: "Answer a malformed state with an error instead of an empty diff, so a broken input is never reported as no change.",
          });
        }
        continue;
      }
      if (errorText !== undefined) {
        add({ file: script, field: "diff", expected: `a result for the ${pair.name} pair`, found: "an error", fix: `Answer the ${pair.name} pair with a diff result instead of an error.` });
        continue;
      }
      // The answer must be a cocheck.changes/1 document: valid, and the change the pair shows is marked.
      for (const p of checkChanges(result)) add(answer(p));
      scanLeaks(result, add, script);
      const list = (typeof result === "object" && result !== null && Array.isArray((result as { changes?: unknown }).changes) ? (result as { changes: Array<{ mark?: unknown }> }).changes : []);
      const want = pair.expect === "create" ? "added" : pair.expect === "delete" ? "removed" : pair.expect === "edit" ? "changed" : undefined;
      if (pair.expect === "none" && list.length > 0) add({ file: script, field: "changes", expected: "no changes when the states are the same", found: `${list.length} change${list.length === 1 ? "" : "s"}`, fix: "Return an empty changes list when the before and after states are the same." });
      if (want !== undefined && !list.some((c) => c.mark === want)) add({ file: script, field: "changes", expected: `a change marked "${want}" for the ${pair.name} pair`, found: list.length === 0 ? "an empty list of changes" : "no change with that mark", fix: `Report a change with mark "${want}" when the states show one.` });
    }
    scanText(handle.log(), () => add({ file: script, field: "log", expected: "no credentials in the connector's output", found: "a credential-shaped string", fix: "Stop printing tokens or authorization headers to standard output and standard error." }));
  } finally {
    await handle.stop();
  }
  return done();
}

function helloFound(msg: string, timeoutMs: number): string {
  if (/timed out/.test(msg)) return `no answer to hello within ${timeoutMs} ms`;
  if (/exited/.test(msg)) return "the connector exited before it answered hello";
  if (/could not start/.test(msg)) return "the connector could not be started";
  if (/did not answer with an object/.test(msg)) return "an answer to hello that is not an object";
  return "no usable answer to hello";
}
function isEmptyChanges(r: unknown): boolean {
  return typeof r === "object" && r !== null && Array.isArray((r as { changes?: unknown }).changes) && (r as { changes: unknown[] }).changes.length === 0;
}
function leak(add: (p: Problem) => void, file: string, field: string): void {
  add({ file, field, expected: "no credentials in the answer", found: "a credential-shaped string", fix: `Remove the token or secret from ${field.replace(/^hello\./, "")} so the connector never prints a credential.` });
}
function scanLeaks(result: unknown, add: (p: Problem) => void, file: string): void {
  walkStrings(result, "", (s, at) => {
    if (SECRET.test(s)) leak(add, file, at);
  });
}
function scanText(text: string, hit: () => void): void {
  if (SECRET.test(text)) hit();
}
