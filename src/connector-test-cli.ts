// `cocheck connector test <dir> [--states <dir>] [--timeout <ms>]`. Runs validateConnector on the folder, then grades every
// non-malformed pair's diff answer over 5 runs: a connector that declares a `level` in hello is graded at that level (gradeLevel in connector/conformance.ts) and
// the output says the level passed; a connector with no level is graded at level 3 and not required to reach it. Exit 0 only when every pair is present
// and every check ran and passed: a skipped check is a failure (a false clean must not happen). An entry-"diff" connector is sent `diffs`
// from the samples its author ships (diff-samples.ts) and passes only when every required class was sent and graded. An export connector has no
// diff to grade: its manifest, hello and `export` answers are checked.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, gradeLevel, helloLevel, runCases, warmMatchesFresh } from "./connector/conformance.ts";
import { readInstalledManifests } from "./connector/installed-manifests.ts";
import { overlapsOf, overlapWarning } from "./connector/installed-match.ts";
import { checkChanges } from "./connector/changes-v1.ts";
import { exportDocOf } from "./connector/export-view.ts";
import { unmetRequires } from "./connector/requires.ts";
import { ownNode, resolveRun } from "./connector/run-argv.ts";
import { startConnector } from "./connector/runner.ts";
import { EXPORT_METHOD, MANIFEST_FILE, checkExportAnswer, checkManifest, checkSnapshotAnswer, DEFAULT_DIFF_MS, diffMsOf, permittedEnvOf, type Problem } from "./connector/schema.ts";
import { validateConnector } from "./connector/validate.ts";
import { CHANGES_SPEC } from "./connector/changes-v1.ts";
import { renderCallSubject } from "./connector/subjects.ts";
import { readDiffSamples, REQUIRED_SAMPLE_CLASSES, SAMPLES_DIR, SAMPLES_FILE, TEST_SAMPLES_ENV, type DiffSample } from "./connector/diff-samples.ts";

const ownNodeOf = (a: string[] | undefined): string[] | undefined => (a === undefined ? undefined : ownNode(a));

interface ConnectorTestResult { exitCode: 0 | 1; stdout: string; stderr: string }

const USAGE = "usage: cocheck connector test <dir> [--states <dir>] [--timeout <ms>]\n       cocheck connector test <dir> --cases [<casesDir>]";
const DEFAULT_CASES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public-kit/conformance/cases");
const DEFAULT_STATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public-kit/toy-product/states");
const PAIR_NAMES = ["create", "edit", "delete", "no-change", "malformed"] as const;
const P6_RUNS = 5;
/** The variable the test sets for the connector: the states folder. A connector reached through a subject template answers `snapshot` from `<name>.json` in it under test, and from the product in production. */
const TEST_STATES_ENV = "COCHECK_TEST_STATES";

/** The first `matches.subjects` template of a manifest, the only way an MCP write ever gets a subject URI (hook-cli.ts); undefined when it has none. */
function templateOf(manifest: unknown): string | undefined {
  const subjects = (manifest as { matches?: { subjects?: Record<string, unknown> } } | undefined)?.matches?.subjects;
  const first = subjects === undefined ? undefined : Object.values(subjects).find((t): t is string => typeof t === "string");
  return first;
}
/** The URI production would build for the item called `name`: the template with each {field} replaced by the name ({field:hex}: its hex). */
const subjectUriOf = (template: string, name: string): string => template.replace(/\{\w+(:hex)?\}/g, (_m, hex: string | undefined) => (hex !== undefined ? Buffer.from(name).toString("hex") : name));

function anchorOf(p: Problem): string {
  if (p.field === "log" || /credential|secret|token/i.test(p.found) || /credential/i.test(p.expected)) return "credentials";
  if (p.field === "error" || /error for a malformed/.test(p.expected) || p.found === "an error") return "errors";
  if (p.file === MANIFEST_FILE || p.file === ".") return "manifest";
  // A create tool's answer samples are described in the spec's "Items a tool creates" section
  if (p.file === CALL_SAMPLES_REL) return "items-a-tool-creates";
  if (p.file.startsWith(`${SAMPLES_DIR}/`) || p.field.includes("diffs")) return "diffs";
  if (p.field === "hello" || p.field.startsWith("hello.")) return "hello";
  return "diff-answer";
}

function render(problems: Problem[], notes: string[], untested: string[] = []): string {
  const lines: string[] = [];
  for (const p of problems) {
    lines.push(`${p.file} ${p.field}: expected ${p.expected}, found ${p.found}. ${p.fix}`);
    lines.push(`see spec #${anchorOf(p)}`);
  }
  lines.push(...notes);
  lines.push(...untested.map((u) => `untested: ${u}`));
  lines.push(problems.length > 0 ? `${problems.length} problem${problems.length === 1 ? "" : "s"}` : untested.length > 0 ? "untested" : "passed");
  return `${lines.join("\n")}\n`;
}

