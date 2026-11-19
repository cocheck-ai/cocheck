// The attribution replay harness. A fixture (scripts/attribution-fixture.ts) holds a recorded drive's call ops, its file states, how each
// call ended according to the host's transcripts, and the golden owner of every change. The timeline is rebuilt from those rows by the
// pure builder (`buildTimeline`), and each change's `by` is scored against its golden owner:
//   exact            the change sits on one lane, the golden owner's;
//   joint            the change is "can't tell which" among calls that include the golden owner's;
//   wrongSingle      the change sits on one lane that is not the golden owner's (a wrong credit);
//   wronglyOutside   the change reads "outside the agents" though an agent wrote it (a wrong credit);
//   during / lost    no call credited (found during calls) / a credited call's record is gone.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CallEvidence, CannotWrite } from "../../src/credit-guard.ts";
import { guardKit } from "../../src/credit-guard.ts";
import { cannotHaveWritten, lexicalProbe, writeScope, type WriteScope } from "../../src/attribution/write-scope.ts";
import type { RawOp, RawState } from "../../src/timeline/runs.ts";
import type { Change, Timeline, TimelineInput } from "../../src/timeline/timeline.ts";

export interface ReplayFixture {
  name: string;
  folder: string;
  host: string | null;
  ops: RawOp[];
  fileStates: RawState[];
  evidence: Record<string, CallEvidence>;
  /** Golden owner per file state id: a helper's agent id, or "main". */
  golden: Record<string, { owner: string; from: string; why?: string }>;
}

export type Score = { changes: number; exact: number; joint: number; wrongSingle: number; wronglyOutside: number; during: number; lost: number; misses: string[] };

export function readFixture(name: string): ReplayFixture {
  return JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "fixtures", "attribution", `${name}.json`), "utf8")) as ReplayFixture;
}

/**
 * The "cannot have written" provider for a recorded drive: each Bash call's write scope from its recorded command and cwd (a command
 * the fixture scrub changed is unknown), its children's hook facts as recorded, and the lexical probe (the drive's paths are not on this
 * machine, so no symlink check: the live adapter makes it).
 */
export function cannotWriteFromFixture(f: ReplayFixture): CannotWrite {
  type Hook = { wrote: number; spawned: boolean; covered: boolean; starts?: Array<{ path: string; pid: number; ppid?: number }> };
  const calls = new Map<string, { scope: WriteScope; tagged: boolean; hook?: Hook }>();
  for (const op of f.ops) {
    if (op.tool !== "Bash") continue;
    const a = JSON.parse(op.args_json ?? "{}") as { tool_use_id?: string; agent_id?: string | null; cwd?: string; scrubbed?: boolean; tagged?: boolean; hook?: Hook };
    if (typeof a.tool_use_id !== "string") continue;
    // a helper's transcript cwd is the main thread's (as its payload cwd is): none, as the adapter has it; the Pre probe is lexical (the drive's
    // folders are not on this machine; they existed when it ran)
    const cwd = a.agent_id ? null : (a.cwd ?? null);
    const scope: WriteScope = a.scrubbed === true ? { known: false, why: "scrubbed" } : writeScope(op.intent ?? "", cwd, { pre: lexicalProbe });
    calls.set(a.tool_use_id, { scope, tagged: a.tagged === true, ...(a.hook ? { hook: a.hook } : {}) });
  }
  const inFolder = (file: string) => file.startsWith(f.folder + "/");
  return (id, file) => {
    const c = calls.get(id);
    if (!c) return false;
    const facts = c.hook ? { tagged: c.tagged, wrote: c.hook.wrote, spawned: c.hook.spawned, covered: c.hook.covered && inFolder(file), starts: c.hook.starts ?? [] } : undefined;
    return cannotHaveWritten(file, c.scope, facts, lexicalProbe, guardKit("darwin"));
  };
}

export function replayInput(f: ReplayFixture, withEvidence = true, withExclusion = true): TimelineInput {
  return {
    taskId: 1,
    build: "replay",
    ops: f.ops,
    fileStates: f.fileStates,
    folder: f.folder,
    valuesExpiredAt: null,
    removals: [],
    stored: new Map(),
    formats: new Map(),
    quickLook: false,
    host: f.host,
    ...(withEvidence ? { evidence: new Map(Object.entries(f.evidence)) } : {}),
    ...(withExclusion ? { cannotWrite: cannotWriteFromFixture(f) } : {}),
  };
}

function changesOf(t: Timeline): Change[] {
  const out = new Map<string, Change>();
  for (const r of t.requests) for (const run of r.runs) for (const c of run.calls) for (const ch of c.changes ?? []) out.set(ch.id, ch);
  for (const ch of t.unplaced) out.set(ch.id, ch);
  return [...out.values()];
}

/** Scores a built timeline against the fixture's golden owners. `build` is the timeline builder under test. */
export function score(f: ReplayFixture, build: (input: TimelineInput) => Timeline, input: TimelineInput = replayInput(f)): Score {
  const laneOf = new Map<string, string>();
  for (const op of f.ops) {
    const a = JSON.parse(op.args_json ?? "{}") as { tool_use_id?: string; agent_id?: string | null };
    if (typeof a.tool_use_id === "string") laneOf.set(a.tool_use_id, a.agent_id ?? "main");
  }
  const s: Score = { changes: 0, exact: 0, joint: 0, wrongSingle: 0, wronglyOutside: 0, during: 0, lost: 0, misses: [] };
  for (const ch of changesOf(build(input))) {
    const id = ch.id.replace(/^c/, "");
    const golden = f.golden[id];
    if (!golden) continue;
    s.changes++;
    const lanes = [...new Set(ch.by.calls.map((c) => laneOf.get(c) ?? "?"))];
    const miss = (kind: string) => s.misses.push(`${id} ${kind}: golden ${golden.owner}, credited lanes [${lanes.join(", ")}] (${ch.file})`);
    switch (ch.by.kind) {
      case "call":
        if (lanes.length === 1 && lanes[0] === golden.owner) s.exact++;
        else {
          s.wrongSingle++;
          miss("wrong single owner");
        }
        break;
      case "joint":
        s.joint++;
        miss("joint");
        if (!lanes.includes(golden.owner)) {
          s.wrongSingle++;
          miss("joint without the owner");
        }
        break;
      case "outside":
        s.wronglyOutside++;
        miss("outside");
        break;
      case "during":
        s.during++;
        miss("during");
        break;
      case "lost":
        s.lost++;
        miss("lost");
        break;
    }
  }
  return s;
}
