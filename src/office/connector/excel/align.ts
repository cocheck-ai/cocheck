// Sequence alignment for rows (and columns) of one sheet, before against after. Pure.
//
//   1. trim the common prefix and suffix;
//   2. anchor on keys unique on both sides (patience), keeping the longest increasing run of them;
//   3. inside each gap between anchors, recurse on keys unique within the gap, then a plain LCS on equal keys when the gap is small;
//   4. similarity pass: inside each gap still unmatched, a gap with as many items on both sides is an edit in place (paired by position);
//      otherwise pair before and after items whose content is at least half the same (a modified row), by a small dynamic programme over
//      similarity when the gap is small, else by position; only the rest are inserted or deleted;
//   5. reorder: when most keys exist on both sides but few stay in order (a sort), items are matched by key instead, and the caller says
//      "N rows reordered".
// The output maps every before index to an after index or null, and the ops list in order.

export type Op = { a: number | null; b: number | null };

export interface Alignment {
  /** before index -> after index, or null (deleted). */
  aToB: (number | null)[];
  /** after index -> before index, or null (inserted). */
  bToA: (number | null)[];
  /** The merged sequence, in order: matched pairs, deletions (b null) and insertions (a null). */
  ops: Op[];
  /** True when the items were matched by key because their order changed (a sort or reorder). */
  reordered: boolean;
  /** How many matched pairs moved relative to each other (only when reordered). */
  moved: number;
}

const DP_LIMIT = 4_000_000;

/** Longest increasing subsequence of `xs` (indices into xs). */
function lis(xs: number[]): number[] {
  const tails: number[] = [], prev: number[] = new Array(xs.length).fill(-1);
  for (let i = 0; i < xs.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[tails[m]!]! < xs[i]!) lo = m + 1; else hi = m; }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) out.push(k);
  return out.reverse();
}

/** Matches equal keys between a[a0,a1) and b[b0,b1), writing into aToB/bToA. */
function matchKeys(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, aToB: (number | null)[], bToA: (number | null)[]): void {
  // common prefix / suffix
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { aToB[a0] = b0; bToA[b0] = a0; a0++; b0++; }
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; aToB[a1] = b1; bToA[b1] = a1; }
  if (a0 >= a1 || b0 >= b1) return;
  // unique anchors within this range
  const ca = new Map<string, number>(), cb = new Map<string, number>(), pa = new Map<string, number>(), pb = new Map<string, number>();
  for (let i = a0; i < a1; i++) { ca.set(a[i]!, (ca.get(a[i]!) ?? 0) + 1); pa.set(a[i]!, i); }
  for (let j = b0; j < b1; j++) { cb.set(b[j]!, (cb.get(b[j]!) ?? 0) + 1); pb.set(b[j]!, j); }
  const cand: { i: number; j: number }[] = [];
  for (let i = a0; i < a1; i++) { const k = a[i]!; if (ca.get(k) === 1 && cb.get(k) === 1) cand.push({ i, j: pb.get(k)! }); }
  if (cand.length > 0) {
    const keep = lis(cand.map((c) => c.j)).map((x) => cand[x]!);
    let pi = a0, pj = b0;
    for (const { i, j } of keep) {
      matchKeys(a, b, pi, i, pj, j, aToB, bToA);
      aToB[i] = j; bToA[j] = i;
      pi = i + 1; pj = j + 1;
    }
    matchKeys(a, b, pi, a1, pj, b1, aToB, bToA);
    return;
  }
  // no unique anchors: plain LCS on equal keys when small enough
  const n = a1 - a0, m = b1 - b0;
  if (n * m > DP_LIMIT) return;
  const w = m + 1, dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[a0 + i] === b[b0 + j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) { aToB[a0 + i] = b0 + j; bToA[b0 + j] = a0 + i; i++; j++; }
    else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
}

/** Pairs unmatched items inside each gap by similarity (>= 0.5), keeping order. */
function pairSimilar(aToB: (number | null)[], bToA: (number | null)[], sim: (i: number, j: number) => number): void {
  const na = aToB.length, nb = bToA.length;
  let i = 0, j = 0;
  while (i <= na && j <= nb) {
    // find the next gap: unmatched run on a starting at i, on b starting at j, up to the next matched pair
    let i1 = i; while (i1 < na && aToB[i1] === null) i1++;
    let j1 = j; while (j1 < nb && bToA[j1] === null) j1++;
    if (i1 > i && j1 > j) gap(i, i1, j, j1);
    if (i1 >= na || j1 >= nb) break;
    // aToB[i1] should be j1 (matched pairs are in order); step past it
    i = i1 + 1; j = (aToB[i1] ?? j1) + 1;
  }
  function gap(a0: number, a1: number, b0: number, b1: number): void {
    const n = a1 - a0, m = b1 - b0;
    // as many before as after items between the same neighbours: an edit in place, paired by position whatever changed in them
    if (n === m) { for (let k = 0; k < n; k++) { aToB[a0 + k] = b0 + k; bToA[b0 + k] = a0 + k; } return; }
    if (n * m <= DP_LIMIT / 4) {
      const w = m + 1, dp = new Float64Array((n + 1) * w), s = new Float64Array(n * m);
      for (let x = 0; x < n; x++) for (let y = 0; y < m; y++) { const v = sim(a0 + x, b0 + y); s[x * m + y] = v >= 0.5 ? v : 0; }
      for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) {
        const take = s[x * m + y]! > 0 ? dp[(x + 1) * w + y + 1]! + s[x * m + y]! : -1;
        dp[x * w + y] = Math.max(take, dp[(x + 1) * w + y]!, dp[x * w + y + 1]!);
      }
      let x = 0, y = 0;
      while (x < n && y < m) {
        const v = s[x * m + y]!;
        if (v > 0 && dp[x * w + y] === dp[(x + 1) * w + y + 1]! + v) { aToB[a0 + x] = b0 + y; bToA[b0 + y] = a0 + x; x++; y++; }
        else if (dp[(x + 1) * w + y]! >= dp[x * w + y + 1]!) x++;
        else y++;
      }
      return;
    }
    // large gap: by position from the top, while similar
    for (let k = 0; k < Math.min(n, m); k++) {
      if (sim(a0 + k, b0 + k) < 0.5) break;
      aToB[a0 + k] = b0 + k; bToA[b0 + k] = a0 + k;
    }
  }
}

