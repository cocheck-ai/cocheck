import { capitalize, count, detailsHtml, esc, joinShown, ownText, plural, utcMoment, words, type Shown } from "../../src/display.ts";
import type { HookCallView, HookRoundView, MovedGroup, NoCellCalls, PageRow, ReviewModel, SheetGroup, StaleNotice } from "./legacy-review-model.ts";

/**
 * Test helper: the text of the removed legacy review page, read-only. The page itself is not in `src/`; the tests of the round
 * engine (row model, checks, "what moved", hook rounds, copies) still assert on what a round says, and this renders the model as the page did.
 * No script, no controls, no sign-off, request or confirm sections.
 */

/** The text after "call <id>": how it closed, background, and the times. */
function callDetail(c: HookCallView): string {
  return [`closed by ${c.closedBy}`, ...(c.background ? ["background"] : []), ...(c.openedAt !== undefined ? [`opened ${utcMoment(c.openedAt)}`] : []), ...(c.closedAt !== undefined ? [`closed ${utcMoment(c.closedAt)}`] : [])].join(", ");
}


/** Hook calls whose ops own no row, per round: they changed no cell they could be tied to, but they ran and are on record. */
export function noCellCallsHtml(rounds: NoCellCalls[]): string {
  if (rounds.length === 0) return "";
  const lines = rounds.flatMap((r) => [`Round ${r.round}`, ...r.calls.map((c) => `call ${c.id}, ${callDetail(c)}`)]);
  return detailsHtml(words`Hook calls with no cells (${count(rounds.reduce((n, r) => n + r.calls.length, 0))})`, lines, { cls: "nocells" });
}

/**
 * Per round with hook calls: a round with calls but no row says so in words (never "no changes"), and what the calls
 * reached outside the watched folder is listed by file name and the call's reason, or only counted when outside
 * watching is off. The full path and the command sit behind a "show path" control.
 */
export function hookRoundsHtml(rounds: HookRoundView[]): string {
  const said: string[] = [];
  const listed: string[] = [];
  for (const r of rounds) {
    const round = words`Round ${r.round}`;
    if (r.rows === 0) said.push(`<div class="small">${esc(words`${round}: ${plural(r.calls, words`tool call`, words`tool calls`)} ran and no workbook change was found. Writes to paths a script computes itself would also show no change here.`)}</div>`);
    if (r.offCalls > 0) said.push(`<div class="small">${esc(words`${plural(r.offCalls, words`call`, words`calls`)} touched paths outside the watched folder (outside watching is off).`)}</div>`);
    for (const w of r.workedIn) listed.push(`<div class="small">${esc(round)}: the agent worked in <code>${esc(w.name)}</code> <span class="muted">${esc(words`by ${w.reason}`)}</span>${detailsHtml(words`show path`, [w.path])}</div>`);
    for (const o of r.outside) listed.push(`<div class="small">${esc(round)}: <code>${esc(o.name)}</code> <span class="muted">${esc(words`by ${o.reason}`)}</span>${detailsHtml(words`show path`, [o.path, o.command])}</div>`);
    for (const c of r.unknown) listed.push(`<div class="small">${esc(round)}: path unknown <span class="muted">${esc(words`by ${c.reason}`)}</span>${detailsHtml(words`show command`, [c.command])}</div>`);
  }
  if (said.length + listed.length === 0) return "";
  return `<div class="hookrounds">${said.join("")}${listed.length > 0 ? `<h2>Work outside the watched folder</h2>${listed.join("")}` : ""}</div>`;
}

/**
 * A new or deleted file, or a workbook changed with no cell diff to show (too large, or no cell
 * changed), has no readable before/after; say what happened in the row's own words.
 */
function changeHtml(r: PageRow, compact = false): string {
  if (
    (r.kind === "new file" || r.kind === "file deleted" || r.kind === "changed outside CoCheck" || r.kind === "deleted outside CoCheck") ||
    (r.layer === "xlsx" && (r.kind === "too large" || r.kind === "file changed"))
  ) {
    return `<b>${esc(capitalize(r.description || ownText(r.kind)))}</b>`;
  }
  return `was <b>${esc(r.before)}</b>, now <b>${esc(r.after)}</b>${compact ? "" : `<div class="muted small">${esc(r.description)}</div>`}`;
}

