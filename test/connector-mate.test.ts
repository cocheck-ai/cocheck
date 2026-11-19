// The level-3 pixel check pairs a box's picture with its mate by group and order, not by label. Must not happen: a level-3 pass (looksSame accepted,
// or a demotion skipped as "different") on a wrong mate. Covered by the tests named "guarded case" below.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gradeLevel } from "../src/connector/conformance.ts";
import { png } from "./helpers/png-writer.ts";

type P = (x: number, y: number) => [number, number, number];
const GRAY: [number, number, number] = [10, 20, 30];
/** A picture with a red 3x3 block at (bx, by) on gray. */
const block = (bx: number, by: number): P => (x, y) => (x >= bx && x < bx + 3 && y >= by && y < by + 3 ? [200, 0, 0] : GRAY);
const flat = (c: [number, number, number]): P => () => c;
const dirWith = (files: Record<string, Buffer>): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  for (const [n, b] of Object.entries(files)) writeFileSync(path.join(dir, n), b);
  return dir;
};
const grade = (d: unknown, dir: string) => gradeLevel([d, d], { level: 3, beforeText: "", afterText: "", dir });
const pic = (id: string, side: string, extra: Record<string, unknown>, h = 8) => ({ id, side, type: "image", src: `${id}.png`, width: 8, height: h, ...extra });
const box = (picture: string, rect: { x: number; y: number; w: number; h: number }, looksSame?: boolean) => ({ picture, rect, ...(looksSame === undefined ? {} : { looksSame }) });

// Excel-shaped: labels differ per side, the region is 2 rows taller after, and the same change sits at different places on each side.
const excel = (afterBlockY: number, looksSame?: boolean) => ({
  spec: "cocheck.changes/1",
  pictures: [
    pic("b", "before", { label: "Before - GDP!A925:H960", group: "GDP!A925", order: 0 }),
    pic("a", "after", { label: "After - GDP!A925:H962", group: "GDP!A925", order: 0 }, 10),
  ],
  changes: [{ id: "c", mark: "described", label: "row", boxes: [box("b", { x: 1, y: 1, w: 3, h: 3 }, looksSame), box("a", { x: 1, y: 3, w: 3, h: 3 }, looksSame)] }],
  _afterBlockY: afterBlockY,
});
const excelDir = (afterBlockY: number) => dirWith({ "b.png": png(8, 8, block(1, 1)), "a.png": png(8, 10, block(1, afterBlockY)) });
const strip = <T extends { _afterBlockY: number }>(d: T) => { const { _afterBlockY, ...rest } = d; void _afterBlockY; return rest; };

test("differing labels, same pixels under each side's own box: demoted without looksSame, accepted with it", () => {
  const dir = excelDir(3);
  const plain = grade(strip(excel(3)), dir);
  assert.match(plain.failures.join("\n"), /may not point at a real change/);
  assert.equal(plain.passed, 2);
  const claimed = grade(strip(excel(3, true)), dir);
  assert.deepEqual(claimed.failures, []);
  assert.deepEqual(claimed.warnings, []);
  assert.equal(claimed.passed, 3);
});

test("differing labels, different pixels under the boxes: not demoted, and looksSame fails", () => {
  const dir = excelDir(4); // the block moved inside the after box region
  assert.equal(grade(strip(excel(4)), dir).passed, 3);
  assert.match(grade(strip(excel(4, true)), dir).failures.join("\n"), /looksSame is true but the before and after pixels under the box differ/);
});

test("group and order point to a different picture than the label would (wrong mate by label)", () => {
  // before: b1 (g1, label L) is gray, b2 (g2, label M) is red. after: a1 (g1, label M) is red: its label-mate is b2 (same), its group mate b1 differs.
  const d = {
    spec: "cocheck.changes/1",
    pictures: [
      pic("b1", "before", { label: "L", group: "g1", order: 0 }), pic("b2", "before", { label: "M", group: "g2", order: 0 }),
      pic("a1", "after", { label: "M", group: "g1", order: 0 }), pic("a2", "after", { label: "L", group: "g2", order: 0 }),
    ],
    changes: [{ id: "c", mark: "described", label: "x", boxes: [box("a1", { x: 0, y: 0, w: 4, h: 4 }, true)] }],
  };
  const dir = dirWith({ "b1.png": png(8, 8, flat(GRAY)), "b2.png": png(8, 8, flat([200, 0, 0])), "a1.png": png(8, 8, flat([200, 0, 0])), "a2.png": png(8, 8, flat(GRAY)) });
  const r = grade(d, dir);
  assert.match(r.failures.join("\n"), /looksSame is true but the before and after pixels under the box differ/);
  assert.equal(r.passed, 2);
  // and without looksSame the group mate (different pixels) means no demotion, where the label mate (identical pixels) would have demoted
  const plain = { ...d, changes: [{ id: "c", mark: "described", label: "x", boxes: [box("a1", { x: 0, y: 0, w: 4, h: 4 })] }] };
  assert.equal(grade(plain, dir).passed, 3);
});

