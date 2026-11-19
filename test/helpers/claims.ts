// The hook takes `claimed(file)` (a connector claims it). Tests that drive the hook with
// an xlsx or files layer pass the answer that layer gives, so each predicate site keeps the behaviour the test was written against.
import { isTrackedFolderFile } from "../../src/formats/files/scan.ts";

/** What the xlsx layer accepted: .xlsx and .xlsm. */
export const workbookClaims = (file: string): boolean => /\.xls[xm]$/i.test(file);

/** What the eviction order called office files (xlsx, xlsm, docx, pptx), which the built-in Office connectors claim. */
export const officeClaims = (file: string): boolean => /\.(xlsx|xlsm|docx|pptx)$/i.test(file);

/** What the files layer accepted: the text-like files the folder watch tracks. */
export const trackedClaims = (file: string): boolean => isTrackedFolderFile(file);
