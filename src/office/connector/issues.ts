// Migration X1 (spec v1.2 `issues`): the structure check runs inside the Office connectors. Only a `likely-repair` finding (a defect Office is
// known to refuse or repair) becomes an issue; a `tolerated` finding (Office opens the file quietly) and a clean result give nothing, because
// an issue on a file Office opens fine erodes trust in every warning. The check reads the after state, the file as the agent left it.
import { checkStructure, plainSentence } from "./shared/structure-check.ts";

export interface Issue { text: string; side?: "before" | "after"; where?: string }

/** The repair-level findings of one state as issues: `where` is the slide, sheet or document the finding maps to, else the package part. */
export function structureIssues(bytes: Uint8Array | null, file: string, side: "before" | "after" = "after"): Issue[] {
  if (bytes === null) return [];
  let result: ReturnType<typeof checkStructure>;
  try {
    result = checkStructure(bytes, file);
  } catch {
    return [];
  }
  if (result === null) return [];
  const out: Issue[] = [];
  const seen = new Set<string>();
  for (const f of result.findings) {
    if (f.severity !== "likely-repair") continue;
    const issue: Issue = { text: plainSentence(f, result.app), side, where: f.where ?? f.part };
    const key = `${issue.where}\u0000${issue.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}
