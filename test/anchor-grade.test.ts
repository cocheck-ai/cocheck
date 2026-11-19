// The stranger-test grader (scripts/anchor-grade.ts), over cocheck.changes/1 answers: an entity is a change's id, its kind follows the change's mark.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { checkCards, checkPayloads, grade, ingestToRail, matchChanges, type Card, type Sealed } from "../scripts/anchor-grade.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FX = path.join(ROOT, "test", "fixtures", "anchor");
const SEALED_DIR = path.join(FX, "sealed");
const sealed = JSON.parse(readFileSync(path.join(SEALED_DIR, "sealed.json"), "utf8")) as Sealed;
const good = path.join(ROOT, "public-kit", "conformance", "fixtures", "toy");
const g = (name: string) => grade({ connectorDir: name === "good" ? good : path.join(FX, name), sealedDir: SEALED_DIR });

const goodCards = (): Card[] => [
  { entity: "n1", kind: "edit", creditedCall: "call-1", panes: { before: "buy milk", after: "buy oat milk" } },
  { entity: "n3", kind: "create", creditedCall: "call-2", panes: { after: "book flights" } },
  { entity: "n2", kind: "delete", creditedCall: "call-3", panes: { before: "call the plumber" } },
];
const failing = (r: ReturnType<typeof checkCards>) => Object.entries(r).filter(([, v]) => v.length).map(([k]) => k);

test("matchChanges: order-free exact match gives recall and precision 1.0", () => {
  const m = matchChanges([{ kind: "edit", entity: "n1" }, { kind: "create", entity: "n3" }], [
    { id: "n3", mark: "added" }, { id: "n1", mark: "changed" }]);
  assert.deepEqual([m.recall, m.precision, m.missed, m.extra], [1, 1, [], []]);
});

test("matchChanges: a missed change and an extra change are named", () => {
  const m = matchChanges([{ kind: "edit", entity: "n1" }], [{ id: "n4", mark: "changed" }]);
  assert.deepEqual([m.recall, m.precision, m.missed, m.extra], [0, 0, ["edit:n1"], ["edit:n4"]]);
});

test("checkPayloads: an empty pane and a wrong value are reported", () => {
  const step = sealed.steps[2]!; // delete n2, golden before value
  const p = checkPayloads(step, [{ id: "n2", mark: "removed", before: "", after: "call the plumber" }]);
  assert.equal(p.panes.length, 1);
  assert.equal(p.tokens.length, 1);
});

test("checkCards: a correct rail has no failures", () => {
  assert.deepEqual(failing(checkCards(sealed, goodCards())), []);
});

test("checkCards: a card for an untouched entity fails precision", () => {
  const r = checkCards(sealed, [...goodCards(), { entity: "n4", kind: "edit", creditedCall: "call-1", panes: { before: "x", after: "y" } }]);
  assert.match(r.precision.join(), /untouched entity/);
});

test("checkCards: two cards for one sealed change fails precision", () => {
  const r = checkCards(sealed, [...goodCards(), goodCards()[0]!]);
  assert.match(r.precision.join(), /want exactly one/);
});

test("checkCards: an empty pane fails panes", () => {
  const cards = goodCards();
  cards[1]!.panes.after = "";
  assert.ok(failing(checkCards(sealed, cards)).includes("panes"));
});

// Must not happen: a grader that passes a missed change or a wrong credit, or fails a correct connector on cosmetic drift.
test("must not: wrong credit is failed, never passed", () => {
  const cards = goodCards();
  cards[0]!.creditedCall = "call-3";
  assert.deepEqual(failing(checkCards(sealed, cards)), ["credit"]);
});

test("must not: a missing card (missed change on the rail) is failed", () => {
  assert.ok(checkCards(sealed, goodCards().slice(1)).recall.length > 0);
});

test("must not: cosmetic drift (whitespace, card order, extra emitted fields) does not fail a correct connector", () => {
  const cards = goodCards().reverse();
  cards[0]!.panes.before = "  call   the\nplumber ";
  assert.deepEqual(failing(checkCards(sealed, cards)), []);
  const p = checkPayloads(sealed.steps[0]!, [{ id: "n1", mark: "changed", before: "buy milk", after: "buy  oat\nmilk ", extra: 1 } as never]);
  assert.deepEqual(p, { panes: [], tokens: [] });
});

test("grade: bad connector that misses a change fails recall", async () => {
  const r = await g("bad-missed-change");
  assert.equal(r.pass, false);
  assert.equal(r.criteria.recall.status, "fail");
  assert.match(r.criteria.recall.reasons.join(), /call-1: missed edit:n1/);
  assert.equal(r.criteria.precision.status, "pass");
});

