/**
 * Turns two `WorkbookSnapshot`s into reviewable `DiffRow[]`. A naive cell-by-cell compare
 * would flag every cell below an inserted/deleted row as "changed" (its formula's references
 * shifted, its address moved). Instead this aligns rows first - so a shift alone produces
 * nothing, and only the row that was actually inserted/deleted, plus genuine edits, show up.
 *
 * Alignment is two-phase:
 * 1. Anchors - rows whose content signature (relative formula shapes + literal values) is
 *    unique on *both* sides are matched via LCS. Uniqueness matters: two duplicate rows with
 *    one cell edited between them must not collide into a false delete+insert just because one
 *    of the duplicates now signature-matches the edited row's new content (see the
 *    `rowSignature` doc comment for the concrete case this fixes). Blank rows never anchor -
 *    two coincidentally-identical blank rows carry no real identity signal.
 * 2. Gaps - the rows left over between (or around) anchors. Equal-count gaps pair positionally
 *    (the common "single edit, no shift" case). Unequal-count gaps (an actual insert or delete)
 *    first trim off any identical-by-signature prefix/suffix, then run a Myers minimal edit
 *    script over the remaining middle's row signatures - this finds the true insert/delete/keep
 *    set regardless of gap size (a gap can be the whole sheet when nothing anchors), so a handful
 *    of genuine edits scattered through a huge low-cardinality gap still resolve to just those
 *    edits instead of drowning in false positives. Within each hunk of consecutive
 *    delete/insert ops the Myers script produces, unequal delete/insert counts are re-resolved by
 *    greedy best-cell-similarity (same as before), so an edited-and-shifted row still pairs with
 *    its own history rather than an unrelated neighbor. If the edit distance would exceed the
 *    algorithm's own budget, it falls back to the coarser windowed pairing and flags the gap's
 *    structure rows as approximate (see `MYERS_MAX_D`).
 *
 * Columns: a row insert and a column insert can land in one save, and each shift makes the other
 * pass see every cell move. So when any row's set of used columns changed, rows are first aligned
 * on what a column shift can't change (each row's filled cells by position, formulas with their
 * column parts dropped), and the same alignment then runs over the sheet transposed (one "row"
 * per column, its cells keyed by that row alignment) - see `alignColumns`. A column shift it
 * detects is reported as one `structure` row per inserted/deleted column (`M:M`), and each row's
 * cells are compared keyed by the before-column they came from, so cells that only moved sideways
 * compare against themselves. The column pass is all-or-nothing: any shifted column pair it can't
 * vouch for drops the column alignment for that sheet and the diff falls back to comparing columns
 * by letter, which keeps the moved cells visible rather than hiding them. A column shift that
 * crosses only empty columns can't say which of them was inserted; the structure row names the
 * leftmost (for the column-at-M case: M, not N). Deleting the last used column is reported like
 * deleting the last used row.
 *
 * Pure shifts: a formula whose text differs only because every reference in it moved with a
 * detected row or column insert/delete (in its own sheet or any other) is not a `formula`
 * change - see `isPureShift`. Rows appended below the last aligned row, and columns right of the
 * last aligned column, get no `structure` row.
 */
import type { CellSnapshot, DiffKind, DiffRow, SheetSnapshot, WorkbookSnapshot } from "./types.ts";
import { canonical15, numbersEqual } from "./numbers.ts";
import { colToNum, numToCol, parseAddress, remapFormulaRefs, toRelativeSignature, withoutColumns } from "./formula.ts";

type RowCells = Map<string, CellSnapshot>; // column letter -> cell

/** Work counters for tests: a deterministic substitute for wall-clock time when asserting a pass stays linear. */
export interface DiffOpCounts {
  /** Formula signatures computed (memo misses). */
  formulaSignatures: number;
  /** Cells folded into a row signature. */
  rowSignatureCells: number;
  /** Cell pairs handed to the cell compare. */
  cellsCompared: number;
}

// Null outside `countDiffOps`, so an ordinary diff pays one null check per counted step.
let probe: DiffOpCounts | null = null;

/** Runs `fn` and returns the work the diffs inside it did. Exposed for tests only; not reentrant. */
export function countDiffOps(fn: () => void): DiffOpCounts {
  const counts: DiffOpCounts = { formulaSignatures: 0, rowSignatureCells: 0, cellsCompared: 0 };
  probe = counts;
  try {
    fn();
  } finally {
    probe = null;
  }
  return counts;
}

/**
 * A formula cell's signature for alignment. One diff builds two per sheet: `toRelativeSignature`
 * (the default), memoized per cell since the alignment passes and the cell compare each ask for
 * it, and the same with column parts dropped (`columnFreeOf`), which a column shift leaves alone.
 */
type CellSig = (cell: CellSnapshot) => string;

function memoSig(compute: CellSig): CellSig {
  const cache = new Map<CellSnapshot, string>();
  return (cell) => {
    let sig = cache.get(cell);
    if (sig === undefined) {
      if (probe !== null) probe.formulaSignatures++;
      sig = compute(cell);
      cache.set(cell, sig);
    }
    return sig;
  };
}

/**
 * `withoutColumns` over `sig`, memoized by signature rather than by cell: a sheet has far fewer
 * distinct formula shapes than formula cells.
 */
function columnFreeOf(sig: CellSig): CellSig {
  const cache = new Map<string, string>();
  return (cell) => {
    const full = sig(cell);
    let free = cache.get(full);
    if (free === undefined) {
      free = withoutColumns(full);
      cache.set(full, free);
    }
    return free;
  };
}

/** Appends without spreading into call arguments, which overflows the stack past ~100k items. */
function pushAll<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) target.push(item);
}

/** Groups a sheet's cells by row number, each row keyed by column letter. */
function rowsOf(sheet: SheetSnapshot): Map<number, RowCells> {
  const rows = new Map<number, RowCells>();
  for (const cell of sheet.cells.values()) {
    const { row } = parseAddress(cell.address);
    const colLetters = cell.address.slice(0, cell.address.length - String(row).length);
    let rowCells = rows.get(row);
    if (!rowCells) {
      rowCells = new Map();
      rows.set(row, rowCells);
    }
    rowCells.set(colLetters, cell);
  }
  return rows;
}

/**
 * A row's identity signature: each formula cell's R1C1-relative form (so a pure row shift
 * doesn't change it) plus every literal value. Used only to find *anchors* (see module doc) -
 * signature equality is deliberately not the sole test for "is this the same row", because two
 * rows can share a signature without being the same row (e.g. before has A1=100, A2=200; after
 * has A1=200, A2=200 - after editing A1, row 2's signature "V:A:200" now collides with what row
 * 1 became). `alignRows` only trusts a signature match when it's unique on both sides; this
 * function just computes the signature. Keys marked `+`/`-` (a cell in an inserted or deleted
 * column or row, see `isUnmatchedKey`) are left out: what was added or removed doesn't say which
 * row this is.
 */
