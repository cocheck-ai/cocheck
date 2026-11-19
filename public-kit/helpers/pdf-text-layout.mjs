// The page model behind pdf-text.mjs (public-kit/spec/v1.md, "Helpers"): pure functions over Mozilla pdf.js `getTextContent` items (and the page's
// operator list) that read a page the way macOS PDFKit read it when CoCheck used it (the shapes the connectors were built on): text runs with
// rectangles (and per-letter `chars` on heading-shaped runs), and the ordered paragraph finder. Pixels are at SCALE x the displayed page size,
// origin top-left, rotation applied.
// No I/O and no pdf.js import: the caller (pdf-text.mjs, in its own child process) runs pdf.js and passes the items in. Types in pdf-text-layout.d.mts.
//
// HOW LINES ARE MADE. PDFKit reads a page as lines (`page.string` joins them with newlines), and splits a line into separate runs where a wide gap
// separates its glyphs (the cells of a table row). A line here is the items between two pdf.js `hasEOL` marks, also cut where a glyph item's
// baseline moves off the line, and a run takes its line's full height.
//
// WHERE A RUN ENDS. PDFKit's own segmentation is not published and looks at the whole line. This keeps the rules that matched it on the PDFs Office
// prints (the parity corpus of the change that made pdf.js the only reader): a gap between two glyph items wider than GAP_EM font sizes, or a step back of more than
// BACK_EM, ends a run; a bullet stays with the text after it across a list indent of up to BULLET_EM; and a line whose every word is a column
// letter (one to three capitals: Excel's printed column headings) is one run, as PDFKit keeps it, so each letter can be tied to its column.
//
// WHERE A CHARACTER SITS. pdf.js's text items carry no position per character, so each character takes the place of the glyph pdf.js shows for it
// (`glyphSpans`: the page's operator list walked with the PDF text state, `input.offsets`), stretched so the item still spans pdf.js's width. An item
// the glyphs cannot be matched to falls back to its font's advances (`input.widths`) and then to standard font proportions (Helvetica, Times).
//
// NOT MATCHED. PDFKit also orders a page's text by its own column analysis (a column of list numbers is read before the paragraphs beside it) and
// sometimes splits a line at no gap at all; this reads lines in content order. test/pdf-reader-golden.slow.test.ts pins what it reads.

export const SCALE = 2;
/** A gap between two glyph items wider than this many font sizes ends a run. */
export const GAP_EM = 1.0;
/** A step back between two glyph items of more than this many font sizes ends a run (pdf.js's own negative-space limit). */
export const BACK_EM = 0.2;
/** The widest list indent (font sizes) across which a bullet stays on its paragraph's run. */
export const BULLET_EM = 4;

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const isBlank = (s) => s.trim() === "";
const COLUMN_LETTERS = /^[A-Z]{1,3}$/;
const LIGATURES = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };

