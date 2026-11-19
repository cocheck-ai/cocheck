// Ported unchanged from the test-drive viewer's runs.test.mjs (synthetic records; no files touched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuns, wordsOfRun, labelOf, type Run } from '../src/timeline/runs.ts';
import { call, fixtures, prompt, state, stop } from './fixtures/timeline.ts';

const R = (name: string) => { const f = fixtures[name](); return { ...buildRuns(f.ops, f.fileStates), f }; };
const ids = (run: Run) => run.calls.map((c) => c.id);

test('direct writer: every write is its own run ending in a change; the read-back after it is checking', () => {
  const { runs } = R('directWriter');
  assert.deepEqual(runs.map(ids), [['w1'], ['w2'], ['w3'], ['w4']]);
  assert.deepEqual(runs.map((r) => r.phase), ['changing', 'changing', 'changing', 'checking']);
  assert.equal(runs[0].reading.caption, 'Worked on notes.md across 1 call; notes.md first changed at call 1');
  assert.equal(runs[3].reading.caption, 'Worked on notes.md across 1 call; no file changed');
  assert.equal(runs[2].reading.position, 'request 1 of 1, run 3 of 4, call 3 of 4');
});

test('live app, file named: one run of six calls, the change seen at the last one points back', () => {
  const { runs } = R('liveAppNamed');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].phase, 'changing');
  assert.equal(runs[0].reading.caption, 'Worked on model.xlsx across 6 calls; model.xlsx first changed at call 6');
  assert.equal(runs[0].reading.position, 'request 1 of 1, run 1 of 1, calls 1–6 of 6');
});

test('live app, nothing named: the targetless calls join the run the change starts, and the target is never guessed', () => {
  const { runs } = R('liveAppUnnamed');
  assert.equal(runs.length, 1);
  assert.deepEqual(ids(runs[0]), ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
  assert.equal(runs[0].reading.caption, "The agent didn't name what it was working on (1 call and 5 lookups); model.xlsx first changed at call 6");
  assert.equal(runs[0].reading.lookups, 5);
});

test('script writing three unnamed files: one run, three changes, no name', () => {
  const { runs } = R('scriptThreeFiles');
  assert.equal(runs.length, 1);
  assert.deepEqual([...runs[0].target].sort(), ['/w/a.csv', '/w/b.csv', '/w/c.csv']);
  assert.equal(runs[0].reading.caption, "The agent didn't name what it was working on (1 call); a.csv, b.csv and c.csv first changed at call 1");
});

test('targetless calls never start a run: they wait for the next one, or join the open one', () => {
  const { runs } = R('targetlessBetween');
  assert.deepEqual(runs.map(ids), [['t1'], ['t2', 't3', 't4', 't5', 't6']]);
  assert.equal(runs[1].reading.caption, 'Worked on app.py across 2 calls and 3 lookups; app.py first changed at call 6');
  assert.equal(runs[1].phase, 'changing');
});

test('failures then a success: one run, attempts count the failures', () => {
  const { runs } = R('failThenSucceed');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].phase, 'changing');
  assert.equal(runs[0].reading.attempts, '3 calls on the target, 2 failed');
  const nc = R('failThenSucceedNoChange').runs;
  assert.equal(nc[0].phase, 'failed and retrying');
  assert.equal(nc[0].reading.attempts, '2 calls on the target, 1 failed');
});

test('two requests in one turn with no submit order: shown together, placement inferred', () => {
  const { requests, runs } = R('twoRequestsOneTurn');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].texts, ['Edit a.', 'Also edit b.']);
  assert.equal(requests[0].placement, 'inferred');
  assert.match(requests[0].reading.texts!, /2 requests sent in one turn/);
  assert.deepEqual(runs.map(ids), [['q1'], ['q2']]);
  assert.equal(requests[0].closing!.text, 'Both edited.');
});