const isChangedList = (doc: unknown): boolean => typeof doc === "object" && doc !== null && Array.isArray((doc as { changes?: unknown }).changes);
/** At least one change marked "changed" holds a before and an after in words, and they differ. A document that says nothing changed at all is judged by the mark check, not this one. */
const changedHasBothSides = (doc: unknown): boolean => {
  const list = (doc as { changes: Array<{ mark?: unknown; before?: unknown; after?: unknown }> }).changes;
  if (!list.some((c) => c.mark === "changed")) return true;
  return list.some((c) => c.mark === "changed" && typeof c.before === "string" && typeof c.after === "string" && c.before !== c.after);
};

function parseArgs(args: string[]): { dir: string; states?: string; timeoutMs?: number; cases?: string | true } | string {
  let cases: string | true | undefined;
  let dir: string | undefined;
  let states: string | undefined;
  let timeoutMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--states" || a === "--timeout") {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) return `${a} needs a value`;
      if (a === "--states") states = v;
      else {
        if (!/^[1-9][0-9]*$/.test(v)) return `--timeout needs a positive whole number of milliseconds, got ${JSON.stringify(v)}`;
        timeoutMs = Number(v);
      }
    } else if (a === "--cases") {
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith("--") && dir !== undefined) { cases = v; i++; } else cases = true;
    } else if (a.startsWith("--")) return `unknown option ${a}`;
    else if (dir === undefined) dir = a;
    else return `unexpected argument ${a}`;
  }
  if (dir === undefined) return "a connector folder is required";
  return { dir, ...(states !== undefined ? { states } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(cases !== undefined ? { cases } : {}) };
}

/** Where the connector under test claims what an installed connector also claims, one winner by the stated order; printed as warnings naming the losers. */
function overlapNotes(dir: string, home: string | undefined): string[] {
  if (home === undefined) return [];
  try {
    const mine = JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as { id?: string; matches?: unknown };
    if (checkManifest(mine).length > 0) return [];
    const installed = readInstalledManifests(home).filter((m) => m.manifest.id !== mine.id);
    const all = [...installed, { dir: path.basename(dir), file: path.join(dir, MANIFEST_FILE), manifest: mine as never }];
    return overlapsOf(all).filter((o) => [o.winner, ...o.losers].includes(mine.id as string)).map(overlapWarning);
  } catch {
    return [];
  }
}

export async function runConnectorTest(args: string[], opts: { home?: string } = {}): Promise<ConnectorTestResult> {
  const r = await runConnectorTestInner(args, opts);
  // The folder parseArgs found, wherever it sits among the options.
  const parsed = parseArgs(args);
  if (r.stdout === "" || typeof parsed === "string") return r;
  const dir = path.resolve(parsed.dir);
  const w = overlapNotes(dir, opts.home);
  if (w.length === 0) return r;
  const lines = r.stdout.trimEnd().split("\n");
  const last = lines.pop()!;
  return { ...r, stdout: `${[...lines, ...w, last].join("\n")}\n` };
}

