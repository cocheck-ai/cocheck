import { escapeHtml as esc } from "../html.ts";
import { isSecretPath, secretLine } from "../secret-files.ts";
import { LOADING_CSS, LOADING_MOTION_CSS, loadingHtml } from "./loading.ts";
import { byOf, callName, whoShort as shortOf, whoText as whoOf } from "./attribution.ts";
import type { Change, Line, Timeline, TimelineCall, TimelineRequest } from "./timeline.ts";

/**
 * The general review page of one task: one card per changed file, built only from the timeline body (`buildTimeline`) and
 * the preview route that body points at. It has no knowledge of any file format. What differs inside a file comes from the change's
 * `generic` part, which has exactly three tiers: text hunks, a before and after picture pair, or a fingerprint. A format part
 * (`change.format`, today spreadsheet cells) is shown folded below as a plain location, before, after list and never replaces `generic`.
 *
 * Never on the page: a raw command (the timeline body does not hold one and this page never fetches it), any content of a file
 * marked `generic.secret` (its card carries the name line only), and two pictures without their label.
 */

export interface GenericPart {
  tier: "text" | "picture" | "fingerprint";
  label: string;
  text?: { hunks: Array<{ beforeStart: number; beforeLines: number; afterStart: number; afterLines: number; lines: Array<{ op: string; text: string }> }>; cut?: string };
  picture?: { before: string | null; after: string | null; width: number; height: number; regions: Array<{ x: number; y: number; w: number; h: number }>; note?: string };
  fingerprint?: { before: { sha: string; size: number | null } | null; after: { sha: string; size: number | null } | null; kind: string; note: string };
  secret?: true;
  /** A state a connector reads: core draws no view of it. */
  claimed?: true;
  pending?: true;
}

type PageChange = Change & { generic?: GenericPart };

interface Placement {
  request: TimelineRequest | null;
  call: TimelineCall | null;
}

interface Entry {
  change: PageChange;
  /** Where the change happened. A joint change lists every call it is credited to. */
  placements: Placement[];
}


const NO_LABEL = "No label was recorded for this view of the change.";

/** Every change of the task once, in the order the timeline holds them, with the calls it is credited to. */
function entriesOf(timeline: Timeline): Map<string, Entry[]> {
  const byId = new Map<string, Entry>();
  const order: Entry[] = [];
  const add = (change: Change, placement: Placement): void => {
    let entry = byId.get(change.id);
    if (entry === undefined) {
      entry = { change: change as PageChange, placements: [] };
      byId.set(change.id, entry);
      order.push(entry);
    }
    entry.placements.push(placement);
  };
  for (const request of timeline.requests) {
    for (const run of request.runs) {
      for (const call of run.calls) {
        for (const change of call.changes) add(change, { request, call });
      }
    }
  }
  for (const change of timeline.unplaced) add(change, { request: null, call: null });
  const files = new Map<string, Entry[]>();
  for (const entry of order) {
    const list = files.get(entry.change.file) ?? [];
    list.push(entry);
    files.set(entry.change.file, list);
  }
  return files;
}

/** Who made the change is `change.by` (`attribution.ts`); the calls the change is listed under only name the calls. */
function whoText(entry: Entry, host: string | null): string {
  const by = byOf(entry.change, host);
  const names = entry.placements.filter((p) => p.call !== null).map((p) => callName(p.call!, by));
  return whoOf(by, names);
}

function whoShort(entries: Entry[], host: string | null): string {
  return [...new Set(entries.map((e) => shortOf(byOf(e.change, host))))].join(", ");
}

function whenText(entry: Entry): string {
  const p = entry.placements.find((x) => x.call !== null);
  if (p === undefined || p.call === null || p.request === null) return "No request or call time is recorded for this change.";
  const at = p.call.start === null ? "" : `, started ${new Date(p.call.start).toISOString().slice(0, 19).replace("T", " ")} UTC`;
  return `Request ${p.request.index}, call ${p.call.index} of ${p.call.of}${at}.`;
}

function lineHtml(line: Line, role: string): string {
  return `<p class="why"><span class="src">${esc(role)} (${esc(line.label)})</span> <span class="said">${esc(line.text)}</span></p>`;
}

function whyHtml(entry: Entry): string {
  const p = entry.placements.find((x) => x.call !== null);
  if (p === undefined || p.call === null || p.request === null) return `<p class="muted">No request is recorded for this change.</p>`;
  const parts = p.request.texts.map((t) => lineHtml(t, "The request"));
  parts.push(lineHtml(p.call.line, "The call"));
  if (p.request.closing !== null) parts.push(lineHtml(p.request.closing, "The agent's closing message"));
  return parts.join("");
}

