import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { makePdf } from "./fixtures/make-pdf.ts";
import { pdfHelperForTest } from "../scripts/lib/pdf-helper-cache.ts";
import { couldNotOpen, readPdf, readState, type Side } from "../src/timeline/broken.ts";
import { unopenedOfState } from "../src/timeline/load.ts";
import { changeNote } from "../src/timeline/notes.ts";
import { storeDirOf } from "../src/states.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { viewPdfs } from "../src/timeline/render/pdf.ts";
import type { Timeline } from "../src/timeline/timeline.ts";
import type { ChangeInfo, View } from "../src/timeline/render/types.ts";

// "Nothing is hidden": CoCheck states what it observed and never judges a file. A: the call failed (hook record). B: the reader that
// draws the file's view could not open those bytes. Note and view come from one read result. No judgment word is ever on the page.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const RELS = (target: string): string => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;
function book(value: number): Buffer {
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": enc(RELS("xl/workbook.xml")),
    "xl/workbook.xml": enc(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": enc(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Rate</t></is></c><c r="B1"><v>${value}</v></c></row></sheetData></worksheet>`),
  };
  return Buffer.from(zipSync(files, { mtime: new Date(2020, 0, 1) }));
}
const good = book(1);
const goodToo = book(2);
const half = good.subarray(0, 40);
const noPart = Buffer.from(zipSync({ "docProps/core.xml": enc("<x/>") }));
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600, 7)]);
const withRels = (rels: string | null): Buffer => {
  const files: Record<string, Uint8Array> = { ...(zipFiles(good)) };
  if (rels === null) delete files["_rels/.rels"];
  else files["_rels/.rels"] = enc(rels);
  return Buffer.from(zipSync(files));
};
import { unzipSync } from "fflate";
const zipFiles = (b: Buffer): Record<string, Uint8Array> => unzipSync(b);
const BANNED = /\b(broken|damaged|corrupt\w*|invalid|half-written)\b/i;
const info = (file: string, extra: Partial<ChangeInfo> = {}): ChangeInfo => ({ id: "c7", file, kind: "modified", ...extra });
const FILE = "fred_macro.xlsx";
const xlsxCorpus: Array<[string, Buffer]> = [
  ["good", good], ["goodToo", goodToo], ["half", half], ["noPart", noPart], ["empty", Buffer.alloc(0)], ["password-protected", OLE],
  ["single-quoted rels", withRels(RELS("xl/workbook.xml").replaceAll('"', "'"))],
  ["prefixed rels", withRels(RELS("xl/workbook.xml").replaceAll("<Relationship", "<r:Relationship").replace("<Relationships", "<r:Relationships").replace("</Relationships", "</r:Relationships"))],
  ["./ rels", withRels(RELS("./xl/workbook.xml"))], ["xl/100%.xml target", withRels(RELS("xl/100%.xml"))], ["no _rels/.rels", withRels(null)],
];
const mentions = (v: View, file: string, side: Side): boolean => v.caveats.some((c) => c.startsWith(`CoCheck could not open the ${side === "before" ? "previous" : side} version of ${file} (`));

describe("the note names exactly the sides the reader could not open", () => {
  // core has no workbook reader, so no workbook is named unopenable by core, broken or not; the connector's own
  // preflight answers a file Excel can't open. The note rule itself (named sides only) stays pinned by the PDF cases below.
  for (const [bn, b] of xlsxCorpus) {
    it(`xlsx ${bn}: core makes no claim`, async () => {
      assert.ok("silent" in (await readState(FILE, b)), bn);
    });
  }
  it("the corpus loads: no reader throws on any of it", async () => {
    for (const [, bytes] of xlsxCorpus) await readState(FILE, bytes);
  });
});

describe("(1) PDF: note and view agree", () => {
  const mac = process.platform === "darwin";
  const pdf = makePdf([["Alpha line", "Bravo line"], ["Charlie line"]]);
  const states: Array<[string, Buffer]> = [
    ["whole", pdf], ["cut", pdf.subarray(0, Math.floor(pdf.length / 2))], ["trailing bytes", Buffer.concat([pdf, Buffer.alloc(5000, 0x0a)])],
    ["prefix", Buffer.concat([Buffer.alloc(2000, 0x41), pdf])], ["locked", readFileSync(new URL("./fixtures/locked.pdf", import.meta.url))],
  ];
  before(() => {
    if (mac) process.env.COCHECK_PDF_HELPER = pdfHelperForTest() ?? undefined;
  });
  after(() => {
    delete process.env.COCHECK_PDF_HELPER;
  });
  for (const [bn, b] of states) {
    for (const [an, a] of states) {
      it(`pdf ${bn} -> ${an}`, { skip: !mac && "needs macOS" }, async () => {
        const v = await viewPdfs(b, a, info("a.pdf"));
        for (const [side, bytes] of [["before", b], ["after", a]] as const) {
          const r = await readPdf(bytes);
          assert.equal(mentions(v, "a.pdf", side), "failed" in r, `${side}: ${v.caveats.join("|")}`);
        }
        assert.ok(!BANNED.test(JSON.stringify(v)), JSON.stringify(v.caveats));
      });
    }
  }
  it("the locked PDF carries the reason locked, inside the sentence", { skip: !mac && "needs macOS" }, async () => {
    const r = await readPdf(states[4]![1]);
    assert.deepEqual(r, { failed: "it is locked with a password" });
  });
});

