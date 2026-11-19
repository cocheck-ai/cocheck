// the end-state scan. Core names no Office format: every source file under src/ (ts, js, css, html; the rail assets
// included), outside src/office/connector/, is scanned for the Office endings (.xls[xm], .ppt[xms], .pps[xm], .doc[xm]), the words Excel, Word,
// PowerPoint, workbook, worksheet, slide, and the package paths xl/, ppt/, word/, docProps/. A hit is allowed only in a file on the list below, which
// approved, each with its reason, its deletion condition and the most lines it may hit. The test fails on a hit in an unlisted
// file, on a listed file over its count, and on a listed file with no hit left (a stale entry): the list only shrinks.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
export const RULES: RegExp[] = [
  /\.xls[xm]\b|\.ppt[xms]\b|\.pps[xm]\b|\.doc[xm]\b/,
  /\b(?:Excel|Word|PowerPoint)\b/,
  /\b(?:workbooks?|worksheets?|slides?)\b/i,
  /(?<![\w.-])(?:xl|ppt|word|docProps)\//,
  // The bare format word, with or without a dot, so an alternation `\.(pptx|docx)$` and a quoted "xlsx" count (review-server wrote its endings that way).
  /\b(?:xlsx|xlsm|pptx|pptm|ppsx|ppsm|docx|docm)\b/i,
  // the format stems as substrings, so a character class (`/\.xls[xm]$/`, `/\.pp[ts][xm]$/`), an identifier (`pptxSlides`,
  // `isPptx`), a path segment (`.pptx_build/`) and xlsb count. A lowercase stem must not follow a letter ("apps", "document" stay quiet); a
  // capitalised one is a camel-case word boundary and always counts.
  /(?<![A-Za-z])(?:xls|ppt|pps|docx|docm)|(?:Xls|XLS|Ppt|PPT|Pps|PPS|Docx|DOCX|Docm|DOCM)|xls\[|pp\[ts\]|doc\[[xm]/,
];

/** The approved list: file, the most lines it may hit, why it may, and when the entry goes. */
const ALLOWED: Record<string, { max: number; reason: string; until: string }> = {
  "src/attribution/write-scope.ts": { max: 19, reason: 'false positive: Word is the shell-word type', until: 'permanent' },
  "src/formats/files/scan.ts": { max: 2, reason: "core's folder scan: isDeckFile and isTrackedFolderFile test the presentation and spreadsheet endings (the connector's presentation layer and the files layer's non-generic mode use them)", until: 'both move under src/office/connector/ with the non-generic files mode' },
  "src/hook-adapter.ts": { max: 28, reason: "hook capture, stage H's to change (H1-H6)", until: 'the format code is removed' },
  "src/install.ts": { max: 1, reason: 'platform capability line ("Live Excel: not available")', until: 'revisited with the docs' },
  "src/ledger.ts": { max: 1, reason: 'SQL schema comment (xlsx: "Sheet1!B3") inside the schema string, left unedited so the schema text stays byte-stable', until: 'a schema bump rewords it' },
  "src/secret-rules.generated.ts": { max: 2, reason: 'false positives: "slide" in a generated secret-rule word list, and a JWT rule whose named group is the header field "ppt"', until: 'permanent' },
  "src/tasks.ts": { max: 5, reason: "review tables that still name formats", until: 'the format code is removed' },
  "src/timeline/read-signal.ts": { max: 2, reason: 'attribution signals (to_excel, load_workbook, osascript words)', until: 'permanent while those signals are read' },
  "src/timeline/render/pdf.ts": { max: 3, reason: "PDF caveat names a deck's hidden slides", until: 'PDF stays in core until after launch' },
};

/** Lines that hit, per file, in `text`. */
export const hitsIn = (text: string): number => text.split("\n").filter((l) => RULES.some((r) => r.test(l))).length;

function scan(): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|js|css|html)$/.test(e.name)) {
        const rel = path.relative(ROOT, full).split(path.sep).join("/");
        if (rel.startsWith("src/office/connector/")) continue;
        const n = hitsIn(readFileSync(full, "utf8"));
        if (n > 0) out.set(rel, n);
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return out;
}

describe("the end-state scan finds only the approved list", () => {
  const found = scan();
  it("no hit in a file off the list", () => {
    assert.deepEqual([...found.keys()].filter((f) => !(f in ALLOWED)), []);
  });
  it("no listed file over its count", () => {
    assert.deepEqual([...found].filter(([f, n]) => f in ALLOWED && n > ALLOWED[f]!.max).map(([f, n]) => `${f}: ${n} > ${ALLOWED[f]!.max}`), []);
  });
  it("no stale entry: every listed file still hits (the list only shrinks)", () => {
    assert.deepEqual(Object.keys(ALLOWED).filter((f) => !found.has(f)), []);
  });
  it("the rules find what they name and skip what they do not (the scan cannot pass empty)", () => {
    for (const t of ['"Book.xlsm"', "open in Excel", "the workbook", "Slides", "xl/workbook.xml", "docProps/core.xml", ".docx"]) assert.equal(hitsIn(t), 1, t);
    for (const t of ["/\\.(pptx|docx|xlsx|xlsm|pdf)$/i", '"xlsx"', "kind: 'pptm'", "xlsx"]) assert.equal(hitsIn(t), 1, t);
    // the stem rule counts these three, which left quiet (a legacy .xls name, a library name, a stem inside an identifier)
    for (const t of ["notes.xls", "xlsxwriter", "my_docx_x"]) assert.equal(hitsIn(t), 1, t);
    for (const t of ["/\\.xls[xm]$/i.test(f)", "/\\.pp[ts][xm]$/i", "const pptxSlides = 1;", "isPptx(f)", "XLSX_RE", "a/.pptx_build/b", "book.xlsb", "/\\.doc[xm]$/"]) assert.equal(hitsIn(t), 1, t);
    for (const t of ["role: 'slider'", "keyword/x", "Wordy", "a.doc", "Apps and runtimes", "the document", "happy apps", "Docs"]) assert.equal(hitsIn(t), 0, t);
  });
});
