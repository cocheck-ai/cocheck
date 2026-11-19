import { createHash } from "node:crypto";
import type { StopVerdictRow, SubmissionRow } from "../../ledger.ts";
import type { Timeline } from "../timeline.ts";
import type { RailModel, RailStop } from "./model.ts";

/**
 * The review status of each rail stop. Pure: the model, the timeline body and the verdict rows in, the statuses out.
 *
 * A stop is "not reviewed", "passed" or "failed". The current status is the latest verdict row of that stop, and only while the row's
 * fingerprint equals the stop's fingerprint now. A stop whose content changed after a verdict reads "not reviewed" again; the row stays
 * in its history. History is every row of the stop's subject (a change stop's subject is its file), oldest first, so a new state of the
 * same file shows the verdicts given on the earlier states.
 */

export type StopStatus = "not_reviewed" | "passed" | "failed";

export interface StopHistoryEntry {
  id: number;
  stop: string;
  status: StopStatus;
  note: string;
  reviewer: string;
  ts: string;
  /** True when the verdict was given on this stop's content as it is now. */
  current: boolean;
}

export interface StopState {
  status: StopStatus;
  /** The note of the current verdict; "" when not reviewed. */
  note: string;
  /** Set when a verdict was given on content the stop no longer has. */
  stale: boolean;
  history: StopHistoryEntry[];
}

export interface StopIdentity {
  fingerprint: string;
  subject: string;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Every change of the body by its stop id ("chg-" and the change id): the record a change stop is built from. */
export function changesByStop(timeline: Timeline): Map<string, Timeline["unplaced"][number]> {
  const changes = new Map<string, Timeline["unplaced"][number]>();
  for (const c of [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((k) => k.changes)))]) changes.set(`chg-${c.id}`, c);
  return changes;
}

/**
 * A moved or renamed step is one stop (`RailStop.moved`), but the gone record's stop id (`moved.fromStop`) may hold verdict rows from before the
 * two were paired. Those rows are carried onto the moved stop: their stop id, subject and fingerprint become the moved stop's (the row id stays,
 * so its regions still resolve), in recording order, so the newest verdict on either id is the one in force. A send-back or submission that named
 * the old id names the moved stop too. A failed verdict on the old record therefore still blocks sign-off and is still sent back.
 */
export function carryMoved(model: RailModel, timeline: Timeline, rows: StopVerdictRow[], events?: VerdictEvent[]): { rows: StopVerdictRow[]; events: VerdictEvent[] | undefined } {
  const moved = model.stops.filter((s) => s.moved !== undefined);
  if (moved.length === 0) return { rows, events };
  const identities = stopIdentities(model, timeline);
  const into = new Map(moved.map((s) => [s.moved!.fromStop, s]));
  const oldSubject = new Map(moved.map((s) => [`file:${s.moved!.from}`, s]));
  const out = rows.map((r) => {
    const stop = into.get(r.stopId);
    const me = stop && identities.get(stop.id);
    if (stop && me) return { ...r, stopId: stop.id, subject: me.subject, fingerprint: me.fingerprint };
    const by = oldSubject.get(r.subject), id = by && identities.get(by.id);
    return by && id ? { ...r, subject: id.subject } : r;
  });
  const ev = events?.map((e) => (e.stops === null ? e : { ...e, stops: [...e.stops, ...e.stops.flatMap((id) => (into.has(id) ? [into.get(id)!.id] : []))] }));
  return { rows: out, events: ev };
}

/** The identity of every stop: what a verdict on it is bound to. A change stop is bound to its before and after bytes; any other stop to its words. */
export function stopIdentities(model: RailModel, timeline: Timeline): Map<string, StopIdentity> {
  const changes = changesByStop(timeline);
  const out = new Map<string, StopIdentity>();
  for (const stop of model.stops) {
    const c = changes.get(stop.id);
    if (stop.change !== undefined && c !== undefined) {
      out.set(stop.id, { fingerprint: sha(`chg\0${c.file}\0${c.kind}\0${c.before?.sha256 ?? ""}\0${c.after.sha256}`), subject: `file:${c.file}` });
    } else {
      out.set(stop.id, { fingerprint: sha(`stop\0${stop.id}\0${stop.head}\0${stop.request?.text ?? ""}`), subject: `stop:${stop.id}` });
    }
  }
  return out;
}