function rowSignature(sig: CellSig, cells: RowCells): string {
  const cols: string[] = [];
  let sorted = true;
  for (const col of cells.keys()) {
    if (isUnmatchedKey(col)) continue;
    if (sorted && cols.length > 0 && cols[cols.length - 1]! > col) sorted = false;
    cols.push(col);
  }
  if (!sorted) cols.sort();
  let out = "";
  for (const col of cols) {
    const cell = cells.get(col)!;
    if (probe !== null) probe.rowSignatureCells++;
    if (out !== "") out += "|";
    out += cell.formula !== null ? `F:${col}:${sig(cell)}` : `V:${col}:${JSON.stringify(typeof cell.value === "number" ? canonical15(cell.value) : cell.value)}`;
  }
  return out;
}

/** A `+`/`-` key: a cell in a column or row that only one side has. */
function isUnmatchedKey(key: string): boolean {
  return key.startsWith("+") || key.startsWith("-");
}

function isBlankRow(cells: RowCells): boolean {
  return [...cells.values()].every((c) => c.value === null && c.formula === null);
}

function valuesEqual(a: CellSnapshot["value"], b: CellSnapshot["value"]): boolean {
  if (typeof a === "number" && typeof b === "number") return numbersEqual(a, b);
  return a === b;
}

/**
 * How much two rows look like "the same row, possibly edited": +1 per column where both sides
 * have a cell and it matches exactly (same relative formula shape, or same literal value), +0.5
 * where both have a cell of the same kind (formula/literal) but it differs, 0 where either side
 * lacks the column or the two cells are different kinds (a formula replacing a literal or vice
 * versa carries no identity signal either way). Only used to rank candidates within a gap whose
 * before/after row counts differ - see `pairGap`.
 */
function cellSimilarity(sig: CellSig, before: RowCells, after: RowCells): number {
  const cols = new Set([...before.keys(), ...after.keys()]);
  let score = 0;
  for (const col of cols) {
    const x = before.get(col);
    const y = after.get(col);
    if (!x || !y) continue;
    if (x.formula !== null && y.formula !== null) {
      score += sig(x) === sig(y) ? 1 : 0.5;
    } else if (x.formula === null && y.formula === null) {
      score += valuesEqual(x.value, y.value) ? 1 : 0.5;
    }
  }
  return score;
}

interface AlignedPair {
  before: RowCells;
  after: RowCells;
  beforeRow: number;
  afterRow: number;
}
interface DeletedRow {
  before: RowCells;
  beforeRow: number;
  /** True when this row came out of a gap whose alignment exceeded the Myers edit-distance budget. */
  approximate?: boolean;
}
interface InsertedRow {
  after: RowCells;
  afterRow: number;
  approximate?: boolean;
}

/**
 * Longest common subsequence by exact signature equality; returns matched `[beforeIndex,
 * afterIndex]` pairs, in order, indexing into the two signature arrays supplied. Callers pass
 * anchor signatures, each unique on its own side, so the LCS is the longest increasing run of
 * after-positions taken in before order (patience diff): O(n log n) time and O(n) memory. A full
 * dynamic-programming table here was O(n*m) - 3.6 billion entries for two 60,000-row sheets, which
 * ran the process out of heap.
 */
function lcsMatch(beforeSig: string[], afterSig: string[]): Array<[number, number]> {
  const afterIndex = new Map<string, number>();
  afterSig.forEach((sig, j) => afterIndex.set(sig, j));
  const seq: Array<[number, number]> = [];
  beforeSig.forEach((sig, i) => {
    const j = afterIndex.get(sig);
    if (j !== undefined) seq.push([i, j]);
  });
  // tails[k]: index into `seq` of the smallest after-position ending an increasing run of length k+1.
  const tails: number[] = [];
  const prev = new Int32Array(seq.length).fill(-1);
  for (let s = 0; s < seq.length; s++) {
    const j = seq[s]![1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]![1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[s] = tails[lo - 1]!;
    tails[lo] = s;
  }
  const pairs: Array<[number, number]> = [];
  for (let s = tails.length > 0 ? tails[tails.length - 1]! : -1; s >= 0; s = prev[s]!) {
    pairs.push(seq[s]!);
  }
  return pairs.reverse();
}

function countOccurrences(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

/**
 * Above this many rows on either side of a gap's *trimmed* middle (see `pairGap`), the
 * similarity cross-product is skipped in favor of positional pairing - it would otherwise build
 * `windowSize^2` candidate objects. 200 keeps the worst case (40,000 candidates) trivial while
 * comfortably covering the "edited row next to an inserted row" case the similarity match exists
 * for, which is never more than a handful of rows once identical duplicates are trimmed off.
 */
const SIMILARITY_WINDOW = 200;

/**
 * The bounded similarity-matching step: ranks every (before, after) pairing in `bMid`/`aMid` by
 * `cellSimilarity` - highest first, ties preferring the same row number - and greedily takes the
 * top `min(count)` non-conflicting pairs; whichever rows are left unpaired become the reported
 * insert(s)/delete(s). This is what lets "an edited row that also shifted, sitting next to a
 * genuinely new row" resolve correctly instead of picking whichever row happens to come first.
 * Past `SIMILARITY_WINDOW` on either side, falls back to positional pairing instead of building
 * the full cross-product. That positional fallback is flagged `approximate` only when the two
 * sides also differ in count: an equal-count block paired positionally is still exactly right -
 * the same row positions genuinely had their contents replaced, so reporting them as value edits
 * is true, not a guess - it's only when counts differ that "pair everything up to the shorter
 * length, the rest becomes insert/delete" is a real approximation of an unresolved insert/delete
 * mixed in with edits.
 */
function pairGapWindowed(
  sig: CellSig,
  bMid: number[],
  aMid: number[],
  beforeMap: Map<number, RowCells>,
  afterMap: Map<number, RowCells>,
): { pairs: Array<[number, number]>; extraBefore: number[]; extraAfter: number[]; approximate: boolean } {
  if (bMid.length === 0 || aMid.length === 0) {
    return { pairs: [], extraBefore: bMid, extraAfter: aMid, approximate: false };
  }
  const minLen = Math.min(bMid.length, aMid.length);
  if (bMid.length > SIMILARITY_WINDOW || aMid.length > SIMILARITY_WINDOW) {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < minLen; i++) pairs.push([bMid[i]!, aMid[i]!]);
    return { pairs, extraBefore: bMid.slice(minLen), extraAfter: aMid.slice(minLen), approximate: bMid.length !== aMid.length };
  }

  const candidates: Array<{ b: number; a: number; score: number; sameRow: boolean }> = [];
  for (const b of bMid) {
    for (const a of aMid) {
      candidates.push({ b, a, score: cellSimilarity(sig, beforeMap.get(b)!, afterMap.get(a)!), sameRow: b === a });
    }
  }
  candidates.sort((x, y) => y.score - x.score || Number(y.sameRow) - Number(x.sameRow) || x.b - y.b || x.a - y.a);

  const usedB = new Set<number>();
  const usedA = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const c of candidates) {
    if (pairs.length >= minLen) break;
    if (usedB.has(c.b) || usedA.has(c.a)) continue;
    pairs.push([c.b, c.a]);
    usedB.add(c.b);
    usedA.add(c.a);
  }
  return {
    pairs,
    extraBefore: bMid.filter((b) => !usedB.has(b)),
    extraAfter: aMid.filter((a) => !usedA.has(a)),
    approximate: false,
  };
}

