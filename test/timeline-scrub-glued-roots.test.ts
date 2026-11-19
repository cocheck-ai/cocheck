// An absolute or home-relative path is found wherever its root appears, glued to the word or punctuation before it,
// and a head strictly inside the folder splits off at any whitespace. Every "leaked" case below would show the outside path without the fix.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { call, prompt, stop, fakeLook } from "./fixtures/timeline.ts";

// The text goes in as a helper's brief (the surface where paths show); the shown brief is returned.
function brief(folder: string, text: string, platform?: "win32"): string {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  if (platform) Object.defineProperty(process, "platform", { value: platform });
  try {
    const t = buildTimeline({
      taskId: 1, build: "test-build", folder, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: true, look: fakeLook(),
      ops: [call("k0", { tool: "Agent", desc: "helper", at: 10, extra: { startSeq: 2, toolLabel: { fields: { subagent_type: "general-purpose", description: "helper", prompt: text } } } }), prompt("s1", ["go"]), stop("s1", "ok")],
      fileStates: [],
    });
    return t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.map((c) => c.brief ?? "")))[0]!;
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}
const W = "/Users/user/Desktop/Work";
const WR = "C:\\Users\\John Smith\\proj";
const T = "/Users/user/Documents/My Taxes/x.pdf";
const T1 = "/Users/user/Documents/Taxes/x.pdf";
const hidden = (out: string): void => assert.ok(!/user|Taxes|Documents|server|share|My docs|bob|John/.test(out), out);

describe("glued roots (outside directories leaked)", () => {
  // [input, expected]. Each input would show its outside directories without the fix.
  const posix: [string, string][] = [
    [`Read ${W}/a.txt then .${T} now.`, "Read a.txt then .[outside path] now."],
    [`Then .${T1} now.`, "Then .[outside path] now."],
    [`Read ${W}/a.txt then ./${T} now.`, "Read a.txt then .[outside path] now."],
    [`Then ./${T1} now.`, "Then .[outside path] now."],
    [`Then ../${T1} now.`, "Then ..[outside path] now."],
    [`Read ${W}/a.txt then ...${T} now.`, "Read [outside path] now."],
    [`Then ...${T1} now.`, "Then ...[outside path] now."],
    [`Then .../${T1} now.`, "Then ...[outside path] now."],
    [`Read ${W}/a.txt then x${T} now.`, "Read a.txt then x[outside path] now."],
    [`Then x${T1} now.`, "Then x[outside path] now."],
    [`Then 9${T1} now.`, "Then 9[outside path] now."],
    [`Then _${T1} now.`, "Then _[outside path] now."],
    [`Read ${W}/a.txt then -${T} now.`, "Read a.txt then -[outside path] now."],
    [`Read ${W}/a.txt then é${T} now.`, "Read a.txt then é[outside path] now."],
    [`Read ${W}/a.txt then ~user${T} now.`, "Read a.txt then [outside path] now."],
    [`Then ~user${T1} now.`, "Then x.pdf now."],
    [`Then ~user/${T1} now.`, "Then x.pdf now."],
    [`Then :${T1} now.`, "Then :x.pdf now."],
    [`Then )${T1} now.`, "Then )x.pdf now."],
    ["Read ~user/Documents/x.pdf now.", "Read x.pdf now."],
    ["Read ~bob/Documents/My Taxes/x.pdf now.", "Read [outside path] now."],
    [`Read ${W}/a.txt and ~user/Documents/My Taxes/x.pdf now.`, "Read a.txt and [outside path] now."],
    [`Read ${W}/a.txt and ~bob/Documents/x.pdf now.`, "Read a.txt and x.pdf now."],
    ["Then //server/share/docs/s.txt now.", "Then [outside path] now."],
    ["Then x//server/share/docs/s.txt now.", "Then x[outside path] now."],
  ];
  for (const [input, want] of posix) {
    it(`posix: ${input}`, () => {
      const out = brief(W, input);
      hidden(out);
      assert.equal(out, want);
    });
  }
  const win: [string, string][] = [
    ["Then xC:\\Users\\user\\Taxes\\x.pdf now.", "Then x[outside path] now."],
    ["Then 9C:/Users/user/Taxes/x.pdf now.", "Then 9[outside path] now."],
    ["Then .\\C:\\Users\\user\\Taxes\\x.pdf now.", "Then .\\[outside path] now."],
    ["Then x//server/share/docs/s.txt now.", "Then x[outside path] now."],
    ["Then //server/share/docs/s.txt now.", "Then [outside path] now."],
    [`Read ${WR}\\a.txt then x//server/share/My docs/s.txt now.`, "Read a.txt then x[outside path] now."],
  ];
  for (const [input, want] of win) {
    it(`win32: ${input}`, () => {
      const out = brief(WR, input, "win32");
      hidden(out);
      assert.equal(out, want);
    });
  }
});

