// The test helpers' temp folders are removed when the test process exits: the fake Office driver's stage root and state pairs. Before, every
// run left them in the OS temp folder (19,062 office-fake-stage- folders on a dev Mac).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const helper = (name: string): string => pathToFileURL(path.join(import.meta.dirname, "helpers", name)).href;

describe("test helper temp folders", () => {
  it("the fake Office driver's stage root and a state-pairs folder are gone once the process that made them exits", () => {
    const code = `import { fakeDriver, statePairs } from ${JSON.stringify(helper("office-fake.ts"))};
const { stageRoot } = fakeDriver();
const pairs = statePairs(".docx");
console.log(JSON.stringify({ stageRoot, pairs }));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const { stageRoot, pairs } = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { stageRoot: string; pairs: string };
    assert.ok(stageRoot.length > 0 && pairs.length > 0);
    assert.equal(existsSync(stageRoot), false, `left behind: ${stageRoot}`);
    assert.equal(existsSync(pairs), false, `left behind: ${pairs}`);
  });
});