/**
 * Above this edit distance, the Myers alignment in `resolveMid` gives up in favor of the coarser
 * windowed pairing over the whole (trimmed) middle - Myers is O((N+M)*D), and a gap that's
 * genuinely almost entirely rewritten (no anchors, no shared rows at all) would otherwise drive D
 * toward N+M. 2,000 is comfortably past any realistic "scattered edits in a big duplicate block"
 * case while keeping the algorithm's own working memory (`O(D^2)` for the backtrack trace)
 * bounded to a few tens of megabytes worst case. A gap that hits this budget gets its
 * insert/delete structure rows flagged `approximate` (see `diffSheet`) rather than silently
 * handing back a plausible-looking but potentially misaligned diff.
 */
const MYERS_MAX_D = 2000;

type MyersOp = { type: "keep"; bIdx: number; aIdx: number } | { type: "delete"; bIdx: number } | { type: "insert"; aIdx: number };

/**
 * Myers' shortest-edit-script algorithm (the one behind `git diff`/GNU `diff`) over two arrays of
 * opaque signature strings, reconstructed into a full keep/delete/insert script. `bIdx`/`aIdx` in
 * the result index into `xs`/`ys` themselves - the caller translates to actual row numbers.
 * Returns `null` without finishing if the edit distance would exceed `maxD`; the working arrays
 * are sized off `maxD`, not `xs.length + ys.length`, so the budget bounds memory as well as time.
 */
function myersDiff(xs: string[], ys: string[], maxD: number): MyersOp[] | null {
  const n = xs.length;
  const m = ys.length;
  if (n === 0 && m === 0) return [];
  const cap = Math.min(n + m, maxD);
  const off = cap;
  const v = new Int32Array(2 * cap + 1);
  const trace: Int32Array[] = [];

  let foundD = -1;
  for (let d = 0; d <= cap && foundD < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) {
        x = v[off + k + 1]!;
      } else {
        x = v[off + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && xs[x] === ys[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
  }
  if (foundD < 0) return null; // exceeded the budget without reaching the end of both arrays

  const ops: MyersOp[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const vPrev = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vPrev[off + k - 1]! < vPrev[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = vPrev[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "keep", bIdx: x - 1, aIdx: y - 1 });
      x--;
      y--;
    }
    ops.push(x === prevX ? { type: "insert", aIdx: prevY } : { type: "delete", bIdx: prevX });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ type: "keep", bIdx: x - 1, aIdx: y - 1 });
    x--;
    y--;
  }
  return ops.reverse();
}

/**
 * Resolves a gap's trimmed middle: runs `myersDiff` over the two sides' row signatures, then
 * walks the resulting script, turning each `keep` straight into an aligned pair and re-resolving
 * each maximal run of consecutive delete/insert ops (a "hunk") via `pairGapWindowed` - reusing its
 * equal-count positional / unequal-count similarity-ranked logic, but now scoped to a single
 * hunk's rows instead of the whole gap, since Myers has already isolated genuine edits from the
 * untouched rows around them. Falls back to running `pairGapWindowed` over the whole middle,
 * flagged `approximate`, if the edit distance exceeds `MYERS_MAX_D`.
 */
function resolveMid(
  sig: CellSig,
  bMid: number[],
  aMid: number[],
  bMidSig: string[],
  aMidSig: string[],
  beforeMap: Map<number, RowCells>,
  afterMap: Map<number, RowCells>,
): { pairs: Array<[number, number]>; extraBefore: number[]; extraAfter: number[]; approximate: boolean } {
  if (bMid.length === 0 || aMid.length === 0) {
    return { pairs: [], extraBefore: bMid, extraAfter: aMid, approximate: false };
  }

  const script = myersDiff(bMidSig, aMidSig, MYERS_MAX_D);
  if (script === null) {
    return pairGapWindowed(sig, bMid, aMid, beforeMap, afterMap);
  }

  const pairs: Array<[number, number]> = [];
  const extraBefore: number[] = [];
  const extraAfter: number[] = [];
  let approximate = false;
  let hunkDeletes: number[] = []; // bMid indices
  let hunkInserts: number[] = []; // aMid indices

  const flushHunk = () => {
    if (hunkDeletes.length === 0 && hunkInserts.length === 0) return;
    const bRows = hunkDeletes.map((i) => bMid[i]!);
    const aRows = hunkInserts.map((i) => aMid[i]!);
    const resolved = pairGapWindowed(sig, bRows, aRows, beforeMap, afterMap);
    pushAll(pairs, resolved.pairs);
    pushAll(extraBefore, resolved.extraBefore);
    pushAll(extraAfter, resolved.extraAfter);
    approximate = approximate || resolved.approximate;
    hunkDeletes = [];
    hunkInserts = [];
  };

  for (const op of script) {
    if (op.type === "keep") {
      flushHunk();
      pairs.push([bMid[op.bIdx]!, aMid[op.aIdx]!]);
    } else if (op.type === "delete") {
      hunkDeletes.push(op.bIdx);
    } else {
      hunkInserts.push(op.aIdx);
    }
  }
  flushHunk();

  pairs.sort((x, y) => x[0] - y[0]);
  return { pairs, extraBefore, extraAfter, approximate };
}

/**
 * Pairs off the rows in a single gap between anchors. Equal counts pair positionally (the
 * ordinary single-edit or pure-shift case). Unequal counts first trim rows identical by
 * signature off both the start and the end of the gap, pairing each trimmed pair positionally -
 * this is what makes a single insert/delete sitting inside a long run of untouched duplicate rows
 * collapse to a trivial remainder before the more expensive `resolveMid` step ever runs.
 */
function pairGap(
  sig: CellSig,
  bGap: number[],
  aGap: number[],
  beforeMap: Map<number, RowCells>,
  afterMap: Map<number, RowCells>,
): { pairs: Array<[number, number]>; extraBefore: number[]; extraAfter: number[]; approximate: boolean } {
  if (bGap.length === aGap.length) {
    return { pairs: bGap.map((b, i) => [b, aGap[i]!] as [number, number]), extraBefore: [], extraAfter: [], approximate: false };
  }

  const bSig = bGap.map((b) => rowSignature(sig, beforeMap.get(b)!));
  const aSig = aGap.map((a) => rowSignature(sig, afterMap.get(a)!));

  const pairs: Array<[number, number]> = [];
  let bStart = 0;
  let aStart = 0;
  let bEnd = bGap.length;
  let aEnd = aGap.length;
  while (bStart < bEnd && aStart < aEnd && bSig[bStart] === aSig[aStart]) {
    pairs.push([bGap[bStart]!, aGap[aStart]!]);
    bStart++;
    aStart++;
  }
  while (bEnd > bStart && aEnd > aStart && bSig[bEnd - 1] === aSig[aEnd - 1]) {
    bEnd--;
    aEnd--;
    pairs.push([bGap[bEnd]!, aGap[aEnd]!]);
  }

  const bMid = bGap.slice(bStart, bEnd);
  const aMid = aGap.slice(aStart, aEnd);
  const bMidSig = bSig.slice(bStart, bEnd);
  const aMidSig = aSig.slice(aStart, aEnd);
  const { pairs: midPairs, extraBefore, extraAfter, approximate } = resolveMid(sig, bMid, aMid, bMidSig, aMidSig, beforeMap, afterMap);
  pushAll(pairs, midPairs);
  pairs.sort((x, y) => x[0] - y[0]);
  return { pairs, extraBefore, extraAfter, approximate };
}

