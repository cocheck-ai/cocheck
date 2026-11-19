// What the serve boundary sends the page. The page reads only the v1 document, so every test that boots review.js feeds it this.
import { viewToV1, type CardWords, type V1Doc } from "../../src/timeline/render/view-v1.ts";
import type { View } from "../../src/timeline/render/types.ts";

/** The model's change as the page's tests build it (cards, extraCards, rowNotes), as the card words the server uses. */
export const wordsOf = (c?: { cards?: unknown[]; extraCards?: unknown[]; rowNotes?: unknown[] } | null): CardWords => ({
  cards: [...((c?.cards ?? []) as CardWords["cards"]), ...((c?.extraCards ?? []) as CardWords["cards"])],
  rowNotes: (c?.rowNotes ?? []) as CardWords["rowNotes"],
});

/** A test's hand-built View (any field may be left out) as the document the server would send for it. */
export function served(view: Record<string, unknown>, change?: { cards?: unknown[]; extraCards?: unknown[]; rowNotes?: unknown[] } | null): V1Doc {
  const v = { change: "c1", file: "book.xlsx", engine: "", kind: "grid", before: [], after: [], boxes: [], caveats: [], ...view } as unknown as View;
  return viewToV1(v, wordsOf(change));
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
