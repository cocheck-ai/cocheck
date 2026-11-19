import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { textRenderer, WHOLE_LINES } from "../src/timeline/render/text.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { ChangeInfo, View } from "../src/timeline/render/types.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// Now shows the whole text file (a 293-line html once showed 5 lines); look-here skips deleting what the task itself created.

const body = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => `<p>line ${i + 1}</p>`).join("\n") + "\n");
const info = (over: Partial<ChangeInfo> = {}): ChangeInfo => ({ id: "c1", file: "asia_dl_proxies.html", kind: "modified", whole: "after", generic: { tier: "text" } as ChangeInfo["generic"], ...over });
const lines = (v: View) => (v.after[0]?.text?.lines ?? []) as Array<{ n?: number; gap?: true }>;

describe("whole text file", () => {
  it("Now draws all 293 lines of a modified file", async () => {
    const v = (await textRenderer.view(body(292), body(293), info())) as View;
    assert.equal(v.kind, "pages");
    assert.equal(lines(v).filter((l) => l.n !== undefined).length, 293);
    assert.deepEqual(v.boxes, []);
    assert.ok(!lines(v).some((l) => l.gap));
  });
  it("Before task draws the before side", async () => {
    const v = (await textRenderer.view(body(10), body(20), info({ whole: "before" }))) as View;
    assert.equal((v.before[0]!.text!.lines as unknown[]).length, 10);
    assert.deepEqual(v.after, []);
  });
  it("past the line cap, names exactly what is cut", async () => {
    const v = (await textRenderer.view(null, body(WHOLE_LINES + 7), info({ kind: "created" }))) as View;
    assert.equal(lines(v).filter((l) => l.n !== undefined).length, WHOLE_LINES);
    assert.ok(v.caveats.some((c) => c.includes(`Lines 5,001-5,007 are not shown (7 of 5,007 lines`)), v.caveats.join("|"));
  });
  it("past the byte cap, names the cut", async () => {
    const big = Buffer.from(Array.from({ length: 3000 }, () => "x".repeat(500)).join("\n"));
    const v = (await textRenderer.view(null, big, info({ kind: "created" }))) as View;
    assert.ok(lines(v).filter((l) => l.n !== undefined).length < 3000);
    assert.ok(v.caveats.some((c) => /are not shown .*limit of 1 MB/.test(c)), v.caveats.join("|"));
  });
  it("a secret file is withheld whole", async () => {
    const v = (await textRenderer.view(null, Buffer.from("API_KEY=abc\n"), info({ kind: "created", generic: { tier: "fingerprint", secret: true } as ChangeInfo["generic"] }))) as View;
    assert.equal(v.kind, "card");
    assert.deepEqual(v.after, []);
    assert.ok(!JSON.stringify(v).includes("abc"));
  });
});

const ref = (sha: string) => ({ sha256: sha.padEnd(64, "0"), size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
const mk = (id: string, file: string, kind: "created" | "modified" | "deleted", before: string | null, after: string, at: number): Change =>
  ({ id, file, outside: false, at, kind, step: 1, before: before === null ? null : ref(before), after: ref(after), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label ${id}` } }) as unknown as Change;

describe("look-here on deletions", () => {
  it("the model marks no stop: the look-here rule is deleted, not replaced", () => {
    const changes = [mk("c0", "tmp.py", "created", null, "x", 500), mk("c1", "tmp.py", "deleted", "x", "y", 1000), mk("c2", "old.txt", "deleted", "a", "b", 2000), mk("c3", "keep.txt", "modified", "a", "b", 3000)];
    const tl = { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
      id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: 1, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
      runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "call", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: "t", source: "agent-description", label: "l" } }] }] }] } as unknown as Timeline;
    const stops = buildRailModel(tl).stops.filter((s) => s.change);
    assert.deepEqual(stops.map((s) => [s.id, "look" in s]), [["chg-c0", false], ["chg-c1", false], ["chg-c2", false], ["chg-c3", false]]);
  });
});