function alignRows(
  sig: CellSig,
  beforeMap: Map<number, RowCells>,
  afterMap: Map<number, RowCells>,
): { aligned: AlignedPair[]; deleted: DeletedRow[]; inserted: InsertedRow[] } {
  const beforeRows = [...beforeMap.keys()].sort((a, b) => a - b);
  const afterRows = [...afterMap.keys()].sort((a, b) => a - b);
  const beforeSig = beforeRows.map((r) => rowSignature(sig, beforeMap.get(r)!));
  const afterSig = afterRows.map((r) => rowSignature(sig, afterMap.get(r)!));
  const beforeSigCount = countOccurrences(beforeSig);
  const afterSigCount = countOccurrences(afterSig);

  // Anchor-eligible: non-blank row whose signature occurs exactly once on each side.
  const beforeAnchorIdx: number[] = [];
  beforeRows.forEach((r, i) => {
    const sig = beforeSig[i]!;
    if (!isBlankRow(beforeMap.get(r)!) && beforeSigCount.get(sig) === 1 && (afterSigCount.get(sig) ?? 0) === 1) {
      beforeAnchorIdx.push(i);
    }
  });
  const afterAnchorIdx: number[] = [];
  afterRows.forEach((r, j) => {
    const sig = afterSig[j]!;
    if (!isBlankRow(afterMap.get(r)!) && afterSigCount.get(sig) === 1 && (beforeSigCount.get(sig) ?? 0) === 1) {
      afterAnchorIdx.push(j);
    }
  });

  const anchorMatches = lcsMatch(
    beforeAnchorIdx.map((i) => beforeSig[i]!),
    afterAnchorIdx.map((j) => afterSig[j]!),
  );
  // Row-index (into beforeRows/afterRows) pairs, in order.
  const anchors: Array<[number, number]> = anchorMatches.map(([pi, pj]) => [beforeAnchorIdx[pi]!, afterAnchorIdx[pj]!]);

  const aligned: AlignedPair[] = [];
  const deleted: DeletedRow[] = [];
  const inserted: InsertedRow[] = [];

  let bCursor = 0;
  let aCursor = 0;
  const anchorsWithEnd = [...anchors, [beforeRows.length, afterRows.length] as [number, number]];

  for (const [bAnchor, aAnchor] of anchorsWithEnd) {
    const bGap = beforeRows.slice(bCursor, bAnchor);
    const aGap = afterRows.slice(aCursor, aAnchor);
    const { pairs, extraBefore, extraAfter, approximate } = pairGap(sig, bGap, aGap, beforeMap, afterMap);
    for (const [beforeRow, afterRow] of pairs) {
      aligned.push({ before: beforeMap.get(beforeRow)!, after: afterMap.get(afterRow)!, beforeRow, afterRow });
    }
    for (const beforeRow of extraBefore) {
      deleted.push({ before: beforeMap.get(beforeRow)!, beforeRow, approximate });
    }
    for (const afterRow of extraAfter) {
      inserted.push({ after: afterMap.get(afterRow)!, afterRow, approximate });
    }
    if (bAnchor < beforeRows.length && aAnchor < afterRows.length) {
      aligned.push({ before: beforeMap.get(beforeRows[bAnchor]!)!, after: afterMap.get(afterRows[aAnchor]!)!, beforeRow: beforeRows[bAnchor]!, afterRow: afterRows[aAnchor]! });
    }
    bCursor = bAnchor + 1;
    aCursor = aAnchor + 1;
  }

  return { aligned, deleted, inserted };
}

/**
 * Each row's cells re-keyed by their position among the row's non-empty cells (left to right),
 * so a column insert/delete - which moves cells sideways but keeps their order - leaves the row
 * looking the same. Used with the column-free signature for the row pass that column detection
 * is keyed on (see `diffWorkbooks`). Format-only cells (no value, no formula) are left out: an
 * inserted column Excel fills with formatted blanks shouldn't shift every position after it.
 */
function byPosition(rows: Map<number, RowCells>): Map<number, RowCells> {
  const out = new Map<number, RowCells>();
  for (const [row, cells] of rows) {
    const filled: Array<[number, CellSnapshot]> = [];
    for (const [letters, cell] of cells) {
      if (cell.value !== null || cell.formula !== null) filled.push([colToNum(letters), cell]);
    }
    filled.sort((x, y) => x[0] - y[0]);
    out.set(row, new Map(filled.map(([, cell], i) => [String(i), cell])));
  }
  return out;
}

/** `rows` with the cell at position `drop` removed from every row, later positions closing the gap. */
function withoutPosition(rows: Map<number, RowCells>, drop: number): Map<number, RowCells> {
  const out = new Map<number, RowCells>();
  for (const [row, cells] of rows) {
    const kept = [...cells.entries()].filter(([key]) => Number(key) !== drop).map(([, cell], i) => [String(i), cell] as [string, CellSnapshot]);
    out.set(row, new Map(kept));
  }
  return out;
}

/**
 * The positional row alignment `alignColumns` starts from. When a column delete shares the save
 * with a row delete, every row on the before side carries a cell its after row lacks, so no row
 * matches by position and the plain pass pairs next to nothing. If the plain pass leaves under
 * half the rows paired, each before position is tried as the deleted column (rows compared
 * without it) and the alignment pairing the most rows wins - used only if it beats the plain one.
 */
function alignRowsAroundDeletedColumn(colFree: CellSig, before: Map<number, RowCells>, after: Map<number, RowCells>): Alignment {
  const plain = alignRows(colFree, before, after);
  // Pairs whose rows read the same: pairing every row by position is no sign of a good alignment.
  const matched = (alignment: Alignment, beforeRows: Map<number, RowCells>): number =>
    alignment.aligned.filter((p) => rowSignature(colFree, beforeRows.get(p.beforeRow)!) === rowSignature(colFree, after.get(p.afterRow)!)).length;
  const rowCount = Math.min(before.size, after.size);
  const plainMatched = matched(plain, before);
  if (plainMatched * 2 >= rowCount) return plain;
  let width = 0;
  for (const cells of before.values()) width = Math.max(width, cells.size);
  let best = plain;
  let bestMatched = plainMatched;
  for (let drop = 0; drop < width; drop++) {
    const projected = withoutPosition(before, drop);
    const candidate = alignRows(colFree, projected, after);
    const score = matched(candidate, projected);
    if (score > bestMatched) {
      best = candidate;
      bestMatched = score;
    }
  }
  return bestMatched * 2 >= rowCount ? best : plain;
}

