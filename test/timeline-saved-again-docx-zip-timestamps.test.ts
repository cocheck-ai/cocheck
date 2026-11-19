import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { createFilesLayer } from "../src/office/connector/docx/layer.ts";
import { partsIdentical } from "../src/office/connector/shared/package-media.ts";
import { workbookClaims } from "./helpers/claims.ts";

// The memo docx v1 and v2 differ only in zip entry timestamps (all 17 parts byte-identical); v2 -> v3 differs in word/styles.xml.
const V1 = "test/fixtures/memo-v1.docx", V2 = "test/fixtures/memo-v2.docx", V3 = "test/fixtures/memo-v3.docx";
// the saved-again note and its look-here exception are the connector's now (office/connector/nothing-changed.ts); core's
// savedAgain and its per-format wording are gone. The reader's answers, the parts check and the step recording stay pinned here.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const book = (sheetTail: string, mtime: Date): Uint8Array =>
  zipSync({ "xl/workbook.xml": enc(`<workbook ${NS}/>`), "xl/worksheets/sheet1.xml": enc(`<worksheet ${NS}><sheetData/>${sheetTail}</worksheet>`) }, { mtime });

describe("an identical rebuild is saved again", () => {
  it("docx v1 -> v2 (same parts, new zip timestamps) gives no rows", async () => {
    assert.notDeepEqual(await readFile(V1), await readFile(V2));
    assert.deepEqual(await createFilesLayer().diff(V1, V2), []);
  });
  it("docx v2 -> v3 (styles.xml differs) keeps its row", async () => {
    const rows = await createFilesLayer().diff(V2, V3);
    assert.equal(rows.length, 1);
    assert.match(String(rows[0]!.detail.note), /body text unchanged; styles differ/);
  });
  it("partsIdentical: same parts with other timestamps yes; one part or one name different no", () => {
    assert.equal(partsIdentical(book("", new Date(2020, 0, 1)), book("", new Date(2021, 5, 5))), true);
    assert.equal(partsIdentical(book("", new Date(2020, 0, 1)), book("<conditionalFormatting sqref=\"A1\"/>", new Date(2020, 0, 1))), false);
    assert.equal(partsIdentical(zipSync({ a: enc("1") }), zipSync({ a: enc("1"), b: enc("2") })), false);
    assert.equal(partsIdentical(enc("not a zip"), enc("not a zip")), false);
  });
  it("partsIdentical refuses a package past the size cap", () => {
    const x = zipSync({ a: enc("1234567890") });
    assert.equal(partsIdentical(x, x, 100), true);
    assert.equal(partsIdentical(x, x, 5), false);
  });
});

// Clause 3: the step is recorded from the file's hash (the hook sweep). The older TaskStore path no longer diffs; the layer cases above pin the empty diff.
const { mkdtemp, realpath, rm, copyFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const path = await import("node:path");
const { openLedger } = await import("../src/ledger.ts");
const { handleHook } = await import("../src/hook-adapter.ts");

describe("the step stays", () => {
  it("hook sweep: a docx rewritten with identical parts still records a step with the new hash", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
    try {
      const memo = path.join(folder, "memo.docx");
      await copyFile(V1, memo);
      const fx = async (name: string, over: Record<string, unknown>) => ({ ...JSON.parse(await readFile(path.join("test/fixtures/hooks", name), "utf8")), cwd: folder, ...over }) as never;
      const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder };
      const cmd = { tool_input: { command: "c1", description: "c1" }, tool_use_id: "c1" };
      await handleHook(await fx("claude-pre-bash.json", cmd), opts);
      await copyFile(V2, memo);
      await handleHook(await fx("claude-post-bash.json", cmd), opts);
      const r = await handleHook(await fx("claude-stop.json", {}), opts);
      const ledger = openLedger(home);
      try {
        const states = ledger.fileStatesForTask(r.summary!.taskId).filter((s) => s.filePath.endsWith("memo.docx"));
        const last = states.at(-1)!;
        assert.notEqual(last.prevSha256, null);
        assert.notEqual(last.sha256, last.prevSha256);
      } finally {
        ledger.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    }
  });
});
