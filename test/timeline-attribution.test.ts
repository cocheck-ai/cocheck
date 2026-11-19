import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type Change, type FormatChanges, type Timeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { renderGenericPage } from "../src/timeline/page.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { hostOfClient } from "../src/timeline/attribution.ts";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// who made a change is decided once (`attributionOf`, src/timeline/attribution.ts), and every surface takes its wording
// from that decision. Table-driven over the five states (call, joint, lost, during, outside), each built from ledger-shaped rows,
// with and without expired values, and rendered through every surface: the rail stop (lane, chip, head, side text), the stop's note
// and row notes, the page's who text and short who, the credit text, the timeline's missing list and the serialized body.
//
// Guarded both ways: a change that is not outside never reads outside and is never on the `other` lane; an outside
// change never names Claude, a helper or a host and is never on an agent lane; a lost, during or cross-lane joint change is never on
// `claude` or `agent:n`.

const FILE = "/w/book.xlsx";
const EXPIRED_AT = "2026-10-01T00:00:00.000Z";
const FMT: FormatChanges = { module: "xlsx", rows: [{ location: "S!B2", kind: "value", before: "1", after: "2", text: "S!B2 changed from 1 to 2" }], more: 0 };
// a connector words its own steps, so the row note is the generic engine's and the change note is
// the whole-file line for a row no connector read. Both still carry the actor of every surface.
const ROW = "changed S!B2 from 1 to 2";
const WHOLE = "changed book.xlsx (the file changed; CoCheck can't read inside it)";

const OUTSIDE_SUB = "Changed between agent calls; CoCheck can't tell who or what wrote it (you, an app, or another process).";
const DURING_OPEN_SUB = (h: string) => `Found while ${h} calls were running, but none of them is credited with it. One of them may have written it, or something else did (you, an app, or another process).`;
const DURING_POST_SUB = (h: string) => `Found as a ${h} call ended that CoCheck had not seen start, so it is not credited with it. That call may have written it, or something else did (you, an app, or another process).`;
const LOST_SUB = (who: string, expired: boolean) => `Credited to ${who} whose record is gone${expired ? " (the task's values expired)" : ""}; CoCheck can't tell which agent made it.`;
const LOST_WHO = (who: string, expired: boolean) => `Credited to ${who} whose record is gone${expired ? " (the task's values expired)" : ""}, so CoCheck can't tell which agent made it.`;
const DURING_WHO = "Found during agent calls, but none of them is credited with it, so CoCheck can't tell what made it.";
const OUTSIDE_WHO = "Made outside the agents: found between agent calls, with no call running. CoCheck can't tell who or what wrote it.";
const LOST_MISSING = (expired: boolean) => `One change is credited to an agent call whose record ${expired ? "expired" : "is gone"}, so CoCheck can't tell which agent made it.`;
const DURING_MISSING = "One change is shown under no call: it was found during agent calls, but none of the calls is credited with it.";
const OUTSIDE_MISSING = "One change is shown under no call: it was found between agent calls, with no call running.";
const DURING_OPEN_CREDIT = "calls were still open, but none can be shown to have made it";
const DURING_POST_CREDIT = "found as a call ended that CoCheck had not seen start, so none can be shown to have made it";
const OUTSIDE_CREDIT = "found between agent calls, with no call running";

type Kind = "call" | "joint" | "lost" | "during" | "outside";

interface Want {
  kind: Kind;
  calls: string[];
  lane: string;
  chip: string;
  /** The rail's name of the main lane. */
  main: string;
  /** Who the head starts with (the rail's own name for the maker). */
  head: string;
  sub: string | undefined;
  /** The note in the body, before the rail names the lane. */
  bodyActor: string;
  /** The note on the rail. */
  railActor: string;
  who: string;
  short: string;
  credit: string;
  missing: string | null;
}

interface Case {
  name: string;
  ops: RawOp[];
  states: RawState[];
  /** The task's host, from the `<host>-hook:` prefix of its client name. */
  host: string | null;
  live: Want;
  expired: Want;
}

const helper = { agent_id: "a1", agent_type: "Explore" };
const changed = (over: Partial<RawState> & { open?: string[]; credited?: string[] }): RawState => {
  const { open = [], credited = [], ...rest } = over;
  return { ...state(FILE, "s1", "s0", { open, credited }), ...rest };
};
const turn = (...calls: RawOp[]): RawOp[] => [prompt("s1", ["Raise B2."]), ...calls, stop("s1")];
const noHost = null as unknown as string;

