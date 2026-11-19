import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// The step arrows are inline SVG chevrons (a text glyph sits ~1.1px low and off-centre; measured at 4x), the control row never wraps
// (the label ellipsizes first), and a composer open does not widen the bar beyond its own width.

async function rules(sel: RegExp): Promise<string[]> {
  const css = (await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8")).replace(/\/\*[^]*?\*\//g, "");
  const out: string[] = [];
  for (const m of css.matchAll(/(?<=^|\})\s*([^{}@/][^{}]*)\{([^}]*)\}/g)) if (sel.test(m[1]!.trim())) out.push(m[2]!);
  return out;
}

describe("review bar arrows, row and composer", () => {
  it("each step button holds an SVG chevron, not a text glyph", () => {
    const html = renderReviewShell(1);
    for (const id of ["pbprev", "pbnext"]) {
      const m = new RegExp(`id="${id}"[^>]*>([^]*?)</button>`).exec(html);
      assert.ok(m, id);
      assert.match(m[1]!, /^<svg [^>]*viewBox="0 0 24 24"/);
      assert.doesNotMatch(m[1]!, /&[lr]saquo;|[‹›]/);
    }
    assert.match(html, /M15 6l-6 6 6 6/);
    assert.match(html, /M9 6l6 6-6 6/);
  });
  it("the chevron is drawn as a stroke and sits centred in the 32px box", async () => {
    const svg = (await rules(/^\.pbar \.pbstep svg$/)).join(";");
    assert.match(svg, /fill:none/);
    assert.match(svg, /stroke:currentColor/);
    const step = (await rules(/^\.pbstep$/)).join(";");
    assert.match(step, /align-items:center/);
    assert.match(step, /justify-content:center/);
  });
  it("the controls sit in one non-wrapping row where the label shrinks and ellipsizes", async () => {
    const html = renderReviewShell(1);
    const row = /<div class="prow">([^]*?)\n  <\/div>\n<\/div>\n<div class="toast"/.exec(html);
    assert.ok(row, "a .prow wraps the control row");
    for (const id of ["pbprev", "pbpos", "pbnext", "pblabel", "pbfail", "pbpass", "pbnote", "pbact"]) assert.match(row[1]!, new RegExp(`id="${id}"`), id);
    for (const id of ["pnotes", "ncomp", "pcomp"]) assert.doesNotMatch(row[1]!, new RegExp(`id="${id}"`), `${id} stays outside the row`);
    const prow = (await rules(/^\.prow$/)).join(";");
    assert.match(prow, /display:flex/);
    assert.match(prow, /min-width:0/);
    assert.doesNotMatch(prow, /flex-wrap:wrap/);
    const label = (await rules(/^\.pblabel$/)).join(";");
    assert.match(label, /flex:0 1 auto/);
    assert.match(label, /min-width:0/);
    assert.match(label, /text-overflow:ellipsis/);
    assert.match(label, /white-space:nowrap/);
    const fixed = (await rules(/^\.pbar \.vp,\.pbar \.vf,\.pbar \.btn,\.pbpos,\.pbstep$/)).join(";");
    assert.match(fixed, /flex:none/);
  });
  it("with a composer open the bar is auto width and the row adds nothing to its intrinsic width", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /\.pbar:has\(\.pcomp:not\(\[hidden\]\)\)\{width:auto\}/);
    assert.match(css, /\.pbar:has\(\.pcomp:not\(\[hidden\]\)\) \.prow\{contain:inline-size\}/);
  });
  it("on a narrow window the row may wrap, so no control goes off-screen", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /@media \(max-width:719px\)\{\.prow\{flex-wrap:wrap\}\}/);
    const bar = (await rules(/^\.pbar$/)).join(";");
    assert.match(bar, /max-width:calc\(100vw - 32px\)/);
  });
});