describe("no reader, no claim", () => {
  it("an unknown extension, a text file and a missing reader say nothing", async () => {
    assert.deepEqual(await readState("a.bin", Buffer.from("junk")), { silent: true });
    assert.deepEqual(await readState("a.csv", Buffer.from("x")), { silent: true });
  });
  it("a PDF with the helper missing says nothing", async () => {
    const prev = process.env.COCHECK_PDF_HELPER;
    process.env.COCHECK_PDF_HELPER = "/nonexistent/helper";
    assert.deepEqual(await readPdf(Buffer.from("junk")), { silent: true });
    if (prev === undefined) delete process.env.COCHECK_PDF_HELPER;
    else process.env.COCHECK_PDF_HELPER = prev;
  });
  it("a text file whose side is not text is not called unopenable", async () => {
    const { textRenderer } = await import("../src/timeline/render/text.ts");
    const v = await textRenderer.view(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x00, 0x81]), Buffer.from("a\nb\n"), info("notes.txt")) as View;
    assert.ok(!v.caveats.some((c) => /could not open/.test(c)));
    assert.ok(v.before.every((p) => !/could not be opened/.test(p.label)));
    assert.ok(v.after.some((p) => p.text));
  });
});

describe("the check never throws or stalls the load", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "q240r3-"));
  const home = path.join(scratch, "home");
  const sha = "a".repeat(64);
  it("a reader that throws a non-ReadError gives no claim and one caveat line", async () => {
    mkdirSync(path.join(home, "tasks", "1", "store"), { recursive: true });
    mkdirSync(storeDirOf(home, 1), { recursive: true });
    writeFileSync(path.join(storeDirOf(home, 1), sha), "x");
    const caveats: string[] = [];
    const why = await unopenedOfState(home, 1, sha, FILE, new Map([[sha, 1]]), caveats, async () => {
      throw new TypeError("boom");
    });
    assert.equal(why, null);
    assert.equal(caveats.length, 1);
    assert.ok(!/boom/.test(caveats[0]!) && !BANNED.test(caveats[0]!));
  });
  it("a state over the view's cap or not in the store makes no claim", async () => {
    assert.equal(await unopenedOfState(home, 1, sha, FILE, new Map(), []), null);
    assert.equal(await unopenedOfState(home, 1, sha, FILE, new Map([[sha, 26 * 1024 * 1024]]), []), null);
  });
});

const facts = { actor: "Claude", file: FILE, change: "modified" as const, secret: false, expired: false, tier: "fingerprint" as const, rows: [] };
describe("notes", () => {
  it("B is appended to the event sentence, never in its place", () => {
    const u = [{ side: "after" as const, why: "x" }];
    assert.equal(changeNote({ ...facts, unopened: u }).text, `Claude changed fred_macro.xlsx (the file changed; CoCheck can't read inside it). ${couldNotOpen(FILE, "after", "x")}`);
    assert.equal(changeNote({ ...facts, change: "created", unopened: u }).text, `Claude created fred_macro.xlsx. ${couldNotOpen(FILE, "after", "x")}`);
    assert.equal(changeNote({ ...facts, change: "deleted", unopened: [{ side: "before", why: "x" }] }).text, `Claude deleted fred_macro.xlsx. ${couldNotOpen(FILE, "before", "x")}`);
  });
  it("no unopened side keeps today's note", () => {
    assert.equal(changeNote({ ...facts, unopened: [] }).text, "Claude changed fred_macro.xlsx (the file changed; CoCheck can't read inside it)");
  });
});

