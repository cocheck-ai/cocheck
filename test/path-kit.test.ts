// One module owns path comparison and display form; the win32 cases run through the win32 platform on any OS.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPathKit, pathKit } from "../src/paths.ts";
import { platformFor } from "../src/platform/index.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";

const win = createPathKit(platformFor("win32"));
const mac = createPathKit(platformFor("darwin"));
const FOLDER = "C:\\Users\\T\\work";

describe("path kit on win32", () => {
  it("reads absolute forms", () => {
    for (const p of ["C:\\x", "c:/x", "\\\\host\\share\\x", "/c/Users/T/work/x"]) assert.equal(win.isAbs(p), true, p);
    assert.equal(win.isAbs("sub\\x.txt"), false);
  });
  it("a file in the folder reads inside with its relative label", () => {
    assert.equal(win.rel(FOLDER, "C:\\Users\\T\\work\\sub\\a.xlsx"), "sub/a.xlsx");
    assert.equal(win.rel(FOLDER + "\\", "C:\\Users\\T\\work\\a.xlsx"), "a.xlsx");
  });
  it("mixed case and Git Bash forms read inside too", () => {
    assert.equal(win.rel(FOLDER, "c:\\users\\t\\WORK\\A.xlsx"), "A.xlsx");
    assert.equal(win.rel(FOLDER, "/c/Users/T/work/x.csv"), "x.csv");
    assert.equal(win.native("/c/Users/T/work/x.csv"), "C:\\Users\\T\\work\\x.csv");
  });
  it("a drive root folder (or Git Bash `/w`) holds the files under it", () => {
    assert.equal(win.rel("/w", "/w/model.xlsx"), "model.xlsx");
    assert.equal(win.rel("C:\\", "C:\\a\\b.txt"), "a/b.txt");
    assert.equal(win.inside("/w", "/x/model.xlsx"), false);
  });
  it("an outside file stays outside, and dot-dot cannot sneak in", () => {
    assert.equal(win.inside(FOLDER, "C:\\Users\\T\\other\\a.txt"), false);
    assert.equal(win.inside(FOLDER, "C:\\Users\\T\\work\\..\\other\\a.txt"), false);
    assert.equal(win.inside(FOLDER, "C:\\Users\\T\\workshop\\a.txt"), false);
    assert.equal(win.inside(FOLDER, FOLDER), false);
    assert.equal(win.baseName("C:\\Users\\T\\other\\a.txt"), "a.txt");
    assert.equal(win.dirName("C:\\Users\\T\\other\\a.txt"), "C:/Users/T/other");
  });
});

describe("path kit keeps posix behaviour", () => {
  it("does not read a backslash path or a Git Bash form as anything special", () => {
    assert.equal(mac.isAbs("C:\\x"), false);
    assert.equal(mac.rel("/Users/t/work", "/Users/t/work/a/b.txt"), "a/b.txt");
    assert.equal(mac.inside("/Users/t/work", "/Users/t/work/../x.txt"), false);
    assert.equal(mac.native("/c/x"), "/c/x");
    assert.equal(mac.inside("/u/work", "/u/Work/x"), false);
    assert.equal(mac.inside("/u/work", "/u/work/x"), true);
    assert.equal(mac.baseName("a\\b"), "a\\b");
  });
  it("the running platform's kit answers a posix path", () => {
    assert.equal(pathKit().isAbs("sub/x"), false);
  });
});

describe("timeline scrub with a win32 folder", () => {
  it("a Windows path inside the folder reads relative; one outside is still cut", () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const t = buildTimeline({
        taskId: 1, build: "test-build", folder: "C:\\Users\\T\\work", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: true,
        ops: [
          call("k1", { desc: "", at: 10, said: "Saw C:\\Users\\T\\work\\sub\\a.xlsx here." }),
          call("k3", { desc: "", at: 15, said: "Saw c:\\users\\t\\WORK\\b.csv here." }),
          call("k2", { desc: "", at: 20, said: "Also C:\\Users\\T\\other\\notes.txt there." }),
          prompt("s1", ["go"]),
          stop("s1", "ok"),
        ],
        fileStates: [],
      });
      const texts = t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls.map((c) => c.line.text)));
      assert.ok(texts.includes("Saw sub/a.xlsx here."), texts.join(" | "));
      assert.ok(texts.includes("Saw b.csv here."), texts.join(" | "));
      assert.ok(texts.includes("Also [outside path] there."), texts.join(" | "));
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });
});
