import { macOnly } from "./helpers/platform.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";

// under the test bootstrap the real Office bridge must refuse to run. (src/excel/osascript.ts is deleted; the
// bootstrap's PATH shim stays and is pinned here.)
describe("test guard against the real Office bridge", () => {
  it("a direct osascript spawn hits the bootstrap PATH shim and fails", macOnly("the test spawns osascript, which exists only on a Mac"), async () => {
    assert.equal(process.env.COCHECK_TEST_NO_OFFICE, "1");
    await assert.rejects(promisify(execFile)("osascript", ["-e", "return 1"]), /test reached the real Office bridge/);
  });
});
