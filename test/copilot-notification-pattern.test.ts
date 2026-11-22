import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { patternProblem } from "../src/hosts/manifest.ts";
import { profileOf } from "../src/hosts/index.ts";

// The shipped notification rules (a bounded pattern pair) classify every prompt as the lookahead pattern they replace did.
const OLD = /^<system_notification>(?:(?!<\/?system_notification>)[\s\S])*<\/system_notification>$/;
const O = "<system_notification>";
const C = "</system_notification>";
const PARTS = [O, C, "a", " ", "\n", "<", "/", ">", "system_notification", "<b>", O.slice(0, -1), C.slice(0, -1)];

describe("copilot notification refine rules", () => {
  it("every shipped pattern passes the structural bound", () => {
    const m = JSON.parse(readFileSync(new URL("../harnesses/copilot/cocheck-harness.json", import.meta.url), "utf8"));
    for (const r of m.refine) if (r.whenMatches) assert.equal(patternProblem(r.whenMatches.pattern), undefined, r.whenMatches.pattern);
  });
  it("agrees with the lookahead pattern on every composition of up to 6 fragments", () => {
    const p = profileOf("copilot");
    const kind = (s: string) => p.refineKind!("prompt", { prompt: s, sessionId: "s" });
    let n = 0;
    const walk = (cur: string, depth: number): void => {
      const expected = OLD.test(cur.trim()) ? "other" : "prompt";
      assert.equal(kind(cur), expected, JSON.stringify(cur));
      n++;
      if (depth === 0) return;
      for (const x of PARTS) walk(cur + x, depth - 1);
    };
    for (const lead of [O, "", " " + O]) for (const x of PARTS) walk(lead + x, 4);
    assert.ok(n > 10000);
  });
});
