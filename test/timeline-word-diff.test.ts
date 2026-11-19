import { describe, it } from "node:test";
import assert from "node:assert/strict";
/* eslint-disable @typescript-eslint/no-explicit-any */
await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);

// The hover callout's words: a word-level diff of a change's public `before` and `after` strings (view-table.js wordDiff). Pure, so any connector's
// change gets it. Segments are { k: "same" | "del" | "add" | "gap", t }; a long unchanged run is cut to a few words each side with one "gap" (an ellipsis).
const VT = (globalThis as any).CoCheckViewTable;
const show = (segs: Array<{ k: string; t: string }>) => segs.map((s) => (s.k === "same" ? s.t : s.k === "gap" ? "…" : `[${s.k === "del" ? "-" : "+"}${s.t}]`)).join(" ");

describe("wordDiff (the hover callout's changed words)", () => {
  it("marks only the changed words inside the sentence", () => {
    assert.equal(show(VT.wordDiff("Revenue was 3 percent in May", "Revenue was 4 percent in May")), "Revenue was [-3] [+4] percent in May");
  });
  it("removed words come before the added words that replace them, and runs merge", () => {
    assert.equal(show(VT.wordDiff("This report outlines the plan", "This report sets out the plan")), "This report [-outlines] [+sets out] the plan");
  });
  it("pure additions and pure removals", () => {
    assert.equal(show(VT.wordDiff("a b c", "a b new c")), "a b [+new] c");
    assert.equal(show(VT.wordDiff("a b old c", "a b c")), "a b [-old] c");
  });
  it("a change with only an after (or only a before) string is all added (or all removed)", () => {
    assert.equal(show(VT.wordDiff(null, "New title words")), "[+New title words]");
    assert.equal(show(VT.wordDiff("Gone words", "")), "[-Gone words]");
  });
  it("no words on either side is an empty list (the callout then shows the change's text or label)", () => {
    assert.deepEqual(VT.wordDiff(null, null), []);
    assert.deepEqual(VT.wordDiff("  ", undefined), []);
  });
  it("whitespace differences are not changes", () => {
    assert.equal(show(VT.wordDiff("a  b\n c", "a b c")), "a b c");
  });
  it("a long unchanged run is elided with one ellipsis, keeping a few words beside each change", () => {
    const mid = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const lead = Array.from({ length: 20 }, (_, i) => `l${i}`).join(" ");
    const tail = Array.from({ length: 20 }, (_, i) => `t${i}`).join(" ");
    const out = VT.wordDiff(`${lead} one ${mid} two ${tail}`, `${lead} ONE ${mid} TWO ${tail}`);
    assert.equal(show(out), "… l16 l17 l18 l19 [-one] [+ONE] w0 w1 w2 w3 … w26 w27 w28 w29 [-two] [+TWO] t0 t1 t2 t3 …");
    assert.equal(out.filter((s: any) => s.k === "gap").length, 3);
    assert.ok(out.every((s: any) => s.k !== "gap" || s.t === "…"));
  });
  it("a short unchanged run is kept whole", () => {
    assert.equal(show(VT.wordDiff("a b c d e f g h i x", "a b c d e f g h i y")), "a b c d e f g h i [-x] [+y]");
  });
  it("a very long pair still diffs (common ends trimmed, no quadratic blow-up) and keeps the change", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `z${i}`).join(" ");
    const t0 = Date.now();
    const out = VT.wordDiff(`${big} old ${big}`, `${big} new ${big}`);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(show(out), "… z4996 z4997 z4998 z4999 [-old] [+new] z0 z1 z2 z3 …");
  });
});
