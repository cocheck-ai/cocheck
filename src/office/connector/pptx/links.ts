import { place } from "./diff.ts";
import { readDeck } from "./reader.ts";
import { readShapeTag } from "./tags.ts";

/**
 * A deck's COCHECK.LINKS shape tags (spec 6.6), read only: one JSON map per shape from number location to
 * `{link_id, source, anchors, format, last_value}`. Nothing in CoCheck writes these tags; decks tagged by older versions still read, so the page keeps its "link broken" row for them.
 */

export const TAG_LINKS = "COCHECK.LINKS";

export interface LinkSource {
  workbook: string;
  sheet: string;
  cell: string;
}

export interface LinkEntry {
  link_id: string;
  source: LinkSource;
  /** `column_header` is a number when the header above the cell is a year and no text header sits above it. */
  anchors: { row_label: string | null; column_header: string | number | null };
  format: string;
  last_value: number;
  /** True when the caller gave `format` explicitly; the scale guard then never refuses an update of this link. */
  explicit_format?: true;
  /** Set when the source can no longer be found; the value is then never rewritten. */
  broken?: string;
}

function readMap(raw: string | undefined): Record<string, LinkEntry> {
  if (raw === undefined) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, LinkEntry>;
  } catch {
    // falls through
  }
  throw new Error(`the shape's ${TAG_LINKS} tag is not a JSON map`);
}

/** One COCHECK.LINKS entry of a deck, with the shape that carries it. */
export interface FoundLink {
  slide: number;
  shapeId: string;
  location: string;
  entry: LinkEntry;
}

/** Every link entry of every shape of the deck, in slide and shape order. A shape whose tag is not a JSON map is skipped. */
export function collectLinks(bytes: Uint8Array): FoundLink[] {
  const out: FoundLink[] = [];
  const deck = readDeck(bytes);
  for (const [i, slide] of deck.slides.entries()) {
    const seen = new Set<string>();
    for (const p of place(slide.shapes)) {
      if (seen.has(p.shape.id)) continue;
      seen.add(p.shape.id);
      let raw: string | undefined;
      try {
        raw = readShapeTag(bytes, i + 1, p.shape.id, TAG_LINKS);
      } catch {
        continue;
      }
      let map: Record<string, LinkEntry>;
      try {
        map = readMap(raw);
      } catch {
        continue;
      }
      for (const [location, entry] of Object.entries(map)) out.push({ slide: i + 1, shapeId: p.shape.id, location, entry });
    }
  }
  return out;
}

/** Links marked broken, by number location. */
export function brokenLinks(bytes: Uint8Array): Map<string, { reason: string; linkId: string }> {
  const out = new Map<string, { reason: string; linkId: string }>();
  for (const l of collectLinks(bytes)) if (typeof l.entry?.broken === "string") out.set(l.location, { reason: l.entry.broken, linkId: l.entry.link_id });
  return out;
}
