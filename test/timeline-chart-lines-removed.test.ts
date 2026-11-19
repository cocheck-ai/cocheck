import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// the per-chart change sentences are not written (nor a chart-facts box); the caveats stay.

await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
const VT = (globalThis as unknown as { CoCheckViewTable: Record<string, unknown> }).CoCheckViewTable;
const read = (f: string): string => readFileSync(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8");

describe("no change sentences on the page", () => {
  it("view-table.js no longer offers chartLines or its helpers", () => {
    assert.equal(VT.chartLines, undefined);
    assert.doesNotMatch(read("view-table.js"), /chartLines|moveLines|rangeOf/);
  });
  it("review.js paints no sentences and no Charts heading; caveats stay", () => {
    const js = read("review.js");
    assert.doesNotMatch(js, /chartLines|cfline|cfchart|'Charts'/);
    assert.match(js, /\$\('caveats'\)/);
  });
  it("review.css drops the sentence rules, reduced-motion stays last", () => {
    const css = read("review.css");
    assert.doesNotMatch(css, /cfline|cfchart/);
    assert.match(css.trimEnd().split("\n").pop()!, /prefers-reduced-motion/);
  });
});
