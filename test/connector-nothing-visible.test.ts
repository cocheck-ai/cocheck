import { describe, it } from "node:test";
import assert from "node:assert/strict";
await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const VT = (globalThis as any).CoCheckViewTable;

// A step whose pictures were all compared and match, with no change listed (a recorded step: the deck saved again, only timestamps moved),
// says so in the view line instead of showing identical pictures with no explanation.
const pic = (id: string, side: string, flags: Record<string, unknown>) => ({ id, side, type: "image", label: id, src: "data:image/png;base64,", ...flags });
const doc = (level: number, changes: unknown[], pictures: unknown[]) => ({ spec: "cocheck.changes/1", changes, pictures, caveats: [], source: { by: "connector", name: "microsoft-powerpoint", level } });

describe("nothing visible changed", () => {
  it("every picture unchanged and no change listed: the view line says nothing visible changed, at level 2 and 3", () => {
    const pics = [pic("before:page1", "before", { unchanged: true }), pic("after:page1", "after", { unchanged: true })];
    for (const level of [2, 3]) assert.equal(VT.sceneOf(doc(level, [], pics)).coverage, VT.NOTHING_VISIBLE);
    assert.match(VT.NOTHING_VISIBLE, /^Nothing visible changed/);
  });
  it("a picture marked changed, a picture with no flag, a listed change, or no pictures: no such line", () => {
    const un = pic("before:page1", "before", { unchanged: true });
    assert.notEqual(VT.sceneOf(doc(2, [], [un, pic("after:page1", "after", { changed: true })])).coverage, VT.NOTHING_VISIBLE);
    assert.notEqual(VT.sceneOf(doc(2, [], [un, pic("after:page1", "after", {})])).coverage, VT.NOTHING_VISIBLE);
    assert.notEqual(VT.sceneOf(doc(2, [{ id: "c1", mark: "changed", label: "x" }], [un, pic("after:page1", "after", { unchanged: true })])).coverage, VT.NOTHING_VISIBLE);
    assert.notEqual(VT.sceneOf(doc(2, [], [])).coverage, VT.NOTHING_VISIBLE);
  });
});
