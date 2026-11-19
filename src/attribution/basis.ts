// What a credit stands on. A change is credited to calls; this says why those calls and not others. Stored beside the credit
// (`file_states.credit_basis`), read later to tell proof from inference. Pure: no host name, no I/O.

/** How a credit was reached, strongest first. `declared` and `joint` are named for hosts and rules that come later; nothing writes them yet. `host-reported-edit` is written by `hostReportedEdit`. */
export const PROOF_METHODS = ["argv-tag", "host-reported-edit", "declared", "named", "window", "joint", "unattributed"] as const;
export type ProofMethod = (typeof PROOF_METHODS)[number];

/** One piece of proof a host event carries. */
export interface ProofRecord {
  proof_method: ProofMethod;
  /** The call the proof names, when it names one. */
  callId?: string;
  /** The file the proof is about, when it is about one. */
  file?: string;
}

/** The methods that are proof. Any other basis, and a missing one (a row from before the basis was stored), is inference. */
const PROVEN_METHODS: readonly ProofMethod[] = ["argv-tag", "host-reported-edit"];
export const isInferredBasis = (basis: string | null | undefined): boolean => !(PROVEN_METHODS as readonly string[]).includes(basis ?? "");

interface BasisFacts {
  /** The calls credited with the change. */
  credited: readonly string[];
  /** The calls a per-call tag on the writing process's argv recorded as writers of this file; empty when there is no tag evidence. */
  taggedWriters: readonly string[];
  /** The credit was narrowed to calls whose own input or record names the file. */
  named: boolean;
  /** `hostReportedEdit` held for this change. Never read for a change that is also argv-tag. */
  hostEdit?: boolean;
}

/** What `hostReportedEdit` needs to know of one call: whether it is a host file-edit tool call, and the absolute paths its own input names. */
interface EditCall {
  /** The call's absolute edit targets as the host reported them (unresolved); absent for a call that is not a host file-edit tool or names a relative path. */
  edits?: readonly string[];
}

/**
 * A change stands on a host-reported edit when every credited call is a host file-edit call that names this file by an absolute path of
 * its own (`same` compares through the path kit), the tag evidence names no other writer, the call did not fail (`failed`), and the bytes recorded for the file are what the call reported writing (`content`: a process that rewrote the file after it leaves other bytes). An open call the credit was narrowed away from no longer blocks it (the exact replay is the proof; a concurrent writer of other bytes fails it; one of the same bytes is undetectable, a declared bound). Any doubt is false: the change stays inferred.
 */
export function hostReportedEdit(f: { credited: readonly string[]; taggedWriters: readonly string[]; file: string; call: (id: string) => EditCall | undefined; same: (a: string, b: string) => boolean; failed: (id: string) => boolean; /** The call's own reported content for this file matches the recorded bytes. */ content: (id: string) => boolean }): boolean {
  if (f.credited.length === 0) return false;
  if (!f.taggedWriters.every((id) => f.credited.includes(id))) return false;
  return f.credited.every((id) => !f.failed(id) && (f.call(id)?.edits ?? []).some((e) => f.same(e, f.file)) && f.content(id));
}

/**
 * The basis of one change's credit. `argv-tag` only when the change is credited to someone and every credited call is a call the tag
 * evidence names for this file: with no tag evidence, or a credited call the tag does not name, it is never `argv-tag`.
 */
export function creditBasisOf(f: BasisFacts): ProofMethod {
  if (f.credited.length === 0) return "unattributed";
  if (f.credited.every((id) => f.taggedWriters.includes(id))) return "argv-tag";
  if (f.hostEdit === true) return "host-reported-edit";
  return f.named ? "named" : "window";
}
