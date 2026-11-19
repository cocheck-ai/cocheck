// What a capture freezes. A connector's change list (and a kept MCP call's input and response) is secret-scanned with the existing rules,
// sealed in the task's store and named by the sha256 of the scrubbed bytes. Load reads these back and never asks a connector again.
// Office pictures step 1: an `image` picture's PNG data URL is not scrubbed but checked as a PNG, cut to the chunks that draw it and lifted into `pictures/`;
// the list keeps `cpic/<sha>`.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { isKeyMissing, readSealed, sha256Hex, writeSealed } from "../seal.ts";
import { redactSecrets } from "../secret-scan.ts";

/** Where a task's frozen change lists are sealed (`<sha256>`). They hold values, so they live and die with the task's other values. */
export const changesDirOf = (home: string, taskId: number): string => path.join(home, "tasks", String(taskId), "changes");
/** Where a task's kept MCP call values are sealed (`<call id, made filename-safe>.json`). Same lifetime as the change lists. */
export const callsDirOf = (home: string, taskId: number): string => path.join(home, "tasks", String(taskId), "calls");

/** Where a task's connector pictures are sealed (`<sha256 of the PNG bytes>`), lifted out of the frozen lists' `image` pictures. Same lifetime as the lists. */
export const picturesDirOf = (home: string, taskId: number): string => path.join(home, "tasks", String(taskId), "pictures");

/** The src a lifted picture is given in the frozen list: the review route `/timeline/<task>/cpic/<sha>` serves those bytes. Only freezing writes it. */
export const CPIC_SRC = /^cpic\/([0-9a-f]{64})$/;
/** The one image data URL CoCheck keeps: a base64 PNG. */
const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Largest side of a kept picture, in pixels (a page at 2x is about 2000). */
export const MAX_PICTURE_SIDE = 32_768;

/**
 * The size of a PNG, or undefined when the bytes are not one: the signature, an IHDR first chunk of 13 bytes with both sides in 1..MAX_PICTURE_SIDE,
 * every chunk whole, and an IEND last. Structure only (no pixel decode), so any valid PNG (16-bit, interlaced, palette) passes; the browser draws it
 * as image/png under nosniff, so bytes that pass this and still do not decode show as a broken picture, never as anything else.
 */
export function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 8 + 25 + 12 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") return undefined;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_PICTURE_SIDE || height > MAX_PICTURE_SIDE) return undefined;
  for (let at = 8; at + 12 <= bytes.length;) {
    const len = bytes.readUInt32BE(at), type = bytes.toString("latin1", at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || at + 12 + len > bytes.length) return undefined;
    if (type === "IEND") return at + 12 + len === bytes.length ? { width, height } : undefined;
    at += 12 + len;
  }
  return undefined;
}

/**
 * The chunks a lifted picture keeps: the ones needed to draw it (IHDR, PLTE, tRNS, IDAT, IEND). Every other chunk is dropped, because ancillary chunks
 * (tEXt, zTXt, iTXt, eXIf, iCCP's profile name, private chunks) can carry free text that the secret redactor never sees: picture bytes are stored as
 * received, not scrubbed. Colour hints (gAMA, cHRM, sRGB, iCCP, cICP) go too: a browser draws an untagged PNG as sRGB, which is what a page raster is,
 * and cHRM and iCCP have room for a token. A PNG with an unknown critical chunk would not decode anyway, so dropping it costs nothing.
 */
const DRAWING_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

/**
 * `bytes` (which pngSize accepted) with only DRAWING_CHUNKS left, in their order, each copied whole (length, type, data, CRC), so nothing is recomputed.
 * A PNG that holds nothing else comes back as the same buffer, byte-identical.
 */
