import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolLabel } from "../src/tool-label.ts";

// A brief withheld as secret-looking is recorded as dropped.prompt and never as a field; each dangerous brief is dropped whole.
// The fixture secret is a GitHub token, a vendor format in the gitleaks default ruleset.
const hooks = { text: (s: string) => s, path: (s: string) => s };
describe("secret-bearing briefs are dropped whole", () => {
  for (const secret of ["ghp_Z8k2Qm4Xv7Rt1Pw9Yb3Nc6Hd5Jf0Lg8Ae2SW", "AKIAIOSFODNN7REALKEY", "xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx", "STRIPE_KEY=sk_live_4eC39HqLyjWDarjtT1zdp7dc"]) {
    it(`drops a brief holding ${secret}`, () => {
      const l = toolLabel("Agent", { description: "d", subagent_type: "x", prompt: `Fetch the data.\n${secret}\nThen report.` }, hooks);
      assert.equal(l.fields.prompt, undefined);
      assert.ok(l.dropped?.prompt, JSON.stringify(l));
      assert.ok(!JSON.stringify(l).includes(secret.split("=").pop()!.slice(0, 8)) || !JSON.stringify(l).includes("Fetch the data"));
    });
  }
});
