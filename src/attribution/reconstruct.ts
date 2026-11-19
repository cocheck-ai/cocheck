// Proof by exact reconstruction. A host file-edit call reports what it did to a file; replaying exactly that on the file's recorded state
// before the call must give the recorded state after it (same hash). Pure: no host name, no I/O. Anything not replayable exactly gives `undefined`.

/** One `*** Add File` / `*** Update File` section of a patch: its body lines as written (`+`, `-`, ` `, `@@`). */
export interface PatchSection {
  add: boolean;
  lines: string[];
}

/** What a call reported doing to one file: whole new content (by hash), old to new replacements, or patch sections. Exactly one of the three. */
export interface ReportedEdit {
  path: string;
  sha?: string;
  edits?: Array<{ old: string; new: string; all: boolean }>;
  sections?: PatchSection[];
}

export const RECONSTRUCT_MAX_BYTES = 8 * 1024 * 1024;

/** Replaces as the Edit tools do: `old` must occur exactly once unless `all`; an empty `old` only fills an empty file. */
function applyEdits(text: string, edits: NonNullable<ReportedEdit["edits"]>): string | undefined {
  for (const e of edits) {
    if (e.old === "") {
      if (text !== "") return undefined;
      text = e.new;
      continue;
    }
    const first = text.indexOf(e.old);
    if (first < 0) return undefined;
    if (!e.all && text.indexOf(e.old, first + 1) >= 0) return undefined;
    text = e.all ? text.split(e.old).join(e.new) : text.slice(0, first) + e.new + text.slice(first + e.old.length);
  }
  return text;
}

/** Applies patch sections to `text` (LF text only): each hunk's context and removed lines must be found, in order, from where the last one ended. */
function applySections(text: string, sections: PatchSection[]): string | undefined {
  for (const sec of sections) {
    if (sec.add) {
      if (sec.lines.some((l) => !l.startsWith("+"))) return undefined;
      text = sec.lines.map((l) => l.slice(1) + "\n").join("");
      continue;
    }
    const lines = text === "" ? [] : text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const hunks: string[][] = [];
    for (const l of sec.lines) {
      if (l.startsWith("@@")) hunks.push([]);
      else {
        if (hunks.length === 0) hunks.push([]);
        hunks[hunks.length - 1]!.push(l);
      }
    }
    let cursor = 0;
    for (const h of hunks) {
      const oldSeq: string[] = [];
      const newSeq: string[] = [];
      for (const l of h) {
        const c = l[0];
        if (l === "") {
          oldSeq.push("");
          newSeq.push("");
        } else if (c === " ") {
          oldSeq.push(l.slice(1));
          newSeq.push(l.slice(1));
        } else if (c === "-") oldSeq.push(l.slice(1));
        else if (c === "+") newSeq.push(l.slice(1));
        else return undefined;
      }
      let at = lines.length;
      if (oldSeq.length > 0) {
        at = -1;
        for (let i = cursor; i + oldSeq.length <= lines.length && at < 0; i++) if (oldSeq.every((x, k) => lines[i + k] === x)) at = i;
        if (at < 0) return undefined;
      }
      lines.splice(at, oldSeq.length, ...newSeq);
      cursor = at + newSeq.length;
    }
    text = lines.length === 0 ? "" : lines.join("\n") + "\n";
  }
  return text;
}

/**
 * Every hash the file may have after the call, exact replay only. A patch writes LF lines; a Windows host may save the file with CRLF, so a
 * patch replay gives the LF result and the same result with every line ending CRLF. A before-state that mixes endings or holds a lone CR gives
 * nothing (the CRLF form needs every ending to be CRLF). Both forms are exact: the recorded hash must equal one of them whole.
 */
export function reconstructAll(rep: ReportedEdit, before: Uint8Array | undefined, sha256: (x: string) => string): string[] {
  if (rep.sha !== undefined) return [rep.sha];
  if (rep.sections === undefined || before === undefined || before.length > RECONSTRUCT_MAX_BYTES || before.includes(0)) {
    const one = reconstruct(rep, before, sha256);
    return one === undefined ? [] : [one];
  }
  let src: string;
  try {
    src = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(before);
  } catch {
    return [];
  }
  const crlf = src.includes("\r");
  if (crlf && /\r(?!\n)|(?<!\r)\n/.test(src)) return [];
  const out = rep.sections.some((x) => x.lines.some((l) => l.includes("\r"))) ? undefined : applySections(crlf ? src.replace(/\r\n/g, "\n") : src, rep.sections);
  if (out === undefined) return [];
  return crlf ? [sha256(out.replace(/\n/g, "\r\n"))] : [sha256(out), sha256(out.replace(/\n/g, "\r\n"))];
}

/**
 * The hash the file must have after the call, if the call's report is replayed exactly on `before` (the recorded bytes just before the call: empty when
 * the file did not exist, undefined when they are not available). `sha256` hashes text or bytes. undefined: cannot be reconstructed exactly
 * (no before-state, binary, over the size cap, a patch that does not apply, an old string not found or ambiguous), so the change stays inferred.
 */
export function reconstruct(rep: ReportedEdit, before: Uint8Array | undefined, sha256: (x: string) => string): string | undefined {
  if (rep.sha !== undefined) return rep.sha;
  if (before === undefined || before.length > RECONSTRUCT_MAX_BYTES || before.includes(0)) return undefined;
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let src: string;
  try {
    src = text.decode(before);
  } catch {
    return undefined;
  }
  const out = rep.edits !== undefined ? applyEdits(src, rep.edits) : rep.sections !== undefined ? (src.includes("\r") ? undefined : applySections(src, rep.sections)) : undefined;
  return out === undefined ? undefined : sha256(out);
}
