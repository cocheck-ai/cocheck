import { cleanId } from "../agent-transcripts.ts";
import { profileOf } from "../hosts/index.ts";
import type { RawOp } from "./runs.ts";

/** The error text of a call the host's session file lists as failed: the exit code (or its absence) and the start of the output. */
export function exitFailureText(hit: { exitCode: number | null; output: string }): string {
  const head = hit.exitCode === null ? "The command failed (the host recorded no exit code)." : `The command exited with code ${hit.exitCode}.`;
  return hit.output.trim() === "" ? head : `${head}\n${hit.output}`;
}

/**
 * A call recorded as finished whose rollout item was written after its Post. For each `post`-closed call of a host whose session file
 * lists exit statuses (`sessionFile.callExit`), the file is read now; a call it lists as failed is returned as a failure (marked inferred), in a new
 * array. Stored ops are never rewritten. The match is by the call id only. A call with exit 0, no listing, or no file is returned unchanged.
 */
export function markFailedFromSessionFile(ops: RawOp[], root?: string): RawOp[] {
  let out: RawOp[] | undefined;
  ops.forEach((op, at) => {
    if (typeof op.args_json !== "string" || !op.args_json.includes('"post"')) return;
    try {
      const a = JSON.parse(op.args_json) as Record<string, unknown>;
      if (a === null || typeof a !== "object" || a.closedBy !== "post" || typeof a.tool_use_id !== "string" || typeof a.host !== "string") return;
      const sf = profileOf(a.host).sessionFile;
      const session = cleanId(a.session_id);
      const at0 = typeof a.openedAt === "number" && Number.isFinite(a.openedAt) ? a.openedAt : undefined;
      if (sf.callExit === undefined || session === undefined || at0 === undefined) return;
      const agent = cleanId(a.agent_id);
      const rollout = agent === undefined ? sf.locate(session, at0, root) : sf.locateHelper?.(session, agent, at0, root);
      const hit = rollout === undefined ? undefined : sf.callExit(rollout)?.get(a.tool_use_id);
      if (hit === undefined) return;
      out ??= [...ops];
      out[at] = { ...op, args_json: JSON.stringify({ ...a, closedBy: "failure", error: exitFailureText(hit), errorInferred: true }) };
    } catch {
      // not a call op
    }
  });
  return out ?? ops;
}
