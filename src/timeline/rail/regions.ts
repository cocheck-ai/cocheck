import { existsSync } from "node:fs";
import path from "node:path";
import type { Ledger, RegionRow } from "../../ledger.ts";
import { regionsDirOf } from "../../states.ts";

/**
 * Regions the person pointed at, as the prompt and the agent read them. A picture region's PNG lives plain at
 * `<home>/tasks/<task>/regions/<id>.png`; the path is given only while the file is still there (the five-week expiry deletes the folder).
 */
export interface RegionRef {
  id: number;
  /** The step (stop id) whose failed note carries the region, or null for the overall note. */
  stop: string | null;
  /** Where it is, in words: the file, the version and the sheet and range, line range or page. */
  where: string;
  /** The listed text of a cells or lines region (cell texts, lines), at most `MAX_REGION_LINES`; empty for a picture or an expired region. */
  lines: string[];
  /** The absolute path of the PNG, or null when the region has none or the file is gone. */
  picture: string | null;
}

/** Text lines kept with one cells or lines region. */
export const MAX_REGION_LINES = 25;

export function regionPicturePath(home: string, taskId: number, id: number): string {
  return path.join(regionsDirOf(home, taskId), `${id}.png`);
}

function refOf(home: string, row: RegionRow, stop: string | null): RegionRef {
  const file = regionPicturePath(home, row.taskId, row.id);
  const listed = row.rect !== null && typeof row.rect === "object" && !Array.isArray(row.rect) ? (row.rect as { lines?: unknown }).lines : undefined;
  const lines = Array.isArray(listed) ? listed.filter((l): l is string => typeof l === "string").slice(0, MAX_REGION_LINES) : [];
  return { id: row.id, stop, where: row.where, lines, picture: row.picture && existsSync(file) ? file : null };
}

/** The regions linked to the verdict `verdictId`, oldest first; each carries that verdict's stop. */
export function regionsForVerdict(ledger: Ledger, home: string, verdictId: number): RegionRef[] {
  return ledger.regionsOfVerdict(verdictId).map((r) => refOf(home, r, r.stopId ?? null));
}

/** The regions of `taskId` with these ids, in the order asked; an id that is not a region of this task is left out. A region linked to a verdict carries that verdict's stop. */
export function regionsById(ledger: Ledger, home: string, taskId: number, ids: readonly number[]): RegionRef[] {
  const rows = new Map(ledger.regionsForTask(taskId).map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = rows.get(id);
    return r === undefined ? [] : [refOf(home, r, r.stopId ?? null)];
  });
}