/**
 * A sheet's cells regrouped by column number, each column keyed by `rowKey(row)` - the aligned
 * row's identity rather than its number, so a row insert doesn't make every column below it
 * look different.
 */
function columnsOf(rows: Map<number, RowCells>, rowKey: (row: number) => string): Map<number, RowCells> {
  const cols = new Map<number, RowCells>();
  // In row order, so each column's keys arrive already sorted (see `rowKeyOf`) and `rowSignature` needn't sort them.
  for (const row of [...rows.keys()].sort((x, y) => x - y)) {
    const cells = rows.get(row)!;
    const key = rowKey(row);
    for (const [letters, cell] of cells) {
      const col = colToNum(letters);
      let colCells = cols.get(col);
      if (!colCells) {
        colCells = new Map();
        cols.set(col, colCells);
      }
      colCells.set(key, cell);
    }
  }
  return cols;
}

/** An aligned row's key in a column: zero-padded, so string order is row order. */
function rowKeyOf(row: number): string {
  return String(row).padStart(7, "0");
}

/**
 * A detected column shift on one sheet: aligned before-column -> after-column pairs (1-based), in
 * column order, plus the before-columns right of the last pair that have no after counterpart
 * (deleted from the end of the used range).
 */
interface ColumnShift {
  pairs: Array<[number, number]>;
  trailingDeleted: number[];
}

/**
 * Of the cells in columns that moved, the share allowed to disagree with where they moved from,
 * on top of one per moved column. A pure insert/delete disagrees on none; the slack is for
 * genuine edits in the same save, and the per-column allowance keeps a small sheet with one edit
 * from failing on proportion alone. Each moved column must also agree on at least half its own
 * cells.
 */
const COLUMN_DISAGREEMENT = 0.1;

/**
 * Detects a column insert/delete on one sheet by aligning its columns the way `alignRows` aligns
 * rows, over the transposed sheet with each column's cells keyed by `rows` (a before row by its
 * number, an after row by the before row it aligned to; rows only one side has get `+`/`-` keys,
 * which don't count toward a column's identity). `rows` must come from a pass a column shift
 * can't disturb - see `diffWorkbooks`. Column identity uses `colFree` signatures, so a column
 * whose formulas point across the inserted column still matches where it came from.
 *
 * Returns null - "no column shift" - unless the alignment moved at least one column or deleted
 * one from the end, and every column it moved is trustworthy: pairs in strictly increasing
 * order, no approximate gap, and the moved cells agreeing with their source (a formula agrees
 * when its text is the before text with this sheet's rows and the candidate columns remapped) -
 * at least half of each moved column, and all but `COLUMN_DISAGREEMENT` of them together. That check is what
 * stops two unrelated columns paired off by position from reading as a shift.
 */
function alignColumns(
  sheetName: string,
  sig: CellSig,
  colFree: CellSig,
  beforeRows: Map<number, RowCells>,
  afterRows: Map<number, RowCells>,
  rows: Alignment,
): ColumnShift | null {
  const beforeKey = new Map<number, string>();
  const afterKey = new Map<number, string>();
  for (const p of rows.aligned) {
    const key = rowKeyOf(p.beforeRow);
    beforeKey.set(p.beforeRow, key);
    afterKey.set(p.afterRow, key);
  }
  const beforeCols = columnsOf(beforeRows, (row) => beforeKey.get(row) ?? `-${row}`);
  const afterCols = columnsOf(afterRows, (row) => afterKey.get(row) ?? `+${row}`);
  const cols = alignRows(colFree, beforeCols, afterCols);
  if (cols.deleted.some((c) => c.approximate) || cols.inserted.some((c) => c.approximate)) return null;

  const pairs = cols.aligned.map((p) => [p.beforeRow, p.afterRow] as [number, number]).sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i]![1] <= pairs[i - 1]![1]) return null;
  }
  const lastBefore = pairs.length > 0 ? pairs[pairs.length - 1]![0] : 0;
  const trailingDeleted = cols.deleted.map((c) => c.beforeRow).filter((c) => c > lastBefore).sort((x, y) => x - y);
  if (!pairs.some(([b, a]) => b !== a) && trailingDeleted.length === 0) return null;

  const rowMap = rowMappersOf(rows).map[0]!;
  const colMap = lineMapperOf(pairs, new Set()).map[0]!;
  const mapRow = (n: number) => rowMap(n) ?? n;
  const mapCol = (n: number) => colMap(n) ?? n;
  const agrees = (x: CellSnapshot, y: CellSnapshot): boolean => {
    if (x.formula === null || y.formula === null) return x.formula === y.formula && valuesEqual(x.value, y.value);
    if (sig(x) === sig(y)) return true;
    const own = (sheet: string, n: number, map: (n: number) => number) => (sheet === sheetName ? map(n) : n);
    const remapped = remapFormulaRefs(x.formula, sheetName, (sh, r) => own(sh, r, mapRow), (sh, c) => own(sh, c, mapCol));
    return remapped.text === y.formula;
  };
  let movedColumns = 0;
  let movedCells = 0;
  let movedAgreed = 0;
  for (const [b, a] of pairs) {
    if (b === a) continue;
    const x = beforeCols.get(b)!;
    const y = afterCols.get(a)!;
    let cells = 0;
    let agreed = 0;
    for (const [key, cx] of x) {
      if (isUnmatchedKey(key)) continue;
      cells++;
      const cy = y.get(key);
      if (cy && agrees(cx, cy)) agreed++;
    }
    for (const key of y.keys()) if (!isUnmatchedKey(key) && !x.has(key)) cells++;
    if (agreed * 2 < cells) return null;
    movedColumns++;
    movedCells += cells;
    movedAgreed += agreed;
  }
  if (movedCells - movedAgreed > COLUMN_DISAGREEMENT * movedCells + movedColumns) return null;
  return { pairs, trailingDeleted };
}

/**
 * The `structure` rows a column alignment implies: wherever consecutive aligned pairs (starting
 * from a virtual column 0 on both sides) are further apart on one side than the other, the
 * difference is that many columns inserted (after side wider) or deleted (before side wider),
 * named from the left edge of the gap; then each column deleted from the end. Columns added
 * right of the last aligned column are not reported, the same as rows appended below the last
 * aligned row.
 */
function columnStructure(sheet: string, shift: ColumnShift): DiffRow[] {
  const out: DiffRow[] = [];
  const push = (col: number, note: string) => {
    const letter = numToCol(col);
    out.push({ sheet, cell: `${letter}:${letter}`, kind: "structure", note });
  };
  let [pb, pa] = [0, 0];
  for (const [b, a] of shift.pairs) {
    const delta = a - pa - (b - pb);
    for (let i = 1; i <= Math.abs(delta); i++) {
      push(delta > 0 ? pa + i : pb + i, delta > 0 ? "column inserted" : "column deleted");
    }
    [pb, pa] = [b, a];
  }
  for (const col of shift.trailingDeleted) push(col, "column deleted");
  return out;
}

