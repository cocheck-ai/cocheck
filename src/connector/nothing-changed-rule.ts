// P3, the nothing-changed rule, over a frozen cocheck.changes/1 document. One predicate for the lane rule; the page's own
// copy of the same test is `coverageLine` in src/timeline/rail/assets/view-table.js (NOTHING_CHANGED), which draws the card's line.
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const empty = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.length === 0);

/**
 * Whether the frozen document vouches that nothing changed: its connector's hello opted into the rule (recorded at capture on the
 * envelope, `source.nothingChanged`), and the document lists no change and no picture, with no status, no "ask again", no pending or
 * failed mark, no caveat, no issue and no `more`. Anything less is no claim: a failed, refused, timed-out, partial or pending answer never vouches.
 * The level is not read: a captured empty list is always drawn at level 1 (`drawnLevel` caps the hello's level by what the document holds),
 * so a level test would refuse every real one.
 */
export function vouchesNothingChanged(doc: unknown): boolean {
  if (!isObj(doc) || !isObj(doc.source) || doc.source.nothingChanged !== true) return false;
  if (!Array.isArray(doc.changes) || doc.changes.length !== 0 || !empty(doc.pictures) || !empty(doc.caveats)) return false;
  // An issue the connector found in a state (spec v1.2 `issues`) is a warning: muting the step would hide it (the costly side).
  if (!empty(doc.issues)) return false;
  if (doc.status !== undefined || doc.pendingRetry !== undefined || doc.pending === true || doc.failed === true) return false;
  return !(typeof doc.more === "number" && doc.more > 0);
}