function rowHtml(r: PageRow, groupCode?: string): string {
  // A recalculated row in a flag group repeats, in words, what its before/after and the group header say.
  const compact = groupCode !== undefined && r.status === "derived" && r.intents.length === 0;
  const why = compact
    ? `<span class="badge derived">Recalculated</span>`
    : r.status === "unlogged"
      ? `<span class="badge unlogged">Changed outside CoCheck</span> <span class="muted">No agent call through CoCheck made this change.</span>`
      : r.status === "derived" && r.intents.length === 0
        ? `<span class="badge derived">Recalculated</span> <span class="muted">Follows from other changes.</span>`
        : r.intents.map((i) => `<div class="intent">&ldquo;${esc(i)}&rdquo;</div>`).join("") +
          (r.commands.length > 0 ? detailsHtml(words`show command`, r.commands, { pre: true, cls: "cmd" }) : "") +
          (r.agents.length > 0 || r.calls.length > 0
            ? detailsHtml(words`show call`, [...(r.agents.length > 0 ? [`by ${r.agents.join(", ")}`] : []), ...r.calls.map((c) => `call ${c.id}, ${callDetail(c)}`)])
            : "");
  // Under its group's header the group's own badge would only repeat the header.
  const flags = r.flags
    .filter((f) => f.code !== groupCode)
    .map((f) => `<div class="flag"><span class="badge flagged">${esc(f.label)}</span> <span class="muted small">${esc(f.detail)}</span></div>`)
    .join("");
  return (
    `<tr id="row-${r.id}" data-row="${r.id}" class="${r.open ? "open" : "closed"}${r.flags.length > 0 ? " flagged" : ""}">` +
    `<td class="place">${esc(r.place)}</td>` +
    `<td class="change">${flags}${changeHtml(r, compact)}</td>` +
    `<td class="why">${r.outsideFolder ? `<span class="badge derived">outside the watched folder</span> ` : ""}${why}</td>` +
    `<td class="state">${esc(r.stateText)}</td>` +
    `</tr>`
  );
}

/**
 * A sheet's flagged block: a count line, then one collapsible group per check. A group opens by
 * default only when it holds rows beyond recalculated ones; its recalculated rows sit in a nested
 * collapsed list. Everything stays in the page, collapsed rows included.
 */
function flaggedHtml(g: SheetGroup): string {
  const groups = g.flagged
    .map((fg) => {
      const derived =
        fg.derived.length > 0
          ? `<details><summary>${esc(plural(fg.derived.length, words`recalculated cell`, words`recalculated cells`))}</summary>${tableHtml(fg.derived, fg.code)}</details>`
          : "";
      const body = (fg.rows.length > 0 ? tableHtml(fg.rows, fg.code) : "") + derived;
      return `<details class="flaggroup"${fg.rows.length > 0 ? " open" : ""}><summary>${g.sheet ? `${esc(g.sheet)}: ` : ""}${esc(plural(fg.count, fg.label, fg.plural))}</summary>${body}</details>`;
    })
    .join("");
  return `<div class="flagcounts"><b>Flagged:</b> ${esc(g.flagCounts)}</div>${groups}`;
}

/** A notice stored before rounds were kept: everything in it came from its one round. */
function withRounds(n: StaleNotice): StaleNotice {
  if (n.rounds !== undefined && n.edits !== undefined) return n;
  return { ...n, rounds: [n.round], edits: n.places.map((place) => ({ round: n.round, place })) };
}

/**
 * The page's opening section: the terminal outputs the round moved (largest relative change
 * first) and the edits each depends on, linked to those edits' rows. Nothing when none moved.
 */
