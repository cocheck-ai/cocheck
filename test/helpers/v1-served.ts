// What the serve boundary sends the page. The page reads only the v1 document, so every test that boots review.js feeds it this.
import { viewToV1, type CardWords, type V1Doc } from "../../src/timeline/render/view-v1.ts";
import type { RowCard } from "../../src/timeline/notes.ts";
import type { View } from "../../src/timeline/render/types.ts";

/** A test's change: the model's row notes, plus `cards`/`extraCards` that hand a change its old and new words (see withCardWords). */
type TestChange = { cards?: unknown[]; extraCards?: unknown[]; rowNotes?: unknown[] } | null | undefined;

/** The model's change as the page's tests build it, as the words the server uses (its row notes). */
export const wordsOf = (c?: TestChange): CardWords => ({ rowNotes: (c?.rowNotes ?? []) as CardWords["rowNotes"] });

const flat = (t: string | null | undefined): string => (t == null ? "" : t.replace(/\s+/g, " ").trim());

/**
 * The server builds a change's words from row notes and labels only; old and new words reach the page in a document whose producer wrote
 * them (a connector's change list). The page tests hand those words as cards matched to a View change by `loc`, and this writes them onto
 * the served change the way such a document carries them: the place as the label, the verb as the mark, before, after and the sentence.
 */
function withCardWords(doc: V1Doc, view: View, c: TestChange): V1Doc {
  const cards = [...((c?.cards ?? []) as RowCard[]), ...((c?.extraCards ?? []) as RowCard[])];
  if (cards.length === 0) return doc;
  const byId = new Map<string, RowCard>();
  for (const vc of view.changes ?? []) {
    const card = vc.loc === null ? undefined : cards.find((k) => k.loc === vc.loc);
    if (card !== undefined) byId.set(vc.id, card);
  }
  return {
    ...doc,
    changes: doc.changes.map((ch) => {
      const k = byId.get(ch.id);
      if (k === undefined) return ch;
      const before = flat(k.full ? k.full.before : k.before), after = flat(k.full ? k.full.after : k.after);
      const mark = k.verb === "Added" ? "added" : k.verb === "Removed" ? "removed" : before === "" && after === "" ? "described" : "changed";
      const { id, label: _l, mark: _m, before: _b, after: _a, text: _t, ...rest } = ch;
      const text = typeof k.text === "string" && k.text.trim() !== "" ? { text: k.text.trim() } : {};
      return { id, label: k.place !== "" ? k.place : (k.loc ?? "Change"), mark, ...(before !== "" ? { before } : {}), ...(after !== "" ? { after } : {}), ...text, ...rest };
    }),
  };
}

/** A test's hand-built View (any field may be left out) as the document the server would send for it. */
export function served(view: Record<string, unknown>, change?: TestChange): V1Doc {
  const v = { change: "c1", file: "book.xlsx", engine: "", kind: "grid", before: [], after: [], boxes: [], caveats: [], ...view } as unknown as View;
  return withCardWords(viewToV1(v, wordsOf(change)), v, change);
}

/** The document for a view request url: the model's own change for the key in the url supplies the card words, as at the serve boundary. */
export function servedFor(view: unknown, model: unknown, url: string): unknown {
  if (view === undefined || view === null || typeof view !== "object") return view;
  const key = /\/view\/([^/?#]+)/.exec(url)?.[1];
  const stops = ((model as { stops?: Array<{ change?: { key?: string; cards?: unknown[]; extraCards?: unknown[]; rowNotes?: unknown[] } }> } | null)?.stops ?? []);
  const change = key === undefined ? undefined : stops.map((s) => s.change).find((c) => c?.key === decodeURIComponent(key));
  return served(view as Record<string, unknown>, change);
}

/** Any value a page test's fetch stub answers: a hand-built View becomes its v1 document, everything else (a model, a status) passes through. */
export function asServed(v: unknown): unknown {
  const o = v as { kind?: unknown; before?: unknown; after?: unknown; stops?: unknown } | null;
  return o !== null && typeof o === "object" && typeof o.kind === "string" && Array.isArray(o.before) && Array.isArray(o.after) && o.stops === undefined ? served(o as Record<string, unknown>) : v;
}

/** What the page makes of a /view route body (the v1 document): its panes, its marks as `boxes`, its envelope. For route tests. */
export async function sceneOfBody(body: string): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  await import(new URL("../../src/timeline/rail/assets/view-table.js", import.meta.url).href);
  const scene = (globalThis as any).CoCheckViewTable.sceneOf(JSON.parse(body)); // eslint-disable-line @typescript-eslint/no-explicit-any
  return { ...scene, boxes: scene.marks };
}
