// The look-here rule, the Office order of the Files view, "Open in Word/Excel/PowerPoint", the .xlsm
// exception, the skill names and the page's Office private hints are deleted, not replaced.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { translateTool } from "../src/timeline/describe.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";
import "../src/timeline/rail/assets/view-table.js";

const src = (rel: string): string => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
const VT = (globalThis as unknown as { CoCheckViewTable: { sceneOf(doc: unknown): { before: Array<Record<string, unknown>>; items: Array<{ kind: string | null }> }; noteCard(ch: unknown, own?: boolean): { place: string } } }).CoCheckViewTable;

const ref = (sha: string) => ({ sha256: sha.padEnd(64, "0"), size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const mk = (id: string, file: string, kind: "created" | "modified" | "deleted", before: string | null, after: string, at: number): Change =>
  ({ id, file, outside: false, at, kind, step: 1, before: before === null ? null : ref(before), after: ref(after), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label ${id}` } }) as unknown as Change;
const timelineOf = (changes: Change[]): Timeline => ({ schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
  id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: 1, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
  runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "call", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: "t", source: "agent-description", label: "l" } }] }] }] } as unknown as Timeline);

describe("the look-here rule and the Office order of the Files view are deleted", () => {
  const model = buildRailModel(timelineOf([mk("c1", "book.xlsx", "modified", "a", "b", 1000), mk("c2", "notes.txt", "modified", "a", "b", 2000), mk("c3", "deck.pptx", "created", null, "c", 1500)]));
  it("no stop carries a look mark, an Office file included", () => {
    assert.ok(model.stops.length >= 3);
    assert.ok(model.stops.every((s) => !("look" in s)), JSON.stringify(model.stops.map((s) => s.id)));
  });
  it("the Files order is by last change alone: an Office file is not put ahead of a newer plain file", () => {
    assert.deepEqual(model.files.map((f) => f.file), ["notes.txt", "deck.pptx", "book.xlsx"]);
  });
  it("the page has no look chip and the Files view no Office kind", () => {
    assert.ok(!src("timeline/rail/assets/review.js").includes("LOOK_TEXT"));
    assert.ok(!/xlsx|pptx|docx/.test(src("timeline/rail/assets/files-view.js")), "files-view.js still names an Office kind");
  });
});

describe("Open in Word/Excel/PowerPoint is deleted", () => {
  it("no open-in module, no route, no model field, no page container, no platform opener, no before copies", () => {
    assert.equal(existsSync(new URL("../src/excel/open-in-excel.ts", import.meta.url)), false);
    assert.equal(existsSync(new URL("../src/excel/osascript.ts", import.meta.url)), false);
    assert.ok(!src("review-server.ts").includes("open-excel"), "the route is still there");
    for (const f of ["timeline/rail/model.ts", "timeline/rail/assets/review.js", "timeline/rail/page.ts", "platform/types.ts", "platform/darwin.ts", "platform/win32.ts", "states.ts", "install.ts"]) {
      assert.ok(!/openExcel|openOffice|openxl|excelOpener|officeOpener|before-copies|BeforeCop/.test(src(f)), `${f} still has open-in code`);
    }
    const model = buildRailModel(timelineOf([mk("c1", "book.xlsx", "modified", "a", "b", 1000), mk("c2", "memo.docx", "modified", "a", "b", 2000)]));
    for (const s of model.stops) if (s.change) assert.ok(!("openExcel" in s.change) && !("openOffice" in s.change), s.id);
  });
});

describe("the .xlsm exception, the skill names and the page's Office private hints are deleted", () => {
  it("timeline.ts has no one-ending exception", () => {
    assert.ok(!src("timeline/timeline.ts").includes('".xlsm"'));
  });
  it("a skill is named by its own name, never a product name", () => {
    assert.equal(translateTool("Skill", { skill: "anthropic-skills:xlsx" }), "Loaded xlsx instructions");
    assert.equal(translateTool("Skill", { skill: "cocheck-excel" }), "Loaded cocheck-excel instructions");
  });
  it("a CoCheck-own document's speaker-notes picture is an ordinary pane and a paragraph-card hint is not read; the region hint stays", () => {
    const doc = { spec: "cocheck.changes/1", source: { by: "cocheck", name: "CoCheck", level: 3 }, pictures: [
      { id: "before:s1", side: "before", type: "text", private: { text: [] } },
      { id: "before:s1#notes", side: "before", type: "text", label: "Speaker notes", private: { notes: "hello", of: "before:s1" } },
    ], changes: [{ id: "a", mark: "described", label: "A marked region", private: { kind: "region" } }] };
    const scene = VT.sceneOf(doc);
    assert.ok(scene.before.every((p) => !("notes" in p)), JSON.stringify(scene.before));
    assert.deepEqual(scene.items.map((i) => i.kind), ["region"]);
    assert.equal(VT.noteCard({ id: "p", mark: "changed", label: "Paragraph 3", before: "a", after: "b", private: { kind: "card-paragraph" } }, true).place, "Paragraph 3");
  });
});
