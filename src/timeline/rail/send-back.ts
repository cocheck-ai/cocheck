import type { RailModel } from "./model.ts";
import { changesByStop, type ReviewSummary } from "./stop-status.ts";
import type { Timeline } from "../timeline.ts";
import { moreText } from "../notes.ts";
import { existsSync } from "node:fs";
import type { RegionRef } from "./regions.ts";
import { speakAs } from "../attribution.ts";
import { ISSUE_CHARS, ISSUES_SHOWN } from "../../connector/changes-v1.ts";

/**
 * The Send back prompt. Pure and deterministic: the rail model, the timeline body and the review summary in, one plain text out.
 *
 * Built from the record only. For each stop that is failed now: where it is (the file, and the sheet and cell or page of each row the
 * record holds), what changed (the record's own sentence and row texts), and the person's note. A detail the record lacks is left out,
 * never guessed. A secret file gets its path and the person's note and nothing from inside it. No failed stop is skipped; a stop that is
 * not failed now is never listed.
 *
 * An optional overall note, the person's own words about the task as a whole. It goes into the prompt as given (trimmed), after the
 * failed stops, or alone when no stop failed. A blank note is no note; with neither a failed stop nor a note there is nothing to send.
 */

/** The fixed follow-up line that ends every copied send-back. Not editable on the page; a later item reads it back by this exact shape. */
export function followUpMarker(task: number, id: number, nonce: string): string {
  return `CoCheck follow-up: task ${task}, send-back ${id}, ${nonce} (you can ignore this line)`;
}

/** What a follow-up line names. */
export interface FollowUpMark {
  task: number;
  id: number;
  nonce: string;
}

const FOLLOW_UP_LINE = /^CoCheck follow-up: task (\d{1,9}), send-back (\d{1,9}), ([a-z0-9]{6}) \(you can ignore this line\)$/;

/**
 * Reads a follow-up line back out of typed text: the first line that is exactly the shape `followUpMarker` writes (nothing before or after it on the
 * line). The three values are returned as the line states them; whether they match a recorded send-back is for the caller to check.
 */
export function parseFollowUpMarker(text: string): FollowUpMark | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = FOLLOW_UP_LINE.exec(line.trim());
    if (m !== null) return { task: Number(m[1]), id: Number(m[2]), nonce: m[3]! };
  }
  return undefined;
}

const VERB: Record<"created" | "modified" | "deleted", string> = { created: "created", modified: "changed", deleted: "deleted" };

/** Rows listed per stop; the rest are counted, never dropped silently. */
const MAX_ROWS = 25;

/** The regions the prompt carries: each failed stop's own, and the send-back's overall note's. */
export interface RegionPrompt {
  byStop: ReadonlyMap<string, readonly RegionRef[]>;
  overall: readonly RegionRef[];
  /** the person's sticky notes, each with its region (null for a note about nothing in particular). */
  notes?: ReadonlyArray<{ text: string; region: RegionRef | null }>;
}

/** The prompt lines of the sticky notes: "Note N: text", then that note's region lines. Empty with no notes. */
export function noteLines(notes: NonNullable<RegionPrompt["notes"]>): string[] {
  if (notes.length === 0) return [];
  const out = ["Notes:"];
  notes.forEach((n, i) => {
    out.push(`Note ${i + 1}: ${n.text.trim()}`);
    if (n.region !== null) out.push(...regionLines([n.region]).map((l) => `   ${l}`));
  });
  return out;
}

/**
 * The "Reviewer pointed at:" lines of one note, unindented: one per region (at most MAX_ROWS, the rest counted), then the region's listed text
 * as "  - " lines (at most MAX_ROWS, the rest counted). A picture path is named only while the file is on disk now; otherwise the locator alone.
 */
export function regionLines(regions: readonly RegionRef[]): string[] {
  const out: string[] = [];
  for (const r of regions.slice(0, MAX_ROWS)) {
    out.push(`Reviewer pointed at: ${r.where}${r.picture !== null && existsSync(r.picture) ? `, picture ${r.picture}` : ""}`);
    for (const l of r.lines.slice(0, MAX_ROWS)) out.push(`  - ${l}`);
    const left = r.lines.length - MAX_ROWS;
    if (left > 0) out.push(`  - ${left} more ${left === 1 ? "line is" : "lines are"} not listed here.`);
  }
  const more = regions.length - MAX_ROWS;
  if (more > 0) out.push(`${more} more ${more === 1 ? "region is" : "regions are"} not listed here.`);
  return out;
}

export interface SendBack {
  prompt: string;
  /** The stop ids the prompt covers, in rail order. */
  stops: string[];
}

/** What the record holds about one failed stop: the one source of the send-back prompt's block and of what the agent reads. */
export interface FailedStopDetail {
  stop: string;
  /** The stop's own words (the prompt's heading). */
  head: string;
  /** The file, or null for a stop that is not a change. */
  file: string | null;
  /** The record's own sentence about the change, or null when it holds none. */
  whatChanged: string | null;
  /** The individual changes the record lists, each as the prompt shows it ("Sheet1!A1: ..."); at most MAX_ROWS. */
  changes: string[];
  /** Where the changes are: the distinct row locations of `changes`, in order. */
  locations: string[];
  /** Why no changes are listed (the record holds none, or holds no detail), or null. */
  caveat: string | null;
  /** Says how many changes the list leaves out, or null when it is complete. */
  more: string | null;
  /** The person's note. */
  note: string;
  /** The "Reviewer pointed at:" lines of the stop's regions, as the prompt prints them (unindented); empty when it has none. */
  regions: string[];
  /** The step's issues, as the connector worded them ("page 5: ..."), for any connector; at most ISSUES_SHOWN, then "and N more issues". Empty when it has none. */
  issues: string[];
}

