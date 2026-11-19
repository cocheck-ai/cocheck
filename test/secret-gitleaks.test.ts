import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { looksSecret, toolLabel } from "../src/tool-label.ts";
import { EXCLUDED_RULES, GITLEAKS_LICENSE, GITLEAKS_VERSION, SECRET_RULES } from "../src/secret-rules.generated.ts";

// The detector is gitleaks' default ruleset, generated, pinned, licence shipped.
const hooks = { text: (s: string) => s, path: (s: string) => s };
const GH = "ghp_Z8k2Qm4Xv7Rt1Pw9Yb3Nc6Hd5Jf0Lg8Ae2SW";

describe("the gitleaks ruleset", () => {
  it("is the pinned release with its licence notice", () => {
    assert.equal(GITLEAKS_VERSION, readFileSync(new URL("../vendor/gitleaks/VERSION", import.meta.url), "utf8").trim());
    assert.match(GITLEAKS_LICENSE, /MIT License/);
    assert.match(GITLEAKS_LICENSE, /Permission is hereby granted/);
  });
  it("accounts for every upstream rule: translated or excluded with a reason", () => {
    assert.equal(SECRET_RULES.length + EXCLUDED_RULES.length, 222);
    for (const e of EXCLUDED_RULES) assert.ok(e.reason.length > 0, e.id);
  });
  it("every translated regex compiles", () => {
    for (const r of SECRET_RULES) assert.doesNotThrow(() => new RegExp(r.regex, "g"), r.id);
  });
});

describe("detection", () => {
  it("a vendor-format token is detected and its field withheld whole", () => {
    assert.equal(looksSecret(`push with ${GH} now`), true);
    const l = toolLabel("SendMessage", { to: "x", message: `Step one.\nuse ${GH}\nThen report.` }, hooks);
    assert.equal(l.fields.message, undefined);
    assert.equal(l.dropped?.message, "secret-looking value, not recorded");
    assert.ok(!JSON.stringify(l).includes("Z8k2Qm4X"));
  });
  // Guard: a secret in a format the rules know must not slip through as a case-folded or inline-flag translation miss.
  it("case-folded and inline-flag rules still match (an `(?i)` mid-pattern rule, Adobe p8e-)", () => {
    assert.equal(looksSecret("key p8e-Ab3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI "), true);
  });
  it("ordinary text is readable", () => {
    for (const t of ["ls -la src", "Fetch GDP, then chart it.", "set the API key in settings", "password: hunter22"]) assert.equal(looksSecret(t), false, t);
  });
  it("the two pathological inputs finish under 100 ms", () => {
    for (const s of ["a.".repeat(25000) + ":", "a_".repeat(25000) + "pass"]) {
      const t = performance.now();
      looksSecret(s);
      assert.ok(performance.now() - t < 100, s.slice(0, 6));
    }
  });
});
