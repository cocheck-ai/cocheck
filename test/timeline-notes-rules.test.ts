import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { actorName, changeNote, noteOf, type ChangeFacts, type NoteInput } from "../src/timeline/notes.ts";
import { buildTimeline, type FormatChanges, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { secretLine } from "../src/secret-files.ts";
import { fixtures, call, prompt, state, stop } from "./fixtures/timeline.ts";

// One plain sentence per change, from rules. The case to guard against is a note that states a number or a quoted string the
// change's record lacks, so every golden case below is also run through `inRecord`. the engine is generic (a layer's location as
// written, no cell grammar, no labels); a connector's step is worded from its document (test/notes-generic.test.ts).

const C = "Claude";
const cell = (over: Partial<NoteInput>): NoteInput => ({ actor: C, file: "rates.csv", location: "row 17, column 2", kind: "cell", ...over });

interface Golden {
  name: string;
  input: NoteInput;
  note: string;
}
const GOLDEN: Golden[] = [
  { name: "a cell changed, percent", input: cell({ before: "25.00%", after: "21.00%" }), note: "Claude changed row 17, column 2 from 25.00% to 21.00%" },
  { name: "a cell changed, with thousands", input: cell({ location: "row 18, column 2", before: "34,124", after: "36,500" }), note: "Claude changed row 18, column 2 from 34,124 to 36,500" },
  { name: "a cell changed, text", input: cell({ location: "row 2, column 2", before: "Acme", after: "Apex" }), note: "Claude changed row 2, column 2 from Acme to Apex" },
  { name: "file created in a folder", input: { actor: C, file: "backup/casebook-backup.xlsx", kind: "created" }, note: "Claude created casebook-backup.xlsx in the backup folder" },
  { name: "text hunk, both ways", input: { actor: C, file: "notes.md", kind: "text", lines: { added: true, removed: true } }, note: "Claude edited lines in notes.md" },
  { name: "text hunk, added", input: { actor: C, file: "notes.md", kind: "text", lines: { added: true, removed: false } }, note: "Claude added lines to notes.md" },
  { name: "picture or fingerprint", input: { actor: C, file: "deck.key", kind: "fingerprint" }, note: "Claude changed deck.key (the file changed; CoCheck can't read inside it)" },
  { name: "unknown shape falls back", input: cell({ kind: "cell style", before: "red", after: "blue" }), note: "Claude changed row 17, column 2 from red to blue" },
  { name: "nobody credited", input: cell({ actor: actorName(null), before: "804.14", after: "850" }), note: "Someone changed row 17, column 2 from 804.14 to 850" },
];

const DIGITS = /-?\d[\d,]*(?:\.\d+)?/g;
const norm = (s: string): number => Number(s.replace(/,/g, ""));
/** Every number and quoted string of the note must be in the strings the change's record holds. */
function inRecord(note: string, record: string[]): string[] {
  const text = record.join("\n");
  const have = new Set((text.match(DIGITS) ?? []).map(norm));
  const missing: string[] = [];
  // The note's own counts are none: a number counts only if the record has it, whatever its trailing zeros.
  for (const n of note.match(DIGITS) ?? []) if (!have.has(norm(n))) missing.push(n);
  for (const q of note.match(/["“']([^"”']+)["”']/g) ?? []) if (!text.includes(q.slice(1, -1))) missing.push(q);
  return missing;
}
const recordOf = (i: NoteInput): string[] => [i.file, i.location ?? "", i.before ?? "", i.after ?? "", i.text ?? ""];

describe("notes: golden sentences", () => {
  for (const g of GOLDEN) {
    it(g.name, () => {
      const n = noteOf(g.input);
      assert.equal(n.text, g.note);
      assert.equal(n.source, "rule");
    });
  }

  it("every number and quoted string in every golden note is in the record for that change", () => {
    for (const g of GOLDEN) assert.deepEqual(inRecord(noteOf(g.input).text, recordOf(g.input)), [], g.name);
  });

  it("the check itself fails on a number the record lacks", () => {
    assert.deepEqual(inRecord("Claude lowered the tax rate from 25% to 22%", ["25.00%", "21.00%"]), ["22"]);
  });

  it("a long value is left out whole, never cut", () => {
    const long = "x".repeat(90);
    const n = noteOf(cell({ before: "a", after: long })).text;
    assert.equal(n, "Claude changed row 17, column 2");
  });
});

describe("notes: the guarded case", () => {
  const secretFacts: ChangeFacts = { actor: C, file: "config/.env", change: "modified", secret: true, expired: false, tier: "fingerprint", rows: [{ location: "Sheet!A1", kind: "value", before: "hunter2", after: "hunter3", text: "x" }] };
  it("a secret file's note is exactly secretLine", () => {
    assert.equal(changeNote(secretFacts).text, secretLine("config/.env"));
    assert.equal(noteOf({ actor: C, file: "config/.env", kind: "value", location: "Sheet!A1", before: "hunter2", after: "hunter3", secret: true }).text, secretLine("config/.env"));
  });
  it("expired values give a note without values", () => {
    const n = noteOf(cell({ before: "25.00%", after: "21.00%", expired: true })).text;
    assert.equal(n, "Claude changed row 17, column 2");
    assert.doesNotMatch(n, /\d{2}%/);
  });
  it("a row about the whole file carries no hashes", () => {
    const n = noteOf({ actor: C, file: "m.xlsx", location: "file", kind: "file changed", before: "a".repeat(64), after: "b".repeat(64) }).text;
    assert.equal(n, "Claude changed m.xlsx");
  });
  it("several changes a connector listed read as several changes, with no count", () => {
    const c = { label: "S!A1", mark: "changed", before: "1", after: "2", text: null };
    const n = changeNote({ actor: C, file: "m.xlsx", change: "modified", secret: false, expired: false, tier: "fingerprint", rows: [], connector: { changes: [c, { ...c, label: "S!A2" }] } }).text;
    assert.equal(n, "Claude made several changes inside m.xlsx");
  });
});

describe("notes: carried on the timeline body", () => {
  const input = (name: string, over: Partial<TimelineInput> = {}): TimelineInput => {
    const f = fixtures[name]!();
    return { taskId: 1, build: "t", ops: f.ops, fileStates: f.fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: true, ...over };
  };
  it("every change has a note with source rule; the ledger's own note moved to ledgerNote", () => {
    const t = buildTimeline(input("directWriter"));
    const changes = t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.flatMap((c) => c.changes)));
    assert.ok(changes.length > 0);
    for (const c of changes) {
      assert.equal(c.note.source, "rule");
      assert.equal(c.note.text, "Claude changed notes.md (the file changed; CoCheck can't read inside it)");
      assert.ok("ledgerNote" in c);
    }
  });
  it("a generic layer's row carries its own sentence", () => {
    const f = fixtures.directWriter!();
    const fmt: FormatChanges = { module: "files", rows: [{ location: "row 17, column 2", kind: "cell", before: "25.00%", after: "21.00%", text: "t" }], more: 0 };
    const t = buildTimeline(input("directWriter", { formats: new Map([[f.fileStates[1]!.id, fmt]]) }));
    const c = t.requests[0]!.runs[0]!.calls[0]!.changes[0]!;
    assert.equal(c.format!.rows[0]!.note!.text, "Claude changed row 17, column 2 from 25.00% to 21.00%");
  });
  it("an outside path in a cell value is cut to its file name in the note", () => {
    const f = fixtures.directWriter!();
    const fmt: FormatChanges = { module: "files", rows: [{ location: "row 12, column 3", kind: "cell", before: "a", after: "/Users/user/outside/backup.xlsx", text: "t" }], more: 0 };
    const t = buildTimeline(input("directWriter", { formats: new Map([[f.fileStates[1]!.id, fmt]]) }));
    const c = t.requests[0]!.runs[0]!.calls[0]!.changes[0]!;
    assert.equal(c.format!.rows[0]!.note!.text, "Claude changed row 12, column 3 from a to backup.xlsx");
  });
  it("the actor is the host of the credited call, and Someone when no call is credited", () => {
    assert.equal(actorName("claude"), "Claude");
    assert.equal(actorName(null), "Someone");
  });
  it("a change no call is credited with says it came from outside the agents; a credited one keeps its host", () => {
    const f = fixtures.directWriter!();
    const inside = buildTimeline(input("directWriter"));
    assert.match(inside.requests[0]!.runs[0]!.calls[0]!.changes[0]!.note.text, /^Claude /);
    // Outside needs no call credited, none open, and not found at a call's Post (the fixture's states are Post sweeps).
    const dropped = buildTimeline({ ...input("directWriter"), fileStates: f.fileStates.map((st) => ({ ...st, credited_json: "[]", calls_open_json: "[]", phase: "Pre" })) });
    assert.ok(dropped.unplaced.length > 0);
    for (const x of dropped.unplaced) assert.match(x.note.text, /^Something outside the agents /);
    // The same changes found at a Post with no call credited were found during agent calls, never outside them.
    const atPost = buildTimeline({ ...input("directWriter"), fileStates: f.fileStates.map((st) => ({ ...st, credited_json: "[]", calls_open_json: "[]" })) });
    for (const x of atPost.unplaced) assert.match(x.note.text, /^Something, during agent calls, /);
  });
  it("a change credited to a call whose record is expired or gone is never called outside the agents", () => {
    const f = fixtures.directWriter!();
    const cases: Array<[string, Partial<TimelineInput>, (st: (typeof f.fileStates)[number]) => (typeof f.fileStates)[number]]> = [
      ["values expired", { valuesExpiredAt: "2026-10-01" }, (st) => st],
      ["credited call absent", {}, (st) => ({ ...st, credited_json: '["ghost-call"]' })],
    ];
    for (const [name, over, tweak] of cases) {
      const t = buildTimeline({ ...input("directWriter", over), fileStates: f.fileStates.map(tweak) });
      assert.ok(t.unplaced.length > 0, name);
      for (const x of t.unplaced) assert.ok(!/outside/i.test(x.note.text), `${name}: ${x.note.text}`);
      const m = buildRailModel(t);
      assert.ok(!m.stops.some((s) => s.lane === "other"), name);
      assert.ok(!JSON.stringify(m.stops.map((s) => [s.head, s.sub])).includes("outside the agents"), name);
      // The lost actor's words changed with the plan ("An agent call whose record is gone").
      assert.ok(m.stops.some((s) => s.head.startsWith("An agent call whose record is gone ")), name);
    }
    // Outside needs no call open and not a Post sweep too (the fixture's states are Post sweeps).
    const none = buildRailModel(buildTimeline({ ...input("directWriter"), fileStates: f.fileStates.map((st) => ({ ...st, credited_json: "[]", calls_open_json: "[]", phase: "Pre" })) }));
    assert.ok(none.stops.some((s) => s.lane === "other"));
  });
  it("a secret file's change note is exactly secretLine, and expiry removes values", () => {
    const f = fixtures.directWriter!();
    const secret = buildTimeline({ ...input("directWriter"), fileStates: f.fileStates.map((s) => ({ ...s, file_path: s.file_path.replace("notes.md", ".env") })), ops: f.ops.map((o) => ({ ...o, args_json: String(o.args_json).replaceAll("notes.md", ".env") })) });
    const c = secret.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.flatMap((x) => x.changes)))[0]!;
    assert.equal(c.note.text, secretLine(".env"));
    const expired = buildTimeline(input("directWriter", { valuesExpiredAt: "2026-10-01" }));
    for (const x of expired.unplaced) assert.doesNotMatch(x.note.text, /\d/);
  });
});

