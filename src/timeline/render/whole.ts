import type { ChangeInfo, FormatRenderer } from "./types.ts";

/**
 * The whole-file view (the Now and Before task positions of the Files view) is asked for with `?whole=before|after`. It is answered when the renderer
 * chosen for the file has one (`wholeView`: the renderers that draw pages or lines, and the card for a claimed type), never from the file's ending. A
 * secret file never has it.
 */
export const wholeViewFor = (renderer: FormatRenderer, generic: ChangeInfo["generic"] | undefined, asked: "before" | "after" | undefined): "before" | "after" | undefined =>
  asked !== undefined && renderer.wholeView === true && generic?.secret !== true ? asked : undefined;
