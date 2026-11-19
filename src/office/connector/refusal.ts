// How an app's refusal of a file is said in the answer. A side the app would not open (a prompt, or an open with no document) is a finding about
// that file, carried at the level the connector spec gives it: a picture-level `status` on a placeholder picture for that side when the other side is pictured, the
// document-level `status` when nothing is pictured. When EVERY side CoCheck opened met a prompt, the prompt is as likely the app's own (sign-in, licence, first run, update) as
// anything in the files, so it is said as that, with no finding and no status.
import type { OfficeApp } from "./apps.ts";

export type Refusal = { kind: "prompt" | "refused"; why: string };
export type Side = "before" | "after";
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export interface RefusalWords {
  caveats: string[];
  /** Document-level status: only when no picture is shipped. */
  status?: { kind: "prompt" | "refused"; evidence: string };
  /** Stand-in pictures (no `src`) carrying the side's status: only when another picture is shipped. */
  standIns: { id: string; side: Side; type: "image"; label: string; status: { kind: "prompt" | "refused"; evidence: string } }[];
}

/** `sides`: the sides this answer has (a new file has only "after"); `pictured`: whether any picture is shipped. */
export function refusalWords(app: Pick<OfficeApp, "name" | "noun">, refused: ReadonlyMap<Side, Refusal>, sides: readonly Side[], pictured: boolean): RefusalWords {
  if (refused.size === 0) return { caveats: [], standIns: [] };
  const all = sides.length > 1 && sides.every((s) => refused.get(s)?.kind === "prompt");
  if (all) return { caveats: [`${app.name} showed a prompt on every ${app.noun} CoCheck asked it to open (before and after), so neither is pictured. The prompt may be ${app.name}'s own (sign-in, licence, update), not a problem with these files.`], standIns: [] };
  const said = [...refused].map(([side, r]) => ({ side, r, line: `${cap(side)}: ${r.why}.` }));
  const caveats = said.map((x) => x.line);
  if (!pictured) {
    const kinds = said.map((x) => x.r.kind);
    return { caveats, status: { kind: kinds.includes("prompt") ? "prompt" : "refused", evidence: caveats.join(" ") }, standIns: [] };
  }
  return { caveats, standIns: said.map((x) => ({ id: `${x.side}:not-opened`, side: x.side, type: "image" as const, label: `${cap(x.side)}: not opened`, status: { kind: x.r.kind, evidence: x.line } })) };
}