function textHtml(text: NonNullable<GenericPart["text"]>): string {
  const hunks = text.hunks.map((h) => {
    const rows = h.lines.map((l) => `<div class="${l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx"}">${esc(l.op === "+" || l.op === "-" ? l.op : " ")} ${esc(l.text)}</div>`).join("");
    return `<div class="hunk"><div class="hunk-head">Before: from line ${h.beforeStart} (${h.beforeLines} lines). After: from line ${h.afterStart} (${h.afterLines} lines).</div><pre class="textdiff">${rows}</pre></div>`;
  });
  const cut = text.cut ? `<p class="muted">${esc(text.cut)}</p>` : "";
  return hunks.join("") + cut;
}

function pictureHtml(taskId: number, token: string, label: string, pic: NonNullable<GenericPart["picture"]>): string {
  // A zero, negative or non-finite size gives no percentages to draw, so no box is drawn.
  const sized = Number.isFinite(pic.width) && Number.isFinite(pic.height) && pic.width > 0 && pic.height > 0;
  const boxes = (sized ? pic.regions : [])
    .map((r) => `<span class="box" style="left:${(100 * r.x) / pic.width}%;top:${(100 * r.y) / pic.height}%;width:${(100 * r.w) / pic.width}%;height:${(100 * r.h) / pic.height}%"></span>`)
    .join("");
  const side = (name: string, sha: string | null): string => {
    if (sha === null) return `<figure><figcaption>${name}</figcaption><div class="nopic">There is no ${name.toLowerCase()} picture.</div></figure>`;
    const src = `/timeline/${taskId}/preview/${encodeURIComponent(sha)}?t=${encodeURIComponent(token)}`;
    return `<figure><figcaption>${name}</figcaption><div class="frame"><img src="${esc(src)}" alt="${esc(label)}: ${name.toLowerCase()}">${boxes}</div></figure>`;
  };
  const note = pic.note ? `<p class="muted">${esc(pic.note)}</p>` : "";
  const regions = pic.regions.length === 0 ? `<p class="muted">No region is boxed.</p>` : `<p class="muted">${pic.regions.length} boxed ${pic.regions.length === 1 ? "region" : "regions"}.</p>`;
  return `<div class="pair">${side("Before", pic.before)}${side("After", pic.after)}</div>${regions}${note}`;
}

function fingerprintHtml(fp: NonNullable<GenericPart["fingerprint"]>): string {
  const state = (name: string, s: { sha: string; size: number | null } | null): string => `<tr><th>${name}</th><td>${s === null ? "none" : `${esc(s.sha)} (${s.size === null ? "size unknown" : `${s.size} bytes`})`}</td></tr>`;
  return `<table class="diff"><tr><th>Kind</th><td>${esc(fp.kind)}</td></tr>${state("Before", fp.before)}${state("After", fp.after)}</table><p>${esc(fp.note)}</p>`;
}

function formatHtml(change: Change): string {
  if (change.format === null || change.format.rows.length === 0) return "";
  const rows = change.format.rows
    .map((r) => `<tr><td>${esc(r.location)}</td><td>${r.before === null ? "" : esc(r.before)}</td><td>${r.after === null ? "" : esc(r.after)}</td></tr>`)
    .join("");
  const more = change.format.more > 0 ? `<p class="muted">${change.format.more} more not listed.</p>` : "";
  return `<details class="fold"><summary>Details from the ${esc(change.format.module)} reader</summary><table class="diff"><tr><th>Location</th><th>Before</th><th>After</th></tr>${rows}</table>${more}</details>`;
}

function cardHtml(taskId: number, token: string, entry: Entry, host: string | null): string {
  const { change } = entry;
  const g = change.generic;
  let diff: string;
  let labelHtml = "";
  // A card shows contents only when the record is whole. A secret file (by the record, or by its name) and a change with no `generic`
  // part both fail closed: the name line, or the name and who, when and why, and nothing from inside the file.
  const secret = g?.secret === true || isSecretPath(change.file);
  if (secret) {
    diff = `<p class="secret">${esc(secretLine(change.file))}</p>`;
  } else if (g?.pending === true) {
    // A preview still being drawn is the loading widget; PENDING_SCRIPT swaps in the finished card, or words when it stops asking
    diff = loadingHtml("Drawing the preview of this change");
  } else if (g === undefined) {
    diff = `<p class="muted">No general record of what changed was made for this change, so nothing from inside the file is shown.</p>`;
    labelHtml = `<p class="label">${NO_LABEL}</p>`;
  } else {
    labelHtml = `<p class="label">${esc(g.label.trim() === "" ? NO_LABEL : g.label)}</p>`;
    const label = g.label.trim() === "" ? NO_LABEL : g.label;
    diff =
      g.tier === "text" && g.text ? textHtml(g.text)
      : g.tier === "picture" && g.picture ? pictureHtml(taskId, token, label, g.picture)
      : g.tier === "fingerprint" && g.fingerprint ? fingerprintHtml(g.fingerprint)
      : `<p class="muted">The record names the ${esc(String(g.tier))} view but holds nothing for it.</p>`;
  }
  const format = secret || g === undefined ? "" : formatHtml(change);
  return `<article class="card" id="${esc(change.id)}"${g?.pending === true && !secret ? " data-pending" : ""}>
<h3>${esc(change.kind[0]!.toUpperCase() + change.kind.slice(1))}: ${esc(change.file)}</h3>
<dl>
<dt>What happened</dt><dd>${esc(change.kind)}</dd>
<dt>Who</dt><dd>${esc(whoText(entry, host))}</dd>
<dt>When</dt><dd>${esc(whenText(entry))}</dd>
<dt>Why</dt><dd>${whyHtml(entry)}</dd>
</dl>
<h4>What is different</h4>${labelHtml}${diff}${format}
</article>`;
}

