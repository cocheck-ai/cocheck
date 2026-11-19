// The print route says two different things when an app's call does not answer (restored from "the print route" cases of test/office-open-prompt.test.ts,
// deleted with the screen look in 5b11b074). A call cut short by the job's deadline is CoCheck's time (budgetWhy); a call that ran its own full time is the app's hang (hangWhy, hang: true).
// The Guards against: an app's hang worded as CoCheck's timeout (the app is let off), or CoCheck's own budget worded as the app's hang (the app is blamed).
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { OFFICE_APPS, budgetWhy } from "../src/office/connector/apps.ts";
import { officePdfs } from "../src/office/connector/office-job.ts";
import { fakeDriver } from "./helpers/office-fake.ts";

const __FILE__ = fileURLToPath(import.meta.url);
const xl = OFFICE_APPS.excel;
const target = { sheet: "Sheet1", kind: "worksheet" as const, area: "$A$1:$B$2", zoom: 100, landscape: false };
const run = async (deadlineMs: number) => {
  const f = fakeDriver({ exportAs: "timeout" });
  const j = await officePdfs(xl, [{ side: "after", file: __FILE__, name: "a.xlsx", targets: [target] }], { driver: f.driver, lockPath: path.join(f.stageRoot, "lock"), deadline: Date.now() + deadlineMs, sideTimeoutMs: 25_000, pollMs: 5, goneWaitMs: 100 });
  assert.ok(!j.pending);
  return j.pending ? undefined : j.sides[0];
};

describe("the print route: CoCheck's budget and an app that did not answer are two different sentences", () => {
  it("a call cut short by the job's deadline reads as CoCheck's time, not as a hang", async () => {
    const s = await run(8_000);
    assert.deepEqual(s, { side: "after", why: budgetWhy(xl) });
    assert.match(budgetWhy(xl), /CoCheck's time for pictures ran out/);
  });
  it("a call that ran its own full time is the app's hang", async () => {
    const s = await run(60_000);
    assert.deepEqual(s, { side: "after", why: xl.hangWhy, hang: true });
    assert.notEqual(xl.hangWhy, budgetWhy(xl));
  });
});