test('two requests in one turn with a recorded submit order: split, each before its first run', () => {
  const { requests } = R('twoRequestsOrdered');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((r) => [r.texts[0], r.placement, r.calls.map((c) => c.id)]), [['Edit a.', 'recorded', ['q1']], ['Also edit b.', 'recorded', ['q2']]]);
  assert.equal(requests[0].closing, null);
  assert.equal(requests[1].closing!.text, 'Both edited.');
  assert.equal(requests[1].runs[0].reading.position, 'request 2 of 2, run 1 of 1, call 1 of 1');
});

test('two sessions in one folder: requests per session, runs never mix sessions, a re-logged held prompt is one request', () => {
  const { requests, runs } = R('twoSessions');
  assert.deepEqual(requests.map((r) => [r.session, r.texts, r.calls.map((c) => c.id)]), [['A', ['A: edit one.'], ['A1', 'A2']], ['B', ['B: edit two.'], ['B1', 'B2']]]);
  for (const run of runs) assert.equal(new Set(run.calls.map((c) => c.session)).size, 1);
  assert.match(requests[0].reading.session!, /session/);
  // B1 was open when A's call changed one.txt; that change is credited to session A, so it is not B's.
  const b1 = runs.find((r) => r.calls[0].id === 'B1');
  assert.deepEqual([...b1!.target], ['/w/two.txt']);
  assert.equal(b1!.reading.caption, 'Worked on two.txt across 1 call; two.txt first changed at call 1');
});

test('Codex-like host: command is the label, and missing failure events are said, not shown as zero', () => {
  const { runs } = R('codexLike');
  assert.equal(runs.length, 1);
  assert.equal(labelOf(runs[0].calls[0]), 'sed -n 1,40p main.go');
  assert.equal(runs[0].reading.attempts, "2 calls on the target; this host doesn't report failures");
  assert.equal(runs[0].reading.failed, null);
});

test('nothing changed on disk: looking, and the words recorded in the run are kept', () => {
  const { runs } = R('nothingChanged');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].phase, 'looking');
  assert.equal(runs[0].reading.caption, 'Worked on spec.md across 1 call and 1 lookup; no file changed');
  assert.deepEqual(wordsOfRun(runs[0]), [{ call: 1, text: 'Reading the spec.' }]);
});

test('no agent words: the run has no words and falls back to descriptions', () => {
  const { runs } = R('noWords');
  assert.deepEqual(wordsOfRun(runs[0]), []);
  assert.equal(labelOf(runs[0].calls[0]), 'edit config');
});

test('a background call open across the turn does not absorb every change into its target', () => {
  const { runs } = R('backgroundOpen');
  assert.deepEqual(runs.map(ids), [['bg', 'e1'], ['e2']]);
  assert.equal(runs[0].calls[0].target!.size, 0);
});

test('trying: calls on a target that changes in a later run', () => {
  const ops = [call('r1', { tool: 'Read', desc: 'read a', named: ['/w/a.txt'], at: 10 }), call('r2', { tool: 'Read', desc: 'read b', named: ['/w/b.txt'], at: 20 }), call('r3', { desc: 'edit a', named: ['/w/a.txt'], at: 30 }), prompt('s1', ['Go.']), stop('s1')];
  const { runs } = buildRuns(ops, [state('/w/a.txt', 'a1', 'a0', { open: ['r3'], credited: ['r3'] })]);
  assert.deepEqual(runs.map((r) => [ids(r), r.phase]), [[['r1'], 'trying'], [['r2'], 'looking'], [['r3'], 'changing']]);
});

test('a run of lookups only says so, with no "0 calls"', () => {
  const { runs } = buildRuns([call('k1', { tool: 'ToolSearch', cmd: 'ToolSearch', at: 1 }), call('k2', { tool: 'Skill', cmd: 'Skill', at: 2 }), prompt('s1', ['Hi.']), stop('s1')], []);
  assert.equal(runs[0].reading.caption, "The agent didn't name what it was working on (2 lookups); no file changed");
  assert.equal(runs[0].phase, 'looking');
});