test("grade: a phantom change for the untouched entity fails precision through grade()", async () => {
  const r = await g("bad-phantom-untouched");
  assert.equal(r.pass, false);
  assert.equal(r.criteria.precision.status, "fail");
  assert.match(r.criteria.precision.reasons.join(), /unexpected edit:n4/);
  assert.equal(r.criteria.recall.status, "pass");
});

test("sealed fixtures: the untouched entity is present and unchanged in every before and after state", () => {
  for (const st of sealed.steps) for (const f of [st.before, st.after]) {
    const notes = (JSON.parse(readFileSync(path.join(SEALED_DIR, f), "utf8")) as { notes: { id: string; text: string }[] }).notes;
    for (const u of sealed.untouched) assert.equal(notes.find((n) => n.id === u)?.text, "water the plants", `${f} ${u}`);
  }
});

// exact value on the golden side, whitespace-only normalisation.
const editStep = () => sealed.steps[0]!;
const editWith = (after: string) => [{ id: "n1", mark: "changed", before: "buy milk", after }];
test("payload value: a value containing the token but otherwise wrong fails (goat vs oat)", () => {
  assert.equal(checkPayloads(editStep(), editWith("buy goat milk")).tokens.length, 1);
});
test("payload value: a case difference fails", () => {
  assert.equal(checkPayloads(editStep(), editWith("Buy oat milk")).tokens.length, 1);
});
test("payload value: whitespace-only drift passes", () => {
  assert.deepEqual(checkPayloads(editStep(), editWith(" buy   oat\nmilk ")), { panes: [], tokens: [] });
});
test("card pane: goat and a case difference fail the exact value, whitespace passes", () => {
  for (const bad of ["buy goat milk", "Buy oat milk"]) {
    const cards = goodCards();
    cards[0]!.panes.after = bad;
    assert.deepEqual(failing(checkCards(sealed, cards)), ["tokens"], bad);
  }
  const ok = goodCards();
  ok[0]!.panes.after = "buy  oat milk\n";
  assert.deepEqual(failing(checkCards(sealed, ok)), []);
});
test("grade: a connector emitting a wrong value fails tokens through grade()", async () => {
  const r = await g("bad-empty-pane");
  assert.equal(r.criteria.tokens.status, "fail");
});

test("grade: bad connector with empty panes fails panes and tokens", async () => {
  const r = await g("bad-empty-pane");
  assert.equal(r.pass, false);
  assert.equal(r.criteria.panes.status, "fail");
  assert.equal(r.criteria.tokens.status, "fail");
  assert.equal(r.criteria.recall.status, "pass");
});

test("ingestToRail: the good toy's cards are pinned: one per sealed change, credited to the call that wrote the file, panes from the connector", async () => {
  const cards = await ingestToRail(good, SEALED_DIR, sealed, new Map());
  const byEntity = (e: string) => cards.filter((c) => c.entity === e);
  assert.equal(cards.length, 3);
  assert.deepEqual(byEntity("n1"), [goodCards()[0]]);
  assert.deepEqual(byEntity("n3"), [goodCards()[1]]);
  assert.deepEqual(byEntity("n2"), [goodCards()[2]]);
  assert.equal(byEntity("n4").length, 0, "the untouched note has no card");
});

test("grade: the good toy connector passes end to end", async () => {
  const r = await g("good");
  assert.deepEqual(Object.entries(r.criteria).filter(([, v]) => v.status !== "pass"), []);
  assert.equal(r.pass, true);
});

// Must not happen (credit from the connector): the connector labels every diff with another call's subject. Credit stays CoCheck's own record,
// so the cards stay credited to the right call; the grade fails on credit because the label contradicts what CoCheck recorded.
// The mislabelled check compares file names, not paths, and splits on either separator. A connector that names the right file with a
// Windows-separator path is correct; posix path.basename would not split it and the card would be false-flagged.

// Must not happen (credit from the answer): a cocheck.changes/1 answer that is otherwise correct but carries attribution, credited, credited_call and call
// fields naming another call on every change and on the answer. The answer goes through the real ingestion path (hook capture, freeze, rail model); each card
// is credited to the call that wrote the file per CoCheck's own record, never to anything the answer names.
test("must not: credit fields in a connector answer never move a card's credit (real ingestion)", async () => {
  const cards = await ingestToRail(path.join(FX, "bad-claims-credit"), SEALED_DIR, sealed, new Map());
  const writer: Record<string, string> = { n1: "call-1", n3: "call-2", n2: "call-3" };
  assert.equal(cards.length, 3);
  for (const c of cards) assert.equal(c.creditedCall, writer[c.entity], `card ${c.entity} credited to ${c.creditedCall}, the writer is ${writer[c.entity]}`);
  const r = await g("bad-claims-credit");
  assert.deepEqual(r.criteria.credit, { status: "pass", reasons: [] });
});