async function runConnectorTestInner(args: string[], _opts: { home?: string }): Promise<ConnectorTestResult> {
  const parsed = parseArgs(args);
  if (typeof parsed === "string") return { exitCode: 1, stdout: "", stderr: `${parsed}\n${USAGE}\n` };
  const dir = path.resolve(parsed.dir);
  if (parsed.cases !== undefined) {
    if (parsed.states !== undefined) return { exitCode: 1, stdout: "", stderr: `--cases and --states are separate modes\n${USAGE}\n` };
    const casesDir = path.resolve(parsed.cases === true ? DEFAULT_CASES : parsed.cases);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { exitCode: 1, stdout: "", stderr: `the connector folder ${parsed.dir} does not exist\n` };
    if (!existsSync(casesDir) || !statSync(casesDir).isDirectory()) return { exitCode: 1, stdout: "", stderr: `the cases folder ${casesDir} does not exist, so nothing was tested\n` };
    let results;
    try {
      results = await runCases({ dir, casesDir });
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: `the cases could not run: ${(error as Error).message}\n` };
    }
    if (results.length === 0) return { exitCode: 1, stdout: "", stderr: `no cases found in ${casesDir}, so nothing was tested\n` };
    const lines = results.map((r) => (r.pass ? `${r.id} pass` : `${r.id} fail ${r.reason ?? ""}`.trimEnd()));
    const failed = results.filter((r) => !r.pass).length;
    lines.push(failed === 0 ? "passed" : `${failed} case${failed === 1 ? "" : "s"} failed`);
    return { exitCode: failed === 0 ? 0 : 1, stdout: `${lines.join("\n")}\n`, stderr: "" };
  }
  const statesDir = path.resolve(parsed.states ?? DEFAULT_STATES);
  let timeoutMs = parsed.timeoutMs ?? DEFAULT_DIFF_MS;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { exitCode: 1, stdout: "", stderr: `the connector folder ${parsed.dir} does not exist\n` };
  if (!existsSync(statesDir) || !statSync(statesDir).isDirectory()) return { exitCode: 1, stdout: "", stderr: `the states folder ${parsed.states ?? statesDir} does not exist, so nothing was tested\n` };

  const problems: Problem[] = [];
  const seen = new Set<string>();
  const add = (p: Problem): void => {
    const key = `${p.file}|${p.field}|${p.expected}`;
    if (!seen.has(key)) {
      seen.add(key);
      problems.push(p);
    }
  };

  const manifestPath = path.join(dir, MANIFEST_FILE);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    manifest = undefined;
  }
  // With no --timeout, a valid manifest's diffMs is the wait for each request.
  if (parsed.timeoutMs === undefined && manifest !== undefined && checkManifest(manifest).length === 0) timeoutMs = diffMsOf(manifest) ?? timeoutMs;
  // An unmet `requires` (a desktop session, a binary) makes the test unverified: the connector's real conditions are absent, so nothing is run.
  if (manifest !== undefined && checkManifest(manifest).length === 0) {
    const unmet = unmetRequires(manifest, { env: process.env, pathDirs: (process.env["PATH"] ?? "").split(path.delimiter).filter((d) => d !== ""), pathExts: (process.env["PATHEXT"] ?? "").split(";").filter((e) => e !== "") });
    if (unmet.length > 0) return { exitCode: 1, stdout: `${unmet.map((u) => `unverified: ${u}`).join("\n")}\nunverified: nothing was run, so nothing is claimed\n`, stderr: "" };
  }

  // A connector with matches.calls is tested on its samples/calls.json: each sample's answer is rendered and compared with its expected subject.
  const calls = manifest !== undefined && checkManifest(manifest).length === 0 ? callSamplesCheck(dir, manifest) : { problems: [], untested: [] };
  for (const p of calls.problems) add(p);
  const entry = (manifest as { entry?: unknown } | undefined)?.entry;
  if ((entry === "diff" || entry === "export") && (calls.problems.length > 0 || calls.untested.length > 0)) return { exitCode: 1, stdout: render(problems, [], calls.untested), stderr: "" };

  // A diff-entry connector is sent real `diffs` requests from the samples its author ships; it never passes on its manifest and hello alone.
  if (typeof manifest === "object" && manifest !== null && (manifest as { entry?: unknown }).entry === "diff") return runDiffEntryTest(dir, manifest as { run: unknown }, timeoutMs);

  // An export connector (entry "export") answers { text } for a subject; CoCheck draws the difference. Graded here: valid answers, the same text every run,
  // a different text for each pair that differs, the same text for the pair that does not, an error (never empty text) for the malformed state, and a drawn document
  // that passes checkChanges.
  if (typeof manifest === "object" && manifest !== null && (manifest as { entry?: unknown }).entry === "export") return runExportTest(dir, manifest as { run: unknown }, statesDir, timeoutMs, parsed.states);

  // Every pair must be present: a missing pair is a failure here, whatever the validator does about it.
  const missing = PAIR_NAMES.filter((n) => !existsSync(path.join(statesDir, `${n}.before.json`)) || !existsSync(path.join(statesDir, `${n}.after.json`)));
  for (const n of missing) add({ file: parsed.states ?? statesDir, field: n, expected: `${n}.before.json and ${n}.after.json`, found: "a missing state file", fix: `Add the ${n} pair to the states folder, so the connector is tested on every kind of change.` });
  if (missing.length > 0) return { exitCode: 1, stdout: render(problems, []), stderr: "" };

  const v = await validateConnector({ dir, statesDir, timeoutMs });
  for (const p of v.problems) add(p);
  if (!v.ok) return { exitCode: 1, stdout: render(problems, []), stderr: "" };

  // The manifest is valid here (the validator checked it); run P1-P6 on a fresh process.
  const m = manifest as { run: unknown };
  const argv = ownNodeOf(resolveRun(m.run));
  const script = argv?.slice(1).find((a) => !a.startsWith("-")) ?? MANIFEST_FILE;
  let checked = 0;
  const warnings: string[] = [];
  let levelPassed: 0 | 1 | 2 | 3 | undefined;
  let declaredLevel: 1 | 2 | 3 | undefined;
  if (argv === undefined) add({ file: MANIFEST_FILE, field: "run", expected: "an argv list for this platform", found: "no entry for this platform", fix: "Add a run entry for this platform, or use one argv list for every platform." });
  else {
    let handle: Awaited<ReturnType<typeof startConnector>> | undefined;
    const template = templateOf(manifest);
    try {
      handle = await startConnector({ dir, run: argv, id: `test:${dir}`, helloTimeoutMs: timeoutMs, envNames: permittedEnvOf(manifest), ...(template !== undefined ? { env: { [TEST_STATES_ENV]: statesDir } } : {}) });
    } catch {
      add({ file: script, field: "hello", expected: "an object answer to hello", found: "no valid answer", fix: "Make the connector answer the hello request with a JSON object on one line of standard output." });
    }
    if (handle !== undefined) {
      try {
        const level = helloLevel(handle.hello);
        let worst: 0 | 1 | 2 | 3 = level ?? 3;
        let reached = 1;
        const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-connector-test-"));
        // What production does with a connector that has a subject template: ask `snapshot` of the URI, seal the state, then ask `diff` of the two sealed states (a missing item is an empty file).
        // A connector with only file endings is given the file bytes CoCheck already holds, so its states are used as they are.
        const methods = Array.isArray(handle.hello["methods"]) ? (handle.hello["methods"] as unknown[]) : [];
        if (template !== undefined && !methods.includes("snapshot")) add({ file: script, field: "hello.methods", expected: 'a list naming "snapshot"', found: JSON.stringify(methods), fix: 'This connector has a matches.subjects template, so CoCheck asks it for `snapshot` of the item\'s URI before and after every call: name "snapshot" in the hello methods and answer it.' });
        const filesOf = async (name: string): Promise<{ before: string; after: string } | undefined> => {
          if (template === undefined) return { before: path.join(statesDir, `${name}.before.json`), after: path.join(statesDir, `${name}.after.json`) };
          const out = { before: "", after: "" };
          for (const side of ["before", "after"] as const) {
            const subject = subjectUriOf(template, `${name}.${side}`);
            const asked: string[] = [];
            for (let i = 0; i < 2; i++) {
              let answer: unknown;
              try {
                answer = await handle!.call("snapshot", { subject }, { timeoutMs });
              } catch (error) {
                add({ file: script, field: `${name} snapshot`, expected: `an answer to snapshot of ${subject}`, found: /answered with an error/.test((error as Error).message) ? "an error" : "no answer", fix: `CoCheck asks a connector with a subject template for snapshot of the URI the template makes, as it did here. While the test runs, ${TEST_STATES_ENV} names the states folder: answer from <name>.json there (here "${name}.${side}") instead of the product.` });
                return undefined;
              }
              const ps = checkSnapshotAnswer(answer);
              if (ps.length > 0) { for (const q of ps) add({ ...q, file: script, field: `${name} snapshot ${q.field}` }); return undefined; }
              asked.push(JSON.stringify((answer as { state: string | null }).state));
              if (i === 0) {
                const dirOf = path.join(scratch, name, side);
                mkdirSync(dirOf, { recursive: true });
                const file = path.join(dirOf, path.basename(new URL(subject.replace(/^[a-z][a-z0-9+.-]*:/i, "file:")).pathname) || "state");
                const state = (answer as { state: string | null }).state;
                writeFileSync(file, state ?? "");
                out[side] = file;
              }
            }
            if (asked[0] !== asked[1]) { add({ file: script, field: `${name} snapshot`, expected: "the same state when asked twice about an item that did not change", found: "a different state the second time", fix: "Answer snapshot with the same state for the same item until the item changes." }); return undefined; }
          }
          return out;
        };
        const filesByPair = new Map<string, { before: string; after: string }>();
        for (const name of PAIR_NAMES.filter((n) => n !== "malformed")) {
          const got = await filesOf(name);
          if (got === undefined) continue;
          filesByPair.set(name, got);
          const { before, after } = got;
          const ctx = { beforeText: readFileSync(before, "utf8"), afterText: readFileSync(after, "utf8") };
          const answers: unknown[] = [];
          let failed = false;
          for (let i = 0; i < P6_RUNS && !failed; i++) {
            try {
              answers.push(await handle.call("diff", { before, after }, { timeoutMs }));
            } catch {
              failed = true;
              add({ file: script, field: "diff", expected: `an answer to the ${name} pair on every one of ${P6_RUNS} runs`, found: `no answer on run ${i + 1}`, fix: "Answer every diff request with a result, the same way each time." });
            }
          }
          if (failed) continue;
          const g = gradeLevel(answers, { level: level ?? 3, ...ctx, dir });
          worst = Math.min(worst, g.passed) as 0 | 1 | 2 | 3;
          reached = Math.max(reached, g.reached);
          for (const f of g.failures) add({ file: script, field: `${name} level ${level ?? 3}`, expected: `the level ${level ?? 3} checks to hold on the ${name} pair`, found: f, fix: level === undefined ? "Fix the document so it meets the checks." : "Fix the document so it meets the level's checks, or declare a lower level in hello." });
          for (const w of g.warnings) warnings.push(`warning: ${name}: ${w}`);
          // An answer that does not depend on the states it is given is not a diff. The edit pair is asked again with its two sides swapped: the answer must change.
          if (name === "edit" && answers.length > 0) {
            try {
              const swapped = await handle.call("diff", { before: after, after: before }, { timeoutMs });
              if (canonical(swapped) === canonical(answers[0])) add({ file: script, field: "edit diff", expected: "a different answer when the before and after states are swapped", found: "the same answer", fix: "Read the two states and report what differs between them: an answer that is the same whatever the states are shows nothing about the product." });
            } catch {
              // a connector that errors on the swapped pair is not shown to ignore its states
            }
            // a level 1 change list says what each changed item was and became
            if (isChangedList(answers[0]) && !changedHasBothSides(answers[0])) add({ file: script, field: "edit level", expected: 'a change marked "changed" that says in words what it was (before) and what it became (after), and the two differ', found: "no such change", fix: 'Give each "changed" change a before and an after in words, so a reviewer sees what the item was and what it is now.' });
          }
          checked++;
        }
        // Production sends an empty file for a side that does not exist, so the connector must read one: a created item is asked against an empty before, a deleted one against an empty after.
        {
          const empty = path.join(scratch, "empty.json");
          writeFileSync(empty, "");
          for (const [label, pair, want] of [["empty before", "create", "added"], ["empty after", "delete", "removed"]] as const) {
            const real = path.join(statesDir, `${pair}.${pair === "create" ? "after" : "before"}.json`);
            const [b, a] = pair === "create" ? [empty, real] : [real, empty];
            try {
              const answer = await handle.call("diff", { before: b, after: a }, { timeoutMs });
              const marks = (answer as { changes?: Array<{ mark?: unknown; kind?: unknown }> } | null)?.changes?.map((c) => String(c.mark ?? c.kind)) ?? [];
              if (!marks.some((m) => m === want)) add({ file: script, field: `${label} diff`, expected: `a change marked "${want}" when one side is an empty file (a side that does not exist is sent as an empty file)`, found: marks.length === 0 ? "an empty list of changes" : "no change with that mark", fix: "Read an empty file as an item that does not exist: a created item has an empty before file, a deleted one an empty after file." });
            } catch (error) {
              if (/answered with an error/.test((error as Error).message)) add({ file: script, field: `${label} diff`, expected: "an answer when one side is an empty file", found: "an error", fix: "CoCheck sends an empty file for a side that does not exist (a created item has an empty before, a deleted one an empty after). Read an empty file as no item, never as a broken one." });
            }
          }
        }
        // One process answers many diffs in production, so the edit and delete pairs are asked A, B, A of one process and compared with fresh processes.
        {
          const A = filesByPair.get("edit"), B = filesByPair.get("delete");
          if (A !== undefined && B !== undefined) {
            let n = 0;
            try {
              const bad = await warmMatchesFresh(
                () => startConnector({ dir, run: argv, id: `test:${dir}:warm-${n++}`, helloTimeoutMs: timeoutMs, envNames: permittedEnvOf(manifest), ...(template !== undefined ? { env: { [TEST_STATES_ENV]: statesDir } } : {}) }),
                (h, p) => h.call("diff", p === "A" ? A : B, { timeoutMs }),
              );
              if (bad !== undefined) add({ file: script, field: "edit and delete diff", expected: "the same answers to the edit, delete, edit pairs from one process as from fresh processes", found: bad, fix: "CoCheck keeps one connector process for many diffs: answer each diff from its two inputs only, keeping nothing from an earlier request." });
            } catch {
              // a pair that fails to answer is already reported above
            }
          }
        }
        if (level !== undefined && reached < level && problems.length === 0) add({ file: script, field: "level", expected: `a document that holds what level ${level} adds (${level === 3 ? "pictures and boxes" : "pictures"}) on at least one of the create, edit and delete pairs`, found: `documents that reach level ${reached}`, fix: `Draw pictures${level === 3 ? " and boxes" : ""} in the documents, or declare level ${reached} in hello.` });
        if (level !== undefined) worst = Math.min(worst, reached) as 0 | 1 | 2 | 3;
        levelPassed = level === undefined ? undefined : worst;
        declaredLevel = level;
      } finally {
        await handle.stop();
      }
    }
  }
  if (problems.length === 0 && checked !== PAIR_NAMES.length - 1) add({ file: ".", field: "checks", expected: `the checks run on ${PAIR_NAMES.length - 1} pairs`, found: `${checked} pairs checked`, fix: "Run the test again; a check that did not run is not a pass." });
  const notes = [...warnings];
  if (declaredLevel !== undefined) notes.push(problems.length === 0 ? `level ${levelPassed} passed` : `level passed: ${levelPassed} (declared ${declaredLevel})`);
  else if (problems.length === 0) notes.push("no level declared in hello: answers graded by the level 3 checks");
  return { exitCode: problems.length === 0 && calls.untested.length === 0 ? 0 : 1, stdout: render(problems, notes, calls.untested), stderr: "" };
}