/** The expired form of a change that was credited to calls: the record of every call went with the values. */
const lostWhenExpired = (host: string | null, main: string): Want => {
  const who = host === null ? "an agent call" : `a ${host} call`;
  return { kind: "lost", calls: [], lane: "unsure", chip: "U", main, head: "An agent call whose record is gone", sub: LOST_SUB(who, true), bodyActor: "An agent call whose record is gone", railActor: "An agent call whose record is gone", who: LOST_WHO(who, true), short: "record gone", credit: "credited to a call whose record expired", missing: LOST_MISSING(true) };
};
const during = (sub: string, credit: string, main = "Claude"): Pick<Case, "live" | "expired"> => {
  const w: Want = { kind: "during", calls: [], lane: "unsure", chip: "U", main, head: "Something, during agent calls,", sub, bodyActor: "Something, during agent calls,", railActor: "Something, during agent calls,", who: DURING_WHO, short: "during agent calls", credit, missing: DURING_MISSING };
  return { live: w, expired: w };
};
const outside = (main = "Claude"): Pick<Case, "live" | "expired"> => {
  const w: Want = { kind: "outside", calls: [], lane: "other", chip: "U", main, head: "Something outside the agents", sub: OUTSIDE_SUB, bodyActor: "Something outside the agents", railActor: "Something outside the agents", who: OUTSIDE_WHO, short: "outside the agents", credit: OUTSIDE_CREDIT, missing: OUTSIDE_MISSING };
  return { live: w, expired: w };
};
const oneCall = (host: string | null, main: string, page: string): Want => ({ kind: "call", calls: ["x"], lane: "claude", chip: main[0] === "T" ? "A" : main[0]!, main, head: main, sub: undefined, bodyActor: main, railActor: main, who: `Credit: ${page} call 1 of 1 (Bash).`, short: "credit", credit: "credited to this call", missing: null });

