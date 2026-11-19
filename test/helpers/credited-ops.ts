import type { Ledger } from "../../src/ledger.ts";
import { hookCallOf, type ExplainingOp } from "../../src/tasks.ts";
import { normalizePathForCompare } from "../../src/paths.ts";

/**
 * The hook ops of a task credited with a change of `file` in the ledger's file states (the call ids named in `file_states.credited`),
 * in the shape the reason reader takes. It stands in for the review rows' `ops`.
 */
export function creditedOps(ledger: Ledger, taskId: number, file: string): ExplainingOp[] {
  const want = normalizePathForCompare(file);
  const calls = new Set(ledger.fileStatesForTask(taskId).filter((s) => normalizePathForCompare(s.filePath) === want).flatMap((s) => s.credited));
  const out: ExplainingOp[] = [];
  for (const op of ledger.okOpsForTask(taskId, 0, ledger.maxOpId())) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(op.argsJson) as Record<string, unknown>;
    } catch {
      continue;
    }
    const call = hookCallOf(args);
    if (call === undefined || !calls.has(call.callId) || typeof args.path !== "string" || normalizePathForCompare(args.path) !== want) continue;
    out.push({
      opId: op.id,
      tool: op.tool,
      intent: op.intent,
      client: op.clientName,
      callId: call.callId,
      ...(typeof args.description === "string" ? { description: args.description } : {}),
      ...(typeof args.reasonFallback === "string" ? { reasonFallback: args.reasonFallback } : {}),
      background: call.background,
    });
  }
  return out;
}
