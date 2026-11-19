/**
 * Sequence alignment for the file layer's line and CSV-row diffs (and the Office connector's paragraph diffs): a longest-common-
 * subsequence pass after trimming the identical head and tail, then adjacent delete/insert runs
 * are paired position by position as "changed" so an edited line reads as one change, not two.
 */

export interface AlignedPair {
  /** Index into the before sequence; `null` for a pure addition. */
  before: number | null;
  /** Index into the after sequence; `null` for a pure removal. */
  after: number | null;
}

/** LCS table cells above this fall back to pairing the differing middle by position, skipping positions whose two sides are equal. */
const MAX_LCS_CELLS = 4_000_000;

/** The non-identical pairs of `a` (before) against `b` (after), in file order. */
export function alignSequences(a: string[], b: string[]): AlignedPair[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length === 0 && midB.length === 0) return [];

  const script = midA.length * midB.length <= MAX_LCS_CELLS ? lcsScript(midA, midB) : null;
  const pairs: AlignedPair[] = [];
  if (script === null) {
    const n = Math.max(midA.length, midB.length);
    for (let i = 0; i < n; i++) {
      // An in-place edit leaves most positions equal; those are not changes.
      if (i < midA.length && i < midB.length && midA[i] === midB[i]) continue;
      pairs.push({ before: i < midA.length ? head + i : null, after: i < midB.length ? head + i : null });
    }
    return pairs;
  }
  let dels: number[] = [];
  let ins: number[] = [];
  const flush = () => {
    const n = Math.max(dels.length, ins.length);
    for (let i = 0; i < n; i++) {
      pairs.push({ before: i < dels.length ? head + dels[i]! : null, after: i < ins.length ? head + ins[i]! : null });
    }
    dels = [];
    ins = [];
  };
  for (const op of script) {
    if (op.type === "keep") flush();
    else if (op.type === "delete") dels.push(op.i);
    else ins.push(op.j);
  }
  flush();
  return pairs;
}

type Step = { type: "keep" } | { type: "delete"; i: number } | { type: "insert"; j: number };

function lcsScript(a: string[], b: string[]): Step[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  const out: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "keep" });
      i++;
      j++;
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) {
      out.push({ type: "delete", i: i++ });
    } else {
      out.push({ type: "insert", j: j++ });
    }
  }
  while (i < n) out.push({ type: "delete", i: i++ });
  while (j < m) out.push({ type: "insert", j: j++ });
  return out;
}
