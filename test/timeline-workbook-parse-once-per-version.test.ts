import { afterEach, describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { ensureStoreDir } from "../src/states.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { readCount } from "../src/office/connector/xlsx/reader.ts";
import { ParseMemo } from "../src/office/connector/xlsx/memo.ts";

// The review build reads each stored workbook version once. Synthetic workbooks, a real ledger and store in a temp home,
// no server. Each test uses its own tag in the labels so the process-wide diff caches never carry one test's answer into another.

const FOLDER = "/work";
const CLIENT = "claude:/work";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A one-sheet workbook: `Row r` labels in column A and `r + bump` in column B for 20 rows. Version k bumps row k only, so every version differs. */
function book(tag: string, k: number): Uint8Array {
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const rows = Array.from({ length: 20 }, (_, i) => {
    const r = i + 1;
    return `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>${tag} Row ${r}</t></is></c><c r="B${r}"><v>${r === k ? r + 1000 * k : r}</v></c></row>`;
  }).join("");
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Plan" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`),
  }, { mtime: new Date(2020, 0, 1) });
}

/** One file's chain of versions in one task, one step per version (the first creates the file). Returns the input the build made and how many parses it took. */
async function buildChain(versions: Uint8Array[], file = "plan.xlsx"): Promise<{ formats: Awaited<ReturnType<typeof loadTimelineInput>>["formats"]; ids: number[]; reads: number }> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const ledger: Ledger = openLedger(home);
  cleanups.push(async () => {
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const id = ledger.openTask(CLIENT);
  const states = await ensureStoreDir(home, id);
  await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: FOLDER }));
  for (const v of versions) await writeSealed(path.join(states, sha(v)), v);
  versions.forEach((v, i) => {
    ledger.recordStep({
      taskId: id, client: CLIENT, seq: i + 1, phase: "Post", callsOpen: [], credited: ["call-not-in-record"],
      files: [{ filePath: `${FOLDER}/${file}`, sha256: sha(v), prevSha256: i === 0 ? null : sha(versions[i - 1]!), size: v.length, kept: "whole", note: "" }],
    });
  });
  const loaded = loadRows(ledger, id, "t");
  readCount.n = 0;
  const input = await loadTimelineInput(ledger, home, loaded, { build: "t", quickLook: false, render: async () => null });
  return { formats: input.formats, ids: loaded.fileStates.map((s) => s.id), reads: readCount.n };
}

describe("the diff hands back the after side's labels", () => {
  it("a chain of 5 versions: the after side is not read again for labels (14 reads before, 9 after the label fix)", async () => {
    const tag = "q235a";
    const { reads } = await buildChain([1, 2, 3, 4, 5].map((k) => book(tag, k)));
    // One read for the creating step, 2 for each of the 4 changes would be the naive count; the build lowers it to one per version, asserted below.
    assert.ok(reads <= 5, `expected at most 5 reads (one per version), saw ${reads}`);
  });

  it("the hook's own entry, diff(), returns the same rows as diffWithLabels and parses each side once", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-hook-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const [x, y] = [book("q235c", 1), book("q235c", 2)];
    await writeFile(path.join(dir, "x.xlsx"), x);
    await writeFile(path.join(dir, "y.xlsx"), y);
    const layer = createXlsxLayer({ openState: async () => "closed" });
    readCount.n = 0;
    const plain = await layer.diff(path.join(dir, "x.xlsx"), path.join(dir, "y.xlsx"));
    assert.equal(readCount.n, 2);
    const withLabels = await layer.diffWithLabels!(path.join(dir, "x.xlsx"), path.join(dir, "y.xlsx"));
    assert.deepEqual(withLabels.rows, plain);
    assert.ok(plain.length > 0);
    // Without a memo nothing is remembered: a second diff parses both sides again, as the hook always did.
    readCount.n = 0;
    await layer.diff(path.join(dir, "x.xlsx"), path.join(dir, "y.xlsx"));
    assert.equal(readCount.n, 2);
  });
});

describe("a file's chain reads each version once", () => {
  it("a chain of 16 versions parses 16 times, not about 3 per change", async () => {
    const { reads } = await buildChain(Array.from({ length: 16 }, (_, i) => book("q236a", i + 1)));
    assert.ok(reads <= 16, `expected at most 16 reads, saw ${reads}`);
  });

});

describe("ParseMemo", () => {
  it("holds at most max entries, dropping the oldest", () => {
    const m = new ParseMemo(2);
    m.set("a", { ok: true, value: 1 });
    m.set("b", { ok: true, value: 2 });
    m.set("c", { ok: true, value: 3 });
    assert.equal(m.size, 2);
    assert.equal(m.get("a"), undefined);
    assert.deepEqual(m.get("c"), { ok: true, value: 3 });
  });

  it("lets a version go after its last expected read, and never holds one nothing later needs", () => {
    const m = new ParseMemo(4, new Map([["a", 2], ["b", 1]]));
    m.set("a", { ok: true, value: 1 });
    m.set("b", { ok: true, value: 2 });
    assert.equal(m.size, 1, "b has no read after this one, so it is not held");
    m.used("a");
    assert.ok(m.get("a"), "a is still needed once more");
    m.used("a");
    assert.equal(m.size, 0);
  });
});
