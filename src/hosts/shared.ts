// What Claude Code and Codex share and a new host need not: their payload keys for a failed call and for the fields CoCheck keeps but does not act on.
// Moved out of normalize.ts so that file names no payload key of any host.
import type { EventKind, ExtraFields, FailureRead } from "./types.ts";

/** The failure a post-like event reports in the Claude/Codex payload shape: a failure event, or a post whose `tool_response` carries `is_error` / `isError`. */
export function claudeShapeFailure(kind: EventKind, p: Record<string, unknown>): FailureRead {
  const resp = p.tool_response as Record<string, unknown> | string | null | undefined;
  const flagged = resp !== null && typeof resp === "object" && (resp.is_error === true || resp.isError === true);
  if (kind !== "tool-failure" && !flagged) return undefined;
  let raw = typeof p.error === "string" ? p.error : "";
  if (raw === "" && flagged) {
    const content = (resp as Record<string, unknown>).content;
    if (typeof content === "string") raw = content;
    else if (Array.isArray(content)) raw = content.flatMap((c) => (c !== null && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? [(c as { text: string }).text] : [])).join("\n");
    else if (typeof (resp as Record<string, unknown>).error === "string") raw = (resp as Record<string, string>).error;
  }
  return { raw, interrupted: p.is_interrupt === true };
}

/** The extras in the Claude/Codex payload shape. */
export function claudeShapeExtra(p: Record<string, unknown>): ExtraFields {
  const extra: ExtraFields = {};
  if (typeof p.turn_id === "string") extra.turnId = p.turn_id;
  if (typeof p.permission_mode === "string") extra.permissionMode = p.permission_mode;
  if (typeof p.model === "string") extra.model = p.model;
  if (typeof p.stop_hook_active === "boolean") extra.stopHookActive = p.stop_hook_active;
  return extra;
}
