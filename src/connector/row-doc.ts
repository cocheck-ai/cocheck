// The cocheck.changes/1 document the page gets for a connector row (the same shape the Office connector serves), plus `source` saying who drew it.
//   frozen v1 answer  -> the document sealed at capture, as the connector sent it (source by "connector")
//   export connector  -> CoCheck's text renderer over the stored before and after text (source by "cocheck", name the connector id)
//   unavailable       -> an empty level-1 list whose caveat says why
import type { V1Doc, V1Source } from "../timeline/render/view-v1.ts";
import { checkChanges, CHANGES_SPEC } from "./changes-v1.ts";
import type { DiffChange, DiffObject } from "./diff-object.ts";
import { exportDocOf } from "./export-view.ts";
import { storedLevelOf } from "./doc-level.ts";

export interface RowDocInputs {
  /** The stored states of an export row (null: that side does not exist). */
  before: Buffer | null;
  after: Buffer | null;
  readFrozen: (ref: string) => Promise<unknown>;
}

export async function connectorRowDoc(d: DiffObject, io: RowDocInputs): Promise<V1Doc> {
  const doc = await rowDocOf(d, io);
  // A list read later than its step carries the mark to the page (failed and pending notes say their own words).
  return d.readLater === true && d.unavailable === undefined ? ({ ...doc, readLater: true } as unknown as V1Doc) : doc;
}

async function rowDocOf(d: DiffObject, io: RowDocInputs): Promise<V1Doc> {
  const source = (level: 1 | 2 | 3): V1Source => ({ by: "connector", name: d.connector, level });
  const note = (why: string): V1Doc => ({ spec: CHANGES_SPEC, level: 1, source: source(1), changes: [], pictures: [], caveats: [why] }) as unknown as V1Doc;
  // A row still being read is a level-1 note marked pending, so the page shows "reading the change list" and asks again.
  if (d.unavailable !== undefined && d.pending === true) return { ...note(d.unavailable), pending: true } as unknown as V1Doc;
  // A row the review process could not read is a note marked failed: the page says "No change list: <why>", never "Nothing changed".
  if (d.unavailable !== undefined && d.failed === true) return { ...note(d.unavailable), caveats: [d.unavailable, ...d.caveats], failed: true } as unknown as V1Doc;
  if (d.unavailable !== undefined) return note(d.unavailable);
  try {
    if (d.served?.kind === "export") return exportDocOf(d.connector, d.subject, io.before === null ? null : io.before.toString("utf8"), io.after === null ? null : io.after.toString("utf8"));
    if (d.served?.kind === "export-text") return exportDocOf(d.connector, d.subject, d.served.before, d.served.after);
    if (d.served?.kind === "frozen") {
      const doc = (await io.readFrozen(d.served.ref)) as V1Doc;
      if (checkChanges(doc).length > 0) return note("the change list kept for this step is not a valid change document");
      const lv = storedLevelOf(doc);
      // The nothing-changed opt-in recorded at capture rides on the envelope; a document frozen without it (from before the opt-in existed, or a connector that did not opt in) never gets the line
      const held = (doc as { source?: { nothingChanged?: unknown } }).source?.nothingChanged === true;
      const src = (): V1Source => ({ ...source(lv), ...(held ? { nothingChanged: true as const } : {}) });
      // An "ask again" answer is shown while CoCheck waits: pending (the page keeps asking), with the loader's waiting line first among the caveats.
      if (d.pending === true) return { ...doc, source: src(), pending: true, caveats: d.caveats } as unknown as V1Doc;
      return { ...doc, source: src() };
    }
  } catch {
    return note("the change list kept for this step could not be read");
  }
  return note("no change list was kept for this step");
}

/** The rail reads a row's `DiffObject.changes`: this is what it sees of a cocheck.changes/1 document, one derived change per document change, in words. */
export function docToChanges(doc: { changes?: unknown }): DiffChange[] {
  return (Array.isArray(doc.changes) ? doc.changes : []).map((c: Record<string, unknown>) => ({
    kind: String(c.mark),
    anchors: [{ label: String(c.label) }],
    confidence: "derived" as const,
    ...(typeof c.before === "string" ? { before: { type: "text" as const, value: c.before } } : {}),
    ...(typeof c.after === "string" ? { after: { type: "text" as const, value: c.after } } : {}),
    ...(typeof c.text === "string" ? { note: c.text } : {}),
  }));
}
