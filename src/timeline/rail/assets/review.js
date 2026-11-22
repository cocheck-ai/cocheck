/* The g-rail review page. Everything it draws comes from /timeline/<task>/review/model and, per moment, /timeline/<task>/view/<change key>.
   No innerHTML: every text goes in through textContent, so nothing from a file can become markup. */
(function () {
  'use strict';
  var task = document.body.getAttribute('data-task');
  var token = new URLSearchParams(location.search).get('t') || '';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (k === 'class') e.className = v;
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x != null) e.append(x.nodeType ? x : document.createTextNode(x)); });
      else e.append(c.nodeType ? c : document.createTextNode(c));
    }
    return e;
  }
  var NS = 'http://www.w3.org/2000/svg';
  function mk(tag, at) { var e = document.createElementNS(NS, tag); for (var k in at) e.setAttribute(k, at[k]); return e; }
  /* el for the widget's icon: the same children rule, in the SVG namespace */
  var SVG_TAGS = { svg: 1, g: 1, circle: 1, path: 1 };
  function svgEl(tag, attrs) { var e = mk(tag, attrs); for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) e.append(arguments[i]); return e; }
  /* Every place that is still waiting shows the one loading widget (view-table.js builds it), named for what it waits on. Each one's
     animations are put on the page's own timeline once it is drawn, so every widget on the page is at the same point of the same cycle. */
  function loading(label) {
    var w = window.CoCheckViewTable.loader(function (tag) { return SVG_TAGS[tag] ? svgEl.apply(null, arguments) : el.apply(null, arguments); }, label);
    syncLoader(w);
    return w;
  }
  function syncLoader(w) {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(function () {
      try { if (typeof w.getAnimations === 'function') w.getAnimations({ subtree: true }).forEach(function (a) { a.startTime = 0; }); } catch (e) { /* no animation API: each widget keeps its own start */ }
    });
  }
  function withToken(u) { return u + (u.indexOf('?') < 0 ? '?' : '&') + 't=' + encodeURIComponent(token); }
  /* the logo in the toolbar corner goes home (the overview page), carrying the token */
  (function () { var h = document.getElementById('homelink'); if (h) h.setAttribute('href', withToken('/')); })();

  /* TOP is the room above the first row for the origin marker; the origin is not a row and not a step */
  var M = null, STOPS = [], ACTORS = [], N = 0, TOP = 22;
  /* two choices that belong to the viewer, not to the run: the colour theme and whether the rail shows the commands that changed no file. Both live in
     localStorage (every access wrapped: a browser that refuses storage still gets the defaults), and neither goes to the review process. */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* the choice still holds for this page's life */ } }
  var THEME = lsGet('cocheck.theme'), SHOWQUIET = lsGet('cocheck.showQuiet') === 'on';
  if (THEME !== 'light' && THEME !== 'dark') THEME = 'auto';
  /* data-theme on the root: light or dark force the scheme, auto (Match system) leaves it to prefers-color-scheme; the dark tokens in review.css honour both */
  function paintTheme() {
    var r = document.documentElement; if (r && r.setAttribute) r.setAttribute('data-theme', THEME);
    ['light', 'dark', 'auto'].forEach(function (t) { var b = $('theme' + t); if (b) b.setAttribute('aria-pressed', String(t === THEME)); });
  }
  function setTheme(t) { THEME = t; lsSet('cocheck.theme', t); paintTheme(); }
  function paintQuietOpt() { var b = $('quietbtn'); if (b) b.setAttribute('aria-pressed', String(!SHOWQUIET)); } /* the button reads Hide Background Commands: pressed means the quiet rows are hidden */
  function setShowQuiet(on) {
    SHOWQUIET = on; lsSet('cocheck.showQuiet', on ? 'on' : 'off'); paintQuietOpt();
    if (!booted || mode === 'files') return;
    YBY = {}; instant = true;
    if (!on && QV) { QV = null; render(); } /* the open commands view belongs to a row that is gone: back to the step on show */
    redraw(false);
  }
  /* The newest-first order: the rail is laid out in time order as ever and mirrored on the screen (NEWEST), so every row, mark and line stays in
     step with its stop. The choice lives in the review process (the preferences route), not here: this page's origin changes when the kept port is taken. */
  var NEWEST = false, railKept = false, PREFS = {}, HTOT = 0, YBY = {};
  function prefsUrl() { return withToken('/timeline/' + task + '/review/preferences'); }
  function loadPrefs() {
    try {
      return fetch(prefsUrl(), { headers: { accept: 'application/json' } }).then(function (r) { return r && r.ok ? r.json() : {}; })
        .then(function (p) { if (p && typeof p === 'object') { PREFS = p; var want = p.railOrder === 'newest-first'; if (want !== NEWEST) setOrder(want, true); applySeen(); } }).catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }
  function savePrefs(patch) {
    try {
      fetch(prefsUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        .then(function (r) { return r && r.ok ? r.json() : null; }).then(function (p) { if (p && typeof p === 'object') PREFS = p; }).catch(function () {});
    } catch (e) { /* the order still holds for this page's life */ }
  }
  function paintOrder() {
    var b = $('railorder');
    if (b) { b.setAttribute('aria-pressed', String(NEWEST)); b.setAttribute('title', NEWEST ? 'Show the oldest steps at the top' : 'Show the newest steps at the top'); b.hidden = mode === 'files'; }
  }
  /* The scroll position survives a rebuild. Newest-first, a row added above the one on show would push it down, so the stop on show keeps its place on the screen;
     a list left at its very top stays at the top, where the new row is. */
  function keepScroll(build) {
    var sc = $('scroller'), keep = sc.scrollTop, id = STOPS[cur] && STOPS[cur].id, was = id !== undefined ? YBY[id] : undefined;
    build(); railKept = true;
    if (NEWEST && keep > 2 && was !== undefined && YBY[id] !== undefined) sc.scrollTop = Math.max(0, keep + YBY[id] - was); else sc.scrollTop = keep;
  }
  function setOrder(rev, stored) {
    NEWEST = rev; PREFS.railOrder = rev ? 'newest-first' : 'oldest-first'; if (!stored) savePrefs({ railOrder: PREFS.railOrder }); paintOrder();
    if (!booted || mode === 'files') return;
    var sc = $('scroller'), go = !stored && canAnimate(), from = go ? railSpots() : null;
    YBY = {}; instant = true; glideEnd = 0; redraw(false);
    var r = POS[cur]; if (r !== undefined && YC[r] !== undefined) sc.scrollTop = Math.max(0, sy(YC[r]) - sc.clientHeight / 2);
    showCurrent();
    if (from) glideRail(from);
  }
  /* The swap glides (FLIP): every rail node is measured where it stood on the screen (top less the scroll), the rail is rebuilt in the new order, and each
     node that is, or was, on show starts back at its old place and eases to the new one. Only transform moves, so no layout runs mid-glide. */
  var GLIDE_MS = 320, glideT = 0;
  function canAnimate() { return !!window.matchMedia && !reduced(); }
  function spotKey(n) { return n.getAttribute && (n.getAttribute('data-key') || n.getAttribute('id') || (n.className === 'origin' ? 'origin' : null)); }
  function railSpots() {
    var sc = $('scroller'), out = {}, off = sc.scrollTop || 0;
    Array.prototype.slice.call($('tl').children || []).forEach(function (n) { var k = spotKey(n); if (k) out[k] = (parseFloat(n.style.top) || 0) - off; });
    return out;
  }
  function glideRail(from) {
    var sc = $('scroller'), tl = $('tl'), off = sc.scrollTop || 0, vh = sc.clientHeight || 1e6, moved = [];
    Array.prototype.slice.call(tl.children).forEach(function (n) {
      var k = spotKey(n); if (!k || !(k in from)) return;
      var now = (parseFloat(n.style.top) || 0) - off, d = from[k] - now;
      if (!d || (Math.max(from[k], now) < -60) || (Math.min(from[k], now) > vh + 60)) return;
      n.style.transform = 'translateY(' + d + 'px)'; moved.push(n);
    });
    var lanes = tl.querySelector ? tl.querySelector('svg') : null; if (lanes && lanes.classList) lanes.classList.add('enter');
    if (!moved.length) return;
    void tl.offsetHeight;
    moved.forEach(function (n) { n.classList.add('flipo'); n.style.transform = ''; });
    clearTimeout(glideT);
    glideT = setTimeout(function () { moved.forEach(function (n) { n.classList.remove('flipo'); }); }, GLIDE_MS + 60);
  }
  function sy(y) { return NEWEST ? HTOT - y : y; }
  /* Every row type has its own slot in the column and its own height; nothing is drawn between two rows or on top of one */
  var H = { step: 28, hdr: 28, quiet: 22, mark: 24, req: 36 };
  var cur = 0, hidden = new Set(), instant = true, seq = 0, VIS = [], POS = {};
  var viewCache = {};
  /* The passes of the review from the status route: markers (send-backs, submissions), a tag per stop after a marker, and the forward links of failed stops */
  var PASSES = null, passKey = 'null', pendingFocus = false;
  var TAG_CHIP = { reworks: 'rework', changes_passed: 'touches passed', 'new': 'new' };
  /* what came after the latest sign-off, for a step: its verdict or file version differs from what the sign-off covered, or the sign-off never covered it */
  var SO_CHANGED = 'changed after you signed off', SO_NEW = 'New since you signed off';
  /* A step's "New since you signed off" clears once it was opened and then left, like an unread mark. The review process keeps it per task and
     step id (the preferences' seenNew), as it keeps the rail order: the page's origin changes when the kept port is taken. */
  var SEEN = {}, seenFrom = null;
  function applySeen() {
    var l = PREFS && PREFS.seenNew && PREFS.seenNew[task], added = false;
    if (Array.isArray(l)) l.forEach(function (id) { if (typeof id === 'string' && !SEEN[id]) { SEEN[id] = true; added = true; } });
    if (added && M) { railSig = ''; syncRail(false); paintTag(); }
  }
  function newSinceSignoff(s) { var a = s && PASSES && PASSES.afterSignoff, pt = s && PASSES && PASSES.tags ? PASSES.tags[s.id] : null; return !!((a && Array.isArray(a.newSteps) && a.newSteps.indexOf(s.id) >= 0) || (pt && pt.text === SO_NEW)); }
  /* called with the step now on show: the step left behind is marked seen; true when a mark cleared, so the rail is drawn again */
  function leaveStep(id) {
    var from = seenFrom; seenFrom = id; if (!from || from === id || SEEN[from]) return false;
    var s = STOPS[stopIndex(from)]; if (!newSinceSignoff(s)) return false;
    SEEN[from] = true; savePrefs({ seen: { task: +task, stop: from } });
    return true;
  }
  function signoffTagOf(s) {
    var a = s && PASSES && PASSES.afterSignoff; if (!a) return null;
    if (Array.isArray(a.changed) && a.changed.indexOf(s.id) >= 0) return SO_CHANGED;
    var pt = tagOf(s);
    if (Array.isArray(a.newSteps) && a.newSteps.indexOf(s.id) >= 0 && !(pt && pt.text === SO_NEW) && !SEEN[s.id]) return SO_NEW;
    return null;
  }
  function tagOf(s) { var t = s && PASSES && PASSES.tags ? PASSES.tags[s.id] || null : null; return t && t.text === SO_NEW && SEEN[s.id] ? null : t; }
  function stopIndex(id) { for (var i = 0; i < STOPS.length; i++) if (STOPS[i].id === id) return i; return -1; }
  /* A run of changes from one call (the model's `call`) gets a header step just above it. The header is the page's own: it has
     no verdict row, and a verdict on it is a verdict on each file under it (setVerdict). Its id never reaches the server. */
  function withHeaders(stops) {
    var out = [], n = 0;
    for (var i = 0; i < stops.length; ) {
      var c = stops[i].call, j = i + 1;
      while (c && j < stops.length && stops[j].call && stops[j].call.id === c.id) j++;
      if (c && j - i > 1) {
        var files = stops.slice(i, j), hid = 'hdr-' + files[0].id; /* Named by its first step, so a header keeps its id when another appears before it */
        out.push({ id: hid, hdr: true, lane: stops[i].lane, label: c.text, head: c.text, covers: files.map(function (s) { return s.id; }) });
        files.forEach(function (s) { s.under = hid; });
      }
      for (var k = i; k < j; k++) out.push(stops[k]);
      i = j;
    }
    return out;
  }

  /* A step shows when its actor is shown and, under a call header, when that header is open */
  function laneShown(s) { return !s.lane || !hidden.has(s.lane); }
  function headerOf(s) { var h = s && s.under ? stopIndex(s.under) : -1; return h >= 0 ? STOPS[h] : null; }
  /* A header starts closed and always opens from a hand state, never from where the selection sits. Only a way to a step opens it (a deep link,
     a key, a look-back, a built-from pill, a live poll that forms the header around the step on show) and that opening is kept by hand (revealStep), so moving off the step
     does not close it. Landing on Deliverables or switching to the Timeline opens nothing; the Timeline then selects the closed header. A header opened or closed by hand keeps that state for the session (the page's life). */
  var hdrHand = {};
  function isOpen(h) {
    return Object.prototype.hasOwnProperty.call(hdrHand, h.id) ? hdrHand[h.id] : false;
  }
  function revealStep(i) { var h = headerOf(STOPS[i]); if (h) hdrHand[h.id] = true; }
  function isVis(i) { return POS[i] !== undefined; }
  function computeVis() {
    VIS = []; POS = {};
    /* a re-save of no single call (s.history) has no row on the railroad; the Files view opens it */
    STOPS.forEach(function (s, i) { var h = headerOf(s); if (laneShown(s) && !s.history && !(h && !isOpen(h))) { POS[i] = VIS.length; VIS.push(i); } });
  }
  function nearestVis(i) { for (var d = 0; d < N; d++) { if (isVis(i + d)) return i + d; if (isVis(i - d)) return i - d; } return 0; }
  function stepVis(i, d) { for (var j = i + d; j >= 0 && j < N; j += d) if (isVis(j)) return j; return -1; }
  function actorOf(id) { return ACTORS.filter(function (a) { return a.id === id; })[0]; }
  function chipEl(a) {
    var n = parseInt(a.color.slice(1), 16), l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    var c = el('b', { class: 'chip' }, a.chip);
    c.style.background = a.color; c.style.color = l < 0.55 ? 'var(--on-fill)' : 'var(--chip-ink)';
    return c;
  }

  /* ---------- a rail row's words ---------- */
  /* A row reads verb, then name. The verb stays whole; a long name loses its middle and keeps its tail, the part that usually tells two names apart
     (a file's extension, the end of a URL, an item's number). Nothing here knows what kind of thing the name is. */
  function railParts(s) {
    var L = s.label || '', m;
    if (s.path && (m = /^(\S+) (.+)$/.exec(L))) return { verb: m[1], name: m[2], tail: tailOf(m[2], s.tail) };
    if ((m = /^(Started|Message to) (.+)$/.exec(L))) return { verb: m[1], name: m[2], tail: tailOf(m[2]) };
    if ((m = /^(Helper \d+) (finished)$/.exec(L))) return { verb: '', name: m[1], tail: '', after: m[2] };
    return { verb: '', name: L, tail: tailOf(L) };
  }
  /* The end of a name kept whole when the row trims: the distinguishing end a step carries (s.tail) when it is short enough, else the last part of the name. A short name is never split. */
  function tailOf(name, t) {
    if (name.length <= 14) return '';
    if (t && t.length < name.length && t.length <= 24 && name.slice(-t.length) === t) return t;
    return name.slice(-Math.min(14, Math.max(9, Math.ceil(name.length * 0.45))));
  }
  /* The trimmed start always keeps room for a letter and its ellipsis, so the verb never fuses with the kept tail */
  function nameEl(name, tail) {
    if (!tail) return el('span', { class: 'tx' }, name);
    return el('span', { class: 'tx split' }, el('span', { class: 'txh' }, name.slice(0, -tail.length)), el('span', { class: 'txt' }, el('span', {}, tail)));
  }
  function reqNo(s) { return STOPS.filter(function (x) { return x.request; }).indexOf(s) + 1; }
  function firstLine(t) { return String(t || '').split(/\n/).filter(function (x) { return x.trim(); })[0] || ''; }
  function reqLine(s) { return 'Request ' + reqNo(s) + (s.request.missing ? '' : ': ' + firstLine(s.request.text)); }
  /* The row's whole text, for the tooltip and screen readers: a request's full words; any other step its label and what happened, with whose lane it is on */
  function railTip(s, a) {
    if (s.request) return 'Request ' + reqNo(s) + ': ' + s.request.text;
    var t = s.label + ': ' + s.head + (s.muted && s.sub ? '. ' + s.sub : '');
    a = a || (s.lane ? actorOf(s.lane) : null);
    return a && a.name && t.indexOf(a.name) < 0 ? t + ' (' + a.name + ')' : t;
  }

  /* ---------- legend, controls ---------- */
  /* A helper resumed later has a line of its own (`group` names its first line); the legend lists the helper once and one button covers every line of it */
  /* the two lanes named Unknown (written outside the agents, or a call CoCheck can't pick) are one legend entry */
  function groupOf(a) { return a.group || (a.name === 'Unknown' ? 'unknown' : a.id); }
  function membersOf(g) { return ACTORS.filter(function (a) { return groupOf(a) === g; }); }
  function groupHidden(g) { return membersOf(g).every(function (a) { return hidden.has(a.id); }); }
  /* The buttons stay in place across redraws, so a pill eases between shown and hidden instead of being drawn anew */
  /* Requests are the rail's section headers, not a lane: the person has no line, no dot and no legend token */
  function laneActor(a) { return a.id !== 'you'; }
  function dotEl(a) { var d = el('span', { class: 'ldot', 'aria-hidden': 'true' }); d.style.setProperty('--c', a.color); return d; }
  function buildLegend() {
    var lg = $('legend'), want = ACTORS.filter(function (a, i) { return laneActor(a) && ACTORS.findIndex(function (b) { return groupOf(b) === groupOf(a); }) === i; });
    var have = Array.prototype.slice.call(lg.children || []);
    if (have.length !== want.length || have.some(function (b, k) { return b.getAttribute('data-g') !== groupOf(want[k]); })) {
      lg.textContent = '';
      want.forEach(function (a) { var g = groupOf(a); lg.append(el('button', { class: 'lg', type: 'button', 'data-g': g, onclick: function () { toggleActor(g); } }, dotEl(a), a.name)); });
      have = Array.prototype.slice.call(lg.children);
    }
    want.forEach(function (a, k) { var off = groupHidden(groupOf(a)); have[k].setAttribute('aria-pressed', String(!off)); have[k].setAttribute('title', (off ? 'Show ' : 'Hide ') + a.name); });
  }
  /* a hidden actor's rows and lane line go; the current step moves to the nearest shown step; the last shown actor can't be hidden */
  function toggleActor(g) {
    var ids = membersOf(g).map(function (a) { return a.id; });
    if (groupHidden(g)) ids.forEach(function (id) { hidden.delete(id); });
    else { if (ACTORS.filter(function (a) { return laneActor(a) && !hidden.has(a.id) && groupOf(a) !== g; }).length < 1) return; ids.forEach(function (id) { hidden.add(id); }); }
    computeVis();
    if (!isVis(cur)) cur = nearestVis(cur);
    redraw(true); instant = true; render();
  }
  function step(d) { var j = stepVis(cur, d); if (j >= 0) { go(j); } }
  /* The Timeline view keeps no position in the URL (always open at the very top). A move clears any #n or Files hash to the
     bare address, so a reload or a revisit opens at the top; an #n someone types or links still wins at boot. */
  /* Deliverables is the landing view, so a task with deliverables marks the Timeline as #v=timeline (still no position): a reload or a
     shared link stays on the Timeline instead of falling back to Deliverables. A task with no deliverables has only the Timeline: bare address. */
  var HASVIEWS = false;
  function bareUrl() { history.replaceState(null, '', (location.pathname || '') + (location.search || '') + (HASVIEWS ? '#v=timeline' : '')); }
  function go(i) { revealStep(i); QV = null; cur = i; instant = false; bareUrl(); render(); }
  /* Open or close a call header by hand, and select it. The state is kept for the session; closing it with the current step under it
     moves the current step to the header, which go() does here in any case. */
  function toggleHdr(hi, open) { var h = STOPS[hi]; if (!h || !h.hdr) return; hdrHand[h.id] = open; go(hi); }

  /* ---------- the railroad: one line per visible actor ---------- */
  /* The rail is drawn again whenever what it shows changes (a header opens or closes, an actor is hidden); the signature says when */
  var railSig = '';
  function sigOf() { return VIS.join(',') + '|' + STOPS.map(function (s) { return s.hdr && isOpen(s) ? 1 : 0; }).join(''); }
  function syncRail(anim) { computeVis(); if (sigOf() !== railSig) redraw(anim); }
  function redraw(anim) {
    var kept = rebuildRail(anim, buildRail); paintPlace(); paintRowStatus(); showCurrent(); kept();
  }
  function reduced() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  /* ---------- live motion (prototype, feat/rail-animations) ----------
     When a poll adds steps, the rail is rebuilt whole as ever, then animated from what was on the screen a moment before:
     - a row that moved glides from where it was SEEN (its on-screen rect, so a glide still running continues from mid-way, never jumps), and every lane
       segment follows its own two end nodes: a y-only affine transform maps its final drawing onto where its ends were, easing to none with the rows;
     - a lane segment that did not exist before grows from the stop it leaves to the stop it reaches (one dash the length of the path, its offset
       easing to 0: only the new path's own geometry is read, never the page's layout);
     - the new segments of one poll draw one stop after another in time order (a cascade); each new stop fades in as its line reaches it, and no line
       leaves a stop before that stop is on screen;
     - when rows glide, the cascade starts once they are half way, so nothing appears in a slot a row is still passing through.
     The whole cascade of one poll, rows included, ends within LIVE_T.cap (600 ms) however many steps arrive (livePlan), so a busy turn with a poll every
     second never queues two cascades.
     Identity: a segment is keyed by the stops it joins and a row by its stop, and a closed call header takes the id of the first file it covers, so a
     header forming around a step (or closing over it) keeps that step's row and lines: nothing redraws, nothing blanks.
     Every animation is a CSS animation keyed that way, with its start time kept in RUN. ANY rebuild of the rail while something runs (a poll, the review
     status tagging new stops, a step left behind, a header opened or closed, an actor hidden) re-attaches it with a negative delay: one motion carries on,
     never restarts, never cuts.
     The rail's geometry (YC, YBY, style.top) stays model-derived; nothing here is read back by layout or showCurrent.
     A poll with no change animates nothing; a rail not on screen (Deliverables) is never animated; reduced motion: none of this runs. */
  var pollMotion = false, liveFrom = null, RUN = {}, glideEnd = 0;
  /* grow: one segment's draw; fade: a new row's fade and its node's settle; arrive: how far into its segment's draw a stop appears; stagger: the gap
     between two segments of a small burst; glide: a row's glide; cap: the end of the last motion of one poll, after its start */
  var LIVE_T = { grow: 300, fade: 200, arrive: 0.55, stagger: 120, glide: 320, cap: 600 };
  /* The cascade over n arrival stops, starting at t0, is one chain: stop i's segments start at t0 + i * slot and draw in `draw` ms, so a stop appears
     (at LIVE_T.arrive of its draw) no later than the next segment leaves it. A big burst gets shorter segments, never overlapping ones: the last stop
     appears by t0 + n * slot and has faded in by t0 + n * slot + fade <= cap. */
  function livePlan(n, t0) {
    var room = LIVE_T.cap - LIVE_T.fade - t0;
    if (n <= 1) return { slot: 0, draw: Math.min(LIVE_T.grow, Math.floor(room / LIVE_T.arrive)) };
    var slot = Math.floor(Math.min(LIVE_T.stagger, room / n));
    return { slot: slot, draw: Math.min(LIVE_T.grow, Math.floor(slot / LIVE_T.arrive)) };
  }
  function liveNow() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  /* Below 1100 px the rail is a sidebar over the stage, behind the toolbar toggle: closed by default, closed again by Escape, a chosen row or a click outside.
     Focus goes to the current row on open and back to the toggle when Escape or a row closes it. From 1100 px the toggle is hidden (CSS) and the rail is always shown. */
  var RAILOPEN = false;
  function railNarrow() { return innerWidth < 1100; }
  function setRail(open, refocus) {
    var col = $('railcol'), tg = $('railtoggle'); if (!col || !tg) return;
    open = !!open && railNarrow();
    if (open !== RAILOPEN) { RAILOPEN = open; if (open) col.classList.add('open'); else col.classList.remove('open'); }
    tg.setAttribute('aria-expanded', String(open)); tg.setAttribute('aria-label', open ? 'Hide steps' : 'Show steps'); tg.setAttribute('title', open ? 'Hide steps' : 'Show steps');
    if (open) { var rows = Array.prototype.filter.call($('tl').children || [], function (r) { return r.getAttribute && r.getAttribute('tabindex') === '0'; }); var f = rows[0]; if (f && f.focus) f.focus(); }
    else if (refocus && tg.focus) tg.focus();
  }
  function inRail(t) { for (; t; t = t.parentNode) { var id = t.getAttribute && t.getAttribute('id'); if (id === 'railcol' || id === 'railtoggle') return true; } return false; }
  function railShown() { var c = $('railcol'); return mode !== 'files' && !(c && c.hidden); }
  function liveRunning() { var now = liveNow(); if (now < glideEnd) return true; for (var k in RUN) if (now <= RUN[k].t0 + RUN[k].dur) return true; return false; }
  /* A closed call header stands for the first file it covers: the step that was there before the header formed keeps its row and its lines */
  function canonId(s) { return s && s.hdr && s.covers && s.covers.length ? s.covers[0] : s && s.id; }
  function rowAk(si) { var s = STOPS[si]; return 'S' + (s.hdr && isOpen(s) ? s.id : canonId(s)); }
  /* A row's place as seen inside the rail's scroller (its rect less the scroller's): transforms and the scroll count, a page shift above the rail
     (the legend wrapping onto a new line) does not, so the rail moves with its column instead of sliding after it */
  function seenTop(n) { var sc = $('scroller'); return n.getBoundingClientRect().top - (sc && sc.getBoundingClientRect ? sc.getBoundingClientRect().top : 0); }
  function liveBefore() {
    var tl = $('tl'), rows = {}, segs = {};
    Array.prototype.slice.call(tl.children || []).forEach(function (n) { var k = n.getAttribute && n.getAttribute('data-ak'); if (k && n.getBoundingClientRect) rows[k] = seenTop(n); });
    var svg = tl.querySelector ? tl.querySelector('svg.graph') : null;
    if (svg) Array.prototype.slice.call(svg.querySelectorAll('path[data-seg]')).forEach(function (p) { segs[p.getAttribute('data-seg')] = true; });
    return { rows: rows, segs: segs, had: !!svg };
  }
  /* (re)attach a keyed animation: a new one starts after `delay` ms; one already running carries on from where it is */
  function runAnim(n, key, name, dur, delay, ease) {
    var now = liveNow(), r = RUN[key];
    if (!r || now > r.t0 + r.dur) { if (delay == null) return false; r = RUN[key] = { t0: now + delay, dur: dur, name: name, ease: ease }; }
    n.style.animation = r.name + ' ' + r.dur + 'ms ' + r.ease + ' ' + Math.round(r.t0 - now) + 'ms both';
    return true;
  }
  function segKey(p) { return 'seg:' + p.getAttribute('data-seg') + (p.parentNode && p.parentNode.getAttribute('class') === 'faint' ? ':f' : ''); }
  /* a segment's draw: one dash the path's own length (geometry, not layout); pathLength="1" was tried and Chrome drew 1px dashes during a delay */
  function growPath(p, dur, delay) {
    var rk = segKey(p); if (delay == null && !RUN[rk]) return false;
    var len = p.getTotalLength ? Math.ceil(p.getTotalLength()) + 2 : 1;
    p.style.setProperty('--len', len + 'px'); p.style.strokeDasharray = len + 'px ' + (len + 4) + 'px'; p.classList.add('grow');
    if (!runAnim(p, rk, 'railgrow', dur, delay, 'cubic-bezier(.3,0,.2,1)')) { p.style.strokeDasharray = ''; p.classList.remove('grow'); return false; }
    return true;
  }
  /* The kept rows that keep their order: the heaviest subsequence of them, taken in their old order, whose new places also rise (a step weighs 2, a quiet
     row or a marker 1, so a step keeps its glide and the quiet row that crossed it is the one that fades). Returns a set by key. */
  function keptInOrder(rows) {
    var byWas = rows.slice().sort(function (a, b) { return a.was - b.was; }), n = byWas.length, len = [], prev = [], best = -1, out = {};
    function w(r) { return r.k.charAt(0) === 'S' ? 2 : 1; }
    for (var i = 0; i < n; i++) {
      len[i] = w(byWas[i]); prev[i] = -1;
      for (var j = 0; j < i; j++) if (byWas[j].now <= byWas[i].now && len[j] + w(byWas[i]) > len[i]) { len[i] = len[j] + w(byWas[i]); prev[i] = j; }
      if (best < 0 || len[i] > len[best]) best = i;
    }
    for (var at = best; at >= 0; at = prev[at]) out[byWas[at].k] = true;
    return out;
  }
  /* The glide: each kept row starts where it was seen (rows far outside the view, like glideRail, are left alone); a row that crossed others is marked to
     fade instead; each path whose ends moved gets the y-affine that puts its ends where their nodes were. Returns what moves and what was seen. */
  function liveMove(from, tl, paths) {
    var sc = $('scroller'), vh = (sc && sc.clientHeight) || 1e6, kept = [], fresh = [], D = {}, now = {}, swapped = {}, moved = [];
    Array.prototype.slice.call(tl.children).forEach(function (n) {
      var k = n.getAttribute && n.getAttribute('data-ak'); if (!k) return;
      if (k in from.rows) { var r = { n: n, k: k, was: from.rows[k], now: seenTop(n) }; kept.push(r); now[k] = r.now; }
      else if (k !== 'origin') fresh.push({ n: n, k: k });
    });
    var stable = keptInOrder(kept);
    function side(k) { var a = from.rows[k], b = now[k]; if (a == null || b == null) return 0; return Math.max(a, b) < -60 ? -1 : Math.min(a, b) > vh + 60 ? 1 : 0; }
    kept.forEach(function (r) {
      if (!stable[r.k]) { swapped[r.k] = true; D[r.k] = 0; return; }
      var d = r.was - r.now; D[r.k] = Math.abs(d) > 0.5 ? d : 0;
      if (D[r.k] && side(r.k) === 0) { r.n.style.transform = 'translateY(' + d + 'px)'; moved.push(r.n); }
    });
    paths.forEach(function (p) {
      var fa = p.getAttribute('data-from'), ta = p.getAttribute('data-to'), dA = D[fa] || 0, dB = D[ta] || 0;
      if (!dA && !dB) return;
      if (side(fa) !== 0 && side(fa) === side(ta)) return;
      var nums = String(p.getAttribute('d')).match(/-?\d+(?:\.\d+)?/g) || []; if (nums.length < 4) return;
      var yA = +nums[1], yB = +nums[nums.length - 1], gA = NEWEST ? -dA : dA, gB = NEWEST ? -dB : dB;
      var a = yB !== yA ? 1 + (gB - gA) / (yB - yA) : 1; if (Math.abs(a) < 1e-4) a = a < 0 ? -1e-4 : 1e-4; /* scale 0 is a singular matrix Chromium will not interpolate */
      var b = yA + gA - a * yA;
      p.style.transform = 'matrix(1,0,0,' + +a.toFixed(4) + ',0,' + +b.toFixed(2) + ')'; moved.push(p);
    });
    return { kept: kept, fresh: fresh, swapped: swapped, moved: moved };
  }
  function liveGo(moved) {
    if (!moved.length) return;
    void $('tl').offsetHeight;
    moved.forEach(function (n) { n.classList.add('flipo'); n.style.transform = ''; });
    glideEnd = liveNow() + LIVE_T.glide;
    clearTimeout(glideT);
    glideT = setTimeout(function () { moved.forEach(function (n) { n.classList.remove('flipo'); }); }, LIVE_T.glide + 60);
  }
  function livePaths(tl) { var svg = tl.querySelector ? tl.querySelector('svg.graph') : null; return svg ? Array.prototype.slice.call(svg.querySelectorAll('path[data-seg]')) : []; }
  /* A poll's rebuild: glide, then the cascade over what is new */
  function liveAfter() {
    var from = liveFrom; liveFrom = null; if (!from || !canAnimate() || !railShown()) return;
    var tl = $('tl'), now = liveNow(), EASE_OUT = 'var(--ease-out)';
    /* forget finished runs so RUN never grows with the session */
    Object.keys(RUN).forEach(function (k) { if (now > RUN[k].t0 + RUN[k].dur + 50) delete RUN[k]; });
    var paths = livePaths(tl), m = liveMove(from, tl, paths), anySwap = Object.keys(m.swapped).length > 0;
    var t0 = m.moved.length || anySwap ? LIVE_T.glide / 2 : 0;
    /* the cascade runs over the rows the new segments reach, in time order: segments reaching the same row (a lane step and a merge) draw together */
    var fresh = [], ends = [], arrive = {}, idx = {};
    VIS.forEach(function (si) { idx[rowAk(si)] = si; });
    paths.forEach(function (p) { var k = p.getAttribute('data-seg'), to = p.getAttribute('data-to'); if (from.had && !from.segs[k]) { if (fresh.indexOf(k) < 0) fresh.push(k); if (ends.indexOf(to) < 0) ends.push(to); } });
    ends.sort(function (a, b) { return (idx[a] == null ? -1 : idx[a]) - (idx[b] == null ? -1 : idx[b]); });
    var plan = livePlan(ends.length, t0);
    paths.forEach(function (p) {
      var to = p.getAttribute('data-to'), delay = fresh.indexOf(p.getAttribute('data-seg')) >= 0 ? t0 + ends.indexOf(to) * plan.slot : null;
      if (growPath(p, plan.draw, delay) && delay != null) arrive[to] = Math.max(arrive[to] || 0, delay + Math.floor(plan.draw * LIVE_T.arrive));
    });
    m.kept.forEach(function (r) {
      if (m.swapped[r.k]) { delete RUN['row:' + r.k]; runAnim(r.n, 'row:' + r.k, 'railin', LIVE_T.fade, t0, EASE_OUT); return; }
      runAnim(r.n, 'row:' + r.k, 'railin', LIVE_T.fade, null, EASE_OUT); /* a row still fading in keeps fading */
      var mk0 = r.n.querySelector && r.n.querySelector('.mark'); if (mk0) runAnim(mk0, 'node:' + r.k, 'railnode', LIVE_T.fade, null, EASE_OUT);
    });
    m.fresh.forEach(function (r) {
      var at = arrive[r.k] != null ? arrive[r.k] : t0;
      runAnim(r.n, 'row:' + r.k, 'railin', LIVE_T.fade, at, EASE_OUT);
      var mk1 = r.n.querySelector && r.n.querySelector('.mark'); if (mk1) runAnim(mk1, 'node:' + r.k, 'railnode', LIVE_T.fade, at, EASE_OUT);
    });
    liveGo(m.moved);
  }
  /* Any other rebuild while something runs: what runs carries on (a glide in flight continues from where it is seen; draws and fades re-attach);
     nothing new starts. `anim` rebuilds (a header opened or closed, an actor hidden) bring their own glide, so only the draws and fades re-attach there. */
  function liveKeep(from, anim) {
    if (!from || !canAnimate() || !railShown()) return;
    var tl = $('tl'), paths = livePaths(tl);
    if (!anim && liveNow() < glideEnd) liveGo(liveMove(from, tl, paths).moved);
    paths.forEach(function (p) { growPath(p, 0, null); });
    Array.prototype.slice.call(tl.children).forEach(function (n) {
      var k = n.getAttribute && n.getAttribute('data-ak'); if (!k) return;
      runAnim(n, 'row:' + k, 'railin', 0, null, '');
      var mk = n.querySelector && n.querySelector('.mark'); if (mk) runAnim(mk, 'node:' + k, 'railnode', 0, null, '');
    });
  }
  /* every rebuild goes through here: a poll's is animated after its scrolls are back (applyModel calls liveAfter); any other keeps what runs */
  function rebuildRail(anim, build) {
    var shown = booted && canAnimate() && railShown(), live = pollMotion && shown;
    if (live && !liveFrom) liveFrom = liveBefore();
    var keep = !live && shown && liveRunning() ? liveBefore() : null;
    keepScroll(function () { build(live ? false : anim); });
    return function () { liveKeep(keep, anim); };
  }
  var X0 = 9, P = 26, YC = [], cmd = {}, QV = null;
  function buildRail(anim) {
    computeVis(); buildLegend(); railSig = sigOf();
    var tl = $('tl'), motion = !!anim && !reduced(), was = {}, wasOpen = {}, ae = document.activeElement;
    var refocus = ae && ae.parentNode === tl && ae.getAttribute ? ae.getAttribute('data-key') : null;
    /* Where each row stood before, so a row that moves glides there (transform only, no layout) and a new one fades in */
    if (motion) Array.prototype.slice.call(tl.children || []).forEach(function (n) {
      var k = n.getAttribute && n.getAttribute('data-key'); if (!k) return;
      was[k] = parseFloat(n.style.top); if (n.getAttribute('aria-expanded') != null) wasOpen[k] = n.getAttribute('aria-expanded');
    });
    tl.textContent = '';
    var vis = ACTORS.filter(function (a) { return laneActor(a) && !hidden.has(a.id); });
    function posOf(id) { var j = stopIndex(id); return j >= 0 && isVis(j) ? POS[j] : null; }
    vis.forEach(function (a) {
      a.rows = STOPS.map(function (s, k) { return s.lane === a.id && isVis(k) ? POS[k] : -1; }).filter(function (r) { return r >= 0; });
      a.first = a.rows[0]; a.last = a.rows[a.rows.length - 1];
      /* a helper's line branches off its parent at startId and merges back at mergeId; with no start stop it is a plain line, with no merge stop it just ends */
      var par = a.parent ? vis.filter(function (p) { return p.id === a.parent; })[0] : null;
      a.par = par || null; a.sAt = a.par ? posOf(a.startId) : null; a.mAt = a.par ? posOf(a.mergeId) : null;
      /* A lane with a merge but no start is a plain line at its top that still draws its merge back into its spawner */
      if (a.sAt == null && a.mAt != null && a.mAt > a.last) a.branched = false;
      else { a.branched = a.sAt != null && a.sAt < a.first; if (!a.branched) { a.par = null; a.mAt = null; } }
      a.s0 = a.branched ? a.sAt : a.first; a.e0 = Math.max(a.last, a.par && a.mAt != null ? a.mAt : a.last);
    });
    /* top-level lines take the first columns; each helper takes the first column to the right of them that is free over its span */
    function depth(a) { var d = 0; while (a && a.par && d < 20) { a = a.par; d++; } return d; } /* a parent takes its column before the helper that branches off it at the same stop */
    var roots = vis.filter(function (a) { return !a.parent; }), kids = vis.filter(function (a) { return a.parent; }), occ = [];
    roots.forEach(function (a, i) { a.col = i; });
    kids.slice().sort(function (p, q) { return p.s0 - q.s0 || depth(p) - depth(q); }).forEach(function (a) {
      var c = roots.length;
      while (occ.some(function (o) { return o.col === c && !(o.e0 < a.s0 || o.s0 > a.e0); })) c++;
      a.col = c; occ.push(a);
    });
    var maxc = Math.max.apply(null, vis.map(function (a) { return a.col; }).concat([0])) + 1, PP = maxc > 3 ? 15 : P;
    var laneW = maxc * PP, LBL = X0 + laneW + 14;
    tl.style.setProperty('--lbl', LBL + 'px');
    function cx(a) { return X0 + a.col * PP + PP / 2; }
    var originX = X0 + PP / 2, oy = TOP / 2;
    function laneX(id) { var a = vis.filter(function (x) { return x.id === id; })[0] || vis.filter(function (x) { return x.main; })[0]; return a ? cx(a) : originX; }

    /* The column of rows, top to bottom. A step is a row; so is each quiet row (one actor's calls), an open quiet list, and a
       review marker. Every row has its own height, and the rows below an opened one move down. */
    var slots = [], before = {}, tail = [];
    /* A marker is the person's action, not an agent's: a row across every lane, just above the first shown step after it (at the end when none follows) */
    ((PASSES && PASSES.markers) || []).forEach(function (m) {
      var at = m.beforeStop == null ? -1 : stopIndex(m.beforeStop), j = -1;
      /* a marker before the first file of a call sits above that call's header */
      if (at > 0 && STOPS[at].under && STOPS[at - 1].id === STOPS[at].under) at--;
      if (m.beforeStop != null) for (var x = Math.max(at, 0); x < N; x++) if (isVis(x)) { j = x; break; }
      if (j < 0) tail.push(m); else (before[j] = before[j] || []).push(m);
    });
    quietSlots(slots, M && M.quiet, 'o');
    STOPS.forEach(function (s, si) {
      (before[si] || []).forEach(function (m, k) { slots.push({ kind: 'mark', key: 'm' + si + '.' + k, m: m, h: H.mark }); });
      if (isVis(si)) slots.push({ kind: 'step', key: 's' + si, si: si, h: s.request ? H.req : s.hdr ? H.hdr : H.step });
      var hh = headerOf(s); if (!(hh && !isOpen(hh))) quietSlots(slots, s.quiet, String(si));
    });
    tail.forEach(function (m, k) { slots.push({ kind: 'mark', key: 'mt.' + k, m: m, h: H.mark }); });
    /* Every maximal run of adjacent quiet slots, across lanes and actors, is one row; a step, a marker or any other node ends it */
    slots = slots.reduce(function (acc, sl) {
      var last = acc[acc.length - 1];
      if (sl.kind === 'quiet' && last && last.kind === 'quiet') { last.calls = last.calls.concat(sl.calls); last.starts = last.starts.concat(sl.starts); if (last.lane !== sl.lane) last.lane = null; last.lanes = last.lanes.concat(sl.lanes.filter(function (l) { return last.lanes.indexOf(l) < 0; })); }
      else acc.push(sl);
      return acc;
    }, []);
    var y = TOP; YC = [];
    slots.forEach(function (sl) { sl.top = y; y += sl.h; if (sl.kind === 'step') { YC[POS[sl.si]] = sl.top + sl.h / 2; YBY[STOPS[sl.si].id] = null; } });
    var HT = y; HTOT = HT; YBY = {}; tl.style.height = (HT + 16) + 'px';
    slots.forEach(function (sl) { if (sl.kind === 'step') YBY[STOPS[sl.si].id] = sy(sl.top + sl.h / 2); });
    function rtop(sl) { return NEWEST ? HT - sl.top - sl.h : sl.top; } /* a row's top on the screen */
    function ry(r) { return YC[r]; }

    var W = X0 + laneW + 4, svg = mk('svg', { class: 'graph', width: W, height: HT });
    var defs = mk('defs', {}), clip = mk('clipPath', { id: 'gclip' }); clip.append(mk('rect', { id: 'gclipr', x: -10, y: 0, width: W + 20, height: 0 })); defs.append(clip); svg.append(defs);
    var gf = mk('g', { class: 'faint' }), gs = mk('g', { 'clip-path': 'url(#gclip)' }), gb = mk('g', { class: 'brk' });
    /* newest-first: lines and branches are drawn in time order and the whole drawing is mirrored, so a branch still leaves its parent and merges back the right way */
    var gw = NEWEST ? mk('g', { transform: 'translate(0,' + HT + ') scale(1,-1)' }) : svg; gw.append(gf, gs, gb); if (NEWEST) svg.append(gw);
    /* Each segment carries a key made of the stop ids it joins, and the stop it arrives at, so a live poll can tell which segments are new and grow only those (liveAfter) */
    function draw(d, color, key, fa, ta) {
      [gf, gs].forEach(function (g) { var p = mk('path', { d: d, stroke: color }); if (key) { p.setAttribute('data-seg', key); p.setAttribute('data-from', fa); p.setAttribute('data-to', ta); } g.append(p); });
    }
    function idAt(r) { var j = VIS[r]; return j !== undefined && STOPS[j] ? canonId(STOPS[j]) : String(r); }
    function akAt(r) { var j = VIS[r]; return j !== undefined && STOPS[j] ? rowAk(j) : String(r); }
    function out(x0, y0, x, y1, dk) { dk = Math.min(dk, y1 - y0); return x0 === x ? 'M' + x0 + ',' + y0 + ' L' + x + ',' + y1 : 'M' + x0 + ',' + y0 + ' C' + x0 + ',' + (y0 + dk * 0.55) + ' ' + x + ',' + (y0 + dk * 0.45) + ' ' + x + ',' + (y0 + dk) + ' L' + x + ',' + y1; }
    function inn(x, yl, x0, ym, dk) { dk = Math.min(dk, ym - yl); return x0 === x ? 'M' + x + ',' + yl + ' L' + x0 + ',' + ym : 'M' + x + ',' + yl + ' L' + x + ',' + (ym - dk) + ' C' + x + ',' + (ym - dk * 0.45) + ' ' + x0 + ',' + (ym - dk * 0.55) + ' ' + x0 + ',' + ym; }
    vis.forEach(function (a) {
      if (a.first == null) return;
      var x = cx(a);
      for (var k = 0; k < a.rows.length - 1; k++) draw('M' + x + ',' + ry(a.rows[k]) + ' L' + x + ',' + ry(a.rows[k + 1]), a.color, 'L|' + a.id + '|' + idAt(a.rows[k]) + '|' + idAt(a.rows[k + 1]), akAt(a.rows[k]), akAt(a.rows[k + 1]));
      if (a.fromStart) draw(out(originX, oy, x, ry(a.first), 20 + 12 * a.col), a.color, 'O|' + a.id + '|' + idAt(a.first), 'origin', akAt(a.first));
      if (a.par) {
        var px = cx(a.par);
        if (a.branched) {
          var sib = kids.filter(function (k) { return k.par === a.par && k.branched && k.sAt === a.sAt; }).sort(function (p, q) { return p.col - q.col; });
          draw(out(px, ry(a.sAt), x, ry(a.first), 16 + 9 * sib.indexOf(a)), a.color, 'B|' + a.id + '|' + idAt(a.sAt) + '|' + idAt(a.first), akAt(a.sAt), akAt(a.first));
        }
        if (a.mAt != null && a.mAt > a.last) {
          var sibm = kids.filter(function (k) { return k.par === a.par && k.mAt === a.mAt; }).sort(function (p, q) { return q.col - p.col; });
          draw(inn(x, ry(a.last), px, ry(a.mAt), 16 + 9 * sibm.indexOf(a)), a.color, 'M|' + a.id + '|' + idAt(a.last) + '|' + idAt(a.mAt), akAt(a.last), akAt(a.mAt));
        }
      }
    });
    /* An open call header's bracket: a thin line beside the labels from the header down the files it covers */
    var bx = LBL - 7;
    slots.forEach(function (sl) {
      var h = sl.kind === 'step' ? STOPS[sl.si] : null; if (!h || !h.hdr || !isOpen(h)) return;
      var end = -1; slots.forEach(function (o) { if (o.kind === 'step' && h.covers.indexOf(STOPS[o.si].id) >= 0) end = o.top + o.h; });
      if (end > 0) gb.append(mk('path', { d: 'M' + (bx + 4) + ',' + (sl.top + sl.h - 3) + ' L' + bx + ',' + (sl.top + sl.h - 3) + ' L' + bx + ',' + (end - 6), stroke: 'var(--sky-deep)' }));
    });
    tl.append(svg);
    /* The origin is a marker the lanes leave from, not a row: nothing to select, nothing for the keys to land on */
    var om = el('span', { class: 'mark origin' }); om.style.left = originX + 'px';
    var origin = el('div', { class: 'origin', 'aria-hidden': 'true', 'data-ak': 'origin' }, om); origin.style.height = TOP + 'px'; if (NEWEST) origin.style.top = (HT - TOP) + 'px'; tl.append(origin);
    slots.forEach(function (sl) {
      if (sl.kind === 'step') stepRow(sl);
      else if (sl.kind === 'quiet') quietRow(sl);
      else markRow(sl);
    });
    function stepRow(sl) {
      var si = sl.si, s = STOPS[si], a = s.lane ? vis.filter(function (x) { return x.id === s.lane; })[0] : null, open = s.hdr ? isOpen(s) : null;
      /* A request is the section header of the steps it led to: its own words on one line, the whole text on hover. A call header is a row with its chevron; closed, it reads "N files" and its node is a dot with a ring.
         Any other step is one line: the lane dot, the verb in secondary ink, the name in primary ink. */
      var kids = [], tip = railTip(s, a);
      if (s.request) kids.push(el('span', { class: 'rq' }, reqLine(s)));
      else {
        if (s.hdr) { var chev = mk('svg', { class: 'chev' + (NEWEST ? ' up' : ''), viewBox: '0 0 12 12', 'aria-hidden': 'true' }); chev.append(mk('path', { d: 'M2.5 4.5L6 8l3.5-3.5' })); kids.push(chev); }
        var pr = s.hdr ? { verb: '', name: s.label, tail: '' } : railParts(s);
        /* the words keep their spaces in the text (the gap draws them), so the row reads "Changed a.txt" to anything that reads its text */
        if (pr.verb) kids.push(el('span', { class: 'vb' }, pr.verb + ' '));
        kids.push(nameEl(pr.name, pr.tail));
        if (pr.after) kids.push(el('span', { class: 'vb' }, ' ' + pr.after));
      }
      if (s.hdr && !open) kids.push(el('span', { class: 'cnt' }, s.covers.length + ' files'));
      var tg = tagOf(s); if (tg) kids.push(el('span', { class: 'tg ' + tg.tag, title: tg.text }, TAG_CHIP[tg.tag] || tg.tag));
      var so = signoffTagOf(s); if (so) kids.push(el('span', { class: 'tg aftersign', title: so }, so));
      /* An MCP write leaves CoCheck's local files for an outside system: a paper plane flying out, beside the stop */
      if (s.mcpWrite) {
        var plane = mk('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' });
        plane.append(mk('path', { d: 'M14.5 1.5L1.5 7l4.5 2L14.5 1.5zM6 9l1.5 5 7-12.5L6 9z' }));
        kids.push(el('span', { class: 'sent', role: 'img', title: SENT_TEXT, 'aria-label': SENT_TEXT }, plane));
      }
      var mark = null;
      if (s.request) {
        /* a request is something the person did: a hollow node on the lane it led (the main lane when it names none), so the rail shows a stop there */
        mark = el('span', { class: 'mark rqm', 'aria-hidden': 'true' }); mark.style.left = (a ? cx(a) : laneX(null)) + 'px';
      } else if (!s.hdr || !open) {
        mark = el('span', { class: 'mark' + (s.hdr ? ' hring' : s.runs ? ' fail' : '') });
        mark.style.left = (a ? cx(a) : originX) + 'px'; mark.style.setProperty('--c', a ? a.color : 'var(--ink-3)');
      }
      var cls = 'row' + (s.request ? ' req' : '') + (s.hdr ? ' hdr' : '') + (s.runs ? ' fgroup' : '') + (s.under ? ' under' : '') + (s.muted ? ' muted' : '');
      /* the rail is one tab stop: only the current row takes Tab (paintPlace moves it); the arrows, Home and End move within */
      var row = el('button', { class: cls, type: 'button', tabindex: si === cur ? '0' : '-1', 'data-i': si, 'data-key': sl.key, 'data-ak': rowAk(si), title: tip, 'aria-label': tip, onclick: function () { if (s.hdr) toggleHdr(si, !isOpen(s)); else { go(si); if (RAILOPEN) setRail(false, true); } } }, mark, el('span', { class: 'lbl' }, kids));
      row.style.top = rtop(sl) + 'px'; row.style.height = sl.h + 'px';
      if (s.under) row.style.setProperty('--lbl', (LBL + 4) + 'px');
      tl.append(row);
      if (s.hdr) {
        /* the chevron turns from where it was, so the change of state eases rather than jumps */
        var now = String(open);
        if (motion && wasOpen[sl.key] != null && wasOpen[sl.key] !== now) { row.setAttribute('aria-expanded', wasOpen[sl.key]); void row.offsetWidth; }
        row.setAttribute('aria-expanded', now);
      }
    }
    function markRow(sl) {
      var m = sl.m, mk1 = el('div', { class: 'pmark ' + m.kind, role: 'separator', 'data-key': sl.key, 'data-ak': 'M' + m.kind + '.' + m.pass + '.' + (m.beforeStop == null ? '' : m.beforeStop), 'aria-label': m.label + ' (the stops ' + (NEWEST ? 'above' : 'below') + ' are pass ' + m.pass + ')' }, el('span', { class: 'pml', title: m.label }, m.kind === 'submitted' ? 'Signed off' : m.label));
      mk1.style.top = (NEWEST ? HT - sl.top - sl.h / 2 : sl.top + sl.h / 2) + 'px'; tl.append(mk1);
    }
    function quietRow(sl) {
      var n = sl.calls.length, ticks = [sl.calls.length > 1 ? 1 : 0].map(function (g) { var t = el('span', { class: 'qtick' + (g ? ' qgroup' : '') }); t.style.left = laneX(sl.lanes[0]) + 'px'; return t; }); /* One mark on the first call's lane; a group of calls is a pill, never a dot per lane */
      var on = !!QV && QV.key === sl.key;
      var tg = el('button', { class: 'qline' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), title: 'Show the calls', onclick: function (e) { e.stopPropagation(); openCalls(sl); } }, n + (n === 1 ? ' command' : ' commands') + ', no file changed');
      var row = el('div', { class: 'quiet', 'data-key': sl.key, 'data-ak': 'Q' + sl.starts[0] }, ticks, tg); row.style.top = rtop(sl) + 'px'; row.style.height = sl.h + 'px'; tl.append(row);
    }
    if (motion) {
      var moved = [];
      Array.prototype.slice.call(tl.children).forEach(function (n) {
        var k = n.getAttribute && n.getAttribute('data-key'); if (!k) return;
        if (!(k in was)) { n.classList.add('enter'); return; }
        var d = was[k] - parseFloat(n.style.top); if (!d) return;
        n.style.transform = 'translateY(' + d + 'px)'; moved.push(n);
      });
      void tl.offsetHeight;
      moved.forEach(function (n) { n.classList.add('flip'); n.style.transform = ''; });
      svg.classList.add('enter');
    }
    if (refocus) Array.prototype.slice.call(tl.children).forEach(function (n) { if (n.getAttribute && n.getAttribute('data-key') === refocus && n.focus) n.focus(); });
  }
  /* Quiet calls: the calls that changed no file, under the stop they follow, closed by default. Not a step and never a tab stop: the mouse opens
     it, and each call opens its command through the existing route. The calls before the first stop sit by the origin marker.
     Each run of one actor's calls is a row of its own, on that actor's lane; a hidden actor's calls go with its rows. */
  function quietSlots(slots, q, at) {
    if (!SHOWQUIET) return; /* off by default, the rows are not built at all, so they take no space and draw no tick */
    if (!q || !q.calls || q.calls.length === 0) return;
    var runs = [];
    q.calls.forEach(function (c) { var l = c.lane || null, last = runs[runs.length - 1]; if (last && last.lane === l) last.calls.push(c); else runs.push({ lane: l, calls: [c] }); });
    runs.forEach(function (r, k) {
      if (r.lane && hidden.has(r.lane)) return;
      var key = 'q' + at + '.' + k;
      slots.push({ kind: 'quiet', key: key, lane: r.lane, lanes: [r.lane], calls: r.calls, starts: [r.calls[0].id], h: H.quiet });
    });
  }
  /* Selecting a quiet row opens its calls in the main area: one plain label per call with its command behind a disclosure in a code
     block. It is not a step: no verdict, not in progress, and the arrows leave it for the next step.
     The row is a button, so Tab reaches it and Enter or Space opens it. */
  function openCalls(sl) {
    QV = { key: sl.key, lane: sl.lane, calls: sl.calls, starts: sl.starts }; instant = true;
    document.querySelectorAll('.qline').forEach(function (b) { var on = b.parentNode.getAttribute('data-key') === sl.key; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    render();
  }
  /* A calls row has no line under its heading */
  function paintCallsLine() { var p = $('h2'); p.textContent = ''; p.hidden = true; }
  /* One call's row: what it did, and its command behind "Show command", closed by default. The text is only what the command route answers (scrubbed there), never a field of the model.
     Used by the "N calls, no change" view and under a file step's heading. `more` (optional) opens and closes with the command. */
  function callRow(c, more) {
    var st = cmd[c.id] || (cmd[c.id] = { open: false, text: null, ok: false, busy: false });
    /* While the command is fetched its block is the loading widget; the answer goes to the block on screen now (st.node), even after a redraw */
    var code = st.node = el('code', {}, st.busy ? loading('Loading the command') : st.text != null ? st.text : ''), pre = el('pre', { class: 'codeblock' }, code); pre.hidden = !st.open;
    var b = el('button', { type: 'button', class: 'linkbtn', 'aria-expanded': String(st.open) }, st.open ? 'Hide command' : 'Show command');
    if (more) more.hidden = !st.open;
    b.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      st.open = !st.open; pre.hidden = !st.open; b.textContent = st.open ? 'Hide command' : 'Show command'; b.setAttribute('aria-expanded', String(st.open));
      if (more) more.hidden = !st.open;
      if (st.open && !st.ok && !st.busy) {
        st.busy = true; code.textContent = ''; code.append(loading('Loading the command'));
        fetch(withToken('/timeline/' + task + '/call/' + encodeURIComponent(c.id) + '/command'), { headers: { accept: 'application/json' } })
          .then(function (res) { return res.json().then(function (j) { st.ok = true; return res.ok && typeof j.command === 'string' ? j.command : (j && j.error) || 'No command was recorded.'; }); })
          .catch(function () { st.ok = false; return 'Could not read the command.'; })
          .then(function (t) { st.busy = false; st.text = t; st.node.textContent = t; });
      }
    });
    if (c.noCommand) return el('div', { class: 'qc' }, el('div', { class: 'what' }, c.text));
    return el('div', { class: 'qc' }, el('div', { class: 'what' }, c.text), b, pre, more);
  }
  function renderCalls() {
    var n = QV.calls.length, a = QV.lane ? actorOf(QV.lane) : null, box = $('bodyview');
    ++seq; syncRail(opened);
    paintHeader2(n + (n === 1 ? ' command' : ' commands') + ', no file changed', '', '', a, false, null, null);
    paintCallsLine(); paintVerdict(); $('ptag').hidden = true; paintPlace();
    curPlan = null; clampers = []; curItems = [];
    /* A calls row has no file change: its own structure panel, chart summary, banner and Inferred word are empty, never the last step's */
    ['banner', 'finding'].forEach(function (id) { $(id).textContent = ''; $(id).hidden = true; });
    paintExtras(null);
    extrasFile = null;
    $('reqview').hidden = true; $('hdrbody').hidden = true; $('hdrview').hidden = true; $('stage').hidden = true; $('below').hidden = true;
    box.hidden = false; box.textContent = '';
    var list = el('div', { class: 'calls' });
    /* The calls grouped by actor, in the order each actor first appears; a heading names the actor when more than one is in the row */
    var lanes = [], ordered = [];
    QV.calls.forEach(function (c) { var l = c.lane || null; if (lanes.indexOf(l) < 0) lanes.push(l); });
    lanes.forEach(function (l) { QV.calls.forEach(function (c) { if ((c.lane || null) === l) ordered.push(c); }); });
    var shown = null;
    ordered.forEach(function (c) {
      if (lanes.length > 1 && (c.lane || null) !== shown) { shown = c.lane || null; var ac = shown ? actorOf(shown) : null; list.append(el('div', { class: 'qactor' }, ac ? ac.name : 'Other')); }
      list.append(callRow(c));
    });
    box.append(list);
    return finish();
  }
  /* The current row stays on screen: the rail scrolls it into view when it nears an edge (the selection fill and the dot ring mark it; there is no playhead) */
  function showCurrent() {
    var r = POS[cur]; if (r === undefined || YC[r] === undefined) return;
    var ly = YC[r], y = sy(ly);
    var c = document.getElementById('gclipr'); if (c) c.setAttribute('height', ly);
    var sc = $('scroller'), top = sc.scrollTop, h = sc.clientHeight;
    if (y < top + H.step * 2 || y > top + h - H.step * 2) sc.scrollTo({ top: Math.max(0, y - h / 2), behavior: instant || reduced() ? 'auto' : 'smooth' });
  }

  /* ---------- panes ---------- */
  var VT = window.CoCheckViewTable;
  /* cpic: a connector's own PNG, served from the task's sealed picture store (never a page of a stored state) */
  function previewUrl(sha, page, cpic) { return withToken('/timeline/' + task + '/' + (cpic ? 'cpic/' + sha : page ? 'pdfpage/' + sha + '/' + page : 'preview/' + sha)); }
  var MAX_NOTES = 5, CLAMP_LINES = 6, clampers = [], curItems = [];
  /* text clamped to six lines with a "show all" toggle; the toggle shows only when the text really overflows (refreshClamps, after the node is in the page) */
  function clampText(tag, cls, kids, peers) {
    var node = el(tag, { class: cls + ' clamp' }, kids), all = [node].concat(peers || []);
    var btn = el('button', { class: 'toggle', type: 'button', hidden: '' }, 'show all');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      /* one toggle opens the whole card (its text, its place and the card itself) */
      var open = !node.classList.contains('open'); btn.textContent = open ? 'show less' : 'show all';
      all.forEach(function (n) { if (open) n.classList.add('open'); else n.classList.remove('open'); });
      layout(curItems);
    });
    clampers.push({ node: node, all: all, btn: btn });
    return [node, btn];
  }
  function refreshClamps() {
    clampers.forEach(function (c) {
      if (c.node.classList.contains('open')) { c.btn.hidden = false; return; }
      c.btn.hidden = !c.all.some(function (n) { return n.scrollHeight > n.clientHeight + 1 || Array.prototype.some.call(n.querySelectorAll ? n.querySelectorAll('.cs') : [], function (p) { return p.scrollHeight > p.clientHeight + 1; }); });
    });
  }
  /* returns {node, anchors: {boxIndex: element}} for one pane of a View, drawn from VT.describePane */
  var lazyPics = false;
  function paneEl(pane, boxes, side) {
    var wrap = el('div', { class: 'vw', 'data-pane': pane.id }), anchors = [], d = VT.describePane(pane, boxes, side);
    if (d.kind === 'frame') {
      /* a connector's html picture, in the same sandboxed frame the connector cards use: unboxed, never markup of this page */
      wrap.append(el('iframe', { class: 'cvframe', sandbox: '', src: d.src, referrerpolicy: 'no-referrer', loading: 'lazy', title: String(d.label || 'Picture') }));
      return { node: wrap, anchors: anchors, empty: false };
    }
    if (d.kind === 'text') {
      if (!d.lines.length) { wrap.append(el('div', { class: 'noline' }, String(pane.label || ''))); return { node: wrap, anchors: anchors, empty: false }; }
      var tt = el('table', { class: 'grid textpane' });
      d.lines.forEach(function (l) {
        if (l.gap) { tt.append(el('tr', { class: 'gaprow fold' }, el('td', { colspan: 2 }, l.hidden ? l.hidden + (l.hidden === 1 ? ' unchanged line' : ' unchanged lines') : '\u22ee'))); return; }
        if (l.filler) { tt.append(el('tr', { class: 'filler', 'aria-label': 'no line' }, el('th', { class: 'rowh' }), el('td', { class: 'code' }))); return; }
        var td = el('td', { class: 'code', 'data-line': l.n, title: l.text });
        var at = 0;
        l.marks.forEach(function (m) {
          if (m[0] > at) td.append(document.createTextNode(l.text.slice(at, m[0])));
          td.append(el('span', { class: 'w' }, l.text.slice(m[0], m[1]))); at = m[1];
        });
        if (at < l.text.length || !l.marks.length) td.append(document.createTextNode(l.text.slice(at)));
        if (l.box !== null) { td.classList.add('hit'); if (!anchors[l.box]) anchors[l.box] = td; }
        tt.append(el('tr', l.kind ? { class: 'ln ' + l.kind } : {}, el('th', { class: 'rowh' }, l.n), td));
      });
      wrap.append(el('div', { class: 'textscroll' }, tt));
    } else if (d.kind === 'picture') {
      var pw = el('div', d.page ? { class: 'pagewrap', 'data-page': d.page } : { class: 'pagewrap' }, el('img', lazyPics ? { src: previewUrl(d.sha, d.page, d.cpic), alt: d.label, width: d.width, height: d.height, loading: 'lazy' } : { src: previewUrl(d.sha, d.page, d.cpic), alt: d.label, width: d.width, height: d.height }));
      d.rects.forEach(function (r) {
        var bx = el('div', { class: 'bx' });
        bx.style.left = r.left + '%'; bx.style.top = r.top + '%'; bx.style.width = r.width + '%'; bx.style.height = r.height + '%';
        pw.append(bx); if (!anchors[r.box]) anchors[r.box] = bx;
      });
      wrap.append(pw);
      /* A chart picture is CoCheck's own sketch; the note says so */
      if (d.note) wrap.append(el('p', { class: 'sketchnote' }, d.note));
    } else {
      /* a pane with nothing to draw is an empty side; its label says why ("There was nothing here yet") */
      wrap.append(el('div', { class: 'empty' }, String(pane.label || (side === 'before' ? 'New' : 'Deleted'))));
    }
    return { node: wrap, anchors: anchors, empty: d.kind === 'card' };
  }
  /* A view of several panes shows one at a time, on tabs. A pane is named by the id after "before:" / "after:", so the before and after panes pair up.
     A pane with a box on either side, or present on one side only, is marked changed on both tabs. */
  function paneKey(p) { return String(p.id).replace(/^(before|after):/, ''); }
  function paneTitle(p) { return p.label; }
  /* a page tab reads from the picture's own label with the side word dropped (the pane already says which side): "Before, page 2 of 5" reads "Page 2 of 5";
     with no label, "2 of 5" from its page and the page count (the picture's pageCount, else the pages on that side). Any other tab (a sheet, a name) reads as it came. */
  var SIDE_PAGE = /^\s*(?:before|after)\s*[,:]\s*(page\b.*)$/i;
  function tabText(pane, label, total) {
    var m = SIDE_PAGE.exec(String(label || '')), pic = pane && pane.picture;
    if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1);
    var of = pic && Number.isInteger(pic.pageCount) ? pic.pageCount : total;
    if (!label && pic && Number.isInteger(pic.page) && of) return pic.page + ' of ' + of;
    return String(label || '');
  }
  function dict() { return Object.create(null); }
  function sheetPlan(view, key) {
    /* sheet names are user text: every map keyed by one has no prototype, so constructor, toString and __proto__ are ordinary names */
    var keys = [], title = dict(), sideTitle = { before: dict(), after: dict() }, kind = dict(), byId = { before: dict(), after: dict() }, have = { before: dict(), after: dict() }, changed = dict();
    ['after', 'before'].forEach(function (side) {
      view[side].forEach(function (p) {
        byId[side][p.id] = p;
        if (p.changed === true) changed[paneKey(p)] = true;
        var d = VT.describePane(p, [], side);
        if (d.kind === 'card') return;
        var k = paneKey(p);
        if (!(k in title)) { keys.push(k); title[k] = paneTitle(p); kind[k] = d.kind; }
        have[side][k] = p; sideTitle[side][k] = paneTitle(p);
      });
    });
    keys.forEach(function (k) { if (!have.before[k] || !have.after[k]) changed[k] = true; });
    (view.marks || []).forEach(function (b) {
      var p = byId[b.side] && byId[b.side][b.pane];
      if (p) changed[paneKey(p)] = true;
    });
    var first = keys[0];
    for (var i = 0; i < keys.length; i++) if (changed[keys[i]]) { first = keys[i]; break; }
    /* A paged review view scrolls its pages (fillPaged), so it has no tabs and nothing for [ and ] to step */
    var paged = pagedView(view, key);
    if (paged) keys = [];
    return { paged: paged, keys: keys, title: title, sideTitle: sideTitle, kind: kind, have: have, changed: changed, sel: first, sides: {} };
  }
  /* a tab for a page the other side has: it says it is not on this side */
  function absentTitle(side, k) {
    var m = /^page(\d+)$/.exec(k);
    return (side === 'before' ? 'Before' : 'After') + ', ' + (m ? 'page ' + m[1] : k) + ': ' + (side === 'before' ? 'not there yet' : 'gone now');
  }
  function selectSheet(plan, k, focus, quiet) {
    if (plan.keys.indexOf(k) < 0) return;
    plan.sel = k;
    ['before', 'after'].forEach(function (side) {
      var st = plan.sides[side]; if (!st) return;
      plan.keys.forEach(function (kk) {
        var on = kk === k, t = st.tabs[kk];
        t.className = 'tab' + (on ? ' on' : '') + (plan.changed[kk] ? ' chg' : '');
        t.setAttribute('aria-selected', on ? 'true' : 'false'); t.setAttribute('tabindex', on ? '0' : '-1');
        st.wraps[kk].hidden = !on;
      });
      if (focus === side) st.tabs[k].focus();
      /* the chosen tab is always reachable on both panes, however many sheets the strip holds */
      if (st.tabs[k].scrollIntoView) st.tabs[k].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    if (!quiet) layout(curItems);
  }
  function stepSheet(delta, focus) {
    var plan = curPlan; if (!plan || plan.keys.length < 2) return false;
    var i = plan.keys.indexOf(plan.sel) + delta;
    if (i < 0 || i >= plan.keys.length) return true;
    selectSheet(plan, plan.keys[i], focus); return true;
  }
  var curPlan = null;
  function fillSide(side, view, boxes, plan, gone) {
    var vw = $(side === 'after' ? 'va' : 'vb'), tabs = $(side === 'after' ? 'ta' : 'tb'), found = {};
    if (side === 'before') snapshotScroll();
    vw.textContent = ''; tabs.textContent = '';
    var lp = $(side === 'after' ? 'lpa' : 'lpb'); if (lp) lp.textContent = '';
    /* a side that did not exist (a created or removed subject) is not drawn at all: the other side takes the stage's width */
    if (gone === side) return found;
    var panes = view[side];
    /* A picture still being drawn is the loading widget; waitForPicture draws the finished view, or words when it stops asking */
    if (view.pending && !panes.length) { vw.append(el('div', { class: 'loadpane' }, loading(side === 'before' ? 'Drawing the before picture' : 'Drawing the after picture'))); return found; }
    /* a spreadsheet that gained sheets has none on its before side while the file existed, so that side never says the file was not there (in words, no tabs) */
    if (!panes.length && view.kind === 'grid' && view[side === 'after' ? 'before' : 'after'].length) { vw.append(el('div', { class: 'empty' }, side === 'before' ? 'This sheet did not exist yet.' : 'This sheet is gone now.')); return found; }
    if (!panes.length) { 
      /* "no picture" is only for a rendering that failed, and it says why */
      var officeOff = view.kind === 'card' && view.caveats && view.caveats[0] === 'Office pictures not available yet';
      vw.append(el('div', { class: view.kind === 'card' ? 'cardbody' : 'empty' }, officeOff ? view.caveats[0] : view.kind === 'card' ? 'There is no picture of this file to show.' : VT.emptyPaneText(view, side)));
      if (view.kind === 'card' && view.caveats && view.caveats.slice(officeOff ? 1 : 0).length) vw.append(el('div', { class: 'cardbody' }, (officeOff ? view.caveats.slice(1) : view.caveats).join(' ')));
      return found; }
    if (plan.paged) return fillPaged(side, view, boxes, vw);
    var drawn = panes.map(function (p) { return paneEl(p, boxes, side); });
    var cardAt = drawn.filter(function (r) { return r.empty; })[0];
    if (cardAt) { vw.append(cardAt.node); return found; }
    var st = plan.sides[side] = { tabs: dict(), wraps: dict() };
    tabs.setAttribute('role', 'tablist');
    plan.keys.forEach(function (k) {
      var idx = -1; panes.forEach(function (p, i) { if (paneKey(p) === k && idx < 0) idx = i; });
      var node, label = idx >= 0 ? plan.sideTitle[side][k] : absentTitle(side, k);
      if (idx >= 0) {
        node = drawn[idx].node;
        drawn[idx].anchors.forEach(function (a, bi) { if (a && !found[bi]) found[bi] = a; });
      } else {
        node = el('div', { class: 'vw' }, el('div', { class: 'empty' }, side === 'before' ? 'This page did not exist yet.' : 'This page is gone now.'));
      }
      var t = el('button', { type: 'button', class: 'tab', role: 'tab', 'data-sheet': k, 'aria-label': label + (plan.changed[k] ? ', changed' : '') }, tabText(idx >= 0 ? panes[idx] : null, label, panes.length));
      t.addEventListener('click', function () { selectSheet(plan, k, side); });
      st.tabs[k] = t; st.wraps[k] = node; tabs.append(t); vw.append(node);
    });
    return found;
  }
  function plainView(rc, why) {
    return VT.sceneOf({ file: rc.file, kind: 'card', caveats: [why] });
  }

  /* ---------- tree ---------- */
  function buildTree(node, rows) {
    node.textContent = ''; node.hidden = false; var hit = null;
    rows.forEach(function (r) {
      var row;
      if (r.gap) row = el('div', { class: 'tr gap' }, 'New');
      else {
        var nm = el('span', { class: 'nm' }, r.name);
        row = el('div', { class: 'tr ' + (r.t === 'dir' ? 'dir' : '') + (r.target ? ' new' : '') },
          r.t === 'dir' ? el('span', { class: 'ch' }, r.open ? '▾' : '▸') : null, el('span', { class: 'ic ' + (r.t === 'dir' ? 'd' : 'f') }), nm,
          r.t === 'dir' && !r.open ? el('small', {}, r.count + (r.count === 1 ? ' file' : ' files')) : null);
        if (r.target) hit = row;
      }
      row.style.paddingLeft = (r.depth * 16 + 2) + 'px';
      node.append(row);
    });
    return hit;
  }

  /* ---------- one moment ---------- */
  /* Key repeat asks for a view per step, and the server draws one at a time. makeAsker keeps only the newest ask: a step that follows
     another within `wait` ms is held back, and a newer ask aborts the one in flight (the server drops a conversion nobody waits on). Neighbour
     versions are fetched afterwards one by one, low priority, and aborted by the next real ask. Memory only: answers land in viewCache. */
  /* asker begin */
  function makeAsker(run, wait, T) {
    var cur = null, timer = null, last = -1e9, pre = null;
    function stopAll() { if (timer !== null) { T.clear(timer); timer = null; } if (cur) { cur.abort(); cur = null; } if (pre) { pre.abort(); pre = null; } }
    return {
      cancel: stopAll,
      ask: function (rc) {
        var t = T.now(), fast = t - last < wait; last = t; stopAll();
        return new Promise(function (resolve, reject) {
          function go() { timer = null; var c = cur = new T.Ctl(); run(rc, c.signal, false).then(resolve, reject); }
          if (fast) timer = T.set(go, wait); else go();
        });
      },
      prefetch: function (rcs, cached) {
        if (pre) pre.abort();
        var c = pre = new T.Ctl(), i = 0;
        (function next() {
          if (c.signal.aborted || i >= rcs.length) return;
          var rc = rcs[i++];
          if (cached(rc)) return next();
          run(rc, c.signal, true).then(next, next);
        })();
      }
    };
  }
  /* asker end */
  /* One try at a view. A failure carries a plain-words reason: the server could not be reached, or the status it answered. Failures are never cached. */
  function tryView(rc, signal, low) {
    var init = { headers: { accept: 'application/json' } };
    if (signal) init.signal = signal;
    if (low) init.priority = 'low';
    return fetch(withToken(rc.viewUrl), init).then(function (r) {
      if (!r.ok) { var e = new Error('The server answered ' + r.status + (r.statusText ? ' (' + r.statusText + ')' : '') + '.'); e.plain = true; throw e; }
      return r.json().then(function (j) { return VT.sceneOf(j); });
    }, function () { var e = new Error('The server cannot be reached.'); e.plain = true; e.aborted = !!(signal && signal.aborted); throw e; });
  }
  function fetchViewNow(rc, signal, low) {
    if (viewCache[rc.key]) return Promise.resolve(viewCache[rc.key]);
    /* a failed view is tried once more (never an aborted one); only a success is kept, so stepping back to the moment tries again */
    return tryView(rc, signal, low).catch(function (e) { if (e && e.aborted) throw e; return tryView(rc, signal, low); }).then(function (v) { if (!v.pending) viewCache[rc.key] = v; detFromView(rc, v); return v; });
  }
  var askerOne = null; /* built on first use, so the page's timers and AbortController are read when needed */
  function asker() { return askerOne || (askerOne = makeAsker(fetchViewNow, 150, { now: function () { return Date.now(); }, set: function (f, ms) { return setTimeout(f, ms); }, clear: function (t) { clearTimeout(t); }, Ctl: typeof AbortController === 'undefined' ? function () { var me = this; this.signal = { aborted: false }; this.abort = function () { me.signal.aborted = true; }; } : AbortController })); }
  function fetchView(rc) {
    if (viewCache[rc.key]) { if (askerOne) askerOne.cancel(); return Promise.resolve(viewCache[rc.key]); }
    return asker().ask(rc);
  }
  /* the settled version's neighbours in the Files view (next first), as changes with a view to fetch */
  function prefetchNeighbours() {
    if (mode !== 'files' || !FV || !FILES[fcur.f] || FILES[fcur.f].source) return;
    var f = FILES[fcur.f], rcs = [];
    [fcur.p + 1, fcur.p - 1].forEach(function (q) {
      if (q < 1 || q > f.versions.length) return;
      var st = STOPS[stopIndex(FV.versionAt(f, q).stop)];
      if (st && st.change && !st.change.secret && st.change.viewUrl) rcs.push(st.change);
    });
    if (rcs.length) asker().prefetch(rcs, function (rc) { return !!viewCache[rc.key]; });
  }
  function failureText(e) { return e && e.plain ? e.message : 'The answer could not be read.'; }
  /* The person's verdict on each stop. REV maps a stop id to {status, note, stale, history}; the server holds the truth, this only draws it. */
  var REV = {}, REVOK = false, STATUS_TEXT = { not_reviewed: 'Not reviewed', passed: 'Passed', failed: 'Failed' };
  function revOf(s) { return (s && REV[s.id]) || { status: 'not_reviewed', note: '', stale: false, history: [] }; }
  /* Only a change and a call header take a verdict. A header's state is its files': it has no verdict row of its own. */
  function reviewable(s) { return !!(s && (s.change || s.hdr)); }
  function coversOf(h) { return h.covers.map(function (id) { return STOPS[stopIndex(id)]; }).filter(Boolean); }
  function tally(h) { var t = { passed: 0, failed: 0, not_reviewed: 0 }; coversOf(h).forEach(function (s) { t[revOf(s).status]++; }); return t; }
  function stateOf(s) { if (!s || !s.hdr) return revOf(s).status; var t = tally(s); return t.failed ? 'failed' : t.not_reviewed ? 'not_reviewed' : 'passed'; }
  function needsVerdict(s) { return reviewable(s) && (s.hdr ? tally(s).not_reviewed > 0 : revOf(s).status === 'not_reviewed'); }
  /* the next shown step after `from` that still needs a verdict; a hidden actor's steps are skipped. -1 when there is none */
  function nextNeeding(from) { for (var j = from + 1; j < N; j++) if (isVis(j) && needsVerdict(STOPS[j])) return j; return -1; }
  /* where the page opens: always the very top, the first shown step (the first request), on every visit whatever the verdicts are.
     Only a #n the URL names is honoured. */
  function openingStep() { return VIS.length ? VIS[0] : 0; }
  /* A verdict can open or close a call header (closed once every file under it has one), so the rail is brought up to date first */
  function paintRows() { syncRail(opened); paintRowStatus(); }
  function paintRowStatus() {
    document.querySelectorAll('.row').forEach(function (r) {
      var st = STOPS[+r.getAttribute('data-i')]; if (!st) return;
      var v = stateOf(st); r.setAttribute('data-status', reviewable(st) ? v : 'none');
      var tg = tagOf(st);
      r.setAttribute('aria-label', railTip(st).replace(/\.\s*$/, '') + '.' + (reviewable(st) ? ' ' + STATUS_TEXT[v] + '.' : '') + (tg ? ' ' + tg.text + '.' : ''));
    });
  }
  /* A part that leaves fades out first (about 140 ms, the .leaving animation), unless reduced motion is asked for. Showing it again
     cancels the leave. Moving to another step still hides at once (paintVerdict): no motion lags behind a move. A page with no matchMedia or
     no timers is treated as asking for reduced motion: it hides at once. The pending leaves are kept here, never as a property of the element. */
  var LEAVE_MS = 140, LEAVES = [];
  function still() {
    if (typeof window.matchMedia !== 'function' || typeof setTimeout !== 'function' || typeof clearTimeout !== 'function') return true;
    var q = window.matchMedia('(prefers-reduced-motion: reduce)');
    return !q || q.matches !== false;
  }
  function leaving(n) { return LEAVES.some(function (l) { return l.n === n; }); }
  function hideSoft(n) {
    if (n.hidden || leaving(n)) return;
    if (still()) { n.hidden = true; return; }
    n.classList.add('leaving');
    var l = { n: n };
    l.t = setTimeout(function () { LEAVES = LEAVES.filter(function (x) { return x !== l; }); n.classList.remove('leaving'); n.hidden = true; }, LEAVE_MS);
    LEAVES.push(l);
  }
  function stopLeave(n) {
    LEAVES = LEAVES.filter(function (l) { if (l.n !== n) return true; clearTimeout(l.t); n.classList.remove('leaving'); return false; });
  }
  function showSoft(n) { stopLeave(n); n.hidden = false; }
  function hideNow(n) { stopLeave(n); n.hidden = true; }
  function pressed(id) { return $(id).getAttribute('aria-pressed') === 'true'; }
  var failFor = null, failRegs = [], noteRegs = [];
  /* a history row's time in the page's own style (files-view: "4:54 PM"); the date only when it is not today */
  function histTime(ts) {
    var d = new Date(ts); if (isNaN(d.getTime())) return '';
    var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), n = new Date();
    return d.toDateString() === n.toDateString() ? t : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + t;
  }
  function paintVerdict() { paintVerdictBody(); paintPbar(); paintTool(); }
  function paintVerdictBody() {
    var stop = STOPS[cur], on = !QV && REVOK && reviewable(stop);
    /* a live refresh repaints the verdict on the step the person is failing: the open note and what they typed stay */
    if (!(failFor && stop && failFor === stop.id && !$('pcomp').hidden)) { failFor = null; failRegs = []; paintChips(); hideNow($('pcomp')); $('vnote').value = ''; }
    $('vstat').hidden = true; $('vstat').textContent = '';
    var list = $('vhistlist'); list.textContent = ''; $('vhist').hidden = true;
    if (!on) return;
    if (stop.hdr) {
      paintHeader(stop);
    } else {
      var v = revOf(stop);
      var fail = v.status === 'failed';
      if (fail && v.note) { $('vstat').textContent = ''; $('vstat').append(el('span', { class: 'vsnote' }, v.note), el('span', { class: 'vsedit', 'aria-hidden': 'true' }, 'Edit')); $('vstat').setAttribute('aria-label', 'Failed: ' + v.note + '. Edit this note'); $('vstat').hidden = false; }
      v.history.forEach(function (h) {
        list.append(el('li', { class: 'vh' + (h.current ? '' : ' old') }, el('span', { class: 'vhs ' + h.status }, STATUS_TEXT[h.status]), el('span', { class: 'vhn' }, h.note || ''), el('span', { class: 'vhw' }, h.reviewer + (h.current ? '' : ' (on earlier content)')), el('time', { class: 'vht', datetime: String(h.ts) }, histTime(h.ts))));
      });
      $('vhistsum').textContent = 'History (' + v.history.length + ')';
      $('vhist').hidden = v.history.length === 0;
    }
  }
  /* a header step's body: the files under it, each with its state and a way to it. When the call failed, one line says so first,
     with the output's error line when the record holds one */
  function paintHeader(h) {
    var box = $('hdrview'); box.textContent = '';
    var cf = $('callfail'), bad = coversOf(h).filter(function (s) { return s.call && s.call.failed && (s.failure || s.change.failed); })[0];
    cf.textContent = '';
    if (bad) { cf.append(document.createTextNode('The call failed.')); if (bad.failure && bad.failure.hasText !== false) cf.append(el('span', { class: 'err' }, bad.failure.raw)); }
    cf.hidden = !bad;
    coversOf(h).forEach(function (s) {
      var v = revOf(s).status;
      box.append(el('button', { type: 'button', class: 'hf', onclick: function () { jump(s.id); } }, el('span', { class: 'fn' }, s.label), el('span', { class: 'st ' + v, title: STATUS_TEXT[v], 'aria-label': STATUS_TEXT[v] }, v === 'passed' ? '\u2713' : v === 'failed' ? '\u2715' : '')));
    });
  }
  function postVerdict(id, status, note, regions) {
    var body = { stop: id, status: status, note: note || '' };
    if (regions && regions.length) body.regions = regions;
    return fetch(withToken('/timeline/' + task + '/review/verdict'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error ? j.error : 'The verdict was not saved.'); return j; }); })
      .then(function (j) { REV[id] = j.state; noteFailed(j); return j; });
  }
  /* One verdict at a time, in rail order, so the last answer carries the summary of every write before it */
  function postAll(items) { return items.reduce(function (p, x) { return p.then(function () { return postVerdict(x.id, x.status, x.note, x.regions); }); }, Promise.resolve()); }
  /* A verdict on the step on show. On a call header it covers every file under it with no verdict of its own (a file's own verdict wins);
     clearing a header clears the files it shows as passed or failed. P moves on to the next step that needs a verdict; the Pass button stays on the step (passClick). */
  var LAST = null, toastTimer = null;
  function setVerdict(status, note, advance) {
    var stop = STOPS[cur], sid = stop && stop.id; $('vmsg').textContent = '';
    /* the one gate every verdict input passes: only the step on show is ever judged (verdictStop), whichever button or key asked */
    if (!REVOK || !reviewable(stop) || verdictStop() !== stop) return;
    /* A poll can insert steps while a verdict is in flight, so the step is followed by id, never by the index it had */
    function here() { return !!STOPS[cur] && STOPS[cur].id === sid; }
    /* On a header: Pass takes the files with no verdict, Fail takes every file not already failed (it overrides a pass, never a file's own fail), clearing takes every file with a verdict */
    var targets = !stop.hdr ? [stop] : coversOf(stop).filter(function (s) { var v = revOf(s).status; return status === 'not_reviewed' ? v !== 'not_reviewed' : status === 'failed' ? v !== 'failed' : v === 'not_reviewed'; });
    if (!targets.length) {
      if (stop.hdr) $('vmsg').textContent = status === 'failed' ? 'Nothing to fail: every file under it already failed.' : status === 'passed' ? 'Nothing to pass: every file under it already has a verdict.' : 'Nothing to clear: no file under it has a verdict.';
      if (advance && status === 'passed') moveOn(stopIndex(sid));
      paintPbar();
      return;
    }
    var prev = targets.map(function (s) { var v = revOf(s); return { id: s.id, status: v.status, note: v.note }; });
    var regions = status === 'failed' && !stop.hdr ? failRegs.map(function (r) { return r.id; }) : [], draft = status === 'failed' && !stop.hdr ? { note: note, regs: failRegs.slice() } : null;
    postAll(targets.map(function (s) { return { id: s.id, status: status, note: note, regions: regions }; })).then(function () {
      if (status === 'failed' && failFor === stop.id) { failRegs = []; failFor = null; hideNow($('pcomp')); paintChips(); paintTool(); }
      LAST = { step: stop.id, prev: prev, draft: draft };
      var name = stop.hdr ? 'the ' + targets.length + (targets.length === 1 ? ' file' : ' files') + ' under “' + stop.label + '”' : stop.label;
      toast((status === 'passed' ? 'Passed ' : status === 'failed' ? 'Failed ' : 'Cleared the verdict on ') + name + '.');
      paintRows(); repaintList();
      if (advance && status === 'passed' && here()) moveOn(stopIndex(sid)); else if (here()) paintVerdict(); else paintPbar();
    }).catch(function (e) { $('vmsg').textContent = (e && e.message) || 'The verdict was not saved.'; paintRows(); if (here() && status !== 'failed') paintVerdict(); else paintPbar(); });
  }
  /* On to the next step that needs a verdict. The Timeline walks its shown rows first; either view then falls back to the next unjudged change after this one, wrapping to the first (the bar's count), and opens the header over it. */
  function moveOn(at) {
    var nx = mode === 'files' ? -1 : nextNeeding(at);
    if (nx >= 0) { go(nx); return; }
    var s = STOPS[at], id = s ? nextUnjudged(s.hdr ? s.covers[s.covers.length - 1] : s.id) : null;
    if (id) { barGo(id); }
  }
  function startFail(prefill) {
    if (!REVOK || !verdictStop()) return;
    if (noteFor !== null && !$('ncomp').hidden) { $('vmsg').textContent = 'Save or cancel the sticky note first.'; paintPbar(); return; }
    $('vmsg').textContent = ''; showSoft($('pcomp')); failFor = STOPS[cur].id; failRegs = []; paintChips(); $('vnote').value = typeof prefill === 'string' ? prefill : ''; paintTool(); paintPbar(); $('vnote').focus();
  }
  function saveFail() {
    /* the note saves only onto the step it was opened on, and only while that step is on show */
    var t = verdictStop(); if (!t || failFor !== t.id) return;
    var note = $('vnote').value.trim();
    if (!note) { $('vmsg').textContent = 'Say what’s wrong to fail it.'; $('vnote').focus(); return; }
    setVerdict('failed', note, false);
  }
  /* Cancel ends the composer: the bar shows the step's saved verdict again, untouched */
  function cancelFail() { hideSoft($('pcomp')); failFor = null; failRegs = []; paintChips(); $('vmsg').textContent = ''; paintTool(); paintPbar(); }
  /* ---------- region notes: with the Point tool on, draw on a pane to point at a spot ---------- */
  var MAX_REGIONS = 4, MIN_DRAG = 4, drag = null;
  /* the open note a drag belongs to: the fail box of the step on show, else the new sticky note. A fail box left over from another step takes nothing. */
  function regionCtx() {
    var fb = $('pcomp'), nc = $('ncomp');
    if (failFor && STOPS[cur] && failFor === STOPS[cur].id && (!$('head').hidden || mode === 'files') && !fb.hidden && !leaving(fb)) return 'fail';
    if (noteFor === 0 && !nc.hidden && !leaving(nc)) return 'note';
    return null;
  }
  /* the chip ids a send-back body adds; undefined with no spot, so JSON.stringify leaves the key out */
  function regionIds(list) { return list.length ? list.map(function (r) { return r.id; }) : undefined; }
  function regsOf(ctx) { return ctx === 'fail' ? failRegs : noteRegs; }
  function paintChips() {
    ['fail', 'note'].forEach(function (ctx) {
      var box = $(ctx === 'fail' ? 'vchips' : 'nchips'); if (!box) return;
      box.textContent = '';
      regsOf(ctx).forEach(function (r) {
        var x = el('button', { type: 'button', 'aria-label': 'Remove this spot: ' + r.where }, '\u00d7');
        x.addEventListener('click', function () {
          var list = regsOf(ctx), at = list.indexOf(r);
          if (at < 0) return;
          list.splice(at, 1); paintChips();
        });
        var face = r.picture ? el('img', { src: withToken('/timeline/' + task + '/region/' + r.id), alt: r.where, title: r.where }) : document.createTextNode(r.where);
        box.append(el('span', { class: 'rchip' }, face, x));
      });
    });
  }
  function postRegion(ctx, body) {
    var list = regsOf(ctx), say = $(ctx === 'fail' ? 'vmsg' : 'sbmsg');
    if (ctx === 'fail' && list.length + (list.pending || 0) >= MAX_REGIONS) { say.textContent = 'At most four spots on one note.'; return; }
    list.pending = (list.pending || 0) + 1; say.textContent = '';
    fetch(withToken('/timeline/' + task + '/review/region'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error ? j.error : 'That spot was not saved.'); return j; }); })
      .then(function (j) {
        list.pending--;
        /* the note this spot was drawn for is gone (saved, cancelled, or another step): the spot is dropped, never moved to the note now open */
        if (list !== regsOf(ctx)) return;
        if (ctx === 'note') list.length = 0; /* a sticky note points at one spot: a newer one replaces the older */
        list.push({ id: j.id, where: String(j.where || 'A spot'), picture: j.picture === true }); paintChips();
      })
      .catch(function (e) { list.pending--; say.textContent = (e && e.message) || 'That spot was not saved.'; });
  }
  function upFrom(t, test) { for (var n = t; n; n = n.parentNode) { var v = test(n); if (v) return v === true ? n : v; } return null; }
  function sideOf(t) { return upFrom(t, function (n) { return n.id === 'pb' ? 'before' : n.id === 'pa' ? 'after' : null; }); }
  function lineNo(t) { var v = upFrom(t, function (n) { return n.getAttribute && n.getAttribute('data-line'); }); return v === null ? null : Number(v); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  /* The region tool has no switch of its own: drawing is on exactly while the fail composer of the step on show (or the whole-task note panel) is open. Box and Freehand sit in both. */
  var tool = { mode: 'box' }, MAX_POINTS = 400, MIN_LASSO = 8;
  function paintTool() {
    if (!tool) return;
    ['regbox', 'nregbox'].forEach(function (id) { $(id).setAttribute('aria-pressed', String(tool.mode === 'box')); });
    ['regfree', 'nregfree'].forEach(function (id) { $(id).setAttribute('aria-pressed', String(tool.mode === 'free')); });
    var on = !!regionCtx();
    /* a composer open takes the bar's room: the settings menu closes so it never paints over Box, Freehand, Save and Cancel */
    if (menuOpen() && (!$('pcomp').hidden || !$('ncomp').hidden)) setMenu(false, false);
    if (!on) dropDrag();
    if (document.body.classList) { if (on) document.body.classList.add('regon'); else document.body.classList.remove('regon'); }
    /* a drag over a box must reach the page under it: nothing stays focused while the Point tool is on (the CSS also takes the pointer from boxes and comments) */
    if (on) hvClear();
  }
  paintTool();
  [['regbox', 'box'], ['nregbox', 'box'], ['regfree', 'free'], ['nregfree', 'free']].forEach(function (p) { $(p[0]).addEventListener('click', function () { tool.mode = p[1]; paintTool(); }); });
  function dropDrag() { var d = drag; drag = null; if (d && d.shape && d.shape.parentNode) d.shape.parentNode.removeChild(d.shape); }
  /* at most n points kept, evenly spread, first and last always in */
  function thin(pts, n) {
    if (pts.length <= n) return pts;
    var out = []; for (var i = 0; i < n; i++) out.push(pts[Math.round(i * (pts.length - 1) / (n - 1))]);
    return out;
  }
  function inside(pts, x, y) {
    var c = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var a = pts[i], b = pts[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  /* every element in a pane carrying the attribute, on the tab on show only (a hidden tab has no box) */
  function within(root, attr, out) {
    for (var i = 0; i < (root.children || []).length; i++) {
      var c = root.children[i];
      if (c.getAttribute && c.getAttribute(attr) !== null && !c.closest('.vw[hidden]')) out.push(c);
      within(c, attr, out);
    }
    return out;
  }
  function boxOf(pts) {
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    pts.forEach(function (p) { x1 = Math.min(x1, p[0]); x2 = Math.max(x2, p[0]); y1 = Math.min(y1, p[1]); y2 = Math.max(y2, p[1]); });
    return { x1: x1, y1: y1, x2: x2, y2: y2 };
  }
  function dragStart(e) {
    drag = null;
    if (e.button || !regionCtx() || !REVOK) return;
    var st = STOPS[cur]; if (!st || !st.change) return;
    var side = sideOf(e.target); if (!side) return;
    var pw = upFrom(e.target, function (n) { return n.classList && n.classList.contains && n.classList.contains('pagewrap'); });
    var line = pw ? null : lineNo(e.target);
    if (!pw && line === null) return;
    drag = { side: side, change: st.change.key, view: mode, x: e.clientX, y: e.clientY, pts: [[e.clientX, e.clientY]], free: tool.mode === 'free', pw: pw, line: line };
    if (e.preventDefault) e.preventDefault();
    /* the drawn shape lives on the page itself, in window coordinates, so one overlay serves every pane kind */
    if (drag.free) { drag.shape = mk('svg', { class: 'regsvg' }); drag.poly = mk('polygon', { class: 'regpoly', points: e.clientX + ',' + e.clientY }); drag.shape.append(drag.poly); }
    else drag.shape = el('div', { class: 'regsel' });
    document.body.append(drag.shape);
  }
  function dragMove(e) {
    if (!drag || !drag.shape) return;
    if (drag.free) {
      var l = drag.pts[drag.pts.length - 1];
      if (Math.abs(e.clientX - l[0]) + Math.abs(e.clientY - l[1]) >= 2) { drag.pts.push([e.clientX, e.clientY]); drag.poly.setAttribute('points', drag.pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ')); }
      return;
    }
    var s = drag.shape.style;
    s.left = Math.min(drag.x, e.clientX) + 'px'; s.top = Math.min(drag.y, e.clientY) + 'px';
    s.width = Math.abs(e.clientX - drag.x) + 'px'; s.height = Math.abs(e.clientY - drag.y) + 'px';
  }
  function dragEnd(e) {
    var d = drag; dropDrag(); if (!d) return;
    /* the same step and view the drag began in: a drag that ends after the step or the view moved points at nothing */
    if (!regionCtx() || mode !== d.view || !STOPS[cur] || !STOPS[cur].change || STOPS[cur].change.key !== d.change) return;
    var body = null, over = sideOf(e.target), pts = d.pts.concat([[e.clientX, e.clientY]]), bb = boxOf(pts);
    if (d.free) { if (pts.length < 3 || bb.x2 - bb.x1 < 1 || bb.y2 - bb.y1 < 1) return; }
    else if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < MIN_DRAG) return;
    if (d.pw) {
      var r = d.pw.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return;
      var fx = function (v) { return clamp01((v - r.left) / r.width); }, fy = function (v) { return clamp01((v - r.top) / r.height); };
      var x1 = fx(bb.x1), x2 = fx(bb.x2), y1 = fy(bb.y1), y2 = fy(bb.y2);
      if (x2 <= x1 || y2 <= y1) return;
      var pg = d.pw.getAttribute('data-page'), im = d.pw.children && d.pw.children[0];
      var nw = Number(im && im.getAttribute && im.getAttribute('width')) || 0, nh = Number(im && im.getAttribute && im.getAttribute('height')) || 0;
      body = { change: d.change, side: d.side, kind: 'picture', page: pg ? Number(pg) : null, rect: [x1, y1, x2 - x1, y2 - y1] };
      if (d.free) {
        if (nw && nh ? (x2 - x1) * nw < MIN_LASSO || (y2 - y1) * nh < MIN_LASSO : bb.x2 - bb.x1 < MIN_LASSO || bb.y2 - bb.y1 < MIN_LASSO) return;
        body.shape = { type: 'lasso', points: thin(pts, MAX_POINTS).map(function (p) { return [fx(p[0]), fy(p[1])]; }) };
      }
    } else {
      if (over !== d.side) return;
      if (d.free && (bb.x2 - bb.x1 < MIN_LASSO || bb.y2 - bb.y1 < MIN_LASSO)) return;
      var pane = $(d.side === 'before' ? 'pb' : 'pa');
      if (!d.free) {
        var to = lineNo(e.target); if (to === null) return;
        body = { change: d.change, side: d.side, kind: 'lines', from: Math.min(d.line, to), to: Math.max(d.line, to) };
      } else {
        var ns = within(pane, 'data-line', []).filter(function (c) { var q = c.getBoundingClientRect(); return q.height > 0 && q.bottom >= bb.y1 && q.top <= bb.y2 && q.right >= bb.x1 && q.left <= bb.x2; }).map(function (c) { return Number(c.getAttribute('data-line')); });
        if (!ns.length) return;
        body = { change: d.change, side: d.side, kind: 'lines', from: Math.min.apply(null, ns), to: Math.max.apply(null, ns) };
      }
    }
    /* the composer of the step on show takes the spot, else the open whole-task note; with neither open nothing is drawn */
    var ctx = regionCtx();
    if (ctx) postRegion(ctx, body);
  }
  $('stage').addEventListener('mousedown', dragStart);
  window.addEventListener('mousemove', dragMove);
  window.addEventListener('mouseup', dragEnd);
  /* ---------- sticky notes: highlight a spot (Box, Freehand, or selected text on a text diff), type, save, repeat. The bar lists every live note; a marker sits on the change and side it was drawn on. ---------- */
  var NOTES = [], noteFor = null; /* noteFor: null closed, 0 a new note, else the id of the note being edited */
  function noteSay(t) { $('vmsg').textContent = t; paintPbar(); }
  /* the lines a text selection covers on one side of the diff on show, as the region body the server takes; null when it is not inside one text pane */
  function selectionRegion() {
    var sel = typeof window.getSelection === 'function' ? window.getSelection() : null, st = STOPS[cur];
    if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode || !st || !st.change) return null;
    var side = sideOf(sel.anchorNode); if (!side || side !== sideOf(sel.focusNode)) return null;
    var a = lineNo(sel.anchorNode), b = lineNo(sel.focusNode); if (a === null || b === null) return null;
    return { change: st.change.key, side: side, kind: 'lines', from: Math.min(a, b), to: Math.max(a, b) };
  }
  function openNoteBox(id, text) {
    noteFor = id; noteRegs = []; paintChips(); $('nnote').value = text; $('nlabel').textContent = id ? 'Edit this note' : 'Sticky note';
    showSoft($('ncomp')); paintTool(); $('nnote').focus();
  }
  function startNote(n) {
    if (!REVOK) return;
    if (failFor && !$('pcomp').hidden) { noteSay('Save or cancel the fail note first.'); return; }
    var open = noteFor !== null && !$('ncomp').hidden;
    if (n) {
      openNoteBox(n.id, n.text);
      /* a spot's change, else the step the note was made on (an old note has neither and stays put) */
      var s = n.region ? stopWithChange(n.region.change) : null, sid = s ? s.id : n.stop; if (sid && (!STOPS[cur] || STOPS[cur].id !== sid)) barGo(sid);
      return;
    }
    if (!open || noteFor !== 0) openNoteBox(0, '');
    var sr = selectionRegion(); if (sr) postRegion('note', sr);
    $('vmsg').textContent = ''; paintPbar();
  }
  function stopWithChange(key) { for (var i = 0; i < STOPS.length; i++) if (STOPS[i].change && STOPS[i].change.key === key) return STOPS[i]; return null; }
  function closeNote() { noteFor = null; noteRegs = []; paintChips(); $('nnote').value = ''; hideSoft($('ncomp')); paintTool(); }
  function sendNote(url, body) {
    return fetch(withToken('/timeline/' + task + url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error ? j.error : 'The note was not saved.'); return j; }); });
  }
  function saveNote() {
    var text = $('nnote').value.trim();
    if (!text) { noteSay('Write the note first.'); $('nnote').focus(); return; }
    if (noteRegs.pending) { noteSay('The spot is still being saved.'); return; }
    var id = noteFor, body = id ? { text: text } : { text: text, regionId: noteRegs.length ? noteRegs[0].id : undefined, stop: STOPS[cur] ? STOPS[cur].id : undefined };
    sendNote('/review/notes' + (id ? '/' + id : ''), body).then(function () { if (noteFor === id) closeNote(); noteSay(''); return loadStatus(); }).catch(function (e) { noteSay((e && e.message) || 'The note was not saved.'); });
  }
  function deleteNote(n) {
    sendNote('/review/notes/' + n.id, { deleted: true }).then(function () { if (noteFor === n.id) closeNote(); return loadStatus(); }).catch(function (e) { noteSay((e && e.message) || 'The note was not deleted.'); });
  }
  /* the bar's list: one entry per live note; the text reopens it for editing, the cross deletes it */
  function paintNotes() {
    var box = $('pnotes'); if (!box) return;
    box.textContent = ''; box.hidden = NOTES.length === 0;
    NOTES.forEach(function (n, i) {
      var go = el('button', { type: 'button', class: 'pnbtn', title: n.where ? n.text + ' (' + n.where + ')' : n.text }, (i + 1) + '. ' + (n.text.length > 40 ? n.text.slice(0, 40) + '…' : n.text));
      go.addEventListener('click', function () { startNote(n); });
      var del = el('button', { type: 'button', class: 'pndel', 'aria-label': 'Delete note ' + (i + 1) }, '×');
      del.addEventListener('click', function () { deleteNote(n); });
      box.append(el('span', { class: 'pnote', 'data-note': String(n.id) }, go, del));
    });
    var c = $('pbncount'); if (c) { c.hidden = NOTES.length === 0; c.textContent = String(NOTES.length); }
    paintSendBack(); paintMarks();
  }
  /* where a note's marker sits, in the stage's own coordinates: the corner of the spot it points at, else the top of its pane */
  function markPos(r, pane) {
    var at = null;
    if (r.kind === 'picture') {
      var w = within(pane, 'data-page', []).filter(function (x) { return r.page == null || x.getAttribute('data-page') === String(r.page); })[0];
      if (w) { var q = w.getBoundingClientRect(), rc = r.rect || [0, 0, 0, 0]; at = { left: q.left + rc[0] * q.width, top: q.top + rc[1] * q.height }; }
    } else {
      var want = String(r.from), t = within(pane, 'data-line', []).filter(function (x) { return x.getAttribute('data-line') === want; })[0];
      if (t) at = t.getBoundingClientRect();
    }
    if (!at) at = pane.getBoundingClientRect();
    var sg = $('stage').getBoundingClientRect();
    return { x: (at.left || 0) - (sg.left || 0), y: (at.top || 0) - (sg.top || 0) };
  }
  /* markers are redrawn from NOTES each time, in a container no render rebuilds; a note shows only on the change and side it was drawn on */
  function paintMarks() {
    var box = $('nmarks'); if (!box) return;
    box.textContent = '';
    var st = STOPS[cur]; if (!st || !st.change) return;
    NOTES.forEach(function (n, i) {
      var r = n.region; if (!r || r.change !== st.change.key) return;
      var pos; try { pos = markPos(r, $(r.side === 'before' ? 'pb' : 'pa')); } catch (e) { pos = { x: 0, y: 0 }; }
      var b = el('button', { type: 'button', class: 'nmark', 'data-note': String(n.id), 'data-side': r.side, title: n.text, 'aria-label': 'Note ' + (i + 1) + ': ' + n.text }, String(i + 1));
      b.style.left = pos.x + 'px'; b.style.top = pos.y + 'px';
      b.addEventListener('click', function () { startNote(n); });
      box.append(b);
    });
  }
  $('pbnote').addEventListener('click', function () { startNote(null); });
  $('ngo').addEventListener('click', saveNote);
  $('nno').addEventListener('click', function () { closeNote(); noteSay(''); });
  window.addEventListener('resize', paintMarks);
  /* the undo bar: six seconds, then the verdict stands. U or Undo puts back what each file had before and returns to that step. */
  function toast(text) {
    $('toasttext').textContent = text; showSoft($('toast'));
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { hideSoft($('toast')); LAST = null; }, 6000);
  }
  function undo() {
    if (!LAST) return;
    var l = LAST; LAST = null; clearTimeout(toastTimer); hideSoft($('toast'));
    postAll(l.prev).then(function () { paintRows(); repaintList(); relocate(l); reopenDraft(l); }).catch(function (e) { $('vmsg').textContent = (e && e.message) || 'The verdict was not put back.'; paintRows(); paintVerdict(); });
  }
  /* U on a failed step keeps what was typed: the composer comes back open on that step with its note and spots as a draft (nothing is saved until Save) */
  function reopenDraft(l) {
    var s = STOPS[cur]; if (!l.draft || !s || s.id !== l.step) return;
    failFor = s.id; failRegs = l.draft.regs; $('vnote').value = l.draft.note || ''; showSoft($('pcomp')); paintChips(); paintTool();
  }
  function relocate(l) {
    {
      var i = stopIndex(l.step), hh = i >= 0 && !isVis(i) ? headerOf(STOPS[i]) : null;
      if (mode === 'files') { if (i >= 0 && i !== cur) barGo(l.step); else paintVerdict(); return; }
      /* A file under a header closed by hand is reached through its header */
      if (hh && isVis(stopIndex(hh.id))) i = stopIndex(hh.id);
      if (i >= 0 && isVis(i) && i !== cur) { go(i); } else paintVerdict();
    }
  }
  /* The passes arrive with the status; the rail is drawn again only when they changed, keeping the person's place */
  function setPasses(p) {
    var next = p && Array.isArray(p.markers) && p.tags && typeof p.tags === 'object' ? p : null, key = JSON.stringify(next);
    if (key === passKey) return;
    passKey = key; PASSES = next;
    var kept = rebuildRail(false, buildRail); paintPlace(); showCurrent(); paintRows(); paintTag(); kept();
  }
  /* after a send-back or a submission the new marker is drawn at once; nothing else on the page is touched (a shown prompt stays) */
  function refreshPasses() {
    fetch(withToken('/timeline/' + task + '/review/status')).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { if (j && j.passes) setPasses(j.passes); if (j && Array.isArray(j.notes)) { NOTES = j.notes; paintNotes(); } }).catch(function () {});
  }
  /* The tag of the stop on show, in its header: what the stop is to the review before it, and the links between a failed stop and the stop that answers it */
  function jump(id) {
    var i = stopIndex(id); if (i < 0) return;
    var a = actorOf(STOPS[i].lane), h = headerOf(STOPS[i]);
    if (a && hidden.has(a.id)) membersOf(groupOf(a)).forEach(function (m) { hidden.delete(m.id); });
    /* A link to a file under a closed header opens that header */
    if (h && !isOpen(h)) hdrHand[h.id] = true;
    pendingFocus = true; go(i);
  }
  function txt(t) { return document.createTextNode(t); }
  function linkBtn(text, id) { return el('button', { type: 'button', class: 'stoplink', onclick: function () { jump(id); } }, text); }
  function paintTag() {
    var box = $('ptag'); if (!box) return;
    box.textContent = '';
    var stop = STOPS[cur], tg = tagOf(stop), by = stop && PASSES && PASSES.answeredBy ? PASSES.answeredBy[stop.id] : null, first = null;
    if (tg) {
      var pass = null; ((PASSES && PASSES.markers) || []).forEach(function (m) { if (m.pass === tg.pass) pass = m; });
      box.append(el('span', { class: 'pt ' + tg.tag }, (tg.tag === 'changes_passed' ? '⚠ ' : '') + tg.text + (pass ? ' (after “' + pass.label + '”)' : '')));
      if (tg.answers && stopIndex(tg.answers) >= 0) { first = linkBtn('Go to the step it answers: ' + STOPS[stopIndex(tg.answers)].label, tg.answers); box.append(txt(' '), first); }
    }
    var so = signoffTagOf(stop);
    paintSign(QV ? null : so);
    if (by && by.length) {
      box.append(el('span', { class: 'pt answered' }, (tg ? ' ' : '') + 'Reworked by a later step'));
      by.slice(0, 5).forEach(function (id) { if (stopIndex(id) < 0) return; var b = linkBtn('Go to the rework: ' + STOPS[stopIndex(id)].label, id); if (!first) first = b; box.append(txt(' '), b); });
      if (by.length > 5) box.append(txt(' and ' + (by.length - 5) + ' more'));
    }
    box.hidden = !(tg || (by && by.length));
    if (pendingFocus) { pendingFocus = false; if (first) first.focus(); }
  }
  /* the page opens at the top and stays there when the status route answers: only the paint of the rail waits for it (opened) */
  var opened = false, bootAt = -1, hashed = false;
  function openOnce() { opened = true; }
  /* The task's link to a send-back: "Round 2 of task <n>, after your send-back on <date>" on the fix task, "Fix came in as task <m>" on the one it came from. */
  function paintFollow(j) {
    var el = $('followline'); if (!el) return;
    var parts = [];
    if (j.follow && typeof j.follow.task === 'number') {
      var d = new Date(j.follow.sentAt);
      parts.push('Round 2 of task ' + j.follow.task + ', after your send-back on ' + (isNaN(d.getTime()) ? String(j.follow.sentAt) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })));
    }
    if (Array.isArray(j.followedBy)) j.followedBy.forEach(function (f) { if (f && typeof f.task === 'number') parts.push('Fix came in as task ' + f.task); });
    el.textContent = parts.join('. ');
    el.hidden = parts.length === 0;
  }
  function loadStatus() {
    return fetch(withToken('/timeline/' + task + '/review/status')).then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); }).then(function (j) {
      if (!j || typeof j.stops !== 'object' || j.stops === null) throw new Error('status shape');
      REV = j.stops; REVOK = true; SUBMITTED = j.submitted || null; SUBSTATE = typeof j.submitState === 'string' ? j.submitState : (j.submitted ? 'submitted' : 'none'); EARLIER = Array.isArray(j.earlier) ? j.earlier.length : 0; paintFollow(j); setPasses(j.passes); NOTES = Array.isArray(j.notes) ? j.notes : []; paintRows(); paintVerdict(); noteFailed(j); paintNotes();
      openOnce();
    }).catch(function () { REVOK = false; paintSendBack(); paintSubmit(); openOnce(); });
  }
  /* Toggle-off is decided here, never from the bar's pressed state (which reads "failed" when any covered file failed): a click clears only when every covered file already holds the verdict. */
  function holdsAll(status) { var s = STOPS[cur]; return !!s && (!s.hdr ? revOf(s).status === status : coversOf(s).every(function (c) { return revOf(c).status === status; })); }
  /* The Pass button stays on the step it judged, so a second click on the same step clears it (moving on at the second click would send it
     to the next step and then wrap to the first one). The P key still passes and moves on. */
  function passClick() { if (holdsAll('passed')) setVerdict('not_reviewed', '', false); else setVerdict('passed', '', false); }
  function failClick() { if (holdsAll('failed')) setVerdict('not_reviewed', '', false); else startFail(); }
  /* ---------- the review bar (#pbar): one stepper over the change stops, in both views. A position is one change stop, counted as the progress count counts them;
     the position and the undo are kept by stop id (BARID), so a poll that adds steps never moves them. The buttons are the page's own Pass and Fail handlers. ---------- */
  var BARID = null;
  function barStop() {
    var s = STOPS[cur];
    if (s && s.change) return s;
    var all = changeStops();
    if (s && s.hdr) { var cv = coversOf(s).filter(function (c) { return !!c.change; }); return cv.filter(needsVerdict)[0] || cv[0] || null; }
    for (var i = 0; i < all.length; i++) if (all[i].id === BARID) return all[i];
    return all[0] || null;
  }
  /* The step the bar's Pass and Fail judge and show: always the step on show, never another one. A step that takes no verdict (a request, a message,
     a finish, an opened quiet row, a read-only file in Deliverables) has none: the buttons are off and pressed by nothing. */
  function verdictStop() {
    if (QV) return null;
    if (mode === 'files') { var f = FILES[fcur.f]; if (!f || f.source) return null; }
    var s = STOPS[cur]; return reviewable(s) ? s : null;
  }
  function canClear() { var s = verdictStop(); return !!(REVOK && s && stateOf(s) !== 'not_reviewed'); }
  /* the next change after `fromId` with no verdict, wrapping round to the first; null when every change has one */
  function nextUnjudged(fromId) {
    var all = changeStops(), at = -1, i;
    for (i = 0; i < all.length; i++) if (all[i].id === fromId) at = i;
    for (i = 1; i <= all.length; i++) { var s = all[(at + i + all.length) % all.length]; if (s && s.id !== fromId && revOf(s).status === 'not_reviewed') return s.id; }
    return null;
  }
  function fileOfStop(id) {
    for (var fi = 0; fi < FILES.length; fi++) for (var vi = 0; vi < FILES[fi].versions.length; vi++) if (FILES[fi].versions[vi].stop === id) return { f: fi, p: vi + 1 };
    return null;
  }
  /* Make a change stop the one on show, in whichever view is open. A header over it opens (by hand, so it stays open) and a hidden actor is shown. */
  function barGo(id) {
    var i = stopIndex(id); if (i < 0) return;
    var a = actorOf(STOPS[i].lane); if (a && hidden.has(a.id)) membersOf(groupOf(a)).forEach(function (m) { hidden.delete(m.id); });
    revealStep(i);
    if (mode === 'files') { var at = fileOfStop(id); if (at) { fcur = at; ftrail = []; paintFiles(); return; } setMode('steps'); }
    computeVis(); go(i);
  }
  function repaintList() { if (mode === 'files' && FV && FILES.length) FV.paintList($('fileslist'), FILES, fcur.f, FH); }
  function paintPbar() {
    var box = $('pbar'); if (!box) return;
    /* a fail note belongs to the step on show: once what is on show takes no verdict (a quiet row, a read-only file) the note closes at once, unsaved */
    if (failFor && !verdictStop()) { failFor = null; failRegs = []; hideNow($('pcomp')); $('vnote').value = ''; paintChips(); paintTool(); }
    paintMarks();
    var all = changeStops(), b = REVOK ? barStop() : null;
    /* the bar is on whenever the rail is: with no change to step through (or no status) it shows the settings icon alone, so Newest first is always in reach */
    box.hidden = !(STOPS && STOPS.length);
    if (box.classList) box.classList[b ? 'remove' : 'add']('solo');
    if (!b) return;
    BARID = b.id;
    /* The position and the arrows keep to the last change shown (BARID); the label, Pass and Fail are the step on show's alone (a verdict that
       acted on whichever change the bar was last on would follow the person to every step that takes none). An open fail note shows Fail pressed. */
    var at = all.indexOf(b), cs = STOPS[cur], t = verdictStop(), st = !t ? 'none' : failFor === t.id && !$('pcomp').hidden && !leaving($('pcomp')) ? 'failed' : stateOf(t);
    /* the position shows only on a step that takes a verdict ("23 of 40"); a request, a message or an opened quiet row
       shows none, never a "1 of 40" that reads as the start */
    $('pbpos').textContent = t ? (at + 1) + ' of ' + all.length : '';
    var rf = mode === 'files' ? FILES[fcur.f] : null;
    $('pblabel').textContent = t ? t.label || '' : QV ? $('h1').textContent : rf ? rf.name || String(rf.file || '').split('/').pop() : (cs && cs.label) || '';
    $('pbmsg').textContent = $('vmsg').textContent || '';
    $('pbprev').disabled = at <= 0; $('pbnext').disabled = at >= all.length - 1;
    $('pbpass').disabled = !t; $('pbfail').disabled = !t;
    /* the Fail/Pass pair is not drawn on a step that takes no verdict (it never becomes available there); the P and F keys follow verdictStop */
    var pv = $('pbverdict'); if (pv) pv.hidden = !t;
    $('pbpass').setAttribute('aria-pressed', String(st === 'passed')); $('pbfail').setAttribute('aria-pressed', String(st === 'failed'));
    $('stage').setAttribute('data-verdict', st === 'passed' || st === 'failed' ? st : 'none');
    /* after the last stop: Send back when a live fail stands (it blocks sign-off), else Sign off; both are the task bar's own buttons */
    var done = all.every(function (s) { return revOf(s).status !== 'not_reviewed'; }), fails = liveFails(), signed = !!SUBMITTED && SUBSTATE !== 'new_work';
    var act = $('pbact'), src = fails > 0 ? $('sendback') : $('submit');
    act.hidden = !done || (fails === 0 && signed);
    act.textContent = fails > 0 ? 'Send back' : (SUBMITTED ? 'Sign off again' : 'Sign off');
    act.disabled = !!src.disabled;
  }
  /* Pass and Fail judge the step on show and nothing else; on a step that takes no verdict they do nothing (they are off there too) */
  $('pbpass').addEventListener('click', function () { if (verdictStop()) passClick(); });
  $('pbfail').addEventListener('click', function () { if (verdictStop()) failClick(); });
  $('pbprev').addEventListener('click', function () { var all = changeStops(), b = barStop(), i = all.indexOf(b); if (i > 0) barGo(all[i - 1].id); });
  $('pbnext').addEventListener('click', function () { var all = changeStops(), b = barStop(), i = all.indexOf(b); if (i >= 0 && i < all.length - 1) barGo(all[i + 1].id); });
  $('pbact').addEventListener('click', function () { var all = changeStops(); if (all.length && liveFails() > 0) $('sendback').click(); else $('submit').click(); });
  /* the saved fail note is the way back into it: click (a native button: Enter and Space too) reopens the composer with that note, for the step on show only (startFail holds the gate) */
  function editSaved() { var t = verdictStop(); if (t && !t.hdr && revOf(t).status === 'failed') startFail(revOf(t).note); }
  $('vstat').addEventListener('click', editSaved);
  $('vfailgo').addEventListener('click', saveFail);
  $('vfailno').addEventListener('click', cancelFail);
  /* the fail note's own keys: Enter saves (Shift+Enter is a new line), Escape cancels. Nothing else is taken, and no other field has these. */
  $('vnote').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveFail(); } else if (e.key === 'Escape') { e.preventDefault(); cancelFail(); } });
  $('undo').addEventListener('click', undo);
  /* The task bar. Progress counts changes only (a header, a request or a message is not a change), and every change, hidden or not. */
  function changeStops() { return STOPS.filter(function (s) { return !!s.change; }); }
  /* A fail on a file version a later recorded state replaced is not counted and does not enable Send back (the server skips it too); its own step still shows failed. */
  function liveFails() {
    var gone = SUBMIT && Array.isArray(SUBMIT.superseded) ? SUBMIT.superseded : [];
    return changeStops().filter(function (s) { return revOf(s).status === 'failed' && gone.indexOf(s.id) < 0; }).length;
  }
  function paintBar() {
    var all = changeStops(), done = all.filter(function (s) { return revOf(s).status !== 'not_reviewed'; }).length;
    var fails = liveFails();
    $('progress').hidden = !REVOK || all.length === 0;
    $('progtext').textContent = done + ' of ' + all.length + (all.length === 1 ? ' change' : ' changes') + ' reviewed';
    $('progring').style.strokeDashoffset = String(100 - (all.length ? Math.round(100 * done / all.length) : 0));
    $('failcount').hidden = fails === 0; $('failcount').textContent = String(fails);
    paintPbar();
  }
  $('sbclose').addEventListener('click', function () { clearPrompt(true); $('sendback').focus(); });
  /* Send back panel: the server writes the prompt from the record; this shows it as the prefilled value of an editable textarea (never markup). The fixed follow-up line sits outside the box; Copy puts the box text, a blank line and that line on the clipboard and records exactly that. */
  function paintSendBack() {
    var box = $('taskbar'); if (!box) return;
    box.hidden = !REVOK;
    var can = liveFails() > 0 || NOTES.length > 0;
    $('sendback').disabled = !can;
    /* Send back shows only once there is something to send (a failed change or a note), never as a dead button */
    $('sendback').hidden = !can;
    $('sendback').title = can ? '' : 'Fail a change or write a note to send the work back.';
    paintBar();
  }
  /* A shown prompt carries the notes it was built with, so a note change hides and empties it like a verdict change does. */
  /* A shown prompt belongs to the failed set it was built from: any verdict change or reload hides and empties it. */
  var sbDirty = false, sbMarker = '', sbId = 0;
  /* Text the person changed is theirs: a refresh, a verdict change or a note edit never hides or empties it. Only Done (force) clears it. */
  function clearPrompt(force) { if (sbDirty && force !== true) return; sbDirty = false; sbMarker = ''; sbId = 0; var o = $('sbout'); if (o) o.hidden = true; var t = $('sbtext'); if (t) t.value = ''; var mk = $('sbmarker'); if (mk) mk.textContent = ''; var m = $('sbmsg'); if (m) m.textContent = ''; }
  $('sbtext').addEventListener('input', function () { sbDirty = true; });
  function noteFailed(j) { if (j && j.submit) SUBMIT = j.submit; clearPrompt(); paintSendBack(); paintSubmit(); }
  $('sendback').addEventListener('click', function () {
    /* An edited box is kept: a new send-back would replace the person's words. Done clears it first. */
    if (sbDirty) { $('sbout').hidden = false; $('sbmsg').textContent = 'Your edited text is kept. Press Done to start over.'; return; }
    /* With failed steps and sticky notes both standing, the person picks whether the notes go too; with only one of them there is nothing to pick */
    var fails = liveFails();
    if (fails > 0 && NOTES.length > 0) {
      var d = $('sbdlg');
      $('sbwithnotes').checked = true; $('sbcommentsonly').checked = false;
      $('sbdlgtext').textContent = fails + (fails === 1 ? ' failed step' : ' failed steps') + ' and ' + NOTES.length + (NOTES.length === 1 ? ' sticky note' : ' sticky notes') + ' stand on this task.';
      if (d.showModal) d.showModal(); else d.open = true;
      $('sbwithnotes').focus();
      return;
    }
    postSendBack({});
  });
  function closeSbDlg() { var d = $('sbdlg'); if (d.close) d.close(); else d.open = false; }
  function sbDlgGo() { var notes = !$('sbcommentsonly').checked; closeSbDlg(); postSendBack({ notes: notes }); }
  function sbDlgCancel() { closeSbDlg(); $('sendback').focus(); }
  $('sbdlggo').addEventListener('click', sbDlgGo);
  $('sbdlgcancel').addEventListener('click', sbDlgCancel);
  /* Enter sends, Esc sends nothing; no key in the dialog reaches the page's own shortcuts */
  $('sbdlg').addEventListener('keydown', function (e) {
    if (e.stopPropagation) e.stopPropagation();
    if (e.key === 'Enter' && !(e.target && e.target.id === 'sbdlgcancel')) { e.preventDefault(); sbDlgGo(); }
    else if (e.key === 'Escape') { e.preventDefault(); sbDlgCancel(); }
  });
  function postSendBack(body) {
    $('sbmsg').textContent = '';
    fetch(withToken('/timeline/' + task + '/review/sendback'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error ? j.error : 'The send-back was not saved.'); return j; }); })
      .then(function (j) { $('sbtext').value = j.prompt; if (j.untracked) $('sbmsg').textContent = 'Tracking is off for this task, so CoCheck did not record the agent\'s recent work.'; sbDirty = false; sbId = j.id; sbMarker = j.marker; $('sbmarker').textContent = j.marker; $('sbout').hidden = false; $('sbtext').focus(); refreshPasses(); })
      .catch(function (e) { $('sbmsg').textContent = (e && e.message) || 'The send-back was not saved.'; });
  }
  $('sbcopy').addEventListener('click', function () {
    var t = $('sbtext'), text = t.value + '\n\n' + sbMarker;
    if (!sbMarker) return;
    var done = function () {
      $('sbmsg').textContent = 'Copied.';
      fetch(withToken('/timeline/' + task + '/review/sendback-copy'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sbId, text: text }) })
        .then(function (r) { if (!r.ok) $('sbmsg').textContent = 'Copied, but the copy was not recorded.'; }, function () { $('sbmsg').textContent = 'Copied, but the copy was not recorded.'; });
    }, fail = function () { $('sbmsg').textContent = 'Could not copy; select the text and copy it yourself.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else fail(); /* no clipboard API: select() + execCommand would copy the box alone, so nothing is copied and nothing is recorded */
  });
  /* Sign-off panel: the server decides (failed stops block, a not-reviewed set needs the acknowledgement); this only asks and shows its answer. */
  /* SUBSTATE is none (never submitted), submitted (nothing new since the latest submission) or new_work (file states landed since it: submit again). */
  var SUBMIT = null, SUBMITTED = null, SUBSTATE = 'none', EARLIER = 0;
  function stepsLeft(n) { return n + (n === 1 ? ' change' : ' changes') + ' not looked at'; }
  function paintSubmit() {
    var b = $('submit'); if (!b) return;
    var again = SUBMITTED && SUBSTATE === 'new_work', past = EARLIER > 0 ? ' Earlier sign-offs: ' + EARLIER + '.' : '';
    var ack = SUBMITTED && Array.isArray(SUBMITTED.acknowledged) ? SUBMITTED.acknowledged : [], left = changeStops().filter(function (s) { return ack.indexOf(s.id) >= 0; }).length; /* changes only, the unit of the progress line */
    b.textContent = again ? 'Sign off again' : 'Sign off';
    /* the count belongs to the sign-off on record, so it stays on show while the person decides whether to sign off again */
    $('submsg').textContent = SUBMITTED ? (again ? 'New or changed since you signed off.' : 'Signed off. You can still add to it.') + past : '';
    $('subleft').textContent = SUBMITTED && left > 0 ? ' ' + stepsLeft(left) : '';
    if (!REVOK || !SUBMIT || (SUBMITTED && !again)) { b.disabled = true; b.title = ''; return; }
    b.disabled = SUBMIT.blocking.length > 0 || !SUBMIT.eligible;
    b.title = '';
  }
  function postSubmit(ack) {
    $('submsg').textContent = '';
    fetch(withToken('/timeline/' + task + '/review/submit'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ack ? { acknowledge: ack } : {}) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j && j.error ? j.error : 'The sign-off was not saved.'); e.refused = true; throw e; } return j; }); })
      .then(function (j) { SUBMITTED = { acknowledged: Array.isArray(j.acknowledged) ? j.acknowledged : [] }; SUBSTATE = 'submitted'; EARLIER = typeof j.n === 'number' ? j.n - 1 : EARLIER; $('subdlg').close && $('subdlg').close(); paintSubmit(); refreshPasses(); })
      .catch(function (e) { if ($('subdlg').open) $('subdlg').close(); $('submsg').textContent = (e && e.message) || 'The sign-off was not saved.'; loadStatus(); });
  }
  /* The dialog names the changes with no verdict. Steps that take no verdict (requests, messages, failed runs) are acknowledged with them
     and never asked about, since the page offers no verdict on them. */
  $('submit').addEventListener('click', function () {
    if (!SUBMIT || (SUBMITTED && SUBSTATE !== 'new_work')) return;
    var all = changeStops(), left = all.filter(function (s) { return SUBMIT.notReviewed.indexOf(s.id) >= 0; }).length;
    if (left === 0) { postSubmit(SUBMIT.notReviewed.length ? SUBMIT.notReviewed.slice() : null); return; }
    $('subdlgtext').textContent = left + ' of ' + all.length + (all.length === 1 ? ' change has' : ' changes have') + ' no verdict yet. Signing off records ' + (left === 1 ? 'it' : 'them') + ' as not looked at.';
    $('subdlg').showModal();
  });
  $('subgo').addEventListener('click', function () { postSubmit(SUBMIT ? SUBMIT.notReviewed.slice() : []); });
  $('subcancel').addEventListener('click', function () { $('subdlg').close(); });
  /* Under the heading in place of a subtitle, a change whose call failed shows the failure, plain, so a failure is never silent; the files
     under a header draw none. Its output sits behind "Show output" when it says more than the line. */
  /* the steps whose output the person opened: a redraw keeps the output open */
  var OUTOPEN = {};
  function paintLine(stop) {
    var p = $('h2'), any = false; p.textContent = '';
    var f = stop && !stop.under && stop.change ? stop.failure : null;
    if (stop && !stop.under && stop.change && (f || stop.change.failed)) { p.append(el('span', { class: 'plainline' }, f ? f.blurb : stop.change.failed)); any = true; }
    if (f && f.hasText !== false && String(f.raw).trim() !== '' && String(f.raw).trim() !== String(f.blurb).trim()) {
      var id = stop.id, raw = el('pre', { class: 'output' }, f.raw), btn = el('button', { type: 'button', class: 'linkbtn' }, OUTOPEN[id] ? 'Hide output' : 'Show output');
      raw.hidden = !OUTOPEN[id];
      btn.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); OUTOPEN[id] = raw.hidden; raw.hidden = !raw.hidden; btn.textContent = raw.hidden ? 'Show output' : 'Hide output'; });
      p.append(btn, raw); any = true;
    }
    p.hidden = !any;
  }
  function paintPlace() {
    var ae = document.activeElement, inRail = !!(ae && ae.classList && ae.classList.contains('row') && ae.parentNode === $('tl')), now = null;
    document.querySelectorAll('.row').forEach(function (r) {
      var i = +r.getAttribute('data-i'); r.classList.toggle('past', i < cur); r.classList.toggle('now', i === cur && !QV); r.classList.toggle('future', i > cur); r.setAttribute('aria-current', String(i === cur && !QV));
      /* roving tab stop: the current row is the rail's one tab stop */
      r.setAttribute('tabindex', i === cur ? '0' : '-1'); if (i === cur) now = r;
    });
    /* focus in the rail follows the selection, so the arrows keep walking from the row that has the ring */
    if (inRail && now && ae !== now && now.focus) now.focus({ preventScroll: true });
  }
  /* The heading is the actor's chip (beside the h1), a plain verb and a file name; the full path is on hover. A finish wears the helper's chip, not the lane it joins. */
  /* Everything a step paints in the header area, set in one place so no view can leave the last one's: the heading and its hover path, the deletion line, the actor chip, the Inferred word. */
  function paintHeader2(text, path, fact, actor, inferred, signoff, who) {
    var h = $('h1'), c = $('hchip'), fx = $('hfact'), wx = $('hwho');
    /* A guess about who made the change (a muted step: the app's own save), in full with its caveat, under the heading; every view sets it, so none keeps the last one's */
    if (wx) { wx.textContent = who || ''; wx.hidden = !who; }
    h.textContent = text; h.setAttribute('title', path || '');
    if (fx) { fx.textContent = fact || ''; fx.hidden = !fx.textContent; }
    c.textContent = ''; if (actor) c.append(chipEl(actor));
    /* the doubt sits in the actor, "Helper 2 (likely)", not in a separate "Inferred" */
    $('hinferred').textContent = inferred ? (actor && actor.name ? actor.name + ' (likely)' : 'Likely') : '';
    $('hinferred').hidden = !inferred;
    paintSign(signoff);
  }
  /* The "changed since sign-off" tag in the header: set by every view through paintHeader2, and again by paintTag when the passes move under the step on show */
  function paintSign(text) { var hs = $('hsign'); if (hs) { hs.textContent = text || ''; hs.hidden = !text; } }
  function paintHeading(stop) {
    var a = stop.title === undefined ? null : actorOf(stop.message && stop.message.helper ? stop.message.helper : stop.lane);
    paintHeader2(stop.message && stop.message.helper && stop.card && stop.card.title ? stop.card.title : stop.title === undefined ? stop.head : stop.title, stop.path, (stop.change && stop.change.fact) || '', a, !!(stop.change && stop.change.inferred === true), signoffTagOf(stop), stop.muted ? stop.sub : null);
  }
  function render() { renderMain(); paintMarks(); paintDetails(); if (DET.open) detReadAll(); }
  /* Under a file step's heading: what each call credited with the change did, with its collapsed "Show command". Nothing for a change no call is credited with, and nothing in the calls view. */
  function paintStepCalls(stop) {
    var box = $('hcalls'); if (!box) return;
    box.textContent = '';
    var calls = stop && stop.change && !stop.change.secret && stop.calls ? stop.calls : [];
    box.hidden = calls.length === 0;
    if (!calls.length) return;
    /* one line: the first call's words and its "Show command"; the other calls are "and N more" inside it, each with its own command */
    var rest = calls.slice(1), more = null;
    if (rest.length) {
      more = el('div', { class: 'hmore' }, el('p', { class: 'hmorehead' }, 'and ' + rest.length + ' more'));
      rest.forEach(function (c) { more.append(callRow(c)); });
    }
    if (!more || !calls[0].noCommand) { box.append(callRow(calls[0], more)); return; }
    /* the first call has no command: the others open from their own "and N more" */
    var tg = el('button', { type: 'button', class: 'linkbtn', 'aria-expanded': 'false' }, 'and ' + rest.length + ' more');
    more.hidden = true;
    tg.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); more.hidden = !more.hidden; tg.setAttribute('aria-expanded', String(!more.hidden)); });
    var row = callRow(calls[0]); row.append(tg, more); box.append(row);
  }
  function renderMain() {
    if (leaveStep(QV ? null : STOPS[cur] && STOPS[cur].id)) railSig = '';
    paintStepCalls(QV ? null : STOPS[cur]);
    /* the last drawing's registries leave before anything else is drawn, whatever this step is (a message never inherits a file step's leftovers) */
    cfDrop();
    if (QV) return renderCalls();
    var stop = STOPS[cur], mine = ++seq;
    syncRail(opened);
    paintHeading(stop); paintLine(stop);
    paintVerdict();
    paintTag(); paintPlace();
    showCurrent();
    var rc = stop.change;
    /* Before task and Now in the Files view are one pane (or one sentence when there is nothing to draw), never the change's two panes */
    var solo = mode === 'files' && rc && !rc.secret && FV ? FV.soloOf(FILES[fcur.f], fcur.p) : null, say = solo ? solo.say : '';
    /* Only a change has panes. A request is its text, a call header its files, a failure, a message or a finish its own body.
       Every flip happens before anything is drawn, so no step inherits the last one's view. */
    curPlan = null;
    $('reqview').hidden = !stop.request; $('hdrbody').hidden = !stop.hdr; $('hdrview').hidden = !stop.hdr; $('bodyview').hidden = !!((rc && !say) || stop.request || stop.hdr);
    $('stage').hidden = !rc || !!say; $('below').hidden = !rc || !!say; $('reqtext').textContent = '';
    if (!stop.hdr) $('hdrview').textContent = '';
    $('bodyview').textContent = ''; $('stage').classList.remove('nonotes'); $('stage').classList.remove('solo-before'); $('stage').classList.remove('solo-after'); $('stage').classList.remove('unified'); resetStage();
    ['vb', 'va', 'tb', 'ta', 'notes', 'svg', 'caveats', 'trb', 'tra', 'banner', 'viewline', 'finding'].forEach(function (id) { $(id).textContent = ''; });
    extrasFile = rc && !rc.secret ? rc.file : null;
    $('banner').hidden = true; $('viewline').hidden = true; $('finding').hidden = true; paintExtras(null);
    ['trb', 'tra'].forEach(function (id) { $(id).hidden = true; });
    $('about').hidden = true; clampers = []; curItems = [];
    if (!rc) {
      if (stop.request) $('reqtext').textContent = stop.request.text;
      else if (stop.hdr) paintHeader(stop);
      else paintBody(stop);
      return finish();
    }
    if (say) { $('bodyview').append(el('div', { class: 'empty' }, say)); return finish(); }
    if (rc.secret) {
      /* a secret file: its name line only, no picture, no tree */
      ['vb', 'va'].forEach(function (id) { $(id).append(el('div', { class: 'secretline' }, rc.secretLine)); });
      /* "Its contents are never shown." is this step's note in the Details panel (detPerStep) */
      return finish();
    }
    VT.loadingScreen($, function (t) { return el('div', { class: 'loadpane' }, loading(t)); });
    /* Before task and Now show the whole file (every page, every sheet), asked for by the same view route with ?whole=<side> */
    var wrc = solo && rc.viewUrl ? Object.assign({}, rc, { key: rc.key + '#whole-' + solo.side, viewUrl: rc.viewUrl + (rc.viewUrl.indexOf('?') < 0 ? '?' : '&') + 'whole=' + solo.side }) : rc;
    /* The glide is decided now: finish() below clears `instant` before the picture arrives, so reading it later always said "glide" */
    var glide = !instant;
    fetchView(wrc).catch(function (e) { return plainView(wrc, 'The picture is not available: ' + failureText(e)); }).then(function (view) {
      if (mine !== seq) return; /* a slower answer for an earlier moment is dropped, never drawn */
      drawView(stop, wrc, view, solo, glide);
      afterDraw(wrc, view, solo);
      if (view && view.pending) waitForPicture(rc, mine, 0, view);
      else prefetchNeighbours();
    });
    finish();
  }
  /* The body of a step that is neither a change, a request nor a call header. A failure group lists its calls, one row each: what it
     tried, the error line, and the whole output behind "Show output". A message or a helper's report is a card edged in the sender's
     color under "To <name>"; a finish then lists the files the helper changed. Anything else says nothing beyond its heading. */
  var REPORT_LINES = 6;
  /* A helper's start step shows the brief the main agent gave it, as text only, under a label saying whose words they are. A long brief keeps
     its first lines and its ending; one button opens the middle. No recorded brief is said plainly. */
  var BRIEF_HEAD = 5, BRIEF_TAIL = 3;
  /* A withheld field can be shown from the person's own transcript. One click asks the server (token, POST); the text is drawn into this card for this view
     only: it is never put in browser storage, a cache or a variable that outlives the card, and drawing the step again drops it. A refusal says so in words. */
  function addReveal(card, reveal) {
    if (!reveal || !reveal.length) return;
    reveal.forEach(function (r) {
      var out = el('div', { class: 'revealed' });
      var btn = el('button', { type: 'button', class: 'linkbtn' }, reveal.length > 1 ? 'Show the ' + r.field + ' from your transcript' : 'Show from your transcript');
      btn.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        btn.disabled = true;
        fetch(withToken('/timeline/' + task + '/review/reveal'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ call: r.call, field: r.field }) })
          .then(function (resp) { return resp.ok ? resp.json() : null; })
          .then(function (j) {
            out.textContent = '';
            if (j && typeof j.text === 'string') { j.text.split('\n').forEach(function (l) { if (l.trim() !== '') out.append(el('p', {}, l)); }); btn.hidden = true; }
            else { out.append(el('p', {}, 'The text is not available from your transcript.')); btn.disabled = false; }
          })
          .catch(function () { out.textContent = ''; out.append(el('p', {}, 'The text is not available from your transcript.')); btn.disabled = false; });
      });
      card.append(btn, out);
    });
  }
  /* The one message component: a sender line (dot in the actor's lane color, name, then "to <name>" in secondary ink, a red Failed label when it failed)
     above a card holding the body. Requests (the page shell), briefs, messages, replies, finishes and failures all come through here. */
  function msgView(o, card) {
    var head = el('p', { class: 'to' }, el('i', { class: 'mdot' }), el('b', { class: 'mname' }, o.name));
    if (o.to) head.append(document.createTextNode(' '), el('span', { class: 'mto' }, o.to));
    if (o.failed) head.append(document.createTextNode(' '), el('span', { class: 'mfailed' }, 'Failed'));
    var root = el('div', { class: 'msg' + (o.cls ? ' ' + o.cls : '') }, head, card);
    if (o.color) root.style.setProperty('--lc', o.color);
    return root;
  }
  var RESTATES = /^Agent\b.*\b(finished|completed)\.?$/i;
  function paintBrief(b, reveal, stop) {
    var lines = b.lines || [];
    var card = el('div', { class: 'mcard' });
    var who = b.by || 'The agent';
    if (b.encrypted) card.append(el('p', {}, who + ' keeps the brief it gives a helper encrypted, so CoCheck can\'t show it.'));
    else if (!lines.length) card.append(el('p', {}, b.withheld ? 'The brief was withheld because it looked like it held a secret.' : 'No brief was recorded for this helper.'));
    else {
      var cut = lines.length > BRIEF_HEAD + BRIEF_TAIL;
      var paras = lines.map(function (l, i) { var p = el('p', {}, l); if (cut && i >= BRIEF_HEAD && i < lines.length - BRIEF_TAIL) p.hidden = true; return p; });
      paras.forEach(function (p) { card.append(p); });
      if (cut) {
        var all = el('button', { type: 'button', class: 'linkbtn' }, 'Show the whole brief');
        all.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); paras.forEach(function (p) { p.hidden = false; }); all.hidden = true; });
        card.append(all);
      }
    }
    addReveal(card, reveal);
    var main = ACTORS.filter(function (a) { return a.main; })[0], hl = stop && /^Started Helper \d+$/.test(stop.label || '') ? { name: stop.label.slice(8) } : null;
    $('bodyview').append(msgView({ name: who, color: main ? main.color : '', to: (hl ? 'to ' + hl.name + ', ' : '') + 'the brief it gave the helper' }, card));
  }
  /* An MCP write no connector handles: a card "What <server> told the agent", built on the server from the call's kept values and drawn here as strings only
     (el() and textContent: a value is never markup, and the card holds no object, only lines). While it loads, or when nothing was kept, the card says so in words. */
  var SENT_TEXT = 'Sent outside CoCheck: an external system was changed, not a local file';
  function paintMcpWrite(stop) {
    var w = stop.mcpWrite, box = $('bodyview');
    var card = el('div', { class: 'mcard mcpcard' });
    var wrap = msgView({ name: 'What ' + String(w.server).replace(/_/g, ' ') + ' told the agent' }, card);
    box.append(wrap);
    function plainCard(why) {
      card.textContent = '';
      card.append(el('p', {}, 'The agent called ' + String(w.tool).replace(/_/g, ' ') + ' on ' + String(w.server).replace(/_/g, ' ') + '. ' + why));
      if (w.fields && w.fields.length) card.append(el('p', {}, 'Fields sent: ' + w.fields.join(', ') + '.'));
    }
    if (!stop.mcpCall || typeof stop.mcpCall.id !== 'string') { plainCard('CoCheck did not keep what was sent or what came back.'); return; }
    card.append(el('p', { class: 'mcploading' }, 'Loading what the server told the agent.'));
    fetch(withToken('/timeline/' + task + '/review/mcp/' + encodeURIComponent(stop.mcpCall.id))).then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
      if (!c || typeof c !== 'object' || !c.intent || !c.reply) { plainCard('CoCheck did not keep what was sent or what came back.'); return; }
      card.textContent = '';
      var lines = function (box2, arr) { (Array.isArray(arr) ? arr : []).forEach(function (l) { box2.append(el('p', { class: 'mcpline' }, String(l))); }); };
      wrap.children[0].textContent = String(c.title || '');
      if (c.credit) card.append(el('p', { class: 'mcpcredit' }, el('strong', {}, String(c.credit))));
      card.append(el('p', { class: 'mcphead' }, el('strong', {}, String(c.intent.head))));
      lines(card, c.intent.lines); if (c.intent.cut) card.append(el('p', { class: 'mcpcut' }, String(c.intent.cut)));
      if (c.reply.failed) card.append(el('p', { class: 'mcpfailed' }, el('strong', {}, String(c.reply.failed))));
      else if (c.reply.none) card.append(el('p', {}, String(c.reply.none)));
      else {
        if (c.reply.confirmed) card.append(el('p', { class: 'mcpconfirmed' }, el('strong', {}, String(c.reply.confirmed))));
        lines(card, c.reply.lines); if (c.reply.cut) card.append(el('p', { class: 'mcpcut' }, String(c.reply.cut)));
      }
      if (c.lastSeen) {
        card.append(el('p', { class: 'mcphead' }, el('strong', {}, String(c.lastSeen.head))));
        lines(card, c.lastSeen.lines); if (c.lastSeen.cut) card.append(el('p', { class: 'mcpcut' }, String(c.lastSeen.cut)));
      }
    }).catch(function () { plainCard('CoCheck did not keep what was sent or what came back.'); });
  }
  /* The gap stop: CoCheck knows the call touched something and could not capture what changed. Its own row and card, in the words of the reason. */
  function paintGap(stop) {
    $('bodyview').append(msgView({ name: 'Not captured: ' + stop.gap.reason }, el('div', { class: 'mcard' }, el('p', {}, stop.gap.what ? String(stop.gap.what) : 'A call changed something CoCheck could not capture.'))));
  }
  function paintBody(stop) {
    var box = $('bodyview');
    if (stop.runs) {
      var list = el('div', { class: 'fails' }), fa = actorOf(stop.lane);
      stop.runs.forEach(function (r) {
        var errLines = String(r.error == null ? '' : r.error).split('\n').filter(function (x) { return x.trim() !== ''; });
        var row = el('div', { class: 'mcard' }, el('div', { class: 'what' }, r.text), el('p', { class: 'err' }, errLines.length ? errLines[errLines.length - 1] : ''));
        if (r.output) {
          var out = el('pre', { class: 'output' }, r.output); out.hidden = true;
          var b = el('button', { type: 'button', class: 'linkbtn' }, 'Show output');
          b.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); out.hidden = !out.hidden; b.textContent = out.hidden ? 'Show output' : 'Hide output'; });
          row.append(b, out);
        }
        list.append(msgView({ name: fa ? fa.name : 'The agent', color: fa ? fa.color : '', failed: true, cls: 'fr' }, row));
      });
      box.append(list);
      return;
    }
    if (stop.brief) return paintBrief(stop.brief, stop.reveal, stop);
    if (stop.gap) return paintGap(stop);
    if (stop.mcpWrite) return paintMcpWrite(stop);
    var m = stop.message;
    if (!m) return;
    var from = actorOf(m.from), to = m.to ? actorOf(m.to) : null;
    var card = el('div', { class: 'mcard' });
    var lines = m.lines.length ? m.lines : ['No words were recorded for this message.'];
    /* a helper's finish already says "Helper N finished" in its heading: the notification's own "Agent ... finished" line is dropped, and a helper that said nothing more gets no card (the heading says it once) */
    var silent = false;
    if (m.helper) { lines = m.lines.filter(function (l) { return !RESTATES.test(String(l).trim()); }); silent = !lines.length && !(stop.reveal && stop.reveal.length); }
    var paras = lines.map(function (l, i) { var p = el('p', {}, l); if (i >= REPORT_LINES) p.hidden = true; return p; });
    paras.forEach(function (p) { card.append(p); });
    if (lines.length > REPORT_LINES) {
      var all = el('button', { type: 'button', class: 'linkbtn' }, 'Show the whole message');
      all.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); paras.forEach(function (p) { p.hidden = false; }); all.hidden = true; });
      card.append(all);
    }
    addReveal(card, stop.reveal);
    if (!silent) box.append(msgView({ name: from ? from.name : 'The agent', color: from ? from.color : '', to: m.toName ? 'to ' + m.toName : '' }, card));
    if (!m.helper) return;
    var mine = actorOf(m.helper), at = stopIndex(stop.id);
    var made = STOPS.filter(function (s, i) { var a = actorOf(s.lane); return s.change && i < at && a && mine && groupOf(a) === groupOf(mine); });
    if (!made.length) return;
    var files = el('div', { class: 'hfiles' });
    made.forEach(function (s) {
      var v = revOf(s).status;
      files.append(el('button', { type: 'button', class: 'hf', onclick: function () { jump(s.id); } }, el('span', { class: 'fn' }, s.label), el('span', { class: 'st ' + v, title: STATUS_TEXT[v], 'aria-label': STATUS_TEXT[v] }, v === 'passed' ? '\u2713' : v === 'failed' ? '\u2715' : '')));
    });
    box.append(el('h2', { class: 'sub' }, 'What it changed'), files);
  }
  /* A picture still being drawn: ask again after 1 s, 2 s, 4 s, then every 8 s, for about 80 s. When it answers, the moment is drawn again from the finished view.
     A connector that said "not ready, ask again" (view.waiting) is asked again by the server only after a doubling gap (30 s to 4 min, about 7.5 minutes
     for all its asks), so its view is asked for every 30 s, for up to 20 minutes; a newer waiting answer (another ask's caveat) is drawn when it comes. */
  var WAIT_EVERY_MS = 30000, WAIT_ASKS = 40;
  function waitForPicture(rc, mine, n, last) {
    var waiting = !!(last && last.waiting);
    /* The last ask is over: the panes say so in words, never a widget left waiting */
    if (n >= (waiting ? WAIT_ASKS : 14)) { if (mine === seq) { viewCache[rc.key] = plainView(rc, waiting ? 'The connector was still not ready when CoCheck stopped asking. Reload the page to try again.' : 'The picture was still being drawn when CoCheck stopped asking. Reload the page to try again.'); instant = true; render(); } return; }
    setTimeout(function () {
      if (mine !== seq) return;
      tryView(rc).then(function (v) {
        if (mine !== seq) return;
        if (v.pending) {
          /* a newer waiting answer: draw it (the redraw asks for the view and starts its own wait, so this one ends) */
          if (v.waiting && waiting && JSON.stringify(v.caveats) !== JSON.stringify(last.caveats)) { instant = true; render(); return; }
          return waitForPicture(rc, mine, v.waiting && !waiting ? 0 : n + 1, v);
        }
        viewCache[rc.key] = v; instant = true; render();
      }, function () { if (mine === seq) waitForPicture(rc, mine, n + 1, last); });
    }, waiting ? WAIT_EVERY_MS : Math.min(1000 * Math.pow(2, n), 8000));
  }
  function finish() { instant = false; }
  /* Two states that draw the same still show both pictures, under this banner; it is the engine line's neighbour and hidden otherwise */
  function paintBanner(b) {
    var n = $('banner');
    if (!n) return;
    n.textContent = '';
    n.hidden = !b;
    /* one plain line; the banner's full words are in the Details log */
    if (b) n.textContent = typeof b === 'string' ? b : 'Nothing visible changed: both versions look the same.';
  }
  /* the connector's issues: a small amber pill at the right end of the step header ("1 issue", "N issues") that opens the Details panel at its
     Issues group, where the sentences and "Copy fix prompt" are; the document's "and N more" stays in the stage. Issue words are outside data: text only, capped by VT.issuesOf.
     The fix prompt is made from the issues, for any connector: the ones about the file as it is now (not a before-side issue), in the connector's words. */
  var extrasFile = null;
  function fixPrompt(shown, file) {
    var now = shown.filter(function (it) { return it.side !== 'before'; });
    if (!now.length) return '';
    var name = file ? '"' + String(file).split(/[\\/]/).pop() + '"' : 'this file';
    return 'Please fix the following problems in the file ' + name + '. Fix only these and change nothing else:\n' + now.map(function (it) { return '- ' + (it.where ? it.where + ': ' : '') + it.text; }).join('\n') + '\nWhen you are done, make sure the file opens without these problems.';
  }
  function paintExtras(view) {
    var n = $('extras');
    var iss = view && view.issues, more = view && view.level !== 1 ? view.more : '';
    if (n) { n.textContent = ''; n.hidden = !more; if (more) n.append(el('p', { class: 'xmore' }, more)); }
    paintIssues(iss || null);
  }
  function paintIssues(iss) {
    var pill = $('hissues'), g = $('detissues');
    if (pill) { pill.textContent = iss ? iss.total + (iss.total === 1 ? ' issue' : ' issues') : ''; pill.hidden = !iss; }
    if (!g) return;
    g.textContent = ''; g.hidden = !iss;
    if (!iss) return;
    var ul = el('ul', {});
    iss.shown.forEach(function (it) { ul.append(el('li', {}, (it.where ? it.where + ': ' : '') + (it.side ? '(' + it.side + ') ' : '') + it.text)); });
    if (iss.more > 0) ul.append(el('li', {}, 'and ' + iss.more + ' more'));
    g.append(el('p', { class: 'detihead' }, 'Issues'), ul);
    var fix = fixPrompt(iss.shown, extrasFile);
    if (fix) {
      var b = el('button', { type: 'button', class: 'btn sfix' }, 'Copy fix prompt');
      b.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        var done = function () { b.textContent = 'Copied'; }, fail = function () { b.textContent = 'Could not copy'; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(fix).then(done, fail); else fail();
      });
      g.append(el('div', { class: 'detiacts' }, b));
    }
  }
  /* The app's own refusal of this file (a prompt instead of opening it, or no file opened): one plain line above the pictures. Text only. */
  function paintFinding(f) {
    var n = $('finding');
    if (!n) return;
    n.textContent = f ? f.text : '';
    n.hidden = !f;
  }
  /* ---------- paged review view and change stepping ---------- */
  /* A review view whose panes are all pages (or stand-ins for a page the other side lacks) scrolls its pages in one column per side. The whole-file view keeps its tabs. */
  function pagedView(view, key) {
    if (!view || view.kind !== 'pages' || /#whole-/.test(String(key || ''))) return false;
    var all = (view.before || []).concat(view.after || []);
    return all.length > 0 && all.every(function (p) { return p && (p.absent === true || (p.picture && (typeof p.picture.page === 'number' || (typeof p.group === 'string' && p.group)))); });
  }
  /* The rows of the two columns. Equal lists pair by position (the server aligned them); otherwise by page number. A side's absent pane is a stand-in. */
  function pagedRows(view) {
    var B = view.before || [], A = view.after || [], rows = [];
    /* pictures that name their set (v1.1 `group`) pair by set, never by position or page number */
    if (B.concat(A).some(function (p) { return p && typeof p.group === 'string' && p.group; })) return VT.groupedRows(B, A);
    function num(p) { if (!p) return 0; if (p.picture) return p.picture.page; var m = /(\d+)/.exec(String(p.label || '')); return m ? Number(m[1]) : 0; }
    if (B.length === A.length) { B.forEach(function (p, i) { rows.push({ before: p, after: A[i] }); }); return rows; }
    var byB = {}, byA = {}, nums = [];
    B.forEach(function (p) { if (!p.absent) { byB[num(p)] = p; nums.push(num(p)); } });
    A.forEach(function (p) { if (!p.absent) { byA[num(p)] = p; if (!byB[num(p)]) nums.push(num(p)); } });
    nums.sort(function (x, y) { return x - y; });
    nums.forEach(function (n) { rows.push({ before: byB[n] || null, after: byA[n] || null, n: n }); });
    return rows;
  }
  var pscrolls = { before: null, after: null }, snap = null, drawnKey = null;
  /* true for a node inside a page column that is scrolled out of the column's view: its box is clipped, so an overlay (leader, group outline) must not draw to it */
  function clippedOut(n) {
    var sc = n && n.closest ? n.closest('.pscroll') : null;
    if (!sc || !sc.getBoundingClientRect || !n.getBoundingClientRect) return false;
    var s = sc.getBoundingClientRect(), r = n.getBoundingClientRect();
    return r.bottom < s.top || r.top > s.bottom;
  }
  function numOf(p) { return p && p.picture ? p.picture.page : (p && /(\d+)/.exec(String(p.label || ''))) ? Number(/(\d+)/.exec(String(p.label))[1]) : 0; }
  function fillPaged(side, view, boxes, vw) {
    var found = {}, rows = pagedRows(view), other = side === 'before' ? 'after' : 'before';
    var sc = el('div', { class: 'pscroll', 'data-side': side });
    rows.forEach(function (r, i) {
      var pane = r[side], mate = r[other], slot = el('div', { class: 'pslot', 'data-row': i });
      var shown = pane && !pane.absent;
      var label = shown ? String(pane.label) : r.group !== undefined ? 'No ' + side + ' picture here' : 'No page ' + (r.n || numOf(mate) || i + 1) + ' on this side';
      /* the picture's place shows once, in the pane's label row (placeOf); the per-picture strip stays for screen readers only */
      slot.setAttribute('data-label', label);
      if (shown && pane.id != null) slot.setAttribute('data-pane', String(pane.id));
      slot.append(el('div', { class: 'plabel' + (shown ? '' : ' none'), title: label }, label));
      var body = el('div', { class: 'pbody' + (shown ? '' : ' gone') });
      var ratio = 0, maxW = 0;
      if (r.group !== undefined) {
        /* one set's pictures at the same scale: the widest of the row fills the column (at most about an app's 100%: 1.5 picture pixels a CSS pixel), the others in proportion */
        [pane, mate].forEach(function (p) { if (p && p.picture && p.picture.width > 0) maxW = Math.max(maxW, p.picture.width); });
        [pane, mate].forEach(function (p) { if (p && p.picture && maxW > 0) ratio = Math.max(ratio, p.picture.height / maxW); });
        if (maxW > 0) body.style.maxWidth = 'calc(' + Math.round(maxW / 1.5) + 'px * var(--z, 1))';
      } else [pane, mate].forEach(function (p) { if (p && p.picture && p.picture.width > 0) ratio = Math.max(ratio, p.picture.height / p.picture.width); });
      if (ratio > 0) body.style.aspectRatio = '1 / ' + ratio;
      if (shown) {
        lazyPics = true;
        var d; try { d = paneEl(pane, boxes, side); } finally { lazyPics = false; }
        d.anchors.forEach(function (a, bi) { if (a && !found[bi]) found[bi] = a; });
        if (maxW > 0 && pane.picture && pane.picture.width > 0 && d.node.style) d.node.style.width = (100 * pane.picture.width / maxW) + '%';
        body.append(d.node);
        if (pane.unchanged) slot.classList.add('same');
      } else body.append(el('div', { class: 'missing' }, label));
      slot.append(body); sc.append(slot);
    });
    vw.append(sc);
    pscrolls[side] = sc;
    if (typeof sc.addEventListener === 'function') sc.addEventListener('scroll', function () { remember(side, sc); showPlace(side); }, { passive: true });
    buildStrip(side, rows, view, sc);
    showPlace(side);
    if (side === 'after' && pscrolls.before && pscrolls.before.isConnected !== false) linkScroll(pscrolls.before, pscrolls.after);
    return found;
  }
  /* The place in a column as a page and the fraction down it, so two columns of different pixel heights stay on the same page */
  function pagePos(sc) {
    var t = sc.scrollTop, s = sc.children, room = (sc.scrollWidth || 0) - (sc.clientWidth || 0), x = room > 1 ? Math.max(0, Math.min(1, (sc.scrollLeft || 0) / room)) : 0;
    for (var i = s.length - 1; i >= 0; i--) if (s[i].offsetTop <= t + 0.5) return { i: i, f: s[i].offsetHeight > 0 ? Math.max(0, Math.min(1, (t - s[i].offsetTop) / s[i].offsetHeight)) : 0, x: x };
    return { i: 0, f: 0, x: x };
  }
  function setPagePos(sc, p) {
    var s = sc.children[p.i]; if (!s) return;
    var top0 = sc.scrollTop, left0 = sc.scrollLeft || 0; sc._exp = undefined;
    sc.scrollTop = s.offsetTop + p.f * s.offsetHeight;
    if (typeof p.x === 'number') { var room = (sc.scrollWidth || 0) - (sc.clientWidth || 0); sc.scrollLeft = room > 1 ? p.x * room : 0; }
    var moved = Math.abs(sc.scrollTop - top0) >= 0.5 || Math.abs((sc.scrollLeft || 0) - left0) >= 0.5;
    sc._exp = moved ? { t: sc.scrollTop, l: sc.scrollLeft || 0 } : undefined;
  }
  function linkScroll(a, b) {
    function mk(src, dst) {
      return function () {
        if (src._exp !== undefined && Math.abs(src.scrollTop - src._exp.t) <= 1.5 && Math.abs((src.scrollLeft || 0) - src._exp.l) <= 1.5) { src._exp = undefined; return; }
        src._exp = undefined; setPagePos(dst, pagePos(src)); pagedMoved();
      };
    }
    if (typeof a.addEventListener !== 'function') return;
    a.addEventListener('scroll', mk(a, b), { passive: true }); b.addEventListener('scroll', mk(b, a), { passive: true });
  }
  /* what sits over the columns (leaders, note markers) is placed in stage coordinates, so it is redrawn once per frame while a column scrolls */
  var movedRaf = 0;
  function pagedMoved() {
    if (movedRaf || typeof requestAnimationFrame !== 'function') return;
    movedRaf = requestAnimationFrame(function () {
      movedRaf = 0;
      if (typeof layout === 'function' && curItems && curItems.length) layout(curItems);
      if (typeof paintMarks === 'function') paintMarks();
      ['before', 'after'].forEach(function (side) {
        var sc = pscrolls[side], box = $('nmarks'); if (!sc || !box || !box.children || !sc.getBoundingClientRect) return;
        var r = sc.getBoundingClientRect(), sg = $('stage').getBoundingClientRect();
        Array.prototype.forEach.call(box.children, function (m) {
          if (m.getAttribute('data-side') !== side) return;
          var y = parseFloat(m.style.top) + sg.top; if (y < r.top - 1 || y > r.bottom + 1) m.style.display = 'none';
        });
      });
    });
  }
  /* The render clears both panes before the new view arrives, so the place cannot be read at redraw time: every scroll of a column records it. */
  /* the label row's right end names the picture the strip rings: the one holding the current change, else the one at the top of a side's
     column (one meaning, shown once: the close-up under the label row has no caption of its own). From the picture's own label; the side word
     the label row already shows is not repeated ("Before, page 2 of 5" reads "Page 2 of 5") */
  function placeOf(label) {
    var t = String(label || '').replace(/^\s*(?:before|after)\s*[,:\u2013\u2014-]\s*/i, '');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  }
  function showPlace(side) {
    var sc = pscrolls[side], out = $(side === 'after' ? 'lpa' : 'lpb');
    if (!sc || !out || !sc.children || !sc.children.length) return;
    /* before layout every slot reads offsetTop 0, so an unscrolled column is on its first picture */
    var at = sc.scrollTop > 0.5 ? pagePos(sc).i : 0;
    if (ringPane[side]) Array.prototype.forEach.call(sc.children, function (c, k) { if (c.getAttribute && c.getAttribute('data-pane') === ringPane[side]) at = k; });
    var slot = sc.children[at], t = slot && slot.getAttribute ? slot.getAttribute('data-label') : '';
    out.textContent = placeOf(t);
    out.title = t || '';
    ringStrip(side, at);
  }
  function remember(side, sc) { if (!snap) snap = {}; snap[side] = pagePos(sc); }
  function snapshotScroll() { pscrolls = { before: null, after: null }; }

  /* N and B: change stepping on every format. `changes` order when the view has it, else the cards' boxes in card order. */
  var stepAt = -1, stepBar = null;
  function esc(v) { return String(v).replace(/["\\]/g, '\\$&'); }
  function stepTargets() {
    var v = stepView, out = [];
    if (v && v.changeFirst && v.items.length) {
      v.items.forEach(function (c) {
        /* the boxes drawChanges really mounted for this change, after side first: a change with no drawable box has no nodes */
        var t = { id: c.id, nodes: [] }, it = CF.items[c.id], mine = it && it.boxes ? it.boxes : [];
        ['after', 'before'].forEach(function (side) {
          var n = mine.filter(function (b) { return b.getAttribute && b.getAttribute('data-side') === side; })[0];
          /* a box drawn into the pane by other means than drawChanges is still found by its change id */
          if (!n && !mine.length) { var pane = $(side === 'after' ? 'pa' : 'pb'), q = pane && pane.querySelector ? pane.querySelector('.bx[data-change="' + esc(c.id) + '"]') : null; if (q && hasCls(q, 'bx')) n = q; }
          if (n) t.nodes.push(n);
        });
        out.push(t);
      });
      return out;
    }
    (curItems || []).forEach(function (it) { var nodes = [it.a, it.b].filter(function (n) { return !!n; }); if (nodes.length) out.push({ id: null, nodes: nodes }); });
    return out;
  }
  var stepView = null;
  function scrollerOf(n) {
    for (var p = n.parentNode; p && p !== document.body && p.nodeType === 1; p = p.parentNode) {
      var cs = typeof getComputedStyle === 'function' ? getComputedStyle(p) : null; if (!cs) return null;
      if (/(auto|scroll)/.test(cs.overflowY + ' ' + cs.overflowX) && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return p;
    }
    return null;
  }
  function revealIn(n, sc) {
    var M = 24, r = n.getBoundingClientRect(), s = sc.getBoundingClientRect(), dy = 0, dx = 0;
    if (r.height > s.height - 2 * M || r.top < s.top + M) dy = r.top - s.top - M; else if (r.bottom > s.bottom - M) dy = r.bottom - s.bottom + M;
    if (sc.scrollWidth > sc.clientWidth + 1) { if (r.width > s.width - 2 * M || r.left < s.left + M) dx = r.left - s.left - M; else if (r.right > s.right - M) dx = r.right - s.right + M; }
    if (dy) sc.scrollTop += dy;
    if (dx) sc.scrollLeft += dx;
  }
  function goStep(i, ts, loud) {
    var t = ts[i]; if (!t) return;
    stepAt = i;
    /* lay the close-up row and the ring out first: centring reads positions, and a row that changed height afterwards would move the box */
    paintCloseUp(t.id); paintRing(t.id); fitColumns();
    var linked = false, onPicture = boxZoom(t.nodes);
    t.nodes.forEach(function (n) {
      var sc = scrollerOf(n); if (!sc) return;
      var isP = sc.classList && sc.classList.contains('pscroll');
      if (isP) { if (linked) return; linked = true; }
      if (onPicture && n.parentNode && hasCls(n.parentNode, 'pagewrap')) centreIn(n, sc); else revealIn(n, sc);
    });
    /* a box in a picture column was centred inside it, and the column fits the window (fitColumns): the page itself stays where it is, so the
       header and the close-up row never leave the screen. Anything else (a text line) still brings the page to it. */
    var first = t.nodes[0], inColumn = first && first.closest ? !!first.closest('.pscroll, .vw[data-pane]') : false;
    if (loud && first && !inColumn && first.getBoundingClientRect) {
      var r = first.getBoundingClientRect(), room = innerHeight - bottomInset() - 8;
      if (r.top < 80 || r.bottom > room) window.scrollBy(0, r.top - Math.max(80, (room - r.height) / 2));
    }
    var fc = window.CoCheckFocus && typeof window.CoCheckFocus.focusChange === 'function' ? window.CoCheckFocus.focusChange : (typeof focusChange === 'function' ? focusChange : null);
    if (loud && t.id !== null && fc) fc(t.id);
    if (typeof layout === 'function' && curItems && curItems.length) layout(curItems);
  }
  function stepChange(dir) {
    var stage = $('stage'); if (!stage || stage.hidden) return false;
    var ts = stepTargets(); if (!ts.length) return false;
    var i = stepAt < 0 ? (dir > 0 ? 0 : ts.length - 1) : Math.max(0, Math.min(ts.length - 1, stepAt + dir));
    goStep(i, ts, true);
    return true;
  }
  /* ---------- the stage: one pane for a subject that did not exist, open on the box (zoomed), the close-up row, the picture strip ----------
     Everything here reads the public fields of the document (boxes, picture width, height, page, label, group, order, changed) and the capture's
     own created/deleted kind, so any connector's pictures get it. Text and html panes keep their own behaviour. */
  var zoomNow = 1, zoomKey = null, openRow = -1;
  function resetStage() {
    [['lsb', 'Before'], ['lsa', 'After']].forEach(function (x) { var n = $(x[0]); if (n) n.textContent = x[1]; });
    ['lnb', 'lna', 'cub', 'cua', 'stb', 'sta'].forEach(function (id) { var n = $(id); if (n) { n.textContent = ''; n.hidden = true; } });
    setZoom(1, true);
  }
  /* the side that did not exist: the capture says the subject was created (no before) or deleted (no after), and that side has nothing to draw */
  function goneSide(rc, view) {
    var side = rc && rc.kind === 'created' ? 'before' : rc && rc.kind === 'deleted' ? 'after' : null;
    if (!side) return null;
    var other = side === 'before' ? 'after' : 'before';
    var draws = function (sd) { return (view[sd] || []).some(function (p) { return VT.describePane(p, [], sd).kind !== 'card'; }); };
    return !draws(side) && (draws(other) || !!view.pending) ? side : null;
  }
  /* the existing side across the stage, labelled "New" or "Removed" and the subject's name (the last part of its path, never a word of CoCheck's) */
  function showOneSide(gone, stop) {
    var shown = gone === 'before' ? 'after' : 'before', k = shown === 'after' ? 'a' : 'b';
    $('stage').classList.add('solo-' + shown);
    var ls = $('ls' + k), ln = $('ln' + k);
    if (ls) ls.textContent = gone === 'before' ? 'New' : 'Removed';
    var rc = stop && stop.change, name = rc && rc.file ? String(rc.file).split('/').filter(Boolean).pop() || '' : '';
    if (ln && name) { ln.textContent = name; ln.hidden = false; }
  }
  function firstDrawn(ts) { for (var i = 0; i < ts.length; i++) if (ts[i].nodes && ts[i].nodes.length) return i; return -1; }
  /* level 2 (pictures, no boxes): open on the first picture marked changed, no zoom */
  function openChangedPicture(view) {
    if (!pagedView(view, drawnKey)) return;
    var rows = pagedRows(view);
    for (var i = 0; i < rows.length; i++) {
      if ((rows[i].after && rows[i].after.changed) || (rows[i].before && rows[i].before.changed)) {
        openRow = i;
        var sc = pscrolls.after || pscrolls.before, slot = sc && sc.children ? sc.children[i] : null;
        if (slot && typeof slot.offsetTop === 'number') sc.scrollTop = slot.offsetTop;
        return;
      }
    }
  }
  /* the zoom of both sides' pictures: a custom property the stage CSS multiplies the pictures' width by; 1 is fit-width */
  function setZoom(z, quiet) {
    zoomNow = z > 1 ? z : 1;
    ['vb', 'va'].forEach(function (id) {
      var v = $(id); if (!v || !v.style) return;
      if (zoomNow > 1) { v.style.setProperty('--z', String(zoomNow)); v.classList.add('zoomed'); }
      else { if (v.style.removeProperty) v.style.removeProperty('--z'); v.classList.remove('zoomed'); }
    });
    if (!quiet) zoomKey = { key: drawnKey, z: zoomNow };
    paintZoomCtl();
  }
  /* ---------- the zoom control: Fit width / 100% / 200% in the label row of the side on show, for steps that have a picture ---------- */
  function zoomPics() {
    var out = [];
    ['vb', 'va'].forEach(function (id) { var v = $(id); if (v && v.querySelectorAll) Array.prototype.forEach.call(v.querySelectorAll('.pagewrap'), function (w) { out.push(w); }); });
    return out;
  }
  /* the fit-width and own-pixel widths of the widest picture on show, measured at the current zoom and brought back to fit-width */
  function zoomMeasure() {
    var fitW = 0, picW = 0;
    zoomPics().forEach(function (w) {
      var r = w.getBoundingClientRect(), im = w.querySelector ? w.querySelector('img') : null;
      if (!(r.width > 0)) return;
      fitW = Math.max(fitW, r.width / zoomNow); picW = Math.max(picW, Number(im && im.getAttribute ? im.getAttribute('width') : 0) || 0);
    });
    return { fitW: fitW, picW: picW };
  }
  var zoomPick = null;
  function paintZoomCtl() {
    var c = $('zoomctl'); if (!c) return;
    var st = $('stage'), has = !!st && !st.hidden && zoomPics().length > 0;
    c.hidden = !has;
    if (!has) return;
    /* in the Before label row when only the Before side is on show */
    var home = st.classList.contains('solo-before') ? $('lpb') : $('lpa');
    if (home && home.parentNode && c.parentNode !== home.parentNode) home.parentNode.append(c);
    var cur = zoomPick && Math.abs(zoomPick.z - zoomNow) < 0.001 ? zoomPick.mode : VT.zoomMode(zoomNow, zoomMeasure());
    Array.prototype.forEach.call(c.querySelectorAll ? c.querySelectorAll('button') : [], function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-zoom') === cur ? 'true' : 'false'); });
  }
  /* zoom both sides to a choice and keep what the reviewer is looking at: the current change's box centred, else the scroll centre of each column */
  function applyZoom(mode) {
    var m = zoomMeasure(); if (!(m.fitW > 0)) return;
    var z = VT.zoomTarget(mode, m), z0 = zoomNow;
    if (Math.abs(z - z0) < 0.001) { zoomPick = { mode: mode, z: z }; setZoom(z); return; }
    var hosts = [];
    zoomPics().forEach(function (w) { var h = zoomHost(w); if (h && hosts.indexOf(h) < 0) hosts.push(h); });
    var from = hosts.map(function (h) { return { h: h, x: h.scrollLeft, y: h.scrollTop, w: h.clientWidth, ht: h.clientHeight }; });
    zoomPick = { mode: mode, z: z }; setZoom(z);
    /* the column is not exactly proportional to z (scrollbars, borders): one correction so 100% really is one picture pixel a CSS pixel */
    if (mode !== 'fit' && z > 1) {
      var w = 0, want = (mode === '200' ? 2 : 1) * m.picW;
      zoomPics().forEach(function (pw) { w = Math.max(w, pw.getBoundingClientRect().width); });
      if (w > 0 && Math.abs(w - want) / want > 0.01) { z = Math.min(16, Math.max(1, Math.round(z * want / w * 100) / 100)); zoomPick = { mode: mode, z: z }; setZoom(z); }
    }
    var ts = stepAt >= 0 ? stepTargets() : [], t = ts[stepAt], nodes = t ? t.nodes.filter(function (n) { return n && n.parentNode && hasCls(n.parentNode, 'pagewrap') && n.getBoundingClientRect; }) : [];
    if (nodes.length) {
      var linked = false;
      nodes.forEach(function (n) { var sc = zoomHost(n); if (!sc || (sc.classList && sc.classList.contains('pscroll') && linked)) return; if (sc.classList && sc.classList.contains('pscroll')) linked = true; centreIn(n, sc); });
    } else from.forEach(function (f) { f.h.scrollLeft = VT.keepCentre(f.x, f.w, z0, z); f.h.scrollTop = VT.keepCentre(f.y, f.ht, z0, z); });
    if (typeof layout === 'function' && curItems && curItems.length) layout(curItems);
  }
  (function wireZoom() {
    var c = $('zoomctl'); if (!c) return;
    Array.prototype.forEach.call(c.querySelectorAll ? c.querySelectorAll('button') : [], function (b) { b.addEventListener('click', function () { applyZoom(b.getAttribute('data-zoom')); }); });
  })();
  function zoomKeyed(e) {
    var cmd = VT.zoomShortcut(e), c = $('zoomctl'); if (!cmd || !c || c.hidden) return false;
    var m = zoomMeasure(), to = cmd === 'fit' ? 'fit' : VT.zoomStep(zoomNow, cmd === 'in' ? 1 : -1, m);
    if (to) applyZoom(to);
    return true;
  }
  /* Zoom so the change's boxes fill a sensible part of the pane: measured at the current zoom, brought back to fit-width, the larger box of the two
     sides decides. Only boxes on a picture zoom; false when there is none to measure (a text line, a box on a hidden tab). */
  function boxZoom(nodes) {
    var pics = (nodes || []).filter(function (n) { return n && n.parentNode && hasCls(n.parentNode, 'pagewrap') && n.getBoundingClientRect; });
    if (!pics.length) return false;
    var z0 = zoomNow, bw = 0, bh = 0, fitW = 0, picW = 0, paneW = 0;
    pics.forEach(function (n) {
      var r = n.getBoundingClientRect(), pw = n.parentNode.getBoundingClientRect(), im = n.parentNode.querySelector ? n.parentNode.querySelector('img') : null, host = zoomHost(n);
      if (!(r.width > 0) || !(pw.width > 0)) return;
      bw = Math.max(bw, r.width / z0); bh = Math.max(bh, r.height / z0); fitW = Math.max(fitW, pw.width / z0);
      picW = Math.max(picW, Number(im && im.getAttribute ? im.getAttribute('width') : 0) || 0);
      paneW = Math.max(paneW, host ? host.clientWidth : 0);
    });
    if (!(bw > 0) || !(paneW > 0)) return false;
    var host0 = zoomHost(pics[0]), paneH = host0 && host0.clientHeight > 0 ? host0.clientHeight : Math.min((window.innerHeight || 900) * 0.8, 920);
    setZoom(VT.zoomFor({ boxW: bw, boxH: bh, paneW: paneW, paneH: paneH, fitW: fitW, picW: picW }));
    return true;
  }
  /* the box a picture zooms in: its page column, or (one picture per side, on tabs) the pane view itself */
  function zoomHost(n) {
    var sc = n.closest ? n.closest('.pscroll') : null;
    if (sc) return sc;
    return n.closest ? n.closest('.vw[data-pane]') : null;
  }
  /* The picture columns are as tall as the window leaves them under the header, the label row and the close-up row, above the strip and the
     docked bar (--colh on the stage; at least 240 px, at most the old cap), so stepping scrolls inside a column and the page stays still. */
  var COL_MIN = 240, COL_MAX = 920;
  function fitColumns() {
    var st = $('stage'); if (!st || !st.style || typeof st.style.setProperty !== 'function') return;
    var sc = null;
    ['after', 'before'].forEach(function (side) { var p = pscrolls[side]; if (!sc && p && p.isConnected !== false && p.getBoundingClientRect) sc = p; });
    if (!sc && st.querySelector) sc = st.querySelector('.vw[data-pane]');
    if (!sc || !sc.getBoundingClientRect || st.hidden) { if (typeof st.style.removeProperty === 'function') st.style.removeProperty('--colh'); return; }
    var top = sc.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0), room = (window.innerHeight || 900) - top - bottomInset() - 12;
    st.style.setProperty('--colh', Math.round(Math.max(COL_MIN, Math.min(COL_MAX, room))) + 'px');
  }
  if (typeof addEventListener === 'function') addEventListener('resize', function () { fitColumns(); });
  /* what covers the window's foot: the docked bar (64 px) and the picture strip stuck above it */
  function bottomInset() {
    var h = 64, sa = $('sta'), sb = $('stb');
    [sa, sb].forEach(function (n) { if (n && !n.hidden && n.offsetHeight) h = Math.max(h, 64 + n.offsetHeight + 8); });
    return h;
  }
  /* centre a box in the part of its scroller that is on screen (the docked bar and the stuck strip cover the window's foot) */
  function centreIn(n, sc) {
    var r = n.getBoundingClientRect(), s = sc.getBoundingClientRect();
    var top = Math.max(s.top, 0), bottom = Math.min(s.bottom, (window.innerHeight || s.bottom) - bottomInset());
    if (!(bottom > top)) { top = s.top; bottom = s.bottom; }
    sc.scrollTop += (r.top + r.height / 2) - (top + bottom) / 2;
    if (sc.scrollWidth > sc.clientWidth + 1) sc.scrollLeft += (r.left + r.width / 2) - (s.left + s.width / 2);
  }
  /* The close-up row: Before and After crops of the connector's own picture around the current change, enlarged to the column width (image
     pictures with a box only; VT.closeUp decides when it would not help). The picture is scaled and clipped, never drawn over; the change box sits on it. */
  function paintCloseUp(id) {
    var cub = $('cub'), cua = $('cua');
    if (!cub || !cua) return;
    [cub, cua].forEach(function (n) { n.textContent = ''; n.hidden = true; n.classList.remove('fx'); });
    var v = stepView; if (!v || !id || !v.changeFirst) return;
    var st = $('stage'), shown = st && st.classList.contains('solo-before') ? $('pb') : $('pa');
    var colW = shown && typeof shown.clientWidth === 'number' ? shown.clientWidth : 0, maxH = Math.min(360, (window.innerHeight || 900) * 0.4);
    var plan = VT.closeUpPlan(v, id);
    /* the row keeps one height across the changes of the step (the tallest close-up; a shorter one shows more of the picture around it), so the pictures below do not move as the reviewer steps */
    var rowH = VT.rowHeight(v, stepTargets().map(function (x) { return x.id; }).concat([id]), colW, maxH), cu = plan ? VT.closeUp(plan, colW, maxH, rowH) : null;
    if (rowH > 0) [cub, cua].forEach(function (n) { n.style.setProperty('--cuh', Math.ceil(rowH) + 'px'); n.classList.add('fx'); n.hidden = false; });
    if (!cu) {
      /* a change with no close-up on a step whose others have one: a quiet well the row's height says why, so the pictures below stay put
         and the row never reads as a blank gap. The words show once, in the After column (or the one column on show). */
      if (rowH > 0) {
        var solo = st && (st.classList.contains('solo-before') || st.classList.contains('solo-after')), only = shown === $('pb') ? cub : cua;
        var words = plan ? 'This change is shown in full below' : 'This change isn’t shown in the pictures';
        [cub, cua].forEach(function (n) {
          if (solo && n !== only) { n.hidden = true; return; }
          var well = el('div', { class: 'cucell none' });
          well.style.height = Math.ceil(rowH) + 'px';
          if (n === only) well.append(el('span', { class: 'cunone' }, words)); else well.setAttribute('aria-hidden', 'true');
          n.append(well);
        });
      }
      return;
    }
    var it = (v.items || []).filter(function (x) { return x.id === id; })[0];
    /* the boxes as the pages draw them (drawBoxes: a change's touching boxes as one, neighbours' edges kept apart), so the close-up matches */
    var pics = {}; ['before', 'after'].forEach(function (s) { (v[s] || []).forEach(function (pp) { if (pp && pp.picture && pp.picture.width > 0 && pp.picture.height > 0) pics[pp.id] = { w: pp.picture.width, h: pp.picture.height }; }); });
    var drawn = drawnBoxes(v.items || [], function (pid) { return pics[pid] || null; });
    ['before', 'after'].forEach(function (side) {
      var c = cu[side], box = side === 'before' ? cub : cua, other = cu[side === 'before' ? 'after' : 'before'];
      if (!c) {
        /* the one crop alone: the other column keeps the row's height, empty, so the full pictures below stay level */
        if (other && !st.classList.contains('solo-' + (side === 'before' ? 'after' : 'before'))) { var gap = el('div', { class: 'cucell blank', 'aria-hidden': 'true' }); gap.style.aspectRatio = other.w + ' / ' + other.h; box.append(gap); box.hidden = false; }
        return;
      }
      var p = c.pane.picture, W = p.width, H = p.height, name = VT.pictureName(c.pane);
      var cell = el('div', { class: 'cucell', 'data-change': id, 'data-pane': c.pane.id, role: 'img', 'aria-label': 'Close-up' + (name ? ' of ' + name : '') });
      cell.style.aspectRatio = c.w + ' / ' + c.h;
      var pic = el('div', { class: 'cupic' });
      pic.style.width = (100 * W / c.w) + '%'; pic.style.height = (100 * H / c.h) + '%';
      pic.style.left = (-100 * c.x / c.w) + '%'; pic.style.top = (-100 * c.y / c.h) + '%';
      pic.append(el('img', { src: previewUrl(p.sha, p.page, p.cpic), alt: '', width: W, height: H }));
      if (c.boxed && it) (it.boxes || []).forEach(function (b) {
        if (b.side !== side || b.pane !== c.pane.id || !b.rect) return;
        var pb = drawn.has(b) ? drawn.get(b) : VT.padBox(b.rect, W, H); if (!pb) return;
        var bx = el('div', { class: 'cubx' });
        bx.style.left = pb.left + '%'; bx.style.top = pb.top + '%'; bx.style.width = pb.width + '%'; bx.style.height = pb.height + '%';
        pic.append(bx);
      });
      cell.append(pic);
      /* no caption: the label row above names this picture (showPlace follows the current change), so its number shows once */
      box.append(cell);
      box.hidden = false;
    });
  }
  /* The picture strip under a side's pictures: a thumbnail per image picture, a numbered chip for anything else, a dot on every picture with a
     box or `changed`, the picture at the top of the column ringed. A click scrolls the column there (the other column follows). One picture: no strip. */
  function buildStrip(side, rows, view, sc) {
    var out = $(side === 'after' ? 'sta' : 'stb'); if (!out) return;
    out.textContent = ''; out.hidden = true;
    var panes = rows.map(function (r) { var p = r[side]; return p && !p.absent ? p : null; });
    if (panes.filter(function (p) { return !!p; }).length < 2) return;
    VT.stripOf(panes, view.marks).forEach(function (e) {
      var b = el('button', { type: 'button', class: 'pst' + (e.dot ? ' dot' : '') + (e.none ? ' none' : ''), 'data-row': String(e.i), 'data-pane': e.pane || '', 'aria-label': (e.name || e.text) + (e.dot ? ', changed' : ''), title: e.name || e.text });
      if (e.thumb) { var pp = panes[e.i].picture; b.append(el('img', { src: previewUrl(pp.sha, pp.page, pp.cpic), alt: '', loading: 'lazy' })); }
      else b.append(el('span', { class: 'pstn' }, e.text));
      b.addEventListener('click', function () { var slot = sc.children ? sc.children[e.i] : null; if (slot && typeof slot.offsetTop === 'number') sc.scrollTop = slot.offsetTop; ringPane[side] = null; });
      out.append(b);
    });
    out.hidden = false;
  }
  /* the picture each side's strip rings: the one holding the current change (null: the picture at the top of the column) */
  var ringPane = { before: null, after: null };
  function paintRing(id) {
    var plan = stepView && id ? VT.closeUpPlan(stepView, id) : null;
    ['before', 'after'].forEach(function (side) { ringPane[side] = plan && plan[side] ? plan[side].pane.id : null; showPlace(side); if (ringPane[side]) ringStrip(side, 0); });
  }
  function ringStrip(side, at) {
    var out = $(side === 'after' ? 'sta' : 'stb'); if (!out || !out.children) return;
    if (ringPane[side]) Array.prototype.forEach.call(out.children, function (b, k) { if (b.getAttribute && b.getAttribute('data-pane') === ringPane[side]) at = k; });
    Array.prototype.forEach.call(out.children, function (b, k) { if (b && b.classList) { if (k === at) b.classList.add('on'); else b.classList.remove('on'); } });
  }
  window.CoCheckStage = { at: function () { var ts = stepTargets(); return { change: stepAt >= 0 && ts[stepAt] ? ts[stepAt].id : null, row: openRow, zoom: zoomNow }; }, step: function (d) { return stepChange(d); } };
  function ensureStepBar() {
    if (stepBar) return stepBar;
    /* in the bottom bar, after the step arrows and counter */
    var st = $('pbnext'); if (!st || !st.parentNode || typeof st.parentNode.insertBefore !== 'function') return null;
    stepBar = el('div', { class: 'stepbar', id: 'stepbar', role: 'group', 'aria-label': 'Changes in this step', hidden: '' });
    [['Previous change', 'M6 15l6-6 6 6', -1, 'B'], ['Next change', 'M6 9l6 6 6-6', 1, 'N']].forEach(function (b) {
      var bt = el('button', { type: 'button', class: 'stepbtn', 'aria-label': b[0], title: b[0] + ' (' + b[3] + ')' });
      /* built as nodes, never markup: the page assigns no HTML strings (the tests pin this) */
      var svg = mk('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
      svg.append(mk('path', { d: b[1] })); bt.append(svg);
      bt.addEventListener('click', function () { stepChange(b[2]); });
      stepBar.append(bt);
    });
    st.parentNode.insertBefore(stepBar, st.nextSibling);
    return stepBar;
  }
  /* after a view is drawn: a new step opens on its first change (scrolled there, nothing focused); a redraw of the same step puts the columns back where they were */
  function afterDraw(rc, view, solo) {
    stepView = view; var same = drawnKey === rc.key; drawnKey = rc.key; paintZoomCtl();
    var ts = solo ? [] : stepTargets(), bar = ensureStepBar();
    /* the change arrows show only when the step has more than one change */
    if (bar) bar.hidden = ts.length < 2;
    if (same && snap) {
      if (stepAt >= ts.length) stepAt = ts.length - 1;
      if (stepAt >= 0 && ts[stepAt]) { paintCloseUp(ts[stepAt].id); paintRing(ts[stepAt].id); }
      fitColumns();
      if (zoomKey && zoomKey.key === rc.key) setZoom(zoomKey.z);
      ['before', 'after'].forEach(function (side) { if (snap[side] && pscrolls[side]) setPagePos(pscrolls[side], snap[side]); });
      if (stepAt >= ts.length) stepAt = ts.length - 1;
      return;
    }
    stepAt = -1; snap = null; zoomKey = null; openRow = -1;
    ringPane = { before: null, after: null };
    var k = firstDrawn(ts);
    if (k >= 0) goStep(k, ts, false);
    else { fitColumns(); if (!solo) openChangedPicture(view); }
  }
  /* the line over a made document (who made it, the tally, how many changes have no place) is a set of notes in the Details panel: the line stays empty */
  function paintViewLine() { var n = $('viewline'); n.textContent = ''; n.hidden = true; }
  /* Level 1: a change list, cards only. A tally line, each change as a card, its children grouped under it. No picture, no box. */
  function drawCardList(view) {
    $('stage').hidden = true; $('below').hidden = true; $('bodyview').hidden = false; $('viewline').hidden = true;
    paintFinding(view.status); paintExtras(view);
    var box = $('bodyview');
    /* a file row CoCheck could not read: why, in CoCheck's words first, then what the connector said; no source line, no "Nothing changed." */
    if (view.failed) { var cv = view.caveats || []; box.append(el('p', { class: 'cvcaveat' }, 'No change list: ' + (cv[0] || 'the change list could not be read') + '.')); cv.slice(1).forEach(function (c) { box.append(el('p', { class: 'cvcaveat' }, c)); }); return; }
    /* the source line, the tally and the caveats are notes in the Details panel */
    function card(g, depth) {
      var c = VT.comment(g.change), words = [];
      var node = el('div', { class: 'mcard cvcard' + (depth ? ' child' : '') }, el('p', {}, el('strong', {}, c.head || (c.verb || 'Change')), c.verb && c.head ? ' (' + c.verb.toLowerCase() + ')' : ''));
      /* a blank line has no <s> child, so .cvl:empty draws its height. (VT.comment flattens whitespace for the shared cards, so the raw text is used here) a change's before and after keep the connector's line breaks and leading spaces: one block per line, drawn pre-wrap (labels, notes and one-line values stay collapsing) */
      var ln = function (t, strike) { return String(t).replace(/\s+$/, '').replace(/^(\s*\n)+/, '').split(/\r?\n/).map(function (l) { return el('div', { class: 'cvl' }, strike && l !== '' ? el('s', {}, l) : l); }); };
      if (c.before) node.append(el('p', { class: 'cvbefore' }, ln(g.change.before, true)));
      if (c.after) node.append(el('p', { class: 'cvafter' }, ln(g.change.after, false)));
      if (c.text) node.append(el('p', {}, c.text));
      c.lines.forEach(function (l) { node.append(el('p', {}, String(l))); });
      g.children.forEach(function (k) { node.append(card(k, depth + 1)); });
      return node;
    }
    VT.groupChanges(view.items.map(function (it) { return it.change; })).forEach(function (g) { box.append(card(g, 0)); });
    /* a file row the review process is still reading says so (waitForPicture asks again and draws the frozen list when it is ready) */
    if (view.pending && !view.items.length) { box.append(el('div', { class: 'loadpane' }, loading('Reading the change list'))); return; }
    /* spec v1.2: changes left out of the list are said in place, after it; a list of none with some left out is never "Nothing changed." */
    if (view.more) box.append(el('p', { class: 'xmore' }, view.more));
    else if (!view.items.length) box.append(el('p', {}, 'Nothing changed.'));
  }
  function drawView(stop, rc, view, solo, glide) {
    cfDrop();
    if (view.level === 1 && view.source) { drawCardList(view); if (!solo) detRecord(stop.id, VT.stepNotes(view), true); return; }
    paintViewLine();
    var boxes = view.marks;
    /* The limits of the view are notes in the Details panel, never words under the panes */
    $('caveats').textContent = ''; $('about').hidden = true;
    try { drawViewBody(stop, rc, view, solo, glide, boxes); } finally { if (!solo) detRecord(stop.id, VT.stepNotes(view, view.changeFirst ? CF.miss : null), true); }
  }
  function drawViewBody(stop, rc, view, solo, glide, boxes) {
    paintBanner(view.banner);
    paintFinding(view.status); paintExtras(view);
    var plan = sheetPlan(view, rc.key); curPlan = plan;
    var gone = solo ? null : goneSide(rc, view);
    var fb = fillSide('before', view, boxes, plan, gone), fa = fillSide('after', view, boxes, plan, gone);
    if (gone) showOneSide(gone, stop);
    if (plan.keys.length) selectSheet(plan, plan.sel, null, true);
    /* The panes, the notes and the leaders glide as one, so a leader never starts at the pre-glide place and jumps */
    var gl = ['pb', 'pa', 'notes', 'svg'];
    gl.forEach(function (id) { $(id).classList.remove('glide'); });
    if (glide) { void $('pa').offsetWidth; gl.forEach(function (id) { $(id).classList.add('glide'); }); }
    if (solo) { $('stage').classList.add('nonotes'); $('stage').classList.add('solo-' + solo.side); curItems = []; layout([]); return; }
    var treeHit = null;
    if (rc.newFile && rc.treeBefore && rc.treeAfter) {
      buildTree($('trb'), rc.treeBefore); treeHit = buildTree($('tra'), rc.treeAfter);
    }
    /* change-first: the document's changes drawn as boxes and comments; otherwise its cards fill the notes column */
    if (view.changeFirst) { CF.drawIn = stop.id !== CF.step && !reduced(); CF.step = stop.id; drawChanges(view, rc, boxes, fa, fb); return; }
    var nt = $('notes'), items = [];
    var firstAfter = Object.keys(fa)[0], firstBefore = Object.keys(fb)[0];
    var anchored = function (node) { return { node: node, a: firstAfter != null ? fa[firstAfter] : null, b: firstBefore != null ? fb[firstBefore] : null }; };
    /* A text change has no notes column: the aligned diff is its own note and gets the width */
    var textOnly = plan.keys.length > 0 && plan.keys.every(function (k) { return plan.kind[k] === 'text'; });
    if (textOnly) {
      $('stage').classList.add('nonotes');
      /* a mostly-additions step of a file that had lines is one column with no before pane, labelled for both sides (a created subject is the one-side pane already) */
      if (!gone && view.before.length === 0 && view.after.length > 0) {
        $('stage').classList.add('unified'); $('stage').classList.add('solo-after');
        var both = $('lsa'); if (both) both.textContent = 'Before and after';
      }
      curItems = []; layout([]);
      return;
    }
    if (rc.rewrite) {
      /* A change too big to read cell by cell is one card, never cell trivia */
      items.push(anchored(el('div', { class: 'note sel', tabindex: 0 }, el('span', { class: 't' }, stop.label), el('span', { class: 'v' }, rc.note))));
    }
    /* A paragraph, picture or chart change is one card per place: the place, the old words struck through, the new words after them */
    var cardItems = [], allCards = view.cards || [];
    allCards.forEach(function (ent) {
      var c = VT.noteCard(ent.change);
      var vals = [];
      if (c.verb) vals.push(el('b', {}, c.verb + (c.before || c.after ? ': ' : '')));
      if (!c.verb && c.before && c.after) {
        /* an edited place reads as a change: the label and the old words struck, then the new words, each clamped on its own so the new words are never hidden behind the old */
        vals.push(el('span', { class: 'cs' }, el('b', {}, 'Edited: '), el('s', {}, c.before)), el('span', { class: 'cs' }, c.after));
      } else {
        if (c.before) vals.push(el('s', {}, c.before), c.after ? ' ' : '');
        if (c.after) vals.push(c.after);
      }
      if (c.text) vals.push(c.text);
      /* the card text clamps (200 px of card) until "show all" */
      /* the place clamps too (a chart title is up to 240 characters) and one toggle opens the whole card; the card is capped at 200 px until then */
      /* a paragraph card has no place (its count was wrong to a reader): no head element, no gap */
      var pl = c.place ? el('span', { class: 'cardt clamp' }, c.place) : null, node = el('div', { class: 'note sel capped', tabindex: 0 });
      var cl = clampText('span', 'cardv', vals, pl ? [pl, node] : [node]);
      if (pl) node.append(el('span', { class: 't' }, pl));
      node.append(el('span', { class: 'v' }, cl[0]), cl[1]);
      /* a card is drawn only when the view has no pictures (a view with pictures and cards draws change-first), so it has no box to lead to */
      cardItems.push({ node: node, a: null, b: null });
    });
    /* The first five cards fill the column, and the others are counted. */
    var shownCards = cardItems, leftOut = 0;
    if (allCards.length > 5) {
      shownCards = cardItems.slice(0, 5);
      leftOut = allCards.length - shownCards.length;
    }
    shownCards.forEach(function (x) { items.push(x); });
    if (leftOut > 0) items.push({ node: el('div', { class: 'note more' }, leftOut + (leftOut === 1 ? ' more change.' : ' more changes.')), a: null, b: null, tail: true });
    /* The change's one note only when it adds to the heading: a new file's note is empty when it would only say "created" again */
    if (!items.length && rc.note) items.push(anchored(el('div', { class: 'note sel', tabindex: 0 }, el('span', { class: 't' }, stop.label), el('span', { class: 'v' }, rc.note))));
    /* the format list was capped: say how many changes have no note and where they are, whatever else the notes show */
    if (rc.moreNote) items.push({ node: el('div', { class: 'note more' }, rc.moreNote), a: null, b: null, tail: true });
    /* a new file outside the work folder: its tree is not drawn, so one line says where it is not */
    if (rc.newFile && rc.newFile.outside) items.push({ node: el('div', { class: 'note card' }, el('span', { class: 'ln plain' }, 'Outside your work folder.')), a: treeHit || null, b: null });
    if (!items.length) $('stage').classList.add('nonotes');
    items.forEach(function (it) { nt.append(it.node); });
    curItems = items;
    layout(items);
  }
  /* hover focus. Hovering a matched box (either side) or its card shows that card's before-to-after threads, highlights both boxes and
     dims the rest of the leaders and boxes; leaving restores. Every layout (step, tab, resize, poll repaint) starts by clearing it, so nothing sticks. */
  var hvOn = [], hvEls = [];
  function hvClear() {
    hvOn.forEach(function (n) { n.classList.remove('hv'); }); hvOn = [];
    var st = $('stage'); if (st) { st.classList.remove('hvon'); st.classList.remove('cfon'); }
    cfClear();
  }
  function hvSet(it, anchor) {
    hvClear();
    if (it && it.change) { cfShow(it, anchor); return; }
    if (!it || !it.parts) return;
    hvOn = it.parts.slice(); hvOn.forEach(function (n) { n.classList.add('hv'); });
    $('stage').classList.add('hvon');
  }
  /* the listeners go on once per element; each layout points the element at its current card */
  /* a box that belongs to a card gets .hm (the CSS gives only those boxes the pointer, above any unmatched box); an unmatched box has none, so it takes no hover */
  /* change-first boxes (it.change) are focusable too: keyboard focus shows what the pointer shows, and a box that holds focus keeps its change shown when the pointer leaves */
  function hvBind(n, it, isBox) {
    n.hvItem = it; if (!(it && it.change)) hvEls.push(n); if (isBox) n.classList.add('hm');
    if (n.hvBound) return; n.hvBound = true;
    n.addEventListener('mouseenter', function () { hvSet(n.hvItem, n); });
    n.addEventListener('mouseleave', function () { if (n.hvItem && n.hvItem.change && document.activeElement === n) return; hvClear(); });
    if (it && it.change) {
      n.addEventListener('focus', function () { hvSet(n.hvItem, n); });
      n.addEventListener('blur', function () { hvClear(); });
    }
  }
  function layout(items) {
    var svg = $('svg'), stage = $('stage'); svg.textContent = '';
    /* a change-first focus survives a layout (the page lays out on a scroll frame); redraws, Clean view and the Point tool clear it by name */
    if (CF.live) cfRefresh(); else hvClear();
    hvEls.forEach(function (n) { n.hvItem = null; n.classList.remove('hm'); }); hvEls = [];
    refreshClamps();
    if (innerWidth <= 1180) { items.forEach(function (it) { it.node.style.top = ''; }); return; }
    var S = stage.getBoundingClientRect(), nl = $('notes').getBoundingClientRect().left - S.left;
    /* A pane mid-glide is drawn some px below where it lays out. Measure every anchor at its laid-out place and let the glide carry the leaders with it. */
    var dyOf = function (n) {
      var pn = n.closest && n.closest('.pane'); if (!pn) return 0;
      return pn.getBoundingClientRect().top - S.top - pn.offsetTop;
    };
    var rectOf = function (n) { var r = n.getBoundingClientRect(), d = dyOf(n); return { left: r.left, right: r.right, width: r.width, height: r.height, top: r.top - d }; };
    var vA = rectOf($('pa'));
    var top = Math.max(0, vA.top - S.top), gap = 8;
    var real = items.filter(function (it) { return !it.tail; }), tails = items.filter(function (it) { return it.tail; });
    /* an anchor on a tab that is not showing has no place on screen: its note stays, its leader waits for the tab */
    var shown = function (n) { return n && !(n.closest && n.closest('.vw[hidden]')) ? n : null; };
    real.forEach(function (it) { it.sa = shown(it.a); it.sb = shown(it.b); });
    /* a box anchors at its own centre */
    var unionOf = function (list) {
      var rs = list.map(function (n) { return rectOf(n); }), u = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      rs.forEach(function (r) { u.left = Math.min(u.left, r.left); u.right = Math.max(u.right, r.right); u.top = Math.min(u.top, r.top); u.bottom = Math.max(u.bottom, r.top + r.height); });
      u.height = u.bottom - u.top; return u;
    };
    real.forEach(function (it) {
      it.ma = it.sa ? [it.sa] : []; it.mb = it.sb ? [it.sb] : [];
      it.ua = it.ma.length ? unionOf(it.ma) : null;
      it.cy = it.ua ? (it.ua.top + it.ua.bottom) / 2 - S.top : top;
      it.hidden = !it.ua;
    });
    /* notes keep the order of their anchors, and every leader bends at one common x, so no leader crosses another or passes through a note */
    var st = VT.stackNotes(real, real.map(function (it) { return it.node.offsetHeight; }), top, gap);
    real.forEach(function (it, k) { it.top = st.slots[k].top; it.ny = st.slots[k].ny; it.node.style.top = it.top + 'px'; });
    var y = st.end;
    tails.forEach(function (it) { it.node.style.top = y + 'px'; y += it.node.offsetHeight + gap; });
    $('notes').style.minHeight = Math.max(y, stage.clientHeight) + 'px';
    var vB = rectOf($('pb')), gx = vB.right < vA.left ? (vB.right + vA.left) / 2 - S.left : vA.left - S.left;
    real.forEach(function (it) {
      if (!it.sa) return;
      var ar = it.ua, x1 = ar.right - S.left, y1 = it.cy, p = VT.leaderPoints(x1, y1, nl, it.ny), parts = [it.node].concat(it.ma);
      if (it.sb) {
        /* the thread leaves the before box's right edge, runs down the gutter and ends on the after box's left edge (never through page text) */
        var bn = rectOf(it.sb), an = rectOf(it.sa);
        var yb = bn.top - S.top + bn.height / 2, ya = an.top - S.top + an.height / 2, x0 = bn.right - S.left, xa = an.left - S.left;
        /* drawn but hidden until a hover (the CSS); hover focus adds .hv to it */
        var th = mk('path', { class: 'th sel', d: 'M' + x0 + ',' + yb + ' L' + gx + ',' + yb + ' L' + gx + ',' + ya + ' L' + xa + ',' + ya });
        svg.append(th); parts = parts.concat(it.mb, [th]);
      }
      var ld = mk('path', { class: 'ld sel', d: 'M' + p[0][0] + ',' + p[0][1] + ' L' + p[1][0] + ',' + p[1][1] + ' L' + p[2][0] + ',' + p[2][1] }), d1 = mk('circle', { class: 'dot sel', cx: x1, cy: y1, r: 4 }), d2 = mk('circle', { class: 'dot sel', cx: nl, cy: it.ny, r: 4 });
      svg.append(ld, d1, d2);
      it.parts = parts.concat([ld, d1, d2]);
      hvBind(it.node, it); it.ma.forEach(function (n) { hvBind(n, it, true); }); if (it.sb) it.mb.forEach(function (n) { hvBind(n, it, true); });
    });
  }

  /* ---------- change-first view (feat/change-first-views): one box per change per side, a callout on hover or focus, the other changes dimmed and one gradient line ----------
     Boxes are div.bx.cf[data-change][data-side] inside the page they mark (so they scroll with it). While a change is focused its boxes (both sides) stay at full
     strength and every other change box drops to 40% (the CSS, under .stage.cfon); nothing covers the picture. One callout is drawn beside the box under the pointer
     or focus. The line is one svg.cf-line in the stage. Every state here is cleared by hvClear, which every layout and every redraw starts with, so nothing stale
     survives a live refresh. Boxes draw in once when a step is arrived at (cf-in), never on a redraw of the same step, and never under reduced motion. */
  var CF = { items: {}, live: null, temp: [], words: null, svg: null, bound: false, raf: 0, step: null, drawIn: false };
  var CF_BLUE = 'stop-color:var(--before)', CF_PINK = 'stop-color:var(--after)';
  function cfWalk(node, fn) { for (var i = 0; i < (node.children || []).length; i++) { var c = node.children[i]; fn(c); cfWalk(c, fn); } }
  function hasCls(n, c) { return !!(n.className && typeof n.className === 'string' && (' ' + n.className + ' ').indexOf(' ' + c + ' ') >= 0); }
  /* one comment line as plain words, for the words list and the box's label */
  function cfText(c) { return VT.commentText(c); }
  /* The callout: the change's changed words marked inside the sentence (a word diff of its public before and after strings: removed words struck in a
     before tint, added words in an after tint, long unchanged runs elided). A change with no words shows its text, else its label, else "Changed".
     Outside data: every word goes in as a text node, never as markup. A side a change shows nothing on is a note in the Details panel, never words here. */
  /* words for the callout with every token that holds a hyphen or dash between characters ("(2026-10)", "Q3-Q4") in a span that does not wrap,
     so a line never breaks after the dash. Text nodes only, never markup. */
  var JOINED = /(\S*[^\s\-\u2010-\u2015][\-\u2010-\u2015]+[^\s\-\u2010-\u2015]\S*)/;
  function cfKeep(t) {
    var parts = String(t).split(JOINED), out = [];
    parts.forEach(function (x, i) { if (!x) return; out.push(i % 2 ? el('span', { class: 'nw' }, x) : x); });
    return out.length ? out : [String(t)];
  }
  function cfCommentNode(it, side) {
    var c = it.comment || {}, cm = el('div', { class: 'cm cf-cm', 'data-side': side, 'data-change': it.id });
    var segs = VT.wordDiff(c.before, c.after), tx = c.text ? String(c.text).trim() : '', kids = [];
    segs.forEach(function (g, i) {
      if (i) kids.push(' ');
      if (g.k === 'del') kids.push(el('del', {}, cfKeep(g.t))); else if (g.k === 'add') kids.push(el('ins', {}, cfKeep(g.t)));
      else if (g.k === 'gap') kids.push(el('span', { class: 'gap' }, g.t)); else kids = kids.concat(cfKeep(g.t));
    });
    if (!segs.length) kids = kids.concat(cfKeep(tx || c.head || 'Changed'));
    cm.append(el('span', { class: 'cb' }, kids));
    /* a change with words and a text (a renumbering consequence on a paragraph row) shows the text as its own extra line */
    if (tx && segs.length) cm.append(el('div', { class: 'cl' }, cfKeep(tx)));
    return cm;
  }
  /* the boxes of one change this file drew, on the tabs on show only */
  function cfBoxesOf(id) {
    var it = CF.items[id], out = [];
    function add(n) { if (n && out.indexOf(n) < 0 && !(n.closest && n.closest('.vw[hidden]'))) out.push(n); }
    if (it) it.boxes.forEach(add);
    return out;
  }
  function cfPaneOf(n, side) { var p = n.closest ? n.closest('.pane') : null; return p || $(side === 'before' ? 'pb' : 'pa'); }
  /* where the callout goes, always fully inside the visible part of its pane or scroll column: below its box if it fits, else above; when neither fits it is
     clamped into the visible area (and may then overlap content). All in viewport rects, then turned into the host's own coordinates. */
  function cfPlace(cm, box, pane) {
    var host = cm.parentNode, H = host.getBoundingClientRect(), B = box.getBoundingClientRect(), cw = cm.offsetWidth || 0, ch = cm.offsetHeight || 0, gap = 8;
    var V = pane ? cfViewOf(box, pane) : { left: H.left, top: H.top, right: H.right, bottom: H.bottom };
    function cl(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }
    function x(v) { return cl(v, V.left, Math.max(V.left, V.right - cw)); }
    function y(v) { return cl(v, V.top, Math.max(V.top, V.bottom - ch)); }
    var X, Y, c;
    if ((c = B.bottom + gap) + ch <= V.bottom && c >= V.top) { X = x(B.left); Y = c; }
    else if ((c = B.top - gap - ch) >= V.top && c + ch <= V.bottom) { X = x(B.left); Y = c; }
    else { X = x(B.left); Y = y(B.bottom + gap); }
    cm.style.top = (Y - H.top - (host.clientTop || 0)) + 'px';
    cm.style.left = (X - H.left - (host.clientLeft || 0)) + 'px';
  }
  /* an ancestor that clips what sticks out of it (overflow other than visible, e.g. the per-page .vw): a comment placed outside it would be cut */
  function cfClips(n) {
    if (typeof getComputedStyle !== 'function' || !n.nodeType) return false;
    var cs = getComputedStyle(n);
    return !!cs && ((cs.overflowX && cs.overflowX !== 'visible') || (cs.overflowY && cs.overflowY !== 'visible'));
  }
  /* the part of a pane a box can be seen in: the pane, cut by the scroll area it sits in */
  function cfViewOf(box, pane) {
    var v = pane.getBoundingClientRect(), l = v.left, t = v.top, r = v.right, b = v.bottom;
    for (var n = box.parentNode; n && n !== pane; n = n.parentNode) {
      if (hasCls(n, 'pscroll') || cfClips(n)) { var q = n.getBoundingClientRect(); l = Math.max(l, q.left); t = Math.max(t, q.top); r = Math.min(r, q.right); b = Math.min(b, q.bottom); }
    }
    return { left: l, top: t, right: r, bottom: b };
  }
  function cfSeen(n, v) { var r = n.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2; return cx >= v.left && cx <= v.right && cy >= v.top && cy <= v.bottom; }
  /* the gradient line: before box's right edge, along to the gutter, down, into the after box's left edge. Hidden while either end is scrolled out of its pane. */
  function cfLine() {
    var svg = CF.svg; if (!svg) return; svg.textContent = '';
    var it = CF.live; if (!it) return;
    var ends = {};
    cfBoxesOf(it.id).forEach(function (b) {
      var side = b.getAttribute('data-side'), pane = cfPaneOf(b, side);
      if (!pane || ends[side]) return;
      if (cfSeen(b, cfViewOf(b, pane))) ends[side] = { box: b, pane: pane };
    });
    if (!ends.before || !ends.after) return;
    var S = $('stage').getBoundingClientRect(), rb = ends.before.box.getBoundingClientRect(), ra = ends.after.box.getBoundingClientRect();
    var pb = ends.before.pane.getBoundingClientRect(), pa = ends.after.pane.getBoundingClientRect();
    if (!(pb.right < pa.left)) return; /* panes stacked: no gutter to run through */
    var x0 = rb.right - S.left, xa = ra.left - S.left, yb = rb.top + rb.height / 2 - S.top, ya = ra.top + ra.height / 2 - S.top, gx = (pb.right + pa.left) / 2 - S.left;
    var g = mk('linearGradient', { id: 'cfgrad', gradientUnits: 'userSpaceOnUse', x1: x0, y1: yb, x2: xa, y2: ya });
    g.append(mk('stop', { offset: '0', style: CF_BLUE }), mk('stop', { offset: '1', style: CF_PINK }));
    var p = mk('path', { class: 'cf-ln', d: 'M' + x0 + ',' + yb + ' L' + gx + ',' + yb + ' L' + gx + ',' + ya + ' L' + xa + ',' + ya, stroke: 'url(#cfgrad)' });
    svg.append(g, p);
  }
  /* the line follows the panes as they scroll or the window resizes */
  function cfRefresh() {
    CF.raf = 0;
    if (!CF.live) return;
    cfLine();
  }
  function cfSoon() { if (!CF.live || CF.raf) return; CF.raf = 1; if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cfRefresh); else cfRefresh(); }
  /* one callout, on the box under the pointer or focus; with none (stepping with N and P) on the first box in view, the After side first */
  function cfShow(it, anchor) {
    var boxes = cfBoxesOf(it.id); if (!boxes.length) return;
    CF.live = it;
    boxes.forEach(function (b) { b.classList.add('hv'); hvOn.push(b); });
    var pick = anchor && boxes.indexOf(anchor) >= 0 ? anchor : null;
    if (!pick) {
      var order = boxes.filter(function (b) { return b.getAttribute('data-side') === 'after'; }).concat(boxes.filter(function (b) { return b.getAttribute('data-side') !== 'after'; }));
      order.forEach(function (b) { if (pick) return; var pane = cfPaneOf(b, b.getAttribute('data-side')); if (!pane || cfSeen(b, cfViewOf(b, pane))) pick = b; });
      if (!pick) pick = order[0];
    }
    var side = pick.getAttribute('data-side'), pane = cfPaneOf(pick, side);
    var cm = cfCommentNode(it, side); pick.parentNode.append(cm); cm.classList.add('hv'); /* shown first: a hidden callout has no size to place by */ cfPlace(cm, pick, pane); CF.temp.push(cm);
    $('stage').classList.add('cfon');
    cfRefresh();
    if (!CF.bound) {
      CF.bound = true;
      if (typeof document.addEventListener === 'function') document.addEventListener('scroll', cfSoon, true);
      if (typeof window.addEventListener === 'function') window.addEventListener('resize', cfSoon);
    }
  }
  function cfClear() {
    CF.live = null;
    CF.temp.forEach(function (c) { if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c); }); CF.temp = [];
    if (CF.svg) CF.svg.textContent = '';
  }
  /* what the stepping code (N and P) calls: show a change exactly as hovering it does (scrolling to it is the caller's), and put it away */
  function focusChange(id) { var it = CF.items[id]; if (it) { hvSet(it); cfPulse(it); } }
  /* stepping to a change pulses its boxes once (never under reduced motion) */
  var pulseT = 0;
  function cfPulse(it) {
    if (reduced() || typeof setTimeout !== 'function') return;
    var bs = cfBoxesOf(it.id);
    bs.forEach(function (b) { b.classList.remove('cf-in'); b.classList.remove('cf-pulse'); void b.offsetWidth; b.classList.add('cf-pulse'); });
    clearTimeout(pulseT);
    pulseT = setTimeout(function () { bs.forEach(function (b) { b.classList.remove('cf-pulse'); }); }, 400);
  }
  function clearFocus() { hvClear(); }
  window.CoCheckFocus = { focusChange: focusChange, clearFocus: clearFocus };
  /* every registry of the last drawing leaves with the step (every step's render calls this, so nothing of a file step outlives it under a message) */
  function cfDrop() {
    hvClear(); CF.items = {}; CF.miss = null;
  }
  /* the drawn box of every rect box of the changes, per side and picture (VT.drawBoxes): a Map from the box to its percent rect, or to null
     when it draws as part of an earlier box of its change. `mountOf(paneId)` gives the picture's { w, h }, or null when it is not on show. */
  function drawnBoxes(changes, mountOf) {
    var per = {}, res = new Map();
    (changes || []).forEach(function (ch) {
      (ch.boxes || []).forEach(function (b) {
        if (!b || b.cell || b.line != null || !b.rect || !mountOf(b.pane)) return;
        var k = b.side + '\u0000' + b.pane; (per[k] = per[k] || { pane: b.pane, list: [], boxes: [] });
        per[k].list.push({ rect: b.rect, key: ch.id }); per[k].boxes.push(b);
      });
    });
    Object.keys(per).forEach(function (k) {
      var g = per[k], m = mountOf(g.pane), d = VT.drawBoxes(g.list, m.w, m.h);
      g.boxes.forEach(function (b, i) { res.set(b, d[i]); });
    });
    return res;
  }
  function drawChanges(view, rc, boxes, fa, fb) {
    var stage = $('stage');
    stage.classList.add('nonotes'); curItems = []; layout([]);
    var changes = view.items;
    /* the pages and notes panels on show, by pane id; today's boxes on them give way to the change boxes */
    var mounts = {};
    ['vb', 'va'].forEach(function (id) {
      cfWalk($(id), function (n) {
        var pid = hasCls(n, 'vw') && n.getAttribute ? n.getAttribute('data-pane') : null;
        if (!pid) return;
        var m = { pw: null, w: 0, h: 0 };
        Array.prototype.forEach.call(n.children || [], function (c) {
          if (hasCls(c, 'pagewrap') && !m.pw) { m.pw = c; var im = c.children && c.children[0]; m.w = Number(im && im.getAttribute && im.getAttribute('width')) || 0; m.h = Number(im && im.getAttribute && im.getAttribute('height')) || 0; }
        });
        mounts[pid] = m;
        [m.pw].forEach(function (host) { if (host) Array.prototype.slice.call(host.children).filter(function (c) { return hasCls(c, 'bx') && !hasCls(c, 'cf'); }).forEach(function (c) { if (host.removeChild) host.removeChild(c); }); });
      });
    });
    var entries = [], drawn = drawnBoxes(changes, function (pid) { var m = mounts[pid]; return m && m.pw && m.w > 0 && m.h > 0 ? m : null; });
    changes.forEach(function (ch) {
      var it = { id: ch.id, change: ch, boxes: [], comment: ch.comment, missing: [] }, mounted = { before: false, after: false };
      (ch.boxes || []).forEach(function (b) {
        if (b.cell) return; /* a cell box: no pane draws it (the page draws no grid), so it is a Details note */
        /* a line box: drawn only where a text pane really marked its line (the anchor fillSide found for it) */
        if (b.line != null) { var li = boxes.indexOf(b); if (li >= 0 && (b.side === 'before' ? fb : fa)[li]) mounted[b.side] = true; return; }
        var m = mounts[b.pane], node = null;
        if (m && b.rect && m.pw && m.w > 0 && m.h > 0) {
          /* a box drawn as part of an earlier box of its change (drawBoxes merged them) adds its highlights only */
          var pb = drawn.has(b) ? drawn.get(b) : VT.padBox(b.rect, m.w, m.h);
          if (pb) {
            node = el('div', { class: CF.drawIn ? 'bx cf cf-in' : 'bx cf' });
            node.style.left = pb.left + '%'; node.style.top = pb.top + '%'; node.style.width = pb.width + '%'; node.style.height = pb.height + '%';
          } else mounted[b.side] = true;
          (b.highlights || []).forEach(function (h) {
            var hl = el('div', { class: 'hl cf-hl', 'data-change': ch.id });
            hl.style.left = (100 * h.x / m.w) + '%'; hl.style.top = (100 * h.y / m.h) + '%'; hl.style.width = (100 * h.w / m.w) + '%'; hl.style.height = (100 * h.h / m.h) + '%';
            m.pw.append(hl);
          });
          if (node) m.pw.append(node);
        }
        if (!node) return;
        node.setAttribute('data-change', ch.id); node.setAttribute('data-side', b.side); node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button'); node.setAttribute('aria-label', 'Show this change: ' + cfText(it.comment));
        it.boxes.push(node); mounted[b.side] = true;
      });
      it.missing = VT.missingSides(ch, mounted, changes);
      CF.items[ch.id] = it;
      it.boxes.forEach(function (n) { hvBind(n, it, false); });
      if (it.missing.length) entries.push(it);
    });
    if (!CF.svg) { CF.svg = mk('svg', { class: 'cf-line', 'aria-hidden': 'true' }); stage.append(CF.svg); }
    if (CF.svg.parentNode !== stage) stage.append(CF.svg);
    /* every change that shows on no side of a picture is a note of this step in the Details panel, with its comment and why (drawView records CF.miss) */
    CF.miss = {};
    entries.forEach(function (it) { CF.miss[it.id] = it.missing; });
  }

  /* ---------- the Files view ----------
     One shell, two views of the same record. Files mode hides the rail and the step heading, shows the file list and the version strip, and
     draws the chosen version through the same per-change view as a step (render() on that version's stop). The Steps view is untouched:
     its hash stays #<index>; the Files view's is #v=files&f=<the file's path, URL-encoded>&p=<position> (the path, never the list position). */
  var FV = typeof CoCheckFilesView === 'undefined' ? null : CoCheckFilesView, FILES = [], mode = 'steps', fcur = { f: 0, p: 0 }, ftrail = [];
  var outsideDirs = null, outsideAsked = false, outsideSeen = 0;
  var FH = {
    el: el,
    chip: function (lane) { var a = actorOf(lane); return a ? chipEl(a) : el('b', { class: 'chip' }, '?'); },
    name: function (lane) { var a = actorOf(lane); return a ? a.name : lane; },
    color: function (lane) { var a = actorOf(lane); return a ? a.color : 'var(--ink-3)'; },
    /* The directories of the outside files, from their own route (never the model); asked once, when the group opens */
    outsideDirs: function () { return outsideDirs; },
    loadOutside: function () {
      if (outsideAsked) return; outsideAsked = true;
      fetch(withToken('/timeline/' + task + '/outside-paths'), { headers: { accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { if (j && typeof j === 'object') { outsideDirs = j; paintFiles(); } }).catch(function () { outsideAsked = false; });
    },
    /* The verdict on the file's latest version, for the small mark on its card */
    markOf: function (f) { return FH.markOfVersion(f && f.versions && f.versions[f.versions.length - 1]); },
    /* The verdict on the step that made one version (the main rail's own status), null when the step has none or is not on the rail */
    markOfVersion: function (l) { var s = l ? STOPS[stopIndex(l.stop)] : null, v = s ? revOf(s).status : 'not_reviewed'; return v === 'not_reviewed' ? null : v; },
    pick: function (i, p) { ftrail = []; fcur = { f: i, p: p }; paintFiles(); },
    go: function (p) { fcur.p = p; paintFiles(); },
    /* Open an input at its version, remembering where we were; back(k) returns to place k of that path, Esc to the last one */
    open: function (i, p) { ftrail.push({ f: fcur.f, p: fcur.p }); fcur = { f: i, p: p }; paintFiles(); },
    back: function (k) { var t = ftrail[k]; if (!t) return; ftrail = ftrail.slice(0, k); fcur = { f: t.f, p: t.p }; paintFiles(); }
  };
  function unkey(t) { try { return decodeURIComponent(t); } catch (e) { return ''; } }
  /* The file and version the step on show belongs to (a call header: its first file), or null */
  function fileAtStep() {
    var s = STOPS[cur], id = s && s.change ? s.id : null;
    if (s && s.hdr) (s.covers || []).forEach(function (c) { var t = STOPS[stopIndex(c)]; if (!id && t && t.change) id = t.id; });
    if (!id) return null;
    for (var fi = 0; fi < FILES.length; fi++) for (var vi = 0; vi < FILES[fi].versions.length; vi++) if (FILES[fi].versions[vi].stop === id) return { f: fi, p: vi + 1 };
    return null;
  }
  function paintFiles() { paintFilesMain(); paintMarks(); }
  function paintFilesMain() {
    var f = FILES[fcur.f]; fcur.p = f.source ? 0 : FV.clamp(f, fcur.p);
    /* A source (read, never changed) has no versions and no steps: the list, the head and the sentence only, and the Before/After stage stays out of the way */
    if (f.source) {
      FV.paintList($('fileslist'), FILES, fcur.f, FH); FV.paintHead($('fvname'), $('fvorder'), f, 0, FH); $('strip').textContent = ''; $('strip').hidden = true;
      $('fvbuilt').textContent = ''; $('fvwarn').textContent = ''; FV.paintCrumbs($('fvcrumbs'), ftrail, FILES, FH); $('stage').hidden = true; $('below').hidden = true; $('bodyview').hidden = true;
      paintPbar();
      history.replaceState(null, '', '#v=files&f=' + encodeURIComponent(f.ref || f.file) + '&p=0');
      return;
    }
    $('strip').hidden = false; $('stage').hidden = false;
    FV.paintList($('fileslist'), FILES, fcur.f, FH); FV.paintStrip($('strip'), f, fcur.p, FH); FV.paintHead($('fvname'), $('fvorder'), f, fcur.p, FH);
    FV.paintBuilt($('fvbuilt'), FILES, f, fcur.p, FH); FV.paintStale($('fvwarn'), FILES, f, fcur.p, FH); FV.paintCrumbs($('fvcrumbs'), ftrail, FILES, FH);
    var i = stopIndex(FV.versionAt(f, fcur.p).stop);
    QV = null; if (i >= 0) cur = i; instant = false;
    history.replaceState(null, '', '#v=files&f=' + encodeURIComponent(f.ref || f.file) + '&p=' + fcur.p);
    render();
  }
  function setMode(m, keep) {
    if (m === 'files' && !(FV && FILES.some(function (f) { return !f.source; }))) m = 'steps';
    if (m === 'files' && !keep) { var at = fileAtStep(); if (at) { fcur = at; ftrail = []; } }
    mode = m; paintOrder();
    var files = m === 'files';
    $('vsteps').setAttribute('aria-pressed', String(!files)); $('vfiles').setAttribute('aria-pressed', String(files));
    $('railcol').hidden = files; { var rt = $('railtoggle'); if (rt) rt.hidden = files; } if (files) setRail(false, false); $('head').hidden = files; $('listcol').hidden = !files; $('filesview').hidden = !files;
    if (files) return paintFiles();
    /* The step on show sits under a closed header: the header is the row selected, so the step is never hidden inside a closed group */
    QV = null; if (!isVis(cur)) { var hh = headerOf(STOPS[cur]), hi = hh ? stopIndex(hh.id) : -1; cur = hi >= 0 && isVis(hi) ? hi : nearestVis(cur); }
    bareUrl(); instant = true; render();
  }
  $('vsteps').addEventListener('click', function () { if (mode !== 'steps') setMode('steps'); });
  /* Clean diff: one class on the body hides the notes, the leader lines and the change boxes; render() never touches it, so it
     survives every render, applyModel and poll. The choice is kept by the preference store when the server has one; without it
     (any non-2xx, or a failed call) the in-page state stands. */
  var cleanOn = false, cleanT = 0, FADE_MS = 200;
  function bodyCls(c, on) { document.body.classList[on ? 'add' : 'remove'](c); }
  function paintClean() { bodyCls('cout', false); bodyCls('cin', false); clearTimeout(cleanT); bodyCls('clean', cleanOn); if (cleanOn) hvClear(); $('cleanbtn').setAttribute('aria-pressed', String(cleanOn)); }
  /* The fade: going clean, the notes, leaders and boxes fade out (cout) while still laid out, and the clean class lands when the fade ends. Coming back, the class
     goes first, the leaders are drawn again at the restored geometry (the panes were wider while clean), and everything fades in (cin). */
  function setClean(on) {
    cleanOn = on;
    if (!canAnimate()) { paintClean(); if (!on && curItems) layout(curItems); return; }
    clearTimeout(cleanT); $('cleanbtn').setAttribute('aria-pressed', String(on)); bodyCls('cout', false); bodyCls('cin', false);
    if (on) { bodyCls('cout', true); cleanT = setTimeout(function () { if (!cleanOn) return; bodyCls('cout', false); bodyCls('clean', true); }, FADE_MS); return; }
    /* a glide left on the notes or the leaders by the last render would play again when they come back and make the fade in stumble */
    ['notes', 'svg'].forEach(function (id) { var n = $(id); if (n && n.classList) n.classList.remove('glide'); });
    bodyCls('clean', false); if (curItems) layout(curItems); bodyCls('cin', true);
    cleanT = setTimeout(function () { if (!cleanOn) bodyCls('cin', false); }, FADE_MS + 160);
  }
  $('cleanbtn').addEventListener('click', function () {
    setClean(!cleanOn);
    try { fetch(withToken('/timeline/' + task + '/review/preferences'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clean: cleanOn }) }).catch(function () {}); } catch (e) {}
  });
  try { fetch(withToken('/timeline/' + task + '/review/preferences')).then(function (r) { return r && r.ok ? r.json() : null; }).then(function (j) { if (j && typeof j.clean === 'boolean') { cleanOn = j.clean; paintClean(); } }).catch(function () {}); } catch (e) {}

  /* ---------- Details ----------
     Every quiet note of the run (who drew a picture, the tally, a change the picture could not mark, the view's limits) in one panel opened
     from the bar, grouped by step and deduplicated; none of them sits in the page flow. Notes belong to file steps only: they come from a file step's view or its
     model row, so a message, a brief or a call header has none. A step's notes are judged from its view when it is fetched, and replaced by what the page really
     drew when the step is drawn. Opening the panel reads the file steps not read yet, one at a time. Genuine file problems stay inline as warnings. */
  var DET = { byStep: {}, exact: {}, open: false, ctl: null };
  function detStopOfKey(key) { for (var i = 0; i < STOPS.length; i++) if (STOPS[i].change && STOPS[i].change.key === key) return STOPS[i]; return null; }
  function detRecord(stepId, notes, exact) {
    if (!stepId || (!exact && DET.exact[stepId])) return;
    DET.byStep[stepId] = notes || []; if (exact) DET.exact[stepId] = true;
    paintDetails();
  }
  /* a fetched view, before its step is drawn (a whole-file view of the Files view is not a step's view) */
  function detFromView(rc, view) { if (!rc || /#whole-/.test(String(rc.key))) return; var s = detStopOfKey(rc.key); if (s) detRecord(s.id, VT.stepNotes(view), false); }
  /* the file steps on show whose view is still to read */
  /* the Details panel and its count speak only of what is on screen: the file step on show, or a call header's own files; a request, a message, an opened
     commands view or the Files view has none */
  function detScope() {
    if (QV || mode === 'files') return [];
    var s = STOPS[cur]; if (!s) return [];
    if (s.hdr) return STOPS.filter(function (x) { return x.under === s.id && !!x.change; });
    return s.change ? [s] : [];
  }
  function detUnread() { return detScope().filter(function (s) { var c = s.change; return c && !c.secret && c.viewUrl && !DET.byStep[s.id]; }); }
  function detPerStep() {
    return detScope().map(function (s) {
      var n = (DET.byStep[s.id] || []).slice();
      if (s.change.secret) n.push({ kind: 'caveat', src: 'cocheck', text: 'Its contents are never shown.' });
      return { step: s.id, notes: n };
    });
  }
  /* a step as the log names it: its place on the rail and its heading */
  function detStepName(id) { var i = stopIndex(id), s = STOPS[i]; return s ? '#' + (i + 1) + ' ' + String(s.title === undefined ? (s.head || s.label || '') : s.title) : id; }
  function detLine(e) { return e.steps.map(detStepName).join(', ') + '  [' + e.src + ']  ' + e.text; }
  function paintDetails() {
    var r = VT.groupNotes(detPerStep()), c = $('pbdcount'), b = $('pbdetails');
    if (c) { c.textContent = String(r.count); c.hidden = r.count === 0; }
    if (b) b.setAttribute('aria-label', r.count ? 'Details, ' + r.count + (r.count === 1 ? ' note' : ' notes') : 'Details');
    DET.last = r;
    if (DET.open) paintDetailsPanel(r);
  }
  function detGo(id) { setDetails(false, false); jump(id); }
  /* the raw log: one line per note, in step order, verbatim; its steps lead the line and each is a jump link */
  function paintDetailsPanel(r) {
    var box = $('detlist'); if (!box) return;
    box.textContent = '';
    var left = detUnread().length;
    if (left) box.append(el('div', { class: 'detwait' }, loading('Reading ' + left + (left === 1 ? ' more step' : ' more steps'))));
    if (!r.count && !left) { var gi = $('detissues'); if (!gi || gi.hidden) box.append(el('p', { class: 'detnone' }, 'Nothing logged.')); return; }
    var ol = el('ol', { class: 'detlog' });
    r.entries.forEach(function (e) {
      var steps = el('span', { class: 'detsteps' });
      e.steps.forEach(function (id, k) { if (k) steps.append(', '); steps.append(el('button', { type: 'button', class: 'detstep', 'data-step': id, onclick: function () { detGo(id); } }, detStepName(id))); });
      ol.append(el('li', { class: 'detline', 'data-kind': e.kind }, steps, el('span', { class: 'detsrc' }, '[' + e.src + ']'), el('span', { class: 'dettext' }, e.text)));
    });
    box.append(ol);
  }
  /* Copy all: the whole log as plain text, one line per note */
  function copyDetails() {
    var b = $('detcopy'), t = ((DET.last && DET.last.entries) || []).map(detLine).join('\n');
    var done = function () { if (b) b.textContent = 'Copied'; }, fail = function () { if (b) b.textContent = 'Could not copy'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, fail); else fail();
  }
  /* reads the unread file steps' views one at a time, low priority; closing the panel stops it */
  function detReadAll() {
    if (DET.ctl) return;
    var Ctl = typeof AbortController === 'undefined' ? null : AbortController, ctl = DET.ctl = Ctl ? new Ctl() : { signal: { aborted: false }, abort: function () { this.signal.aborted = true; } };
    (function next() {
      if (ctl.signal.aborted) return;
      var s = detUnread()[0];
      if (!s) { DET.ctl = null; paintDetails(); return; }
      fetchViewNow(s.change, ctl.signal, true).then(function (v) { if (!DET.byStep[s.id]) detRecord(s.id, VT.stepNotes(v), false); next(); }, function () { if (!ctl.signal.aborted) { detRecord(s.id, [], false); next(); } });
    })();
  }
  function setDetails(open, refocus) {
    var p = $('detpanel'), b = $('pbdetails'); if (!p || !b) return;
    DET.open = open; p.hidden = !open; b.setAttribute('aria-expanded', String(open));
    if (open) { if (MENU) setMenu(false, false); var cb = $('detcopy'); if (cb) cb.textContent = 'Copy all'; paintDetails(); detReadAll(); if (p.focus) p.focus(); }
    else { if (DET.ctl) { DET.ctl.abort(); DET.ctl = null; } if (refocus && b.focus) b.focus(); }
  }
  $('pbdetails').addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); setDetails(!DET.open, false); });
  { var dc = $('detclose'); if (dc) dc.addEventListener('click', function () { setDetails(false, true); }); var dk = $('detcopy'); if (dk) dk.addEventListener('click', copyDetails); }
  /* the header's issues pill opens Details at its Issues group (a native button: Enter and Space too) */
  { var hp = $('hissues'); if (hp) hp.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (!DET.open) setDetails(true, false);
    var g = $('detissues'); if (g && !g.hidden) { if (g.scrollIntoView) g.scrollIntoView({ block: 'nearest' }); if (g.focus) g.focus(); }
  }); }
  function inDetails(t) { for (; t; t = t.parentNode) { var id = t.getAttribute && t.getAttribute('id'); if (id === 'detpanel' || id === 'pbdetails' || id === 'hissues') return true; } return false; }
  addEventListener('click', function (e) { if (DET.open && !inDetails(e && e.target)) setDetails(false, false); });
  window.CoCheckDetails = { entries: function () { return VT.groupNotes(detPerStep()).entries; }, lines: function () { return VT.groupNotes(detPerStep()).entries.map(detLine); }, open: function () { setDetails(true, false); }, close: function () { setDetails(false, false); } };

  /* The settings menu: one icon in the bar opens a small menu of toggles, upward. It is a disclosure, not a dialog: no focus trap, Escape and a click outside close it,
     and every shortcut key keeps working with it open. More options are one more .setopt button in #setmenu. */
  var MENU = false;
  function menuOpen() { return MENU; }
  function setMenu(open, refocus) {
    var m = $('setmenu'), b = $('setbtn'); if (!m || !b) return;
    MENU = open; m.hidden = !open; b.setAttribute('aria-expanded', String(open));
    if (!open && refocus && b.focus) b.focus();
  }
  $('setbtn').addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); setMenu(!menuOpen(), false); });
  var SETIDS = { setwrap: 1, setbtn: 1, setmenu: 1, railorder: 1, cleanbtn: 1, quietbtn: 1, themelight: 1, themedark: 1, themeauto: 1 };
  function inSettings(t) { for (; t; t = t.parentNode) { var id = t.getAttribute && t.getAttribute('id'); if (id && SETIDS[id]) return true; } return false; }
  addEventListener('click', function (e) { if (menuOpen() && !inSettings(e && e.target)) setMenu(false, false); });
  { var ob = $('railorder'); if (ob) ob.addEventListener('click', function () { setOrder(!NEWEST); }); }
  { var qb = $('quietbtn'); if (qb) qb.addEventListener('click', function () { setShowQuiet(!SHOWQUIET); }); }
  ['light', 'dark', 'auto'].forEach(function (t) { var tb = $('theme' + t); if (tb) tb.addEventListener('click', function () { setTheme(t); }); });
  paintTheme(); paintQuietOpt();
  $('vfiles').addEventListener('click', function () { if (mode !== 'files') setMode('files'); });

  /* ---------- boot ---------- */
  /* In a field that takes typing, every key is the field's own: the shortcuts below never run and never swallow the key */
  function typing(t) { var g = t && t.tagName; return g === 'TEXTAREA' || g === 'INPUT' || g === 'SELECT' || !!(t && t.isContentEditable); }
  addEventListener('keydown', function (e) {
    if (typing(e.target)) return;
    if (zoomKeyed(e)) { e.preventDefault(); return; }
    if (e.key === 'Escape' && menuOpen()) { setMenu(false, true); e.preventDefault(); return; }
    if (e.key === 'Escape' && DET.open) { setDetails(false, true); e.preventDefault(); return; }
    if (e.key === 'Escape' && RAILOPEN) { setRail(false, true); e.preventDefault(); return; }
    var onTab = e.target && e.target.classList && e.target.classList.contains('tab');
    if (onTab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { stepSheet(e.key === 'ArrowRight' ? 1 : -1, e.target.parentNode && e.target.parentNode.id === 'ta' ? 'after' : 'before'); e.preventDefault(); return; }
    if (e.key === ']' || e.key === '[') { if (stepSheet(e.key === ']' ? 1 : -1, null)) e.preventDefault(); return; }
    /* The verdict keys work in both views (the bar judges the step on show). P passes and moves on, F opens the fail note, U undoes the last verdict while its bar
       shows (else it clears the verdict of the step on show), Escape closes the open fail note, Cmd/Ctrl+Enter saves it (else takes the bar's sign-off or send-back). */
    var k = typeof e.key === 'string' && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey ? e.key.toLowerCase() : '';
    if (e.key === 'Escape' && !$('pcomp').hidden && failFor) { cancelFail(); e.preventDefault(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      if (!$('pcomp').hidden && failFor) saveFail(); else if (!$('pbact').hidden && !$('pbact').disabled) $('pbact').click(); else return;
      e.preventDefault(); return;
    }
    if (k === 'p' && REVOK && verdictStop()) { if (holdsAll('passed')) moveOn(cur); else setVerdict('passed', '', true); e.preventDefault(); return; }
    if (k === 'f' && REVOK && verdictStop()) { startFail(); e.preventDefault(); return; }
    /* Change stepping: N next, B back (P is the verdict Pass). Not in the Files view, not with a fail or note box open (the Point tool), not while typing (returned above). */
    if ((k === 'n' || k === 'b') && mode !== 'files' && !QV && !regionCtx() && stepChange(k === 'n' ? 1 : -1)) { e.preventDefault(); return; }
    if (k === 'u' && !QV && (LAST || canClear())) { if (LAST) undo(); else setVerdict('not_reviewed', '', false); e.preventDefault(); return; }
    /* In the Files view the arrows walk the versions of the file on show; the step shortcuts belong to the Steps view */
    if (mode === 'files' && e.key === 'Escape' && ftrail.length) { FH.back(ftrail.length - 1); e.preventDefault(); return; }
    /* The strip reads left to right in time (Now on the right): Right/Down goes forward (p + 1), Left/Up back (p - 1) */
    if (mode === 'files') { var d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0; if (d) { FH.go(fcur.p + d); e.preventDefault(); } return; }
    if (onTab && e.key === ' ') return;
    /* With a call header current, Right opens it and Left closes it; Left on a file under a header closes that header and lands on it */
    var cs = QV ? null : STOPS[cur];
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && cs && cs.hdr) { if (isOpen(cs) !== (e.key === 'ArrowRight')) toggleHdr(cur, e.key === 'ArrowRight'); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft' && cs && cs.under && stopIndex(cs.under) >= 0) { toggleHdr(stopIndex(cs.under), false); e.preventDefault(); return; }
    /* Up and Down walk the screen: newest-first, Up is the next stop in time. Left, Right, Back and Forward keep time order. */
    /* Home and End, with focus in the rail, go to its first and last row on screen */
    if ((e.key === 'Home' || e.key === 'End') && e.target && e.target.parentNode === $('tl') && VIS.length) { var far = (e.key === 'Home') !== NEWEST ? VIS[0] : VIS[VIS.length - 1]; if (far !== cur) { go(far); } e.preventDefault(); return; }
    if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { step(NEWEST ? -1 : 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { step(NEWEST ? 1 : -1); e.preventDefault(); }
  });
  { var rtg = $('railtoggle'); if (rtg) rtg.addEventListener('click', function () { setRail(!RAILOPEN, false); }); }
  addEventListener('click', function (e) { if (RAILOPEN && !inRail(e && e.target)) setRail(false, false); });
  addEventListener('resize', function () { if (RAILOPEN && !railNarrow()) setRail(false, false); });
  /* A resize never rebuilds the panes: one layout per frame, and a full draw only when the width crosses the 1180 px flow switch */
  var wideNow = innerWidth > 1180, resizeRaf = 0;
  addEventListener('resize', function () {
    if (!M || resizeRaf) return;
    resizeRaf = requestAnimationFrame(function () {
      resizeRaf = 0;
      var w = innerWidth > 1180;
      if (w !== wideNow) { wideNow = w; instant = true; render(); return; }
      if (curItems && curItems.length) layout(curItems); else refreshClamps();
    });
  });
  /* The rail has nothing to show for this task (the timeline could not be loaded): say so in plain words and hide the empty controls and panes. */
  function noRail(why, err) {
    clearInterval(ticker);
    if (err) console.error('CoCheck: could not load the timeline for this task:', err);
    $('h1').textContent = 'Nothing to show for this task yet.';
    $('h2').textContent = why;
    $('stage').hidden = true;
  }
  /* Until the model arrives the heading is the loading widget, with the seconds so far beside it (not read out each second) */
  var t0 = Date.now(), secs = el('span', { class: 'iload-s', 'aria-hidden': 'true' }), tick = function () { secs.textContent = Math.floor((Date.now() - t0) / 1000) + ' s'; };
  $('h1').textContent = ''; $('h1').append(loading('Reading the work'), secs);
  tick(); var ticker = setInterval(tick, 1000);
  /* The page follows a task whose agent is still working. The model carries `live`; while it is true the page asks again about every 1 s,
     with the ETag of the answer it holds (a 304 changes nothing and draws nothing). When `live` turns false it goes on asking every 3 s, so the next turn
     of an open page appears without a reload; only 30 failures in a row stop it for good. A hidden tab
     asks nothing and asks once when it shows again. A new answer is merged in place: the step on show, the file and version on show, the view
     and every scroll position stay, and a pane is drawn again only when what it shows changed. */
  var LIVE = { on: false, etag: null, timer: null, busy: false, fails: 0, quiet: 0, dead: false, armed: false }, POLL_MS = 1000, SLOW_POLL_MS = 3000, MAX_FAILS = 30, booted = false;
  function tabHidden() { return typeof document !== 'undefined' && (document.hidden === true || document.visibilityState === 'hidden'); }
  function etagOf(r) { return r && r.headers && typeof r.headers.get === 'function' ? r.headers.get('etag') : null; }
  function paintLive() { var b = $('livebanner'); if (b) { b.hidden = !LIVE.on; b.textContent = 'Agent still working' + (LIVE.quiet ? ' (quiet for ' + LIVE.quiet + ' min)' : ''); } if (FV && FV.setLive) FV.setLive(LIVE.on); }
  function clearPoll() { if (LIVE.timer !== null) clearTimeout(LIVE.timer); LIVE.timer = null; }
  function schedulePoll() {
    clearPoll(); LIVE.armed = true;
    if (LIVE.dead || tabHidden() || typeof setTimeout !== 'function') return;
    LIVE.timer = setTimeout(poll, LIVE.on && !LIVE.quiet ? POLL_MS : SLOW_POLL_MS);
    if (LIVE.timer && typeof LIVE.timer.unref === 'function') LIVE.timer.unref(); /* a test runner under Node may exit with the page open; a browser timer is a number */
  }
  function stopLive() { LIVE.on = false; LIVE.dead = true; LIVE.quiet = 0; clearPoll(); paintLive(); if (!booted && LIVE.fails >= MAX_FAILS) noRail("CoCheck lost touch with this task. Reload the page to try again."); }
  function poll() {
    LIVE.timer = null;
    if (LIVE.dead || tabHidden() || LIVE.busy) return;
    LIVE.busy = true;
    var init = { headers: { accept: 'application/json' } }; if (LIVE.etag) init.headers['if-none-match'] = LIVE.etag;
    fetch(withToken('/timeline/' + task + '/review/model'), init).then(function (r) {
      if (r.status === 304) return null;
      if (!r.ok) throw new Error('model ' + r.status);
      var tag = etagOf(r); return r.json().then(function (m) { return { m: m, tag: tag }; });
    }).then(function (x) { LIVE.fails = 0; if (x) { LIVE.etag = x.tag; applyModel(x.m); } }, function () { if (++LIVE.fails >= MAX_FAILS) stopLive(); })
      .then(function () { LIVE.busy = false; schedulePoll(); });
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', function () { clearPoll(); if (!tabHidden() && LIVE.armed && !LIVE.dead) poll(); });
  function fileKey(f) { return f ? f.ref || f.file : null; }
  function fileIndex(key, fallback) { for (var i = 0; i < FILES.length; i++) if (fileKey(FILES[i]) === key) return i; return Math.max(0, Math.min(fallback, FILES.length - 1)); }
  var SCROLLERS = ['scroller', 'listcol', 'fileslist', 'strip', 'stage', 'below', 'bodyview', 'hdrbody', 'hdrview', 'reqview', 'filesview', 'head'];
  function scrollsNow() {
    railKept = false;
    var out = { y: window.pageYOffset || 0, x: window.pageXOffset || 0, el: {} };
    SCROLLERS.forEach(function (id) { var e = $(id); if (e && (e.scrollTop || e.scrollLeft)) out.el[id] = [e.scrollTop, e.scrollLeft]; });
    return out;
  }
  function scrollsBack(sc) {
    SCROLLERS.forEach(function (id) { var e = $(id), v = sc.el[id]; if (id === 'scroller' && NEWEST && railKept) return; if (e && v) { e.scrollTop = v[0]; e.scrollLeft = v[1]; } });
    if ((window.pageYOffset || 0) !== sc.y && typeof window.scrollTo === 'function') window.scrollTo(sc.x, sc.y);
  }
  /* The home page's shortenRequest (src/home-page.ts), for the task name in the toolbar */
  function shortRequest(text, max) {
    max = max || 64;
    var line = String(text).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l !== ''; })[0] || '';
    var one = line.replace(/\s+/g, ' '), chars = Array.from(one);
    if (chars.length <= max) return one;
    var head = chars.slice(0, max).join(''), at = head.lastIndexOf(' ');
    return (at > max / 2 ? head.slice(0, at) : head).replace(/[ ,;:.-]+$/, '') + '\u2026';
  }
  /* what an answer sets, shared by the first paint and every later merge */
  function adopt(m) {
    M = m; STOPS = withHeaders(m.stops); ACTORS = m.actors; N = STOPS.length;
    paintDetails();
    /* only actors that appear on the railroad get a lane */
    ACTORS = ACTORS.filter(function (a) { return STOPS.some(function (s) { return s.lane === a.id; }); });
    $('subh').textContent = m.folder || '';
    /* the task in words: the first request, shortened as the home page shortens it (first line, cut at a word near 64 characters).
       With no request words on record the heading keeps "Task N". */
    var firstReq = (m.stops || []).filter(function (s) { return s.request && !s.request.missing && String(s.request.text || '').trim(); })[0];
    if (firstReq) { $('taskname').textContent = shortRequest(firstReq.request.text); $('taskname').title = String(firstReq.request.text); }
    FILES = FV && Array.isArray(m.files) ? m.files.filter(function (f) { return f.versions && (f.versions.length || f.source); }) : [];
    var outsideN = FILES.filter(function (f) { return f.outside; }).length; if (outsideN !== outsideSeen) { outsideSeen = outsideN; outsideAsked = false; }
    var CHANGED = FILES.filter(function (f) { return !f.source; }).length;
    /* with steps but no changed file the switcher stays, so the page does not look broken; Deliverables is off and a plain line says why. Clean diff has nothing to act on, so it stays hidden. */
    $('viewswitch').hidden = false; $('vfiles').disabled = !CHANGED; $('nofiles').hidden = !!CHANGED; $('cleanbtn').hidden = !CHANGED; HASVIEWS = !!CHANGED;
    return CHANGED;
  }
  /* What decides a redraw of the step on show */
  function sigOfStop(s) { return s ? JSON.stringify(s) : ''; }
  function applyModel(m) {
    if (!m || !m.stops || m.stops.length === 0) { if (m && !m.live && !booted) { stopLive(); noRail('No steps were recorded for this task.'); } return; }
    if (!booted) return startPage(m);
    var wasLive = LIVE.on, sc = scrollsNow(), busyTyping = typing(document.activeElement);
    pollMotion = true; liveFrom = null;
    try { applyLive(m, wasLive, sc, busyTyping); } finally { pollMotion = false; }
    liveAfter();
  }
  function applyLive(m, wasLive, sc, busyTyping) {
    var oldStop = STOPS[cur], oldSig = sigOfStop(oldStop), oldId = oldStop && oldStop.id;
    var oldFile = FILES[fcur.f], fKey = fileKey(oldFile), atNow = !!(oldFile && !oldFile.source && fcur.p === oldFile.versions.length + 1);
    var trailKeys = ftrail.map(function (t) { return { k: fileKey(FILES[t.f]), p: t.p }; });
    adopt(m);
    LIVE.on = !!m.live; LIVE.quiet = m.live && m.quietMin ? m.quietMin : 0; paintLive();
    computeVis();
    /* the step on show stays by id; if it is gone the nearest visible one takes its place */
    var at = stopIndex(oldId), moved = at < 0;
    /* A header formed around the step on show by this poll opens, so the step stays in view (in Deliverables the Timeline picks the header at the switch) */
    if (at >= 0 && mode === 'steps' && !isVis(at) && laneShown(STOPS[at])) { revealStep(at); computeVis(); }
    cur = at >= 0 ? at : nearestVis(cur);
    var renderNow = false;
    if (mode === 'files' && FILES.some(function (f) { return !f.source; })) {
      var fi = fileIndex(fKey, fcur.f), f = FILES[fi], p = fcur.p;
      if (f.source) p = 0; else if (atNow) p = f.versions.length + 1; else p = FV.clamp(f, p);
      fcur = { f: fi, p: p };
      ftrail = trailKeys.map(function (t) { return { f: fileIndex(t.k, 0), p: t.p }; });
      if (!f.source) {
        var vi = stopIndex(FV.versionAt(f, p).stop);
        if (vi >= 0 && (vi !== at || sigOfStop(STOPS[vi]) !== oldSig)) { cur = vi; renderNow = true; }
      }
    } else {
      if (mode === 'files') mode = 'steps';
      if (!QV && (moved || sigOfStop(STOPS[cur]) !== oldSig)) renderNow = true;
    }
    if (busyTyping) renderNow = false; /* a note being typed is never wiped by a redraw; the pane catches up at the next change */
    railSig = '';
    if (mode === 'files') {
      var g = FILES[fcur.f];
      FV.paintList($('fileslist'), FILES, fcur.f, FH);
      if (!g.source) { FV.paintStrip($('strip'), g, fcur.p, FH); FV.paintBuilt($('fvbuilt'), FILES, g, fcur.p, FH); FV.paintStale($('fvwarn'), FILES, g, fcur.p, FH); }
      FV.paintHead($('fvname'), $('fvorder'), g, g.source ? 0 : fcur.p, FH); FV.paintCrumbs($('fvcrumbs'), ftrail, FILES, FH);
      if (renderNow) { QV = null; instant = true; render(); }
      /* the rail is not on screen in this view; it is drawn when the person comes back to it */
    } else if (renderNow) { instant = true; render(); }
    else {
      syncRail(false);
    }
    scrollsBack(sc);
    loadStatus();
  }
  /* the first paint of the page, from the first model that has steps */
  function startPage(m) {
    clearInterval(ticker); booted = true;
    var CHANGED = adopt(m);
    LIVE.on = !!m.live; LIVE.quiet = m.live && m.quietMin ? m.quietMin : 0; paintLive();
    var fh = FILES.length ? /^#v=files(?:&f=([^&]*)(?:&p=(\d+))?)?$/.exec(location.hash) : null;
    computeVis();
    /* a #n in the URL wins; otherwise the page opens on the first request, at the very top */
    var h = parseInt(location.hash.slice(1), 10), stepHash = isFinite(h) && h >= 0 && h < N && (isVis(h) || (laneShown(STOPS[h]) && !!headerOf(STOPS[h])));
    if (stepHash) { revealStep(h); computeVis(); }
    hashed = !!fh || stepHash;
    cur = hashed && !fh ? h : openingStep(); bootAt = cur;
    buildRail(); instant = true; paintOrder();
    /* With no hash, a task with deliverables lands on Deliverables (its first changed file, at Now). #v=timeline (or #v=steps) or a #n opens the Timeline. */
    var landFiles = !fh && CHANGED && !stepHash && !/^#v=(?:timeline|steps)$/.test(location.hash);
    if (fh || landFiles) {
      var fk = fh && fh[1] !== undefined ? unkey(fh[1]) : '', fi = fh ? Math.max(0, FILES.findIndex(function (x) { return (x.ref || x.file) === fk; })) : FILES.findIndex(function (x) { return !x.source; });
      var fp = fh && fh[2] !== undefined ? +fh[2] : undefined;
      fcur = { f: fi, p: fp === undefined ? (FILES[fi].source ? 0 : FILES[fi].versions.length + 1) : fp }; /* No &p opens at Now, the final product; an explicit &p wins */
      setMode('files', true);
    } else { $('vsteps').setAttribute('aria-pressed', 'true'); $('vfiles').setAttribute('aria-pressed', 'false'); render(); } /* The shell presses Deliverables; booting on the Timeline says so */
    loadStatus();
    if (document.fonts) document.fonts.ready.then(function () { instant = true; render(); });
    schedulePoll();
  }
  /* The stored order is asked for beside the model and never waited on (a slow answer must not hold the first paint); it is applied the moment it lands */
  var modelP = fetch(withToken('/timeline/' + task + '/review/model')).then(function (r) { if (!r.ok) throw new Error('model ' + r.status); LIVE.etag = etagOf(r); return r.json(); });
  loadPrefs();
  modelP.then(function (m) {
    if (!m || !m.stops || m.stops.length === 0) {
      /* a task whose agent has not made its first step yet: say so and keep asking while it is live */
      if (m && m.live) { LIVE.on = true; LIVE.quiet = m.quietMin || 0; paintLive(); $('h1').textContent = ''; $('h1').append(loading('Waiting for the first step')); clearInterval(ticker); schedulePoll(); return; }
      return noRail('No steps were recorded for this task.');
    }
    startPage(m);
  }).catch(function (e) { noRail("CoCheck couldn't load this task's timeline.", e); });
})();
