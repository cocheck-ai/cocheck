import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readDeck, readDeckTraced, slideRelationshipTypes } from "../src/office/connector/pptx/reader.ts";
import { readWorkbookSnapshot } from "../src/office/connector/xlsx/reader.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** The same bytes as three input types: a Node Buffer, a view at a non-zero offset into a larger ArrayBuffer, a plain Uint8Array. */
function shapes(file: Buffer): Record<string, () => Uint8Array> {
  return {
    "Node Buffer from readFileSync": () => Buffer.from(file),
    "Uint8Array view with non-zero byteOffset": () => {
      const big = new Uint8Array(file.length + 100);
      big.fill(0xab);
      big.set(file, 37);
      return big.subarray(37, 37 + file.length);
    },
    "plain Uint8Array": () => new Uint8Array(file),
  };
}

const deck = fixture("ppt-table-deck.pptx");
const book = fixture("lbo-model.xlsx");

type Call = (bytes: Uint8Array) => unknown;
const pptxCalls: Record<string, Call> = {
  readDeck: (b) => readDeck(b),
  readDeckTraced: (b) => readDeckTraced(b),
  slideRelationshipTypes: (b) => slideRelationshipTypes(b),
};
const xlsxCalls: Record<string, Call> = {
  readWorkbookSnapshot: (b) => readWorkbookSnapshot(b),
  "readWorkbookSnapshot with limits": (b) => readWorkbookSnapshot(b, { maxUnzippedBytes: 64 * 1048576 }),
};

for (const [fn, calls, file] of [
  ["pptx", pptxCalls, deck],
  ["xlsx", xlsxCalls, book],
] as const) {
  describe(`${fn} entry points never modify their input bytes`, () => {
    for (const [shape, make] of Object.entries(shapes(file))) {
      for (const [name, call] of Object.entries(calls)) {
        it(`${name}, ${shape}`, () => {
          const input = make();
          const before = sha(input);
          call(input);
          assert.equal(sha(input), before);
        });
      }
    }
  });
}
