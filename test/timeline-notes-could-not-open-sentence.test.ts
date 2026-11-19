import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { changeNote, noteOf, type ChangeFacts, type NoteInput } from "../src/timeline/notes.ts";

// the could-not-open sentence joins the event sentence cleanly, and a layer's location is kept as written. (A connector words the sheet and A1 address steps itself.)

describe("the could-not-open sentence", () => {
  const facts = (unopened: ChangeFacts["unopened"]): ChangeFacts => ({
    actor: "Claude", file: "fred.xlsx", change: "modified", secret: false, expired: false, tier: "fingerprint", unopened,
    rows: [], connector: { changes: [{ label: "about!A7", mark: "changed", before: "1", after: "hello", text: null }] },
  });
  it("is joined to the event sentence with a full stop, never run on", () => {
    assert.equal(changeNote(facts([{ side: "after", why: "bad zip" }])).text, "Claude changed about!A7 from 1 to hello. CoCheck could not open the after version of fred.xlsx (bad zip).");
  });
  it("an event sentence that already ends in a full stop is not doubled", () => {
    const f = facts([{ side: "after", why: "bad zip" }]);
    const t = changeNote({ ...f, file: "notes.", rows: [], connector: null, tier: "text", hunkOps: ["+"] }).text;
    assert.ok(!t.includes(".."), t);
  });
  it("two appended sentences are separated by one space, no doubled stop", () => {
    const t = changeNote(facts([{ side: "before", why: "a" }, { side: "after", why: "b" }])).text;
    assert.ok(!t.includes(".."), t);
    assert.ok(t.includes("(a). CoCheck could not open the after"), t);
  });
});

describe("a layer's location is left as written", () => {
  const base: NoteInput = { actor: "Claude", file: "data.csv", location: "row 5, column 3", kind: "cell" };
  it("a CSV cell edit never says range", () => {
    assert.equal(noteOf({ ...base, before: "1", after: "2" }).text, "Claude changed row 5, column 3 from 1 to 2");
    for (const [before, after] of [["1", "2"], ["x", null], [null, null], [null, "hi"]] as const) {
      const t = noteOf({ ...base, before, after }).text;
      assert.ok(!/range/.test(t) && t.includes("row 5, column 3"), t);
    }
  });
  it("other layer locations are left as written", () => {
    for (const loc of ["row 5", "Slide 5 / Text 3", "name:Rate"]) {
      const t = noteOf({ ...base, location: loc, before: "a", after: null }).text;
      assert.ok(t.includes(loc) && !/range|cell /.test(t), t);
    }
  });
});
