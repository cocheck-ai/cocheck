import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CONNECTOR_SERVICE_PREFIX, type Platform } from "./platform/types.ts";
import { readInstalledManifests } from "./connector/installed-manifests.ts";
import { overlapsOf, overlapWarning } from "./connector/installed-match.ts";
import { readEnabledTypes, typeStates } from "./connector/enabled-types.ts";
import { claimantsOf } from "./connector-types-cli.ts";
import { ownNode, resolveRun } from "./connector/run-argv.ts";
import { startConnector } from "./connector/runner.ts";

/**
 * `cocheck connector doctor [<id>]`: one line per check for each installed connector. A credential's value is read only inside the runner's
 * hello (as in production); the doctor itself asks the store only whether an item exists and never prints, logs or measures it. Reasons are
 * fixed plain sentences: no runner id, no absolute path, and nothing the connector wrote.
 */

interface DoctorResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

interface DoctorRun {
  home: string;
  store: Pick<Platform["secretStore"], "get">;
  env?: NodeJS.ProcessEnv;
  /** Default 5000. */
  helloTimeoutMs?: number;
}

interface Check {
  ok: boolean;
  text: string;
}

const HELLO_MS = 5000;

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  const exts = [""].concat((env.PATHEXT ?? "").split(";").filter((e) => e !== ""));
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

function commandFound(cmd: string, dir: string, env: NodeJS.ProcessEnv): boolean {
  if (/[\\/]/.test(cmd) || cmd.startsWith(".")) {
    try {
      return statSync(path.resolve(dir, cmd)).isFile();
    } catch {
      return false;
    }
  }
  return onPath(cmd, env);
}

function helloReason(message: string, ms: number): string {
  if (/timed out/.test(message)) return `no answer to hello within ${ms / 1000} seconds`;
  if (/not stored|credential store/.test(message)) return "a credential could not be read, so hello was not tried";
  if (/answered with an error/.test(message)) return "hello was answered with an error";
  if (/did not answer with an object/.test(message)) return "hello was answered with something that is not a JSON object";
  if (/exited|closed its input/.test(message)) return "the connector stopped before it answered hello";
  if (/could not start|failed/.test(message)) return "the connector could not be started";
  return "hello failed";
}

async function checkOne(label: string, dir: string, file: string, parseProblem: string | undefined, run: DoctorRun): Promise<{ ok: boolean; lines: string[] }> {
  const env = run.env ?? process.env;
  const ms = run.helloTimeoutMs ?? HELLO_MS;
  const checks: Check[] = [];
  const add = (ok: boolean, text: string): void => void checks.push({ ok, text });
  if (parseProblem !== undefined) {
    add(false, `manifest valid: no, ${parseProblem}`);
    return render(label, checks);
  }
  add(true, "manifest valid");
  let raw: { run?: unknown; id?: string; credentials?: { name: string }[]; requires?: { binaries?: unknown } } = {};
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as typeof raw;
  } catch {
    /* it parsed a moment ago; treat a vanished file as an unreadable manifest */
    checks[0] = { ok: false, text: "manifest valid: no, the manifest could not be read" };
    return render(label, checks);
  }
  const resolved = resolveRun(raw.run);
  const argv = resolved === undefined ? undefined : ownNode(resolved);
  const found = argv !== undefined && commandFound(argv[0]!, dir, env);
  add(found, argv === undefined ? "run command found: no, the manifest has no run command for this system" : found ? "run command found" : "run command found: no");
  const binaries = Array.isArray(raw.requires?.binaries) ? (raw.requires!.binaries as unknown[]).filter((b): b is string => typeof b === "string") : [];
  for (const b of binaries) add(onPath(b, env), `required binary "${b}" found: ${onPath(b, env) ? "yes" : "no"}`);
  const creds = (raw.credentials ?? []).map((c) => c.name);
  let allStored = true;
  for (const name of creds) {
    let stored: boolean;
    try {
      stored = run.store.get(CONNECTOR_SERVICE_PREFIX + (raw.id ?? label), name) !== null;
    } catch {
      add(false, `credential "${name}" stored: could not be checked`);
      allStored = false;
      continue;
    }
    if (!stored) allStored = false;
    add(stored, `credential "${name}" stored: ${stored ? "yes" : "no"}`);
  }
  if (argv === undefined || !found || !allStored) {
    add(false, "hello answered: not tried, an earlier check failed");
    return render(label, checks);
  }
  try {
    const handle = await startConnector({
      dir,
      run: argv,
      id: raw.id ?? label,
      credentials: creds.map((name) => ({ name })),
      secretStore: run.store,
      helloTimeoutMs: ms,
    });
    await handle.stop();
    add(true, `hello answered within ${ms / 1000} seconds`);
  } catch (error) {
    add(false, `hello answered within ${ms / 1000} seconds: no, ${helloReason((error as Error).message, ms)}`);
  }
  return render(label, checks);
}