/** Issue words are outside data: each cut to ISSUE_CHARS, at most ISSUES_SHOWN of them, the rest counted. A before-side issue says so. */
function issueLines(issues: ReadonlyArray<{ text: string; side?: string; where?: string }>): string[] {
  const cut = (t: string): string => (t.length > ISSUE_CHARS ? `${t.slice(0, ISSUE_CHARS - 1)}\u2026` : t);
  const out = issues.slice(0, ISSUES_SHOWN).map((i) => cut(`${i.where !== undefined ? `${i.where}: ` : ""}${i.side === "before" ? "(before) " : ""}${i.text}`.replace(/\s+/g, " ")));
  if (issues.length > ISSUES_SHOWN) out.push(`and ${issues.length - ISSUES_SHOWN} more issues`);
  return out;
}

export function failedStopDetail(model: RailModel, timeline: Timeline, f: ReviewSummary["failed"][number], regions: readonly RegionRef[] = []): FailedStopDetail {
  const stop = model.stops.find((s) => s.id === f.stop);
  const change = changesByStop(timeline).get(f.stop);
  const secret = stop?.change?.secret === true;
  const detail: FailedStopDetail = { stop: f.stop, head: f.head, file: f.file, whatChanged: null, changes: [], locations: [], caveat: null, more: null, note: f.note, regions: regionLines(regions), issues: secret ? [] : issueLines(change?.diff?.issues ?? []) };
  if (change !== undefined && !secret) {
    const note = typeof change.note === "string" ? change.note : change.note?.text;
    // The record's sentence names the body's maker ("Claude changed ..."); the heading names the step's credit ("Helper 5 changed ..."). Both say the heading's name.
    const tail = ` ${VERB[change.kind]} ${change.file}`;
    const actor = f.head.endsWith(tail) ? f.head.slice(0, -tail.length) : null;
    if (note !== undefined && note.trim() !== "") detail.whatChanged = actor !== null && change.by !== undefined ? speakAs(note.trim(), change.by, actor) : note.trim();
    const format = change.format;
    if (format === null || format === undefined) {
      detail.caveat = "The individual changes inside this file are not listed here: the record holds none for it.";
    } else {
      // Every change is either listed or counted: the builder's own cap and the format layer's own `more` both go into the count.
      for (const r of format.rows.slice(0, MAX_ROWS)) {
        detail.changes.push(`${r.location === "" || r.text.startsWith(r.location) ? "" : `${r.location}: `}${r.text}`);
        if (r.location !== "" && !detail.locations.includes(r.location)) detail.locations.push(r.location);
      }
      const left = Math.max(0, format.rows.length - MAX_ROWS) + format.more;
      if (left > 0) {
        const where = format.more > 0 && format.moreIn !== undefined && format.moreIn.length > 0 ? ` ${moreText(format.more, format.moreIn)}` : "";
        detail.more = `${left} more ${left === 1 ? "change is" : "changes are"} in this file and not listed here, so this list is not complete.${where}`;
      }
    }
  } else if (change !== undefined) {
    detail.whatChanged = `the file was ${change.kind}. Its contents are not shown here.`;
  } else if (stop?.change !== undefined) {
    detail.caveat = "The record holds no detail of what changed in this file.";
  }
  return detail;
}

export function buildSendBack(model: RailModel, timeline: Timeline, summary: ReviewSummary, overallNote = "", regions: RegionPrompt = { byStop: new Map(), overall: [] }): SendBack {
  const overall = overallNote.trim();
  const overallRegions = regionLines(regions.overall);
  // A fail on a file version a later state replaced is history, not work to redo: it is not listed and not counted.
  const replaced = new Set(summary.submit.superseded);
  const failed = summary.failed.filter((f) => !replaced.has(f.stop));
  const notes = noteLines(regions.notes ?? []);
  if (failed.length === 0 && overall === "" && notes.length === 0) throw new Error("There is nothing to send back: there is no failed stop, no overall note and no note.");
  if (failed.length === 0) return { prompt: [`I reviewed your work on task ${model.task}.`, "", ...(overall === "" ? [] : [`Overall note: ${overall}`, ...overallRegions]), ...(overall !== "" && notes.length > 0 ? [""] : []), ...notes].join("\n"), stops: [] };
  const blocks = failed.map((f, i) => {
    const d = failedStopDetail(model, timeline, f, regions.byStop.get(f.stop) ?? []);
    const lines = [`${i + 1}. ${d.head}`];
    if (d.file !== null) lines.push(`   Where: ${d.file}`);
    if (d.whatChanged !== null) lines.push(`   What changed: ${d.whatChanged}`);
    for (const c of d.changes) lines.push(`   - ${c}`);
    if (d.more !== null) lines.push(`   - ${d.more}`);
    if (d.caveat !== null) lines.push(`   ${d.caveat}`);
    for (const r of d.issues) lines.push(`   Issue: ${r}`);
    lines.push(`   Reviewer's note: ${d.note}`);
    for (const l of d.regions) lines.push(`   ${l}`);
    return lines.join("\n");
  });
  const n = failed.length;
  const prompt = [
    `I reviewed your work on task ${model.task} and ${n === 1 ? "1 step failed" : `${n} steps failed`}. Please fix ${n === 1 ? "it" : "each one"}${overall === "" && notes.length === 0 ? " and change nothing else." : overall === "" ? ", and follow the notes below." : notes.length === 0 ? ", and follow the overall note below." : ", and follow the overall note and the notes below."}`,
    "",
    blocks.join("\n\n"),
    ...(overall === "" ? [] : ["", `Overall note: ${overall}`, ...overallRegions]),
    ...(notes.length === 0 ? [] : ["", ...notes]),
  ].join("\n");
  return { prompt, stops: failed.map((f) => f.stop) };
}
