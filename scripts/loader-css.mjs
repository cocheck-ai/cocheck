#!/usr/bin/env node
// The loading widget's motion, made from the two Lottie loaders in src/timeline/rail/assets/loaders/ (bodymovin JSON, read as data only:
// nothing in them is evaluated). `node scripts/loader-css.mjs` prints the keyframes that LOADING_CSS in src/timeline/loading.ts and
// review.css carry verbatim; test/timeline-loader-motion.test.ts checks they still match the JSON.
//
// One rig plays both loaders (the widget's SVG in loading.ts), without their Background tile and recoloured for the page (STROKES):
//   translate(P) rotate(R) translate(D) rotate(-R) scale(S) [lens]  and the same plus rotate(H) for the handle; each factor is one <g>.
// Orbit loader: the null "Orbit" turns R about P with the magnifier hung D off it and turned back by -R, so it circles upright.
// Spin loader:  P and S ease the magnifier to the tile's centre and back while the handle turns H once around the lens.
// They take turns on one clock (SEQUENCE). The orbit loader's hang D is 5 units off the icon's rest pose and the spin loader starts and ends
// at rest, so D eases in and out over the spin loader's own opening and closing holds: the hand-off is seamless, not a 5-unit jump.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SEQUENCE = ["spin", "orbit", "spin", "orbit", "orbit"];

// The loaders draw the app icon, navy tile and all. On the page the widget is transparent: the Background
// layer is not drawn, and the strokes, coloured for the navy tile, take the page's ink and its lighter sky-deep instead. The JSON keeps both.
export const DROPPED_LAYERS = ["Background"];
/** the magnifier's groups: the rig's class for each, and the colour it takes on the page (page token, with the value for a page without one) */
export const STROKES = {
  Lens: { cls: "ild-rim", colour: "var(--ink,#1c2740)" },
  Glint: { cls: "ild-glint", colour: "var(--sky-deep,#4f86b0)" },
  Neck: { cls: "ild-neck", colour: "var(--ink,#1c2740)" },
  Grip: { cls: "ild-grip", colour: "var(--ink,#1c2740)" },
};

const FEATURES = { layer: new Set([3, 4]), shape: new Set(["gr", "sh", "st", "fl", "rc", "tr", "tm"]) };

/** Throws unless the animation uses only what this rig plays: shape and null layers, no assets, no expressions, no 3D, no masks or effects. */
export function checkPlayable(anim, name) {
  const fail = (why) => { throw new Error(`${name}: ${why}`); };
  if (!anim || typeof anim !== "object" || anim.w !== 128 || anim.h !== 128) fail("not a 128x128 animation");
  if (Array.isArray(anim.assets) && anim.assets.length) fail("has assets");
  if (anim.ddd) fail("is 3D");
  const walk = (v, at) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "x" && typeof x === "string") fail(`expression at ${at}`); walk(x, `${at}.${k}`); }
  };
  walk(anim, "");
  for (const l of anim.layers) {
    if (!FEATURES.layer.has(l.ty)) fail(`layer type ${l.ty}`);
    if (l.masksProperties || l.ef || l.tt || l.td || l.ddd) fail(`layer ${l.nm} has masks, effects, mattes or 3D`);
    const shapes = (s) => s.forEach((x) => { if (!FEATURES.shape.has(x.ty)) fail(`shape type ${x.ty}`); if (x.it) shapes(x.it); });
    shapes(l.shapes || []);
  }
}