export function movedHtml(moved: MovedGroup[], stale: StaleNotice[] = []): string {
  if (moved.length === 0 && stale.length === 0) return "";
  const staleBlock = stale
    .map((n0) => {
      const n = withRounds(n0);
      const byRound = n.rounds.map((k) => {
        const places = n.edits.filter((e) => e.round === k).map((e) => e.place);
        return places.length > 0 ? [words`round ${k}: ${joinShown(places, words`, `)}`] : [];
      });
      return (
        `<div class="banner" role="note">${esc(words`${n.name}: the agent changed ${plural(n.inputs, words`input`, words`inputs`)} whose results weren't recalculated, so the outputs shown may be out of date.`)}` +
        `<div class="muted small">${esc(joinShown(byRound.flat(), words`; `))}${n.inputs > n.edits.length ? esc(words` and ${n.inputs - n.edits.length} more`) : ""}</div></div>`
      );
    })
    .join("");
  const nothing = moved.length === 0 ? `<div class="muted small">No results were recalculated, so nothing is shown as moved.</div>` : "";
  const body = moved
    .map((g) => {
      const rows = g.outputs
        .map((o) => {
          const edits = o.edits
            .map((e) => {
              const why = e.intents.length > 0 ? ` <span class="muted">&ldquo;${esc(joinShown(e.intents, words`; `))}&rdquo;</span>` : e.status === "unlogged" ? ` <span class="muted">changed outside CoCheck</span>` : "";
              return `<div><a href="#row-${e.id}">${esc(e.place)}</a>${why}</div>`;
            })
            .join("");
          const rounds = [...new Set(o.priorEdits.map((p) => p.round))].sort((a, b) => a - b);
          const prior = rounds
            .map((k) => `<div class="muted small">${esc(words`This result may include unrecalculated edits from round ${k}: ${joinShown(o.priorEdits.filter((p) => p.round === k).map((p) => p.place), words`, `)}`)}</div>`)
            .join("");
          const note = o.traceNote ? `<div class="muted small">${esc(o.traceNote)}</div>` : "";
          return (
            `<tr><td class="place">${esc(o.title)}</td>` +
            `<td>${esc(o.detail)}</td>` +
            `<td>${edits}${prior}${note}</td></tr>`
          );
        })
        .join("");
      const more = g.more > 0 ? `<div class="muted small">${esc(words`and ${plural(g.more, words`more output`, words`more outputs`)} moved by recalculation`)}${g.moreLargest ? `; largest: ${esc(g.moreLargest.title)}, ${esc(g.moreLargest.detail)}` : ""}</div>` : "";
      const title = moved.length > 1 ? `<h3>${esc(g.name)}</h3>` : "";
      return `${title}<table><thead><tr><th>Output</th><th>What changed</th><th>Depends on your edits</th></tr></thead><tbody>${rows}</tbody></table>${more}`;
    })
    .join("");
  return `<section class="moved"><h2>What moved</h2><div class="muted small">Results that changed only because other cells changed, and that no other cell uses.</div>${staleBlock}${nothing}${body}</section>`;
}

function tableHtml(rows: PageRow[], groupCode?: string): string {
  const head = `<tr><th>Where</th><th>Change</th><th>Why (the agent's words)</th><th>Review</th></tr>`;
  return `<table><thead>${head}</thead><tbody>${rows.map((r) => rowHtml(r, groupCode)).join("")}</tbody></table>`;
}

const STYLE = `
body{font:15px/1.45 -apple-system,system-ui,Segoe UI,Helvetica,Arial,sans-serif;margin:24px;color:#1d1d1f;background:#fafafa}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}h3{font-size:15px;margin:16px 0 6px;color:#444}
.summary{font-size:16px;margin:6px 0 16px}.summary .need{color:#b3261e;font-weight:600}
table{border-collapse:collapse;width:100%;background:#fff;margin-bottom:8px}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid #e5e5e5}
th{font-size:12px;text-transform:uppercase;color:#666;letter-spacing:.03em}
tr.open td:first-child{box-shadow:inset 3px 0 #b3261e}
.place{font-weight:600;white-space:nowrap}.muted{color:#666}.small{font-size:12px}
.intent{font-style:italic}.cmd pre{white-space:pre-wrap;word-break:break-all;max-height:12em;overflow:auto}.badge{display:inline-block;border-radius:10px;padding:1px 8px;font-size:12px;font-weight:600}
.badge.flagged{background:#b3261e;color:#fff}.flag{margin-bottom:4px}.flagcounts{margin:8px 0;color:#8c1d18}.flaggroup>summary{font-weight:600;color:#8c1d18}
.badge.unlogged{background:#fde7e4;color:#8c1d18}.badge.derived{background:#eef;color:#334}
details{margin:6px 0 12px}summary{cursor:pointer;color:#444}
.banner{background:#fff4d6;border:1px solid #e8c56b;border-radius:6px;padding:8px 12px;margin:0 0 12px}
`;