const unpaired = (a: Record<string, unknown>, extraBefore: Array<Record<string, unknown>> = []) => ({
  spec: "cocheck.changes/1",
  pictures: [pic("b", "before", { label: "L", group: "g", order: 0 }), ...extraBefore, pic("a", "after", { label: "L", ...a })],
  changes: [{ id: "c", mark: "described", label: "x", boxes: [box("a", { x: 0, y: 0, w: 4, h: 4 }, true)] }],
});
const same = () => dirWith({ "b.png": png(8, 8, flat(GRAY)), "a.png": png(8, 8, flat(GRAY)), "b2.png": png(8, 8, flat(GRAY)) });

test("must not: same group, different order, identical pixels and equal labels is never paired, looksSame is not accepted", () => {
  const r = grade(unpaired({ group: "g", order: 1 }), same());
  assert.match(r.failures.join("\n"), /looksSame cannot be accepted, no picture on the other side could be paired/);
  assert.equal(r.passed, 2);
});

test("must not: a group matching nothing on the other side is never paired, not demoted and not accepted", () => {
  const r = grade(unpaired({ group: "other", order: 0 }), same());
  assert.match(r.failures.join("\n"), /looksSame cannot be accepted/);
  const plain = unpaired({ group: "other", order: 0 });
  delete (plain.changes[0]!.boxes[0] as { looksSame?: boolean }).looksSame;
  const p = grade(plain, same());
  assert.deepEqual(p.failures, []);
  assert.match(p.warnings.join("\n"), /no pixel check, no picture on the other side could be paired/);
});

test("must not: two pictures with the same group and order on the other side are ambiguous, never paired", () => {
  const r = grade(unpaired({ group: "g", order: 0 }, [pic("b2", "before", { label: "L", group: "g", order: 0 })]), same());
  assert.match(r.failures.join("\n"), /looksSame cannot be accepted, no picture on the other side could be paired/);
});

test("a picture with a group is never paired with an ungrouped picture of the same label", () => {
  // the after picture is grouped, the before picture is not: the grouped one is paired only inside its group
  const d = unpaired({ group: "g", order: 0 });
  delete (d.pictures[0] as Record<string, unknown>)["group"];
  delete (d.pictures[0] as Record<string, unknown>)["order"];
  assert.match(grade(d, same()).failures.join("\n"), /looksSame cannot be accepted, no picture/);
});

test("without a group the label rule stands: same label, else the only image on that side", () => {
  const d = (label: string) => ({
    spec: "cocheck.changes/1",
    pictures: [pic("b", "before", { label: "L" }), pic("a", "after", { label })],
    changes: [{ id: "c", mark: "described", label: "x", boxes: [box("a", { x: 0, y: 0, w: 4, h: 4 }, true)] }],
  });
  assert.equal(grade(d("L"), same()).passed, 3);
  assert.equal(grade(d("other"), same()).passed, 2);
});

test("must not: two boxes per side in swapped order are never paired by index, a looksSame box over differing pixels fails", () => {
  // before has red at (0,0) only, after has red at (5,5) only. Pairing B1 with the first after box (A2, at 5,5) would call red-vs-red the same.
  const d = {
    spec: "cocheck.changes/1",
    pictures: [pic("b", "before", { label: "L" }, 10), pic("a", "after", { label: "L" }, 10)],
    changes: [{ id: "c", mark: "described", label: "x", boxes: [
      box("b", { x: 0, y: 0, w: 3, h: 3 }, true), box("b", { x: 5, y: 5, w: 3, h: 3 }),
      box("a", { x: 5, y: 5, w: 3, h: 3 }), box("a", { x: 0, y: 0, w: 3, h: 3 }),
    ] }],
  };
  const dir = dirWith({ "b.png": png(10, 10, block(0, 0)), "a.png": png(10, 10, block(5, 5)) });
  const r = grade(d, dir);
  assert.match(r.failures.join("\n"), /changes\[0\]\.boxes\[0\]: looksSame is true but the before and after pixels under the box differ/);
  assert.equal(r.passed, 2);
});
