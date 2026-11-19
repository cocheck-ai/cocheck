import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("rail chevron follows the direction a group opens", () => {
  it("newest first marks the chevron .up and an open .up chevron points up", async () => {
    const js = await readFile(new URL("../src/timeline/rail/assets/review.js", import.meta.url), "utf8");
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(js, /class: 'chev' \+ \(NEWEST \? ' up' : ''\)/);
    assert.match(css, /\.row\.hdr\[aria-expanded=true\] \.chev\.up\{transform:rotate\(180deg\)\}/);
  });
});

