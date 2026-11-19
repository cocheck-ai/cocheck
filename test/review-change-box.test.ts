import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The change box is one style on both sides, a 2px solid side colour, a 1.5px white keyline and a 7px
// halo, with no fill over the content. Guard: a box harder to see than today on any background, dark slides included. Today's After
// outline (#e79dc2) held 2.10:1 on white. The rendered box is measured in Chrome by test/timeline-change-first-chrome.test.ts; this file checks
// the stylesheet's own values without a browser, so a run with no Chrome still guards the contrast. REVIEW_CSS_ROOT points at another checkout.
const ROOT = process.env.REVIEW_CSS_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const css = readFile(join(ROOT, "src/timeline/rail/assets/review.css"), "utf8");

const hex = (h: string): number[] => { const x = h.replace("#", ""); const f = x.length === 3 ? x.split("").map((c) => c + c).join("") : x; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); };
const lum = (c: number[]): number => { const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
const ratio = (a: number[], b: number[]): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const token = (s: string, name: string): string => { const m = new RegExp(`${name}:(#[0-9a-fA-F]{3,6})\\b`).exec(s); assert.ok(m, `token ${name} is a colour`); return m![1]!; };

describe("change box", () => {
  it("one rule draws the box on both sides: 2px solid side colour, 1.5px white keyline, 7px halo at 22%, no fill", async () => {
    const s = await css;
    const rule = /\.before \.bx,\.after \.bx,\.bx\.cf\{([^}]*)\}/.exec(s)?.[1];
    assert.ok(rule, "the shared box rule");
    assert.match(rule!, /background:none/);
    assert.match(rule!, /mix-blend-mode:normal/);
    assert.match(rule!, /outline:2px solid var\(--bc/);
    assert.match(rule!, /box-shadow:0 0 0 1\.5px var\(--keyline\),0 0 0 7px color-mix\(in srgb,var\(--bc[^)]*\)\) 22%,transparent\)/);
    assert.match(s, /\.before \.bx\{--bc:var\(--box-before\)\}/);
    assert.match(s, /\.after \.bx\{--bc:var\(--box-after\)\}/);
    // no later rule gives the box a fill or a dashed line back (the old Before box was dashed, the old After box filled pink in multiply)
    assert.doesNotMatch(s, /\.after \.bx\{[^}]*background:(?!none)/);
    assert.doesNotMatch(s, /\.before \.bx\{[^}]*dashed/);
    assert.doesNotMatch(s, /\.(?:after|before) \.bx\.cf\{[^}]*outline:/, "no side-specific outline overrides the shared one");
  });
  it("each side's line holds 3:1 on white and on near-black, and the keyline holds 3:1 on near-black", async () => {
    const s = await css;
    const keyline = hex(token(s, "--keyline"));
    for (const side of ["--box-before", "--box-after"]) {
      const line = hex(token(s, side));
      for (const [bg, name] of [[[255, 255, 255], "white"], [[17, 17, 17], "near-black #111"], [[0, 0, 0], "black"]] as const) {
        assert.ok(ratio(line, [...bg]) >= 3, `${side} on ${name}: ${ratio(line, [...bg]).toFixed(2)}`);
      }
      assert.ok(ratio(line, [255, 255, 255]) > 2.1, `${side} is stronger on white than today's After outline (2.10:1)`);
    }
    assert.ok(ratio(keyline, [17, 17, 17]) >= 3, "the keyline reads on a dark slide");
  });
  it("the box colours do not follow the dark scheme (they sit on the connector's picture, which is shown as delivered): neither dark token block redefines them", async () => {
    const s = await css;
    // Applies the dark tokens twice: under the system setting unless Light was chosen, and when Dark was chosen. Both blocks must exist and stay clean.
    const blocks: Array<[string, string | undefined]> = [
      ["media-query dark block", /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{([^}]*)\}\}/.exec(s)?.[1]],
      ["data-theme=dark block", /:root\[data-theme=dark\]\{([^}]*--canvas[^}]*)\}/.exec(s)?.[1]],
    ];
    for (const [name, body] of blocks) {
      assert.ok(body, `${name} is present`);
      assert.match(body!, /--canvas:/, `${name} is the dark token list`);
      assert.doesNotMatch(body!, /--box-(?:before|after)|--keyline/, `${name} redefines no box token`);
    }
  });
});