/**
 * `rows` with each cell re-keyed by the before-column it aligns to: `side` "after" maps after
 * columns through the shift, "before" keeps before columns. A column only one side has gets a
 * `+` (inserted) or `-` (deleted) key the other side never has, so a row compares a moved cell
 * with the cell it moved from. Cells keep their own addresses.
 */
function rekeyColumns(rows: Map<number, RowCells>, shift: ColumnShift, side: "before" | "after"): Map<number, RowCells> {
  const own = side === "after" ? 1 : 0;
  const toBefore = new Map(shift.pairs.map((p) => [p[own], numToCol(p[0])]));
  const unmatched = side === "after" ? "+" : "-";
  const out = new Map<number, RowCells>();
  for (const [row, cells] of rows) {
    const rekeyed: RowCells = new Map();
    for (const [letters, cell] of cells) {
      const col = colToNum(letters);
      rekeyed.set(toBefore.get(col) ?? `${unmatched}${numToCol(col)}`, cell);
    }
    out.set(row, rekeyed);
  }
  return out;
}

/** True when some row has a value or formula in a column only its side has (a `+`/`-` key). */
function unmatchedFilled(rows: Map<number, RowCells>): boolean {
  for (const cells of rows.values()) {
    for (const [key, cell] of cells) {
      if (isUnmatchedKey(key) && (cell.value !== null || cell.formula !== null)) return true;
    }
  }
  return false;
}

/** `alignment` with each row's cells swapped for that row in `before`/`after`, row numbers and flags kept. */
function rekeyAlignment(alignment: Alignment, before: Map<number, RowCells>, after: Map<number, RowCells>): Alignment {
  return {
    aligned: alignment.aligned.map((p) => ({ ...p, before: before.get(p.beforeRow)!, after: after.get(p.afterRow)! })),
    deleted: alignment.deleted.map((r) => ({ ...r, before: before.get(r.beforeRow)! })),
    inserted: alignment.inserted.map((r) => ({ ...r, after: after.get(r.afterRow)! })),
  };
}

function cellLabel(beforeAddr: string | undefined, afterAddr: string | undefined): string {
  if (beforeAddr && afterAddr && beforeAddr !== afterAddr) return `${beforeAddr}->${afterAddr}`;
  return (afterAddr ?? beforeAddr)!;
}

type Alignment = ReturnType<typeof alignRows>;

/**
 * Per-sheet before-row -> after-row mappers derived from the row alignment, keyed by sheet name.
 * Each mapper returns where a before row went under one reading of the save, or null if that
 * reading has it deleted (Excel turns a ref to a deleted row into `#REF!`, so whatever the after
 * text says instead is an edit). A formula counts as a pure shift if one reading explains every
 * ref in it exactly (see `isPureShift`). A row with no aligned pair of its own (a blank row, or one
 * whose content changed) sits in the gap between two aligned pairs, and the two sides of that gap
 * decide where it went:
 * - after side empty: every before row in the gap was deleted, whether or not it had cells;
 * - both sides the same size: nothing shifted inside the gap (a row cleared or rewritten in
 *   place is not a delete), so the row keeps the gap's offset;
 * - otherwise it's ambiguous, and a row with cells the alignment couldn't pair is deleted in
 *   both readings. Where rows were inserted, one reading borrows the offset of the aligned row
 *   above and the other of the aligned row below. Where rows were deleted, the readings take the
 *   fewest and the most deletions the gap can hold above the row (a row with only one line above
 *   it in the gap can't have lost two above it); a row no count fits was itself deleted.
 * Past the last aligned row nothing below says a line moved further, so only the offset above
 * applies; a row with cells there that lost its pair was deleted in one reading (rows past it
 * move up one per such row) and cleared in the other (nothing past it moves). Column mappers
 * (`ColMappers`) are the same shape, built from a detected column shift.
 */
type LineMapper = { map: Array<(n: number) => number | null> };
type RowMappers = Map<string, LineMapper>;
type ColMappers = RowMappers;

function rowMappersOf(alignment: Alignment): LineMapper {
  return lineMapperOf(
    alignment.aligned.map((p) => [p.beforeRow, p.afterRow] as [number, number]),
    new Set(alignment.deleted.map((r) => r.beforeRow)),
  );
}

/** Column mappers for a detected shift; a before column with cells and no aligned pair is the column analogue of a deleted row. */
function colMappersOf(shift: ColumnShift, beforeRows: Map<number, RowCells>): LineMapper {
  const paired = new Set(shift.pairs.map((p) => p[0]));
  const unpaired = new Set<number>();
  for (const cells of beforeRows.values()) {
    for (const letters of cells.keys()) {
      const col = colToNum(letters);
      if (!paired.has(col)) unpaired.add(col);
    }
  }
  return lineMapperOf(shift.pairs, unpaired);
}

/** See `RowMappers`: `aligned` is the before -> after line pairs, `unpaired` the before lines with cells and no pair. */
function lineMapperOf(aligned: Array<[number, number]>, unpaired: Set<number>): LineMapper {
  // A virtual pair at line 0 bounds the gap above the first aligned line.
  const pairs: Array<[number, number]> = [[0, 0], ...[...aligned].sort((x, y) => x[0] - y[0])];
  const last = pairs.length - 1;
  const trailing = [...unpaired].filter((n) => n > pairs[last]![0]).sort((x, y) => x - y);
  /** Index of the last pair at or before before-line `n`. */
  const at = (n: number): number => {
    let [lo, hi] = [0, last];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pairs[mid]![0] <= n) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const offset = (i: number) => pairs[i]![1] - pairs[i]![0];
  const map = (reading: 0 | 1) => (n: number): number | null => {
    const i = at(n);
    if (pairs[i]![0] === n) return pairs[i]![1];
    if (i === last) {
      if (reading === 1) return n + offset(i);
      if (unpaired.has(n)) return null;
      let removed = 0;
      while (removed < trailing.length && trailing[removed]! < n) removed++;
      return n + offset(i) - removed;
    }
    const beforeGap = pairs[i + 1]![0] - pairs[i]![0] - 1;
    const afterGap = pairs[i + 1]![1] - pairs[i]![1] - 1;
    if (afterGap === 0) return null;
    if (afterGap === beforeGap) return n + offset(i);
    if (unpaired.has(n)) return null;
    if (afterGap > beforeGap) return n + offset(reading === 0 ? i : i + 1);
    // `beforeGap - afterGap` lines of the gap were deleted, the unpaired ones among them. Those
    // above `n` set its offset, and each side can only lose the lines it has.
    const deletedLines = beforeGap - afterGap;
    const [aboveLines, belowLines] = [n - pairs[i]![0] - 1, pairs[i + 1]![0] - n - 1];
    let [aboveUnpaired, belowUnpaired] = [0, 0];
    for (const u of unpaired) {
      if (u > pairs[i]![0] && u < n) aboveUnpaired++;
      else if (u > n && u < pairs[i + 1]![0]) belowUnpaired++;
    }
    const fewest = Math.max(aboveUnpaired, deletedLines - belowLines);
    const most = Math.min(aboveLines, deletedLines - belowUnpaired);
    if (fewest > most) return null;
    return n + offset(i) - (reading === 0 ? fewest : most);
  };
  return { map: [map(0), map(1)] };
}