/** Where a connector with `matches.calls` keeps its answer samples. */
const CALL_SAMPLES_REL = "samples/calls.json";

/**
 * Every `{ tool, response, expect }` in samples/calls.json is rendered with its tool's `matches.calls` template and compared with `expect`. A named tool
 * with no sample is untested (never passed); an unreadable file, a malformed sample or a wrong subject is a problem.
 */
export function callSamplesCheck(dir: string, manifest: unknown): { problems: Problem[]; untested: string[] } {
  const calls = (manifest as { matches?: { calls?: Record<string, { subjects: Array<{ template: string }> }> } }).matches?.calls;
  if (calls === undefined || Object.keys(calls).length === 0) return { problems: [], untested: [] };
  const problems: Problem[] = [];
  const file = CALL_SAMPLES_REL;
  let samples: unknown;
  try {
    samples = JSON.parse(readFileSync(path.join(dir, CALL_SAMPLES_REL), "utf8"));
  } catch {
    samples = undefined;
  }
  const tested = new Set<string>();
  if (samples !== undefined && !Array.isArray(samples)) problems.push({ file, field: "", expected: "a list of { tool, response, expect }", found: "not a list", fix: `Write ${CALL_SAMPLES_REL} as a list such as [{ "tool": "mcp__x__create_item", "response": { ... }, "expect": "x://item/1" }].` });
  if (Array.isArray(samples)) samples.forEach((s: unknown, i: number) => {
    const at = `[${i}]`;
    const o = s !== null && typeof s === "object" && !Array.isArray(s) ? (s as { tool?: unknown; response?: unknown; expect?: unknown }) : undefined;
    if (o === undefined || typeof o.tool !== "string" || typeof o.expect !== "string" || !Object.hasOwn(o, "response")) {
      problems.push({ file, field: at, expected: "{ tool, response, expect } with tool and expect strings", found: "a malformed sample", fix: "Give each sample the full MCP tool name, the answer as the tool returned it, and the subject you expect." });
      return;
    }
    const template = Object.hasOwn(calls, o.tool) ? calls[o.tool]!.subjects[0]?.template : undefined;
    if (template === undefined) {
      problems.push({ file, field: `${at}.tool`, expected: "a tool named in matches.calls", found: JSON.stringify(o.tool), fix: "Use a tool name your manifest lists in matches.calls." });
      return;
    }
    const got = renderCallSubject(template, o.response);
    if (got !== o.expect) problems.push({ file, field: `${at}.expect`, expected: JSON.stringify(o.expect), found: got === undefined ? "no subject (the answer did not name the item)" : JSON.stringify(got), fix: "Fix the template in matches.calls, or the sample, so the answer renders the expected subject." });
    else tested.add(o.tool);
  });
  const untested = Object.keys(calls).filter((t) => !tested.has(t) && !(Array.isArray(samples) && samples.some((s) => (s as { tool?: unknown } | null)?.tool === t))).map((t) => `no sample for ${t} in ${CALL_SAMPLES_REL}, so the subject its answer names was not tested`);
  return { problems, untested };
}

