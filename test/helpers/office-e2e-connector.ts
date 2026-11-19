// Test-only connector program: the shared Office program (serve) with fake Office, for an end-to-end review of several Office files in one task.
// Every child started from one test shares one Office lock (OFFICE_E2E_LOCK), as the real connectors share defaultLockPath(). Every app runs the print route on office-fake.ts's driver, each side's export
// taking OFFICE_E2E_EXPORT_MS. diffMs and its reserves come from OFFICE_E2E_DIFF_MS (the test's manifest gives CoCheck the same diffMs). Not shipped.
import { officeApp } from "../../src/office/connector/apps.ts";
import { serve, type ProgramDeps } from "../../src/office/connector/program.ts";
import { fakeCropper, fakeDriver, fakePageReader, fakePager } from "./office-fake.ts";

const app = officeApp(process.argv[2] ?? "");
const lockPath = process.env.OFFICE_E2E_LOCK!;
const diffMs = Number(process.env.OFFICE_E2E_DIFF_MS ?? "8000");
const exportMs = Number(process.env.OFFICE_E2E_EXPORT_MS ?? "800");
const reserves = { marginMs: 300, cleanupMs: 1_000, drawMs: 700 };
const common = { pager: fakePager, crop: fakeCropper, pages: fakePageReader, lockPath, pollMs: 10, goneWaitMs: 300, lockWaitMs: 15_000, diffMs, reserves };
const deps: ProgramDeps = { ...common, driver: fakeDriver({ delayMs: exportMs }).driver };
await serve(app, deps);
