// every picture the three Office connectors answer says what drew it (spec v1.1 `renderedBy`), over the fake driver (no Office is touched).
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { hostPlatform } from "../src/platform/index.ts";
import { OFFICE_APPS, type OfficeApp } from "../src/office/connector/apps.ts";
import { answerDiff, levelFor, type OfficeDoc, type ProgramDeps } from "../src/office/connector/program.ts";
import { fakeCropper, fakeDriver, fakePageReader, fakePager, FIXTURES, type FakeOptions } from "./helpers/office-fake.ts";
import { tempDirRemovedAtExit } from "./helpers/temp-dirs.ts";

const os = hostPlatform()?.name ?? "unknown";
async function run(app: OfficeApp, o: FakeOptions): Promise<OfficeDoc> {
  const f = fakeDriver(o);
  const lockPath = path.join(tempDirRemovedAtExit("office-lock-"), "lock");
  const deps: ProgramDeps = { driver: f.driver, pager: fakePager, crop: fakeCropper, pages: fakePageReader, lockPath, pollMs: 5, goneWaitMs: 100, lockWaitMs: 200 };
  const fx = (v: 1 | 2): string => path.join(FIXTURES, `v${v}${app.exts[0]}`);
  return answerDiff(app, fx(1), fx(2), deps);
}

for (const app of Object.values(OFFICE_APPS)) {
  describe(`${app.id}: renderedBy on every picture`, () => {
    it("tool is the app's name, version is what the driver read, os is the OS name; accepted at its level", async () => {
      const doc = await run(app, { version: "16.99.1" });
      assert.ok((doc.pictures ?? []).length > 0);
      for (const p of doc.pictures as unknown as { renderedBy?: unknown }[]) assert.deepEqual(p.renderedBy, { tool: app.name, version: "16.99.1", os });
      assert.deepEqual(checkChanges(doc, levelFor(app)), []);
    });
    for (const version of ["none", "throw", "  "]) {
      it(`a version the driver cannot read (${JSON.stringify(version)}) is "unknown", never empty or missing`, async () => {
        const doc = await run(app, { version });
        assert.ok((doc.pictures ?? []).length > 0);
        for (const p of doc.pictures as unknown as { renderedBy?: { version: string } }[]) assert.equal(p.renderedBy?.version, "unknown");
        assert.deepEqual(checkChanges(doc, levelFor(app)), []);
      });
    }
  });
}