const CASES: Case[] = [
  {
    name: "call: one call on the main lane",
    ops: turn(call("x", { named: [FILE], at: 10, end: 40 })),
    states: [changed({ open: ["x"], credited: ["x"] })],
    host: "claude",
    live: oneCall("claude", "Claude", "claude"),
    expired: lostWhenExpired("Claude", "Claude"),
  },
  {
    name: "call: two calls on the main lane (joint on one lane stays on it)",
    ops: turn(call("x", { named: [FILE], at: 10, end: 40 }), call("y", { named: [FILE], at: 20, end: 30 })),
    states: [changed({ open: ["x", "y"], credited: ["x", "y"] })],
    host: "claude",
    live: { kind: "call", calls: ["x", "y"], lane: "claude", chip: "C", main: "Claude", head: "Claude", sub: undefined, bodyActor: "Claude", railActor: "Claude", who: "Joint: claude call 1 of 2 (Bash) and claude call 2 of 2 (Bash) overlapped, so the change is credited to all of them.", short: "joint", credit: "credited jointly to 2 calls that overlapped", missing: null },
    expired: lostWhenExpired("Claude", "Claude"),
  },
  {
    name: "call: one helper call goes on the helper's lane",
    ops: turn(call("h", { named: [FILE], at: 10, end: 40, extra: helper })),
    states: [changed({ open: ["h"], credited: ["h"] })],
    host: "claude",
    live: { kind: "call", calls: ["h"], lane: "agent:1", chip: "1", main: "Claude", head: "Helper 1", sub: undefined, bodyActor: "Claude", railActor: "Helper 1", who: "Credit: claude call 1 of 1 (Bash).", short: "credit", credit: "credited to this call", missing: null },
    expired: lostWhenExpired("Claude", "Claude"),
  },
  {
    name: "joint: Claude and a helper, on the neutral lane",
    ops: turn(call("x", { named: [FILE], at: 10, end: 40 }), call("h", { named: [FILE], at: 20, end: 30, extra: helper })),
    states: [changed({ open: ["x", "h"], credited: ["x", "h"] })],
    host: "claude",
    live: { kind: "joint", calls: ["x", "h"], lane: "unsure", chip: "U", main: "Claude", head: "Claude or Helper 1", sub: "Changed while Claude and Helper 1 were running; the record credits all of them, so CoCheck can't tell which one wrote it.", bodyActor: "Claude or a helper", railActor: "Claude or Helper 1", who: "Joint: claude call 1 of 2 (Bash) and claude call 2 of 2 (Bash) overlapped, so the change is credited to all of them.", short: "joint", credit: "credited jointly to 2 calls that overlapped", missing: null },
    expired: lostWhenExpired("Claude", "Claude"),
  },
  {
    name: "lost: the credited call has no record",
    ops: turn(),
    states: [changed({ open: ["ghost"], credited: ["ghost"] })],
    host: "claude",
    live: { kind: "lost", calls: [], lane: "unsure", chip: "U", main: "Claude", head: "An agent call whose record is gone", sub: LOST_SUB("a Claude call", false), bodyActor: "An agent call whose record is gone", railActor: "An agent call whose record is gone", who: LOST_WHO("a Claude call", false), short: "record gone", credit: "credited to a call the record no longer holds", missing: LOST_MISSING(false) },
    expired: lostWhenExpired("Claude", "Claude"),
  },
  {
    name: "lost: one credited call on record and one gone",
    ops: turn(call("x", { named: [FILE], at: 10, end: 40 })),
    states: [changed({ open: ["x", "ghost"], credited: ["x", "ghost"] })],
    host: "claude",
    live: { kind: "lost", calls: ["x"], lane: "unsure", chip: "U", main: "Claude", head: "An agent call whose record is gone", sub: "Credited to Claude and to an agent call whose record is gone; CoCheck can't tell which one made it.", bodyActor: "An agent call whose record is gone", railActor: "An agent call whose record is gone", who: "Credited to claude call 1 of 1 (Bash) and to an agent call whose record is gone, so CoCheck can't tell which one made it.", short: "record gone", credit: "credited jointly to 2 calls; the record no longer holds one of them", missing: LOST_MISSING(false) },
    expired: lostWhenExpired("Claude", "Claude"),
  },
  {
    name: "during: the Stop sweep with a background call open",
    ops: turn(call("bg", { named: [], at: 10, by: "stop", background: true })),
    states: [changed({ phase: "Stop", open: ["bg"], credited: [] })],
    host: "claude",
    ...during(DURING_OPEN_SUB("Claude"), DURING_OPEN_CREDIT),
  },
  {
    name: "during: a Post whose Pre was never seen",
    ops: turn(call("g", { named: [FILE], at: 10, by: "ghost-post" })),
    states: [changed({ phase: "Post", open: [], credited: [] })],
    host: "claude",
    ...during(DURING_POST_SUB("Claude"), DURING_POST_CREDIT),
  },
  {
    name: "during: a legacy record from before schema 12 (no credited_json, the calls open at the sweep)",
    ops: turn(call("x", { named: [FILE], at: 10, end: 40 })),
    states: [(() => { const s = changed({ phase: "Post", open: ["x"] }); delete s.credited_json; return s; })()],
    host: "claude",
    ...during(DURING_OPEN_SUB("Claude"), DURING_OPEN_CREDIT),
  },
  {
    name: "outside: found at a Pre with no call open",
    ops: turn(call("x", { named: [], at: 50, end: 60 })),
    states: [changed({ phase: "Pre", open: [], credited: [] })],
    host: "claude",
    ...outside(),
  },
  {
    name: "outside: found at a Stop with nothing open",
    ops: turn(),
    states: [changed({ phase: "Stop", open: [], credited: [] })],
    host: "claude",
    ...outside(),
  },
  {
    name: "host missing on the call: the task's host names it",
    ops: turn(call("x", { named: [FILE], at: 10, end: 40, host: noHost })),
    states: [changed({ open: ["x"], credited: ["x"] })],
    host: "claude",
    live: oneCall("claude", "Claude", "claude"),
    expired: lostWhenExpired("Claude", "Claude"),
  },
  {
    name: "no host anywhere: the agent",
    ops: turn(call("x", { named: [FILE], at: 10, end: 40, host: noHost })),
    states: [changed({ open: ["x"], credited: ["x"] })],
    host: null,
    live: oneCall(null, "The agent", "agent"),
    expired: lostWhenExpired(null, "The agent"),
  },
  {
    name: "Codex host",
    ops: turn(call("x", { named: [FILE], at: 10, end: 40, host: "codex" })),
    states: [changed({ open: ["x"], credited: ["x"] })],
    host: "codex",
    live: oneCall("codex", "Codex", "codex"),
    expired: lostWhenExpired("Codex", "Codex"),
  },
  {
    name: "outside with no host anywhere",
    ops: turn(),
    states: [changed({ phase: "Pre", open: [], credited: [] })],
    host: null,
    ...outside("The agent"),
  },
  {
    name: "during, Codex host",
    ops: turn(call("bg", { named: [], at: 10, by: "stop", background: true, host: "codex" })),
    states: [changed({ phase: "Stop", open: ["bg"], credited: [] })],
    host: "codex",
    ...during(DURING_OPEN_SUB("Codex"), DURING_OPEN_CREDIT, "Codex"),
  },
];

