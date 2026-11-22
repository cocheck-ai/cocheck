import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHookTracked } from "./helpers/track.ts";
import { book, dumpLedger, goldenView, jsonText } from "./hook-corpus.ts";
import { PRODUCTION_BUILTIN_CONNECTORS, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { removeHome } from "./helpers/remove-home.ts";

// Replays of the hook stdin recorded from real host runs (platforms/<host>/versions/<version>/), through the real hook entry
// (`runHook` with a temp CoCheck home, a temp task folder and a temp HOME), and the ledger dump they leave, scrubbed like the corpus goldens.
//
// How a recording is made replayable, per line shape:
//  - Claude Code and Codex 0.162 (`{event, ts, stdin: "<json text>"}`): the stdin text is what the hook read. Recorded scratch paths are
//    rewritten to the temp folder; the transcript or rollout path is rewritten to a temp copy of the recorded session file.
//  - Codex 0.164 (`{probe_event, stdin: {...}}`): same, the rollouts of the main thread and of the helper are copied under the temp
//    `~/.codex/sessions/<day>/` named by thread id, where the adapter looks them up.
//  - Copilot (`{event_arg, stdin: {...}}`): the hook command names the event (`--event <event_arg>`); `<scratch>` becomes the temp
//    root and `<scratch>/ws` the task folder. VS Code's `events-vscode-control.jsonl` is copied to the session's events.jsonl.
// The recordings hold no file contents, so a call that wrote a file gets a stand-in file written right after its Pre (the hook then sees the
// change at the call's Post, the way it would have on the host's machine). `data.csv` and the like are created before the first event.
// The clock is pinned (noon UTC of the recording's day, so it does not depend on the process time zone, one second per event), HOME and COPILOT_HOME point into the temp root.

const PLATFORMS = path.join(import.meta.dirname, "..", "platforms");

export interface Wire {
  /** The hook command's `--event` argument, for a host that names no event in its payload. */
  event?: string;
  /** The stdin object (or text) the hook read. */
  stdin: Record<string, any>;
}

export interface Recording {
  /** The golden's name: `golden-real-<name>.json`. */
  name: string;
  host: "claude" | "codex" | "copilot";
  /** The recording, relative to `platforms/`. */
  file: string;
  /** The calendar day (UTC noon) the clock starts at (the Codex rollout lookup is by day). */
  day: [number, number, number];
  /** Files that exist before the first event. */
  setup?: Record<string, string | Uint8Array>;
  /** The recording is Copilot's own events of another host's format (Pascal-cased, snake_case): the hook records nothing for them, and the golden holds that empty ledger. */
  recordsNothing?: boolean;
  /** A recording of the host's own file-write tools: the tools its golden must hold ops for, and the files whose Post states must credit a call. */
  fileTools?: { tools: string[]; files: string[] };
  /** The wire form of one recorded line. */
  wire: (line: any) => Wire;
  /** The file a recorded Pre call leaves behind: written right after that record is replayed. */
  writes: (w: Wire, index: number) => Array<{ file: string; data: string | Uint8Array }>;
  /** Recorded session files to copy into the temp tree: `from` relative to `platforms/`, `to` relative to the temp root. */
  copies?: Array<{ from: string; to: string }>;
  /** Replace the recorded transcript or rollout path in a payload with the temp copy's. */
  transcript?: (stdin: Record<string, any>, root: string) => void;
}

const wrapped = (line: any): Wire => ({ stdin: JSON.parse(line.stdin) });
const probe = (line: any): Wire => ({ stdin: line.stdin });
const copilotWire = (line: any): Wire => ({ event: line.event_arg, stdin: line.stdin });

const CSV = "a,b,c\n1,2,3\n4,5,6\n";
const TOTALS = "a,b,c\n5,7,9\n";
/** The file a recorded shell call writes: a `printf word > file`, or an awk redirected to a csv. */
function shellWrite(w: Wire): Array<{ file: string; data: string }> {
  if (w.stdin.hook_event_name !== "PreToolUse") return [];
  const cmd = w.stdin.tool_input?.command;
  if (typeof cmd !== "string") return [];
  const printf = /^printf (\w+) > (\S+)$/.exec(cmd);
  if (printf) return [{ file: printf[2]!, data: printf[1]! }];
  const csv = /> (\w+\.csv)\b/.exec(cmd);
  return csv ? [{ file: csv[1]!, data: TOTALS }] : [];
}

/** The files a recorded Codex apply_patch Pre leaves behind: an added file holds its `+` lines, an updated one the context and `+` lines of its hunk (the recorded hunks do not span the whole file: a stand-in for an updated file lacks the lines outside its hunks). */
function patchWrites(w: Wire): Array<{ file: string; data: string }> {
  if (w.stdin.hook_event_name !== "PreToolUse" || w.stdin.tool_name !== "apply_patch") return [];
  const patch = w.stdin.tool_input?.command;
  if (typeof patch !== "string") return [];
  const out: Array<{ file: string; data: string }> = [];
  let cur: { file: string; lines: string[] } | undefined;
  const flush = () => { if (cur) out.push({ file: cur.file, data: cur.lines.map((l) => `${l}\n`).join("") }); cur = undefined; };
  for (const line of patch.split("\n")) {
    const head = /^\*\*\* (?:Add|Update) File: (\S+)$/.exec(line);
    if (head) { flush(); cur = { file: head[1]!, lines: [] }; continue; }
    if (line.startsWith("***") || line.startsWith("@@")) continue;
    if (cur && (line.startsWith("+") || line.startsWith(" "))) cur.lines.push(line.slice(1));
  }
  flush();
  return out;
}

const claudeSession = "b0f5204b-5694-452a-b345-e478329f2f19";
const codex162Session = "01a14fae-faac-7b30-9563-1e1f59fae2c1";
const codex169Session = "01a20087-e556-72d1-87a6-98775c29fdbd";
const codex164Main = "01a16ff1-ac5d-78f1-a588-6ff46ea9e279";
const codex164Helper = "01a16ff1-c26a-7f03-80e7-465fcf0b0f19";

/** Copilot writes by record index (a Pre that wrote a file): the patch's own file, or the named one. */
const copilotWrites = (table: Record<number, string>) => (_w: Wire, i: number) => {
  const file = table[i];
  if (file === undefined) return [];
  return [{ file, data: file.endsWith(".xlsx") ? book({ A1: 1, A2: 2, A3: 3 }) : `stand-in for ${file}\n` }];
};

export const RECORDINGS: Recording[] = [
  {
    name: "claude-2.1.302",
    host: "claude",
    file: "claude-code/versions/2.1.302/payloads.jsonl",
    day: [2026, 10, 18],
    setup: { "data.csv": CSV },
    wire: wrapped,
    writes: shellWrite,
    copies: [{ from: `claude-code/versions/2.1.302/sessions/${claudeSession}.jsonl`, to: `claude/projects/work/${claudeSession}.jsonl` }],
    transcript: (s, root) => { if (typeof s.transcript_path === "string") s.transcript_path = path.join(root, "claude", "projects", "work", `${claudeSession}.jsonl`); },
  },
  {
    name: "codex-0.162.0-alpha.2",
    host: "codex",
    file: "codex/versions/0.162.0-alpha.2/payloads.jsonl",
    day: [2026, 10, 18],
    setup: { "data.csv": CSV },
    wire: wrapped,
    writes: shellWrite,
    copies: [{ from: "codex/versions/0.162.0-alpha.2/sessions/rollout-2026-10-18T11-43-50-01a14fae-faac-7b30-9563-1e1f59fae2c1.jsonl", to: ".codex/sessions/2026/10/18/rollout-2026-10-18T11-43-50-01a14fae-faac-7b30-9563-1e1f59fae2c1.jsonl" }],
    transcript: (s, root) => { if (typeof s.transcript_path === "string") s.transcript_path = path.join(root, ".codex", "sessions", "2026", "10", "18", `rollout-2026-10-18T11-43-50-${codex162Session}.jsonl`); },
  },
  {
    name: "codex-0.164.0-alpha.11.1",
    host: "codex",
    file: "codex/versions/0.164.0-alpha.11.1/hook-calls-run2.jsonl",
    day: [2026, 10, 24],
    wire: probe,
    writes: shellWrite,
    copies: [
      { from: "codex/versions/0.164.0-alpha.11.1/rollouts/main-18-04-31.jsonl", to: `.codex/sessions/2026/10/24/rollout-2026-10-24T18-04-31-${codex164Main}.jsonl` },
      { from: "codex/versions/0.164.0-alpha.11.1/rollouts/helper-18-04-37.jsonl", to: `.codex/sessions/2026/10/24/rollout-2026-10-24T18-04-37-${codex164Helper}.jsonl` },
    ],
    transcript: (s, root) => { if (typeof s.transcript_path === "string") s.transcript_path = path.join(root, ".codex", "sessions", "2026", "10", "24", `rollout-2026-10-24T18-04-31-${codex164Main}.jsonl`); },
  },
  {
    name: "codex-0.169.0-apply-patch",
    host: "codex",
    file: "codex/versions/0.169.0/payloads-write-tools.jsonl",
    day: [2026, 11, 21],
    setup: { "data.csv": CSV },
    wire: wrapped,
    writes: patchWrites,
    fileTools: { tools: ["apply_patch"], files: ["notes.txt", "data.csv"] },
    copies: [{ from: `codex/versions/0.169.0/sessions-write-tools/rollout-2026-11-21T18-53-56-${codex169Session}.jsonl`, to: `.codex/sessions/2026/11/21/rollout-2026-11-21T18-53-56-${codex169Session}.jsonl` }],
    transcript: (s, root) => { if (typeof s.transcript_path === "string") s.transcript_path = path.join(root, ".codex", "sessions", "2026", "11", "21", `rollout-2026-11-21T18-53-56-${codex169Session}.jsonl`); },
  },
  {
    name: "copilot-cli-1.0.103",
    host: "copilot",
    file: "copilot-cli/versions/1.0.103/raw-hook-stdin.jsonl",
    day: [2026, 10, 24],
    wire: copilotWire,
    writes: copilotWrites({ 30: "memo.md", 34: "deck.md", 45: "deck.md", 47: "model.xlsx" }),
  },
  {
    name: "copilot-cli-1.0.98-camel",
    host: "copilot",
    file: "copilot-cli/versions/1.0.98/hook-calls-camel.jsonl",
    day: [2026, 10, 24],
    wire: copilotWire,
    writes: copilotWrites({ 3: "a.txt", 13: "sub1.txt", 23: "sub2.txt" }),
  },
  {
    // Copilot sends these snake_case payloads to the hooks it reads from a repo's Claude settings, so they reach the claude entry (the
    // hook command names no event); the hook sees a Copilot payload there and records nothing, the copilot entry records.
    name: "copilot-cli-1.0.98-pascal",
    host: "claude",
    file: "copilot-cli/versions/1.0.98/hook-calls-pascal.jsonl",
    day: [2026, 10, 24],
    recordsNothing: true,
    wire: probe,
    writes: copilotWrites({ 3: "a.txt" }),
  },
  {
    name: "copilot-vscode-1.140.0-control",
    host: "copilot",
    file: "copilot-vscode/versions/1.140.0/hook-calls-vscode-control.jsonl",
    day: [2026, 10, 24],
    wire: copilotWire,
    writes: copilotWrites({ 35: "memo.md", 59: "deck.md", 72: "model.xlsx" }),
    copies: [{ from: "copilot-vscode/versions/1.140.0/events-vscode-control.jsonl", to: "copilot/session-state/25ee9a7c-ca9a-4d10-bd2e-e53055cfac50/events.jsonl" }],
  },
];

/** Replaces every recorded scratch or probe path in a text with the temp folder and root. */
export function rewritePaths(text: string, folder: string, root: string): string {
  // The text is JSON, so a path goes in as it reads inside JSON text (a Windows path's backslashes are doubled).
  const f = jsonText(folder);
  return text
    .replace(/(?:\/private)?\/var\/folders\/xx\/[A-Za-z0-9]+\/T\/cocheck-probe-[A-Za-z0-9]+\/work/g, () => f)
    .split("<scratch>/ws2").join(f)
    .split("<scratch>/ws").join(f)
    .split("<scratch>").join(jsonText(root));
}

/** One recorded line as the wire the hook reads: the line's own JSON (and, for a wrapped line, its inner stdin text) is parsed first, then the paths are substituted into the wire's JSON text, so a backslash path never meets a JSON parser raw. */
export function wireOfLine(rec: Pick<Recording, "wire">, text: string, folder: string, root: string): Wire {
  return JSON.parse(rewritePaths(JSON.stringify(rec.wire(JSON.parse(text))), folder, root));
}

/** One replay of a recording: the scrubbed ledger dump and the number of events replayed. Throws when the hook exits non-zero. */
export async function replayRecording(rec: Recording): Promise<{ dump: Record<string, unknown[]>; events: number }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-real-")));
  const home = path.join(root, "home");
  const folder = path.join(root, "ws");
  mkdirSync(home);
  mkdirSync(folder);
  mkdirSync(path.join(root, "copilot", "session-state"), { recursive: true });
  for (const [file, data] of Object.entries(rec.setup ?? {})) writeFileSync(path.join(folder, file), data);
  for (const c of rec.copies ?? []) {
    mkdirSync(path.dirname(path.join(root, c.to)), { recursive: true });
    cpSync(path.join(PLATFORMS, c.from), path.join(root, c.to));
  }
  const saved = { HOME: process.env.HOME, COPILOT_HOME: process.env.COPILOT_HOME };
  process.env.HOME = root;
  process.env.COPILOT_HOME = path.join(root, "copilot");
  setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
  try {
    const lines = readFileSync(path.join(PLATFORMS, rec.file), "utf8").split("\n").filter((l) => l !== "");
    const start = Date.UTC(rec.day[0], rec.day[1] - 1, rec.day[2], 12, 0, 0);
    let clock = start;
    for (const [i, text] of lines.entries()) {
      const wire = wireOfLine(rec, text, folder, root);
      rec.transcript?.(wire.stdin, root);
      const argv = ["node", "hook.ts", "--host", rec.host, ...(wire.event === undefined ? [] : ["--event", wire.event]), "--folder", folder];
      const res = await runHookTracked({ argv, env: { COCHECK_HOME: home }, now: () => (clock += 1000), journalNow: () => start + i * 1000, stdin: (async function* () { yield Buffer.from(JSON.stringify(wire.stdin)); })() });
      if (res.exitCode !== 0) throw new Error(`${rec.name} record ${i} exited ${res.exitCode}: ${res.stderr}`);
      for (const w of rec.writes(wire, i)) writeFileSync(path.join(folder, w.file), w.data);
    }
    const dump = goldenView(dumpLedger(home, folder));
    // A transcript, rollout or session-state path is under the temp root, which is different on every run.
    const scrubbed = JSON.parse(JSON.stringify(dump).split(JSON.stringify(root).slice(1, -1)).join("<root>"));
    return { dump: scrubbed, events: lines.length };
  } finally {
    setBuiltinConnectorsForTest(undefined);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await removeHome(home, root);
  }
}

export const goldenPath = (rec: Recording): string => path.join(import.meta.dirname, "fixtures", "hook-goldens", `golden-real-${rec.name}.json`);
export const readGolden = (rec: Recording): unknown => JSON.parse(readFileSync(goldenPath(rec), "utf8"));
