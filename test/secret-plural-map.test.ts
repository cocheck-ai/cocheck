import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { looksSecret } from "../src/tool-label.ts";

// A plural name after a prose word ("Design tokens:") stays readable.
// The plural-map withholding pinned a hand-written shape that is
// removed, so that block is deleted. A plural map of passwords with no vendor format is not detected now (bound stated in docs/security.md); the readable cases below stay.
describe("a plural name after a prose word stays readable", () => {
  for (const t of [
    "Design tokens:\n  PAPER  #FFFFFF\n  INK    #111111",
    "The API keys:\n  live in the vault, not here",
    "Deck spec\nDesign tokens:\n  PAPER  #FFFFFF",
    "Tokens:\n- PAPER is the background",
    "- Design tokens:\n    PAPER  #FFFFFF",
    "* Design tokens:\n    a: b",
    "1. The API keys:\n   rotate them",
    "Notes on API keys:\n\n  live in the vault",
  ]) {
    it(JSON.stringify(t).slice(0, 40), () => assert.equal(looksSecret(t), false));
  }
});

describe("the real helper inputs stay readable", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/secret/helper-agent-inputs.json", import.meta.url), "utf8"));
  const texts: string[] = [];
  const walk = (v: unknown): void => { if (typeof v === "string") texts.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(raw);
  it("none of the fixture texts is flagged", () => {
    assert.ok(texts.length >= 24, String(texts.length));
    assert.deepEqual(texts.filter((t) => looksSecret(t)).length, 0);
  });
});
