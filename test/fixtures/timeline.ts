// Synthetic records, built by hand, in the shape the timeline's record reader takes (ledger ops + file_states rows). Each one is a way of
// working, not a copy of any real run. Time is in plain ticks (openedAt/closedAt); file paths are made up.
// Carried over from the test-drive viewer's fixtures.mjs unchanged apart from types.
import type { RawOp, RawState } from "../../src/timeline/runs.ts";
import type { PathLook } from "../../src/timeline/timeline.ts";


let opId = 0;
let stId = 0;
const reset = () => { opId = 0; stId = 0; };
const op = (args: Record<string, any>, intent = 'x'): RawOp => ({ id: ++opId, tool: args.tool_name ?? 'hook', intent, args_json: JSON.stringify(args) });

export interface CallOpts { session?: string; host?: string; tool?: string; desc?: string; cmd?: string; named?: string[]; at?: number; end?: number; by?: string; said?: string | null; background?: boolean; input?: unknown; extra?: Record<string, unknown> }
export function call(id: string, { session = 's1', host = 'claude', tool = 'Bash', desc = '', cmd = 'cmd', named = [], at, end, by = 'post', said = null, background = false, input, extra = {} }: CallOpts = {}): RawOp {
  const narration = said == null ? { source: 'none', text: 'no narration recorded' } : { source: 'agent', label: "the agent's own words", text: said };
  return op({ hookAdapter: 1, tool_use_id: id, closedBy: by, background, openedAt: at, closedAt: end ?? at! + 1, host, session_id: session, tool_name: tool, namedFiles: named, description: desc, narration, ...(input ? { tool_input: input } : {}), ...extra }, desc ? `${cmd} - ${desc}` : cmd);
}
export const prompt = (session: string, texts: string[], extra: Record<string, unknown> = {}): RawOp => op({ hookAdapter: 1, hookEvent: 'UserPromptSubmit', session_id: session, at: 0, earlier: 0, prompts: texts, ...extra }, 'user prompt');
export const stop = (session: string, text: string | null = null): RawOp => op({ hookAdapter: 1, hookEvent: 'Stop', session_id: session, at: 0, closing: text == null ? { source: 'none', text: 'no narration recorded' } : { source: 'agent', label: "the agent's own words", text } }, 'agent closing claim');
// A file state. open: calls open when the sweep saw it; credited: calls the hook credited. prev null + step 1 = baseline.
export const state = (file: string, sha: string, prev: string | null, { open = [], credited = [], step }: { open?: string[]; credited?: string[]; step?: number } = {}): RawState => { const id = ++stId; return { id, step_id: step ?? id, task_id: 1, file_path: file, sha256: sha, prev_sha256: prev, phase: 'Post', calls_open_json: JSON.stringify(open), credited_json: JSON.stringify(credited), size: 1, kept: 'whole', note: '' }; };

const W = '/w/';

