// The general picture fields `group` and `order` (spec v1.1): pictures sharing a group are one before-and-after set, ordered by `order` on
// each side. Must not happen: a malformed group or order slips past the check, and the page pairs a before picture with an after
// picture of another group (the row-pairing tests are in timeline-view-group-pairing.test.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkChanges } from "../src/connector/changes-v1.ts";

const pic = (extra: Record<string, unknown>) => ({ spec: "cocheck.changes/1", changes: [], pictures: [{ id: "b1", side: "before", type: "image", src: "b.png", width: 8, height: 8, ...extra }] });
const fields = (doc: unknown, level: 1 | 2 | 3 = 2): string[] => checkChanges(doc, level).map((p) => p.field);

test("group and order are valid at levels 2 and 3, and a document without them is unchanged", () => {
  assert.deepEqual(fields(pic({ group: "g1", order: 0 })), []);
  assert.deepEqual(fields(pic({ group: "g1", order: 3 }), 3), []);
  assert.deepEqual(fields(pic({ group: "GDP!A925:H960" })), []);
  assert.deepEqual(fields(pic({})), []);
});

test("a malformed group or order is a problem naming its field", () => {
  for (const bad of ["", 3, null, {}, ["g"]]) assert.deepEqual(fields(pic({ group: bad })), ["pictures[0].group"], JSON.stringify(bad));
  for (const bad of [-1, 1.5, "1", null, true]) assert.deepEqual(fields(pic({ group: "g", order: bad })), ["pictures[0].order"], JSON.stringify(bad));
  assert.deepEqual(fields(pic({ order: 0 })), ["pictures[0].order"], "order without a group");
});

test("the spec documents group and order in the general fields table", () => {
  const doc = readFileSync(path.join(import.meta.dirname, "..", "public-kit", "spec", "v1.md"), "utf8");
  const table = doc.slice(doc.indexOf("## General fields (v1.1)"), doc.indexOf("## Manifest additions"));
  assert.match(table, /\| picture \| `group` \|/);
  assert.match(table, /\| picture \| `order` \|/);
});
