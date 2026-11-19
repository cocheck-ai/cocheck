import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { writeSealed } from "../src/seal.ts";
import { formatChangesOf } from "../src/timeline/load.ts";
import { alignSequences } from "../src/formats/files/align.ts";
import { readDocxParagraphs } from "../src/office/connector/docx/reader.ts";
import { createFilesLayer } from "../src/office/connector/docx/layer.ts";
import { storeDirOf } from "../src/states.ts";
import type { RawState } from "../src/timeline/runs.ts";
import type { FormatChanges, FormatRow } from "../src/timeline/timeline.ts";

// Change-first Word rows and cards (cfv-cards): a run of added or removed paragraphs is ONE row ("paragraphs N-M"), a header or footer edit has a
// card, a picture resized or reordered and a paragraph whose look changed say so in plain words, and list markers that moved are a sentence on the
// row that caused them. Pairs are real Codex-like Word steps (test/fixtures/word-conditional-format-*); a few are edited in the XML here. Nothing opens Word.

const fixture = (name: string): Promise<Buffer> => readFile(path.join(import.meta.dirname, "fixtures", `word-conditional-format-${name}.docx`));
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** A fixture with one package part rewritten by `fn`. */
async function edited(name: string, part: string, fn: (xml: string) => string): Promise<Buffer> {
  const files = unzipSync(await fixture(name));
  files[part] = strToU8(fn(Buffer.from(files[part]!).toString("utf8")));
  return Buffer.from(zipSync(files, { mtime: new Date(2020, 0, 1) }));
}

