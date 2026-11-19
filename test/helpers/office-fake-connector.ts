// Test-only connector program: the shared Office program served with the fake driver and pager (office-fake.ts). Used by
// test/office-connector.test.ts to run `cocheck connector test` over the real program without any Office app. Not shipped.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { officeApp } from "../../src/office/connector/apps.ts";
import { serve } from "../../src/office/connector/program.ts";
import type { PdfPager } from "../../src/office/connector/pictures.ts";
import { drawnCropper, drawnPageReader, fakeDriver, fakePager } from "./office-fake.ts";

const lockDir = mkdtempSync(path.join(tmpdir(), "office-fake-lock-"));
// OFFICE_FAKE_OPTS (JSON FakeOptions) shapes the fake, for tests that run this program as a child (the SIGTERM test).
const opts = process.env.OFFICE_FAKE_OPTS ? JSON.parse(process.env.OFFICE_FAKE_OPTS) : {};
// Word's boxes come from the finder; this one places every wanted paragraph at the one pixel of the fake's 1x1 page, so the program's level 3 answer has boxes.
const pager: PdfPager = { ...fakePager, find: async (_pdf, queries) => ({ pages: [{ index: 1, width: 1, height: 1 }], results: queries.map((q) => ({ id: q.id, found: q.want ?? true, pagebreak: false, segments: (q.want ?? true) ? [{ page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, highlights: [] }] : [] })) }) };
await serve(officeApp(process.argv[2] ?? ""), { driver: fakeDriver(opts).driver, pager, crop: drawnCropper, pages: drawnPageReader, lockPath: path.join(lockDir, "lock"), pollMs: 10, goneWaitMs: 200 });
