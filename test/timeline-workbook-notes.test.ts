import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { changeNote, noteOf } from "../src/timeline/notes.ts";
import { mediaChanges } from "../src/office/connector/shared/package-media.ts";

// A created workbook's charts come from the reader; replacing an unreadable workbook is one plain line.
// Core has no chart phrases or cell labels: a connector words its own steps.

const base = { actor: "Claude", file: "macro_charts.xlsx", secret: false, expired: false, tier: "fingerprint" as const };

describe("notes", () => {
  it("a created workbook's charts come from mediaChanges with no earlier file", () => {
    assert.deepEqual(mediaChanges(".xlsx", null, new Uint8Array([1, 2, 3])), []);
  });

  it("an unreadable earlier workbook that was replaced reads as one plain line", () => {
    const t = changeNote({ ...base, file: "macro.xlsx", change: "modified", rows: [], unopened: [{ side: "before", why: "the file has no workbook part" }] }).text;
    assert.equal(t, "Claude replaced macro.xlsx; the earlier copy could not be opened");
    assert.equal(noteOf({ ...base, kind: "plain" }).text.includes("replaced"), false);
  });
});
