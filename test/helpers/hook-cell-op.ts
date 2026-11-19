import { cellHash, observedKey } from "../../src/office/connector/xlsx/written.ts";
import type { LayerOp } from "../../src/formats/layer.ts";

/** A cell as `hookCellOf` (src/hook-adapter.ts) records it: where, and the hash of what it held after the call. */
export const hookCell = (sheet: string, cell: string, value: unknown, formula: string | null = null) =>
  ({ sheet, cell, hash: cellHash(observedKey(value, formula)) });

/** The args of an op the host-hook adapter records for a closed call that changed `cells` in `path` (the shape of `record` in src/hook-adapter.ts). */
export const hookArgs = (path: string, cells: Array<ReturnType<typeof hookCell>>, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ hookAdapter: 1, tool_use_id: "call-1", closedBy: "post", host: "claude", session_id: "sess", tool_name: "Bash", path, hookCells: cells, ...extra });

/** The op as the layer sees it (tool is the host's own tool name). */
export const hookOp = (opId: number, path: string, cells: Array<ReturnType<typeof hookCell>>, extra: Record<string, unknown> = {}): LayerOp =>
  ({ opId, tool: "Bash", args: hookArgs(path, cells, extra), intent: "i", client: "c" });