/**
 * True when `formulaAfter` is exactly `formulaBefore` with every reference (in any sheet) moved
 * by the row and column inserts/deletes the alignment detected, and no range changed size.
 * Anything the rewrite can't explain byte-for-byte (a grown range, a real edit, a ref into a
 * deleted row or column) is not a pure shift, so the row stays a `formula` row.
 */
function isPureShift(sheet: string, formulaBefore: string, formulaAfter: string, mappers: RowMappers, colMappers: ColMappers): boolean {
  return shiftRewrites(sheet, formulaBefore, mappers, colMappers, formulaAfter).texts.includes(formulaAfter);
}

/**
 * The texts `formulaBefore` becomes under the detected row/column shifts, one per reading (see
 * `RowMappers`) that keeps every range's size and every ref's line, deduplicated. A reading that
 * puts a ref in a deleted row or column gives no text (Excel writes `#REF!` there, which no
 * rewrite reproduces) and sets `intoDeleted`. Stops at `stopAt` once a reading produces it:
 * `isPureShift` runs on every formula of a shifted sheet and the first reading usually matches.
 */
function shiftRewrites(sheet: string, formulaBefore: string, mappers: RowMappers, colMappers: ColMappers, stopAt?: string): { texts: string[]; intoDeleted: boolean } {
  const texts: string[] = [];
  let anyDeleted = false;
  for (const pickRow of [0, 1]) {
    for (const pickCol of [0, 1]) {
      let intoDeleted = false;
      const through = (mapper: LineMapper | undefined, pick: number, n: number): number => {
        const moved = mapper === undefined ? n : mapper.map[pick]!(n);
        if (moved === null) intoDeleted = true;
        return moved ?? n;
      };
      const { text, spanPreserved } = remapFormulaRefs(
        formulaBefore,
        sheet,
        (target, row) => through(mappers.get(target), pickRow, row),
        (target, col) => through(colMappers.get(target), pickCol, col),
      );
      if (intoDeleted) {
        anyDeleted = true;
        continue;
      }
      if (spanPreserved && !texts.includes(text)) texts.push(text);
      if (text === stopAt && spanPreserved) return { texts, intoDeleted: anyDeleted };
    }
  }
  return { texts, intoDeleted: anyDeleted };
}

/**
 * What an edited formula would read had it only moved with the shift, when that differs from its
 * before text and the shift gives one unambiguous rewrite; undefined otherwise, including when
 * any reading has a ref's line deleted.
 */
function expectedAfterShift(sheet: string, formulaBefore: string, mappers: ShiftMappers): string | undefined {
  const { texts, intoDeleted } = shiftRewrites(sheet, formulaBefore, mappers.rows, mappers.cols);
  return !intoDeleted && texts.length === 1 && texts[0] !== formulaBefore ? texts[0] : undefined;
}

function diffAlignedCell(
  sheet: string,
  sig: CellSig,
  cb: CellSnapshot | undefined,
  ca: CellSnapshot | undefined,
  out: DiffRow[],
  mappers?: ShiftMappers,
): void {
  if (!cb && !ca) return;
  if (probe !== null) probe.cellsCompared++;
  if (!cb || !ca) {
    const only = (ca ?? cb)!;
    const kind: DiffKind = only.formula !== null ? "formula" : "value";
    out.push({
      sheet,
      cell: cellLabel(cb?.address, ca?.address),
      kind,
      valueBefore: cb?.value ?? null,
      valueAfter: ca?.value ?? null,
      formulaBefore: cb?.formula ?? null,
      formulaAfter: ca?.formula ?? null,
      // Only the side that actually has a cell has a number format to report - omit the key
      // entirely on the other side rather than setting it to `undefined` (which would still
      // show up as an own property under deep-equality checks against golden JSON).
      ...(cb ? { numFmtBefore: cb.numFmt } : {}),
      ...(ca ? { numFmtAfter: ca.numFmt } : {}),
    });
    return;
  }

  // Once a shift moved rows or columns, relative equality stops meaning "unchanged": a moved cell
  // keeps its relative form when a ref was re-pointed along with it, and a cell that stayed put
  // keeps its text when a ref Excel would have moved was put back. So every formula is then held
  // to the exact rewrite the shift implies.
  let formulaChanged: boolean;
  if (mappers?.shifted && cb.formula !== null && ca.formula !== null) {
    formulaChanged = !isPureShift(sheet, cb.formula, ca.formula, mappers.rows, mappers.cols);
  } else {
    const relBefore = cb.formula !== null ? sig(cb) : null;
    const relAfter = ca.formula !== null ? sig(ca) : null;
    formulaChanged = relBefore !== relAfter && !(cb.formula !== null && ca.formula !== null && mappers !== undefined && isPureShift(sheet, cb.formula, ca.formula, mappers.rows, mappers.cols));
  }
  const fmtChanged = cb.numFmt !== ca.numFmt;
  // A formula cell whose formula and format are unchanged and whose stored result is missing on one side: the writer (openpyxl, a
  // script) dropped or never wrote the cached result. No value was typed or cleared, so this is a file-internals change, not a card.
  const resultNotStored = !formulaChanged && !fmtChanged && cb.formula !== null && ca.formula !== null && (cb.value === null) !== (ca.value === null);
  if (resultNotStored && valuesEqual(cb.value, ca.value) === false) unstoredResults += 1;
  const valueChanged = !resultNotStored && !valuesEqual(cb.value, ca.value);
  if (!formulaChanged && !valueChanged && !fmtChanged) return;
  const expected = formulaChanged && mappers?.shifted && cb.formula !== null ? expectedAfterShift(sheet, cb.formula, mappers) : undefined;

  out.push({
    sheet,
    cell: cellLabel(cb.address, ca.address),
    kind: formulaChanged ? "formula" : "value",
    valueBefore: cb.value,
    valueAfter: ca.value,
    formulaBefore: cb.formula,
    formulaAfter: ca.formula,
    numFmtBefore: cb.numFmt,
    numFmtAfter: ca.numFmt,
    ...(expected !== undefined && expected !== ca.formula ? { expectedFormulaAfterShift: expected } : {}),
  });
}

/** Every sheet's row and column mappers, and whether any sheet's rows or columns moved at all. */
type ShiftMappers = { rows: RowMappers; cols: ColMappers; shifted: boolean };

