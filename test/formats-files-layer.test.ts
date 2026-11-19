import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { createFilesLayer } from "../src/office/connector/docx/layer.ts";
import { parseCsv } from "../src/formats/files/csv.ts";

// Fixed so two builds of the same workbook are byte-identical; fflate stamps the current time (2 s granularity) otherwise.
const ZIP_MTIME = new Date(2020, 0, 1);

const layer = createFilesLayer();
let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cocheck-files-layer-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(name: string, content: string | Uint8Array): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, content);
  return p;
}

function docx(paragraphs: string[]): Uint8Array {
  // Split each paragraph into two runs so the test proves runs are concatenated.
  const body = paragraphs
    .map((t) => {
      const mid = Math.floor(t.length / 2);
      const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      return `<w:p><w:pPr/><w:r><w:t xml:space="preserve">${esc(t.slice(0, mid))}</w:t></w:r><w:r><w:t xml:space="preserve">${esc(t.slice(mid))}</w:t></w:r></w:p>`;
    })
    .join("");
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return zipSync({ "word/document.xml": strToU8(xml), "[Content_Types].xml": strToU8("<Types/>") }, { mtime: ZIP_MTIME });
}

async function diffOf(name: string, before: string | Uint8Array, afterContent: string | Uint8Array) {
  const a = await put(`a-${name}`, before);
  const b = await put(`b-${name}`, afterContent);
  return layer.diff(a, b);
}

describe("files layer", () => {
  it("accepts everything but xlsx and lock/temp/export files", () => {
    assert.equal(layer.accepts("/x/notes.txt"), true);
    assert.equal(layer.accepts("/x/photo.png"), true);
    assert.equal(layer.accepts("/x/book.xlsx"), false);
    assert.equal(layer.accepts("/x/~$book.docx"), false);
    assert.equal(layer.accepts("/x/.DS_Store"), false);
    assert.equal(layer.accepts("/x/task.cocheck-review.html"), false);
  });

  it("docx: an edited paragraph is one row with the runs joined", async () => {
    const rows = await diffOf("d.docx", docx(["Intro", "Total is 100 dollars", "End"]), docx(["Intro", "Total is 105 dollars", "End"]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.location, "paragraph 2");
    assert.equal(layer.describe(rows[0]!), "paragraph 2: 'Total is 100 dollars' -> 'Total is 105 dollars'");
  });

  it("csv: a changed cell reads as row and header column", async () => {
    const rows = await diffOf("c.csv", "Item,Price\nApple,1\nPear,2\n", "Item,Price\nApple,1\nPear,3\n");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.location, "row 3, column Price");
    assert.equal(layer.describe(rows[0]!), "row 3, column Price: '2' -> '3'");
  });

  it("csv: quoted commas, embedded newlines and CRLF parse as single fields", () => {
    assert.deepEqual(parseCsv('a,"b,c","d\ne"\r\n1,2,3\r\n'), [["a", "b,c", "d\ne"], ["1", "2", "3"]]);
    assert.deepEqual(parseCsv('"say ""hi""",x'), [['say "hi"', "x"]]);
  });

  it("csv: added and removed rows", async () => {
    const rows = await diffOf("c2.csv", "Item,Price\nApple,1\nPear,2\n", "Item,Price\nApple,1\nFig,9\nPear,2\n");
    assert.deepEqual(rows.map((r) => r.kind), ["row added"]);
    assert.equal(rows[0]!.location, "row 3");
  });

  it("text: line-level change, add and remove with plain descriptions", async () => {
    const rows = await diffOf("t.md", "one\ntwo\nthree\nfour\n", "one\nTWO\nthree\n");
    assert.deepEqual(rows.map((r) => layer.describe(r)), ["line 2: 'two' -> 'TWO'", "line 4 removed: 'four'"]);
  });

  it("text: CRLF versus LF alone is not a change per line, only one line-endings row", async () => {
    assert.deepEqual((await diffOf("t2.txt", "a\r\nb\r\n", "a\nb\n")).map((r) => r.kind), ["line endings changed"]);
  });

  it("new file, deleted file and other extensions", async () => {
    const f = await put("new.txt", "hello");
    const created = await layer.diff(null, f);
    assert.equal(layer.describe(created[0]!), "new file (5 bytes)");
    assert.equal(layer.describe((await layer.diff(f, null))[0]!), "file deleted");
    // A real PNG header holds NUL bytes, so it is binary by content (bytes 1,2,3 alone are valid UTF-8 and would read as text).
    const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
    const bin = await diffOf("p.png", new Uint8Array([...head, 1]), new Uint8Array([...head, 2]));
    assert.equal(bin[0]!.kind, "binary file changed");
  });

  it("explains is false: no op records cells of these formats", async () => {
    const [r] = await diffOf("e.txt", "a", "b");
    assert.equal(layer.explains({ opId: 1, tool: "Bash", args: {}, intent: "", client: null }, "/x/e.txt", r!), false);
  });

  it("restate re-reads a location from a snapshot; touches is false", async () => {
    const [r] = await diffOf("r.csv", "Item,Price\nApple,1\n", "Item,Price\nApple,2\n");
    const later = await put("r-later.csv", "Item,Price\nApple,9\n");
    assert.equal((await layer.restate(later, r!)).after, "9");
    assert.equal((await layer.restate(null, r!)).after, null);
    assert.equal(layer.touches({ opId: 1, tool: "t", args: {}, intent: "", client: null }, "/x/r.csv", r!), false);
  });
});

