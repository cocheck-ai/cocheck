// no call label is built from a flag or a blank; a call with no description names its first real verb and object or the tool;
// the host's error text on the rail is one line with outside paths masked. Shapes are the recorded helper calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { translateShell, translateTool } from "../src/timeline/describe.ts";

const S = "/private/tmp/claude-501/-Users-user-Desktop-cocheck-run-8-work/8f0b/scratchpad";
const bad = (t: string): boolean => /^Ran (-|for\b|do\b|while\b|if\b)/.test(t) || /\s$/.test(t) || /Edited\s+and|\s{2,}/.test(t);

test("a for-loop reads as the command it runs, not 'Ran for'", () => {
  const t = translateShell("cd /Users/user/Desktop/cocheck-run-8/work/macro/data && for f in *.csv; do echo == $f; head -3 $f; tail -2 $f; wc -l $f; done; which soffice");
  assert.ok(!bad(t), t);
  assert.notEqual(t, "Ran for");
});

test("a command substitution assignment is skipped, not read as 'Ran -d'", () => {
  const t = translateShell(`cd ${S}; P=$(ls -d /Users/user/.claude/skills/synced/abc/pptx); node $P/scripts/x.js`);
  assert.ok(!bad(t), t);
  assert.equal(t, "Ran a Node script (x.js)");
  assert.equal(translateShell("P=$(ls -d /Users/user/x)"), "Ran a shell command");
});

test("sed -i with an empty argument and a script never leaves a blank file", () => {
  for (const cmd of [`cd ${S}; sed -i '' "s/'cap','eq'/'c','e'/" deck.py`, `cd ${S} && sed -i "s/Unemployment i/X/" memo.js`, `sed -i '' "19s/.*/  x/" xl.py`]) {
    const t = translateShell(cmd);
    assert.ok(!bad(t), t);
  }
  assert.equal(translateShell(`sed -i '' "s/a/b/" deck.py`), "Edited deck.py");
  assert.equal(translateShell(`sed -i '' "s/a/b/g"`), "Edited a file");
});

test("a heredoc that writes a file is a write, not a read", () => {
  const t = translateShell(`S=${S}; cat > $S/memo.js <<'E'\nconst d=require('docx');\nconsole.log(d)\nE\nnode $S/memo.js`);
  assert.equal(t, "Wrote to memo.js");
});

test("a message to another agent is named for what it is", () => {
  assert.equal(translateTool("SendMessage", {}, ["/w/macro_charts.xlsx"]), "Sent a message");
  assert.equal(translateTool("Frobnicate", {}, ["/w/a.xlsx"]), "Used Frobnicate on a.xlsx");
});
