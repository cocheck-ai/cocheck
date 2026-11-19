import type { SendBackRow, StopVerdictRow, SubmissionRow } from "../../ledger.ts";
import type { Timeline } from "../timeline.ts";
import type { RailModel } from "./model.ts";
import { carryMoved, changesByStop, stopIdentities, stopStates, type StopStatus } from "./stop-status.ts";

/**
 * The passes of a review. Pure: the model, the timeline body, the verdict rows, the send-backs and the submissions in; the markers,
 * the tag of each stop after a marker and the links between a failed stop and its rework out. No model call, no clock: file history only.
 *
 * A marker is a person's action (a send-back or a submission) at its recorded time. It sits between the last stop at or before that time
 * and the next one, and the stops after it, up to the next marker, are the next pass. Each change stop of a pass is tagged against the
 * verdicts as they stood at that pass's marker:
 * - "reworks": its file had a failed stop. The tag names that stop; that stop lists the reworks forward.
 * - "changes_passed": its file was passed (and not failed).
 * - "new": its file had no stop before the marker, or none with a verdict then.
 * Which verdict a file has: its latest stop before the marker that has a verdict as of the marker. Failed wins: a file with a failed stop
 * since the previous marker is a rework even when a later stop of it was passed. A verdict given after the marker, or on bytes the stop no
 * longer has, is not a verdict at the marker. A stop with no file (a request, a failed call, a wake) gets no tag.
 */

export interface PassMarker {
  id: string;
  kind: "sent_back" | "submitted";
  label: string;
  ts: string;
  /** 1 for the first marker; the stops after it are that pass's. */
  pass: number;
  /** The first stop after the marker (the marker is drawn just above it); null when no stop follows it. */
  beforeStop: string | null;
}

/** What came after the latest sign-off: stops whose verdict or file version differs from what the sign-off covered, and stops it did not cover at all. */
export interface AfterSignoff {
  changed: string[];
  newSteps: string[];
}

export interface StopTag {
  tag: "reworks" | "changes_passed" | "new";
  text: string;
  pass: number;
  /** For "reworks": the failed stop this stop answers. */
  answers?: string;
}

export interface Passes {
  markers: PassMarker[];
  tags: Record<string, StopTag>;
  /** Against the latest sign-off only. An old sign-off never reads as covering a step or verdict that came after it. */
  afterSignoff: AfterSignoff;
  /** A failed stop to the stops that rework it, in rail order. */
  answeredBy: Record<string, string[]>;
}

const TAG_TEXT: Record<StopTag["tag"], string> = {
  reworks: "Reworks a stop you failed",
  changes_passed: "Changes something you passed",
  new: "New since the review",
};
const NEW_SINCE_SIGNOFF = "New since you signed off";

/** The date a sign-off marker shows: the UTC day of the record's time. */
const dayOf = (ts: string): string => ts.slice(0, 10);

/** The words on the rail line at a sign-off (its hover text; the line itself shows "Signed off"). The count is of changes, the unit of the progress line. A sign-off with changes not looked at says so, so the line never claims more than the person did. */
export function signoffMarkerLabel(reviewer: string, ts: string, notLooked: number): string {
  return `Signed off by ${reviewer}, ${dayOf(ts)}: everything above this line was reviewed${notLooked > 0 ? ` except ${notLooked} ${notLooked === 1 ? "change" : "changes"} not looked at` : ""}`;
}

/**
 * Stops that differ from what `sub` covered. A stop is "changed" when its status now or its file version differs from the one the sign-off
 * recorded, "new" when the sign-off did not list it. A sign-off with no covered list (written before it was recorded) falls back to times:
 * a stop after the sign-off is new, a stop with a verdict row after it is changed.
 */
export function afterSignoff(model: RailModel, timeline: Timeline, rawRows: StopVerdictRow[], sub: SubmissionRow | undefined): AfterSignoff {
  const out: AfterSignoff = { changed: [], newSteps: [] };
  if (sub === undefined) return out;
  const rows = carryMoved(model, timeline, rawRows).rows;
  const states = stopStates(model.stops, stopIdentities(model, timeline), rows);
  const changes = changesByStop(timeline);
  const at = Date.parse(sub.ts);
  const covered = sub.covered === null ? null : new Map(sub.covered.map((c) => [c.stop, c]));
  for (const stop of model.stops) {
    // A sign-off that covered only the gone record of a move covers the moved stop, compared against that record's own bytes.
    const old = stop.moved !== undefined && !covered?.has(stop.id) ? stop.moved.fromStop : undefined;
    const was = covered?.get(old ?? stop.id);
    if (covered !== null ? was === undefined : (stop.at ?? Number.NEGATIVE_INFINITY) > at) out.newSteps.push(stop.id);
    else if (was !== undefined) {
      if ((states.get(stop.id)?.status ?? "not_reviewed") !== was.status || (changes.get(old ?? stop.id)?.after.sha256 ?? null) !== was.sha256) out.changed.push(stop.id);
    } else if (rows.some((r) => r.stopId === stop.id && Date.parse(r.ts) > at)) out.changed.push(stop.id);
  }
  return out;
}