describe("glued roots that main already hid stay hidden", () => {
  it("quotes, =, brackets, file:, ~/, drive and UNC forms", () => {
    for (const p of ['"', "'", "`", "=", "(", "[", "{", "<", ",", ";", "a=", "--out=", "\\", "~"]) hidden(brief(W, `Read ${W}/a.txt then ${p}${T} now.`));
    hidden(brief(W, `Read ${W}/a.txt and file:///Users/user/Documents/My Taxes/x.pdf now.`));
    for (const p of ["", ".", ".\\", "..\\", "x", "9", '"', "=", ":", "(", "file:", "~", "/"]) hidden(brief(WR, `Read ${WR}\\a.txt then ${p}C:\\Users\\user\\My Taxes\\x.pdf now.`, "win32"));
    for (const p of ["x", "9", ".", '"', "=", "(", "/"]) hidden(brief(WR, `Read ${WR}\\a.txt then ${p}\\\\server\\share\\My docs\\s.txt now.`, "win32"));
  });
});

describe("a head strictly inside the folder splits at any whitespace", () => {
  it("brings back the words before an outside path", () => {
    assert.equal(brief(W, `Copy ${W}/a.txt to /Users/user/Documents/My Taxes/secret.txt now.`), "Copy a.txt to [outside path] now.");
    assert.equal(brief(W, `Copy ${W}/a.txt to ${W}/b.txt now.`), "Copy a.txt to b.txt now.");
    assert.equal(brief(W, `See ${W}/a.txt (draft) and ${W}/b.txt now.`), "See a.txt (draft) and b.txt now.");
    assert.equal(brief(WR, `Copy ${WR}\\a.txt to C:\\Users\\user\\My Taxes\\x.pdf now.`, "win32"), "Copy a.txt to [outside path] now.");
  });
  it("the folder itself still needs a sentence boundary (a sibling's name)", () => {
    for (const s of [`Read ${W} Private/medical records.pdf now.`, `Read ${W} Private/Health/medical.pdf now.`]) {
      const out = brief(W, s);
      assert.ok(!/Private|medical|user/.test(out), out);
    }
    const out = brief(W, `Read ${W}/a.txt and ${W} Private/Health/medical.pdf now.`);
    assert.ok(!/Private|medical|user/.test(out), out);
    const w = brief(WR, `Read ${WR} secret\\medical records.pdf now.`, "win32");
    assert.ok(!/secret|medical|John/.test(w), w);
  });
  it("a .. segment anywhere is never split", () => {
    for (const s of [`Read ${W}/a b/../../Work Private/x.pdf now.`, `Read ${W}/a b/c d/../../../Work Private/x.pdf now.`]) {
      const out = brief(W, s);
      assert.ok(!/Private|user/.test(out), out);
    }
    const w = brief(WR, `Read ${WR}\\a b\\..\\..\\proj secret\\x.pdf now.`, "win32");
    assert.ok(!/secret|John/.test(w), w);
  });
});

describe("plain words and relative paths stay as they were", () => {
  it("fractions, and/or, URLs, ~2/3, relative paths", () => {
    for (const s of ["1/2 and/or 3/4 a/b/c x/y.txt", "ratio 3/4/5 and km/h", "approx ~2/3 of it, see https://example.com/a/b", "src/home/index.tsx and build/tmp/out.log and ./tmp/x.csv"]) assert.equal(brief(W, s), s);
  });
  it("inside paths with known-root names and doubled separators keep their inside reading", () => {
    assert.equal(brief(W, `Read ${W}/sub/home/x.txt now.`), "Read sub/home/x.txt now.");
    assert.equal(brief(W, `Copy ${W}/project x/tmp/out.csv now.`), "Copy project x/tmp/out.csv now.");
    assert.equal(brief(W, `See ${W}/sub//b/a.txt now.`), "See sub//b/a.txt now.");
  });
});
