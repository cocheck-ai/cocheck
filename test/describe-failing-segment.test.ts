import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { failedPart, lineOf, translateShell } from "../src/timeline/describe.ts";

// a failed chained call is named by the segment that failed (recorded: "Ran pdftoppm" where `node deck.js` failed first); a header
// names the call's main work, not its first mkdir.
const D = "cd /w && node deck.js && pdftoppm -png deck.pdf out";
const call = (command: string, error: string | null) => ({ tool: "Bash", description: null, command, named: [], narration: null, input: null, closedBy: "failure", error }) as never;

describe("failing segment", () => {
  it("names node deck.js from the module error, though pdftoppm is last", () => {
    assert.equal(translateShell(D, [], true, "Error: Cannot find module '/w/deck.js'\n    at node:internal/modules"), "Ran a Node script (deck.js)");
  });
  it("names node memo.js among two node segments by the file in the error", () => {
    const c = "cd /w && node deck.js && node memo.js && ls out";
    assert.equal(translateShell(c, [], true, "/w/memo.js:3\nTypeError: x is not a function"), "Ran a Node script (memo.js)");
  });
  it("names ls fred/charts when the error names ls", () => {
    assert.equal(translateShell("ls fred/charts && python3 plot.py", [], true, "ls: fred/charts: No such file or directory"), "Listed files in charts");
  });
  it("reads a program that is not found", () => {
    assert.equal(translateShell("node deck.js && pdftoppm -png a.pdf o", [], true, "zsh: command not found: pdftoppm"), "Ran pdftoppm on a.pdf");
  });
  it("an unidentified failure names the chain's main work and says it failed at a step", () => {
    assert.equal(translateShell(D, [], true, "exit code 1"), "Ran a Node script (deck.js), failed at a step in it");
    assert.equal(translateShell("mkdir -p out && python3 draw.py && ls out", [], true, null), "Ran a Python script (draw.py), failed at a step in it");
    assert.equal(translateShell("ls data; python fetch.py", [], true, "exit 1"), "Ran a Python script (fetch.py), failed at a step in it");
  });
  it("git add/commit/push whose error names only push is named by program plus subcommand", () => {
    const c = "git add . && git commit -m x && git push";
    assert.equal(translateShell(c, [], true, "fatal: unable to access remote\nerror: failed to run git push"), "Ran git push");
    assert.equal(translateShell(c, [], true, "error: failed to push some refs to 'origin'"), "Ran git add, failed at a step in it");
    assert.equal(translateShell(c, [], true, "fatal: not a git repository"), "Ran git add, failed at a step in it");
  });
  it("npm install/test whose error names only test", () => {
    const c = "npm install && npm test";
    assert.equal(translateShell(c, [], true, "npm error Lifecycle script `test` failed with error"), "Ran npm test");
    assert.equal(translateShell(c, [], true, "npm test: 3 tests failed"), "Ran npm test");
    assert.equal(translateShell(c, [], true, "Exit code 1"), "Ran npm install, failed at a step in it");
  });
  it("a program unique among the segments is identified by name", () => {
    assert.equal(translateShell("npm install && pdftoppm a.pdf o", [], true, "pdftoppm: not found"), "Ran pdftoppm on a.pdf");
  });
  it("a header names the main work, not the first mkdir", () => {
    assert.equal(translateShell("mkdir -p charts && python3 draw.py charts"), "Ran a Python script (draw.py)");
    assert.equal(translateShell("mkdir -p charts"), "Made the folder charts");
  });
  it("lineOf passes the call's error through", () => {
    assert.equal(lineOf(call(D, "Cannot find module '/w/deck.js'")).text, "Ran a Node script (deck.js)");
  });
  it("tells the AI input the failed part, only for a chain", () => {
    assert.equal(failedPart(D, "Cannot find module '/w/deck.js'"), "Ran a Node script (deck.js) (named by the error)");
    assert.match(failedPart(D, "exit code 1")!, /^not identified: .*deck\.js/);
    assert.equal(failedPart("node deck.js", "x"), null);
  });
  it("a pipe splits into segments; the one the error names wins", () => {
    assert.equal(translateShell("cat data.csv | python3 plot.py", [], true, "plot.py\", line 2\nValueError: bad"), "Ran a Python script (plot.py)");
    assert.equal(translateShell("python3 gen.py | head -5", [], true, "gen.py: error: no input"), "Ran a Python script (gen.py)");
  });
  it("a pipe whose error names no segment is the chain's main work, failed at a step", () => {
    assert.equal(translateShell("cat data.csv | python3 plot.py", [], true, "exit code 1"), "Ran a Python script (plot.py), failed at a step in it");
  });
  it("a call that worked keeps its first segment across a pipe", () => {
    assert.equal(translateShell("cat data.csv | head -3"), "Read data.csv");
  });
});