async function runExportTest(dir: string, manifest: { run: unknown }, statesDir: string, timeoutMs: number, statesArg: string | undefined): Promise<ConnectorTestResult> {
  const problems: Problem[] = [];
  const add = (p: Problem): void => void problems.push(p);
  for (const p of checkManifest(manifest)) add(p);
  const argv = problems.length === 0 ? ownNodeOf(resolveRun(manifest.run)) : undefined;
  const script = argv?.slice(1).find((a) => !a.startsWith("-")) ?? MANIFEST_FILE;
  if (problems.length === 0 && argv === undefined) add({ file: MANIFEST_FILE, field: "run", expected: "an argv list for this platform", found: "no entry for this platform", fix: "Add a run entry for this platform, or use one argv list for every platform." });
  const missing = PAIR_NAMES.filter((n) => !existsSync(path.join(statesDir, `${n}.before.json`)) || !existsSync(path.join(statesDir, `${n}.after.json`)));
  for (const n of missing) add({ file: statesArg ?? statesDir, field: n, expected: `${n}.before.json and ${n}.after.json`, found: "a missing state file", fix: `Add the ${n} pair to the states folder, so the connector is tested on every kind of change.` });
  if (problems.length > 0) return { exitCode: 1, stdout: render(problems, []), stderr: "" };
  let handle;
  const template = templateOf(manifest);
  try {
    handle = await startConnector({ dir, run: argv!, id: `test:${dir}`, helloTimeoutMs: timeoutMs, envNames: permittedEnvOf(manifest), ...(template !== undefined ? { env: { [TEST_STATES_ENV]: statesDir } } : {}) });
  } catch {
    add({ file: script, field: "hello", expected: "an object answer to hello", found: "no valid answer", fix: "Make the connector answer the hello request with a JSON object on one line of standard output." });
    return { exitCode: 1, stdout: render(problems, []), stderr: "" };
  }
  let drawn = 0;
  let transformed = false;
  try {
    const methods = Array.isArray(handle.hello.methods) ? (handle.hello.methods as unknown[]) : [];
    if (!methods.includes(EXPORT_METHOD)) add({ file: script, field: "hello.methods", expected: `a list naming "${EXPORT_METHOD}"`, found: JSON.stringify(methods), fix: `Name "${EXPORT_METHOD}" in the hello methods: an export connector answers it.` });
    // A connector with a subject template is asked `export` of the URI the template makes, as production asks it; a file-ending connector is asked of a file path.
    const ask = async (file: string, label: string, name?: string, side?: string): Promise<string | undefined> => {
      const subject = template !== undefined && name !== undefined ? subjectUriOf(template, `${name}.${side}`) : file;
      let first: string | undefined;
      for (let i = 0; i < P6_RUNS; i++) {
        let answer: unknown;
        try {
          answer = await handle.call(EXPORT_METHOD, { subject }, { timeoutMs });
        } catch (error) {
          if (/answered with an error/.test((error as Error).message)) return undefined;
          add({ file: script, field: EXPORT_METHOD, expected: `an answer to the ${label} state on every one of ${P6_RUNS} runs`, found: `no answer on run ${i + 1}`, fix: "Answer every export request with a result or an error, the same way each time." });
          return undefined;
        }
        const ps = checkExportAnswer(answer);
        if (ps.length > 0) { for (const p of ps) add({ ...p, file: script, field: `${label} ${p.field}` }); return undefined; }
        const text = (answer as { text: string | null })["text"] ?? "";
        if (first === undefined) first = text;
        else if (first !== text) { add({ file: script, field: `${label} ${EXPORT_METHOD}`, expected: "the same text on every run", found: "a second run gave different text", fix: "Make the export the same text for the same state, every time." }); return undefined; }
      }
      return first;
    };
    for (const name of PAIR_NAMES) {
      const before = path.join(statesDir, `${name}.before.json`), after = path.join(statesDir, `${name}.after.json`);
      const b = await ask(before, `${name} before`, name, "before"), a = await ask(after, `${name} after`, name, "after");
      if (name === "malformed") {
        if (a !== undefined) add({ file: script, field: EXPORT_METHOD, expected: "an error for a malformed state", found: a === "" ? "an empty text" : "a normal answer", fix: "Answer a malformed state with an error instead of text, so a broken input is never reported as an empty item." });
        continue;
      }
      if (b !== undefined && a !== undefined && (b !== readFileSync(before, "utf8") || a !== readFileSync(after, "utf8"))) transformed = true;
      if (b === undefined || a === undefined) { if (!problems.some((p) => p.field.startsWith(`${name} `))) add({ file: script, field: EXPORT_METHOD, expected: `a text for the ${name} pair`, found: "an error", fix: `Answer the ${name} pair with text instead of an error.` }); continue; }
      if (name === "no-change" ? a !== b : a === b) add({ file: script, field: `${name} ${EXPORT_METHOD}`, expected: name === "no-change" ? "the same text for the same state" : `a different text after the ${name}`, found: name === "no-change" ? "different text" : "the same text", fix: name === "no-change" ? "Export identical states as identical text." : "Export enough of the item that the change shows in its text." });
      else {
        const doc = exportDocOf("export-test", path.basename(after), b === "" ? null : b, a === "" ? null : a);
        const bad = checkChanges(doc);
        if (bad.length > 0) add({ file: script, field: `${name} ${EXPORT_METHOD}`, expected: "text CoCheck can draw", found: bad[0]!.field, fix: "Export plain text." });
        else drawn++;
      }
    }
  } finally {
    await handle.stop();
  }
  // An export that prints the file as it is adds nothing: CoCheck already draws a line diff of any text file. Flagged when no pair's export differs from its file's own text.
  if (problems.length === 0 && !transformed) add({ file: script, field: EXPORT_METHOD, expected: "an export that is not the file's own text (the item as a reader would see it)", found: "the file's text, unchanged, on every pair", fix: "Export what the product means (ordered, named and labelled, with ids stable), not the raw file: CoCheck already draws a line diff of the file itself. See the guide's export section." });
  if (problems.length === 0 && drawn !== PAIR_NAMES.length - 1) add({ file: ".", field: "checks", expected: `the export drawn on ${PAIR_NAMES.length - 1} pairs`, found: `${drawn} pairs drawn`, fix: "Run the test again; a check that did not run is not a pass." });
  return { exitCode: problems.length === 0 ? 0 : 1, stdout: render(problems, problems.length === 0 ? ["export: CoCheck draws the difference of the exported text (source by CoCheck)"] : []), stderr: "" };
}