// ---- deletes, containment and equal values ----

const W = "/w/";
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** The notes of every change of a hand-built record, by relative file name. */
function notesOf(ops: TimelineInput["ops"], fileStates: TimelineInput["fileStates"]): Record<string, string> {
  const t = buildTimeline({ taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: true });
  const out: Record<string, string> = {};
  for (const c of [...t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.flatMap((x) => x.changes))), ...t.unplaced]) out[c.file] = c.note.text;
  return out;
}
const withGone = (s: ReturnType<typeof state>, sha = EMPTY_SHA) => ({ ...s, sha256: sha, kept: "gone" as const });
const callOps = (...ids: string[]) => [...ids.map((id, i) => call(id, { desc: "d", named: [], at: 10 * (i + 1) })), prompt("s1", ["go"]), stop("s1")];

describe("notes: a delete pairs with at most one create", () => {
  it("one delete and two creates of the same bytes read as plain created and deleted", () => {
    const ops = callOps("c1");
    const st = [state(W + "a.txt", "A", null, { step: 1 }), state(W + "b.txt", "A", null, { open: ["c1"], credited: ["c1"] }), state(W + "sub/c.txt", "A", null, { open: ["c1"], credited: ["c1"] }), withGone(state(W + "a.txt", "A", "A", { open: ["c1"], credited: ["c1"] }))];
    const n = notesOf(ops, st);
    assert.doesNotMatch(Object.values(n).join("|"), /renamed|moved/);
    assert.equal(n["b.txt"], "Claude created b.txt");
    assert.equal(n["sub/c.txt"], "Claude created c.txt in the sub folder");
  });
  it("an unrelated empty delete and an empty create are not a rename", () => {
    const ops = callOps("c1");
    const st = [withGone(state(W + "x.txt", EMPTY_SHA, EMPTY_SHA, { open: ["c1"], credited: ["c1"] })), state(W + "new.txt", EMPTY_SHA, null, { open: ["c1"], credited: ["c1"] })];
    const n = notesOf(ops, st);
    assert.equal(n["x.txt"], "Claude deleted x.txt");
    assert.equal(n["new.txt"], "Claude created new.txt");
  });
  it("a delete and a create of the same bytes in different calls are not a rename", () => {
    const ops = callOps("c1", "c2");
    const st = [withGone(state(W + "a.txt", "A", "A", { open: ["c1"], credited: ["c1"] })), state(W + "b.txt", "A", null, { open: ["c2"], credited: ["c2"] })];
    const n = notesOf(ops, st);
    assert.equal(n["a.txt"], "Claude deleted a.txt");
  });
  // equal bytes prove identical content, not a move, so the note states only the literal fact,
  // each side naming the other path. Was: "Claude moved a.txt to sub/c.txt" on both.
  it("exactly one delete and one create of the same bytes in one call state the same content, never a move", () => {
    const ops = callOps("c1");
    const st = [withGone(state(W + "a.txt", "A", "A", { open: ["c1"], credited: ["c1"] })), state(W + "sub/c.txt", "A", null, { open: ["c1"], credited: ["c1"] })];
    const n = notesOf(ops, st);
    assert.equal(n["sub/c.txt"], "Claude created c.txt in the sub folder. Same content as a.txt, which this call deleted.");
    assert.equal(n["a.txt"], "Claude deleted a.txt. This call created sub/c.txt with the same content.");
  });
});

