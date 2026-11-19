import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { changedOutsideWording, NO_BEFORE_WORDING, outsideClass, sha256Stream } from "../src/fingerprint.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";
import { signoffStatus } from "../src/signoff.ts";
import { signOffForTest } from "./helpers/signed-fixture.ts";

const ZIP_MTIME = new Date(2020, 0, 1);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const WB = (ptr: string) => `<workbook xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision"><sheets/><xr:revisionPtr documentId="${ptr}" revIDLastSave="1"/></workbook>`;
const CORE = (mod: string) => `<cp:coreProperties><dc:title>T</dc:title><cp:lastModifiedBy>a</cp:lastModifiedBy><dcterms:modified>${mod}</dcterms:modified></cp:coreProperties>`;
function book(o: { ptr?: string; mod?: string; app?: string; sheet?: string }): Uint8Array {
  return zipSync(
    {
      "xl/workbook.xml": strToU8(WB(o.ptr ?? "A")),
      "docProps/core.xml": strToU8(CORE(o.mod ?? "2026-01-01")),
      "docProps/app.xml": strToU8(o.app ?? "<a/>"),
      "xl/worksheets/sheet1.xml": strToU8(o.sheet ?? "<s>1</s>"),
    },
    { mtime: ZIP_MTIME },
  );
}
function deck(o: { props?: string; slide?: string }): Uint8Array {
  return zipSync({ "docProps/core.xml": strToU8(o.props ?? "p"), "ppt/slides/slide1.xml": strToU8(o.slide ?? "s") }, { mtime: ZIP_MTIME });
}

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-fp-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-fp-folder-")));
  const ledger = openLedger(home);
  const tasks = new TaskStore(ledger, home, [createPptxLayer(), createFilesLayer()]);
  return {
    home, folder, ledger, tasks,
    file: (n: string) => path.join(folder, n),
    cleanup: async () => {
      ledger.close();
      await rm(home, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    },
  };
}


async function copiesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name !== "folder.json") out.push(full);
    }
  };
  await walk(dir);
  return out;
}

describe("one identity and one wording for a missing before-side", () => {
  it("the fingerprint CoCheck writes is the plain SHA-256 for every type, so a workbook re-save moves it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-fp-unit-"));
    try {
      const w = path.join(dir, "w.xlsx");
      await writeFile(w, book({}));
      const a = await sha256Stream(w);
      assert.equal(a, createHash("sha256").update(book({})).digest("hex"));
      await writeFile(w, book({ ptr: "B", mod: "2026-09-01" }));
      assert.notEqual(await sha256Stream(w), a);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no file ending changes the class or the wording: every outside change is normal priority and reads the same", () => {
    for (const f of ["/x/d.pptx", "/x/d.PPSX", "/x/w.xlsx", "/x/r.docx", "/x/n.txt", "/x/a.foo"]) {
      assert.equal(outsideClass(f, false), "changed", f);
      assert.equal(outsideClass(f, true), "deleted", f);
    }
    assert.equal(changedOutsideWording(), "changed or saved again; its earlier contents weren't kept");
    assert.equal(changedOutsideWording("changed"), NO_BEFORE_WORDING);
    assert.equal(changedOutsideWording("deleted"), "deleted outside CoCheck; its earlier contents weren't kept");
  });
});

describe("a deck changed outside is a normal row with the one wording", () => {
  /** a.txt touched, b.pptx changed outside: one row. */
  async function lowRow() {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    await writeFile(t.file("b.pptx"), deck({ slide: "one" }));
    const id = await t.tasks.touch("c", t.file("a.txt"));
    await writeFile(t.file("b.pptx"), deck({ slide: "two" }));
    return { t, id };
  }

  it("(a) the row is not low priority and reads the one wording; the final submit still closes the round", async () => {
    const { t, id } = await lowRow();
    const summary = await t.tasks.submit("c", "final", true);
    assert.equal(summary.final, true, "the task closes its round");
    const rows = t.ledger.reviewRowsForTask(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.description, NO_BEFORE_WORDING);
    assert.equal(rows[0]!.detail.lowPriority, undefined);
    await t.cleanup();
  });

  it("(c) still needs a reviewer decision: sign-off refuses while one is undecided", async () => {
    const { t, id } = await lowRow();
    await t.tasks.submit("c", "final", true);
    assert.ok(signoffStatus(t.ledger, id).blockers.length > 0);
    await assert.rejects(() => signOffForTest(t.ledger, id, "Dana"));
    const row = t.ledger.reviewRowsForTask(id)[0]!;
    t.ledger.recordDecision({ rowId: row.id, decision: "approve", note: "", reviewer: "Dana" });
    assert.deepEqual(signoffStatus(t.ledger, id).blockers, []);
    await signOffForTest(t.ledger, id, "Dana");
    await t.cleanup();
  });

  it("a deleted untouched file reads as a deletion and is not low priority; a final submit is no longer held by it", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    await writeFile(t.file("b.pptx"), deck({ slide: "one" }));
    const id = await t.tasks.touch("c", t.file("a.txt"));
    await rm(t.file("b.pptx"));
    assert.equal((await t.tasks.submit("c", "final", true)).final, true);
    const row = t.ledger.reviewRowsForTask(id)[0]!;
    assert.equal(row.description, "deleted outside CoCheck; its earlier contents weren't kept");
    assert.doesNotMatch(row.description, /re-saved/);
    assert.notEqual(row.detail.lowPriority, true);
    await t.cleanup();
  });
});

