// The one place a connector manifest's `run` becomes an argv for this OS. `run` is an argv list for every platform, or a map from
// platform name to argv list. validate.ts, conformance.ts, diff.ts and scripts/anchor-grade.ts all resolve it here, so they never disagree.
import { platform } from "../platform/index.ts";

/** The argv for `os` (default: this OS), or undefined when `run` is neither a string list nor a map with a string-list entry for it. */
export function resolveRun(run: unknown, os: string = platform().name): string[] | undefined {
  const ok = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
  if (Array.isArray(run)) return ok(run) ? run : undefined;
  if (typeof run === "object" && run !== null) {
    const v = (run as Record<string, unknown>)[os];
    return ok(v) ? v : undefined;
  }
  return undefined;
}

/** The argv with a bare `node` first word run on CoCheck's own Node (process.execPath), for every connector. Any other first word (an absolute path, `python3`, a relative path) is kept as written. */
export function ownNode(argv: string[]): string[] {
  return argv[0] === "node" ? [process.execPath, ...argv.slice(1)] : argv;
}

/** `resolveRun`, or an Error that names the OS when `run` has no entry for it. */
export function requireRun(run: unknown, os: string = platform().name): string[] {
  const argv = resolveRun(run, os);
  if (argv === undefined) throw new Error(`the manifest's run has no entry for ${os}`);
  return argv;
}