const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function build(c: Case, expired: boolean): { t: Timeline; body: Timeline; model: RailModel; html: string; change: Change } {
  const stateId = c.states[0]!.id;
  const input = {
    taskId: 1,
    build: "b",
    ops: c.ops,
    fileStates: c.states,
    folder: "/w",
    valuesExpiredAt: expired ? EXPIRED_AT : null,
    removals: [],
    stored: new Map<string, number>(),
    formats: expired ? new Map<number, FormatChanges>() : new Map([[stateId, FMT]]),
    quickLook: false,
    host: c.host,
  } as TimelineInput;
  const t = buildTimeline(input);
  // Every surface reads the served body: the timeline as JSON, parsed back.
  const body = JSON.parse(JSON.stringify(t)) as Timeline;
  const all = [...body.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.flatMap((x) => x.changes))), ...body.unplaced];
  const change = all.find((x) => x.id === `c${stateId}`)!;
  assert.ok(change, `${c.name}: the change is in the body`);
  return { t, body, model: buildRailModel(body), html: renderGenericPage(body, "tok"), change };
}

const FORBIDDEN_OFF_OUTSIDE = ["outside the agents", "between agent calls", "no call is credited", "Not from an agent call"];

describe("one attribution, every surface", () => {
  for (const c of CASES) {
    for (const expired of [false, true]) {
      const w = expired ? c.expired : c.live;
      it(`${c.name}${expired ? ", values expired" : ""}`, () => {
        const { body, model, html, change } = build(c, expired);
        const by = (change as unknown as { by?: { kind: string; calls: string[]; expired: boolean } }).by;
        // The serialized body.
        assert.deepEqual(by && { kind: by.kind, calls: by.calls, expired: by.expired }, { kind: w.kind, calls: w.calls, expired });
        assert.equal(change.credit.text, w.credit);
        const note = `${w.bodyActor} ${WHOLE}`;
        assert.equal(change.note.text, note);
        // The rail.
        const stops = model.stops.filter((s) => s.change?.key === change.id);
        assert.equal(stops.length, 1, "one stop per change");
        const stop = stops[0]!;
        assert.equal(stop.lane, w.lane);
        assert.equal(model.actors.find((a) => a.id === stop.lane)?.chip, w.chip);
        assert.equal(model.actors.find((a) => a.id === "claude")?.name, w.main);
        assert.equal(stop.head, `${w.head} changed book.xlsx`);
        assert.equal(stop.sub, w.sub);
        assert.equal(stop.change!.note, `${w.railActor} ${WHOLE}`);
        assert.deepEqual(stop.change!.rowNotes, expired ? [] : [{ location: "S!B2", text: `${w.railActor} ${ROW}` }]);
        if (w.lane === "unsure") {
          const lane = model.actors.find((a) => a.id === "unsure")!;
          assert.deepEqual([lane.name, lane.chip, lane.color], ["Unknown", "U", "#7a7f88"]);
        }
        // The page.
        assert.ok(html.includes(`<dt>Who</dt><dd>${esc(w.who)}</dd>`), `page who text: ${w.who}\n${/<dt>Who<\/dt><dd>[^<]*/.exec(html)?.[0]}`);
        assert.ok(html.includes(`<summary>book.xlsx - 1 change - ${esc(w.short)}</summary>`), `page short who: ${w.short}\n${/<summary>book[^<]*/.exec(html)?.[0]}`);
        // The missing list.
        const said = body.missing.filter((m) => /shown under no call|whose record|no call/.test(m));
        assert.deepEqual(said, w.missing === null ? [] : [w.missing]);
      });
    }
  }
});

