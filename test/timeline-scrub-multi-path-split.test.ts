// A scrub match that spans more than one path is never relabelled whole; no outside path text reaches the output.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { call, prompt, stop, fakeLook } from "./fixtures/timeline.ts";

function lines(folder: string, said: string[], platform: "win32" | "darwin"): string[] {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    const t = buildTimeline({
      taskId: 1, build: "test-build", folder, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: true, look: fakeLook(),
      ops: [...said.map((s, i) => call(`k${i}`, { desc: "", at: 10 + i, said: s })), prompt("s1", ["go"]), stop("s1", "ok")],
      fileStates: [],
    });
    return t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.map((c) => c.line.text)));
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}
const W = "C:\\Users\\T\\work";
const noLeak = (out: string[]): void => assert.ok(!/other|secret/i.test(out.join("\n")), out.join(" | "));
// An outside file shows its name alone by design, so the posix checks look for the directory text.
const noDir = (out: string[]): void => assert.ok(!/other|\/Users\/t\//i.test(out.join("\n")), out.join(" | "));

describe("win32 scrub", () => {
  const A = "C:\\Users\\T\\work\\a.txt";
  const S = "C:\\Users\\T\\other\\secret.txt";
  it("inside then outside, joined three ways, never leaks the outside path", () => {
    for (const join of [" and ", ", ", " then "]) {
      const out = lines(W, [`See ${A}${join}${S} now.`], "win32");
      noLeak(out);
      // A head strictly inside the folder splits off at any whitespace (only the folder itself needs a sentence boundary).
      assert.equal(out[0], `See a.txt${join}[outside path] now.`, "a strictly inside head splits off");
    }
  });
  it("an outside path with a space in a directory is cut whole", () => {
    const out = lines(W, [`See ${A} and C:\\Users\\T\\other dir\\secret.txt now.`], "win32");
    noLeak(out);
  });
  it("outside first, and a single outside path, are cut", () => {
    noLeak(lines(W, [`See ${S} and ${A} now.`], "win32"));
    assert.deepEqual(lines(W, [`See ${S} now.`], "win32"), ["See [outside path] now."]);
  });
  it("a single inside path still gets its relative label", () => {
    assert.deepEqual(lines(W, [`See ${A} now.`, "See c:\\users\\t\\WORK\\sub dir\\b.csv now."], "win32"), ["See a.txt now.", "See sub dir/b.csv now."]);
  });
});

describe("posix scrub", () => {
  it("inside then outside under a known root never leaks the outside path", () => {
    for (const join of [" and ", ", ", " then "]) {
      noDir(lines("/Users/t/work", [`See /Users/t/work/a.txt${join}/Users/t/other/secret.txt now.`], "darwin"));
    }
    noDir(lines("/Users/t/work", ["See /Users/t/work/a.txt and /Users/t/other dir/secret.txt now."], "darwin"));
  });
  it("a single inside path still gets its relative label", () => {
    assert.deepEqual(lines("/Users/t/work", ["See /Users/t/work/sub/a.txt now."], "darwin"), ["See sub/a.txt now."]);
  });
});

describe("one root start per relabelled span", () => {
  const A = "C:\\Users\\T\\work\\a.txt";
  const S = "C:\\Users\\T\\other\\secret.txt";
  it("brackets, braces, equals and a bare paren never carry the outside path", () => {
    for (const s of [`See ${A} and (${S}) now.`, `See ${A} and [${S}] now.`, `See ${A} and {${S}} now.`, `See ${A} and x=${S} now.`, `See ${A}(${S}) now.`]) noLeak(lines(W, [s], "win32"));
  });
  it("any punctuation before the second path leaks nothing, win32", () => {
    for (const ch of "()[]{}<>=\"'`|&!@#$%^*+?~") noLeak(lines(W, [`See ${A} ${ch}${S} now.`], "win32"));
  });
  it("any punctuation before the second path leaks no directory, posix", () => {
    for (const ch of "()[]{}<>=\"'`|&!@#$%^*+?~") {
      const out = lines("/Users/t/work", [`See /Users/t/work/a.txt ${ch}/Users/t/other/secret.txt now.`], "darwin");
      assert.ok(!/other/.test(out.join("\n")), `${ch}: ${out.join(" | ")}`);
    }
  });
  it("a single inside path with a bracket in a name is still labelled or cut, never widened", () => {
    assert.deepEqual(lines(W, [`See ${A} now.`], "win32"), ["See a.txt now."]);
  });
});
