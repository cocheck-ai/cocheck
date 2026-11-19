import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { writeSealed } from "../src/seal.ts";
import { formatChangesOf } from "../src/timeline/load.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { rowNote } from "../src/timeline/notes.ts";
import { storeDirOf } from "../src/states.ts";
import type { RawState } from "../src/timeline/runs.ts";

// a cell that was empty before and is empty after makes no note, no count and no box. (core's cell grammar and labels
// are gone; the generic engine still never claims a clear or quotes a value for an empty-to-empty row, and the reader still drops such rows.) The c7 shape: a pandas append-mode
// resave turned empty-string cells into missing ones, next to two added sheets. Workbooks are built in memory; nothing opens Excel.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const str = (ref: string, t: string): string => `<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;
const num = (ref: string, v: number): string => `<c r="${ref}"><v>${v}</v></c>`;
const row = (r: number, ...cells: string[]): string => `<row r="${r}">${cells.join("")}</row>`;

function workbook(sheets: Array<{ name: string; rows: string }>): Buffer {
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": enc(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = enc(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.rows}</sheetData></worksheet>`); });
  return Buffer.from(zipSync(files, { mtime: new Date(2020, 0, 1) }));
}

const N = 30;
/** Header in row 1; rows 2..N+1 hold a number in A and an empty cell in B (written as an empty string, or left out). */
const inflation = (emptyCells: boolean): string =>
  row(1, str("A1", "date"), str("B1", "CPILFESL")) +
  Array.from({ length: N }, (_, i) => row(i + 2, num(`A${i + 2}`, i + 1), ...(emptyCells ? [str(`B${i + 2}`, "")] : []))).join("");
const extra = row(1, str("A1", "x"));

async function store(from: Buffer, to: Buffer): Promise<{ home: string; s: RawState; stored: Map<string, number>; done: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  await mkdir(storeDirOf(home, 1), { recursive: true });
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const stored = new Map<string, number>();
  for (const b of [from, to]) { await writeSealed(path.join(storeDirOf(home, 1), sha(b)), b); stored.set(sha(b), b.length); }
  const s = { id: 1, step_id: 1, task_id: 1, file_path: "/w/m.xlsx", sha256: sha(to), prev_sha256: sha(from), phase: "post", calls_open_json: null, credited_json: null, size: to.length, kept: "whole", note: null, ts: null } as unknown as RawState;
  return { home, s, stored, done: () => rm(home, { recursive: true, force: true }) };
}
const layers = () => [createXlsxLayer({ openState: async () => "closed" }), createFilesLayer()];

describe("empty to empty makes no note", () => {
  const f = { actor: "Claude", file: "m.xlsx", secret: false, expired: false };
  for (const [b, a] of [["", null], [null, ""], ["", ""], [null, null], ["(empty)", null]] as const) {
    it(`value ${JSON.stringify(b)} to ${JSON.stringify(a)} has no sentence that clears or quotes a value`, () => {
      const t = rowNote(f, { location: "inflation!C2", kind: "value", before: b, after: a, text: "" }).text;
      assert.doesNotMatch(t, /cleared|from|stays/);
    });
  }
});

describe("the recorded run's c7 shape: empty strings resaved as missing, with two sheets added", () => {
  it("a real value change in the same sheet is still noted", async () => {
    const before = workbook([{ name: "inflation", rows: inflation(true) }]);
    const changed = inflation(false).replace(`<c r="A5"><v>4</v></c>`, `<c r="A5"><v>99</v></c>`);
    const after = workbook([{ name: "inflation", rows: changed }]);
    const st = await store(before, after);
    try {
      const out = await formatChangesOf(st.home, 1, st.s, layers(), st.stored, new Set());
      assert.ok("rows" in out);
      assert.equal(out.rows.length, 1);
      assert.deepEqual([out.rows[0]!.before, out.rows[0]!.after], ["4", "99"]);
    } finally { await st.done(); }
  });
});
