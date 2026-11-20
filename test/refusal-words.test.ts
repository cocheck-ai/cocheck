// The words of refusal.ts (refusalWords), live on the print route (program.ts, excel/answer.ts). Restored from the finding-7 cases of a removed test.
// Guards against a healthy file called refused being reported, or one prompt blamed on the files when it may be the app's own.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { refusalWords, type Refusal, type Side } from "../src/office/connector/refusal.ts";

const xl = OFFICE_APPS.excel;
const m = (...e: [Side, Refusal][]): Map<Side, Refusal> => new Map(e);

describe("refusalWords", () => {
  it("nothing refused: no words, no status, no stand-ins", () => {
    assert.deepEqual(refusalWords(xl, m(), ["before", "after"], true), { caveats: [], standIns: [] });
  });
  it("a prompt on every side is not a finding about the files: no status, no stand-in, words that say the prompt may be the app's own", () => {
    const w = refusalWords(xl, m(["before", { kind: "prompt", why: "x" }], ["after", { kind: "prompt", why: "x" }]), ["before", "after"], false);
    assert.equal(w.status, undefined);
    assert.deepEqual(w.standIns, []);
    assert.equal(w.caveats.length, 1);
    assert.match(w.caveats[0]!, /stopped at a question on every workbook CoCheck asked it to open/);
    assert.match(w.caveats[0]!, /may be Microsoft Excel's own/);
  });
  it("one side refused, the other pictured: the status rides on a stand-in picture for that side (spec v1.1), not on the document", () => {
    const w = refusalWords(xl, m(["after", { kind: "prompt", why: "Microsoft Excel showed a prompt" }]), ["before", "after"], true);
    assert.equal(w.status, undefined);
    assert.deepEqual(w.standIns, [{ id: "after:not-opened", side: "after", type: "image", label: "After: not opened", status: { kind: "prompt", evidence: "After: Microsoft Excel showed a prompt." } }]);
    assert.deepEqual(w.caveats, ["After: Microsoft Excel showed a prompt."]);
  });
  it("one side refused and nothing pictured: the status rides on the document, no stand-in", () => {
    const w = refusalWords(xl, m(["after", { kind: "prompt", why: "Microsoft Excel showed a prompt" }]), ["before", "after"], false);
    assert.deepEqual(w.status, { kind: "prompt", evidence: "After: Microsoft Excel showed a prompt." });
    assert.deepEqual(w.standIns, []);
  });
  it("DANGEROUS: a new file (only the after side) that prompts is a finding, not 'the app's own' (the every-side rule needs two sides)", () => {
    const w = refusalWords(xl, m(["after", { kind: "prompt", why: "p" }]), ["after"], false);
    assert.deepEqual(w.status, { kind: "prompt", evidence: "After: p." });
    assert.ok(!w.caveats.some((c) => /may be/.test(c)));
  });
  it("DANGEROUS: both sides refused (not prompted) is a finding on each file, never the app's-own words", () => {
    const w = refusalWords(xl, m(["before", { kind: "refused", why: "b" }], ["after", { kind: "refused", why: "a" }]), ["before", "after"], false);
    assert.equal(w.status?.kind, "refused");
    assert.ok(!w.caveats.some((c) => /may be/.test(c)), JSON.stringify(w.caveats));
    assert.deepEqual(w.caveats, ["Before: b.", "After: a."]);
  });
  it("DANGEROUS: a prompt on one side and a refusal on the other is a finding (status prompt), not the app's-own words", () => {
    const w = refusalWords(xl, m(["before", { kind: "prompt", why: "b" }], ["after", { kind: "refused", why: "a" }]), ["before", "after"], false);
    assert.equal(w.status?.kind, "prompt");
    assert.ok(!w.caveats.some((c) => /may be/.test(c)), JSON.stringify(w.caveats));
  });
});
