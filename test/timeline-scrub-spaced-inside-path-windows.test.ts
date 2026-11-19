// a spaced inside path followed by words keeps its words and is relabelled; no outside path shows.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { call, prompt, stop, fakeLook } from "./fixtures/timeline.ts";

function brief(folder: string, text: string): string {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
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
const R = "C:\\Users\\John Smith\\proj";
const hidden = (out: string): void => assert.ok(!/Taxes|Documents|other|secret|server|share|Admin/i.test(out), out);

describe("win32 spaced inside path followed by words", () => {
  it("keeps the words after the folder and relabels it", () => {
    assert.equal(brief(R, `Working directory is ${R}. Create t09\\helper-file.txt with initial content, ensuring t09 exists.`), "Working directory is proj. Create t09\\helper-file.txt with initial content, ensuring t09 exists.");
  });
  it("outside spaced path stays hidden", () => {
    hidden(brief(R, "Read C:\\Users\\John Smith\\Documents\\My Taxes\\2026 return.pdf now."));
    hidden(brief(R, "Read C:\\Users\\John Smith\\Documents\\My Taxes then open notes.txt now."));
  });
  it("inside then outside in one sentence", () => {
    const out = brief(R, `Copy ${R}\\a.txt to C:\\Users\\John Smith\\Documents\\My Taxes\\secret.txt now.`);
    hidden(out);
    // "a.txt" is strictly inside the folder, so its head splits off at a bare space; the rest is scanned again and the outside path cut.
    assert.equal(out, "Copy a.txt to [outside path] now.");
  });
  it("..\\ escape", () => {
    hidden(brief(R, `See ${R}\\sub dir\\..\\..\\Documents\\My Taxes\\x.pdf. Then stop.`));
    hidden(brief(R, `See ${R}\\..\\other things\\keep.txt for details.`));
  });
  it("UNC path, alone and after an inside path", () => {
    hidden(brief(R, "See \\\\server\\share\\Admin docs\\secret.txt now."));
    hidden(brief(R, `Go ${R}\\a.txt then \\\\server\\share\\Admin docs\\secret.txt now.`));
    hidden(brief(R, `Go ${R}. Then (\\\\server\\share\\other dir\\secret.txt) done.`));
  });
  it("a sibling folder sharing the folder's name prefix stays hidden", () => {
    const out = brief(R, "Read C:\\Users\\John Smith\\proj secret\\medical records.pdf now.");
    hidden(out);
    assert.equal(out, "Read [outside path] now.");
    hidden(brief(R, `Read ${R}\\a b\\..\\..\\proj secret\\x.pdf now.`));
    hidden(brief(R, `Read ${R}\\a, b\\..\\..\\proj secret\\x.pdf now.`));
  });
  it("comma and semicolon boundaries keep the words", () => {
    assert.equal(brief(R, `Working directory is ${R}, create t09\\a.txt now.`), "Working directory is proj, create t09\\a.txt now.");
    assert.equal(brief(R, `Use ${R}; then write t09\\a.txt now.`), "Use proj; then write t09\\a.txt now.");
  });
  it("drive-root spaced paths stay hidden", () => {
    hidden(brief(R, "Read C:\\Secret Stuff\\x.pdf now."));
    hidden(brief(R, `Go ${R}. Then D:\\Admin docs\\secret.txt done.`));
    hidden(brief(R, `Go ${R}, D:\\Admin docs\\secret.txt done.`));
  });
});
