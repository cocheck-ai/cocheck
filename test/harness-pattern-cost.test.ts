import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { loadHarnessFolder } from "../src/hosts/harnesses.ts";
import { BUILTIN_HARNESSES_ROOT } from "../src/hosts/index.ts";
import path from "node:path";
import { compileManifest } from "../src/hosts/compile.ts";
import { patternProblem, validateManifest } from "../src/hosts/manifest.ts";
import { profileOf } from "../src/hosts/index.ts";
import { TOY } from "./harness-toy-rig.ts";

const toy = (): Record<string, any> => JSON.parse(readFileSync(path.join(TOY, "cocheck-harness.json"), "utf8"));
const label = "toyagent/cocheck-harness.json";

describe("the cost of a manifest pattern is bounded in fact", () => {
  it("polynomial blow-up patterns are rejected with the field named", () => {
    for (const bad of [".*.*.*x", ".*.*.*.*.*.*x", "\\d+\\d+\\d+\\d+\\d+\\d+\\d+\\d+x", "a*a*a*a*a*a*a*a*a*a*a*a*a*b", "a*a*b", ".*x.*y"]) {
      const m = toy();
      m.toolNameStrip = { prefix: bad };
      assert.throws(() => validateManifest(m, label), (e: Error) => e.message.startsWith(`${label}: toolNameStrip.prefix: too many unbounded repeats`), bad);
      const n = toy();
      n.failure = { "tool-post": { exitCode: { from: "tool.result.text", pattern: bad } } };
      assert.throws(() => validateManifest(n, label), (e: Error) => e.message.startsWith(`${label}: failure.tool-post.exitCode.pattern: too many unbounded repeats`), bad);
    }
  });

  it("every pattern the rule accepts, from a generated set, stays within a fixed multiple of a linear pattern timed in the same run, on 4096 characters of adversarial input", () => {
    const atoms = [".*", "\\d+", "[^>]*?", "a*", "\\s+", "[\\s\\S]*", "(?:ab)*", "a{1,4}", "a{2,}", "x", "a", "(a|b)?"];
    const inputs = ["a".repeat(4096), "1".repeat(4096), " ".repeat(4096), "ab".repeat(2048), "a".repeat(4095) + "b"];
    const accepted: string[] = [];
    const build = (parts: string[]): void => {
      for (const prefix of ["", "^"]) for (const tail of ["x", "b"]) {
        const pat = prefix + parts.join("") + tail;
        if (pat !== "" && patternProblem(pat) === undefined) accepted.push(pat);
      }
    };
    for (const a of atoms) {
      build([a]);
      for (const b of atoms) {
        build([a, b]);
        if (atoms.indexOf(a) % 3 === 0 && atoms.indexOf(b) % 2 === 0) for (const c of atoms.slice(0, 4)) build([a, b, c]);
      }
    }
    assert.ok(accepted.length > 100, `${accepted.length} accepted`);
    // The bound is relative, so a slow runner does not move it: 50 times what a trivially linear pattern takes on the same input in this run, never less than 1000 ms
    // (timer noise and a cold start dominate a baseline of microseconds). A pattern that grows with the square of the input is tens of ms here, far under the floor,
    // so the next test shows the measurement itself catches growth by comparing the time at two input sizes.
    const timeOf = (re: RegExp, reg: RegExp, input: string): number => {
      const t0 = performance.now();
      re.test(input);
      [...input.matchAll(reg)];
      return performance.now() - t0;
    };
    const baseline = new Map(inputs.map((input) => [input, Math.min(...[1, 2, 3].map(() => timeOf(/x/, /x/g, input)))]));
    const bound = (input: string): number => Math.max(1000, 50 * baseline.get(input)!);
    let slowest = { ms: 0, pat: "", input: "", limit: 1000 };
    for (const pat of accepted) {
      const re = new RegExp(pat);
      const reg = new RegExp(pat, "g");
      for (const input of inputs) {
        const ms = timeOf(re, reg, input);
        if (ms / bound(input) > slowest.ms / slowest.limit) slowest = { ms, pat, input: input.slice(0, 8), limit: bound(input) };
      }
    }
    assert.ok(slowest.ms < slowest.limit, `slowest accepted pattern ${JSON.stringify(slowest.pat)} took ${slowest.ms.toFixed(1)} ms, over its ${slowest.limit.toFixed(0)} ms bound`);
  });

  it("the measurement catches growth: a rejected superlinear pattern takes much more than twice as long on twice the input, a linear one does not", () => {
    assert.notEqual(patternProblem(".*.*x"), undefined, "the pattern is one the rule rejects");
    const best = (pat: string, n: number): number => Math.min(...[1, 2, 3].map(() => {
      const input = "a".repeat(n);
      const t0 = performance.now();
      new RegExp(pat).test(input);
      return performance.now() - t0;
    }));
    assert.ok(best(".*.*x", 600) / Math.max(best(".*.*x", 300), 0.05) > 2.8, "superlinear growth shows in the ratio");
    assert.ok(best("x", 600000) / Math.max(best("x", 300000), 0.05) < 2.8 || best("x", 600000) < 20, "a linear pattern does not");
  });

  it("the shipped manifests validate", () => {
    const dir = path.join(import.meta.dirname, "..", "harnesses");
    const loaded = loadHarnessFolder(dir, "built-in", []);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.profiles.map((p) => p.key).sort(), readdirSync(dir).filter((n) => !n.endsWith(".md")).sort());
  });
  it("the built-in manifests are data outside src/: the registry reads harnesses/ at the repo root, and the build copies it to dist/harnesses", () => {
    const repo = path.join(import.meta.dirname, "..");
    assert.equal(BUILTIN_HARNESSES_ROOT, path.join(repo, "harnesses"));
    assert.ok(!path.relative(path.join(repo, "src"), BUILTIN_HARNESSES_ROOT).match(/^[^.]/), "not under src/");
    assert.match(readFileSync(path.join(repo, "scripts", "build.mjs"), "utf8"), /cpSync\(path\.join\(root, "harnesses"\), path\.join\(dist, "harnesses"\)/);
    // Every built-in key the registry lists comes from that folder.
    for (const k of ["claude", "codex", "copilot"]) assert.ok(readdirSync(BUILTIN_HARNESSES_ROOT).includes(k), k);
  });
});