async function read(from: Buffer, to: Buffer): Promise<FormatChanges> {
  const home = await mkdtemp(path.join(tmpdir(), "cfv-cards-"));
  try {
    await mkdir(storeDirOf(home, 1), { recursive: true });
    const stored = new Map<string, number>();
    for (const b of [from, to]) { await writeSealed(path.join(storeDirOf(home, 1), sha(b)), b); stored.set(sha(b), b.length); }
    const s = { id: 1, step_id: 1, task_id: 1, file_path: "/w/r.docx", sha256: sha(to), prev_sha256: sha(from), phase: "post", calls_open_json: null, credited_json: null, size: to.length, kept: "whole", note: null, ts: null } as unknown as RawState;
    return await formatChangesOf(home, 1, s, [createFilesLayer()], stored, new Set());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
const rowsOf = (f: FormatChanges): FormatRow[] => {
  assert.ok(!("unavailable" in f), JSON.stringify(f));
  return f.rows;
};
const brief = (rows: FormatRow[]): string[] => rows.map((r) => `${r.location} | ${r.kind}`);
// core's Word cards are gone (the connector's document carries each change's words and plain sentence, and the page draws the
// card); the reader's rows and their words, which that document is made from, stay pinned here.

/** A bare document of plain paragraphs, in the shape the other Word tests build. */
const document = (paragraphs: string[]): Buffer => {
  const body = paragraphs.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join("");
  return Buffer.from(zipSync({ "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`) }, { mtime: new Date(2020, 0, 1) }));
};

describe("a run of consecutive added or removed paragraphs is one change", () => {
  it("W1: the added Next Steps paragraphs are one 'paragraphs 37-41' row", async () => {
    const rows = rowsOf(await read(await fixture("w1-before"), await fixture("w1-after")));
    assert.deepEqual(brief(rows), ["paragraph 2 | paragraph changed", "paragraph 28 | paragraph removed", "paragraphs 37-41 | paragraphs added"]);
    const run = rows[2]!;
    assert.match(run.after!, /^\n\nNext Steps\nThe project lead will confirm the next review date/);
    assert.equal(run.before, null);
  });
  it("a single added or removed paragraph keeps 'paragraph N'; a changed paragraph stays one row each", async () => {
    const rows = rowsOf(await read(document(["A", "B", "C"]), document(["A", "B2", "C", "D"])));
    assert.deepEqual(brief(rows), ["paragraph 2 | paragraph changed", "paragraph 4 | paragraph added"]);
    const gone = rowsOf(await read(document(["A", "B", "C", "D"]), document(["A", "D"])));
    assert.deepEqual(brief(gone), ["paragraphs 2-3 | paragraphs removed"]);
    assert.equal(gone[0]!.before, "B\nC");
  });
  it("empty paragraphs inside a run belong to the run, and an all-empty run says so in the plural", async () => {
    const rows = rowsOf(await read(document(["A", "Z"]), document(["A", "X", "", "Y", "Z"])));
    assert.deepEqual(brief(rows), ["paragraphs 2-4 | paragraphs added"]);
    assert.equal(rows[0]!.after, "X\n\nY");
    const empties = rowsOf(await read(document(["A", "Z"]), document(["A", "", "", "Z"])));
    assert.deepEqual(brief(empties), ["paragraphs 2-3 | paragraphs added"]);
    assert.equal(empties[0]!.after, "\n");
  });
  it("two runs split by an unchanged paragraph are two rows, each numbered on the side where it exists", async () => {
    const rows = rowsOf(await read(document(["A", "B", "C"]), document(["A", "n1", "n2", "B", "n3", "n4", "C"])));
    assert.deepEqual(brief(rows), ["paragraphs 2-3 | paragraphs added", "paragraphs 5-6 | paragraphs added"]);
  });
  it("restate reads a run back from the later file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cfv-restate-"));
    const file = path.join(dir, "r.docx");
    await writeFile(file, document(["A", "X", "Y", "Z"]));
    const restated = await createFilesLayer().restate(file, { location: "paragraphs 2-3", kind: "paragraphs added", before: null, after: "?", derivable: false, detail: {} });
    assert.equal(restated.after, "X\nY");
  });
});

describe("header and footer edits have a row", () => {
  it("W12: the header edit is one 'header 1' row (it was only a whole-file row)", async () => {
    const rows = rowsOf(await read(await fixture("w12-before"), await fixture("w12-after")));
    assert.deepEqual(brief(rows), ["header 1 | header changed"]);
    assert.deepEqual([rows[0]!.before, rows[0]!.after], ["Delivery report, draft v1", "Delivery report, draft v2"]);
  });
});

describe("a paragraph whose look changed, with its words the same", () => {
  it("the formatting probe pair: a colour change and a bold, in plain words, with no whole-file row", async () => {
    const rows = rowsOf(await read(await fixture("w1-before"), await fixture("fmt-after")));
    assert.deepEqual(brief(rows), ["paragraph 3 | paragraph formatting changed", "paragraph 25 | paragraph formatting changed"]);
    assert.deepEqual(rows.map((r) => r.text), ["paragraph formatting changed: Colour changed", "paragraph formatting changed: Made bold"]);
    assert.ok(rows.every((r) => r.kind !== "file changed"));
  });
  it("a bold taken away reads 'Removed bold'", async () => {
    const rows = rowsOf(await read(await fixture("fmt-after"), await fixture("w1-before")));
    assert.deepEqual(rows.map((r) => r.text), ["paragraph formatting changed: Colour changed", "paragraph formatting changed: Removed bold"]);
  });
});

describe("pictures", () => {
  it("a picture drawn larger is 'picture resized' on its paragraph", async () => {
    const before = await fixture("w10-before");
    const after = await edited("w10-before", "word/document.xml", (x) => x.replace(/(<wp:extent cx=")1828800(" cy=")914400"/, '$13657600$21828800"'));
    const rows = rowsOf(await read(before, after));
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.kind, /^picture resized$/);
    assert.match(rows[0]!.location, /^paragraph \d+$/);
  });
  it("two pictures swapped in one paragraph is 'picture moved'", async () => {
    const rows = rowsOf(await read(await fixture("w16-before"), await fixture("w16-after")));
    assert.deepEqual(brief(rows), ["paragraph 3 | paragraph changed", "paragraph 4 | picture moved"]);
    assert.equal(rows[1]!.text, "picture moved: within the paragraph");
  });
});

describe("list markers that moved", () => {
  /** m1's three-item list made a numbered one, the way a Word list of decimal items is stored. */
  const numbered = (xml: string): string => xml.replace(/(<w:abstractNum w:abstractNumId="2"[\s\S]*?)<w:numFmt w:val="bullet"\/>/, '$1<w:numFmt w:val="decimal"/>');
  const dropFirstItem = (xml: string): string => xml.replace(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:numId w:val="2"\/>[\s\S]*?<\/w:p>/, "");
  it("a removed list item says what the markers below it became, and no row of its own", async () => {
    const before = await edited("m1-list", "word/numbering.xml", numbered);
    const files = unzipSync(before);
    files["word/document.xml"] = strToU8(dropFirstItem(Buffer.from(files["word/document.xml"]!).toString("utf8")));
    const after = Buffer.from(zipSync(files, { mtime: new Date(2020, 0, 1) }));
    const rows = rowsOf(await read(before, after));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "paragraph removed");
    assert.match(rows[0]!.text, /Items below renumbered 2 to 1, 3 to 2$/);
  });
  it("markers that moved with no added or removed item behind them are named on a formatting row, never dropped", async () => {
    const before = await edited("m1-list", "word/numbering.xml", numbered);
    const after = await edited("m1-list", "word/numbering.xml", (x) => numbered(x).replace(/(<w:num w:numId="2">[\s\S]*?<w:startOverride w:val=")1"/, '$15"'));
    const rows = rowsOf(await read(before, after));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "paragraph formatting changed");
    assert.match(rows[0]!.text, /list renumbered 1 to 5, 2 to 6, 3 to 7/i);
  });
});

describe("a change never disappears from the rows", () => {
  it("every pair of the Word fixtures whose bytes differ has at least one row, and every paragraph of the old rows is still counted", async () => {
    const names = (await readdir(path.join(import.meta.dirname, "fixtures"))).filter((n) => /^word-conditional-format-.*\.docx$/.test(n));
    const layer = createFilesLayer();
    const units = (rows: Array<{ location: string; kind: string }>): number => rows.reduce((n, r) => {
      const m = /^paragraphs (\d+)-(\d+)$/.exec(r.location);
      return n + (m ? Number(m[2]) - Number(m[1]) + 1 : /^paragraph (changed|added|removed)$/.test(r.kind) ? 1 : 0);
    }, 0);
    let pairs = 0;
    for (const a of names) {
      for (const b of names) {
        if (a === b) continue;
        const [x, y] = [path.join(import.meta.dirname, "fixtures", a), path.join(import.meta.dirname, "fixtures", b)];
        const rows = await layer.diff(x, y);
        if (Buffer.compare(await readFile(x), await readFile(y)) === 0) continue;
        pairs++;
        assert.ok(rows.length > 0, `${a} > ${b} lost every row`);
        // every paragraph the plain text alignment reports is still in a row (a run counts its paragraphs)
        const plain = alignSequences(readDocxParagraphs(await readFile(x)), readDocxParagraphs(await readFile(y))).length;
        assert.equal(units(rows), plain, `${a} > ${b}`);
      }
    }
    assert.ok(pairs >= 20, `only ${pairs} pairs`);
  });
});
