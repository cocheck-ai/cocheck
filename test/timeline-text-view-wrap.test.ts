import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const asset = (n: string) => readFile(new URL(`../src/timeline/rail/assets/${n}`, import.meta.url), "utf8");

describe("text view scrolls long lines sideways", () => {
  it("no rule cuts a text-pane line off with an ellipsis; the pane scrolls and the gutter is sticky", async () => {
    const css = await asset("review.css");
    const rules = css.split("\n").filter((l) => /\.grid\.textpane td\.code\s*\{/.test(l) && !/\.(hit|w)\b/.test(l));
    assert.ok(rules.length >= 1);
    for (const r of rules) assert.doesNotMatch(r, /text-overflow:\s*ellipsis|max-width:\s*0/);
    assert.match(css, /\.textscroll\{overflow-x:auto\}/);
    assert.match(css, /\.grid\.textpane td\.code\{white-space:pre;overflow:visible/);
    assert.match(css, /\.grid\.textpane th\.rowh\{position:sticky;left:0/);
  });
  it("each side's text table sits in its own scroller", async () => {
    const js = await asset("review.js");
    assert.match(js, /el\('div', \{ class: 'textscroll' \}, tt\)/);
  });
});
