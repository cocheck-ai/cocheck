import type { ChangeInfo, FormatRenderer, View } from "./types.ts";

/**
 * a state a connector reads (its row has a connector, a known connector claims its ending, or it shares bytes with such a state) is never
 * drawn by core: no picture, no preview, no crop, no lines. The view is a card with no pane and one plain sentence.
 */
export const CLAIMED_CARD = "A connector reads this type of file, so CoCheck draws no view of it.";

export const claimedRenderer: FormatRenderer = {
  name: "connector-claimed",
  extensions: [],
  wholeView: true,
  view(_before, _after, info: ChangeInfo): View {
    return { change: info.id, file: info.file, engine: "", kind: "card", before: [], after: [], boxes: [], caveats: [CLAIMED_CARD, ...(info.missing ?? [])] };
  },
};
