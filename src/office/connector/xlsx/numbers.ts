/**
 * Number comparison and display for spreadsheet values. Spreadsheet apps keep 15 significant digits; anything
 * past that in a recalculated value is floating-point noise (0.1+0.2 reads 0.30000000000000004), not
 * a change anyone made.
 *
 * Rule: two numbers are the same when they are equal to 15 significant digits, or when one is
 * exactly 0 and the other is smaller than 1e-12 in magnitude (a check cell that should read 0 and
 * reads 1.3e-13). The floor applies only against 0, where a relative comparison can never hold, so
 * it cannot hide a relative change between two nonzero numbers: 1 -> 1 + 1e-9 and 0 -> 1e-6 both
 * stay different.
 */
const ZERO_FLOOR = 1e-12;

/** `n` rounded to 15 significant digits. */
export function round15(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(15)) : n;
}

export function numbersEqual(a: number, b: number): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === 0) return Math.abs(b) < ZERO_FLOOR;
  if (b === 0) return Math.abs(a) < ZERO_FLOOR;
  return round15(a) === round15(b);
}

/** A canonical form for equality-style keys: `round15`, with anything under the zero floor as 0. */
export function canonical15(n: number): number {
  return Math.abs(n) < ZERO_FLOOR ? 0 : round15(n);
}
