import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants, crc32, deflateRawSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";

// Fixed so two builds of the same workbook are byte-identical; fflate stamps the current time (2 s granularity) otherwise.
const ZIP_MTIME = new Date(2020, 0, 1);

const layer = createXlsxLayer({ openState: async () => "closed" });
const LAYER_URL = new URL("../src/office/connector/xlsx/layer.ts", import.meta.url).href;

const WORKBOOK_XML = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WORKBOOK_RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const SHEET = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;

function book(docProps: Record<string, string>): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    "xl/workbook.xml": strToU8(WORKBOOK_XML),
    "xl/_rels/workbook.xml.rels": strToU8(WORKBOOK_RELS),
    "xl/worksheets/sheet1.xml": strToU8(SHEET),
  };
  for (const [name, text] of Object.entries(docProps)) {
    parts[name] = strToU8(text);
  }
  return zipSync(parts, { mtime: ZIP_MTIME });
}

async function diffPair(a: Uint8Array, b: Uint8Array) {
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-noise-"));
  try {
    await writeFile(path.join(dir, "a.xlsx"), a);
    await writeFile(path.join(dir, "b.xlsx"), b);
    return await layer.diff(path.join(dir, "a.xlsx"), path.join(dir, "b.xlsx"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("xlsx layer: what counts as re-save noise", () => {
  for (const part of ["docProps/app.xml", "docProps/thumbnail.jpeg", "docProps/thumbnail.png"]) {
    it(`a change confined to ${part} is no row`, async () => {
      assert.deepEqual(await diffPair(book({ [part]: "<a>1</a>" }), book({ [part]: "<a>2</a>" })), []);
    });
  }

  const core = (o: { modified?: string; by?: string; revision?: string; title?: string; creator?: string; subject?: string; keywords?: string }) => ({
    "docProps/core.xml": `<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t" xmlns:xsi="x"><dc:title>${o.title ?? "T"}</dc:title><dc:subject>${o.subject ?? "S"}</dc:subject><dc:creator>${o.creator ?? "Ann"}</dc:creator><cp:keywords>${o.keywords ?? "K"}</cp:keywords><cp:lastModifiedBy>${o.by ?? "Ann"}</cp:lastModifiedBy><cp:revision>${o.revision ?? "1"}</cp:revision><dcterms:modified xsi:type="dcterms:W3CDTF">${o.modified ?? "2026-01-01T00:00:00Z"}</dcterms:modified></cp:coreProperties>`,
  });

  it("core.xml moving its save time, last author and revision is no row", async () => {
    const rows = await diffPair(book(core({})), book(core({ modified: "2026-09-29T10:00:00Z", by: "Bob", revision: "7" })));
    assert.deepEqual(rows, []);
  });

  for (const [field, change] of [["title", { title: "T2" }], ["author", { creator: "Zed" }], ["subject", { subject: "S2" }], ["keywords", { keywords: "K2" }]] as const) {
    it(`a changed ${field} in core.xml is a 'file changed' row`, async () => {
      const rows = await diffPair(book(core({})), book(core({ ...change, modified: "2026-09-29T10:00:00Z" })));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.kind, "file changed");
    });
  }

  it("core.xml added or removed is a row", async () => {
    const rows = await diffPair(book(core({})), book({}));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "file changed");
  });

  it("a change confined to docProps/custom.xml is a 'file changed' row", async () => {
    const custom = (label: string) => ({ "docProps/custom.xml": `<Properties><property name="Sensitivity"><P>${label}</P></property></Properties>` });
    const rows = await diffPair(book(custom("secret-label-A")), book(custom("secret-label-B")));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "file changed");
  });

  it("custom.xml added or removed is a row, while app.xml moving alongside stays quiet", async () => {
    const rows = await diffPair(book({ "docProps/app.xml": "<a>1</a>" }), book({ "docProps/app.xml": "<a>2</a>", "docProps/custom.xml": "<P>x</P>" }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "file changed");
  });
});


interface RawPart {
  name: string;
  text?: string;
  /** A part of this many real zero bytes (a multiple of 1 MiB), deflated block by block so the test never holds it. */
  zeros?: number;
  /** What the headers claim as the unzipped size, when they should lie. */
  declaredSize?: number;
  /** What the headers claim as the CRC, when they should lie. */
  declaredCrc?: number;
}

const MIB = 1 << 20;

/** Deflate stream of `blocks` MiB of zeros: sync-flushed independent blocks, then an empty final block. */
function deflatedZeros(blocks: number): { data: Buffer; crc: number } {
  const zeros = Buffer.alloc(MIB);
  const one = deflateRawSync(zeros, { level: 9, finishFlush: constants.Z_SYNC_FLUSH });
  let crc = 0;
  for (let i = 0; i < blocks; i++) {
    crc = crc32(zeros, crc);
  }
  return { data: Buffer.concat([...Array.from({ length: blocks }, () => one), Buffer.from([0x03, 0x00])]), crc };
}

/** A zip written by hand so a part can be hundreds of MB of real deflated zeros without the test holding them. */
function rawZip(parts: RawPart[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    let data: Buffer;
    let size: number;
    let crc: number;
    if (part.zeros !== undefined) {
      ({ data, crc } = deflatedZeros(part.zeros / MIB));
      size = part.zeros;
    } else {
      const raw = Buffer.from(part.text ?? "");
      data = deflateRawSync(raw);
      size = raw.length;
      crc = crc32(raw);
    }
    const declared = part.declaredSize ?? size;
    const declaredCrc = part.declaredCrc ?? crc;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(declaredCrc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(declaredCrc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(declared, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    chunks.push(local, name, data);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

const BASE_PARTS: RawPart[] = [
  { name: "xl/workbook.xml", text: WORKBOOK_XML },
  { name: "xl/_rels/workbook.xml.rels", text: WORKBOOK_RELS },
];

const RSS_LIMIT_MB = 250;
const BOMB_MB = 300;

/** Diffs the pair in a child process (a fresh heap and a clean RSS high-water mark) with the heap capped. */
function diffInChild(a: Uint8Array, b: Uint8Array): { kinds: string[]; maxRssMb: number } {
  const script = `
    import { readFileSync } from "node:fs";
    import { createXlsxLayer } from ${JSON.stringify(LAYER_URL)};
    const layer = createXlsxLayer({ openState: async () => "closed" });
    const rows = await layer.diff(process.env.A, process.env.B);
    // resourceUsage().maxRSS is in kilobytes on every platform (libuv normalizes macOS).
    console.log(JSON.stringify({ kinds: rows.map((r) => r.kind), maxRssMb: process.resourceUsage().maxRSS / 1024 }));
  `;
  const dir = mkdtempSync(path.join(tmpdir(), "cocheck-noise-rss-"));
  try {
    writeFileSync(path.join(dir, "a.xlsx"), a);
    writeFileSync(path.join(dir, "b.xlsx"), b);
    const child = spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, A: path.join(dir, "a.xlsx"), B: path.join(dir, "b.xlsx") },
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split("\n").pop()!) as { kinds: string[]; maxRssMb: number };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("xlsx layer: the noise check's memory", () => {
  const core = (n: number) => ({ name: "docProps/core.xml", text: `<cp:coreProperties xmlns:cp="c" xmlns:dcterms="t"><cp:revision>${n}</cp:revision></cp:coreProperties>` });
  const sheet = (extra: Partial<RawPart>): RawPart => ({ name: "xl/worksheets/sheet1.xml", zeros: BOMB_MB * MIB, ...extra });

  it(`a docProps-only pair holding a real ${BOMB_MB} MB sheet part stays under ${RSS_LIMIT_MB} MB RSS and reads as too large`, () => {
    const result = diffInChild(rawZip([...BASE_PARTS, sheet({}), core(1)]), rawZip([...BASE_PARTS, sheet({}), core(2)]));
    assert.deepEqual(result.kinds, ["too large"]);
    assert.ok(result.maxRssMb < RSS_LIMIT_MB, `max RSS ${result.maxRssMb.toFixed(0)} MB, want under ${RSS_LIMIT_MB} MB`);
  });

  it(`sheet parts that declare 1 MB each but inflate to ${BOMB_MB} MB and ${BOMB_MB - 100} MB are never noise and stay under ${RSS_LIMIT_MB} MB RSS`, () => {
    const lie = { declaredSize: MIB, declaredCrc: 0x12345678 };
    const result = diffInChild(
      rawZip([...BASE_PARTS, sheet(lie), core(1)]),
      rawZip([...BASE_PARTS, sheet({ ...lie, zeros: (BOMB_MB - 100) * MIB }), core(2)]),
    );
    assert.deepEqual(result.kinds, ["file changed"]);
    assert.ok(result.maxRssMb < RSS_LIMIT_MB, `max RSS ${result.maxRssMb.toFixed(0)} MB, want under ${RSS_LIMIT_MB} MB`);
  });
});

describe("xlsx layer: the noise check compares CRCs", () => {
  it("parts whose headers claim the same CRC and size but whose bytes differ are not noise", async () => {
    const theme = (text: string, declaredCrc?: number) => ({ name: "xl/theme/theme1.xml", text, declaredCrc });
    const a = rawZip([...BASE_PARTS, theme("<a>1</a>"), { name: "docProps/app.xml", text: "<x>1</x>" }]);
    const b = rawZip([...BASE_PARTS, theme("<a>2</a>", crc32(Buffer.from("<a>1</a>"))), { name: "docProps/app.xml", text: "<x>2</x>" }]);
    const rows = await diffPair(a, b);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "file changed");
  });

  it("the same package re-saved with different compression and moved docProps is still no row", async () => {
    const parts = (compress: boolean) =>
      book({ "docProps/app.xml": compress ? "<x>1</x>" : "<x>2</x>" });
    assert.deepEqual(await diffPair(parts(true), parts(false)), []);
  });
});
