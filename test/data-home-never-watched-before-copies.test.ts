import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { platform } from "../src/platform/index.ts";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { workbookClaims } from "./helpers/claims.ts";

// the data home is CoCheck's own, wherever it sits. With the home inside the watched folder
// (--folder ~/proj --home ~/proj/.cocheck-data, or ~ and ~/.cocheck), an Open before copy under <home>/before-copies must never be
// walked, baselined or recorded. Guards against: a user folder merely named like the home, but elsewhere, is still recorded.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const fixture = async (name: string, over: Record<string, unknown>): Promise<HookPayload> =>
  ({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), ...over }) as HookPayload;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(homeRel: string) {
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-r2-folder-")));
  const home = path.join(folder, homeRel);
  await mkdir(home, { recursive: true });
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  await copyFile(path.join(FIXTURES, "probe", "S0.xlsx"), path.join(folder, "casebook.xlsx"));
  const hostOpts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder };
  const send = (name: string, over: Record<string, unknown> = {}) => fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, hostOpts));
  const cycle = async (id: string, act: () => Promise<void>) => {
    const tool_input = { command: "touch", description: id };
    await send("claude-pre-bash.json", { tool_use_id: id, tool_input });
    await act();
    await send("claude-post-bash.json", { tool_use_id: id, tool_input });
    await send("claude-stop.json");
  };
  const states = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1);
    } finally {
      l.close();
    }
  };
  return { folder, home, cycle, states };
}

describe("the data home is never watched, wherever it sits", () => {
  for (const homeRel of [".cocheck-data", path.join("nested", "deep", "data")]) {
    it(`home at <folder>/${homeRel}: a file written under the home during a hook cycle records nothing`, async () => {
      const t = await setup(homeRel);
      await t.cycle("toolu_1", async () => {
        // core has no "Open in Excel" or before copies; any file written under the home still records nothing
        mkdirSync(path.join(t.home, "before-copies", "1"), { recursive: true });
        writeFileSync(path.join(t.home, "before-copies", "1", "book.xlsx"), Buffer.from("PK before"));
        await writeFile(path.join(t.folder, "out.txt"), "x\n");
      });
      const files = t.states().map((s) => s.filePath);
      assert.ok(files.some((f) => f.endsWith("out.txt")), "control: a file beside the home is recorded");
      assert.deepEqual(files.filter((f) => f.startsWith(t.home + path.sep) || f.includes("before-copies")), []);
    });
  }

  it("a user folder merely named like the home, elsewhere in the folder, is still recorded", async () => {
    const t = await setup(".cocheck-data");
    await t.cycle("toolu_1", async () => {
      await mkdir(path.join(t.folder, "sub", ".cocheck-data", "before-copies"), { recursive: true });
      await writeFile(path.join(t.folder, "sub", ".cocheck-data", "before-copies", "mine.txt"), "mine\n");
      await mkdir(path.join(t.folder, "before-copies"), { recursive: true });
      await writeFile(path.join(t.folder, "before-copies", "yours.txt"), "yours\n");
    });
    const files = t.states().map((s) => s.filePath);
    assert.ok(files.some((f) => f.endsWith(path.join("sub", ".cocheck-data", "before-copies", "mine.txt"))), files.join("\n"));
    assert.ok(files.some((f) => f.endsWith(path.join("before-copies", "yours.txt"))));
  });
});