export function buildPasses(model: RailModel, timeline: Timeline, rawRows: StopVerdictRow[], sendBacks: SendBackRow[], submissions: SubmissionRow[]): Passes {
  const rows = carryMoved(model, timeline, rawRows).rows;
  const at = (i: number): number => model.stops[i]!.at ?? Number.NEGATIVE_INFINITY;
  // Only changes count, as on the progress line; the acknowledged list also holds requests, replies and failed runs.
  const changes = changesByStop(timeline);
  const raw = [
    ...sendBacks.map((s) => ({ id: `sendback-${s.id}`, kind: "sent_back" as const, label: "Sent back for review", ts: s.ts })),
    ...submissions.map((s) => ({ id: `submit-${s.id}`, kind: "submitted" as const, label: signoffMarkerLabel(s.reviewer, s.ts, s.acknowledged.filter((id) => changes.has(id)).length), ts: s.ts })),
  ].map((m) => ({ ...m, ms: Date.parse(m.ts) })).filter((m) => Number.isFinite(m.ms));
  // Stable: markers at one time keep send-backs before submissions.
  const timed = raw.map((m, i) => ({ m, i })).sort((a, b) => a.m.ms - b.m.ms || a.i - b.i).map((x) => x.m);
  const cut = timed.map((m) => {
    const i = model.stops.findIndex((_, k) => at(k) > m.ms);
    return i < 0 ? model.stops.length : i;
  });
  const markers: PassMarker[] = timed.map((m, k) => ({ id: m.id, kind: m.kind, label: m.label, ts: m.ts, pass: k + 1, beforeStop: cut[k]! < model.stops.length ? model.stops[cut[k]!]!.id : null }));
  const tags: Passes["tags"] = {};
  const answeredBy: Passes["answeredBy"] = {};
  const signoff = afterSignoff(model, timeline, rows, submissions.at(-1));
  if (timed.length === 0) return { markers, tags, afterSignoff: signoff, answeredBy };

  const identities = stopIdentities(model, timeline);
  const subjectOf = (i: number): string | null => (model.stops[i]!.change !== undefined ? identities.get(model.stops[i]!.id)?.subject ?? null : null);
  /** The status of stop `i` as of `ms`: the latest verdict row on this stop's own bytes that was given by then. */
  const statusAt = (i: number, ms: number): StopStatus => {
    const stop = model.stops[i]!, me = identities.get(stop.id);
    if (me === undefined) return "not_reviewed";
    return rows.findLast((r) => r.stopId === stop.id && r.fingerprint === me.fingerprint && Date.parse(r.ts) <= ms)?.status ?? "not_reviewed";
  };

  timed.forEach((m, k) => {
    const from = cut[k]!, to = k + 1 < timed.length ? cut[k + 1]! : model.stops.length;
    const windowFrom = k === 0 ? 0 : cut[k - 1]!;
    for (let i = from; i < to; i++) {
      const subject = subjectOf(i);
      if (subject === null) continue;
      const earlier: number[] = [];
      for (let j = 0; j < from; j++) if (subjectOf(j) === subject) earlier.push(j);
      let tag: StopTag["tag"] = "new";
      let answers: string | undefined;
      // The latest stop of the file with a verdict at the marker decides; a failed stop since the previous marker beats a later pass.
      const decider = earlier.findLast((j) => statusAt(j, m.ms) !== "not_reviewed");
      if (decider !== undefined) {
        const status = statusAt(decider, m.ms);
        const failedSince = earlier.findLast((j) => j >= windowFrom && statusAt(j, m.ms) === "failed");
        const failed = status === "failed" ? decider : failedSince;
        if (failed !== undefined) {
          tag = "reworks";
          answers = model.stops[failed]!.id;
        } else tag = "changes_passed";
      }
      const id = model.stops[i]!.id;
      tags[id] = { tag, text: tag === "new" && m.kind === "submitted" ? NEW_SINCE_SIGNOFF : TAG_TEXT[tag], pass: k + 1, ...(answers === undefined ? {} : { answers }) };
      if (answers !== undefined) (answeredBy[answers] ??= []).push(id);
    }
  });
  return { markers, tags, afterSignoff: signoff, answeredBy };
}