/** A moment a verdict took effect: a send-back (it names the stops it sent) or a submission (it lists the stops it covered; null when it listed none, so every stop). */
export interface VerdictEvent { ts: string; stops: string[] | null }

/** The send-backs and submissions of a task as the events that give a verdict effect. */
export function verdictEvents(sent: Array<{ ts: string; stopIds: string[] }>, submissions: SubmissionRow[]): VerdictEvent[] {
  return [
    ...sent.map((b) => ({ ts: b.ts, stops: b.stopIds })),
    ...submissions.map((s) => ({ ts: s.ts, stops: s.covered === null ? null : s.covered.map((c) => c.stop) })),
  ];
}

/**
 * The ids of the verdict rows that took effect: the one in force for a stop when a send-back named it or a submission covered it (the stop's
 * latest row at or before that moment). A verdict replaced or withdrawn before either left no effect. The ledger keeps every row; this only
 * decides which the page is given.
 */
function effectiveRowIds(rows: StopVerdictRow[], events: VerdictEvent[]): Set<number> {
  const out = new Set<number>();
  for (const ev of events) {
    const at = Date.parse(ev.ts);
    const inForce = new Map<string, StopVerdictRow>();
    for (const r of rows) if (Date.parse(r.ts) <= at && (ev.stops === null || ev.stops.includes(r.stopId))) inForce.set(r.stopId, r);
    for (const r of inForce.values()) if (r.status !== "not_reviewed") out.add(r.id);
  }
  return out;
}

export function stopStates(stops: RailStop[], identities: ReadonlyMap<string, StopIdentity>, rows: StopVerdictRow[], events?: VerdictEvent[]): Map<string, StopState> {
  const effective = events === undefined ? null : effectiveRowIds(rows, events);
  const out = new Map<string, StopState>();
  for (const stop of stops) {
    const me = identities.get(stop.id);
    if (me === undefined) continue;
    const own = rows.filter((r) => r.stopId === stop.id);
    // The latest verdict given on this content. A verdict on other content in between does not hide it, so content that returns to
    // bytes it was passed on reads passed again; with no verdict on this content the stop is not reviewed.
    const latest = own.findLast((r) => r.fingerprint === me.fingerprint);
    const live = latest !== undefined;
    out.set(stop.id, {
      status: live ? latest.status : "not_reviewed",
      note: live ? latest.note : "",
      // A verdict exists but none on today's content: the stop was reset by a change.
      stale: own.length > 0 && !live,
      // With the send-backs and submissions known, only verdicts that took effect are listed, plus the current one.
      history: rows
        .filter((r) => r.subject === me.subject)
        .filter((r) => effective === null || effective.has(r.id) || (latest !== undefined && r.id === latest.id && r.status !== "not_reviewed"))
        .map((r) => ({ id: r.id, stop: r.stopId, status: r.status, note: r.note, reviewer: r.reviewer, ts: r.ts, current: r.stopId === stop.id && r.fingerprint === me.fingerprint })),
    });
  }
  return out;
}

export interface ReviewSummary {
  stops: Record<string, StopState>;
  /** For send-back: every failed stop with its note and where it is. */
  failed: Array<{ stop: string; label: string; head: string; file: string | null; note: string }>;
  anyFailed: boolean;
  anyNotReviewed: boolean;
  counts: Record<StopStatus, number>;
  /** What Submit reads. Send-back keeps reading `failed`. */
  submit: SubmitEligibility;
}

export interface SubmitEligibility {
  /** Failed stops that block Submit: current failed stops minus the superseded ones. */
  blocking: string[];
  /** Failed change stops a later state of the same file has replaced. They stay in the history and do not block; the later state needs its own verdict. */
  superseded: string[];
  /** Every stop that is not reviewed now, in rail order, superseded ones included (the conservative choice). Submit needs these acknowledged. */
  notReviewed: string[];
  /** False when a stop blocks, or when there is no stop at all. */
  eligible: boolean;
}