describe("guarded both ways", () => {
  for (const c of CASES) {
    for (const expired of [false, true]) {
      const w = expired ? c.expired : c.live;
      it(`${c.name}${expired ? ", values expired" : ""}: ${w.kind}`, () => {
        const { body, model, html, change } = build(c, expired);
        const stop = model.stops.find((s) => s.change?.key === change.id)!;
        // What belongs to this change alone: its body entry, its stop, its page card.
        const card = /<article class="card"[\s\S]*?<\/article>/.exec(html)![0];
        const own = [JSON.stringify(change), JSON.stringify(stop), card].join("\n");
        const whole = [JSON.stringify(body), JSON.stringify(model), html].join("\n");
        if (w.kind !== "outside") {
          // Over the whole served page and model: no outside wording (the legend's lane name "Unknown" is a lane label, capitalised).
          for (const s of FORBIDDEN_OFF_OUTSIDE) assert.ok(!whole.includes(s), `${s} in a ${w.kind} body`);
          for (const s of FORBIDDEN_OFF_OUTSIDE) assert.ok(!own.toLowerCase().includes(s.toLowerCase()), `${s} on a ${w.kind} change`);
          assert.ok(!/not from an agent call/i.test(own), "the hook's ledger words never reach a non-outside change");
          assert.notEqual(stop.lane, "other");
        } else {
          assert.ok(!/claude|codex|helper|gemini|cursor/i.test(own), `an outside change names an agent:\n${own}`);
          assert.equal(stop.lane, "other");
        }
        if (w.kind === "lost" || w.kind === "during" || w.kind === "joint") {
          assert.ok(stop.lane !== "claude" && !stop.lane!.startsWith("agent:"), `${w.kind} on ${stop.lane}`);
        }
      });
    }
  }
});

describe("the pieces around the rule", () => {
  it("reads the task's host from the hook client name, and nothing from any other client", () => {
    assert.equal(hostOfClient("claude-hook:/Users/user/work"), "claude");
    assert.equal(hostOfClient("codex-hook:/w"), "codex");
    assert.equal(hostOfClient("mcp-client"), null);
    assert.equal(hostOfClient(null), null);
  });

  it("serves the ledger note without the hook's attribution words", () => {
    const body = (note: string, phase: string) => buildTimeline({ taskId: 1, build: "b", ops: [], fileStates: [{ ...state(FILE, "s1", "s0"), note, phase }], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, host: "claude" } as TimelineInput).unplaced[0]!;
    assert.equal(body("not from an agent call", "Pre").ledgerNote, null);
    assert.equal(body("over 10 MB (12 MB): only this file's first and current state are kept; calls were still open, but none can be shown to have made it", "Post").ledgerNote, "over 10 MB (12 MB): only this file's first and current state are kept");
  });

  it("names the actors and lanes in attribution.ts only; everywhere else imports them", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.join(import.meta.dirname, "..", "src");
    const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".ts") && !f.endsWith("attribution.ts")).map((f) => path.join(root, f));
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const line of text.split("\n")) {
        if (/^import /.test(line)) continue;
        for (const word of ["OUTSIDE_ACTOR", "LOST_CALL_ACTOR", "DURING_ACTOR", "OUTSIDE_SIDE_TEXT", "Something outside the agents", "An agent call whose record is gone", "Something, during agent calls"]) assert.ok(!line.includes(word), `${path.relative(root, file)}: ${line.trim()}`);
      }
    }
    // The surfaces never read the credit or the raw credited list to decide who.
    for (const rel of ["timeline/rail/model.ts", "timeline/page.ts"]) assert.ok(!/credit\.|\.credited\b/.test(await readFile(path.join(root, rel), "utf8")), `${rel} reads the credit`);
    // The lane ids, as string literals, in the files that place changes on lanes or word them.
    for (const rel of ["timeline/rail/model.ts", "timeline/page.ts", "timeline/timeline.ts", "timeline/notes.ts"]) {
      const text = await readFile(path.join(root, rel), "utf8");
      for (const lane of ['"claude"', '"other"', '"unsure"', '"agent:', "`agent:"]) assert.ok(!text.includes(lane), `${rel} spells ${lane}`);
    }
  });
});
