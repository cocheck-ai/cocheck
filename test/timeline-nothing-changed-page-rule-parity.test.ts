// The page's NOTHING_CHANGED line (view-table.js coverageLine) and the lane rule (vouchesNothingChanged) must answer alike for the
// same document. Must not happen: the page says "nothing changed" for a document the rule refuses (a status of null, '' or 0 is
// still a status: the rule refuses it, so the lane shows a stop).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { vouchesNothingChanged } from "../src/connector/nothing-changed-rule.ts";

await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
const VT = (globalThis as unknown as { CoCheckViewTable: { coverageLine: (doc: unknown) => string; NOTHING_CHANGED: string } }).CoCheckViewTable;

const base = { changes: [], source: { by: "connector", name: "microsoft-excel", level: 3, nothingChanged: true } };
const cases: Array<[string, Record<string, unknown>]> = [
  ["clean", {}],
  ["status absent", { status: undefined }],
  ["status null", { status: null }],
  ["status empty string", { status: "" }],
  ["status 0", { status: 0 }],
  ["status failed", { status: "failed" }],
  ["status object", { status: { kind: "refused" } }],
  ["issues", { issues: ["a warning"] }],
  ["empty issues", { issues: [] }],
  ["caveats", { caveats: ["a caveat"] }],
  ["empty caveats", { caveats: [] }],
  ["pictures", { pictures: [{ side: "after", src: "x.png" }] }],
  ["empty pictures", { pictures: [] }],
  ["pending", { pending: true }],
  ["pending retry", { pendingRetry: 5 }],
  ["failed", { failed: true }],
  ["more", { more: 2 }],
  ["no opt-in", { source: { by: "connector", name: "x", level: 3 } }],
];

describe("page and rule agree on nothing changed", () => {
  for (const [name, extra] of cases) {
    it(name, () => {
      const doc = { ...base, ...extra };
      const page = VT.coverageLine(doc) === VT.NOTHING_CHANGED;
      assert.equal(page, vouchesNothingChanged(doc));
    });
  }
  it("a status of null, '' or 0 is refused by both", () => {
    for (const status of [null, "", 0]) {
      const doc = { ...base, status };
      assert.equal(vouchesNothingChanged(doc), false);
      assert.notEqual(VT.coverageLine(doc), VT.NOTHING_CHANGED);
    }
  });
});