export function summarize(model: RailModel, timeline: Timeline, rawRows: StopVerdictRow[], rawEvents?: VerdictEvent[]): ReviewSummary {
  const { rows, events } = carryMoved(model, timeline, rawRows, rawEvents);
  const states = stopStates(model.stops, stopIdentities(model, timeline), rows, events);
  const counts: Record<StopStatus, number> = { not_reviewed: 0, passed: 0, failed: 0 };
  const failed: ReviewSummary["failed"] = [];
  // A re-save its connector vouches changed nothing, made by no single agent (`history`: no lane, a muted line in the
  // file's history), is no open item: it is not counted and never asks to be looked at before sign-off.
  const open = model.stops.filter((stop) => stop.history === undefined);
  for (const stop of open) {
    const s = states.get(stop.id)!;
    counts[s.status]++;
    if (s.status === "failed") failed.push({ stop: stop.id, label: stop.label, head: stop.head, file: stop.change?.file ?? null, note: s.note });
  }
  const identities = stopIdentities(model, timeline);
  // Superseded: a failed change stop whose file has a later state recorded after a send-back (or a submission) that CARRIED this fail. An unsent
  // fail is never superseded, whatever the agent wrote since the verdict, so it is always offered for Send back and a state the agent wrote
  // between the verdict and the send-back cannot drop it unsent. Once a send-back carried it, the agent acting on it is what replaces it: a
  // state recorded after that send-back retires the fail, so it is never resent and no longer blocks Submit. Re-saving an old fail after that
  // is a new verdict row (a deliberate re-fail by the person), later than the send-back, so it is unsent again and is offered again.
  // The comparison is the carrying event's ts against the later state's recording time (`Change.at`, epoch ms). Where `at` is missing it falls
  // back to recording order, the file state id in the stop id (`chg-c<id>`, append-only), then rail order, never rail order alone.
  const changes = changesByStop(timeline);
  const recorded = (id: string): number | null => { const m = /^chg-c(\d+)$/.exec(id); return m === null ? null : Number(m[1]); };
  const bySubject = new Map<string, Array<{ id: string; i: number }>>();
  model.stops.forEach((stop, i) => { if (stop.change !== undefined) { const k = identities.get(stop.id)?.subject ?? ""; bySubject.set(k, [...(bySubject.get(k) ?? []), { id: stop.id, i }]); } });
  const verdictAt = (id: string): number => {
    const fp = identities.get(id)?.fingerprint;
    const row = rows.findLast((r) => r.stopId === id && r.fingerprint === fp);
    return row === undefined ? Number.NaN : Date.parse(row.ts);
  };
  /** The earliest moment after the verdict that sent it (a send-back that named the stop, or a submission that covered it); null when it was never sent. */
  const sentAt = (id: string): number | null => {
    const given = verdictAt(id);
    if (!Number.isFinite(given)) return null;
    const hits = (events ?? []).filter((ev) => (ev.stops === null || ev.stops.includes(id)) && Date.parse(ev.ts) >= given).map((ev) => Date.parse(ev.ts));
    return hits.length === 0 ? null : Math.min(...hits);
  };
  const replacedBy = (me: { id: string; i: number }, other: { id: string; i: number }, sent: number): boolean => {
    const at = changes.get(other.id)?.at;
    if (typeof at === "number") return at > sent;
    const a = recorded(me.id), b = recorded(other.id);
    return a !== null && b !== null ? b > a : other.i > me.i;
  };
  const superseded = model.stops
    .filter((stop) => stop.change !== undefined && states.get(stop.id)!.status === "failed")
    .filter((stop) => {
      const sent = sentAt(stop.id);
      if (sent === null) return false;
      const group = bySubject.get(identities.get(stop.id)?.subject ?? "") ?? [];
      const me = group.find((g) => g.id === stop.id)!;
      return group.some((g) => g.id !== me.id && replacedBy(me, g, sent));
    })
    .map((s) => s.id);
  const blocking = failed.map((f) => f.stop).filter((id) => !superseded.includes(id));
  const notReviewed = open.filter((stop) => states.get(stop.id)!.status === "not_reviewed").map((s) => s.id);
  return { stops: Object.fromEntries(states), failed, anyFailed: counts.failed > 0, anyNotReviewed: counts.not_reviewed > 0, counts, submit: { blocking, superseded, notReviewed, eligible: model.stops.length > 0 && blocking.length === 0 } };
}
