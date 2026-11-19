import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// A strip card holds a time, an actor dot and a verb on two short rows; the verb is cut with an ellipsis inside the card, never painted over a
// neighbour. No browser in tests: these are CSS-rule assertions, not a measured render (the visual test measures).

const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
const body = (sel: string): string => {
  const esc = sel.replace(/[.\s>*]/g, (c) => (c === " " ? "\\s+" : "\\" + c));
  const m = css.match(new RegExp(`^${esc}\\{([^}]*)\\}`, "m"));
  assert.ok(m, `rule ${sel} exists`);
  return m![1]!;
};

describe("strip node labels cannot overlap", () => {
  it("the actor dot and verb share one row that may shrink, and the verb is cut with an ellipsis", () => {
    assert.match(body(".vn .who"), /min-width:0/);
    const l = body(".vn .lbl");
    assert.match(l, /min-width:0/);
    assert.match(l, /text-overflow:ellipsis/);
    assert.doesNotMatch(css, /\.vn \.who \.hinferred/, "no per-card Inferred text");
  });
  it("the node width is not fixed by a height or overflow clip that would cut a second line", () => {
    const b = body(".vn");
    assert.doesNotMatch(b, /(^|;)height:|overflow:hidden/);
  });
});