const layer = (anim, nm) => anim.layers.find((l) => l.nm === nm) ?? (() => { throw new Error(`no layer ${nm}`); })();
/** Keyframes of a transform property as [{t, s, e}] where e is the easing to the next key; a static property is one key at frame 0. */
function keys(prop) {
  if (!prop.a) return [{ t: 0, s: [].concat(prop.k), e: null }];
  return prop.k.map((k) => ({ t: k.t, s: k.s, e: k.h ? "hold" : k.o ? [k.o.x[0], k.o.y[0], k.i.x[0], k.i.y[0]] : null }));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function loaderMotion(orbitAnim, spinAnim) {
  checkPlayable(orbitAnim, "orbit loader"); checkPlayable(spinAnim, "spin loader");
  const O = layer(orbitAnim, "Orbit"), M = layer(orbitAnim, "Magnifier"), H = layer(spinAnim, "Handle"), L = layer(spinAnim, "Lens");
  if (M.parent !== O.ind) throw new Error("orbit loader: the magnifier no longer hangs from the orbit");
  for (const p of ["p", "s"]) if (!same(H.ks[p], L.ks[p])) throw new Error(`spin loader: handle and lens ${p} differ`);
  if (!same(M.ks.a.k, H.ks.a.k) || !same(L.ks.a.k, H.ks.a.k) || !same(O.ks.a.k, [0, 0, 0])) throw new Error("anchors moved");
  const orbit = { len: orbitAnim.op - orbitAnim.ip, R: keys(O.ks.r), C: keys(M.ks.r), P: O.ks.p.k, D: M.ks.p.k, S: M.ks.s.k };
  const spin = { len: spinAnim.op - spinAnim.ip, P: keys(H.ks.p), S: keys(H.ks.s), Hr: keys(H.ks.r) };
  if (orbit.R.length !== 2 || orbit.C.length !== 2 || orbit.R[1].s[0] !== 360 || orbit.C[1].s[0] !== -360 || !same(orbit.R[0].e, orbit.C[0].e)) throw new Error("orbit loader: not one turn and its counter-turn");
  if (!same(spin.P[0].s, orbit.P) || !same(spin.S[0].s, orbit.S) || !same(spin.P.at(-1).s, orbit.P)) throw new Error("spin loader: no longer starts and ends at the orbit's centre and scale");
  const rest = { P: orbit.P, S: orbit.S };

  const tracks = { P: [], R: [], D: [], C: [], S: [], H: [] };
  const put = (name, t, v, e) => { const tr = tracks[name]; if (tr.length && tr.at(-1).t === t) tr.pop(); tr.push({ t, v, e }); };
  let F = 0, R0 = 0, H0 = 0;
  for (const part of SEQUENCE) {
    if (part === "orbit") {
      for (const k of orbit.R) put("R", F + k.t, R0 + k.s[0], k.e);
      for (const k of orbit.C) put("C", F + k.t, -R0 + k.s[0], k.e);
      put("P", F, rest.P, null); put("S", F, rest.S, null); put("D", F, orbit.D, null); put("H", F, H0, null);
      F += orbit.len; R0 += 360;
    } else {
      for (const k of spin.P) put("P", F + k.t, k.s, k.e);
      for (const k of spin.S) put("S", F + k.t, k.s, k.e);
      for (const k of spin.Hr) put("H", F + k.t, H0 + k.s[0], k.e);
      put("R", F, R0, null); put("C", F, -R0, null);
      // the hang eases off over the opening hold and back on over the closing hold, with the spin loader's own easing
      const open = spin.P[1], close = spin.P.at(-2);
      if (!same(open.s, spin.P[0].s) || !same(close.s, spin.P.at(-1).s)) throw new Error("spin loader: no opening or closing hold for the hand-off");
      put("D", F, orbit.D, spin.P[0].e); put("D", F + open.t, [0, 0, 0], null); put("D", F + close.t, [0, 0, 0], close.e);
      F += spin.len; H0 += spin.Hr.at(-1).s[0];
      put("D", F, orbit.D, null);
    }
  }
  // the last values of each track land on the cycle's end; the turns end on whole turns, so the wrap to frame 0 is seamless
  for (const name of Object.keys(tracks)) { const last = tracks[name].at(-1); if (last.t !== F) put(name, F, last.v, null); }
  if (R0 % 360 || H0 % 360) throw new Error("the cycle does not end on whole turns");
  return { frames: F, fps: orbitAnim.fr, tracks, rest };
}

const num = (n) => String(Math.round(n * 1000) / 1000).replace(/^(-?)0\./, "$1.");
const pct = (t, F) => `${num((t / F) * 100)}%`;
const css = {
  P: (v) => `translate(${num(v[0])}px,${num(v[1])}px)`, D: (v) => `translate(${num(v[0])}px,${num(v[1])}px)`,
  R: (v) => `rotate(${num(v)}deg)`, C: (v) => `rotate(${num(v)}deg)`, H: (v) => `rotate(${num(v)}deg)`, S: (v) => `scale(${num(v[0] / 100)})`,
};
const ease = (e) => (e === null || e === "hold" ? (e === "hold" ? "step-end" : "linear") : `cubic-bezier(${e.map(num).join(",")})`);

/** One stroke rule per magnifier group, its width and cap from the JSON (the same in both loaders), its colour from STROKES. */
function strokeCss(orbitAnim, spinAnim) {
  const groups = (anim, layers) => layers.flatMap((nm) => layer(anim, nm).shapes);
  const caps = { 1: "butt", 2: "round", 3: "square" };
  const fromOrbit = groups(orbitAnim, ["Magnifier"]), fromSpin = groups(spinAnim, ["Handle", "Lens"]);
  for (const nm of DROPPED_LAYERS) { layer(orbitAnim, nm); layer(spinAnim, nm); }
  const drawn = [...orbitAnim.layers, ...spinAnim.layers].filter((l) => l.ty === 4 && !DROPPED_LAYERS.includes(l.nm)).map((l) => l.nm);
  if (drawn.some((nm) => !["Magnifier", "Handle", "Lens"].includes(nm))) throw new Error(`a drawn layer the rig does not know: ${drawn}`);
  return Object.entries(STROKES).map(([nm, { cls, colour }]) => {
    const st = (gs) => { const g = gs.find((x) => x.nm === nm); const s = g && g.it.find((x) => x.ty === "st"); if (!s) throw new Error(`no stroke for ${nm}`); return s; };
    const a = st(fromOrbit), b = st(fromSpin);
    if (a.w.a || a.w.k !== b.w.k || a.lc !== b.lc || g_fill(fromOrbit, nm)) throw new Error(`${nm}: the loaders disagree on its stroke, or it is filled`);
    return `.${cls}{fill:none;stroke:${colour};stroke-width:${a.w.k};stroke-linecap:${caps[a.lc]}}`;
  }).join("\n");
}
const g_fill = (gs, nm) => gs.find((x) => x.nm === nm).it.some((x) => x.ty === "fl");

/** The CSS: the strokes, then one keyframes rule and one animation per factor of the rig, all on the same duration so they stay in step. */
export function loaderCss(orbitAnim, spinAnim) {
  const m = loaderMotion(orbitAnim, spinAnim);
  const dur = `${num(m.frames / m.fps)}s`;
  const out = [strokeCss(orbitAnim, spinAnim)];
  for (const [name, tr] of Object.entries(m.tracks)) {
    const id = `ild-${name.toLowerCase()}`;
    out.push(`.iload-mark .${id}{animation:${id} ${dur} infinite}`);
    out.push(`@keyframes ${id}{${tr.map((k) => `${pct(k.t, m.frames)}{transform:${css[name](k.v)};animation-timing-function:${ease(k.e)}}`).join("")}}`);
  }
  return out.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(fileURLToPath(import.meta.url), "..", "..", "src", "timeline", "rail", "assets", "loaders");
  const read = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  process.stdout.write(loaderCss(read("loader-orbit.json"), read("loader-spin.json")) + "\n");
}
