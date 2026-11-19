// what the serve boundary adds to a connector's picture before the page reads it. The connector names pictures; CoCheck holds the stored states.
//   text picture, no `private.text`  -> the side's stored state as numbered lines (the lines a box's `lines` range points at)
//   html picture whose src is a data:text/html URL -> its html in the sandboxed view server (src becomes that frame address); any other src is dropped
//   image picture -> its src as frozen: `cpic/<sha>` (a PNG lifted at freeze, src/connector/frozen.ts) is what the page draws as an <img>; a data URL
//                    (a list frozen before lifting existed) is dropped, so the page shows the picture's label and never gets image data in the document
// A picture is never given markup of its own: the page draws a frame address or text lines, as text.
import { prepareFramePayload } from "../../review-view-server.ts";
import type { V1Doc } from "../render/view-v1.ts";

/** A state past this many lines or bytes is not turned into a text picture: the picture keeps its label and says nothing more. */
export const MAX_PICTURE_LINES = 3000;
export const MAX_PICTURE_BYTES = 512 * 1024;

export function finishPictures(doc: V1Doc, io: { before: Buffer | null; after: Buffer | null; mint?: (html: string) => string }): V1Doc {
  if (!Array.isArray(doc.pictures)) return doc;
  const pictures = (Array.isArray(doc.pictures) ? doc.pictures : []).map((p) => {
    const pic = { ...p } as Record<string, unknown> & { type: string; side: "before" | "after" };
    if (pic.type === "text") {
      const buf = pic.side === "before" ? io.before : io.after;
      const priv = pic.private as Record<string, unknown> | undefined;
      if (buf !== null && buf.length <= MAX_PICTURE_BYTES && !(priv !== undefined && priv.text !== undefined)) {
        const lines = buf.toString("utf8").split(/\r\n|\n|\r/);
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        if (lines.length <= MAX_PICTURE_LINES) pic.private = { ...(priv ?? {}), text: { lines: lines.map((text, i) => ({ n: i + 1, text })) } };
      }
    } else if (pic.type === "image") {
      if (typeof pic.src === "string" && /^data:/i.test(pic.src)) delete pic.src;
    } else if (pic.type === "html") {
      const src = typeof pic.src === "string" ? pic.src : "";
      delete pic.src;
      const m = /^data:text\/html(;base64)?,(.*)$/s.exec(src);
      if (m !== null && io.mint !== undefined) {
        try {
          const value = m[1] !== undefined ? Buffer.from(m[2]!, "base64").toString("utf8") : decodeURIComponent(m[2]!);
          const prepared = prepareFramePayload({ type: "html", value });
          if (prepared.ok) pic.src = io.mint(prepared.html);
        } catch { /* no frame: the picture keeps its label */ }
      }
    }
    return pic;
  });
  return { ...doc, pictures } as unknown as V1Doc;
}
