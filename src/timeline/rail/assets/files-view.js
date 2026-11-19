/* The Files view of the review page. A file the task changed, its versions in time order, the strip of them. Drawn from the model's
   `files` list (src/timeline/rail/model.ts); the page script (review.js) owns the data, the selection and the per-change view, and passes in
   the few things this file needs (`h`). No innerHTML: every text goes in through textContent. The pure half is tested in node. */
(function (root) {
  'use strict';

  /* a strip has the positions Before task (0), v1..vN (1..N) and Now (N+1); Before task and Now show the file's first and last change */
  function clamp(file, p) { var n = file.versions.length; return Math.max(0, Math.min(n + 1, p)); }
  /* A file with a twin of the same name in another folder is named with its folder */
  function labelOf(file) { return file.where ? file.name + ' (' + file.where + ')' : file.name; }
  /* Before task and Now are one pane each: which side of the edge change to draw, or the sentence to show when there is nothing to draw. Null for a version, and for a secret file. */
  function soloOf(file, p) {
    var n = file.versions.length;
    /* A source (read, never changed) has the one position, Before task; its bytes are not kept */
    if (file.source) return { side: 'before', say: 'Content not kept.' };
    if (p !== 0 && p !== n + 1) return null;
    var last = file.versions[n - 1];
    if (file.versions[0].secret) return null;
    if (p === 0) return { side: 'before', say: file.start === 'none' ? 'This file did not exist before the task.' : file.start === 'lost' ? 'Content not kept.' : '' };
    return { side: 'after', say: last.kind === 'deleted' ? 'This file is gone now.' : !last.kept ? 'Content not kept.' : '' };
  }
  function versionAt(file, p) { var n = file.versions.length; return file.versions[Math.min(Math.max(p, 1), n) - 1]; }
  /* While the agent is still working the last position is "So far", never "Now": the final product is not known until the work stops */
  var working = false;
  function setLive(on) { working = !!on; }
  function nameOf(p, n) { return p === 0 ? 'Before task' : p === n + 1 ? (working ? 'So far' : 'Now') : 'v' + p; }
  function timeText(at) {
    if (typeof at !== 'number' || !isFinite(at)) return '';
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  /* a connector's subject is not a file: no file-type icon, the subject shown whole */
  function glyphOf(f, h) { return f.connector ? h.el('i', { class: 'glyph connector', 'aria-hidden': 'true' }) : h.el('i', { class: /\.(csv|tsv)$/i.test(f.name || '') ? 'glyph csv' : 'glyph' }); }
  /* the one line under the strip's selected position that says what the position is */
  function describe(file, p, who) {
    var n = file.versions.length, v = versionAt(file, p);
    if (file.source) return 'Not changed by the task: the file as the task found it.';
    if (p === 0) return file.versions[0].kind === 'created' ? 'The file did not exist before the task.' : 'The file as the task found it.';
    if (p === n + 1) return 'The file as it is now, after v' + n + '.';
    return nameOf(p, n) + ' of ' + n + ': ' + v.label.toLowerCase() + ' by ' + who(v.lane) + (timeText(v.at) ? ', ' + timeText(v.at) : '') + '.';
  }
  /* a version whose bytes CoCheck does not hold says so; a secret file's content is never shown, so it never says this */
  function notKept(v) { return !v.kept && !v.secret; }

  /* Per-group open state, kept across repaints (verdicts arrive after the first paint) */
  var groupOpen = {};
  /* A reusable collapsed group: a <details class="outgrp"> with a summary; open when the person opened it before or the selected file is inside */
  function makeGroup(h, name, title) {
    var g = h.el('details', { class: 'outgrp', 'data-group': name }, h.el('summary', { class: 'grp' }, title));
    g.open = !!groupOpen[name];
    g.addEventListener && g.addEventListener('toggle', function () { groupOpen[name] = g.open; });
    return g;
  }
  /* A file opens at Now, the final product (position N+1) */
  function nowOf(f) { return f.versions.length + 1; }
  /* The review bar's verdict on the file's latest version (the one judged), as a small tick or cross on its card; nothing when it has none */
  function markEl(m, h) {
    return m === 'passed' || m === 'failed' ? h.el('span', { class: 'jm ' + (m === 'passed' ? 'pass' : 'fail'), role: 'img', title: m === 'passed' ? 'Passed' : 'Failed', 'aria-label': m === 'passed' ? 'Passed' : 'Failed' }, m === 'passed' ? '\u2713' : '\u2717') : '';
  }
  /* the same tick or cross on a strip step, for the step that made that version; nothing when its step has no verdict */
  function versionMark(v, h) { return markEl(v && h.markOfVersion ? h.markOfVersion(v) : null, h); }
  /* The one status glyph on a file row: not reviewed is an open circle, passed a green check, failed a red cross */
  function statusMark(f, h) {
    var m = h.markOf ? h.markOf(f) : null;
    if (m === 'passed' || m === 'failed') return markEl(m, h);
    return h.el('span', { class: 'jm open', role: 'img', title: 'Not reviewed', 'aria-label': 'Not reviewed' }, '\u25CB');
  }
  /* h: { el, chip(lane) -> node, name(lane) -> text, color(lane) -> css color, pick(fileIndex, p) } */
  function paintList(box, files, sel, h) {
    box.textContent = '';
    box.append(h.el('div', { class: 'grp' }, 'Files this task changed'));
    var idx = files.map(function (_, i) { return i; });
    var mainIdx = idx.filter(function (i) { return !files[i].outside && !files[i].source && !files[i].working; });
    var workIdx = idx.filter(function (i) { return !files[i].outside && !files[i].source && files[i].working; });
    var srcIdx = idx.filter(function (i) { return !files[i].outside && files[i].source; });
    var outIdx = idx.filter(function (i) { return files[i].outside; });
    function row(i) {
      var f = files[i];
      /* Files the task read and never changed, each a read-only entry */
      if (f.source) {
        return h.el('button', { type: 'button', class: 'fi src', 'data-file': String(i), 'aria-current': String(i === sel), onclick: function () { h.pick(i, 0); } },
          h.el('span', { class: 'r1' }, glyphOf(f, h), h.el('span', { class: 'nm', title: f.file }, f.name), f.where ? h.el('span', { class: 'wh' }, f.where) : '', h.el('span', { class: 'vv' }, 'read only')));
      }
      /* Only the latest version is judged; unknown (could not tell what the script read) is its own mark, never shown as clean or as stale */
      var last = f.versions[f.versions.length - 1];
      var stale = !!(last.stale && last.stale.length), unknown = !stale && !!last.unknownReads;
      /* icon, name, one status glyph; a file whose bytes equal another's says so in a tooltip on the row */
      var attrs = { type: 'button', class: 'fi' + (stale ? ' st' : unknown ? ' un' : ''), 'data-file': String(i), 'aria-current': String(i === sel), onclick: function () { h.pick(i, nowOf(f)); } };
      if (f.sameAs) attrs.title = identicalTip(f.sameAs);
      return h.el('button', attrs,
        h.el('span', { class: 'r1' }, glyphOf(f, h), h.el('span', { class: 'nm', title: f.file }, f.name), f.where ? h.el('span', { class: 'wh' }, f.where) : '', last.kind === 'deleted' ? h.el('span', { class: 'delmark' }, 'deleted') : '', stale ? h.el('span', { class: 'stdot', title: 'A version was built from an input that changed afterwards' }) : unknown ? h.el('span', { class: 'undot', title: "CoCheck couldn't tell everything the script behind the latest version read" }) : '', statusMark(f, h)));
    }
    mainIdx.forEach(function (i) { box.append(row(i)); });
    srcIdx.forEach(function (i, n) {
      if (n === 0) box.append(h.el('div', { class: 'grp' }, 'Files this task read, unchanged'));
      box.append(row(i));
    });
    /* Build and scratch files made during the task (dot-folders): collapsed, open when the selected file is inside */
    if (workIdx.length) {
      var workBox = makeGroup(h, 'working', 'Working files');
      if (workIdx.indexOf(sel) >= 0) workBox.open = true;
      workIdx.forEach(function (i) { workBox.append(row(i)); });
      box.append(workBox);
    }
    /* Scratch outside the folder (nothing the person typed asked for it): a collapsed group at the end, never in the main list */
    if (outIdx.length) {
      var outsideBox = makeGroup(h, 'outside', 'Outside the folder');
      if (outIdx.indexOf(sel) >= 0) outsideBox.open = true;
      outIdx.forEach(function (i) {
        var f = files[i];
        /* The real directory comes from its own route, asked when the group opens; it is never in the model */
        var dirs = h.outsideDirs ? h.outsideDirs() : null, mine = dirs && f.ref && Array.isArray(dirs[f.ref]) ? dirs[f.ref] : [];
        outsideBox.append(h.el('button', { type: 'button', class: 'fi out', 'data-file': String(i), 'aria-current': String(i === sel), onclick: function () { h.pick(i, nowOf(f)); } },
          h.el('span', { class: 'r1' }, glyphOf(f, h), h.el('span', { class: 'nm', title: f.file }, f.name), h.el('span', { class: 'wh' }, 'outside the folder'), f.versions[f.versions.length - 1].kind === 'deleted' ? h.el('span', { class: 'delmark' }, 'deleted') : '', h.el('span', { class: 'vv' }, f.versions.length + (f.versions.length === 1 ? ' version' : ' versions'))),
          mine.map(function (d) { return h.el('div', { class: 'od', title: d }, d); })));
      });
      box.append(outsideBox);
      if (h.loadOutside) { if (outsideBox.open) h.loadOutside(); outsideBox.addEventListener('toggle', function () { if (outsideBox.open) h.loadOutside(); }); }
    }
  }

  function paintStrip(box, file, p, h) {
    var n = file.versions.length, cn = null;
    box.textContent = '';
    /* The strip reads left to right in time: Before task, v1..vN, Now. Positions (data-p, FILES) are the same numbers as the paint order. */
    for (var q = 0; q <= n + 1; q++) (function (q) {
      var edge = q === 0 || q === n + 1, v = edge ? null : file.versions[q - 1];
      var top = h.el('div', { class: 'top' }, h.el('b', {}, edge ? nameOf(q, n) : timeText(v.at) || nameOf(q, n)), v && v.stale && v.stale.length ? h.el('span', { class: 'stl', title: 'Built from an input that changed afterwards' }, 'Stale') : '', versionMark(v, h));
      /* a re-save the connector vouched changed nothing is drawn as a quiet line (the model's SAVED_AGAIN_NOTHING_CHANGED words); only `muted === true` does this, any other version is drawn as a normal version */
      var quiet = !!v && v.muted === true;
      var lbl = h.el('span', { class: 'lbl' }, quiet ? 'saved again, nothing changed' : v ? v.label : q === 0 ? 'Start' : 'End');
      var who = h.el('div', { class: 'who' }, v ? h.chip(v.lane) : '', lbl);
      var attrs = { type: 'button', role: 'option', class: 'vn' + (quiet ? ' muted' : '') + (q === p ? ' cur' : ''), 'aria-selected': String(q === p), 'data-p': String(q), onclick: function () { h.go(q); } };
      if (v) attrs.title = nameOf(q, n) + ' by ' + h.name(v.lane) + (v.inferred === true ? ' (likely)' : '');
      var b = h.el('button', attrs, top, who);
      if (v) b.style.setProperty('--c', h.color(v.lane));
      if (q === p) cn = b;
      box.append(b);
    })(q);
    /* The strip opens at its newest card (the right end) and keeps the chosen card in view; no scroll is carried over from the previous file */
    if (p === n + 1 || !cn) box.scrollLeft = typeof box.scrollWidth === 'number' ? box.scrollWidth : 0;
    else if (typeof cn.offsetLeft === 'number' && (cn.offsetLeft < box.scrollLeft || cn.offsetLeft + cn.offsetWidth > box.scrollLeft + box.clientWidth)) box.scrollLeft = Math.max(0, cn.offsetLeft - (box.clientWidth - cn.offsetWidth) / 2);
  }

  /* the model's "same bytes as <name> (<folder>)" as a tooltip, "Identical to <name> (<folder>)"; anything else is shown as it came */
  function identicalTip(t) { var m = /^same bytes as (.+)$/.exec(String(t)); return m ? 'Identical to ' + m[1] : String(t); }
  function paintHead(nameEl, orderEl, file, p, h) {
    nameEl.textContent = labelOf(file); nameEl.setAttribute('data-tip', file.file);
    orderEl.textContent = '';
    var n = file.versions.length, v = p >= 1 && p <= n ? file.versions[p - 1] : null;
    if (v) orderEl.append(h.chip(v.lane));
    orderEl.append(h.el('span', {}, describe(file, p, h.name)));
    if (v && v.inferred === true) orderEl.append(h.el('span', { class: 'hinferred' }, '(likely)'));
    var held = p === n + 1 ? file.versions[n - 1] : v;
    var lost = p === 0 ? file.start === 'lost' : p === n + 1 ? held.kind !== 'deleted' && notKept(held) : !!held && notKept(held);
    if (lost) orderEl.append(h.el('span', { class: 'notkept' }, 'content not kept'));
  }

  /* What the version on show was built from. Each input is a button that opens that file at that version (h.open); each says why: "named in the script" or "opened in the same call". Files the agent only opened with the Read tool sit below on a quieter "Looked at" line. Position 0 is Before task. Only a version (1..N) has inputs; Before task and Now have none. */
  function inputLabel(files, i) { var f = files[i.file]; return labelOf(f) + ' ' + (i.p === 0 ? '(before task)' : 'v' + i.p); }
  function paintBuilt(box, files, file, p, h) {
    box.textContent = '';
    var n = file.versions.length, v = p >= 1 && p <= n ? file.versions[p - 1] : null;
    if (!v || ((!v.inputs || !v.inputs.length) && (!v.looked || !v.looked.length))) return;
    if (v.inputs && v.inputs.length) box.append(h.el('div', { class: 'grp' }, 'Built from'));
    (v.inputs || []).forEach(function (i) {
      box.append(h.el('button', { type: 'button', class: 'bf', 'data-file': String(i.file), 'data-p': String(i.p), onclick: function () { h.open(i.file, i.p); } },
        h.el('span', { class: 'nm', title: files[i.file].file }, inputLabel(files, i)), h.el('span', { class: 'inf' }, i.why === 'script' ? 'named in the script' : 'opened in the same call')));
    });
    if (v.looked && v.looked.length) {
      var line = h.el('div', { class: 'looked' }, h.el('span', { class: 'grp' }, 'Looked at'));
      v.looked.forEach(function (i) { line.append(h.el('button', { type: 'button', class: 'bf lk', 'data-file': String(i.file), 'data-p': String(i.p), onclick: function () { h.open(i.file, i.p); } }, h.el('span', { class: 'nm', title: files[i.file].file }, inputLabel(files, i)))); });
      box.append(line);
    }
  }
  /* A calm warning when the version on show read an input that changed afterwards; the button opens the newer input version. Only the version that read it. */
  function paintStale(box, files, file, p, h) {
    box.textContent = '';
    var n = file.versions.length, v = p >= 1 && p <= n ? file.versions[p - 1] : null;
    if (!v) return;
    if (v.unknownReads) box.append(h.el('div', { class: 'warn unk', role: 'status' }, h.el('span', { class: 'ic', 'aria-hidden': 'true' }, '?'), h.el('div', { class: 'tx' }, "CoCheck couldn't tell everything this script read.")));
    (v.stale || []).forEach(function (s) {
      var g = files[s.file], was = s.p === 0 ? labelOf(g) + ' as the task found it' : labelOf(g) + ' v' + s.p + ' by ' + h.name(g.versions[s.p - 1].lane);
      box.append(h.el('div', { class: 'warn', role: 'status' }, h.el('span', { class: 'ic', 'aria-hidden': 'true' }, '!'),
        h.el('div', { class: 'tx' }, 'Built from ' + was + '. ' + labelOf(g) + ' changed afterwards: v' + s.newer + ' by ' + h.name(s.newerLane) + '.'),
        h.el('button', { type: 'button', class: 'wopen', onclick: function () { h.open(s.file, s.newer); } }, 'Open ' + labelOf(g) + ' v' + s.newer)));
    });
  }
  /* the look-back path: where you were before each step into an input; a click goes back to that place */
  function paintCrumbs(box, trail, files, h) {
    box.textContent = '';
    trail.forEach(function (t, k) {
      var f = files[t.f];
      box.append(h.el('button', { type: 'button', class: 'crumb', onclick: function () { h.back(k); } }, labelOf(f) + ' ' + nameOf(clamp(f, t.p), f.versions.length)), h.el('span', { class: 'sep', 'aria-hidden': 'true' }, '\u203A'));
    });
  }

  root.CoCheckFilesView = { setLive: setLive, paintBuilt: paintBuilt, paintStale: paintStale, paintCrumbs: paintCrumbs, clamp: clamp, versionAt: versionAt, labelOf: labelOf, soloOf: soloOf, nameOf: nameOf, timeText: timeText, describe: describe, notKept: notKept, paintList: paintList, paintStrip: paintStrip, paintHead: paintHead, nowOf: nowOf, versionMark: versionMark };
})(typeof globalThis !== 'undefined' ? globalThis : this);