export function drawingChunksOnly(bytes: Buffer): Buffer {
  const parts: Buffer[] = [bytes.subarray(0, 8)];
  let dropped = false;
  for (let at = 8; at + 12 <= bytes.length;) {
    const end = at + 12 + bytes.readUInt32BE(at);
    if (DRAWING_CHUNKS.has(bytes.toString("latin1", at + 4, at + 8))) parts.push(bytes.subarray(at, end));
    else dropped = true;
    at = end;
  }
  return dropped ? Buffer.concat(parts) : bytes;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const nameOf = (p: Record<string, unknown>): string => (typeof p.id === "string" && p.id !== "" ? `"${p.id.slice(0, 80)}"` : "of the list");

/**
 * Lifts each `image` picture's PNG data URL out of `answer` into the task's sealed picture store and gives the picture `src: cpic/<sha>` (and its
 * size from the PNG when the answer gave none). An image src that is a data URL but not a valid PNG, or a `cpic/` src the answer wrote itself, is
 * dropped with a caveat: never stored, never shown. Any other src is left as it was. Returns the new answer and, per picture index, the src it set.
 */
async function liftPictures(home: string, taskId: number, answer: unknown): Promise<{ doc: unknown; lifted: Map<number, string> }> {
  const lifted = new Map<number, string>();
  if (!isObj(answer) || !Array.isArray(answer.pictures)) return { doc: answer, lifted };
  const caveats: string[] = [];
  const pictures: unknown[] = [];
  for (const [i, raw] of (answer.pictures as unknown[]).entries()) {
    if (!isObj(raw) || raw.type !== "image" || typeof raw.src !== "string") { pictures.push(raw); continue; }
    const pic: Record<string, unknown> = { ...raw };
    const src = raw.src;
    if (CPIC_SRC.test(src)) {
      delete pic.src;
      caveats.push(`Picture ${nameOf(raw)} named a CoCheck picture address itself, so it is not shown.`);
    } else if (/^data:/i.test(src)) {
      delete pic.src;
      const m = PNG_DATA_URL.exec(src);
      const received = m === null || m[1]!.length % 4 !== 0 ? undefined : Buffer.from(m[1]!, "base64");
      const size = received === undefined ? undefined : pngSize(received);
      // Only the chunks that draw it are kept (drawingChunksOnly): text chunks would bypass the redactor. The name is of the bytes kept.
      const bytes = received === undefined || size === undefined ? undefined : drawingChunksOnly(received);
      if (bytes === undefined || size === undefined) {
        caveats.push(`Picture ${nameOf(raw)} was not a PNG, so it is not shown.`);
      } else {
        const sha256 = sha256Hex(bytes);
        const dir = picturesDirOf(home, taskId);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeSealed(path.join(dir, sha256), bytes);
        pic.src = `cpic/${sha256}`;
        lifted.set(i, pic.src as string);
        const sized = typeof raw.width === "number" && raw.width > 0 && typeof raw.height === "number" && raw.height > 0;
        if (!sized) { pic.width = size.width; pic.height = size.height; }
      }
    }
    pictures.push(pic);
  }
  if (caveats.length === 0 && lifted.size === 0) return { doc: answer, lifted };
  const kept = Array.isArray(answer.caveats) ? (answer.caveats as unknown[]) : [];
  return { doc: { ...answer, pictures, ...(caveats.length === 0 ? {} : { caveats: [...kept, ...caveats] }) }, lifted };
}

/** JSON with every object's keys sorted: the same answer always seals to the same ref. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Every string inside `v` (keys excluded) run through the secret rules' redaction. Depth is bounded; past it a value is replaced by a note. */
export function scrubDeep(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redactSecrets(v);
  if (depth > 24) return "[too deep to keep]";
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubDeep(x, depth + 1)]));
  return v;
}

/**
 * Lifts the answer's PNG pictures into `pictures/` (see liftPictures), scrubs the rest, seals it under `changes/` and returns its sha256 (of the
 * scrubbed canonical bytes). The lifted srcs are CoCheck's own addresses and are put back after the scrub, so the redactor never sees image data.
 */
