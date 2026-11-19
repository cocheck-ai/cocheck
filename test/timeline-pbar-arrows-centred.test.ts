import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The step arrows of the review bar (#pbprev/#pbnext, class pbstep) sit centred in their 32px boxes, not in the lower left.

describe("review bar step arrows are centred", () => {
  it("the .pbstep rule centres its glyph and keeps the box size", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    const rule = /(?:^|\})\s*\.pbstep\{([^}]*)\}/m.exec(css);
    assert.ok(rule, "a plain .pbstep rule exists");
    const body = rule[1]!;
    assert.match(body, /display:inline-flex/);
    assert.match(body, /align-items:center/);
    assert.match(body, /justify-content:center/);
    assert.match(body, /padding:0(?:;|$)/);
    assert.match(body, /width:32px/);
    assert.match(body, /height:32px/);
  });
});
