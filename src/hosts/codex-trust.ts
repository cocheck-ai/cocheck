// Codex skips a hook that is untrusted or whose content changed, with no trace (platforms/discrepancies.json hook-trust-silent-skip).
// CoCheck cannot write the trust record for the person (the hash is Codex's own and no source the register holds says how it is made), so
// `cocheck status` reads it back through `codex app-server` `hooks/list` and says when CoCheck's hooks will not run.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexBin } from "./codex-bin.ts";

/** Reads the `hooks/list` result for a Codex home; undefined when Codex could not be asked. Tests pass a stub. */
type HooksListReader = (codexHome: string, env: NodeJS.ProcessEnv) => unknown;

interface ListedHook {
  eventName?: unknown;
  trustStatus?: unknown;
  enabled?: unknown;
  command?: unknown;
}

function listedHooks(result: unknown): ListedHook[] {
  const r = result as { hooks?: unknown; data?: unknown } | null;
  if (r === null || typeof r !== "object") return [];
  if (Array.isArray(r.hooks)) return r.hooks as ListedHook[];
  if (Array.isArray(r.data)) return (r.data as Array<{ hooks?: unknown }>).flatMap((d) => (d !== null && typeof d === "object" && Array.isArray(d.hooks) ? (d.hooks as ListedHook[]) : []));
  return [];
}

/**
 * The sentence `cocheck status` shows when Codex lists any of CoCheck's hooks as not trusted; undefined when all are trusted or the list
 * could not be read. A listing that carries the hook command is narrowed to CoCheck's (it names `hookPath`); the trimmed shape in the
 * record carries none, and then every listed hook counts.
 */
export function codexTrustProblem(result: unknown, hookPath: string): string | undefined {
  const all = listedHooks(result);
  const ours = all.filter((h) => typeof h.command !== "string" || h.command.includes(hookPath) || h.command.includes("--host codex"));
  const bad = ours.filter((h) => h.enabled !== false && h.trustStatus !== "trusted");
  if (bad.length === 0) return undefined;
  const events = [...new Set(bad.map((h) => (typeof h.eventName === "string" ? h.eventName : "?")))].join(", ");
  const states = [...new Set(bad.map((h) => (typeof h.trustStatus === "string" ? h.trustStatus : "unknown")))].join(", ");
  return `Codex does not trust CoCheck's hooks (${events}: ${states}), so it skips them with no warning. Open Codex and trust the hooks once, then run cocheck status again`;
}

/** Asks `codex app-server` for `hooks/list`, through a child process that holds stdin open until the reply. Stays synchronous for its callers. Best effort: any failure, or no Codex anywhere, is undefined, never an error. */
export const readCodexHooksList: HooksListReader = (codexHome, env) => {
  const bin = resolveCodexBin(env);
  if (bin === undefined) return undefined;
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL(`./codex-trust-probe${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url)), bin, codexHome], { encoding: "utf8", timeout: 12000, env });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("{"));
    return line === undefined ? undefined : JSON.parse(line);
  } catch {
    return undefined;
  }
};
