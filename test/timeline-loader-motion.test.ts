import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { LOADING_CSS, LOADING_MOTION_CSS, loadingHtml } from "../src/timeline/loading.ts";
import { renderGenericPage } from "../src/timeline/page.ts";
// @ts-expect-error a plain .mjs build script, no types
import { SEQUENCE, checkPlayable, loaderCss, loaderMotion } from "../scripts/loader-css.mjs";

// The loading widget plays the two Lottie loaders (assets/loaders/loader-orbit.json, loader-spin.json) as CSS keyframes made from them,
// taking turns on one clock. Guarded cases: the widget drifting from the JSON it claims to play, a visible jump where one loader
// hands off to the other, motion under reduced motion, and an animation file that asks for more than the rig plays being accepted.

const ASSETS = new URL("../src/timeline/rail/assets/", import.meta.url);
const json = async (f: string) => JSON.parse(await readFile(new URL(`loaders/${f}`, ASSETS), "utf8"));
type V = number[];
type Key = { t: number; s?: V; v?: V | number; e: null | "hold" | number[] };

/** cubic-bezier(x1,y1,x2,y2) at progress x, as Lottie and CSS both define it */
function bez(e: Key["e"], x: number): number {
  if (e === null) return x;
  if (e === "hold") return 0;
  const [x1, y1, x2, y2] = e as number[];
  const B = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (B(x1!, x2!, m) < x) lo = m; else hi = m; }
  return B(y1!, y2!, (lo + hi) / 2);
}
/** a track of {t, v, e} keys at frame f */
function at(track: Key[], f: number): V {
  const val = (k: Key) => ([] as number[]).concat((k.v ?? k.s) as V);
  if (f <= track[0]!.t) return val(track[0]!);
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i]!, b = track[i + 1]!;
    if (f >= a.t && f <= b.t) { const p = bez(a.e, (f - a.t) / (b.t - a.t)); return val(a).map((x, j) => x + (val(b)[j]! - x) * p); }
  }
  return val(track.at(-1)!);
}
/** Lottie keyframes of a property as {t, s, e} */
const lkeys = (prop: { a: number; k: unknown }): Key[] => (prop.a ? (prop.k as Array<{ t: number; s: V; o?: { x: V; y: V }; i?: { x: V; y: V } }>).map((k) => ({ t: k.t, s: k.s, e: k.o ? [k.o.x[0]!, k.o.y[0]!, k.i!.x[0]!, k.i!.y[0]!] : null })) : [{ t: 0, s: ([] as number[]).concat(prop.k as V), e: null }]);
const rot = (deg: number, [x, y]: V) => { const r = (deg * Math.PI) / 180; return [x! * Math.cos(r) - y! * Math.sin(r), x! * Math.sin(r) + y! * Math.cos(r)]; };
const add = (a: V, b: V) => [a[0]! + b[0]!, a[1]! + b[1]!];
const mul = (k: number, a: V) => [k * a[0]!, k * a[1]!];
/** where the rig puts the lens centre and the grip's end at cycle frame f */
function rig(m: { tracks: Record<string, Key[]> }, f: number) {
  const g = (n: string) => at(m.tracks[n]!, f);
  const P = g("P"), R = g("R")[0]!, D = g("D"), S = g("S")[0]! / 100, H = g("H")[0]!;
  const lens = add(P, rot(R, D));
  return { lens, grip: add(lens, mul(S, rot(H, [59, 59]))) };
}
const near = (a: V, b: V, tol: number, what: string) => assert.ok(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!) <= tol, `${what}: ${a} vs ${b}`);

describe("the Lottie loaders are project assets, read as data", () => {
  it("all three ship under assets/loaders/ (the build copies the whole assets folder) and use only what the rig plays", async () => {
    assert.deepEqual((await readdir(new URL("loaders/", ASSETS))).sort(), ["icon-intro.json", "loader-orbit.json", "loader-spin.json"]);
    for (const f of ["icon-intro.json", "loader-orbit.json", "loader-spin.json"]) checkPlayable(await json(f), f);
    const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
    assert.match(build, /cpSync\(path\.join\(root, "src", "timeline", "rail", "assets"\), path\.join\(dist, "timeline", "rail", "assets"\), \{ recursive: true \}\)/);
  });

  it("an animation with an expression, an image asset or an unknown layer is refused, never half-played", async () => {
    const base = await json("loader-orbit.json");
    const withExpr = structuredClone(base); withExpr.layers[0].ks.r.x = "var a = 1; a";
    const withImage = structuredClone(base); withImage.assets = [{ id: "i", p: "a.png", u: "http://example.com/" }];
    const withText = structuredClone(base); withText.layers[0].ty = 5;
    for (const bad of [withExpr, withImage, withText]) assert.throws(() => checkPlayable(bad, "x"));
  });
});

