import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pictureTier, type PictureInput } from "../src/timeline/picture.ts";
import { fallbackRenderer } from "../src/timeline/render/fallback.ts";
import type { GenericPart } from "../src/timeline/page.ts";

// Wording fixes for Windows. Other wording cases are pinned in timeline-step-command-toggle.test.ts and
// timeline-loading-widget.test.ts, where the page harness lives.

const input = (filePath: string, over: Partial<PictureInput> = {}): PictureInput => ({
  home: "/h", taskId: 1, filePath, before: "a".repeat(64), after: "b".repeat(64), stored: new Map(), sizes: { before: 1, after: 2 },
  isText: () => false, isSecret: () => false, ...over,
});

describe("a file type that is not shown as a picture does not blame macOS", () => {
  it("a .tmp step is a fingerprint that names no OS", async () => {
    const g = (await pictureTier(input("/w/open-test.xlsx.tmp")))!;
    assert.equal(g.tier, "fingerprint");
    assert.doesNotMatch(g.label, /macOS/);
    assert.doesNotMatch(g.fingerprint!.note, /macOS/);
    assert.match(g.label, /only png, jpg, gif, webp and svg/);
  });
  it("a type that is not an image keeps the fingerprint card and names no OS", async () => {
    const g = (await pictureTier(input("/w/deck.key")))!;
    assert.equal(g.tier, "fingerprint");
    assert.doesNotMatch(`${g.label} ${g.fingerprint!.note}`, /macOS|Quick Look/);
  });
});

describe("no double period after the reason", () => {
  const caveat = async (file: string, g: GenericPart) => (await fallbackRenderer.view(null, null, { id: "c1", file, kind: "modified", generic: g })).caveats;
  it("the no-picture caveat ends in one period", async () => {
    const g = (await pictureTier(input("/w/deck.key")))! as GenericPart;
    const cs = await caveat("deck.key", g);
    const line = cs.find((c) => /No picture of this file could be made/.test(c))!;
    assert.ok(line.endsWith("svg images as pictures."), line);
    assert.doesNotMatch(line, /\.\./);
  });
  it("a label without a final period still gets one", async () => {
    const cs = await caveat("x.bin", { tier: "fingerprint", label: "No preview of this change: a reason" } as GenericPart);
    assert.ok(cs.some((c) => c.endsWith("a reason.") && !c.endsWith("..")), cs.join(" | "));
  });
});