/** The quad of [a, b] along an item's baseline (PDF units from the item origin), from descent to ascent, mapped to pixels: its bounding box. */
function quad(page, item, a, b) {
  const g = page.items[item];
  const xs = [], ys = [];
  for (const [u, v] of [[a, g.desc], [b, g.desc], [a, g.asc], [b, g.asc]]) {
    const [x, y] = apply(g.m, u, v);
    xs.push(x);
    ys.push(y);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Whether item `b`'s baseline lies off item `a`'s line: moved across the text direction by more than the ascent of the lower one. */
function crossShift(input, a, b) {
  const ta = input.items[a].transform, tb = input.items[b].transform;
  const sa = Math.hypot(ta[0], ta[1]) || 1, sb = Math.hypot(tb[0], tb[1]) || 1;
  const nx = -ta[1] / sa, ny = ta[0] / sa;
  const shift = (tb[4] - ta[4]) * nx + (tb[5] - ta[5]) * ny;
  const asc = (i, size) => {
    const st = input.styles[input.items[i].fontName];
    return (st && Number.isFinite(st.ascent) && st.ascent !== 0 ? st.ascent : 0.8) * size;
  };
  return shift > 0 ? shift > asc(a, sa) : -shift > asc(b, sb);
}

/** Advance widths (per 1000 em) of ASCII 32..126 in Helvetica and Times-Roman, the shapes most office fonts share (Arial, Calibri; Times New Roman). */
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const TIMES = [250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541];
/**
 * The item's width shared among its characters. With the font's own advance widths (`own`: character to width per 1000 em, read from the page's
 * operator list) each character gets its advance and the rest of the item's width (character spacing) is shared equally; a character the map
 * lacks, or no map, falls back to proportional shares of the standard font of the item's family, anything outside ASCII counting as a digit.
 */
function charWidths(str, width, family, own, size) {
  if (own !== undefined && str.length > 0 && [...Array(str.length).keys()].every((i) => own[str[i]] !== undefined)) {
    const adv = [...Array(str.length).keys()].map((i) => (own[str[i]] * size) / 1000);
    const rest = width - adv.reduce((a, b) => a + b, 0);
    // justified text widens its spaces (word spacing): what the advances leave over goes to the spaces when the item has any
    const spaces = [...str].filter((c) => c === " ").length;
    const out = adv.map((a, i) => (spaces > 0 ? a + (str[i] === " " ? rest / spaces : 0) : a + rest / str.length));
    if (out.every((a) => a >= 0)) return out;
  }
  const table = family === "serif" ? TIMES : family === "monospace" ? null : HELV;
  const w = [...Array(str.length).keys()].map((i) => {
    const c = str.charCodeAt(i);
    return table === null ? 1 : c >= 32 && c <= 126 ? table[c - 32] : table[16];
  });
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => (x * width) / sum);
}

/**
 * Where each character of each text item starts and ends along the item's baseline (PDF units from the item's origin), from the glyphs pdf.js shows.
 * `ops` is a page's operator list (`page.getOperatorList()`), `OPS` pdf.js's operator codes, `items` the page's text items. The list is walked with
 * the PDF graphics and text state: CTM, text and line matrices, font size, character and word spacing, horizontal scale, leading and rise, all of
 * it saved by q and restored by Q (the text matrix is not part of that state), and a form XObject's matrix applied inside it. Each glyph advances by
 * its own width; the glyphs are matched in order to the items' characters (a space pdf.js put in for a gap spans that gap). One entry per item, null
 * for an item whose characters could not all be matched (the layout then shares its width by the font's advances). Null for the whole page when a
 * glyph this walk does not model is shown (vertical text): the layout then uses the font's advances for every item of that page.
 */
export function glyphSpans(ops, OPS, items) {
  const glyphs = [];
  let g = { ctm: [1, 0, 0, 1, 0, 0], size: 1, tc: 0, tw: 0, th: 1, rise: 0, leading: 0 };
  let tm = [1, 0, 0, 1, 0, 0], lm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  // a matrix argument comes as six numbers or as one six-element (typed) array, depending on the operator
  const matrix = (a) => Array.from(a.length === 1 ? a[0] : a).slice(0, 6);
  const moveTo = (x, y) => { lm = mul(lm, [1, 0, 0, 1, x, y]); tm = lm.slice(); };
  const show = (arr) => {
    for (const q of arr) {
      if (typeof q === "number") { tm = mul(tm, [1, 0, 0, 1, (-q / 1000) * g.size * g.th, 0]); continue; }
      if (typeof q !== "object" || q === null || !Number.isFinite(q.width) || q.vmetric) return false;
      const adv = ((q.width * g.size) / 1000 + g.tc + (q.isSpace ? g.tw : 0)) * g.th;
      const [x0, y0] = apply(mul(g.ctm, tm), 0, g.rise);
      tm = mul(tm, [1, 0, 0, 1, adv, 0]);
      const [x1, y1] = apply(mul(g.ctm, tm), 0, g.rise);
      glyphs.push({ u: typeof q.unicode === "string" ? q.unicode : "", x0, y0, x1, y1 });
    }
    return true;
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], a = ops.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push({ ...g }); break;
      case OPS.restore: g = stack.pop() ?? g; break;
      case OPS.paintFormXObjectBegin: stack.push({ ...g }); if (Array.isArray(a?.[0]) || ArrayBuffer.isView(a?.[0])) g = { ...g, ctm: mul(g.ctm, Array.from(a[0]).slice(0, 6)) }; break;
      case OPS.paintFormXObjectEnd: g = stack.pop() ?? g; break;
      case OPS.transform: g = { ...g, ctm: mul(g.ctm, matrix(a)) }; break;
      case OPS.beginText: tm = [1, 0, 0, 1, 0, 0]; lm = tm.slice(); break;
      case OPS.setTextMatrix: tm = matrix(a); lm = tm.slice(); break;
      case OPS.moveText: moveTo(a[0], a[1]); break;
      case OPS.setLeadingMoveText: g = { ...g, leading: -a[1] }; moveTo(a[0], a[1]); break;
      case OPS.nextLine: moveTo(0, -g.leading); break;
      case OPS.setLeading: g = { ...g, leading: a[0] }; break;
      case OPS.setCharSpacing: g = { ...g, tc: a[0] }; break;
      case OPS.setWordSpacing: g = { ...g, tw: a[0] }; break;
      case OPS.setHScale: g = { ...g, th: a[0] / 100 }; break;
      case OPS.setTextRise: g = { ...g, rise: a[0] }; break;
      case OPS.setFont: g = { ...g, size: a[1] }; break;
      case OPS.showText: case OPS.showSpacedText: if (!show(a[0])) return null; break;
      case OPS.nextLineShowText: moveTo(0, -g.leading); if (!show(a[0])) return null; break;
      case OPS.nextLineSetSpacingShowText: g = { ...g, tw: a[0], tc: a[1] }; moveTo(0, -g.leading); if (!show(a[2])) return null; break;
      default: break;
    }
  }
  let gi = 0;
  return items.map((it) => {
    if (it.str === "") return null;
    const t = it.transform, sz = Math.hypot(t[0], t[1]) || 1, dx = t[0] / sz, dy = t[1] / sz;
    const along = (x, y) => (x - t[4]) * dx + (y - t[5]) * dy;
    const out = [];
    // resynchronise after an item that could not be matched: the next glyphs that spell this item's first letters
    const head = it.str.replace(/^ +/, "").slice(0, 3);
    if (head !== "" && !(glyphs[gi]?.u !== undefined && it.str.trimStart().startsWith(glyphs[gi].u))) {
      for (let j = gi; j < Math.min(glyphs.length, gi + 400); j++) {
        let w = "", k = j;
        while (w.length < head.length && k < glyphs.length) w += glyphs[k++].u;
        if (w.startsWith(head)) { gi = j; break; }
      }
    }
    const start = gi;
    for (let c = 0; c < it.str.length;) {
      while (gi < glyphs.length && glyphs[gi].u === "") gi++;
      const q = glyphs[gi];
      if (q !== undefined && q.u !== "" && it.str.startsWith(q.u, c)) {
        for (let k = 0; k < q.u.length; k++) out.push([along(q.x0, q.y0), along(q.x1, q.y1)]);
        c += q.u.length;
        gi++;
      } else if (it.str[c] === " ") {
        out.push(null); // a space pdf.js put in for a gap: spans it, filled below
        c++;
      } else {
        gi = start;
        return null;
      }
    }
    for (let k = 0; k < out.length; k++) if (out[k] === null) out[k] = [k > 0 && out[k - 1] ? out[k - 1][1] : 0, out.slice(k + 1).find((x) => x)?.[0] ?? it.width];
    return out;
  });
}