function timeline(outcome: "failed" | "succeeded" | "unknown", unopened: Array<{ side: string; why: string }> = [], file = "a.csv", second?: "failed" | "succeeded"): Timeline {
  const change = (id: string, calls: string[]) => ({ id, file, outside: false, at: 1, kind: "modified", step: 1, before: null, after: null, credit: { calls, joint: calls.length > 1, text: "" }, ledgerN: 1, generic: { unopened }, format: null, note: changeNote({ ...facts, file, unopened: unopened as never }) });
  const call = (id: string, o: string, changes: unknown[]) => ({ id, index: 1, of: 2, host: "claude", tool: "Bash", start: 1, end: 2, outcome: o, closedBy: null, background: false, onTarget: true, agent: null, changes });
  const c1 = change("c1", second ? ["k1", "k2"] : ["k1"]);
  const calls = [call("k1", outcome, [c1]), ...(second ? [call("k2", second, [])] : [])];
  return { task: 1, folder: null, requests: [{ id: "q1", index: 1, session: "s", texts: [{ text: "go" }], at: 0, runs: [{ calls }], wakes: [] }], unplaced: [] } as unknown as Timeline;
}
const changeStop = (t: Timeline) => buildRailModel(t).stops.find((s) => s.change)!.change!;
const B_AFTER = [{ side: "after", why: "the file could not be opened as an Excel workbook" }];

describe("A and B on the rail", () => {
  it("A alone: a failed call over a file that opens", () => {
    const c = changeStop(timeline("failed", [], FILE));
    assert.match(c.failed ?? "", /^The call that changed fred_macro\.xlsx failed, with no error text or exit code\.$/);
    assert.ok(!/could not open/.test(c.note));
  });
  it("B alone: a succeeded call that leaves an unopenable file", () => {
    const c = changeStop(timeline("succeeded", B_AFTER, FILE));
    assert.equal(c.failed, null);
    assert.match(c.note, /CoCheck could not open the after version of fred_macro\.xlsx/);
  });
  it("A+B: one joined sentence", () => {
    const c = changeStop(timeline("failed", B_AFTER, FILE));
    assert.equal(c.note, "The call that changed fred_macro.xlsx failed, and CoCheck could not open the file it left.");
    assert.equal(c.failed, null);
  });
  it("neither: unknown extension, call succeeded or unreported", () => {
    for (const o of ["succeeded", "unknown"] as const) {
      const c = changeStop(timeline(o, [], "a.bin"));
      assert.equal(c.failed, null);
      assert.ok(!/could not open|failed/.test(c.note));
    }
  });
  it("a joint change: none failed is null, some failed carries the shared failure, all failed keeps the A form", () => {
    assert.equal(changeStop(timeline("succeeded", [], FILE, "succeeded")).failed, null);
    assert.equal(changeStop(timeline("failed", [], FILE, "succeeded")).failed, "A call by Claude failed while other calls were open. CoCheck can't tell which of them changed fred_macro.xlsx.");
    assert.match(changeStop(timeline("failed", [], FILE, "failed")).failed ?? "", /^The call that changed fred_macro\.xlsx failed, with no error text or exit code\.$/);
  });
  it("no banned word on any of these", () => {
    for (const t of [timeline("failed", B_AFTER, FILE), timeline("failed", [], FILE), timeline("failed", [], FILE, "succeeded"), timeline("succeeded", B_AFTER, FILE)]) assert.ok(!BANNED.test(JSON.stringify(changeStop(t))));
  });
});

describe("r3b", () => {
  const pkg = (target: string, part: string): Buffer => Buffer.from(zipSync({ "_rels/.rels": enc(RELS(target)), [part]: enc("<x/>") }));
  it("a docx or pptx makes no claim, locked or not: no CoCheck reader draws it, so nothing is named as unopenable", async () => {
    for (const [f, bytes] of [["a.docx", pkg("word/document2.xml", "word/document2.xml")], ["a.docx", pkg("/custom/main.xml", "custom/main.xml")], ["a.pptx", pkg("ppt/custom.xml", "ppt/custom.xml")], ["a.docx", OLE], ["a.pptx", OLE]] as const) {
      assert.deepEqual(await readState(f, bytes), { silent: true }, f);
    }
  });
  it("A uses the change's own verb", () => {
    const { callFailed, callFailedAndUnopenable } = require_broken();
    assert.match(callFailed("d.pdf", "deleted"), /^The call that deleted d\.pdf failed/);
    assert.match(callFailed("d.pdf", "created"), /^The call that created d\.pdf failed/);
    assert.match(callFailedAndUnopenable("d.pdf", "deleted"), /^The call that deleted d\.pdf failed, and/);
  });
  it("a failed call that deleted a file reads deleted on the rail", () => {
    const t = timeline("failed", [], "deck.pdf");
    (t as any).requests[0].runs[0].calls[0].changes[0].kind = "deleted";
    const c = changeStop(t);
    assert.match(c.failed ?? "", /^The call that deleted deck\.pdf failed/);
  });
  it("an empty .xlsx makes no claim in core (its connector answers it)", async () => {
    assert.ok("silent" in (await readState("m.xlsx", Buffer.alloc(0))));
  });
});
import * as brokenMod from "../src/timeline/broken.ts";
const require_broken = () => brokenMod;