describe("a built-in host matches exactly as before: no input cap", () => {
  it("a Copilot system notification of 10000 characters is still `other`, as the lookahead pattern classified it", () => {
    const p = profileOf("copilot");
    const body = "x".repeat(10_000);
    assert.equal(p.refineKind!("prompt", { prompt: `<system_notification>${body}</system_notification>`, sessionId: "s" }), "other");
    assert.equal(p.refineKind!("prompt", { prompt: `<system_notification>${body}</system_notification> trailing`, sessionId: "s" }), "prompt");
    assert.equal(p.refineKind!("prompt", { prompt: `<system_notification>${body}</system_notification><system_notification>${body}</system_notification>`, sessionId: "s" }), "prompt");
  });
  it("a Copilot shell exit marker at the start of a long result is still read", () => {
    const p = profileOf("copilot");
    const text = `<shellId: 1 completed with exit code 3>${"y".repeat(10_000)}`;
    assert.deepEqual(p.failureOf("tool-post", { toolResult: { textResultForLlm: text } })?.interrupted, false);
    assert.equal(p.failureOf("tool-post", { toolResult: { textResultForLlm: text } })?.raw, text);
  });
  it("a tool-name strip and an exit-text rule of a built-in manifest see the whole input; an outsider's see the first or last 4096 characters", () => {
    const m = toy();
    m.toolNameStrip = { prefix: "ns_" };
    m.failure = { "tool-post": { exitCode: { from: "tool.result.text", pattern: "exit (-?\\d+)" } } };
    const long = `exit 5${"z".repeat(10_000)}`;
    const raw = { tool: { result: { text: long } } };
    const builtIn = compileManifest(validateManifest(m, label), "built-in");
    const outsider = compileManifest(validateManifest(m, label), "outsider");
    assert.equal(builtIn.toolName!(`ns_${"n".repeat(10_000)}`, {}), "n".repeat(10_000));
    assert.equal(builtIn.failureOf("tool-post", raw)?.raw, long, "built-in reads the exit code at the start of a long text");
    assert.equal(outsider.failureOf("tool-post", raw), undefined, "an outsider's rule sees only the last 4096 characters");
  });
});
