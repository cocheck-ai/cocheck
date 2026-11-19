import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { editTargetsOf, reportedEditsOf } from "../src/credit-guard.ts";
import { createPathKit, normalizePathForCompare } from "../src/paths.ts";
import { platformFor } from "../src/platform/index.ts";
import { copilot } from "../src/hosts/copilot.ts";

// The adapter's input reading (hook-adapter #writeIntent), run with the Windows path module and platform in place, a Windows cwd and task folder.
const realPlat = Object.getOwnPropertyDescriptor(process, "platform")!;
const saved: Record<string, unknown> = {};
// On a posix host `path.posix` is `path` itself: keep a copy so swapping the module's functions leaves the posix forms intact.
const POSIX = { ...path.posix };
const KEYS = ["resolve", "isAbsolute", "join", "normalize", "relative", "dirname", "basename", "parse", "sep", "delimiter", "format", "extname"] as const;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
  for (const k of KEYS) {
    saved[k] = (path as any)[k];
    (path as any)[k] = (path.win32 as any)[k];
  }
  (path as any).posix = POSIX;
  syncBuiltinESMExports();
});
afterEach(() => {
  Object.defineProperty(process, "platform", realPlat);
  for (const k of KEYS) (path as any)[k] = saved[k];
  (path as any).posix = path;
  syncBuiltinESMExports();
});

const FOLDER = "C:\\Users\\Ana\\cocheck-w010\\copilot-run";
const PATCH = "*** Begin Patch\n*** Add File: t09\\one.md\n+first\n*** End Patch";

/** What #writeIntent keeps: the edits and reported paths inside the folder. */
function judge(cwd: string | undefined, folder: string, toolArgs: unknown) {
  const kit = createPathKit(platformFor("win32"));
  const input = copilot.parseToolInput!(toolArgs);
  const cwdOf = cwd && path.isAbsolute(cwd) ? cwd : folder;
  const outside = (p: string) => {
    const f = normalizePathForCompare(kit.native(folder));
    const q = normalizePathForCompare(kit.native(p));
        return !kit.same(q, f) && !kit.inside(f, q);
  };
  const rel = (p: string) => path.resolve(cwdOf, p);
  const edits = editTargetsOf("apply_patch", input, (p) => kit.isAbs(p), rel);
  const reported = edits === undefined ? [] : reportedEditsOf("apply_patch", input, (p) => kit.isAbs(p), (t) => t, rel);
  return { edits: (edits ?? []).filter((p) => !outside(p)), reported: reported.filter((c) => !outside(c.path)).map((c) => c.path), all: edits };
}

describe("win32 variants of a Copilot apply_patch payload", () => {
  const cases: Array<[string, string | undefined, unknown]> = [
    ["plain: cwd as the folder, bare string", FOLDER, PATCH],
    ["cwd with forward slashes", "C:/Users/Ana/cocheck-w010/copilot-run", PATCH],
    ["lowercase drive letter", "c:\\Users\\Ana\\cocheck-w010\\copilot-run", PATCH],
    ["trailing backslash on cwd", FOLDER + "\\", PATCH],
    ["toolArgs as a JSON-encoded string", FOLDER, JSON.stringify(PATCH)],
    ["toolArgs as a JSON object holding the patch", FOLDER, JSON.stringify({ input: PATCH })],
      ];
  for (const [name, cwd, args] of cases) {
    it(name, () => {
      const r = judge(cwd, FOLDER, args);
      assert.deepEqual(r.reported.length, 1);
    });
  }
  it("toolArgs absent reads nothing (a Post without args never overwrites what its Pre read)", () => {
    assert.deepEqual(judge(FOLDER, FOLDER, undefined).reported, []);
  });
  it("a name that is only a literal backslash file name on a posix host keeps its meaning: the win32 header resolves under the folder", () => {
    assert.equal(judge(FOLDER, FOLDER, "*** Begin Patch\n*** Add File: a\\b.md\n+x\n*** End Patch").reported.length, 1);
  });
  it("must not: a patch that climbs out of the folder is outside", () => {
    const r = judge(FOLDER, FOLDER, "*** Begin Patch\n*** Add File: ..\\escape.md\n+x\n*** End Patch");
    assert.deepEqual(r.edits, []);
  });
});
