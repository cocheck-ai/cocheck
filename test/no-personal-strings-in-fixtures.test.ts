import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, strToU8, unzipSync, unzlibSync, zipSync, zlibSync } from "fflate";

// no personal data in tests and fixtures, including inside binary files. A text search
// (rg) skips binary files and cannot see inside deflated zip entries, so this scan decodes each container.
// The needles are assembled from parts so this file does not contain them.
const NEEDLES = [["to", "mas"], ["tor", "terola"], ["tor", "terola", "to", "mas", "16"], ["anoni", "mation"]].map((p) => p.join(""));
const ROOT = path.resolve(import.meta.dirname, "..");

function latin(b: Uint8Array): string {
  return Buffer.from(b).toString("latin1").toLowerCase();
}
function utf16(b: Uint8Array, be: boolean): string {
  const buf = Buffer.from(b);
  const even = buf.length - (buf.length % 2);
  const out = Buffer.alloc(even);
  for (let i = 0; i < even; i += 2) {
    out[i] = be ? buf[i + 1]! : buf[i]!;
    out[i + 1] = be ? buf[i]! : buf[i + 1]!;
  }
  return out.toString("utf16le").toLowerCase();
}
// Text views of one blob: raw bytes, UTF-16 both byte orders (both alignments), and PDF hex strings decoded.
function views(b: Uint8Array): string[] {
  const raw = latin(b);
  const v = [raw, utf16(b, false), utf16(b, true), utf16(b.subarray(1), false), utf16(b.subarray(1), true)];
  for (const m of raw.matchAll(/<([0-9a-f\s]{8,})>/g)) {
    const hex = m[1]!.replace(/\s+/g, "");
    if (hex.length % 2 === 0) {
      const dec = Buffer.from(hex, "hex");
      v.push(latin(dec), utf16(dec, true));
    }
  }
  return v;
}

export function scanBytes(label: string, b: Uint8Array, depth = 0): string[] {
  const hits: string[] = [];
  const text = views(b);
  for (const n of NEEDLES) if (text.some((t) => t.includes(n))) hits.push(`${label} [needle #${NEEDLES.indexOf(n)}]`);
  if (depth > 4) return hits;
  const head = Buffer.from(b.subarray(0, 4));
  if (head.toString("latin1") === "PK\x03\x04") {
    let entries: Record<string, Uint8Array> = {};
    try {
      entries = unzipSync(b as Uint8Array);
    } catch {
      /* deliberately corrupt zip fixture (corrupt_truncated.xlsx): raw bytes were already scanned above */
    }
    for (const [name, data] of Object.entries(entries)) hits.push(...scanBytes(`${label}!${name}`, data, depth + 1));
  } else if (head[0] === 0x1f && head[1] === 0x8b) {
    try {
      hits.push(...scanBytes(`${label}!gunzip`, gunzipSync(b as Uint8Array), depth + 1));
    } catch {
      /* not gzip */
    }
  }
  if (head.toString("latin1") === "%PDF") {
    const raw = Buffer.from(b).toString("latin1");
    for (const m of raw.matchAll(/stream\r?\n/g)) {
      const start = m.index! + m[0].length;
      const end = raw.indexOf("endstream", start);
      if (end < 0) continue;
      try {
        hits.push(...scanBytes(`${label}[stream@${start}]`, unzlibSync(Uint8Array.from(Buffer.from(raw.slice(start, end), "latin1"))), depth + 1));
      } catch {
        /* not a flate stream, already covered as raw bytes */
      }
    }
  }
  return hits;
}

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "test", "platforms"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  return out
    .split("\0")
    .filter(Boolean)
    // The author's name in test/*.ts code comments is out of scope; everything else is a fixture.
    .filter((f) => !(f.startsWith("test/") && f.endsWith(".ts") && f.split("/").length === 2));
}

describe("personal strings in test and platform files, decoded", () => {
  it("the scanner sees a string inside a zip entry, a nested zip, a flate PDF stream, a PDF hex string and UTF-16", () => {
    const needle = NEEDLES[0]!;
    const inZip = zipSync({ "xl/workbook.xml": strToU8(`<a url="/Users/${needle}/x"/>`) });
    assert.equal(scanBytes("z.xlsx", inZip).length, 1);
    const nested = zipSync({ "inner.zip": inZip });
    assert.equal(scanBytes("n.zip", nested).length, 1);
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<</Filter/FlateDecode>>\nstream\n"), Buffer.from(zlibSync(strToU8(`author ${needle}`))), Buffer.from("\nendstream\nendobj\n")]);
    assert.equal(scanBytes("p.pdf", pdf).length, 1);
    const hexPdf = Buffer.from(`%PDF-1.4\n/Author <${Buffer.from(needle).toString("hex").toUpperCase()}>\n`);
    assert.equal(scanBytes("h.pdf", hexPdf).length, 1);
    assert.equal(scanBytes("w.bin", Buffer.from(needle, "utf16le")).length, 1);
    assert.equal(scanBytes("c.pdf", Buffer.from("%PDF-1.4\nclean\n")).length, 0);
  });

  it("no tracked file under test/ or platforms/ holds a personal string in any decoded layer", () => {
    const files = trackedFiles();
    assert.ok(files.length > 200, `expected the full tracked tree, saw ${files.length} files`);
    const hits: string[] = [];
    for (const f of files) {
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(path.join(ROOT, f));
      } catch {
        continue; // tracked but deleted in the worktree
      }
      hits.push(...scanBytes(f, bytes));
    }
    assert.deepEqual(hits, []);
  });
});
