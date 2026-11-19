import path from "node:path";
import { isKeyMissing, readSealed } from "../seal.ts";
import { storeDirOf } from "../states.ts";

/**
 * Image states are shown by the browser itself, from the stored bytes, on every OS. This module knows which file names are images and
 * reads one stored state; it renders nothing. The content type comes from the file's own extension, never from the bytes, and an image
 * is only ever loaded through an img element (an SVG that way cannot run script).
 */
const TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The image content type for a file name, or null when the file is not one of png, jpg, jpeg, gif, webp or svg. */
export function imageTypeOf(fileName: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(fileName.split(/[\\/]/).pop() ?? fileName)?.[1]?.toLowerCase() ?? "";
  return Object.hasOwn(TYPES, ext) ? TYPES[ext]! : null;
}

/** The plain bytes of one stored state, read by content hash from the task's own store; null when they are not there. A lost key is thrown. */
export async function readStoredImage(home: string, taskId: number, sha: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  try {
    return await readSealed(path.join(storeDirOf(home, taskId), sha));
  } catch (error) {
    if (isKeyMissing(error)) throw error;
    return null;
  }
}