const SAMPLES_REL = `${SAMPLES_DIR}/${SAMPLES_FILE}`;
const CLASS_WORDS: Record<string, string> = { changed: "a window in which the item changed", "no-change": "a window in which nothing changed", "failed-read": "a read that fails" };

/** An entry-"diff" connector. Its manifest and hello are checked, then every well-formed sample in samples/samples.json is sent as a `diffs` request
 * P6_RUNS times, with COCHECK_TEST_SAMPLES naming the samples folder. `passed` needs at least one sample of each required class sent and graded, and every
 * answer passing: a missing class (or no samples) is untested and exits 1; anything the grader could not read is a problem, never a pass. */
async function runDiffEntryTest(dir: string, manifest: { run: unknown }, timeoutMs: number): Promise<ConnectorTestResult> {
  const problems: Problem[] = [];
  const add = (p: Problem): void => void problems.push(p);
  for (const p of checkManifest(manifest)) add(p);
  const argv = problems.length === 0 ? ownNodeOf(resolveRun(manifest.run)) : undefined;
  const script = argv?.slice(1).find((a) => !a.startsWith("-")) ?? MANIFEST_FILE;
  if (problems.length === 0 && argv === undefined) add({ file: MANIFEST_FILE, field: "run", expected: "an argv list for this platform", found: "no entry for this platform", fix: "Add a run entry for this platform, or use one argv list for every platform." });
  const read = readDiffSamples(dir);
  for (const p of read.problems) add(p);
  const graded = new Set<string>();
  let sent = 0;
  if (argv !== undefined) {
    let handle: Awaited<ReturnType<typeof startConnector>> | undefined;
    try {
      handle = await startConnector({ dir, run: argv, id: `test:${dir}`, helloTimeoutMs: timeoutMs, envNames: permittedEnvOf(manifest), env: { [TEST_SAMPLES_ENV]: read.dir } });
    } catch {
      add({ file: script, field: "hello", expected: "an object answer to hello", found: "no valid answer", fix: "Make the connector answer the hello request with a JSON object on one line of standard output." });
    }
    if (handle !== undefined) {
      try {
        const level = helloLevel(handle.hello);
        for (const sample of read.samples) {
          sent++;
          if (await gradeSample(handle, sample, level, timeoutMs, script, add)) graded.add(sample.class);
        }
      } finally {
        await handle.stop();
      }
    }
  }
  const untested = REQUIRED_SAMPLE_CLASSES.filter((c) => !graded.has(c) && !read.samples.some((s) => s.class === c)).map((c) => `no "${c}" sample in ${SAMPLES_REL} (${CLASS_WORDS[c]}), so this connector's diffs answer for it was not tested`);
  // A required class whose samples were all sent but none graded already carries a problem; a class never sent (no hello, no run) is untested too.
  for (const c of REQUIRED_SAMPLE_CLASSES) if (!graded.has(c) && read.samples.some((s) => s.class === c) && !problems.some((p) => p.field.includes(`(${c})`))) untested.push(`the "${c}" samples were not sent, so this connector's diffs answer for it was not tested`);
  const notes = sent > 0 ? [`diffs: graded on the author's samples in ${SAMPLES_DIR}/, which are the author's recorded history; the live product was not contacted by this test`] : [];
  return { exitCode: problems.length === 0 && untested.length === 0 ? 0 : 1, stdout: render(problems, notes, untested), stderr: "" };
}