/** The glyph spans of one item mapped onto [0, width]; null when there are none or they do not fit the item. */
function exactSpans(spans, n, width) {
  if (!Array.isArray(spans) || spans.length !== n || n === 0 || !spans.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
  const s0 = spans[0][0], e1 = spans[n - 1][1];
  if (!(e1 > s0) || !(width > 0)) return null;
  const k = width / (e1 - s0);
  if (k < 0.8 || k > 1.25) return null;
  return spans.map(([a, b]) => [(a - s0) * k, (b - s0) * k]);
}

/** The item's text with Latin ligatures spelled out (PDFKit reads "ﬁ" as "fi"), and for each output character the input character it came from. */
function spelled(str) {
  let s = "";
  const from = [];
  for (let i = 0; i < str.length; i++) {
    const l = LIGATURES[str[i]];
    if (l === undefined) { s += str[i]; from.push(i); }
    else for (const ch of l) { s += ch; from.push(i); }
  }
  return { s, from };
}

/**
 * Lays out one page: lines, runs and the page string, the way PDFKit reads it. `input` is { viewport: { width, height, transform }, items, styles }
 * from pdf.js at scale SCALE (`page.getViewport({ scale: SCALE })`, `page.getTextContent()`).
 */
export function layoutPage(input) {
  const vp = input.viewport;
  const page = { width: Math.round(vp.width), height: Math.round(vp.height), string: "", pos: [], items: [], runs: [], bands: [], viewport: vp };
  const bandItems = [[]];
  let prevGlyph = -1;
  // text whose middle lies outside the displayed page (cropped away) is not on the page: PDFKit reads none of it
  const onPage = (it) => {
    const t = it.transform;
    const size = Math.hypot(t[0], t[1]) || 1;
    const [x, y] = apply(vp.transform, t[4] + ((t[0] / size) * it.width) / 2 + (t[2] / size) * size * 0.3, t[5] + ((t[1] / size) * it.width) / 2 + (t[3] / size) * size * 0.3);
    return x >= 0 && y >= 0 && x <= vp.width && y <= vp.height;
  };
  const newBand = () => { if (bandItems[bandItems.length - 1].length > 0) bandItems.push([]); prevGlyph = -1; };
  input.items.forEach((it, i) => {
    if (it.str === "" || !onPage(it)) {
      if (it.hasEOL) newBand();
      return;
    }
    if (!isBlank(it.str)) {
      if (prevGlyph >= 0 && bandItems[bandItems.length - 1].length > 0 && crossShift(input, prevGlyph, i)) bandItems.push([]);
      prevGlyph = i;
    }
    bandItems[bandItems.length - 1].push(i);
    if (it.hasEOL) newBand();
  });
  const geo = new Map();
  const itemGeo = (i) => {
    let k = geo.get(i);
    if (k !== undefined) return k;
    const it = input.items[i];
    const t = it.transform;
    const size = Math.hypot(t[0], t[1]) || Math.hypot(t[2], t[3]) || 1;
    const norm = [t[0] / size, t[1] / size, t[2], t[3], t[4], t[5]];
    const st = input.styles[it.fontName];
    const asc = st && Number.isFinite(st.ascent) && st.ascent !== 0 ? st.ascent : 0.8;
    const desc = st && Number.isFinite(st.descent) ? st.descent : -0.2;
    k = page.items.length;
    page.items.push({ m: mul(vp.transform, norm), asc, desc });
    geo.set(i, k);
    return k;
  };
  let out = "";
  for (const band of bandItems) {
    if (band.length === 0) continue;
    const words = band.map((i) => input.items[i].str).join(" ").split(/\s+/).filter((w) => w !== "");
    const headings = words.length > 1 && words.every((w) => COLUMN_LETTERS.test(w));
    const parts = [];
    let cur = [];
    let lastEnd = null, lastSize = 0, lastOrigin = [0, 0], lastDir = [1, 0];
    for (const i of band) {
      const it = input.items[i];
      if (isBlank(it.str)) {
        if (cur.length > 0) cur.push(i);
        continue;
      }
      const t = it.transform;
      const size = Math.hypot(t[0], t[1]) || 1;
      if (lastEnd !== null && !headings) {
        const along = (t[4] - lastOrigin[0]) * lastDir[0] + (t[5] - lastOrigin[1]) * lastDir[1];
        const gap = along - lastEnd;
        const em = Math.min(size, lastSize);
        const bullet = gap > 0 && gap <= BULLET_EM * em && /^[^\p{L}\p{N}\s]{1,2}$/u.test(cur.map((k) => input.items[k].str).join("").trim());
        if (!bullet && (gap > GAP_EM * em || gap < -BACK_EM * em)) {
          parts.push(cur);
          cur = [];
        }
      }
      cur.push(i);
      lastOrigin = [t[4], t[5]];
      lastDir = [t[0] / size, t[1] / size];
      lastEnd = it.width;
      lastSize = size;
    }
    if (cur.length > 0) parts.push(cur);
    const bandNo = page.bands.length;
    let lo = Infinity, hi = -Infinity, crossY = true, pieces = 0;
    for (const part of parts) {
      while (part.length > 0 && isBlank(input.items[part[part.length - 1]].str)) part.pop();
      if (part.length === 0) continue;
      if (pieces > 0) out += " ";
      else if (out.length > 0) out += "\n";
      const runNo = page.runs.length;
      let text = "";
      for (const i of part) {
        const it = input.items[i];
        const k = itemGeo(i);
        const cw = charWidths(it.str, it.width, input.styles[it.fontName]?.fontFamily, input.widths?.[it.fontName], Math.hypot(it.transform[0], it.transform[1]) || 1);
        const starts = [];
        let at = 0;
        for (let c = 0; c < it.str.length; c++) { starts.push(at); at += cw[c]; }
        // exact glyph positions (pdf-text.mjs), stretched so the item still spans pdf.js's own width: inside an item the glyphs' places, at its ends
        // pdf.js's measure, which is where PDFKit puts a line's ends
        const exact = exactSpans(input.offsets?.[i], it.str.length, it.width);
        const sp = spelled(it.str);
        for (let c = 0; c < sp.s.length; c++) {
          const src = sp.from[c];
          // a spelled-out ligature's letters share its glyph
          page.pos[out.length + c] = exact !== null ? { run: runNo, item: k, a: exact[src][0], b: exact[src][1] } : { run: runNo, item: k, a: starts[src], b: starts[src] + cw[src] };
        }
        out += sp.s;
        text += sp.s;
        if (!isBlank(it.str)) {
          const [x0, y0, x1, y1] = quad(page, k, 0, it.width);
          const g = page.items[k];
          crossY = Math.abs(g.m[0]) >= Math.abs(g.m[1]);
          lo = Math.min(lo, crossY ? y0 : x0);
          hi = Math.max(hi, crossY ? y1 : x1);
        }
      }
      page.runs.push({ band: bandNo, text });
      pieces++;
    }
    if (pieces > 0) page.bands.push({ lo, hi, crossY });
  }
  page.string = out;
  for (let i = 0; i < page.string.length; i++) if (page.pos[i] === undefined) page.pos[i] = null;
  page.pos.length = page.string.length;
  return page;
}

/** The rectangle of the given characters of one band, its cross axis the band's; null when they hold no glyph. */
function bandRect(page, band, idx) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of idx) {
    const p = page.pos[i];
    if (!p || page.runs[p.run].band !== band) continue;
    const [a, b, c, d] = quad(page, p.item, p.a, p.b);
    x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d);
  }
  if (!Number.isFinite(x0)) return null;
  const bd = page.bands[band];
  if (bd.crossY) { y0 = bd.lo; y1 = bd.hi; } else { x0 = bd.lo; x1 = bd.hi; }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A run that looks like a printed heading (capital letters, digits and spaces only, at most 400 characters) gets `chars`, as the helper gives them. */
