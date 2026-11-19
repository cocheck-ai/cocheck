/* The pure half of the review page's drawing: a View (src/timeline/render/types.ts) in, a plain description of each pane out.
   review.js turns the description into DOM; the tests run this file in node. No DOM here, no markup built. */
(function (root) {
  'use strict';
  var SHA = /^[0-9a-f]{64}$/;

  function flat(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); }
  /* The card clipper, ONE function: src/timeline/notes.ts (the model's cards) and the notes column of the page both use it.
     A card's text is cut at 240 characters; a pair of old and new words is cut around the first difference, both sides in one window. */
  var MAX_CARD_TEXT = 240, LEAD = 40;
  function clip(v) {
    if (v == null) return null;
    var f = String(v).replace(/\s+/g, ' ').trim();
    if (f === '') return null;
    return f.length > MAX_CARD_TEXT ? f.slice(0, MAX_CARD_TEXT - 1).replace(/\s+$/, '') + '\u2026' : f;
  }
  function clipPair(b, a) {
    var fb = b == null ? null : String(b).replace(/\s+/g, ' ').trim(), fa = a == null ? null : String(a).replace(/\s+/g, ' ').trim();
    if (fb === null || fb === '' || fa === null || fa === '' || (fb.length <= MAX_CARD_TEXT && fa.length <= MAX_CARD_TEXT)) return [clip(b), clip(a)];
    var d = 0;
    while (d < fb.length && d < fa.length && fb.charAt(d) === fa.charAt(d)) d++;
    var start = Math.max(0, d - LEAD);
    if (start > 0) { var sp = fb.lastIndexOf(' ', start + 10); if (sp >= Math.max(0, start - 20) && sp < d) start = sp + 1; }
    var room = MAX_CARD_TEXT - (start > 0 ? 1 : 0);
    function cut(t) { var body = t.length - start > room ? t.slice(start, start + room - 1).replace(/\s+$/, '') + '\u2026' : t.slice(start); return start > 0 ? '\u2026' + body : body; }
    return [cut(fb), cut(fa)];
  }
  /* The hover callout's words: a word-level diff of a change's public `before` and `after` strings, so any connector's change gets it.
     Segments in reading order, { k: 'same' | 'del' | 'add' | 'gap', t }: removed words before the added words that replace them, runs merged, and an
     unchanged run longer than 2 * DIFF_CTX + 1 words cut to DIFF_CTX words beside each change with one 'gap' (an ellipsis), so the card stays short.
     Common ends are trimmed first; the middle is a longest-common-subsequence diff when small enough, else all removed then all added. */
  var DIFF_CTX = 4, DIFF_CELLS = 200000;
  function words(t) { var f = flat(t); return f ? f.split(' ') : []; }
  function wordDiff(before, after) {
    var a = words(before), b = words(after), ops = [], p = 0, s = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    var A = a.slice(p, a.length - s), B = b.slice(p, b.length - s), i, j;
    for (i = 0; i < p; i++) ops.push(['same', a[i]]);
    if (A.length && B.length && A.length * B.length <= DIFF_CELLS) {
      var n = A.length, m = B.length, L = [];
      for (i = 0; i <= n; i++) L.push(new Array(m + 1).fill(0));
      for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      var dels = [], adds = [];
      var flush = function () { dels.forEach(function (w) { ops.push(['del', w]); }); adds.forEach(function (w) { ops.push(['add', w]); }); dels = []; adds = []; };
      i = 0; j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && A[i] === B[j]) { flush(); ops.push(['same', A[i]]); i++; j++; }
        else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) dels.push(A[i++]);
        else adds.push(B[j++]);
      }
      flush();
    } else {
      A.forEach(function (w) { ops.push(['del', w]); }); B.forEach(function (w) { ops.push(['add', w]); });
    }
    for (i = a.length - s; i < a.length; i++) ops.push(['same', a[i]]);
    var runs = [];
    ops.forEach(function (o) { var r = runs[runs.length - 1]; if (r && r.k === o[0]) r.w.push(o[1]); else runs.push({ k: o[0], w: [o[1]] }); });
    var out = [], changed = runs.some(function (r) { return r.k !== 'same'; }), max = 2 * DIFF_CTX + 1;
    runs.forEach(function (r, x) {
      if (r.k !== 'same' || !changed || r.w.length <= max) { out.push({ k: r.k, t: r.w.join(' ') }); return; }
      var first = x === 0, last = x === runs.length - 1, gap = { k: 'gap', t: '…' };
      if (!first) out.push({ k: 'same', t: r.w.slice(0, DIFF_CTX).join(' ') });
      out.push(gap);
      if (!last) out.push({ k: 'same', t: r.w.slice(r.w.length - DIFF_CTX).join(' ') });
    });
    return out;
  }
  /* ---- change-first drawing (feat/change-first-views). Pure: the page turns these descriptions into DOM. ---- */
  /* The page pads a box about 0.7% of the image width on every side, clipped to the picture; the result is in percent of the picture, ready for style left/top/width/height. */
  /* a box is drawn 0.7% of the picture width out from its rect at the sides, a quarter of that above and below: a connector's line or paragraph
     rect ends between two lines of text, and the outline (its offset and width are the page's own) already clears the glyphs, so a full pad
     there would lay the edge across the next line's capitals */
  var PAD_V = 0.25;
  function padBox(rect, w, h) {
    var P = w * 0.007, V = P * PAD_V, x0 = Math.max(0, rect.x - P), y0 = Math.max(0, rect.y - V), x1 = Math.min(w, rect.x + rect.w + P), y1 = Math.min(h, rect.y + rect.h + V);
    return { left: 100 * x0 / w, top: 100 * y0 / h, width: 100 * (x1 - x0) / w, height: 100 * (y1 - y0) / h };
  }
  /* The boxes of one side of one picture as drawn, so no edge runs along a neighbour's text: `list` is [{ rect, key }] in picture pixels, `key`
     the change. Boxes of the same change that overlap or touch once padded draw as one (their union). Two boxes of different changes stacked
     one over the other (or side by side), touching or overlapping by less than half the smaller one, keep their padding away from each other:
     the shared edge sits midway between them, minus a hair, so the two outlines meet in the gap between the lines and never cross either.
     A box inside another keeps its own padding. Returns, per entry of `list`, the drawn box in percent ({ left, top, width, height }), or null
     for a box drawn as part of an earlier one of its change. */
  function drawBoxes(list, w, h) {
    var P = w * 0.007, items = arr(list), out = items.map(function () { return null; }), groups = [];
    items.forEach(function (e, i) {
      var r = e && e.rect; if (!r || !(r.w > 0) || !(r.h > 0) || !(w > 0) || !(h > 0)) return;
      var g = { key: e.key, i: i, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
      for (var k = 0; k < groups.length; k++) {
        var o = groups[k];
        if (o.key !== g.key || g.x0 > o.x1 + 2 * P || o.x0 > g.x1 + 2 * P || g.y0 > o.y1 + 2 * P || o.y0 > g.y1 + 2 * P) continue;
        o.x0 = Math.min(o.x0, g.x0); o.y0 = Math.min(o.y0, g.y0); o.x1 = Math.max(o.x1, g.x1); o.y1 = Math.max(o.y1, g.y1);
        /* the grown union may now reach another group of the change: fold it in */
        for (var m = groups.length - 1; m >= 0; m--) {
          var q = groups[m]; if (q === o || q.key !== o.key || q.x0 > o.x1 + 2 * P || o.x0 > q.x1 + 2 * P || q.y0 > o.y1 + 2 * P || o.y0 > q.y1 + 2 * P) continue;
          o.x0 = Math.min(o.x0, q.x0); o.y0 = Math.min(o.y0, q.y0); o.x1 = Math.max(o.x1, q.x1); o.y1 = Math.max(o.y1, q.y1); o.i = Math.min(o.i, q.i); groups.splice(m, 1);
        }
        return;
      }
      groups.push(g);
    });
    var V = P * PAD_V, pad = groups.map(function (g) { return { x0: Math.max(0, g.x0 - P), y0: Math.max(0, g.y0 - V), x1: Math.min(w, g.x1 + P), y1: Math.min(h, g.y1 + V) }; });
    var hair = P * 0.25;
    function inside(a, b) { return a.x0 >= b.x0 && a.y0 >= b.y0 && a.x1 <= b.x1 && a.y1 <= b.y1; }
    groups.forEach(function (a, i) {
      groups.forEach(function (b, j) {
        if (j <= i || a.key === b.key || inside(a, b) || inside(b, a)) return;
        var ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        var minH = Math.min(a.y1 - a.y0, b.y1 - b.y0), minW = Math.min(a.x1 - a.x0, b.x1 - b.x0);
        /* stacked: they share columns, and meet (or nearly meet) in rows */
        if (ox > 0 && oy > -2 * P && oy < minH / 2) {
          var top = a.y0 <= b.y0 ? i : j, bot = top === i ? j : i, mid = (groups[top].y1 + groups[bot].y0) / 2;
          pad[top].y1 = Math.min(pad[top].y1, mid - hair); pad[bot].y0 = Math.max(pad[bot].y0, mid + hair);
        } else if (oy > 0 && ox > -2 * P && ox < minW / 2) {
          var lft = a.x0 <= b.x0 ? i : j, rgt = lft === i ? j : i, midx = (groups[lft].x1 + groups[rgt].x0) / 2;
          pad[lft].x1 = Math.min(pad[lft].x1, midx - hair); pad[rgt].x0 = Math.max(pad[rgt].x0, midx + hair);
        }
      });
    });
    groups.forEach(function (g, k) {
      var p = pad[k]; if (!(p.x1 > p.x0) || !(p.y1 > p.y0)) p = { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 };
      out[g.i] = { left: 100 * p.x0 / w, top: 100 * p.y0 / h, width: 100 * (p.x1 - p.x0) / w, height: 100 * (p.y1 - p.y0) / h };
    });
    return out;
  }
  /* ---- the v1 document (cocheck.changes/1) -> what the page draws. The page reads ONLY the document. ----
     panes come from pictures[] (CoCheck's own grid and text data from pictures[].private), every change and box from changes[].
     the page takes no drawing hint from a public field. The hints Office needs (a card of the notes column, a bare region mark, a speaker-notes picture)
     are `private` data (changes[].private.kind, pictures[].private.of), read only when the document says CoCheck drew it (source.by 'cocheck'). A stranger's
     change with kind 'card' or 'region', or a picture whose id ends in '/notes', is an ordinary change and draws as one. */
  /* cpic/<sha>: a connector's PNG, lifted out of its answer when the step was frozen and served by CoCheck from the task's sealed store */
  var SRC = /^(preview\/[0-9a-f]{64}|pdfpage\/[0-9a-f]{64}\/[0-9]+|cpic\/[0-9a-f]{64})$/;
  function arr(v) { return Array.isArray(v) ? v : []; }
  /* the page's own hint for a change, from private data; null unless the document is CoCheck's own. Kept for CoCheck's own drawing only (view-v1 marks a region the reviewer drew on a text, PDF or picture view as 'region', in CoCheck's own documents (and export
     mode's). No built-in connector sends `by: "cocheck"`, so no Office hint (a paragraph card, a deck's speaker notes) is read. */
  /* a cpic picture's pane picture; a whole page number (v1 `page`) rides along so the page can pair and scroll pages. The address stays cpic/<sha>. */
  function cpicPicture(sha, p) {
    var pic = { sha: sha, width: p.width, height: p.height, cpic: true };
    if (typeof p.page === 'number' && p.page >= 1 && Math.floor(p.page) === p.page) pic.page = p.page;
    if (pic.page && typeof p.pageCount === 'number' && p.pageCount >= pic.page && Math.floor(p.pageCount) === p.pageCount) pic.pageCount = p.pageCount;
    return pic;
  }
  function hintOf(ch, own) { return own && ch && ch.private && typeof ch.private === 'object' && typeof ch.private.kind === 'string' ? ch.private.kind : null; }
  function comment(ch) {
    var verb = ch.mark === 'added' ? 'Added' : ch.mark === 'removed' ? 'Removed' : null;
    return { head: typeof ch.label === 'string' && ch.label ? ch.label : null, verb: verb, before: flat(ch.before) || null, after: flat(ch.after) || null, text: typeof ch.text === 'string' && ch.text ? ch.text : null, lines: arr(ch.lines).filter(function (l) { return typeof l === 'string'; }).concat(moreLine(ch.more) ? [moreLine(ch.more)] : []) };
  }
  /* A card of the notes column: the full words of the change clipped by the model's own clipper. */
  function noteCard(ch) {
    var c = comment(ch), pair = clipPair(c.before, c.after), words = !!(pair[0] || pair[1]);
    return { place: c.head || '', verb: c.verb, before: pair[0], after: pair[1], text: c.text ? (words ? ' ' + c.text : c.text) : null };
  }
  /* ---- who made the document, the tally, the groups, the coverage line. Pure; the page draws the strings as text. ---- */
  var FRAME = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/v\/[0-9a-f]{32}$/;
  function sourceOf(s) {
    if (!s || typeof s !== 'object') return null;
    if ((s.by !== 'connector' && s.by !== 'cocheck') || typeof s.name !== 'string' || !s.name || s.name.length > 80 || (s.level !== 1 && s.level !== 2 && s.level !== 3)) return null;
    return s.nothingChanged === true ? { by: s.by, name: s.name, level: s.level, nothingChanged: true } : { by: s.by, name: s.name, level: s.level };
  }
  /* who drew the pictures, in the reader's words. A connector's pictures are "Drawn by <tool>" from the document's
     own picture renderedBy (spec v1 "General fields"), never the connector's internal id; with no renderedBy there is no line. CoCheck's own drawing
     (export mode included) is "Drawn by CoCheck from the text". A level-1 change list keeps "Change list from <name>". */
  function drawnBy(pictures) {
    var ps = arr(pictures);
    for (var i = 0; i < ps.length; i++) {
      var rb = ps[i] && ps[i].renderedBy, t = rb && typeof rb === 'object' && typeof rb.tool === 'string' ? rb.tool.trim() : '';
      if (t && t.length <= 80) return t;
    }
    return '';
  }
  function sourceLine(s, pictures) {
    if (s.by === 'cocheck') return 'Drawn by CoCheck from the text';
    if (s.level === 1) return 'Change list from ' + s.name;
    var tool = drawnBy(pictures);
    return tool ? 'Drawn by ' + tool : '';
  }
  var MARK_ORDER = ['added', 'removed', 'changed', 'moved', 'described'];
  /* "3 changed, 1 added": each mark's count, the most first (ties in the order added, removed, changed, moved, described) */
  function tallyLine(changes, own) {
    var n = {}, any = false;
    arr(changes).forEach(function (ch) { if (ch && hintOf(ch, own) !== 'region' && MARK_ORDER.indexOf(ch.mark) >= 0) { n[ch.mark] = (n[ch.mark] || 0) + 1; any = true; } });
    if (!any) return '';
    return MARK_ORDER.filter(function (m) { return n[m]; }).sort(function (a, b) { return n[b] - n[a] || MARK_ORDER.indexOf(a) - MARK_ORDER.indexOf(b); }).map(function (m) { return n[m] + ' ' + m; }).join(', ');
  }
  /* The changes as groups: each change that names a parent present in the list goes under it (to any depth, a cycle breaks at the first repeat); the others lead. */
  function groupChanges(changes) {
    var list = arr(changes).filter(function (ch) { return ch && typeof ch.id === 'string'; }), byId = {}, kids = {};
    list.forEach(function (ch) { byId[ch.id] = ch; });
    function parentOf(ch) { var p = typeof ch.parent === 'string' && ch.parent !== ch.id && byId[ch.parent] ? ch.parent : null; if (!p) return null; var q = p, n = 0; while (q && n++ <= list.length) { if (q === ch.id) return null; var up = byId[q].parent; q = typeof up === 'string' && byId[up] ? up : null; } return p; }
    var tops = [];
    list.forEach(function (ch) { var p = parentOf(ch); if (p) (kids[p] = kids[p] || []).push(ch); else tops.push(ch); });
    function build(ch) { return { change: ch, children: (kids[ch.id] || []).map(build) }; }
    return tops.map(build);
  }
  /* Every picture compared and matching (`unchanged`) with no change listed: only saved-file details differ (timestamps), so the page says so. */
  var NOTHING_VISIBLE = 'Nothing visible changed: both versions look the same.';
  /* the same line when there is no picture to look at. An empty list the connector vouches for: no status, nothing pending, no caveat */
  var NOTHING_CHANGED = 'Saved again: nothing changed.';
  /* a step recorded before its file had a connector gets its change list read later, from the copies CoCheck kept; the page says so */
  var READ_LATER = 'This change list was read later than the step, from the copies CoCheck kept.';
  /* spec v1.2 `issues`: at most this many are drawn, each cut to ISSUE_CHARS characters, then "and N more". Outside data: always drawn as text */
  var ISSUES_SHOWN = 50, ISSUE_CHARS = 300;
  /* Every issue of the document (document, pictures, changes), in document order, capped: { shown: [{ text, side?, where? }], total, more } or null when there is none */
  function issuesOf(doc) {
    doc = doc && typeof doc === 'object' ? doc : {};
    var all = [];
    function take(v) { arr(v).forEach(function (it) { if (it && typeof it === 'object' && typeof it.text === 'string' && it.text) all.push(it); }); }
    take(doc.issues);
    arr(doc.pictures).forEach(function (p) { if (p) take(p.issues); });
    arr(doc.changes).forEach(function (c) { if (c) take(c.issues); });
    if (!all.length) return null;
    var shown = all.slice(0, ISSUES_SHOWN).map(function (it) {
      var o = { text: it.text.length > ISSUE_CHARS ? it.text.slice(0, ISSUE_CHARS) + '\u2026' : it.text };
      if (it.side === 'before' || it.side === 'after') o.side = it.side;
      if (typeof it.where === 'string' && it.where) o.where = it.where.slice(0, ISSUE_CHARS);
      return o;
    });
    return { shown: shown, total: all.length, more: all.length - shown.length };
  }
  /* spec v1.2 `more`: "and N more", in place; the page never adds a place word of its own */
  function moreLine(n) { return typeof n === 'number' && n > 0 && Math.floor(n) === n ? 'and ' + n + ' more' : ''; }
  /* "2 changes have no place in the picture": changes with no box, where the picture can box (level 3 with a picture). A child inside its parent's box is placed. */
  function coverageLine(doc) {
    doc = doc && typeof doc === 'object' ? doc : {};
    var src = sourceOf(doc.source), level = src ? src.level : 3, own = !!src && src.by === 'cocheck';
    if (!arr(doc.changes).length && !(typeof doc.more === 'number' && doc.more > 0) && arr(doc.pictures).length && arr(doc.pictures).every(function (p) { return p && p.unchanged === true; })) return NOTHING_VISIBLE;
    /* only a connector whose hello opted in (recorded at capture on the envelope) vouches for an empty list with no picture; without it an empty list is no claim */
    if (src && src.nothingChanged === true && !arr(doc.changes).length && !arr(doc.pictures).length && doc.status === undefined && doc.pendingRetry === undefined && doc.pending !== true && doc.failed !== true && !arr(doc.caveats).length && !arr(doc.issues).length && !(typeof doc.more === 'number' && doc.more > 0)) return NOTHING_CHANGED; /* the lane rule's P3 (nothing-changed-rule.ts), word for word (status is tested against undefined: null, '' and 0 are statuses; test/timeline-nothing-changed-page-rule-parity.test.ts pins the pair): no level test, since a captured empty list is always drawn at level 1; an issue is a warning the line must not hide */
    if (level !== 3 || !arr(doc.pictures).length) return '';
    var changes = arr(doc.changes).filter(function (c) { return c && typeof c.id === 'string' && hintOf(c, own) !== 'region'; }), byId = {};
    arr(doc.changes).forEach(function (c) { if (c && typeof c.id === 'string') byId[c.id] = c; });
    var picIds = {}; arr(doc.pictures).forEach(function (p) { if (p && typeof p.id === 'string') picIds[p.id] = 1; });
    function boxed(c) { return arr(c.boxes).some(function (b) { return b && picIds[b.picture]; }); }
    var n = changes.filter(function (c) { var par = typeof c.parent === 'string' ? byId[c.parent] : null; return !boxed(c) && !(par && boxed(par)); }).length;
    return n === 0 ? '' : n + (n === 1 ? ' change has' : ' changes have') + ' no place in the picture';
  }
  /* The connector's status (spec v1.1, why a side could not be drawn) when it is about the file itself: the app showed a prompt instead of opening it, or would not open it.
     Shown as a finding on the change; other kinds (a hang, an app that is not there) stay with the view's limits. The evidence is the connector's own text. */
  function findingOne(st) {
    if (!st || typeof st !== 'object' || (st.kind !== 'prompt' && st.kind !== 'refused') || typeof st.evidence !== 'string' || !st.evidence) return undefined;
    return { kind: st.kind, text: st.evidence };
  }
  /* The document's status, or (spec v1.1) the status on a side's stand-in picture (no src: that side could not be drawn), joined in side order. */
  function findingOf(doc) {
    var d = findingOne(doc.status);
    if (d) return d;
    var got = arr(doc.pictures).filter(function (p) { return p && !p.src && findingOne(p.status); }).map(function (p) { return findingOne(p.status); });
    return got.length ? { kind: got[0].kind, text: got.map(function (f) { return f.text; }).join(' ') } : undefined;
  }
  /* A stand-in picture carries only a status: it is never a pane. */
  function standIn(p) { return !!(p && !p.src && p.status && typeof p.status === 'object'); }
  /* The sides the app would not open (a stand-in with a prompt or refused status), by kind: their empty pane says so, never "There is nothing here" (that is a deleted file) */
  function notOpenedOf(doc) {
    var out = {};
    arr(doc.pictures).forEach(function (p) { var f = standIn(p) ? findingOne(p.status) : undefined; if (f && (p.side === 'before' || p.side === 'after') && !out[p.side]) out[p.side] = f.kind; });
    return out;
  }
  /* The words in a pane with no picture: a side the app would not open says why; otherwise the file was not there (before) or is not there (after) */
  function emptyPaneText(scene, side) {
    var k = scene && scene.notOpened ? scene.notOpened[side] : undefined;
    if (k === 'prompt') return 'Not pictured: the app showed a prompt instead of opening this file.';
    if (k === 'refused') return 'Not pictured: the app did not open this file.';
    /* one word for a side that did not exist, not a sentence ("New" for any subject, not "new file") */
    return side === 'before' ? 'New' : 'Deleted';
  }
  function sceneOf(doc) {
    doc = doc && typeof doc === 'object' ? doc : {};
    /* the level is the connector's (the served source); a document with no source is drawn as level 3. The page draws no more than the level claims (1: cards only, 2: pictures unboxed, 3: boxes) */
    var source = sourceOf(doc.source), level = source ? source.level : 3, own = !!source && source.by === 'cocheck';
    var pics = level === 1 ? [] : arr(doc.pictures).filter(function (p) { return !standIn(p); }), before = [], after = [], byId = {}, i;
    pics.forEach(function (p) { if (p && typeof p.id === 'string') byId[p.id] = p; });
    pics.forEach(function (p, seq) {
      if (!p || typeof p.id !== 'string') return;
      var pv = p.private && typeof p.private === 'object' ? p.private : {};
      var pane = { id: p.id, label: typeof p.label === 'string' ? p.label : '' };
      /* a grid picture is a name for where boxes sit; the page draws no grid, so its changes are listed in words */
      if (p.type === 'text' && pv.text) pane.text = pv.text;
      else if (p.type === 'html' && typeof p.src === 'string' && FRAME.test(p.src)) pane.frame = p.src;
      else if (p.type === 'image' && typeof p.src === 'string' && SRC.test(p.src) && p.width > 0 && p.height > 0) {
        var m = /^pdfpage\/([0-9a-f]{64})\/([0-9]+)$/.exec(p.src), pm = /^preview\/([0-9a-f]{64})$/.exec(p.src), cm = /^cpic\/([0-9a-f]{64})$/.exec(p.src);
        pane.picture = m ? { sha: m[1], width: p.width, height: p.height, page: Number(m[2]) } : cm ? cpicPicture(cm[1], p) : { sha: pm[1], width: p.width, height: p.height };
      }
      if (typeof p.note === 'string' && p.note) pane.note = p.note;
      /* v1.1 `group` and `order`: the set this picture belongs to and its place on its side of the set; `seq` keeps the document's order of sets */
      if (typeof p.group === 'string' && p.group) { pane.group = p.group; pane.seq = seq; if (typeof p.order === 'number' && p.order >= 0 && Math.floor(p.order) === p.order) pane.order = p.order; }
      ['absent', 'unchanged', 'reflowed', 'changed'].forEach(function (k) { if (p[k] === true) pane[k] = true; });
      (p.side === 'before' ? before : after).push(pane);
    });
    /* A connector's pictures that all carry page numbers (v1 picture field `page`) draw as scrolled pages, from the document alone: every pane is a cpic
       picture with a page or an absent stand-in, and at least one has a page. A document that names its own kind keeps it; a mix keeps the tabs. */
    var panes = before.concat(after);
    var pagedPictures = !doc.kind && panes.some(function (q) { return q.picture && q.picture.cpic && typeof q.picture.page === 'number'; })
      && panes.every(function (q) { return q.absent === true && !q.picture || (q.picture && q.picture.cpic && typeof q.picture.page === 'number'); });
    /* pictures that name their set (v1.1 `group`) draw the same way, the sets side by side: every pane a connector picture, at least one in a group */
    if (!doc.kind && !pagedPictures && panes.some(function (q) { return q.group && q.picture && q.picture.cpic; }) && panes.every(function (q) { return q.absent === true && !q.picture || (q.picture && q.picture.cpic); })) pagedPictures = true;
    var marks = [], items = [];
    arr(doc.changes).forEach(function (ch) {
      if (!ch || typeof ch.id !== 'string') return;
      var boxes = [];
      arr(level === 3 ? ch.boxes : []).forEach(function (b) {
        var pic = byId[b.picture]; if (!pic) return;
        /* a box's side is its picture's side */
        var mk = { side: pic.side === 'before' ? 'before' : 'after', pane: b.picture, change: ch.id };
        if (b.cell) mk.cell = b.cell; /* no pane draws a cell box: a cell change is a words-list row */
        else if (b.lines) mk.line = b.lines.from;
        else if (b.rect) { mk.rect = b.rect; if (b.highlights) mk.highlights = b.highlights; }
        marks.push(mk); boxes.push(mk);
      });
      items.push({ id: ch.id, kind: hintOf(ch, own), parent: ch.parent || null, boxes: boxes, unplaced: ch.unplaced, lines: arr(ch.lines), comment: comment(ch), mark: ch.mark, change: ch });
    });
    /* 'region' (CoCheck's own) is a bare mark with no card; every other change is drawn as boxes and comments, or a words-list row */
    var cards = items.filter(function (it) { return it.kind !== 'region'; });
    var changeFirst = pics.length > 0 && (items.some(function (it) { return it.kind !== 'region'; }) || (!items.length && (!!doc.banner || pics.some(function (p) { return p && p.type === 'grid'; }))));
    var scene = { level: level, coverage: source ? coverageLine(doc) : '', source: source ? { by: source.by, name: source.name, level: source.level, text: sourceLine(source, doc.pictures) } : undefined, kind: doc.kind || (pagedPictures ? 'pages' : 'card'), engine: doc.engine || '', file: doc.file || '', pending: doc.pending === true ? true : undefined, waiting: doc.pending === true && doc.pendingRetry !== undefined ? true : undefined, failed: doc.failed === true ? true : undefined, banner: doc.banner || (source && (coverageLine(doc) === NOTHING_VISIBLE || coverageLine(doc) === NOTHING_CHANGED) ? coverageLine(doc) : undefined), issues: issuesOf(doc) || undefined, more: moreLine(doc.more) || undefined, status: findingOf(doc), notOpened: notOpenedOf(doc), caveats: (doc.readLater === true ? [READ_LATER] : []).concat(arr(doc.caveats)), before: before, after: after, marks: marks, items: items, cards: cards, changeFirst: changeFirst };
    return scene;
  }
  /* The sides of a change that show nothing, for the one plain words list under the panes: each side the producer named in `unplaced`, each side whose boxes the page could
     not mount (`mounted` = { before: bool, after: bool }, true when that side has an element), and a change with no box at all and no reason ("not marked"). Never empty for a change nobody can see. */
  function missingSides(change, mounted, changes) {
    var un = change.unplaced || {}, out = [], boxes = change.boxes || [], par = null;
    if (change.parent && changes) for (var i = 0; i < changes.length; i++) if (changes[i] && changes[i].id === change.parent) par = changes[i];
    /* a child change sits inside its parent's box: a side where the parent has a box is covered there, so the child is not "not marked" on it */
    function covered(s) { return !!par && (par.boxes || []).some(function (b) { return b.side === s; }); }
    ['before', 'after'].forEach(function (s) {
      if (covered(s)) return;
      if (typeof un[s] === 'string' && un[s]) { out.push({ side: s, why: un[s] }); return; }
      if (boxes.some(function (b) { return b.side === s; }) && !(mounted && mounted[s])) out.push({ side: s, why: 'not marked' });
    });
    if (!out.length && !boxes.length && !covered('before') && !covered('after') && !Object.keys(un).length) out.push({ side: 'after', why: 'not marked' });
    return out;
  }

  /* ---- the Details log: the quiet notes of one step, verbatim, as the system produced them. Pure. ----
     A note says how a step was drawn (who drew the picture, the tally, a change the picture could not mark with the drawing's own reason, the view's caveats).
     None of it sits in the page flow: the page lists every note of the run in one raw log. Each note names its source: the connector's id, or 'cocheck' for
     CoCheck's own drawing and checks. A genuine file problem (a repair banner, an app that refused the file, a failed picture) is a warning on the page, never a note. */
  /* one comment as plain words (a box's label, a log line) */
  function commentText(c) {
    c = c || {};
    var w = c.before && c.after && !c.verb ? 'Edited: “' + c.before + '” to “' + c.after + '”' : (c.verb ? c.verb + (c.before || c.after ? ': ' : '') : '') + (c.before || '') + (c.before && c.after ? ' ' : '') + (c.after || '');
    if (c.text) w += (w ? ' ' : '') + c.text;
    return w || 'Changed';
  }
  /* the source of a view's notes: the connector's id, or 'cocheck' */
  function sourceId(view) { var s = view && view.source; return s && s.by === 'connector' ? s.name : 'cocheck'; }
  /* The sides a change's boxes can be drawn on, judged from the document alone (the page's own drawing refines it): a picture box; a cell box never */
  function drawableSides(it) {
    var m = { before: false, after: false };
    (it.boxes || []).forEach(function (b) { if (!b.cell && b.rect) m[b.side] = true; });
    return m;
  }
  /* one log line per unseen side: "unplaced <side>: <the reason, verbatim> | <place>: <the change>". A technical reason kept in private.unplacedWhy wins over the words. */
  function unplacedNotes(it, missing, src) {
    var c = it.comment || {}, pv = it.change && it.change.private && typeof it.change.private === 'object' ? it.change.private.unplacedWhy : null;
    var what = (c.head ? c.head + ': ' : '') + commentText(c) + (c.lines && c.lines.length ? ' (' + c.lines.join('; ') + ')' : '');
    return (missing || []).map(function (m) {
      var why = pv && typeof pv[m.side] === 'string' ? pv[m.side] : m.why;
      return { kind: 'unplaced', src: src, change: it.id, text: 'unplaced ' + m.side + ': ' + why + ' | ' + what };
    });
  }
  /* Every note of one view. `missing` (optional) maps a change id to the sides the page really could not draw; without it they are judged from the document. */
  function stepNotes(view, missing) {
    /* a failed change list says why in the body of its step (every caveat): it has no notes */
    if (!view || typeof view !== 'object' || view.failed) return [];
    var out = [], items = arr(view.items), own = !!(view.source && view.source.by === 'cocheck'), src = sourceId(view);
    function add(kind, text) { if (typeof text === 'string' && text) out.push({ kind: kind, src: src, text: text }); }
    if (view.source && view.source.text) add('source', view.source.text);
    add('tally', tallyLine(items.map(function (it) { return it.change; }), own));
    if (view.changeFirst) {
      items.forEach(function (it) {
        var ms = missing ? missing[it.id] : missingSides(it, drawableSides(it), items);
        if (ms && ms.length) out = out.concat(unplacedNotes(it, ms, src));
      });
    } else if (view.coverage !== NOTHING_VISIBLE && view.coverage !== NOTHING_CHANGED) add('coverage', view.coverage);
    /* the banner's full words (the page shows one plain line for it) */
    if (view.banner && view.banner.text) add('banner', (view.banner.title ? view.banner.title + ': ' : '') + view.banner.text);
    arr(view.caveats).forEach(function (c) { add('caveat', c); });
    return out;
  }
  /* The run's log, deduplicated, in step order: `perStep` is [{ step, notes }] in rail order. A note said on several steps (the same source, words and change id)
     is one entry listing every step it is on; two changes of one step are never merged. */
  function groupNotes(perStep) {
    var byKey = {}, list = [];
    arr(perStep).forEach(function (ps, si) {
      arr(ps && ps.notes).forEach(function (n) {
        var key = (n.src || '') + '\u0001' + n.text + '\u0001' + (n.change || ''), e = Object.prototype.hasOwnProperty.call(byKey, key) ? byKey[key] : null;
        if (!e) { e = byKey[key] = { text: n.text, kind: n.kind, src: n.src || 'cocheck', change: n.change || null, steps: [], first: si }; list.push(e); }
        if (e.steps.indexOf(ps.step) < 0) e.steps.push(ps.step);
      });
    });
    return { count: list.length, entries: list };
  }

  /* one Pane -> {id,label,kind:'text'|'frame'|'picture'|'card', ...}. `boxes` is boxesOf(), each match keeps its index in that list. */
  function describePane(pane, boxes, side) {
    var mine = [];
    boxes.forEach(function (b, bi) { if (b.side === side && b.pane === pane.id) mine.push({ box: b, index: bi }); });
    if (pane.text && Array.isArray(pane.text.lines)) {
      var hitsT = {};
      mine.forEach(function (m) { var n = typeof m.box.line === 'number' && isFinite(m.box.line) ? String(m.box.line) : lineOf(m.box.cell); if (n !== null && hitsT[n] === undefined) hitsT[n] = m.index; });
      return {
        id: pane.id, label: pane.label, kind: 'text',
        lines: pane.text.lines.map(function (l) {
          if (!l) return { gap: true, hidden: 0 };
          if (l.filler) return { filler: true };
          if (l.gap) return { gap: true, hidden: typeof l.hidden === 'number' && isFinite(l.hidden) && l.hidden > 0 ? Math.floor(l.hidden) : 0 };
          var n = String(l.n), text = String(l.text == null ? '' : l.text);
          return { n: n, text: text, kind: l.kind === 'add' || l.kind === 'del' || l.kind === 'edit' ? l.kind : null, marks: marksOf(l.marks, text.length), box: hitsT[n] === undefined ? null : hitsT[n] };
        }),
      };
    }
    if (typeof pane.frame === 'string' && FRAME.test(pane.frame)) return { id: pane.id, label: pane.label, kind: 'frame', src: pane.frame };
    if (pane.picture && SHA.test(pane.picture.sha) && pane.picture.width > 0 && pane.picture.height > 0) {
      var p = pane.picture;
      return {
        id: pane.id, label: pane.label, kind: 'picture', note: typeof pane.note === 'string' ? pane.note : '', sha: p.sha, page: (typeof p.page === 'number' && p.page >= 1 && Math.floor(p.page) === p.page) ? p.page : null, width: p.width, height: p.height, cpic: p.cpic === true,
        rects: mine.filter(function (m) { return m.box.rect; }).map(function (m) {
          var r = m.box.rect;
          return { box: m.index, left: 100 * r.x / p.width, top: 100 * r.y / p.height, width: 100 * r.w / p.width, height: 100 * r.h / p.height };
        }),
      };
    }
    return { id: pane.id, label: pane.label, kind: 'card' };
  }

  /* The word ranges inside an edited line, checked against the line: sorted, inside it, never overlapping, [] when malformed */
  function marksOf(marks, len) {
    var out = [], at = 0;
    if (!Array.isArray(marks)) return out;
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (!Array.isArray(m) || typeof m[0] !== 'number' || typeof m[1] !== 'number' || !(m[0] >= at) || !(m[1] > m[0]) || m[1] > len) return [];
      out.push([m[0], m[1]]); at = m[1];
    }
    return out;
  }

  /* a box on a text pane names its line by the line number as a string; "L12" and "12:3" are read as line 12 */
  function lineOf(cell) { var m = typeof cell === 'string' || typeof cell === 'number' ? /^\D*(\d+)/.exec(String(cell)) : null; return m ? String(parseInt(m[1], 10)) : null; }

  /* Stepping to a change that must be fetched: everything the last step drew leaves the screen first (panes, tabs, the
     caveats, tethered notes, leaders, trees), and each pane area gets makeNode(label) with the label of its loading widget. `get(id)`
     returns an element (or a stub with textContent, hidden, and an optional append/empty hook). Pure of the document so a node test can run it. */
  function loadingScreen(get, makeNode) {
    ['vb', 'va', 'tb', 'ta', 'caveats', 'notes', 'svg', 'trb', 'tra'].forEach(function (id) { var n = get(id); n.textContent = ''; if (id === 'trb' || id === 'tra') n.hidden = true; });
    ['vb', 'va'].forEach(function (id) { var n = get(id); if (makeNode) n.append(makeNode(id === 'vb' ? 'Loading the before picture' : 'Loading the after picture')); });
  }

  /* The one loading widget (src/timeline/loading.ts builds the same markup on the server). Every place that is still waiting draws
     this, never its own text; a finished or failed state is words. `make` is the page's el(tag, attrs, ...children), which must make the
     svg, g, circle and path tags in the SVG namespace; `label` names what is loading, for a screen reader and on hover. The mark is
     the icon's rig, one g per factor of its transform (scripts/loader-css.mjs): translate(P) rotate(R) translate(D) rotate(-R) scale(S), H for the handle. */
  function loader(make, label) {
    var g = function (c) { var kids = Array.prototype.slice.call(arguments, 1); return make.apply(null, ['g', c ? { class: c } : {}].concat(kids)); };
    var at41 = function () { return make.apply(null, ['g', { transform: 'translate(-41 -41)' }].concat(Array.prototype.slice.call(arguments))); };
    var lens = at41(make('circle', { class: 'ild-rim', cx: '41', cy: '41', r: '34' }), make('path', { class: 'ild-glint', d: 'M22 33A21 21 0 0 1 33 22' }));
    var handle = g('ild-h', at41(make('path', { class: 'ild-neck', d: 'M69 69L80 80' }), make('path', { class: 'ild-grip', d: 'M83 83L100 100' })));
    var mark = make('svg', { class: 'iload-mark', viewBox: '0 0 128 128', 'aria-hidden': 'true', focusable: 'false' },
      g('ild-p', g('ild-r', g('ild-d', g('ild-c', g('ild-s', lens, handle))))));
    return make('span', { class: 'iload', role: 'status', title: label }, mark, make('span', { class: 'iload-sr' }, label));
  }

  /* Stack the notes down the margin. items: [{cy}] anchor heights; heights: note heights. The notes keep the order of their anchors, so a
     leader (anchor -> its note) never crosses another. Returns [{top, ny}] in the items' own order, and `end`, the y below the last note. */
  function stackNotes(items, heights, top, gap) {
    /* a note whose anchor is on screen takes its place by anchor height; a note with none (`hidden`: anchor on another tab or page, or no line at all) waits below them in list order */
    var seen = items.map(function (it, i) { return i; }).filter(function (i) { return !items[i].hidden; }).sort(function (p, q) { return items[p].cy - items[q].cy || p - q; });
    var order = seen.concat(items.map(function (it, i) { return i; }).filter(function (i) { return items[i].hidden; }));
    var y = top, res = [];
    order.forEach(function (i) {
      var t = items[i].hidden ? y : Math.max(items[i].cy - 22, y);
      res[i] = { top: t, ny: t + 20 };
      y = t + heights[i] + gap;
    });
    return { slots: res, end: y };
  }

  /* The polyline of one leader: out along the anchor's row to a common elbow just left of the notes, then down or up to the note. The
     common elbow is what keeps leaders in anchor order from crossing: all horizontals end on one x, all slants sit between that x and nl. */
  function leaderPoints(x1, y1, nl, ny) {
    var mid = nl - 26;
    if (x1 + 10 > mid) mid = x1 + 10;
    return [[x1, y1], [mid, y1], [nl, ny]];
  }
  /* The rows of a paged view whose panes name their set (v1.1 `group`): one row per (set, place), the k-th picture of the set on each side by
     `order` (ties keep the document's order); a side with fewer pictures in that set gets an empty place, never another set's picture. Sets come
     in the order of their first picture; panes without a set follow, paired by position. Pure. */
  function groupedRows(B, A) {
    var sets = [], bySet = {}, loose = { before: [], after: [] };
    function add(p, side) {
      if (!p || p.absent) return;
      if (typeof p.group !== 'string' || !p.group) { loose[side].push(p); return; }
      var s = bySet[p.group];
      if (!s) { s = bySet[p.group] = { id: p.group, seq: typeof p.seq === 'number' ? p.seq : 1e9, before: [], after: [] }; sets.push(s); }
      if (typeof p.seq === 'number' && p.seq < s.seq) s.seq = p.seq;
      s[side].push(p);
    }
    (B || []).forEach(function (p) { add(p, 'before'); });
    (A || []).forEach(function (p) { add(p, 'after'); });
    function byOrder(x, y) { var ox = typeof x.order === 'number' ? x.order : 1e9, oy = typeof y.order === 'number' ? y.order : 1e9; return ox - oy || (x.seq || 0) - (y.seq || 0); }
    var rows = [];
    sets.sort(function (x, y) { return x.seq - y.seq; }).forEach(function (s) {
      s.before.sort(byOrder); s.after.sort(byOrder);
      for (var k = 0; k < Math.max(s.before.length, s.after.length); k++) rows.push({ before: s.before[k] || null, after: s.after[k] || null, group: s.id });
    });
    for (var k = 0; k < Math.max(loose.before.length, loose.after.length); k++) rows.push({ before: loose.before[k] || null, after: loose.after[k] || null });
    return rows;
  }
  /* ---- the stage: open on the box, the close-up row, the picture strip. Pure, and keyed only on public fields: box rects and highlights,
     picture width, height, page, pageCount, label, group, order and changed. Any connector's image pictures get the same treatment. ---- */
  /* a close-up pads the change's drawn box by a fifth of its size (at least 24 picture pixels), is skipped when the change covers more than half the
     picture or would gain less than 1.2x over the full picture, and never shows more than one picture pixel per CSS pixel */
  var CLOSE = { pad: 0.2, padMin: 24, maxCover: 0.5, minGain: 1.2, maxAspect: 4 };
  /* a zoomed pane shows the change at about 60% of the pane's width or height, never below fit-width, never past the picture's own pixels */
  var ZOOM_FILL = 0.6;
  function okRect(r) { return !!(r && typeof r === 'object' && isFinite(r.x) && isFinite(r.y) && r.w > 0 && r.h > 0); }
  /* the smallest rectangle holding every rect, in picture pixels; null when none is usable */
  function unionRect(rects) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    arr(rects).forEach(function (r) { if (!okRect(r)) return; any = true; x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); });
    return any ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }
  /* the region a close-up shows: the union padded on every side, clipped to the picture */
  function cropRegion(rects, w, h) {
    var u = unionRect(rects); if (!u || !(w > 0) || !(h > 0)) return null;
    /* around the box as drawn (padBox pads at most 0.7% of the picture width), then a fifth of the box, at least padMin */
    var P = w * 0.007, px = P + Math.max(CLOSE.padMin, u.w * CLOSE.pad), py = P + Math.max(CLOSE.padMin, u.h * CLOSE.pad);
    var x0 = Math.max(0, u.x - px), y0 = Math.max(0, u.y - py), x1 = Math.min(w, u.x + u.w + px), y1 = Math.min(h, u.y + u.h + py);
    if (!(x1 > x0) || !(y1 > y0)) return null;
    /* a wide, short box gets height for context: no wider than CLOSE.maxAspect to 1, grown evenly above and below, shifted back inside the picture */
    var minH = Math.min(h, (x1 - x0) / CLOSE.maxAspect);
    if (y1 - y0 < minH) {
      var mid = (y0 + y1) / 2, a = Math.max(0, Math.min(h - minH, mid - minH / 2));
      y0 = a; y1 = a + minH;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /* a picture's label without a leading side word ("Before, page 2" reads "Page 2"), the way the label row shows it */
  function sideFree(label) {
    var t = String(label || '').replace(/^\s*(?:before|after)\s*[,:\u2013\u2014-]\s*/i, '');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  }
  /* what a picture is called on the stage: its own label, else "N of M" from page and pageCount, else its page number, else nothing. Never a noun of CoCheck's. */
  function pictureName(pane) {
    var t = pane ? sideFree(pane.label) : '';
    if (t) return t;
    var p = pane && pane.picture;
    if (p && p.page && p.pageCount) return p.page + ' of ' + p.pageCount;
    return p && p.page ? String(p.page) : '';
  }
  /* the picture on the other side a picture pairs with (spec "mate"): same group and order, else the same label, else the only picture there */
  function mateOf(pane, others) {
    var pics = arr(others).filter(function (p) { return p && p.picture && !p.absent; });
    if (!pane) return null;
    if (typeof pane.group === 'string' && pane.group && typeof pane.order === 'number') {
      var g = pics.filter(function (p) { return p.group === pane.group && p.order === pane.order; });
      if (g.length) return g[0];
    }
    var name = sideFree(pane.label);
    if (name) { var l = pics.filter(function (p) { return sideFree(p.label) === name; }); if (l.length) return l[0]; }
    return pics.length === 1 ? pics[0] : null;
  }
  /* For one change of a scene: per side, the picture its boxes sit on (the first picture a box of that side names) and the rects on it (each box's
     rect and highlights). A side with no box borrows the other side's rects on its mate, only when the two pictures have the same width and height. */
  function closeUpPlan(scene, changeId) {
    var it = arr(scene && scene.items).filter(function (x) { return x && x.id === changeId; })[0];
    if (!it) return null;
    var pics = { before: {}, after: {} }, list = { before: [], after: [] }, out = { before: null, after: null };
    ['before', 'after'].forEach(function (side) { arr(scene[side]).forEach(function (p) { if (p && p.picture && p.picture.width > 0 && p.picture.height > 0) { pics[side][p.id] = p; list[side].push(p); } }); });
    ['before', 'after'].forEach(function (side) {
      var bs = arr(it.boxes).filter(function (b) { return b && b.side === side && okRect(b.rect) && pics[side][b.pane]; });
      if (!bs.length) return;
      var pane = pics[side][bs[0].pane], rects = [];
      bs.forEach(function (b) { if (b.pane !== pane.id) return; rects.push(b.rect); arr(b.highlights).forEach(function (h) { if (okRect(h)) rects.push(h); }); });
      out[side] = { pane: pane, rects: rects, boxed: true };
    });
    if (!out.before && !out.after) return null;
    ['before', 'after'].forEach(function (side) {
      var other = out[side === 'before' ? 'after' : 'before'];
      if (out[side] || !other) return;
      var m = mateOf(other.pane, list[side]);
      if (m && m.picture.width === other.pane.picture.width && m.picture.height === other.pane.picture.height) out[side] = { pane: m, rects: other.rects, boxed: false };
    });
    return out;
  }
  /* The close-up of a plan in a column `colW` CSS pixels wide and at most `maxH` tall: one scale for both sides, each side's region grown to the
     display box around its centre and clipped to its picture. Null (no close-up) when a change covers more than half its picture, or the gain over
     the full picture at column width is under 1.2x once the scale is capped at one picture pixel per CSS pixel. `minH` (the row height shared by the
     changes of a step) grows the shown area with more of the picture around the region, never the scale. */
  function closeUp(plan, colW, maxH, minH) {
    if (!plan || !(colW > 0) || !(maxH > 0)) return null;
    var sides = ['before', 'after'].filter(function (s) { return plan[s]; });
    if (!sides.length) return null;
    var scale = Infinity, gain = Infinity, regs = {};
    for (var i = 0; i < sides.length; i++) {
      var s = plan[sides[i]], W = s.pane.picture.width, H = s.pane.picture.height, u = unionRect(s.rects), reg = cropRegion(s.rects, W, H);
      if (!u || !reg) return null;
      if (u.w * u.h > CLOSE.maxCover * W * H) return null;
      regs[sides[i]] = reg;
      scale = Math.min(scale, colW / reg.w, maxH / reg.h, 1);
    }
    sides.forEach(function (sd) { gain = Math.min(gain, scale / (colW / plan[sd].pane.picture.width)); });
    if (!(gain >= CLOSE.minGain)) return null;
    var dispH = 0;
    sides.forEach(function (sd) { dispH = Math.max(dispH, regs[sd].h * scale); });
    if (minH > dispH) dispH = Math.min(minH, maxH);
    var res = { scale: scale, gain: gain, height: dispH, before: null, after: null };
    sides.forEach(function (sd) {
      var W = plan[sd].pane.picture.width, H = plan[sd].pane.picture.height, r = regs[sd];
      var cw = Math.min(W, colW / scale), ch = Math.min(H, dispH / scale);
      var x = Math.max(0, Math.min(W - cw, r.x + r.w / 2 - cw / 2)), y = Math.max(0, Math.min(H - ch, r.y + r.h / 2 - ch / 2));
      res[sd] = { pane: plan[sd].pane, boxed: plan[sd].boxed, rects: plan[sd].rects, x: x, y: y, w: cw, h: ch };
    });
    return res;
  }
  /* the height the close-up row keeps for a set of changes: the tallest close-up among them, 0 when none has one */
  function rowHeight(scene, ids, colW, maxH) {
    var h = 0, seen = {};
    arr(ids).forEach(function (id) {
      if (seen[id]) return; seen[id] = true;
      var plan = closeUpPlan(scene, id), cu = plan ? closeUp(plan, colW, maxH) : null;
      if (cu) h = Math.max(h, cu.height);
    });
    return h;
  }
  /* The zoom that brings a box (CSS pixels at fit-width) to about ZOOM_FILL of the pane: at least 1 (fit-width), at most the picture's own
     pixels (picW over the fit width). */
  function zoomFor(o) {
    if (!o || !(o.boxW > 0) || !(o.boxH > 0) || !(o.paneW > 0) || !(o.paneH > 0) || !(o.fitW > 0)) return 1;
    var z = Math.min(ZOOM_FILL * o.paneW / o.boxW, ZOOM_FILL * o.paneH / o.boxH), cap = o.picW > 0 ? o.picW / o.fitW : 1;
    z = Math.min(z, cap);
    return z > 1 ? Math.round(z * 100) / 100 : 1;
  }
  /* Pane zoom. The multiplier z is relative to fit-width (1). 100% is one picture pixel a CSS pixel (picW over the fit width), 200% two; never below
     fit-width, and never more than ZOOM_MAX. Read from the picture's width alone. */
  var ZOOM_MAX = 16;
  function zoomTarget(mode, o) {
    if (mode === 'fit' || !o || !(o.fitW > 0) || !(o.picW > 0)) return 1;
    var z = (mode === '200' ? 2 : 1) * o.picW / o.fitW;
    return Math.min(ZOOM_MAX, z > 1 ? Math.round(z * 100) / 100 : 1);
  }
  /* The choice whose zoom is the current one (the first that matches), or null when none does (the automatic open-on-box zoom). */
  function zoomMode(zNow, o) {
    var ms = ['fit', '100', '200'];
    for (var i = 0; i < ms.length; i++) if (Math.abs(zoomTarget(ms[i], o) - zNow) < 0.015) return ms[i];
    return null;
  }
  /* The next (dir 1) or previous (dir -1) zoom that differs from the current one among the three choices; null when there is none. */
  function zoomStep(zNow, dir, o) {
    var zs = ['fit', '100', '200'].map(function (m) { return { m: m, z: zoomTarget(m, o) }; }), pick = null;
    zs.forEach(function (c) {
      if (dir > 0 && c.z > zNow + 0.015 && (!pick || c.z < pick.z)) pick = c;
      if (dir < 0 && c.z < zNow - 0.015 && (!pick || c.z > pick.z)) pick = c;
    });
    return pick ? pick.m : null;
  }
  /* The scroll offset that keeps the same point of the picture in the middle of the view when the zoom goes from z0 to z1. */
  function keepCentre(scroll, view, z0, z1) {
    if (!(z0 > 0) || !(z1 > 0)) return scroll;
    return Math.max(0, (scroll + view / 2) * z1 / z0 - view / 2);
  }
  /* A key event as a zoom command: Cmd/Ctrl with plus, minus or 0 is 'in', 'out', 'fit'; null for anything else, and always null in a text field (the browser keeps its zoom there). */
  function zoomShortcut(e) {
    if (!e || !(e.metaKey || e.ctrlKey) || e.altKey) return null;
    var t = e.target, g = t && t.tagName;
    if (g === 'TEXTAREA' || g === 'INPUT' || g === 'SELECT' || (t && t.isContentEditable)) return null;
    var k = e.key;
    return k === '+' || k === '=' ? 'in' : k === '-' || k === '_' ? 'out' : k === '0' ? 'fit' : null;
  }
  /* The picture strip of one side: an entry per place (panes in row order, null where this side has no picture). An image picture is a thumbnail,
     anything else a numbered chip (its page, else the first number of its label, else its place); a dot when the picture has a box or `changed`. */
  function stripOf(panes, marks) {
    var boxed = {};
    arr(marks).forEach(function (m) { if (m && m.pane) boxed[m.pane] = true; });
    return arr(panes).map(function (p, i) {
      if (!p || p.absent) return { i: i, pane: null, thumb: false, text: String(i + 1), name: '', dot: false, none: true };
      var n = p.picture && p.picture.page ? p.picture.page : (/(\d+)/.exec(String(p.label || '')) || [])[1];
      return { i: i, pane: p.id, thumb: !!p.picture, text: String(n || i + 1), name: pictureName(p), dot: !!boxed[p.id] || p.changed === true, none: false };
    });
  }
  root.CoCheckViewTable = { wordDiff: wordDiff, groupedRows: groupedRows, sourceLine: sourceLine, tallyLine: tallyLine, groupChanges: groupChanges, coverageLine: coverageLine, NOTHING_VISIBLE: NOTHING_VISIBLE, NOTHING_CHANGED: NOTHING_CHANGED, READ_LATER: READ_LATER, ISSUES_SHOWN: ISSUES_SHOWN, ISSUE_CHARS: ISSUE_CHARS, issuesOf: issuesOf, moreLine: moreLine, padBox: padBox, drawBoxes: drawBoxes, sceneOf: sceneOf, emptyPaneText: emptyPaneText, comment: comment, noteCard: noteCard, clip: clip, clipPair: clipPair, missingSides: missingSides, commentText: commentText, stepNotes: stepNotes, groupNotes: groupNotes, describePane: describePane, loadingScreen: loadingScreen, unionRect: unionRect, cropRegion: cropRegion, mateOf: mateOf, closeUpPlan: closeUpPlan, closeUp: closeUp, rowHeight: rowHeight, zoomFor: zoomFor, zoomTarget: zoomTarget, zoomMode: zoomMode, zoomStep: zoomStep, keepCentre: keepCentre, zoomShortcut: zoomShortcut, stripOf: stripOf, pictureName: pictureName, sideFree: sideFree, loader: loader, stackNotes: stackNotes, leaderPoints: leaderPoints };
})(typeof globalThis !== 'undefined' ? globalThis : this);