function diffSheet(name: string, sig: CellSig, alignment: Alignment, columns: ColumnShift | null, mappers: ShiftMappers): DiffRow[] {
  // Collect with a sort key (the row number a reviewer would read this change at) since rows
  // are produced grouped by alignment bucket (deleted/inserted/aligned), not reading order.
  // Column structure rows span every row, so they sort first.
  const out: Array<{ sortRow: number; row: DiffRow }> = [];
  for (const row of columns === null ? [] : columnStructure(name, columns)) out.push({ sortRow: 0, row });
  const { aligned, deleted, inserted } = alignment;
  // Rows below everything that aligned are plain new cells, not an insertion: nothing moved
  // to make room for them, so a `structure` row (and its "row inserted" claim) would be noise.
  const lastAlignedAfterRow = aligned.reduce((max, p) => Math.max(max, p.afterRow), 0);

  for (const row of deleted) {
    const note = row.approximate ? "row deleted (approximate alignment - edit distance exceeded the alignment budget)" : "row deleted";
    out.push({ sortRow: row.beforeRow, row: { sheet: name, cell: `${row.beforeRow}:${row.beforeRow}`, kind: "structure", note } });
    const cols = [...row.before.keys()].sort();
    for (const col of cols) {
      const buf: DiffRow[] = [];
      diffAlignedCell(name, sig, row.before.get(col), undefined, buf);
      buf.forEach((r) => out.push({ sortRow: row.beforeRow, row: r }));
    }
  }

  for (const row of inserted) {
    // An approximate alignment can't vouch that the row is really new, so it keeps its structure row.
    const appended = !row.approximate && aligned.length > 0 && row.afterRow > lastAlignedAfterRow;
    if (!appended) {
      const note = row.approximate ? "row inserted (approximate alignment - edit distance exceeded the alignment budget)" : "row inserted";
      out.push({ sortRow: row.afterRow, row: { sheet: name, cell: `${row.afterRow}:${row.afterRow}`, kind: "structure", note } });
    }
    const cols = [...row.after.keys()].sort();
    for (const col of cols) {
      const buf: DiffRow[] = [];
      diffAlignedCell(name, sig, undefined, row.after.get(col), buf);
      buf.forEach((r) => out.push({ sortRow: row.afterRow, row: r }));
    }
  }

  for (const pair of aligned) {
    const cols = new Set([...pair.before.keys(), ...pair.after.keys()]);
    for (const col of [...cols].sort()) {
      const buf: DiffRow[] = [];
      diffAlignedCell(name, sig, pair.before.get(col), pair.after.get(col), buf, mappers);
      buf.forEach((r) => out.push({ sortRow: pair.afterRow, row: r }));
    }
  }

  out.sort((a, b) => a.sortRow - b.sortRow || a.row.cell.localeCompare(b.row.cell));
  return out.map((entry) => entry.row);
}

/**
 * True when every row number both sides have uses the same columns on both. Nothing can have
 * shifted sideways then, so column detection - and the extra row pass it needs - is skipped: an
 * edit or a row insert/delete alone never pays for it. (An insert and a delete of columns that
 * exactly cancel out in every row would slip through; the moved cells then show as edits.)
 */
function sameColumnsPerRow(before: Map<number, RowCells>, after: Map<number, RowCells>): boolean {
  for (const [row, b] of before) {
    const a = after.get(row);
    if (a === undefined) continue;
    if (a.size !== b.size) return false;
    for (const col of b.keys()) if (!a.has(col)) return false;
  }
  return true;
}

/** Counter read by `countUnstoredResults`: cells `diffAlignedCell` kept quiet because only one side stores the formula's result. */
let unstoredResults = 0;

/** How many formula cells (formula and number format unchanged) have a cached result on one side only: the fifth noise class. */
export function countUnstoredResults(before: WorkbookSnapshot, after: WorkbookSnapshot): number {
  unstoredResults = 0;
  diffWorkbooks(before, after);
  return unstoredResults;
}

export function diffWorkbooks(before: WorkbookSnapshot, after: WorkbookSnapshot): DiffRow[] {
  const rows: DiffRow[] = [];
  const beforeByName = new Map(before.sheets.map((s) => [s.name, s]));
  const afterByName = new Map(after.sheets.map((s) => [s.name, s]));
  // A sheet only one side has is diffed against an empty one, so each of its cells is a row: a sheet created or
  // deleted mid-task must not hide its content. A removed sheet's rows show the after side empty.
  // Its rows were not inserted into or deleted from anything, so it gets cell rows only, no `structure` rows.
  const lopsided = new Set<string>();
  for (const [name] of afterByName) {
    if (!beforeByName.has(name)) {
      beforeByName.set(name, { name, cells: new Map() });
      lopsided.add(name);
    }
  }
  for (const [name] of [...beforeByName]) {
    if (!afterByName.has(name)) {
      afterByName.set(name, { name, cells: new Map() });
      lopsided.add(name);
    }
  }
  // Sheets present in both are diffed.
  // Every sheet is aligned before any is diffed: a formula's references can point into another
  // sheet, and whether its text changed only because that sheet's rows shifted needs that sheet's alignment.
  const alignments = new Map<string, { sig: CellSig; rows: Alignment; columns: ColumnShift | null }>();
  const mappers: ShiftMappers = { rows: new Map(), cols: new Map(), shifted: false };
  for (const [name, beforeSheet] of beforeByName) {
    const afterSheet = afterByName.get(name);
    if (!afterSheet) continue;
    const beforeRows = rowsOf(beforeSheet);
    const afterRows = rowsOf(afterSheet);
    const sig = memoSig((cell) => toRelativeSignature(cell.formula!, cell.address, name));
    const colFree = columnFreeOf(sig);
    let alignment: Alignment;
    let columns: ColumnShift | null = null;
    if (sameColumnsPerRow(beforeRows, afterRows)) {
      alignment = alignRows(sig, beforeRows, afterRows);
    } else {
      // Rows and columns can both shift in one save, and each pass keyed on the other's
      // coordinates would see every cell move. So rows are first aligned on what a column shift
      // can't change (cells by position, formulas without column parts), and columns are aligned
      // over that. A detected shift then has the rows compared keyed by before-column, so the
      // shift itself stops looking like edits.
      const byPos = alignRowsAroundDeletedColumn(colFree, byPosition(beforeRows), byPosition(afterRows));
      columns = alignColumns(name, sig, colFree, beforeRows, afterRows, byPos);
      if (columns !== null) {
        const before = rekeyColumns(beforeRows, columns, "before");
        const after = rekeyColumns(afterRows, columns, "after");
        // The positional pass counted the cells of inserted/deleted columns in every row's
        // position; if any of those has content, the rows are aligned again without them.
        alignment = unmatchedFilled(before) || unmatchedFilled(after) ? alignRows(colFree, before, after) : rekeyAlignment(byPos, before, after);
        mappers.cols.set(name, colMappersOf(columns, beforeRows));
        mappers.shifted = true;
      } else {
        alignment = alignRows(sig, beforeRows, afterRows);
      }
    }
    alignments.set(name, { sig, rows: alignment, columns });
    mappers.rows.set(name, rowMappersOf(alignment));
    if (alignment.aligned.some((p) => p.beforeRow !== p.afterRow)) mappers.shifted = true;
  }
  for (const [name, { sig, rows: alignment, columns }] of alignments) {
    const sheetRows = diffSheet(name, sig, alignment, columns, mappers);
    pushAll(rows, lopsided.has(name) ? sheetRows.filter((r) => r.kind !== "structure") : sheetRows);
  }
  return rows;
}
