import type { Box, ChangeInfo, FormatRenderer, Pane, View } from "./types.ts";

/**
 * The fallback renderer: the picture tier (an image the browser draws from the stored bytes) wrapped as kind `pages`. Its boxes come from the pixel diff the loader
 * already made (`generic.picture.regions`), so their confidence is `pixel`. With no picture it is a card: nothing is guessed.
 */

/** Who draws the picture, named on screen: the browser itself, on every OS. */
export const IMAGE_ENGINE = "your browser, from the stored file";

export const fallbackRenderer: FormatRenderer = {
  name: "stored-image",
  extensions: [],
  view(_before, _after, info: ChangeInfo): View {
    const caveats = [...(info.missing ?? [])];
    const engine = IMAGE_ENGINE;
    const pic = info.generic?.picture;
    if (info.generic?.pending === true) {
      return { change: info.id, file: info.file, engine, kind: "card", before: [], after: [], boxes: [], caveats, pending: true }; // The page shows its loading widget for `pending`, so no "still being drawn" words here
    }
    if (info.generic?.tier !== "picture" || !pic) {
      caveats.push(info.generic?.label ? `No picture of this file could be made, so nothing is boxed. ${info.generic.label.replace(/\.$/, "")}.` : "No picture of this file could be made, so nothing is boxed.");
      return { change: info.id, file: info.file, engine, kind: "card", before: [], after: [], boxes: [], caveats };
    }
    const pane = (side: "before" | "after", sha: string | null): Pane[] => (sha === null ? [] : [{ id: `${side}:page1`, label: side === "before" ? "Before" : "After", picture: { sha, width: pic.width, height: pic.height } }]);
    const boxes: Box[] = [];
    for (const side of ["before", "after"] as const) {
      if ((side === "before" ? pic.before : pic.after) === null) continue;
      for (const r of pic.regions) boxes.push({ side, pane: `${side}:page1`, rect: { ...r }, change: info.id, confidence: "pixel" });
    }
    // Boxes here are always a pixel comparison of the two pictures, never a reading of the file.
    if (pic.regions.length > 0) caveats.push("The pink boxes mark where the pixels differ, found by comparing the two pictures, not by reading them.");
    if (pic.note) caveats.push(`${pic.note.replace(/\.?$/, ".")}`);
    return { change: info.id, file: info.file, engine, kind: "pages", before: pane("before", pic.before), after: pane("after", pic.after), boxes, caveats };
  },
};
