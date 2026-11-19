import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { lineOf } from "../src/timeline/describe.ts";
import { readRecord, wordsOfRun } from "../src/timeline/runs.ts";

/**
 * a line whose agent words have no letter or digit never shows the punctuation; the next source speaks.
 * Fixture: recorded, task 12, helper a41b2fceba0cccd41's first two calls (ToolSearch, then Bash on the same words). The
 * host's text there is "EXECUTE. I'll start ..."; the mode label strip leaves ". I'll ..." and the first sentence was ".".
 * Guards against: a short real sentence ("Done.", "OK", "Fix") still shows as the agent's words.
 */
const ops = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/recorded-tool-calls/first-tool-calls.json"), "utf8"));
const calls = [...readRecord(ops, []).calls.values()];
const said = (text: string) => lineOf({ tool: "Bash", description: "List the files", command: "ls", narration: { source: "agent", label: "x", text }, closedBy: "post" } as any);

describe("blank agent words", () => {
  it("the two recorded calls never show a line without a letter or digit", () => {
    assert.equal(calls.length, 2);
    for (const c of calls) {
      const l = lineOf(c as any);
      assert.match(l.text, /[\p{L}\p{N}]/u, `line ${JSON.stringify(l)}`);
    }
  });
  it("the mode label and its punctuation are stripped and the real sentence shows", () => {
    const want = "I'll start by finding the top 10 and checking the SEC access in parallel.";
    for (const c of calls) assert.deepEqual([lineOf(c as any).text, lineOf(c as any).source], [want, "words"]);
    for (const t of ["EXECUTE. Go", "PLAN: Go", "ANSWER Go"]) assert.deepEqual([said(t).text, said(t).source], ["Go", "words"], t);
  });
  it("a word that is not a label at the start keeps its words", () => {
    for (const t of ["Plan: split the file.", "Answer. Yes it fits.", "Then EXECUTE. Go", "Execute the plan.", "Planning ahead."]) assert.deepEqual([said(t).text, said(t).source].slice(1), ["words"], t);
    assert.equal(said("Plan: split the file.").text, "Plan: split the file.");
    assert.equal(said("Answer. Yes it fits.").text, "Answer.");
    assert.equal(said("Then EXECUTE. Go").text, "Then EXECUTE.");
  });
  it("empty, '.', '...', '-' and whitespace fall to the call description", () => {
    for (const t of ["", ".", "...", "-", "  \n ", "EXECUTE."]) {
      const l = said(t);
      assert.deepEqual([l.text, l.source], ["List the files", "description"], JSON.stringify(t));
    }
  });
  it("falls to CoCheck's own wording when the call has no description", () => {
    const l = lineOf({ tool: "Bash", description: null, command: "ls", narration: { source: "agent", label: "x", text: "." }, closedBy: "post" } as any);
    assert.equal(l.source, "shell");
  });
  it("a short real sentence still shows as the agent's words", () => {
    for (const t of ["Done.", "OK", "Fix", "Step 2", "Ça marche."]) {
      const l = said(t);
      assert.deepEqual([l.text, l.source], [t, "words"], t);
    }
  });
  it("wordsOfRun skips blank words", () => {
    const run = { calls: [{ index: 0, narration: { source: "agent", text: "." } }, { index: 1, narration: { source: "agent", text: "Done." } }] } as any;
    assert.deepEqual(wordsOfRun(run), [{ call: 1, text: "Done." }]);
  });
});
