import { type El, child } from "./xml.ts";

/**
 * Where a shape sits on its slide, in EMU, read from the XML alone (the PowerPoint connector draws boxes from it).
 * The frame resolves through slide, layout, master (placeholders); group `chOff`/`chExt` scaling (and a group's own
 * rotation and flips) is applied; a rotated shape gets the bounding box of its rotated rectangle, which is loose but
 * contains the shape. Anything that cannot be resolved is `undefined`: no frame, never a guess.
 */
export interface Frame { x: number; y: number; w: number; h: number }

/** An `a:xfrm`: offset, extent, rotation (degrees), flips; a group's also carries its child space. */
export interface Xfrm {
  x: number; y: number; cx: number; cy: number;
  rot: number;
  flipH: boolean; flipV: boolean;
  chX?: number; chY?: number; chCx?: number; chCy?: number;
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** The transform of a shape element: its `xfrm` child, or the one inside its `spPr` / `grpSpPr`; undefined when it has none or a malformed one. */
export function readXfrm(el: El): Xfrm | undefined {
  const x = child(el, "xfrm") ?? el.children.filter((c) => /Pr$/.test(c.name)).map((c) => child(c, "xfrm")).find((v) => v !== undefined);
  if (!x) return undefined;
  const off = child(x, "off"), ext = child(x, "ext");
  const ox = num(off?.attrs["x"]), oy = num(off?.attrs["y"]), cx = num(ext?.attrs["cx"]), cy = num(ext?.attrs["cy"]);
  if (ox === undefined || oy === undefined || cx === undefined || cy === undefined || cx < 0 || cy < 0) return undefined;
  const out: Xfrm = { x: ox, y: oy, cx, cy, rot: (num(x.attrs["rot"]) ?? 0) / 60000, flipH: x.attrs["flipH"] === "1" || x.attrs["flipH"] === "true", flipV: x.attrs["flipV"] === "1" || x.attrs["flipV"] === "true" };
  const co = child(x, "chOff"), ce = child(x, "chExt");
  if (co && ce) {
    const [a, b, c, d] = [num(co.attrs["x"]), num(co.attrs["y"]), num(ce.attrs["cx"]), num(ce.attrs["cy"])];
    if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
    Object.assign(out, { chX: a, chY: b, chCx: c, chCy: d });
  }
  return out;
}

type Pt = { x: number; y: number };

/** A point in a group's child space, carried into the space the group sits in: scaled by ext/chExt, then flipped and rotated about the group's centre. */
function throughGroup(g: Xfrm, p: Pt): Pt {
  const sx = g.chCx ? g.cx / g.chCx : 1, sy = g.chCy ? g.cy / g.chCy : 1;
  const qx = g.x + (p.x - (g.chX ?? g.x)) * sx, qy = g.y + (p.y - (g.chY ?? g.y)) * sy;
  const cx = g.x + g.cx / 2, cy = g.y + g.cy / 2;
  let dx = qx - cx, dy = qy - cy;
  if (g.flipH) dx = -dx;
  if (g.flipV) dy = -dy;
  const a = (g.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** The slide-space bounding box of a shape's own transform, inside `groups` (outermost first). */
export function frameOf(own: Xfrm, groups: Xfrm[]): Frame {
  const a = (own.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const cx = own.x + own.cx / 2, cy = own.y + own.cy / 2;
  let pts: Pt[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const dx = (u! * own.cx) / 2, dy = (v! * own.cy) / 2;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  });
  for (let i = groups.length - 1; i >= 0; i--) pts = pts.map((p) => throughGroup(groups[i]!, p));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export interface Ph { type: string | undefined; idx: string | undefined }

/** A shape's placeholder identity (`p:nvPr/p:ph`), or undefined when it is not a placeholder. */
export function placeholderOf(el: El): Ph | undefined {
  for (const c of el.children) {
    if (!/^nv.*Pr$/.test(c.name)) continue;
    const ph = child(child(c, "nvPr") ?? { name: "", attrs: {}, children: [], text: "" }, "ph");
    if (ph) return { type: ph.attrs["type"], idx: ph.attrs["idx"] };
  }
  return undefined;
}

/** A layout placeholder's type is the master's key: titles share one, every body-like kind shares another. */
const masterKey = (type: string | undefined): string => (type === "title" || type === "ctrTitle" ? "title" : type === "dt" || type === "ftr" || type === "sldNum" ? type : "body");

/** Top-level placeholder shapes of a layout or master (children of `spTree`, through AlternateContent). */
function placeholders(root: El | undefined): { ph: Ph; el: El }[] {
  const out: { ph: Ph; el: El }[] = [];
  const visit = (e: El): void => {
    for (const c of e.children) {
      if (c.name === "sp") { const ph = placeholderOf(c); if (ph) out.push({ ph, el: c }); }
      else if (c.name === "AlternateContent") { const pick = child(c, "Choice") ?? child(c, "Fallback"); if (pick) visit(pick); }
    }
  };
  const tree = root ? child(child(root, "cSld") ?? root, "spTree") : undefined;
  if (tree) visit(tree);
  return out;
}

/**
 * The transform a slide placeholder inherits: the layout's placeholder with the same `idx` (else the same type), and when that has no
 * transform of its own, the master's placeholder of the same kind. Undefined when the chain ends without one.
 */
export function inheritedXfrm(ph: Ph, layout: El | undefined, master: El | undefined): Xfrm | undefined {
  const type = ph.type ?? "obj";
  const lay = placeholders(layout);
  const byIdx = ph.idx !== undefined ? lay.filter((l) => l.ph.idx === ph.idx) : [];
  const byType = lay.filter((l) => (l.ph.type ?? "obj") === type && (ph.idx === undefined || l.ph.idx === undefined || byIdx.length === 0));
  const hit = byIdx.length === 1 ? byIdx[0] : byIdx.length === 0 && byType.length === 1 ? byType[0] : undefined;
  const own = hit ? readXfrm(hit.el) : undefined;
  if (own) return own;
  const key = masterKey(hit ? hit.ph.type : ph.type);
  const mas = placeholders(master).filter((m) => masterKey(m.ph.type) === key);
  return mas.length === 1 ? readXfrm(mas[0]!.el) : undefined;
}
