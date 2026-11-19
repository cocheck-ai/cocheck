import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openLedger } from "../src/ledger.ts";

// Sticky-note anchor: clicking any note goes to the step where that note was made, not only the first. A note records the step on show when it was made (review_notes.stop_id). Guards against
// the column becoming writable in place.

describe("sticky note anchor (review_notes.stop_id)", () => {
  it("a note keeps the step it was made on through edit, delete and send-back rows", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-noteanchor-"));
    const l = openLedger(home);
    try {
      const t = l.openTask("claude");
      const a = l.appendNote(t, "on a reply", null, "reply-abc");
      const b = l.appendNote(t, "on nothing", null);
      assert.deepEqual(l.liveNotes(t).map((n) => [n.text, n.stopId]), [["on a reply", "reply-abc"], ["on nothing", null]]);
      l.editNote(t, a, "on a reply, edited");
      assert.equal(l.liveNote(t, a)!.stopId, "reply-abc");
      l.deleteNote(t, b);
      const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
      assert.deepEqual((db.prepare("SELECT stop_id FROM review_notes WHERE note_id = ? ORDER BY id").all(a) as Array<{ stop_id: string | null }>).map((r) => r.stop_id), ["reply-abc", "reply-abc"]);
      assert.deepEqual((db.prepare("SELECT stop_id FROM review_notes WHERE note_id = ? ORDER BY id").all(b) as Array<{ stop_id: string | null }>).map((r) => r.stop_id), [null, null]);
      db.close();
      const rw = new DatabaseSync(path.join(home, "ledger.sqlite"));
      assert.throws(() => rw.exec(`UPDATE review_notes SET stop_id = 'chg-x' WHERE note_id = ${a}`), /append-only/);
      assert.throws(() => rw.exec("DELETE FROM review_notes"), /append-only/);
      rw.close();
    } finally {
      l.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