/** Fills a still-running preview in by itself: asks for the page again after 1 s, 2 s, 4 s, then every 8 s (about 80 s), and swaps each finished card in.
 *  After the last ask a card still waiting says so in words; its loading widget never stays. */
export const PENDING_SCRIPT = `(function(){var n=0;function stop(){document.querySelectorAll("article[data-pending] .iload").forEach(function(w){var p=document.createElement("p");p.className="muted";p.textContent="The preview was still being drawn when the page stopped asking. Reload the page to try again.";w.replaceWith(p)})}function go(){if(!document.querySelector("article[data-pending]"))return;if(n>=14)return stop();setTimeout(function(){n++;fetch(location.href).then(function(r){return r.text()}).then(function(t){var d=new DOMParser().parseFromString(t,"text/html");document.querySelectorAll("article[data-pending]").forEach(function(c){var f=d.getElementById(c.id);if(f&&!f.hasAttribute("data-pending"))c.replaceWith(document.importNode(f,true))});go()}).catch(go)},Math.min(1000*Math.pow(2,n),8000))}go()})();`;

/** The page styles; the review index uses them too. */
export const CSS = `body{font:16px/1.5 -apple-system,Helvetica,Arial,sans-serif;color:#111;margin:32px auto;max-width:980px;padding:0 24px}
h1{font-size:30px;margin:0 0 4px}h3{margin:0 0 8px}h4{margin:16px 0 4px}.muted{font-style:italic;color:#444}
details.file{border-top:2px solid #111;padding:10px 0}details.file>summary{cursor:pointer;font-size:20px;font-weight:700}
.card{border-left:6px solid #a8cdeb;padding:4px 0 8px 20px;margin:18px 0}dl{display:grid;grid-template-columns:120px 1fr;gap:4px 12px;margin:0}dt{font-weight:700}dd{margin:0}
.why{margin:0 0 4px}.src{font-weight:700}.said{white-space:pre-wrap}.label{font-weight:700;margin:4px 0}
pre{border:2px solid #a8cdeb;border-radius:8px;padding:10px;font:13px/1.5 ui-monospace,Menlo,monospace;overflow:auto;margin:4px 0}
.textdiff div{white-space:pre-wrap}.add{background:#a8cdeb}.del{background:#f2b6d2}.hunk-head{font-size:13px}
.pair{display:flex;gap:16px;flex-wrap:wrap}figure{margin:0;flex:1 1 300px}figcaption{font-weight:700}
.frame{position:relative;display:inline-block;max-width:100%;border:2px solid #111}.frame img{display:block;max-width:100%}
.box{position:absolute;border:3px solid #f2b6d2;box-sizing:border-box}.nopic{border:2px dashed #111;padding:24px;font-style:italic}
.secret{font-weight:700;border:2px solid #f2b6d2;padding:10px;border-radius:8px}
table.diff{border-collapse:collapse;width:100%}.diff th,.diff td{text-align:left;padding:4px 10px 4px 0;border-bottom:1px solid #111;font-size:14px;word-break:break-all}
details.fold{margin-top:10px}details.fold>summary{cursor:pointer;font-style:italic}
${LOADING_CSS}
${LOADING_MOTION_CSS}`;

/** The page for one task. `token` is the review token the page's own picture links carry. */
export function renderGenericPage(timeline: Timeline, token: string): string {
  const files = entriesOf(timeline);
  const host = timeline.host ?? null;
  const open = files.size === 1 ? " open" : "";
  const sections = [...files.entries()].map(([file, entries]) => {
    const count = entries.length === 1 ? "1 change" : `${entries.length} changes`;
    return `<details class="file"${open}><summary>${esc(file)} - ${count} - ${esc(whoShort(entries, host))}</summary>${entries.map((e) => cardHtml(timeline.task, token, e, host)).join("")}</details>`;
  });
  const expired = timeline.expired ? `<p class="muted">${esc(timeline.expired.text)}</p>` : "";
  const body = files.size === 0 ? `<p class="muted">No file changed in this task.</p>` : sections.join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Task ${timeline.task}: what changed</title><style>${CSS}</style></head><body>
<h1>Task ${timeline.task}: what changed</h1>${expired}
<p class="muted">${files.size === 1 ? "1 file" : `${files.size} files`} changed. Open a file to see each change, who made it and why.</p>
${body}${body.includes("data-pending") ? `<script>${PENDING_SCRIPT}</script>` : ""}
</body></html>`;
}