/** The strict check: every digit run and every word that is not template wording is a literal substring of the record. */
const TEMPLATE = new Set(["Claude", "Someone", "Codex", "raised", "lowered", "changed", "set", "entered", "in", "on", "the", "sheet", "range", "from", "to", "of", "a", "cell", "row", "column", "formula", "for", "replaced", "with", "value", "cleared", "which", "held", "it", "was", "created", "deleted", "renamed", "moved", "folder", "lines", "added", "removed", "edited", "inserted", "made", "several", "changes", "inside", "file", "can't", "CoCheck", "read", "stays", "shown", "and", "out", "top", "watched", "into", "labelled"]);
function literal(note: string, record: string[]): string[] {
  const text = record.join("\n");
  const bad: string[] = [];
  for (const d of note.match(/\d[\d,.]*%?/g) ?? []) if (!text.includes(d)) bad.push(d);
  for (const w of note.match(/[A-Za-z]+(?:'[A-Za-z]+)*/g) ?? []) if (!TEMPLATE.has(w) && !text.includes(w)) bad.push(w);
  return bad;
}

describe("notes: literal containment", () => {
  it("every golden note's digit runs and words are literal substrings of the record", () => {
    for (const g of GOLDEN) assert.deepEqual(literal(noteOf(g.input).text, recordOf(g.input)), [], g.name);
  });
  it("the check fails on a case-changed label and on a tidied number", () => {
    assert.deepEqual(literal("Claude lowered the marginal tax rate from 25% to 21%", ["Marginal tax rate", "25.00%", "21.00%"]).sort(), ["21%", "25%", "marginal"]);
    assert.deepEqual(literal("Claude changed the rate from 20.9 to 21", ["rate", "20.90", "21"]), []);
    assert.deepEqual(literal("Claude changed x from 20.9% to 21%", ["x", "20.8%", "21%"]), ["20.9%"]);
  });
  it("version-like text stays whole", () => {
    assert.equal(noteOf(cell({ before: "3.10", after: "3.11" })).text, "Claude changed row 17, column 2 from 3.10 to 3.11");
  });
  it("a note on a real format row is literal against that row", () => {
    const row = { actor: C, file: "rates.csv", location: "row 17, column 2", kind: "cell", before: "20.90%", after: "(empty)" };
    const n = noteOf(row).text;
    assert.deepEqual(literal(n, recordOf(row)), []);
  });
});

describe("notes: equal and unreadable values", () => {
  it("equal displayed values do not read from 10 to 10", () => {
    assert.equal(noteOf(cell({ before: "10", after: "10" })).text, "Claude changed row 17, column 2; the shown value stays 10");
    assert.equal(noteOf(cell({ kind: "cell style", before: "red", after: "red" })).text, "Claude changed row 17, column 2; the shown value stays red");
  });
  it("an unreadable value is never stated", () => {
    assert.equal(noteOf(cell({ before: "[object Object]", after: "5" })).text, "Claude changed row 17, column 2");
    assert.equal(noteOf(cell({ before: "5", after: "[object Object]" })).text, "Claude changed row 17, column 2");
  });
});
