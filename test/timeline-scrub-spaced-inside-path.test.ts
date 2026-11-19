// a spaced inside path followed by words is relabelled to its inside part; no words are lost and no outside path shows.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { call, prompt, stop, fakeLook } from "./fixtures/timeline.ts";

// The text goes in as a helper's brief, the surface where the bug showed; the shown brief is returned.
function lines(folder: string, said: string[]): string[] {
  const t = buildTimeline({
    taskId: 1, build: "test-build", folder, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: true, look: fakeLook(),
    ops: [...said.map((s, i) => call(`k${i}`, { tool: "Agent", desc: "helper", at: 10 + i, extra: { startSeq: 2 + i, toolLabel: { fields: { subagent_type: "general-purpose", description: "helper", prompt: s } } } })), prompt("s1", ["go"]), stop("s1", "ok")],
    fileStates: [],
  });
  return t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.map((c) => c.brief ?? "")));
}
const F = "/Users/user/Desktop/CoCheck Testing";
const R = `${F}/copilot-run`;
const one = (s: string, folder = R): string => lines(folder, [s])[0]!;
const hidden = (out: string): void => assert.ok(!/Taxes|Documents|user|Desktop|CoCheck|other|secret/i.test(out), out);

describe("spaced inside path followed by words", () => {
  it("keeps the words after an inside folder path (the Copilot brief)", () => {
    const out = one(`Working directory is ${R}. Create t09/helper-file.txt with initial content, ensuring t09 exists. Do not modify any other files.`);
    assert.equal(out, "Working directory is copilot-run. Create t09/helper-file.txt with initial content, ensuring t09 exists. Do not modify any other files.");
  });
  it("outside spaced path still masked", () => {
    const out = one("Read /Users/user/Documents/My Taxes/2026 return.pdf now.");
    assert.ok(!/Taxes|Documents|user/.test(out), out);
    assert.match(out, /\[outside path\]|2026 return\.pdf/);
  });
  it("outside spaced path followed by words and a file name", () => {
    const out = one("Read /Users/user/Documents/My Taxes then open notes.txt now.");
    assert.ok(!/Taxes|Documents|user/.test(out), out);
  });
  it("inside path then outside path in one sentence", () => {
    const out = one(`Copy ${R}/a.txt to /Users/user/Documents/My Taxes/secret.txt now.`);
    assert.ok(!/Taxes|Documents|user/.test(out), out);
    // "a.txt" is strictly inside the folder, so its head splits off at a bare space; the rest is scanned again and the outside path cut.
    assert.equal(out, "Copy a.txt to [outside path] now.");
  });
  it("../ escape never reads as inside", () => {
    const out = one(`See ${R}/sub dir/../../Documents/My Taxes/x.pdf. Then stop.`);
    assert.ok(!/Taxes|Documents|user/.test(out), out);
    const out2 = one(`See ${R}/../Other Stuff/keep.txt for details.`);
    assert.ok(!/Other Stuff|Desktop/.test(out2), out2);
  });
  it("an outside path after an inside one, after a bracket or colon, is never shown", () => {
    for (const j of ["(", ":", "~"]) hidden(one(`Go ${R}/a.txt ${j}/Users/user/Documents/My Taxes/secret.txt done.`));
    hidden(one(`Go ${R}. See )/Users/user/other things/secret.txt done.`));
  });
  // a head is split off only at a sentence boundary (punctuation, then whitespace). "<folder> please" can't be told from a sibling
  // folder named "copilot-run please", so this case cuts whole (the words after it are lost; nothing outside shows).
  it("the folder followed by a bare space and words cuts whole (no sentence boundary)", () => {
    const out = one(`Work in ${R} please, then Create b/c.txt later.`);
    hidden(out);
    assert.equal(out, "Work in [outside path] later.");
  });
  it("comma and semicolon boundaries keep the words", () => {
    assert.equal(one(`Working directory is ${R}, create t09/a.txt now.`), "Working directory is copilot-run, create t09/a.txt now.");
    assert.equal(one(`Use ${R}; then write t09/a.txt now.`), "Use copilot-run; then write t09/a.txt now.");
    assert.equal(one(`Use ${R}/t09: then write b/a.txt now.`), "Use t09: then write b/a.txt now.");
  });
});

// a sibling folder whose name starts with the watched folder's name is never shown.
describe("sibling folder sharing the watched folder's name prefix", () => {
  const W = "/Users/user/Desktop/Work";
  const priv = (out: string): void => assert.ok(!/Private|medical|user|Desktop/.test(out), out);
  it("a bare space after the folder name is not a boundary", () => {
    const out = one(`Read ${W} Private/medical records.pdf now.`, W);
    priv(out);
    assert.equal(out, "Read [outside path] now.");
    priv(one(`Read ${W} Private/Health/medical.pdf now.`, W));
    priv(one(`Read ${W}/a.txt and ${W} Private/Health/medical.pdf now.`, W));
    priv(one(`Read ${W} Private/x.pdf now`, W));
  });
  it("a ../ anywhere in the match never splits", () => {
    priv(one(`Read ${W}/a b/../../Work Private/x.pdf now.`, W));
    priv(one(`Read ${W}/a, b/../../Work Private/x.pdf now.`, W));
    priv(one(`Read ${W}/a. b/../../Work Private/x.pdf now.`, W));
  });
});
