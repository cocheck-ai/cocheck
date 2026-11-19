import { crc32 } from "node:zlib";
import { deflateSync, inflateSync } from "fflate";

/**
 * A zip reader/rewriter that keeps every entry it is not asked to change byte-for-byte: the local
 * header, compressed data, data descriptor and extra fields are copied as they are, entry order is
 * kept, and only the central directory offsets move. A changed entry is stored deflated with its
 * own fresh header. Re-zipping a whole deck through a library would recompress everything and drop
 * what Office wrote; this does not. Zip64 and encrypted archives are refused, not guessed at.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

interface Entry {
  name: string;
  method: number;
  flags: number;
  csize: number;
  localOffset: number;
  /** Where this entry's bytes (local header through data descriptor) end in the file. */
  extentEnd: number;
  /** The central directory record, verbatim. */
  central: Uint8Array;
}

const utf8 = new TextDecoder("utf-8");

export class Zip {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  /** Central directory order. */
  readonly #entries: Entry[] = [];
  readonly #cdOffset: number;
  readonly #eocd: Uint8Array;

  constructor(input: Uint8Array) {
    // A Node Buffer's slice() is a view, not a copy, so the patched copies below would write through into the caller's bytes.
    // Re-viewing as a plain Uint8Array (same memory, no copy) makes every slice() here a real copy.
    const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (this.#view.getUint32(i, true) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("not a zip file: no end-of-central-directory record");
    const count = this.#view.getUint16(eocd + 10, true);
    const cdSize = this.#view.getUint32(eocd + 12, true);
    this.#cdOffset = this.#view.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || this.#cdOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
    this.#eocd = bytes.subarray(eocd);
    let p = this.#cdOffset;
    for (let i = 0; i < count; i++) {
      if (this.#view.getUint32(p, true) !== SIG_CENTRAL) throw new Error("corrupt zip: bad central directory record");
      const nameLen = this.#view.getUint16(p + 28, true);
      const len = 46 + nameLen + this.#view.getUint16(p + 30, true) + this.#view.getUint16(p + 32, true);
      const flags = this.#view.getUint16(p + 8, true);
      if (flags & 1) throw new Error("encrypted zip entries are not supported");
      const csize = this.#view.getUint32(p + 20, true);
      const localOffset = this.#view.getUint32(p + 42, true);
      if (csize === 0xffffffff || localOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
      this.#entries.push({
        name: utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
        method: this.#view.getUint16(p + 10, true),
        flags,
        csize,
        localOffset,
        extentEnd: 0,
        central: bytes.subarray(p, p + len),
      });
      p += len;
    }
    const byOffset = [...this.#entries].sort((a, b) => a.localOffset - b.localOffset);
    byOffset.forEach((e, i) => {
      e.extentEnd = byOffset[i + 1]?.localOffset ?? this.#cdOffset;
    });
  }

  /** Entry names, central directory order. */
  get names(): string[] {
    return this.#entries.map((e) => e.name);
  }

  has(name: string): boolean {
    return this.#entries.some((e) => e.name === name);
  }

  #entry(name: string): Entry {
    const e = this.#entries.find((x) => x.name === name);
    if (!e) throw new Error(`no part ${name} in the package`);
    return e;
  }

  /** The uncompressed bytes of entry `name`. */
  read(name: string): Uint8Array {
    const e = this.#entry(name);
    if (this.#view.getUint32(e.localOffset, true) !== SIG_LOCAL) throw new Error(`corrupt zip: bad local header for ${name}`);
    const start = e.localOffset + 30 + this.#view.getUint16(e.localOffset + 26, true) + this.#view.getUint16(e.localOffset + 28, true);
    const data = this.#bytes.subarray(start, start + e.csize);
    if (e.method === 0) return data.slice();
    if (e.method === 8) return inflateSync(data);
    throw new Error(`entry ${name} uses unsupported compression method ${e.method}`);
  }

  /** The stored (still compressed) bytes of entry `name`, exactly as they sit in the file. */
  compressed(name: string): Uint8Array {
    const e = this.#entry(name);
    const start = e.localOffset + 30 + this.#view.getUint16(e.localOffset + 26, true) + this.#view.getUint16(e.localOffset + 28, true);
    return this.#bytes.subarray(start, start + e.csize);
  }

  /**
   * A new archive identical to this one except that each entry in `replacements` carries the given bytes
   * and each entry in `additions` (names not already in the archive) is appended after the existing ones.
   */
  rewrite(replacements: Map<string, Uint8Array>, additions: Map<string, Uint8Array> = new Map()): Uint8Array {
    for (const name of replacements.keys()) this.#entry(name);
    for (const name of additions.keys()) if (this.has(name)) throw new Error(`part ${name} already exists in the package`);
    const out: Uint8Array[] = [];
    let offset = 0;
    const push = (chunk: Uint8Array) => {
      out.push(chunk);
      offset += chunk.length;
    };
    const order = [...this.#entries].sort((a, b) => a.localOffset - b.localOffset);
    const first = order[0];
    push(this.#bytes.subarray(0, first ? first.localOffset : this.#cdOffset));
    const central = new Map<Entry, Uint8Array>();
    for (const e of order) {
      const newOffset = offset;
      const data = replacements.get(e.name);
      if (data === undefined) {
        push(this.#bytes.subarray(e.localOffset, e.extentEnd));
        central.set(e, patchCentral(e.central, { localOffset: newOffset }));
        continue;
      }
      const packed = deflateSync(data);
      const crc = crc32(data);
      const flags = e.flags & ~0x8;
      const name = e.central.subarray(46, 46 + new DataView(e.central.buffer, e.central.byteOffset).getUint16(28, true));
      const local = new Uint8Array(30 + name.length);
      const v = new DataView(local.buffer);
      const cv = new DataView(e.central.buffer, e.central.byteOffset);
      v.setUint32(0, SIG_LOCAL, true);
      v.setUint16(4, cv.getUint16(6, true), true);
      v.setUint16(6, flags, true);
      v.setUint16(8, 8, true);
      v.setUint16(10, cv.getUint16(12, true), true);
      v.setUint16(12, cv.getUint16(14, true), true);
      v.setUint32(14, crc, true);
      v.setUint32(18, packed.length, true);
      v.setUint32(22, data.length, true);
      v.setUint16(26, name.length, true);
      local.set(name, 30);
      push(local);
      push(packed);
      central.set(e, patchCentral(e.central, { localOffset: newOffset, flags, method: 8, crc, csize: packed.length, usize: data.length }));
    }
    const added: Uint8Array[] = [];
    for (const [name, data] of additions) {
      const nameBytes = new TextEncoder().encode(name);
      const packed = deflateSync(data);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const rec = new Uint8Array(46 + nameBytes.length);
      const lv = new DataView(local.buffer);
      const cv = new DataView(rec.buffer);
      lv.setUint32(0, SIG_LOCAL, true);
      cv.setUint32(0, SIG_CENTRAL, true);
      cv.setUint16(4, 20, true);
      // version needed, flags (bit 11: UTF-8 name), method deflate, DOS time 00:00, DOS date 1980-01-01
      const common: [number, number][] = [[4, 20], [6, 0x800], [8, 8], [10, 0], [12, 0x21]];
      for (const [at, val] of common) {
        lv.setUint16(at, val, true);
        cv.setUint16(at + 2, val, true);
      }
      lv.setUint32(14, crc, true);
      lv.setUint32(18, packed.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, packed.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      rec.set(nameBytes, 46);
      push(local);
      push(packed);
      added.push(rec);
    }
    const cdStart = offset;
    for (const e of this.#entries) push(central.get(e)!);
    for (const rec of added) push(rec);
    const cdSize = offset - cdStart;
    const eocd = this.#eocd.slice();
    const ev = new DataView(eocd.buffer);
    ev.setUint16(8, this.#entries.length + added.length, true);
    ev.setUint16(10, this.#entries.length + added.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    push(eocd);
    const result = new Uint8Array(offset);
    let at = 0;
    for (const chunk of out) {
      result.set(chunk, at);
      at += chunk.length;
    }
    return result;
  }
}

interface CentralPatch {
  localOffset: number;
  flags?: number;
  method?: number;
  crc?: number;
  csize?: number;
  usize?: number;
}

function patchCentral(record: Uint8Array, p: CentralPatch): Uint8Array {
  const copy = record.slice();
  const v = new DataView(copy.buffer);
  v.setUint32(42, p.localOffset, true);
  if (p.flags !== undefined) v.setUint16(8, p.flags, true);
  if (p.method !== undefined) v.setUint16(10, p.method, true);
  if (p.crc !== undefined) v.setUint32(16, p.crc, true);
  if (p.csize !== undefined) v.setUint32(20, p.csize, true);
  if (p.usize !== undefined) v.setUint32(24, p.usize, true);
  return copy;
}
