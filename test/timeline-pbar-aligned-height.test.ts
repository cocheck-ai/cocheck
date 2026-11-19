import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Every control in the review bar shares one height and one vertical centre, and the bar sizes to its content so a control never wraps
// onto a second row at an ordinary width (it is fixed at left:50%, so its shrink-to-fit width alone is capped at half the viewport).

async function rules(sel: RegExp): Promise<string[]> {
  const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
  const out: string[] = [];
  for (const m of css.matchAll(/(?<=^|\})\s*([^{}@/][^{}]*)\{([^}]*)\}/g)) if (sel.test(m[1]!.trim())) out.push(m[2]!);
  return out;
}

describe("review bar alignment", () => {
  it("the bar centres its items and is docked across the bottom of the main column", async () => {
    const body = (await rules(/^\.pbar$/)).join(";");
    assert.match(body, /align-items:center/);
    assert.match(body, /position:fixed/);
    assert.match(body, /left:var\(--rail\)/); assert.match(body, /right:0/); assert.match(body, /bottom:0/);
    assert.match(body, /min-height:var\(--barh\)/);
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.match(css, /--barh:56px/);
    assert.match(css, /\.body\{padding-bottom:calc\(var\(--barh\) \+ var\(--s4\)\)\}/, "the content ends above the bar");
  });
  it("step arrows, verdict buttons, Note and the action button are all 32px tall", async () => {
    const steps = (await rules(/^\.pbstep$/)).join(";");
    assert.match(steps, /width:32px/);
    assert.match(steps, /height:32px/);
    const verdict = (await rules(/^\.pbar \.vp,\.pbar \.vf$/)).join(";");
    assert.match(verdict, /height:32px/);
    const btn = (await rules(/^\.pbar \.btn$/)).join(";");
    assert.match(btn, /height:32px/);
  });
  it("the position and label text boxes are as tall as the controls, so their centre is the row's", async () => {
    const text = (await rules(/^\.pbpos,\.pblabel$/)).join(";");
    assert.match(text, /line-height:32px/);
  });
});
