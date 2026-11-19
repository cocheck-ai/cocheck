// Ported unchanged from the test-drive viewer's describe.test.mjs (call lines: sources a-d, Claude-like and Codex-like hosts, failures, repeats, unknown tools).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRecord } from '../src/timeline/runs.ts';
import { lineOf, groupLines, translateShell } from '../src/timeline/describe.ts';
import { call, type CallOpts } from './fixtures/timeline.ts';

// One call through the record reader, as the page sees it. Non-shell tools record no command: the intent is the tool name.
const one = (id: string, o: CallOpts) => { const op = call(id, { at: 1, ...o, cmd: o.cmd ?? (o.tool && o.tool !== 'Bash' ? o.tool : 'cmd') }); return readRecord([op], []).calls.get(id)!; };

test('a. the agent\'s own words win, first sentence only', () => {
  const l = lineOf(one('c1', { desc: 'Run script', said: 'EXECUTE\n\nChecking the totals before I touch them. Then I will fix them.', cmd: 'python3 x.py' }));
  assert.deepEqual([l.text, l.source], ['Checking the totals before I touch them.', 'words']);
});

test('b. the agent\'s short description on a shell call (Claude-like)', () => {
  const l = lineOf(one('c2', { desc: 'Rebuild the chart sheet', cmd: 'python3 - <<EOF\nimport x\nEOF' }));
  assert.deepEqual([l.text, l.source], ['Rebuild the chart sheet', 'description']);
});

test('c. non-shell tools: plain sentence from the tool and its input, degrading when the input is not recorded', () => {
  const cases: Array<[CallOpts, string]> = [
    [{ tool: 'Read', input: { file_path: '/w/notes.md' } }, 'Read notes.md'],
    [{ tool: 'Edit', named: ['/w/model.xlsx'] }, 'Edited model.xlsx'],
    [{ tool: 'Write', input: { file_path: '/w/a.py' } }, 'Wrote a.py'],
    [{ tool: 'Skill', input: { skill: 'pdf' } }, 'Loaded pdf instructions'],
    [{ tool: 'Skill' }, 'Loaded instructions'],
    [{ tool: 'ToolSearch', input: { query: 'excel tools' } }, 'Looked up a tool'],
    [{ tool: 'ToolSearch' }, 'Looked up a tool'],
    [{ tool: 'WebFetch', input: { url: 'https://example.com/a/b?c=1' } }, 'Opened example.com'],
    [{ tool: 'Task', input: { prompt: 'x' } }, 'Started a helper agent'],
    [{ tool: 'FrobnicateThing', named: ['/w/a.xlsx'] }, 'Used FrobnicateThing on a.xlsx'],
    [{ tool: 'mcp__drive__upload_file' }, 'Used upload file from drive'],
  ];
  for (const [o, want] of cases) { const l = lineOf(one('t', o)); assert.deepEqual([l.text, l.source], [want, 'tool'], JSON.stringify(o)); }
});

test('d. shell commands with no description (Codex-like): first command word and the files it names, never the raw command', () => {
  const cases = [
    ['python3 scripts/fix_totals.py data/q3.csv', 'Ran a Python script (fix_totals.py) on q3.csv'],
    ['cd /w && node build.mjs --out out/page.html', 'Ran a Node script (build.mjs) on page.html'],
    ['python3 -c "print(1)"', 'Ran a short Python program'],
    ['osascript -e \'tell application "Microsoft Excel" to calculate\'', 'Sent a command to Microsoft Excel'],
    ['osascript script.scpt', 'Ran an AppleScript'],
    ['ls -la /w/reports/', 'Listed files in reports'],
    ['find . -name "*.ts"', 'Listed files in the folder'],
    ['cat /w/notes.md', 'Read notes.md'],
    ["sed -n 1,40p main.go", 'Read main.go'],
    ['head -20 data.csv | sort', 'Read data.csv'],
    ['cp /w/a.xlsx /tmp/backup/a-copy.xlsx', 'Copied a.xlsx to a-copy.xlsx'],
    ['mv old.txt new.txt', 'Moved old.txt to new.txt'],
    ['rm -f /w/tmp.json', 'Deleted tmp.json'],
    ['git status', 'Ran git status'],
    ['echo hi > out.txt', 'Wrote to out.txt'],
    ['apply_patch main.go', 'Changed main.go with a patch'],
    ['make', 'Ran make'],
    ['frob --fast', 'Ran frob'],
  ];
  for (const [cmd, want] of cases) {
    const l = lineOf(one('x', { host: 'codex', desc: '', cmd }));
    assert.deepEqual([l.text, l.source], [want, 'shell'], cmd);
    assert.ok(l.text !== cmd && !/(^|\s)-{1,2}\w|[|&;<>\/]/.test(l.text), `no raw command, flags, paths or pipes in: ${l.text}`);
    assert.equal(l.command, cmd); // kept for the "show command" toggle
  }
});

test('d. a command naming no file says only what kind of thing ran', () => {
  assert.equal(translateShell('python3 - <<EOF\nprint(2)\nEOF'), 'Ran a short Python program');
  assert.equal(translateShell('sleep 5'), 'Waited');
  assert.equal(translateShell(''), 'Ran a shell command');
});

test('failed calls say (didn\'t work); identical repeats group', () => {
  const cs = [
    one('r1', { host: 'codex', cmd: 'python3 fix.py a.csv', by: 'failure' }),
    one('r2', { host: 'codex', cmd: 'python3 fix.py a.csv', by: 'failure' }),
    one('r3', { host: 'codex', cmd: 'python3 fix.py a.csv' }),
    one('r4', { tool: 'Skill' }), one('r5', { tool: 'Skill' }),
    one('r6', { desc: 'Save the file', by: 'failure' }),
  ];
  cs.forEach((c, i) => (c.index = i + 1));
  assert.deepEqual(groupLines(cs).map((g) => g.line), [
    "Tried 3 times: Ran a Python script (fix.py) on a.csv (the first 2 didn't work)",
    'Loaded instructions (2 times)',
    "Save the file (didn't work)",
  ]);
  const allBad = [one('z1', { desc: 'Open it', by: 'failure' }), one('z2', { desc: 'Open it', by: 'failure' })];
  allBad.forEach((c, i) => (c.index = i + 1));
  assert.equal(groupLines(allBad)[0].line, "Tried 2 times: Open it (didn't work)");
});