// a round's copies still leave untouched files as fingerprints (the diff base is not the record). The hook
// adapter's per-step store copies every watched file at the task's start under the scan caps (hook-state.test.ts).
describe("a task's round copies skip untouched files (the hook store copies them)", () => {
  it("a task in a folder with unrelated files leaves no copies of them", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    await writeFile(t.file("b.txt"), "unrelated\n");
    await writeFile(t.file("d.pptx"), deck({}));
    const id = await t.tasks.touch("c", t.file("a.txt"));
    const copies = await copiesUnder(path.join(t.home, "tasks", String(id)));
    assert.equal(copies.length, 1, `only a.txt is copied: ${copies.join(", ")}`);
    assert.match(copies[0]!, /a\.txt$/);
    const b = t.ledger.snapshotsForTask(id).find((s) => s.filePath === t.file("b.txt"))!;
    assert.equal(b.mode, "fingerprint");
    assert.equal(b.snapshotPath, "");
    assert.equal(b.sha256, sha("unrelated\n"));
    await writeFile(t.file("a.txt"), "two\n");
    await t.tasks.submit("c", "edit", false);
    assert.equal((await copiesUnder(path.join(t.home, "tasks", String(id)))).length, 1, "still only a.txt after a round");
    await t.cleanup();
  });

  it("an unchanged fingerprint-only file makes no row; a changed one makes exactly one, unlogged, with the plain wording", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    await writeFile(t.file("b.txt"), "b1\n");
    await writeFile(t.file("c.txt"), "c1\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    await writeFile(t.file("b.txt"), "b2\n");
    const summary = await t.tasks.submit("c", "round", false);
    const rows = t.ledger.reviewRowsForTask(id).filter((r) => r.filePath !== t.file("a.txt"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.filePath, t.file("b.txt"));
    assert.equal(rows[0]!.status, "unlogged");
    assert.match(rows[0]!.description, new RegExp(changedOutsideWording()));
    assert.equal((await copiesUnder(path.join(t.home, "tasks", String(id)))).length, 1);
    assert.ok(summary);
    // the next round does not repeat the row
    await t.tasks.submit("c", "again", false);
    assert.equal(t.ledger.reviewRowsForTask(id).filter((r) => r.filePath === t.file("b.txt")).length, 1);
    await t.cleanup();
  });

  it("first touch mid-task takes the baseline copy then; a change before the touch is one fingerprint-only row", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    await writeFile(t.file("b.txt"), "b1\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    await writeFile(t.file("b.txt"), "b2\n");
    await t.tasks.touch("c", t.file("b.txt"));
    const bCopies = (await copiesUnder(path.join(t.home, "tasks", String(id)))).filter((f) => /b\.txt$/.test(f));
    assert.equal(bCopies.length, 1, "baseline copy taken at the touch");
    await writeFile(t.file("b.txt"), "b3\n");
    await t.tasks.submit("c", "round", false);
    const rows = t.ledger.reviewRowsForTask(id).filter((r) => r.filePath === t.file("b.txt"));
    assert.ok(rows.some((r) => r.description === NO_BEFORE_WORDING), "fingerprint-only row for the change before the touch");
    assert.equal(rows.filter((r) => r.description === NO_BEFORE_WORDING).length, 1);
    assert.equal(rows.length, 1, "the later edit makes no row of its own, the round no longer diffs");
    await t.cleanup();
  });

  it("an untouched fingerprint-only file with no change before the touch: touch makes no row", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    await writeFile(t.file("b.txt"), "b1\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    await t.tasks.touch("c", t.file("b.txt"));
    await t.tasks.submit("c", "round", false);
    assert.equal(t.ledger.reviewRowsForTask(id).filter((r) => r.filePath === t.file("b.txt")).length, 0);
    await t.cleanup();
  });

  it("when the watch is off, the first call's warning is plain and comes once", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    for (let i = 0; i < 501; i++) await writeFile(t.file(`f${i}.txt`), "x");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    const w = t.tasks.takeWatchWarning(id);
    assert.match(w ?? "", /CoCheck is not watching this folder for changes outside CoCheck/);
    assert.equal(t.tasks.takeWatchWarning(id), undefined);
    await t.cleanup();
  });

  it("the folder caps stay in place: the file-count cap still skips a huge folder", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    for (let i = 0; i < 501; i++) await writeFile(t.file(`f${i}.txt`), "x");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    assert.equal(t.ledger.snapshotsForTask(id).length, 1);
    await t.cleanup();
  });
});



describe("negative controls: one real edit is exactly one row", () => {
  it("one cell edited in an untouched workbook, and one slide's text in an untouched deck", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-fp-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-fp-folder-")));
    const ledger = openLedger(home);
    const tasks = new TaskStore(ledger, home, [createXlsxLayer({ openState: async () => "closed" }), createPptxLayer(), createFilesLayer()]);
    const f = (n: string) => path.join(folder, n);
    await writeFile(f("a.txt"), "anchor\n");
    await writeFile(f("w.xlsx"), book({}));
    await writeFile(f("d.pptx"), deck({}));
    const id = await tasks.touch("c", f("a.txt"));
    await writeFile(f("w.xlsx"), book({ sheet: "<s>2</s>" }));
    await writeFile(f("d.pptx"), deck({ slide: "edited slide text" }));
    await tasks.submit("c", "round", false);
    const rows = ledger.reviewRowsForTask(id);
    assert.deepEqual(rows.map((r) => path.basename(r.filePath)).sort(), ["d.pptx", "w.xlsx"]);
    const by = new Map(rows.map((r) => [path.basename(r.filePath), r]));
    assert.equal(by.get("w.xlsx")!.description, changedOutsideWording("changed"));
    assert.equal(by.get("w.xlsx")!.detail.lowPriority, undefined);
    assert.equal(by.get("d.pptx")!.description, changedOutsideWording("changed"));
    assert.equal(by.get("d.pptx")!.detail.lowPriority, undefined);
    ledger.close();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
});