/**
 * The read-only review page for `model`, as the removed legacy page drew it without its controls. Kept here only so the tests of the
 * round engine (the row model, checks, "what moved", hook rounds) can still read what a round says as text; nothing in `src/` serves it.
 * It goes when the engine does.
 */
export function renderReviewPage(model: ReviewModel): string {
  const title = model.files.length > 0 ? words`Review: ${joinShown(model.files.map((f) => f.name), words`, `)}` : words`Review: task ${model.taskId}`;
  const need = `${model.open.toLocaleString("en-US")} ${model.open === 1 ? "needs" : "need"} a look`;
  const sections = model.files
    .map((f) => {
      const sheets = f.sheets
        .map((g) => {
          const heading = g.sheet ? `<h3>${esc(g.sheet)}</h3>` : "";
          const flagged = g.flagged.length > 0 ? flaggedHtml(g) : "";
          const main = g.rows.length > 0 ? tableHtml(g.rows) : "";
          const derived =
            g.derived.length > 0
              ? `<details><summary>${esc(plural(g.derived.length, words`recalculated cell`, words`recalculated cells`))} (follow from other changes)</summary>${tableHtml(g.derived)}</details>`
              : "";
          return heading + flagged + main + derived;
        })
        .join("");
      const low =
        f.lowPriority.length > 0
          ? `<details class="lowpriority"><summary>Low priority (${esc(count(f.lowPriority.length))}): re-saved or changed outside CoCheck</summary>${tableHtml(f.lowPriority)}</details>`
          : "";
      return `<section><h2>${esc(f.name)}</h2>${detailsHtml(words`show path`, [f.file])}${sheets}${low}</section>`;
    })
    .join("");
  const roundLine = model.round === null ? "Nothing submitted for review yet." : `Round ${model.round}.`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>` +
    `<h1>${esc(title)}</h1>` +
    `<div class="summary">${esc(plural(model.total, words`change`, words`changes`))}, <span class="need" id="need">${need}</span>. ${model.flagged > 0 ? ` <span class="need" id="flagged">Flagged: ${esc(model.flagSummary)}.</span>` : ""} <span class="muted">${roundLine} Read-only copy.</span></div>` +
    requestHtml(model) +
    roundNotesHtml(model.notes) +
    checkNoticesHtml(model.closedNotes) +
    checkNoticesHtml(model.checkNotices) +
    movedHtml(model.moved, model.unrecalculated) +
    sections +
    hookRoundsHtml(model.hookRounds) +
    noCellCallsHtml(model.noCellCalls) +
    `</body></html>`
  );
}

/**
 * The persistent banner for round notes: each thing the review couldn't see (an unwatched folder,
 * a file over the size cap), on the live page and the export alike, so a reviewer never reads an
 * empty list as "nothing changed" when part of the folder wasn't watched.
 */
export function checkNoticesHtml(notices: Shown[]): string {
  return notices.map((n) => `<div class="banner" role="note">${esc(n)}</div>`).join("");
}

export function roundNotesHtml(notes: Shown[]): string {
  return notes.map((note) => `<div class="banner" role="note">Not reviewed: ${esc(note)}</div>`).join("");
}


/** The current round's request at the top of the page: the prompts in order, or a plain statement that none was captured. */
function requestHtml(model: ReviewModel): string {
  if (model.round === null) return "";
  const prompts = model.roundRequests.find((r) => r.round === model.round)?.prompts ?? [];
  if (prompts.length === 0) return `<div class="request muted" id="request">Request not captured.</div>`;
  return `<div class="request" id="request"><div class="muted small">Request:</div>${prompts.map((p) => `<div style="white-space:pre-wrap">${esc(p)}</div>`).join("")}</div>`;
}

