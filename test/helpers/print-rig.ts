// A fake world for the Excel print route: office-fake.ts's driver in its own stage root, with an Office lock of its own. Nothing here reaches Excel, osascript or the real helper.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OfficeExportDriver } from "../../src/office/connector/office-job.ts";
import { fakeDriver, type FakeCall } from "./office-fake.ts";

export interface PrintRig { driver: OfficeExportDriver; calls: FakeCall[]; stageRoot: string; lockPath: string }

export function printRig(o: { lockPath?: string } = {}): PrintRig {
  const stageRoot = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  const f = fakeDriver({ stageRoot });
  return { driver: f.driver, calls: f.calls, stageRoot, lockPath: o.lockPath ?? path.join(stageRoot, "office.lock") };
}
