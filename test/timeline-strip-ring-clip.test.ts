import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The selected version ring (box-shadow 4px) and the focus outline (3px + 2px offset = 5px) sit inside scroll containers that clip
// them flat. Each clipping container needs padding of at least 5px on the sides where the ring reaches it, balanced by margin so layout holds.

const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
const rule = (sel: string): string => {
  const m = css.match(new RegExp(`^${sel.replace(/[.]/g, "\\.")}\\{([^}]*)\\}`, "m"));
  assert.ok(m, `rule ${sel} exists`);
  return m![1]!;
};
const px = (v: string): number => (v.endsWith("px") ? parseFloat(v) : 0);
const sides = (body: string, prop: string): number[] => {
  const long = (s: string) => body.match(new RegExp(`(?:^|;)${prop}-${s}:([^;]+)`));
  const short = body.match(new RegExp(`(?:^|;)${prop}:([^;]+)`));
  const v = (short?.[1] ?? "0").trim().split(/\s+/).map(px);
  const [t, r = t, b = t, l = r] = v as [number, number?, number?, number?];
  const base = [t, r, b, l] as number[];
  return ["top", "right", "bottom", "left"].map((s, i) => { const m = long(s); return m ? px(m[1]!.trim()) : base[i]!; });
};

describe("rings and focus outlines are not clipped", () => {
  it(".strip pads at least 5px on all four sides", () => {
    for (const p of sides(rule(".strip"), "padding")) assert.ok(p >= 5, `strip padding ${p} >= 5`);
  });
  it(".strip margin offsets the padding so the layout does not shift", () => {
    const pad = sides(rule(".strip"), "padding"), mar = sides(rule(".strip"), "margin");
    // old box: margin 12 0 4 0, padding 0 0 2 0
    const old = [12, 0, 4, 0], oldPad = [0, 0, 2, 0];
    pad.forEach((p, i) => assert.equal(mar[i]! + p, old[i]! + oldPad[i]!, `side ${i}: margin + padding unchanged`));
  });
  it(".scroller keeps 5px or more of right padding for focus outlines, margin balanced", () => {
    const pad = sides(rule(".scroller"), "padding"), mar = sides(rule(".scroller"), "margin");
    assert.ok(pad[1]! >= 5);
    assert.equal(pad[1]! + mar[1]!, 0);
  });
  it(".tab focus outline sits inside the tab strip, which clips overflow", () => {
    assert.match(css, /\.tab:focus-visible\{[^}]*outline-offset:-\d/);
  });
});