describe("files layer: every byte-level change yields a row", () => {
  const latin1 = (t: string) => Buffer.from(t, "latin1");

  it("rejects leftover lock and temp files", () => {
    assert.equal(layer.accepts("/x/.~lock.a.docx#"), false);
    assert.equal(layer.accepts("/x/~WRL0001.tmp"), false);
    assert.equal(layer.accepts("/x/._notes.txt"), false);
  });

  it("text: a Latin-1 accent swap reads as a line change, marked non-UTF-8", async () => {
    const rows = await diffOf("l1.txt", latin1("caf\xe9\n"), latin1("caf\xe8\n"));
    assert.equal(rows.length, 1);
    assert.equal(layer.describe(rows[0]!), "line 1: 'caf\xe9' -> 'caf\xe8' (not UTF-8; read as Latin-1)");
  });

  it("csv: a Latin-1 accent swap reads as a cell change", async () => {
    const rows = await diffOf("l1.csv", latin1("Name,City\nAna,caf\xe9\n"), latin1("Name,City\nAna,caf\xe8\n"));
    assert.equal(rows.length, 1);
    assert.equal(layer.describe(rows[0]!), "row 2, column City: 'caf\xe9' -> 'caf\xe8' (not UTF-8; read as Latin-1)");
  });

  it("text: CRLF to LF is a line-endings row", async () => {
    const rows = await diffOf("eol.txt", "a\r\nb\r\n", "a\nb\n");
    assert.deepEqual(rows.map((r) => layer.describe(r)), ["line endings changed: CRLF -> LF"]);
  });

  it("text: a removed trailing newline is a row", async () => {
    const rows = await diffOf("nl.txt", "a\nb\n", "a\nb");
    assert.deepEqual(rows.map((r) => layer.describe(r)), ["final newline removed"]);
  });

  it("text: an added BOM is a row", async () => {
    const rows = await diffOf("bom.md", "a\n", "\ufeffa\n");
    assert.deepEqual(rows.map((r) => layer.describe(r)), ["byte order mark added"]);
  });

  it("csv: a quoting-only rewrite falls back to a whole-file row", async () => {
    const rows = await diffOf("q.csv", "a,b\n1,2\n", '"a","b"\n"1","2"\n');
    assert.equal(rows.length, 1);
    assert.equal(layer.describe(rows[0]!), "file changed (same readable contents; formatting or encoding differs)");
  });

  it("text: UTF-16 is decoded, not read as UTF-8 garbage", async () => {
    const u16 = (t: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, "utf16le")]);
    const rows = await diffOf("u16.txt", u16("hello\nworld\n"), u16("hello\nWORLD\n"));
    assert.deepEqual(rows.map((r) => layer.describe(r)), ["line 2: 'world' -> 'WORLD'"]);
  });

  it("csv: semicolon-delimited files split into columns", async () => {
    const rows = await diffOf("semi.csv", "Item;Price\nApple;1\n", "Item;Price\nApple;2\n");
    assert.deepEqual(rows.map((r) => layer.describe(r)), ["row 2, column Price: '1' -> '2'"]);
  });

  it("docx: an edit outside the body (header only) still yields a row", async () => {
    const withHeader = (h: string) => {
      const base = docx(["Body"]);
      const files = unzipSync(base);
      files["word/header1.xml"] = strToU8(`<w:hdr><w:p><w:r><w:t>${h}</w:t></w:r></w:p></w:hdr>`);
      return zipSync(files, { mtime: ZIP_MTIME });
    };
    const rows = await diffOf("h.docx", withHeader("Draft"), withHeader("Final"));
    assert.equal(rows.length, 1);
  });
});