/** One sample, P6_RUNS `diffs` requests. True when every answer was read and graded (pass or fail is in the problems); false when grading stopped early. */
async function gradeSample(handle: Awaited<ReturnType<typeof startConnector>>, sample: DiffSample, level: 1 | 2 | 3 | undefined, timeoutMs: number, script: string, add: (p: Problem) => void): Promise<boolean> {
  const field = `${SAMPLES_REL} samples[${sample.index}] (${sample.class}) diffs`;
  const fail = (expected: string, found: string, fix: string): false => (add({ file: script, field, expected, found, fix }), false);
  const answers: unknown[] = [];
  const errors: string[] = [];
  for (let i = 0; i < P6_RUNS; i++) {
    try {
      answers.push(await handle.call("diffs", sample.params, { timeoutMs }));
    } catch (error) {
      if (!/answered with an error/.test((error as Error).message)) return fail(`an answer on every one of ${P6_RUNS} runs`, `no answer on run ${i + 1}`, "Answer every diffs request with a result or an error, within the timeout.");
      errors.push((error as Error).message);
    }
  }
  if (sample.class === "failed-read") {
    if (answers.length > 0) return fail("an error on every run (a read that fails is an error)", describeAnswer(answers[0]), "Answer a read you could not do with an error, never with null, an empty document or a document that says nothing changed: CoCheck would record that nothing changed and the change would be lost.");
    return true;
  }
  // A class the standard does not require is optional: an error on every run is a consistent answer for it, so only the shared checks apply.
  if (errors.length === P6_RUNS && !(REQUIRED_SAMPLE_CLASSES as readonly string[]).includes(sample.class)) return true;
  if (errors.length > 0) return fail(`a change document on every one of ${P6_RUNS} runs`, `an error on ${errors.length} run${errors.length === 1 ? "" : "s"}`, `This sample is a ${sample.class} window the author recorded: answer it from the recorded history in the folder ${TEST_SAMPLES_ENV} names.`);
  for (let i = 1; i < answers.length; i++) if (canonical(answers[i]) !== canonical(answers[0])) return fail(`the same answer on every one of ${P6_RUNS} runs`, `a different answer on run ${i + 1}`, "Answer the same window with the same document every time.");
  const answer = answers[0];
  const bad = checkChanges(answer, level);
  if (bad.length > 0) return fail(level !== undefined ? `a change document valid at level ${level} or below` : "a valid change document", `${describeAnswer(answer)} (${bad[0]!.field}: expected ${bad[0]!.expected})`, level !== undefined ? `Answer a ${CHANGES_SPEC} document that holds nothing above the level hello declares.` : "Answer a change document, as the spec's diff answer section shows.");
  const count = (answer as { changes: unknown[] }).changes.length;
  if (sample.class === "changed" && count === 0) return fail("at least one change (the author recorded this window as changed)", "no change", "Report the changes the recorded history holds in this window.");
  if (sample.class === "no-change" && count > 0) return fail("no change (the author recorded this window as unchanged)", `${count} change${count === 1 ? "" : "s"}`, "Report only the entries whose own time is in since <= time < until.");
  return true;
}

const describeAnswer = (a: unknown): string => (a === null ? "null" : typeof a !== "object" ? JSON.stringify(a) ?? "nothing" : Object.keys(a).length === 0 ? "an empty document" : Array.isArray((a as { changes?: unknown }).changes) ? `a document with ${(a as { changes: unknown[] }).changes.length} changes` : "a document");