const HEADING = /^[A-Z0-9 ]+$/;

/** Every run of the page, trimmed, empty ones dropped; rectangles in pixels, not clipped (as the helper). Heading-shaped runs carry `chars`. */
export function pageRuns(page) {
  const idxByRun = new Map();
  page.pos.forEach((p, i) => {
    if (p && !isBlank(page.string[i])) (idxByRun.get(p.run) ?? idxByRun.set(p.run, []).get(p.run)).push(i);
  });
  const out = [];
  page.runs.forEach((r, k) => {
    const text = r.text.trim();
    if (text === "") return;
    const idx = idxByRun.get(k) ?? [];
    const rect = bandRect(page, r.band, idx);
    if (rect === null) return;
    const run = { text, ...rect };
    if (HEADING.test(text) && text.length <= 400) {
      run.chars = idx.map((i) => {
        const [x0, y0, x1, y1] = quad(page, page.pos[i].item, page.pos[i].a, page.pos[i].b);
        return { c: page.string[i], x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      });
    }
    out.push(run);
  });
  return out;
}

/**
 * The line rectangles of characters [loc, loc + len) of the page string, clipped to the page; lines with no visible text dropped (the helper's
 * `lineRects`): one rectangle per line the range touches, spanning only the selected glyphs, its height the line's. Per line, not per run: a
 * paragraph's words are contiguous in reading order, so pieces a run split cut apart on one line are still one selection (on the parity corpus
 * this matches PDFKit more often than a rectangle per run; PDFKit itself sometimes gives one per piece, scripts/lib/pdf-parity.ts counts those).
 */
export function lineRects(page, loc, len) {
  if (len <= 0) return [];
  const byBand = new Map();
  const order = [];
  for (let i = loc; i < Math.min(page.string.length, loc + len); i++) {
    const p = page.pos[i];
    if (!p || isBlank(page.string[i])) continue;
    const band = page.runs[p.run].band;
    if (!byBand.has(band)) { byBand.set(band, []); order.push(band); }
    byBand.get(band).push(i);
  }
  const out = [];
  for (const band of order) {
    const r = bandRect(page, band, byBand.get(band));
    if (r === null) continue;
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(page.width, r.x + r.w), y1 = Math.min(page.height, r.y + r.h);
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

// ---- find: a port of the helper's ordered strict paragraph search (native/pdfpages.swift, `--find`); the Swift is the spec ----

const SKIP = new Set([0x00ad, 0x200b, 0x200c, 0x200d, 0xfeff, 0xfffc, 0x2060]);
const HYPH = new Set([0x2d, 0x2010, 0x2011]);
function isWS(u) {
  if (u === 0x20 || u === 0x09 || u === 0x0a || u === 0x0d || u === 0x0b || u === 0x0c || u === 0xa0 || u === 0x2028 || u === 0x2029 || u === 0x202f || u === 0x3000 || u === 0x85) return true;
  return u >= 0x2000 && u <= 0x200a;
}
/** Applied to BOTH the page text and the query (Swift `normUnits`): each output unit carries the UTF-16 index it came from. */
export function normUnits(s, dropHyphens) {
  const u = [], o = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isWS(c) || SKIP.has(c)) continue;
    let out;
    switch (c) {
      case 0x2018: case 0x2019: case 0x201a: case 0x201b: case 0x2032: case 0x00b4: case 0x0060: out = [0x27]; break;
      case 0x201c: case 0x201d: case 0x201e: case 0x201f: case 0x2033: out = [0x22]; break;
      case 0x2013: case 0x2014: case 0x2012: case 0x2212: case 0x2015: case 0x2010: case 0x2011: out = [0x2d]; break;
      case 0xfb00: out = [0x66, 0x66]; break;
      case 0xfb01: out = [0x66, 0x69]; break;
      case 0xfb02: out = [0x66, 0x6c]; break;
      case 0xfb03: out = [0x66, 0x66, 0x69]; break;
      case 0xfb04: out = [0x66, 0x66, 0x6c]; break;
      case 0xfb05: case 0xfb06: out = [0x73, 0x74]; break;
      case 0x2026: out = [0x2e, 0x2e, 0x2e]; break;
      default: out = [c];
    }
    for (const x of out) {
      if (dropHyphens && HYPH.has(x)) continue;
      u.push(x);
      o.push(i);
    }
  }
  return { u, o };
}
const r1 = (v) => Math.round(v * 10) / 10;
const rectOut = (r) => ({ x: r1(r.x), y: r1(r.y), w: r1(r.w), h: r1(r.h) });
const isNL = (c) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
const sameUnits = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// The helper's list-marker rule (a space before the dot allowed: pdf.js puts one in where the label and its dot are apart).
const MARKER = /^\s*(\(?[0-9A-Za-z]{1,3} ?[.)]|[•·*\p{Co}\p{So}\p{Pd}]{1,2})?\s*$/u;
// A list label PDFKit reads apart from its paragraph (a column of "5.4", "5.a", "1.1)", "XIII." beside the text), so its page text never has one between
// two paragraphs; pdf.js keeps it inline. It counts as a marker only when it is a text item of its own (shown apart from the paragraph's first word):
// "1.5 " flowing into the words after it is a number in the text, not a label.
const LABEL = /^\s*(\d{1,3}(?:\.\d{1,3}){1,3}[.)]?|\d{1,3}\.[a-z][.)]?|[IVXLCDM]{1,7}[.)]|\(?[0-9A-Za-z]{1,4}[.)])\s*$/;

