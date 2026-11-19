import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { textRenderer } from "../src/timeline/render/text.ts";
import type { ChangeInfo, TextLine, View } from "../src/timeline/render/types.ts";

// A step that is mostly additions is one column: no empty before column, the added lines marked add. Decided from the lines alone.

const info = (extra: Partial<ChangeInfo> = {}): ChangeInfo => ({ id: "c1", file: "notes.dat", kind: "modified", ...extra });
const buf = (s: string): Buffer => Buffer.from(s, "utf8");
const rows = (n: number, tag = "row"): string[] => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`);
const body = (ls: string[]): Buffer => buf(ls.join("\n") + "\n");
const textOf = (v: View, side: "before" | "after"): TextLine[] => v[side].find((p) => p.text)?.text?.lines ?? [];
const quietBefore = (v: View): boolean => v.before.length === 0 && !JSON.stringify(v).includes("No lines here before");

describe("single column for additions", () => {
  it("a pure addition draws one column of add lines, with context and folds, and a quiet before side", async () => {
    const a = rows(30);
    const b = [...a.slice(0, 15), "new one", "new two", ...a.slice(15)];
    const v = await textRenderer.view(body(a), body(b), info());
    assert.ok(quietBefore(v));
    const after = textOf(v, "after");
    assert.deepEqual(after.filter((l) => "kind" in l && l.kind).map((l) => ("text" in l ? l.text : "")), ["new one", "new two"]);
    assert.ok(after.some((l) => "gap" in l), "unchanged runs still fold");
    assert.ok(!after.some((l) => "filler" in l), "no filler rows in one column");
    assert.deepEqual(v.boxes.map((x) => `${x.side}:${x.line}`), ["after:16", "after:17"]);
  });

  it("a created file is plain lines (the New label carries the meaning) and its before side is the nothing-here pane, never a zero-line text pane", async () => {
    const v = await textRenderer.view(null, body(rows(5)), info({ kind: "created" }));
    assert.ok(!JSON.stringify(v).includes("No lines here before"));
    assert.equal(v.before.length, 1);
    assert.equal(v.before[0]!.text, undefined);
    assert.equal(v.before[0]!.label, "There was nothing here yet");
    assert.ok(textOf(v, "after").every((l) => !("kind" in l)));
  });

  it("an edit with text on both sides keeps the split view", async () => {
    const a = rows(20);
    const b = [...a];
    b[5] = "row 6 CHANGED";
    b[12] = "row 13 CHANGED";
    const v = await textRenderer.view(body(a), body(b), info());
    assert.ok(!quietBefore(v));
    assert.ok(textOf(v, "before").some((l) => "kind" in l && l.kind === "edit"));
  });

  it("removed lines at exactly a tenth of the changed lines stay split; under a tenth go to one column", async () => {
    const a = rows(60);
    const at = [...a.slice(1)]; // 1 removed
    for (let i = 0; i < 9; i++) at.splice(5 + i * 5, 0, `added ${i}`); // 9 added: 1 of 10 changed is removed
    assert.ok(!quietBefore(await textRenderer.view(body(a), body(at), info())), "10% is not under 10%");
    const under = [...a.slice(1)];
    for (let i = 0; i < 10; i++) under.splice(5 + i * 4, 0, `added ${i}`); // 1 of 11
    const v = await textRenderer.view(body(a), body(under), info());
    assert.ok(quietBefore(v));
    const struck = textOf(v, "after").filter((l) => "kind" in l && l.kind === "del");
    assert.equal(struck.length, 1);
    assert.equal(v.boxes.filter((x) => x.side === "before").length, 0);
  });

  it("a deletion is not an addition", async () => {
    const a = rows(10);
    const v = await textRenderer.view(body(a), body(a.slice(0, 6)), info());
    assert.ok(!quietBefore(v));
  });
});