export type Fixture = { ops: RawOp[]; fileStates: RawState[] };
export const fixtures: Record<string, () => Fixture> = {
  // An agent writing a text/code file directly on every call, then reading it back.
  directWriter() {
    reset();
    const ops = [
      call('w1', { desc: 'write notes', named: [W + 'notes.md'], at: 10, said: 'Writing the notes.' }),
      call('w2', { desc: 'add section', named: [W + 'notes.md'], at: 20 }),
      call('w3', { desc: 'fix typo', named: [W + 'notes.md'], at: 30 }),
      call('w4', { tool: 'Read', desc: 'read back', named: [W + 'notes.md'], at: 40 }),
      prompt('s1', ['Write the notes.']), stop('s1', 'Done.'),
    ];
    const fileStates = [state(W + 'notes.md', 'n0', null, { step: 1 }), state(W + 'notes.md', 'n1', 'n0', { open: ['w1'], credited: ['w1'] }), state(W + 'notes.md', 'n2', 'n1', { open: ['w2'], credited: ['w2'] }), state(W + 'notes.md', 'n3', 'n2', { open: ['w3'], credited: ['w3'] })];
    return { ops, fileStates };
  },
  // An agent driving a live app: many calls that name the file, the file on disk changes once, at the save.
  liveAppNamed() {
    reset();
    const ops = [...[1, 2, 3, 4, 5, 6].map((i) => call('a' + i, { desc: 'drive app step ' + i, named: [W + 'model.xlsx'], at: i * 10 })), prompt('s1', ['Update the model.']), stop('s1')];
    const fileStates = [state(W + 'model.xlsx', 'm0', null, { step: 1 }), state(W + 'model.xlsx', 'm1', 'm0', { open: ['a6'], credited: ['a6'] })];
    return { ops, fileStates };
  },
  // The same, but the driving calls name nothing (the app holds the file): they wait for the run the change starts.
  liveAppUnnamed() {
    reset();
    const ops = [...[1, 2, 3, 4, 5, 6].map((i) => call('b' + i, { desc: 'drive app step ' + i, at: i * 10 })), prompt('s1', ['Update the model.']), stop('s1')];
    const fileStates = [state(W + 'model.xlsx', 'm0', null, { step: 1 }), state(W + 'model.xlsx', 'm1', 'm0', { open: ['b6'], credited: ['b6'] })];
    return { ops, fileStates };
  },
  // A script that writes three files at once and names none of them in its input.
  scriptThreeFiles() {
    reset();
    const ops = [call('s1c', { desc: 'run build script', cmd: 'python build.py', at: 10 }), prompt('s1', ['Build it.']), stop('s1')];
    const fileStates = ['a.csv', 'b.csv', 'c.csv'].map((f) => state(W + f, f + '1', null, { open: ['s1c'], credited: ['s1c'], step: 5 }));
    return { ops, fileStates };
  },
  // Calls with no target (tool searches, skill loads) between real work.
  targetlessBetween() {
    reset();
    const ops = [
      call('t1', { tool: 'Edit', desc: 'edit app', named: [W + 'app.py'], at: 10 }),
      call('t2', { tool: 'ToolSearch', desc: '', cmd: 'ToolSearch', at: 20 }),
      call('t3', { tool: 'Skill', desc: '', cmd: 'Skill', at: 30 }),
      call('t4', { tool: 'Read', desc: 'read app', named: [W + 'app.py'], at: 40 }),
      call('t5', { tool: 'ToolSearch', cmd: 'ToolSearch', at: 50 }),
      call('t6', { tool: 'Edit', desc: 'edit app again', named: [W + 'app.py'], at: 60 }),
      prompt('s1', ['Fix the app.']), stop('s1'),
    ];
    const fileStates = [state(W + 'app.py', 'p0', null, { step: 1 }), state(W + 'app.py', 'p1', 'p0', { open: ['t1'], credited: ['t1'] }), state(W + 'app.py', 'p2', 'p1', { open: ['t6'], credited: ['t6'] })];
    return { ops, fileStates };
  },
  // A run with failures, then a success that changes the file.
  failThenSucceed() {
    reset();
    const ops = [
      call('f1', { desc: 'apply patch', named: [W + 'x.ts'], at: 10, by: 'failure' }),
      call('f2', { desc: 'apply patch again', named: [W + 'x.ts'], at: 20, by: 'failure' }),
      call('f3', { desc: 'apply fixed patch', named: [W + 'x.ts'], at: 30 }),
      prompt('s1', ['Patch x.']), stop('s1'),
    ];
    return { ops, fileStates: [state(W + 'x.ts', 'x0', null, { step: 1 }), state(W + 'x.ts', 'x1', 'x0', { open: ['f3'], credited: ['f3'] })] };
  },
  // Failures then a success that changes nothing (a test command run until it passes).
  failThenSucceedNoChange() {
    reset();
    const ops = [call('g1', { desc: 'run tests', named: [W + 'x.test.ts'], at: 10, by: 'failure' }), call('g2', { desc: 'run tests', named: [W + 'x.test.ts'], at: 20 }), prompt('s1', ['Run tests.']), stop('s1')];
    return { ops, fileStates: [state(W + 'x.test.ts', 'y0', null, { step: 1 })] };
  },
  // Two requests in one turn, with no submit order in the record.
  twoRequestsOneTurn() {
    reset();
    const ops = [call('q1', { desc: 'edit a', named: [W + 'a.txt'], at: 10 }), call('q2', { desc: 'edit b', named: [W + 'b.txt'], at: 20 }), prompt('s1', ['Edit a.', 'Also edit b.']), stop('s1', 'Both edited.')];
    return { ops, fileStates: [state(W + 'a.txt', 'a1', 'a0', { open: ['q1'], credited: ['q1'] }), state(W + 'b.txt', 'b1', 'b0', { open: ['q2'], credited: ['q2'] })] };
  },
  // The same turn, with the submit order recorded on the prompt op.
  twoRequestsOrdered() {
    reset();
    const ops = [call('q1', { desc: 'edit a', named: [W + 'a.txt'], at: 10 }), call('q2', { desc: 'edit b', named: [W + 'b.txt'], at: 20 }), prompt('s1', ['Edit a.', 'Also edit b.'], { requests: [{ seq: 1, at: 5, firstStep: null }, { seq: 4, at: 15, firstStep: null }] }), stop('s1', 'Both edited.')];
    return { ops, fileStates: [state(W + 'a.txt', 'a1', 'a0', { open: ['q1'], credited: ['q1'] }), state(W + 'b.txt', 'b1', 'b0', { open: ['q2'], credited: ['q2'] })] };
  },
  // Two sessions interleaved in one folder. A's Stop cuts the round, which logs B's held prompt too; B carries on and stops later.
  twoSessions() {
    reset();
    const ops = [
      call('A1', { session: 'A', desc: 'A edits one', named: [W + 'one.txt'], at: 10 }),
      call('B1', { session: 'B', desc: 'B edits two', named: [W + 'two.txt'], at: 15 }),
      call('A2', { session: 'A', desc: 'A edits one more', named: [W + 'one.txt'], at: 20 }),
      prompt('A', ['A: edit one.']), prompt('B', ['B: edit two.']), stop('A', 'A done.'),
      call('B2', { session: 'B', desc: 'B edits two more', named: [W + 'two.txt'], at: 30 }),
      prompt('B', ['B: edit two.']), stop('B', 'B done.'),
    ];
    const fileStates = [
      state(W + 'one.txt', 'o1', 'o0', { open: ['A1', 'B1'], credited: ['A1'] }),
      state(W + 'two.txt', 't1', 't0', { open: ['B1'], credited: ['B1'] }),
      state(W + 'one.txt', 'o2', 'o1', { open: ['A2'], credited: ['A2'] }),
      state(W + 'two.txt', 't2', 't1', { open: ['B2'], credited: ['B2'] }),
    ];
    return { ops, fileStates };
  },
  // A Codex-like host: no call descriptions, no failure event.
  codexLike() {
    reset();
    const ops = [
      call('exec-1', { host: 'codex', desc: '', cmd: 'sed -n 1,40p main.go', named: [W + 'main.go'], at: 10 }),
      call('exec-2', { host: 'codex', desc: '', cmd: 'apply_patch main.go', named: [W + 'main.go'], at: 20 }),
      prompt('s1', ['Fix main.']), stop('s1'),
    ];
    return { ops, fileStates: [state(W + 'main.go', 'g0', null, { step: 1 }), state(W + 'main.go', 'g1', 'g0', { open: ['exec-2'], credited: ['exec-2'] })] };
  },
  // A request where nothing changed on disk.
  nothingChanged() {
    reset();
    const ops = [call('n1', { tool: 'Read', desc: 'read spec', named: [W + 'spec.md'], at: 10, said: 'Reading the spec.' }), call('n2', { tool: 'Grep', desc: 'search', cmd: 'Grep', at: 20 }), prompt('s1', ['What does the spec say?']), stop('s1', 'It says X.')];
    return { ops, fileStates: [state(W + 'spec.md', 's0', null, { step: 1 })] };
  },
  // A run with no agent words at all.
  noWords() {
    reset();
    const ops = [call('v1', { desc: 'edit config', named: [W + 'cfg.json'], at: 10 }), prompt('s1', ['Edit config.']), stop('s1')];
    return { ops, fileStates: [state(W + 'cfg.json', 'c1', 'c0', { open: ['v1'], credited: ['v1'] })] };
  },
  // A background call open through the whole turn: the changes found while it was open are not its target.
  backgroundOpen() {
    reset();
    const ops = [call('bg', { desc: 'start watcher', at: 5, end: 100, background: true }), call('e1', { desc: 'edit a', named: [W + 'a.txt'], at: 10 }), call('e2', { desc: 'edit b', named: [W + 'b.txt'], at: 20 }), prompt('s1', ['Go.']), stop('s1')];
    return { ops, fileStates: [state(W + 'a.txt', 'a1', 'a0', { open: ['bg', 'e1'], credited: ['e1'] }), state(W + 'b.txt', 'b1', 'b0', { open: ['bg', 'e2'], credited: ['e2'] })] };
  },
};