/**
 * The helper's `--find` over pages laid out by `layoutPage`: `queries` is every paragraph of the document in document order ({ id, text, want?,
 * spans? }). Same results as the helper (found, pass, pagebreak, one segment per page), rectangles rounded to 0.1 px.
 */
export function findInPages(pages, qs) {
  const texts = pages.map((p) => p.string);
  const stream = (dropH) => {
    const s = { u: [], pg: [], ix: [], pageStart: [] };
    texts.forEach((t, p) => {
      const n = normUnits(t, dropH);
      s.pageStart.push(s.u.length);
      for (let i = 0; i < n.u.length; i++) { s.u.push(n.u[i]); s.ix.push(n.o[i]); s.pg.push(p); }
    });
    s.pageStart.push(s.u.length);
    return s;
  };
  const streams = [stream(false), stream(true)];
  const key = (s, i) => s.pg[i] * 10_000_000 + s.ix[i];
  const lower = (s, k) => {
    let lo = 0, hi = s.u.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (key(s, m) > k) hi = m; else lo = m + 1; }
    return lo;
  };
  const firstHit = (hay, from, to, needle) => {
    const n = needle.length;
    if (n === 0 || to - from < n) return null;
    const f = needle[0];
    for (let i = from; i <= to - n; i++) {
      if (hay[i] === f) {
        let k = 1;
        while (k < n && hay[i + k] === needle[k]) k++;
        if (k === n) return i;
      }
    }
    return null;
  };
  const ranges = (s, a, b) => {
    const out = [];
    for (let p = s.pg[a]; p <= s.pg[b]; p++) {
      const lo = p === s.pg[a] ? s.ix[a] : 0;
      const hi = p === s.pg[b] ? s.ix[b] + 1 : texts[p].length;
      if (hi > lo) out.push({ page: p, loc: lo, len: hi - lo });
    }
    return out;
  };
  let cursorKey = -1, cursorPage = -1, unfound = 0;
  const HEAD = 600, SLACK = 500, MINSPLIT = 10, LONG = 25;
  const textOf = (q) => (typeof q?.text === "string" ? q.text : "");
  const followingUnits = (qi, need) => {
    const out = [];
    let k = qi + 1;
    while (out.length < need && k < qs.length) { out.push(...normUnits(textOf(qs[k]), false).u); k++; }
    return out;
  };
  const lineBounded = (st, a, b, qi) => {
    const ta = texts[st.pg[a]], tb = texts[st.pg[b]];
    let j = st.ix[a];
    while (j > 0) { if (isNL(ta.charCodeAt(j - 1))) break; j--; }
    if (cursorKey >= 0 && Math.floor(cursorKey / 10_000_000) === st.pg[a]) { const ce = (cursorKey % 10_000_000) + 1; if (ce > j && ce <= st.ix[a]) j = ce; }
    const pre = ta.slice(j, st.ix[a]);
    const own = () => { const pg = pages[st.pg[a]]; let k = st.ix[a] - 1; while (k >= j && isBlank(ta[k])) k--; return k >= j && pg.pos[k] !== null && pg.pos[st.ix[a]] !== null && pg.pos[k].item !== pg.pos[st.ix[a]].item; };
    if (!MARKER.test(pre) && !(LABEL.test(pre) && own())) return null;
    let e = st.ix[b] + 1;
    const from = e;
    while (e < tb.length) { if (isNL(tb.charCodeAt(e))) break; e++; }
    const rest = normUnits(tb.slice(from, e), false).u;
    if (rest.length > 0) {
      const next = followingUnits(qi, rest.length);
      const n = Math.min(rest.length, next.length);
      if (n === 0 || !sameUnits(rest.slice(0, n), next.slice(0, n))) return null;
    }
    return normUnits(pre, false).u.length;
  };
  const results = [];
  qs.forEach((q, qi) => {
    const id = typeof q?.id === "string" ? q.id : "";
    const text = textOf(q);
    const want = typeof q?.want === "boolean" ? q.want : true;
    const spans = Array.isArray(q?.spans) ? q.spans : [];
    const rec = { id, found: false, pass: "none", pagebreak: false, segments: [] };
    if (normUnits(text, false).u.length === 0) { rec.pass = "empty"; results.push(rec); return; }
    let matched = null;
    for (const [pi, dropH] of [false, true].entries()) {
      if (matched !== null) break;
      const st = streams[pi];
      const nq = normUnits(text, dropH);
      if (nq.u.length === 0) continue;
      const cur = lower(st, cursorKey);
      const s = firstHit(st.u, cur, st.u.length, nq.u);
      if (s !== null) {
        const slack = SLACK * (st.pg[s] - cursorPage);
        const lb = lineBounded(st, s, s + nq.u.length - 1, qi);
        if (s - cur - (lb ?? 0) <= slack + 2 * unfound && (nq.u.length >= LONG || lb !== null)) matched = { pass: pi, nq, k: nq.u.length, a: s, b: s, pagebreak: false };
      }
    }
    if (matched === null) {
      splitLoop: for (const [pi, dropH] of [false, true].entries()) {
        const st = streams[pi];
        const nq = normUnits(text, dropH);
        if (nq.u.length < 2 * MINSPLIT || texts.length < 2) continue;
        const cur = lower(st, cursorKey);
        for (let p = Math.max(0, cursorPage); p < texts.length - 1; p++) {
          const endP = st.pageStart[p + 1];
          for (let k = nq.u.length - MINSPLIT; k >= MINSPLIT; k--) {
            const a = endP - k;
            if (a < Math.max(cur, st.pageStart[p])) continue;
            if (!sameUnits(st.u.slice(a, endP), nq.u.slice(0, k))) continue;
            if (a - cur > SLACK * (p - cursorPage) + 2 * unfound) continue;
            const rest = nq.u.slice(k);
            const lo = st.pageStart[p + 1], hi = Math.min(st.pageStart[p + 2], lo + HEAD + rest.length);
            const h = firstHit(st.u, lo, hi, rest);
            if (h !== null) { matched = { pass: pi, nq, k, a, b: h, pagebreak: true }; break splitLoop; }
          }
        }
      }
    }
    if (matched === null) { unfound += normUnits(text, false).u.length; results.push(rec); return; }
    const m = matched;
    const st = streams[m.pass];
    const n = m.nq.u.length;
    const at = (i) => (m.pagebreak ? (i < m.k ? m.a + i : m.b + (i - m.k)) : m.a + i);
    const last = at(n - 1);
    cursorKey = key(st, last); cursorPage = st.pg[last]; unfound = 0;
    rec.found = true;
    rec.pass = m.pass === 0 ? "strict" : "nohyphen";
    rec.pagebreak = m.pagebreak;
    if (want) {
      const rangesOf = (lo, hi) => (m.pagebreak && lo < m.k && hi >= m.k ? [...ranges(st, at(lo), at(m.k - 1)), ...ranges(st, at(m.k), at(hi))] : ranges(st, at(lo), at(hi)));
      const byPage = new Map();
      const order = [];
      for (const r of rangesOf(0, n - 1)) {
        const rects = lineRects(pages[r.page], r.loc, r.len);
        if (rects.length === 0) continue;
        if (!byPage.has(r.page)) { order.push(r.page); byPage.set(r.page, []); }
        byPage.get(r.page).push(...rects);
      }
      const hl = new Map();
      for (const span of spans) {
        if (!Array.isArray(span) || span.length !== 2) continue;
        const ks = m.nq.o.flatMap((o, i) => (o >= span[0] && o < span[1] ? [i] : []));
        if (ks.length === 0) continue;
        for (const r of rangesOf(ks[0], ks[ks.length - 1])) {
          for (const x of lineRects(pages[r.page], r.loc, r.len)) (hl.get(r.page) ?? hl.set(r.page, []).get(r.page)).push(rectOut(x));
        }
      }
      for (const p of order) {
        const rs = byPage.get(p);
        const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y)), x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
        rec.segments.push({ page: p + 1, rect: rectOut({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }), highlights: hl.get(p) ?? [] });
      }
    }
    results.push(rec);
  });
  return { pages: pages.map((p, i) => ({ index: i + 1, width: p.width, height: p.height })), results };
}