function render(label: string, checks: Check[]): { ok: boolean; lines: string[] } {
  return { ok: checks.every((c) => c.ok), lines: [label, ...checks.map((c) => `  ${c.ok ? "ok  " : "FAIL"} ${c.text}`)] };
}

export async function runConnectorDoctor(argv: string[], run: DoctorRun): Promise<DoctorResult> {
  if (argv.length > 1 || (argv[0] ?? "").startsWith("-")) return { exitCode: 1, stdout: "", stderr: "usage: cocheck connector doctor [<id>]\n" };
  const want = argv[0];
  const skipped = new Map<string, string>();
  const installed = readInstalledManifests(run.home, {
    onSkip: (file, why) => void skipped.set(path.basename(path.dirname(file)), why.split("\n")[0]!),
    onFolderError: () => void 0,
  });
  const entries: { label: string; dir: string; file: string; problem?: string }[] = [
    ...installed.map((m) => ({ label: m.manifest.id, dir: path.dirname(m.file), file: m.file })),
    ...[...skipped].map(([d, why]) => ({ label: d, dir: path.join(run.home, "connectors", d), file: path.join(run.home, "connectors", d, "cocheck-connector.json"), problem: plainProblem(why) })),
  ].sort((a, b) => a.label.localeCompare(b.label));
  const chosen = want === undefined ? entries : entries.filter((e) => e.label === want || path.basename(e.dir) === want);
  if (want !== undefined && chosen.length === 0) return { exitCode: 1, stdout: "", stderr: `no connector "${want}" is installed\n` };
  if (chosen.length === 0) return { exitCode: 0, stdout: "No connectors are installed.\n", stderr: "" };
  let ok = true;
  const out: string[] = [];
  for (const e of chosen) {
    const r = await checkOne(e.label, e.dir, e.file, e.problem, run);
    ok = ok && r.ok;
    out.push(r.lines.join("\n"));
  }
  // Where two installed connectors claim the same call or subject, one wins by the stated order; the losers are named here (a warning, never a failure).
  const overlaps = overlapsOf(installed).filter((o) => want === undefined || [o.winner, ...o.losers].includes(chosen[0]!.label)).map(overlapWarning);
  // A type an installed connector claims but is not enabled for is said here once, a note, never a failure; so is an unusable setting file.
  const setting = readEnabledTypes(run.home);
  if (setting.warning !== undefined) overlaps.push(setting.warning);
  for (const s of typeStates(claimantsOf(run.home), setting)) for (const c of s.claimants) {
    if (c.builtin || c.id === s.enabled || !chosen.some((e) => e.label === c.id)) continue;
    overlaps.push(`note: "${c.id}" claims ${s.type} but is not enabled for it (enabled: ${s.enabled ?? "none"}); \`cocheck connector enable ${c.id} ${s.type}\` switches it`);
  }
  if (overlaps.length > 0) out.push(overlaps.join("\n"));
  return { exitCode: ok ? 0 : 1, stdout: out.join("\n\n") + "\n", stderr: "" };
}

/** A skip reason without a file path: the manifest's own problem text, or a plain fallback. */
function plainProblem(why: string): string {
  return /^connectors\/|SyntaxError|JSON|Unexpected/.test(why) ? (/does not match its folder/.test(why) ? "the manifest id does not match its folder name" : /over 64/.test(why) ? "the manifest is too large" : /regular file/.test(why) ? "the manifest is not a regular file" : "the manifest is not valid JSON or cannot be read") : why.replace(/\/[^\s]*/g, "").trim() || "the manifest has a problem";
}