/**
 * The text of a background agent's wake prompt, in the shape the host sends (one tag per line). `toolUseId` is the
 * launching Agent call's tool_use id. `result` and `usage` are optional blocks the host may add after the note.
 */
export function wakeText({ toolUseId, summary = 'Agent "Check the sheet" finished', status = 'completed', taskId = 'a1b2c3d4e5f60718', result, usage }: { toolUseId: string; summary?: string; status?: string; taskId?: string; result?: string; usage?: string }): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    `<tool-use-id>${toolUseId}</tool-use-id>`,
    `<output-file>/private/tmp/claude-501/tasks/${taskId}.output</output-file>`,
    `<status>${status}</status>`,
    `<summary>${summary}</summary>`,
    '<note>This is an automated notification.</note>',
    ...(result === undefined ? [] : [`<result>${result}</result>`]),
    ...(usage === undefined ? [] : [`<usage>${usage}</usage>`]),
    '</task-notification>',
  ].join('\n');
}
/** The prompt op a wake leaves: the wake text as the session's prompt, stamped with its submit order like any prompt. */
export const wakePrompt = (session: string, wake: Parameters<typeof wakeText>[0], seq: number, at = seq * 10): RawOp => prompt(session, [wakeText(wake)], { requests: [{ seq, at, firstStep: null }] });

/**
 * A filesystem view for the path scrub, so no test lists a real directory: `dirs` maps a directory ("/" separators, as the path kit writes
 * it) to its names, or to null for one that cannot be read; any other directory is missing. The default holds the homes the scrub tests name.
 */
export function fakeLook(dirs: Record<string, string[] | null> = {}, home = "/Users/user"): PathLook {
  const all: Record<string, string[] | null> = { "/": ["Users", "tmp", "var", "home", "usr", "opt"], "/Users": ["user", "John Smith", "T", "t"], "C:/Users": ["user", "John Smith", "T", "Admin"], ...dirs };
  return { list: (d) => (d in all ? all[d]! : "missing"), home: () => home };
}
