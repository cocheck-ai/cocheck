/** How many leading bytes are checked for a NUL byte: a file with one in its head is not plain text. */
export const NUL_SCAN_BYTES = 64 * 1024;

const strict = new TextDecoder("utf-8", { fatal: true });

/**
 * Whether stored bytes are plain text by their content, whatever the file is named: they decode as UTF-8 and the first 64 KB holds
 * no NUL byte. The one definition both the files layer and the timeline's text tier use. UTF-16 and Latin-1 files are not text here.
 */
export function decodeTextBytes(bytes: Uint8Array): string | null {
  const head = bytes.length > NUL_SCAN_BYTES ? bytes.subarray(0, NUL_SCAN_BYTES) : bytes;
  if (head.includes(0)) return null;
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

export function isTextBytes(bytes: Uint8Array): boolean {
  return decodeTextBytes(bytes) !== null;
}