export async function freezeChanges(home: string, taskId: number, answer: unknown): Promise<{ sha256: string; bytes: Buffer }> {
  const { doc, lifted } = await liftPictures(home, taskId, answer);
  const scrubbed = scrubDeep(doc);
  if (lifted.size > 0 && isObj(scrubbed) && Array.isArray(scrubbed.pictures)) {
    for (const [i, src] of lifted) { const p = (scrubbed.pictures as unknown[])[i]; if (isObj(p)) p.src = src; }
  }
  const bytes = Buffer.from(canonicalJson(scrubbed), "utf8");
  const sha256 = sha256Hex(bytes);
  const dir = changesDirOf(home, taskId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeSealed(path.join(dir, sha256), bytes);
  return { sha256, bytes };
}

/** The frozen list with this hash, parsed. Throws when it is missing, unreadable or its bytes no longer hash to the name. */
export async function readFrozen(home: string, taskId: number, sha256: string): Promise<unknown> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("not a change list ref");
  const bytes = await readSealed(path.join(changesDirOf(home, taskId), sha256));
  if (sha256Hex(bytes) !== sha256) throw new Error("the stored change list does not match its hash");
  return JSON.parse(bytes.toString("utf8"));
}

/** The sealed PNG of a lifted picture, or undefined when it is not there or its bytes no longer hash to the name or read as a PNG. A missing key throws. */
export async function readPicture(home: string, taskId: number, sha256: string): Promise<Buffer | undefined> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  let bytes: Buffer;
  try {
    bytes = await readSealed(path.join(picturesDirOf(home, taskId), sha256));
  } catch (error) {
    if (isKeyMissing(error)) throw error;
    return undefined;
  }
  return sha256Hex(bytes) === sha256 && pngSize(bytes) !== undefined ? bytes : undefined;
}

/** Deletes a task's frozen lists, lifted pictures and kept call values (the values expiry). */
export async function removeFrozen(home: string, taskId: number): Promise<void> {
  await rm(changesDirOf(home, taskId), { recursive: true, force: true });
  await rm(picturesDirOf(home, taskId), { recursive: true, force: true });
  await rm(callsDirOf(home, taskId), { recursive: true, force: true });
}

/** The most bytes of one kept MCP call part (the input, the response) that is stored; the rest is cut and the record says so. The largest real response the probe found was about 27 KB. */
export const MCP_PART_CAP_BYTES = 64 * 1024;

export interface KeptCall { tool: string; call: string; input: unknown; response: unknown; cut: { input?: number; response?: number } }

const cutPart = (v: unknown): { value: unknown; cutFrom?: number } => {
  const text = v === undefined ? "" : typeof v === "string" ? v : canonicalJson(v);
  const size = Buffer.byteLength(text, "utf8");
  if (size <= MCP_PART_CAP_BYTES) return { value: v };
  return { value: Buffer.from(text, "utf8").subarray(0, MCP_PART_CAP_BYTES).toString("utf8"), cutFrom: size };
};

/** Keeps one MCP call's input and response: scrubbed, each part capped at MCP_PART_CAP_BYTES (a cut part is stored as its text prefix, with the full size in `cut`), sealed under `calls/`. Returns the file's name. */
export async function keepCallValues(home: string, taskId: number, call: { call: string; tool: string; input: unknown; response: unknown }): Promise<string> {
  const i = cutPart(scrubDeep(call.input)), r = cutPart(scrubDeep(call.response));
  const kept: KeptCall = { tool: call.tool, call: call.call, input: i.value ?? null, response: r.value ?? null, cut: { ...(i.cutFrom === undefined ? {} : { input: i.cutFrom }), ...(r.cutFrom === undefined ? {} : { response: r.cutFrom }) } };
  const name = `${call.call.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "call"}.json`;
  const dir = callsDirOf(home, taskId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeSealed(path.join(dir, name), Buffer.from(canonicalJson(kept), "utf8"));
  return name;
}
