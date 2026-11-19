// The size bound of the print-copy rewrites. A package whose XML parts would inflate past the cap, or whose zip is past the cap, gets the plain copy
// with no claim: the rewrite holds every part in memory (a 300k-row sheet, 39.8 MB of XML, took 2 GB and 4.7 s per side). The largest real workbook seen has
// 12 MB of sheet XML and stays on the rewrite. The check reads the zip's central directory only: nothing is inflated.
import { unzipSync } from "fflate";

export const PRINT_COPY_CAP_BYTES = 64 * 1024 * 1024;

export interface PrintCopyOptions {
  /** Test seam: the cap in bytes (default PRINT_COPY_CAP_BYTES). */
  cap?: number;
  /** Test seam: called with the name and size of every part the rewrite inflates. */
  inflated?: (name: string, size: number) => void;
}

const isXmlName = (n: string): boolean => /\.(?:xml|rels)$/i.test(n);

/** True when the package is within the cap; decided from the central directory, before any part is inflated. */
export function withinCap(bytes: Uint8Array, cap: number): boolean {
  if (bytes.length > cap) return false;
  let xml = 0;
  unzipSync(bytes, { filter: (f) => { if (isXmlName(f.name)) xml += f.originalSize; return false; } });
  return xml <= cap;
}

/** Every part, inflated; each part reported to `opts.inflated`. */
export function inflateAll(bytes: Uint8Array, opts?: PrintCopyOptions): Record<string, Uint8Array> {
  return unzipSync(bytes, { filter: (f) => { opts?.inflated?.(f.name, f.originalSize); return true; } });
}