function opsOf(aToB: (number | null)[], bToA: (number | null)[]): Op[] {
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < aToB.length || j < bToA.length) {
    if (i < aToB.length && aToB[i] === null) { ops.push({ a: i, b: null }); i++; continue; }
    if (j < bToA.length && bToA[j] === null) { ops.push({ a: null, b: j }); j++; continue; }
    if (i < aToB.length && j < bToA.length) { ops.push({ a: i, b: j }); i++; j++; continue; }
    if (i < aToB.length) { ops.push({ a: i, b: null }); i++; } else { ops.push({ a: null, b: j }); j++; }
  }
  return ops;
}

/**
 * Aligns `a` against `b`. `keyA`/`keyB` are the anchor keys (equal key = same item); `sim(i, j)` is the share of content the two items
 * have in common (0..1), used only for items the keys could not match.
 */
export function align(keyA: string[], keyB: string[], sim: (i: number, j: number) => number): Alignment {
  const na = keyA.length, nb = keyB.length;
  let aToB: (number | null)[] = new Array(na).fill(null), bToA: (number | null)[] = new Array(nb).fill(null);
  matchKeys(keyA, keyB, 0, na, 0, nb, aToB, bToA);
  let reordered = false, moved = 0;
  // reorder test: how many keys the two sides share (as multisets) against how many stayed in order
  const matched = aToB.filter((x) => x !== null).length;
  const count = new Map<string, number>();
  for (const k of keyA) count.set(k, (count.get(k) ?? 0) + 1);
  let shared = 0;
  for (const k of keyB) { const c = count.get(k) ?? 0; if (c > 0) { shared++; count.set(k, c - 1); } }
  if (shared - matched > Math.max(10, 0.2 * Math.min(na, nb))) {
    reordered = true;
    aToB = new Array(na).fill(null); bToA = new Array(nb).fill(null);
    const pos = new Map<string, number[]>();
    keyB.forEach((k, j) => { const l = pos.get(k); if (l) l.push(j); else pos.set(k, [j]); });
    keyA.forEach((k, i) => { const l = pos.get(k); if (l && l.length) { const j = l.shift()!; aToB[i] = j; bToA[j] = i; } });
    // items that moved: matched pairs outside the longest in-order run
    const pairs = aToB.map((j, i) => ({ i, j })).filter((p) => p.j !== null) as { i: number; j: number }[];
    moved = pairs.length - lis(pairs.map((p) => p.j)).length;
    // unmatched leftovers pair by similarity in order of appearance
    const ua = aToB.map((x, i) => (x === null ? i : -1)).filter((i) => i >= 0), ub = bToA.map((x, j) => (x === null ? j : -1)).filter((j) => j >= 0);
    const used = new Set<number>();
    for (const i of ua) {
      let best = -1, bv = 0.5;
      for (const j of ub) if (!used.has(j)) { const v = sim(i, j); if (v >= bv) { bv = v; best = j; } }
      if (best >= 0) { used.add(best); aToB[i] = best; bToA[best] = i; }
    }
    // the merged order follows the after side; deleted items go where they were
    const ops: Op[] = [];
    const delAt = new Map<number, number[]>();
    for (let i = 0; i < na; i++) if (aToB[i] === null) { let k = i - 1; while (k >= 0 && aToB[k] === null) k--; const at = k < 0 ? -1 : aToB[k]!; const l = delAt.get(at); if (l) l.push(i); else delAt.set(at, [i]); }
    for (const i of delAt.get(-1) ?? []) ops.push({ a: i, b: null });
    for (let j = 0; j < nb; j++) { ops.push({ a: bToA[j]!, b: j }); for (const i of delAt.get(j) ?? []) ops.push({ a: i, b: null }); }
    return { aToB, bToA, ops: ops.map((o) => (o.a === null || o.a === undefined ? { a: null, b: o.b } : o)), reordered, moved };
  }
  pairSimilar(aToB, bToA, sim);
  return { aToB, bToA, ops: opsOf(aToB, bToA), reordered, moved };
}