describe("the widget plays them", () => {
  it("LOADING_CSS carries the keyframes made from the JSON, verbatim, and review.css carries LOADING_CSS", async () => {
    const want = loaderCss(await json("loader-orbit.json"), await json("loader-spin.json"));
    assert.ok(LOADING_CSS.includes(want), "LOADING_CSS no longer matches the loaders' JSON: run node scripts/loader-css.mjs");
    const css = await readFile(new URL("review.css", ASSETS), "utf8");
    assert.ok(css.includes(LOADING_CSS));
  });

  it("the widget is the icon's rig, label kept; the page script builds the same markup with SVG elements in the SVG namespace", async () => {
    const html = loadingHtml("Reading the work");
    for (const c of ["iload-mark", "ild-p", "ild-r", "ild-d", "ild-c", "ild-s", "ild-h", "ild-rim", "ild-glint", "ild-neck", "ild-grip"]) assert.match(html, new RegExp(`class="${c}"`));
    // transparent: the app icon's navy tile is not drawn, inline or in a pane
    assert.doesNotMatch(html, /<rect|ild-tile/);
    assert.doesNotMatch(LOADING_CSS, /ild-tile|fill:#1c2740/);
    assert.match(html, /<span class="iload-sr">Reading the work<\/span>/);
    assert.match(html, /<svg class="iload-mark" viewBox="0 0 128 128" aria-hidden="true" focusable="false">/);
    // nesting order is the transform order: P, R, D, -R, S, then the handle's own turn
    assert.match(html, /class="ild-p"><g class="ild-r"><g class="ild-d"><g class="ild-c"><g class="ild-s">.*<g class="ild-h">/);
    const src = await readFile(new URL("review.js", ASSETS), "utf8");
    assert.match(src, /window\.CoCheckViewTable\.loader\(function \(tag\) \{ return SVG_TAGS\[tag\] \? svgEl\.apply\(null, arguments\) : el\.apply\(null, arguments\); \}, label\)/);
    assert.match(src, /var SVG_TAGS = \{ svg: 1, g: 1, circle: 1, path: 1 \};/);
  });

  it("at rest (no animation) the rig is the app icon's mark, no tile: rim, glint, neck and grip in the icon's place and widths, coloured for the page", async () => {
    const icon = await readFile(new URL("cocheck-icon.svg", ASSETS), "utf8");
    // icon: translate(26 24) scale(.7) about the paths' own origin; rig: translate(P) scale(S) translate(-41,-41)
    const [, tx, ty, sc] = /translate\((\S+) (\S+)\) scale\((\S+)\)/.exec(icon)!.map(Number);
    const P = /\.ild-p\{transform:translate\(([\d.]+)px,([\d.]+)px\)\}/.exec(LOADING_CSS)!.slice(1).map(Number);
    const S = Number(/\.ild-s\{transform:scale\(([\d.]+)\)\}/.exec(LOADING_CSS)![1]);
    assert.equal(S, sc);
    near([P[0]! - S * 41, P[1]! - S * 41], [tx!, ty!], 1e-9, "rest pose vs the icon");
    // the widths and caps are the icon's; the colours are the page's ink (rim and handle) and its lighter sky-deep (glint), readable on the light page
    for (const [cls, stroke, width, cap] of [["rim", "var(--ink,#1c2740)", 14, "round"], ["glint", "var(--sky-deep,#4f86b0)", 7, "round"], ["neck", "var(--ink,#1c2740)", 11, "butt"], ["grip", "var(--ink,#1c2740)", 22, "round"]] as const) {
      assert.match(LOADING_CSS, new RegExp(`\\.ild-${cls}\\{fill:none;stroke:${stroke.replace(/[()]/g, "\\$&")};stroke-width:${width};stroke-linecap:${cap}\\}`));
      assert.match(icon, new RegExp(`stroke-width="${width}"`));
    }
  });

  it("the asset JSONs stay exactly as designed (the generator drops the tile and recolours; the files keep their Background layer)", async () => {
    const { createHash } = await import("node:crypto");
    const sha = async (f: string) => createHash("sha256").update(await readFile(new URL(`loaders/${f}`, ASSETS))).digest("hex");
    assert.equal(await sha("loader-orbit.json"), "5589000468774017397e9921157be82af7e0dd8e68f3102dcd8231ce55b5033f");
    assert.equal(await sha("loader-spin.json"), "ebdb398e36c8dd039f91ed109fd1c4f664bd1f645a457483d44586fd10a5c170");
    assert.equal(await sha("icon-intro.json"), "426524b802fa0434a8a3279bf9ee625d6df35526ef1d49f3669b285e1f267e2b");
    const css = loaderCss(await json("loader-orbit.json"), await json("loader-spin.json"));
    assert.ok((await json("loader-orbit.json")).layers.some((l: { nm: string }) => l.nm === "Background"));
    assert.doesNotMatch(css, /#1c2740\}|fill:#/, "the Background layer's fill made it into the CSS");
    assert.match(css, /\.ild-rim\{fill:none;stroke:var\(--ink,#1c2740\);stroke-width:14;stroke-linecap:round\}/, "the stroke rules come from the generator");
  });

  it("reduced motion: the same transparent mark holds still at rest on both pages", async () => {
    assert.equal(LOADING_MOTION_CSS, "@media (prefers-reduced-motion:reduce){.iload-mark *{animation:none!important}}");
    // the still rule must beat every animation rule; ".iload-mark *" (0,1,0) loses to ".iload-mark .ild-p" (0,2,0) unless important
    for (const m of LOADING_CSS.matchAll(/(\.iload-mark \.ild-\w)\{animation:/g)) assert.match(LOADING_MOTION_CSS, /animation:none!important/, `${m[1]} would keep moving`);
    const css = await readFile(new URL("review.css", ASSETS), "utf8");
    assert.match(css.trimEnd(), /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important;transition:none!important\}\}$/);
    assert.ok(renderGenericPage({ schema: "cocheck.timeline/1", task: 1, requests: [], missing: [], unplaced: [], expired: null, hosts: [] } as never, "t").includes(LOADING_MOTION_CSS));
  });
});

describe("the choreography: one clock, two loaders taking turns", () => {
  it("both loaders play, never twice the same loader in a row for the spin, and the cycle is not one loader repeated", () => {
    assert.ok(SEQUENCE.includes("orbit") && SEQUENCE.includes("spin"));
    for (let i = 0; i < SEQUENCE.length; i++) if (SEQUENCE[i] === "spin") assert.notEqual(SEQUENCE[(i + 1) % SEQUENCE.length], "spin");
  });

  it("each loader's own frames play as its JSON says (lens and grip within 1e-6 of the Lottie pose), outside the hand-off holds", async () => {
    const O = await json("loader-orbit.json"), Sp = await json("loader-spin.json");
    const m = loaderMotion(O, Sp);
    const lay = (a: { layers: Array<{ nm: string; ks: Record<string, { a: number; k: unknown }> }> }, n: string) => a.layers.find((l) => l.nm === n)!;
    const orb = lay(O, "Orbit"), mag = lay(O, "Magnifier"), han = lay(Sp, "Handle");
    let F = 0;
    for (const part of SEQUENCE) {
      const len = part === "orbit" ? O.op : Sp.op;
      for (let f = 0; f <= len; f += 0.5) {
        let lens: V, grip: V;
        if (part === "orbit") {
          // Lottie: orbit null at p turned r, the magnifier hung at its p and turned back by its own r (-r), scale s, anchor 41
          const r = at(lkeys(orb.ks.r!), f)[0]!, mr = at(lkeys(mag.ks.r!), f)[0]!, s = (mag.ks.s!.k as V)[0]! / 100;
          lens = add(orb.ks.p!.k as V, rot(r, mag.ks.p!.k as V));
          grip = add(lens, mul(s, rot(r + mr, [59, 59])));
        } else {
          if (f < 6 || f > 76) continue; // the hand-off holds: the hang eases in and out here (next test)
          lens = at(lkeys(han.ks.p!), f);
          grip = add(lens, mul(at(lkeys(han.ks.s!), f)[0]! / 100, rot(at(lkeys(han.ks.r!), f)[0]!, [59, 59])));
        }
        const got = rig(m, F + f);
        near(got.lens, lens, 1e-6, `${part} lens at frame ${f}`); near(got.grip, grip, 1e-6, `${part} grip at frame ${f}`);
      }
      F += len;
    }
  });

  it("no jump where one loader hands off to the other, nor at the cycle's wrap", async () => {
    const m = loaderMotion(await json("loader-orbit.json"), await json("loader-spin.json"));
    const O = await json("loader-orbit.json"), Sp = await json("loader-spin.json");
    let F = 0;
    const cuts: number[] = [];
    for (const part of SEQUENCE) { cuts.push(F); F += part === "orbit" ? O.op : Sp.op; }
    assert.equal(F, m.frames);
    const e = 1e-4;
    for (const c of cuts) {
      const before = rig(m, c === 0 ? m.frames - e : c - e), after = rig(m, c + e);
      near(before.lens, after.lens, 1e-2, `lens across the cut at frame ${c}`); near(before.grip, after.grip, 1e-2, `grip across the cut at frame ${c}`);
    }
    // without the eased hang the orbit's 5-unit offset would jump at each cut; the rig moves it over the spin loader's holds instead
    const spinStart = cuts[SEQUENCE.indexOf("spin")]!;
    near(rig(m, spinStart).lens, [59.7, 52.7], 1e-9, "the spin starts where the orbit left the lens");
    near(rig(m, spinStart + 6).lens, [54.7, 52.7], 1e-9, "and is at the icon's rest pose when the spin loader moves");
  });

  it("every loader in the page shares one clock: the review page aligns each widget's animations to the page's timeline", async () => {
    const src = await readFile(new URL("review.js", ASSETS), "utf8");
    assert.match(src, /a\.startTime = 0/);
    assert.match(src, /typeof requestAnimationFrame !== 'function'/, "the alignment is skipped where the page has no animation API");
  });
});
