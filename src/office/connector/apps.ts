// The per-app table of the three built-in Office connectors (microsoft-excel, microsoft-word, microsoft-powerpoint). One shared program
// (program.ts) serves all three; this table is the only place they differ in the shared code. What each app is told to do lives in the
// platform's driver (src/office/connector/office-macos.ts on the Mac), keyed by the same `key`.

import path from "node:path";

export type OfficeAppKey = "excel" | "word" | "powerpoint";

export interface OfficeApp {
  key: OfficeAppKey;
  /** The connector id and folder name under connectors/. */
  id: string;
  /** The app's name, as people know it and as its process is named. */
  name: string;
  /**
   * The endings this connector claims (its manifest's matches.extensions, in the same order). Each side is staged under the file's own ending
   * when it is one of these (`stagingExt`), else under the first: Office refuses a macro or show file saved under another ending.
   */
  exts: readonly string[];
  /** What one file is called, for sentences ("workbook"). */
  noun: string;
  /** Said when the app stops answering on a file and the job had to stop the app: a call that ran its own full time, never CoCheck's budget running out (`budgetWhy`). */
  hangWhy: string;
}

export const OFFICE_APPS: Record<OfficeAppKey, OfficeApp> = {
  excel: { key: "excel", id: "microsoft-excel", name: "Microsoft Excel", exts: [".xlsx", ".xlsm"], noun: "workbook", hangWhy: "Microsoft Excel stopped answering on this workbook and was stopped" },
  word: { key: "word", id: "microsoft-word", name: "Microsoft Word", exts: [".docx"], noun: "document", hangWhy: "Microsoft Word stopped answering on this document and was stopped" },
  // A broken deck hangs PowerPoint behind a hidden repair prompt. (A prompt the screen route sees has its own words,
  // `promptWhy`; this hang text is still used where no window list is read, the print route. Pinned by test/office-connector.test.ts.)
  powerpoint: { key: "powerpoint", id: "microsoft-powerpoint", name: "Microsoft PowerPoint", exts: [".pptx", ".pptm", ".ppsx", ".ppsm"], noun: "presentation", hangWhy: "PowerPoint would ask to repair this file" },
};

/**
 * The four ways an open can end without a picture, in the reviewer's words, kept apart (a repair prompt must not be reported as "out of time" or "stopped answering"):
 *   promptWhy:  the app put up a prompt (a window that is not the file's) while the open was pending, and never opened the file (open-watch.ts). What it said is not read.
 *   refusedWhy: the app answered the open, but the file never appeared among its open files (Word, damaged XML).
 *   hangWhy:    a call ran its own full time with no answer (the field above).
 *   budgetWhy:  CoCheck's own time for pictures ran out before the app answered.
 */
export const promptWhy = (app: Pick<OfficeApp, "name" | "noun">): string => `${app.name} showed a prompt instead of opening this ${app.noun} (CoCheck never answers such prompts), so it is not pictured`;
export const refusedWhy = (app: Pick<OfficeApp, "name" | "noun">): string => `${app.name} did not open this ${app.noun}: it answered, but the ${app.noun} never appeared, so it is not pictured`;
export const budgetWhy = (app: Pick<OfficeApp, "name" | "noun">): string => `CoCheck's time for pictures ran out before ${app.name} answered on this ${app.noun}`;

/** The ending a side is staged and read under: the file's own ending (lowercased) when this app claims it, else the app's first ending. */
export const stagingExt = (app: Pick<OfficeApp, "exts">, file: string): string => {
  const own = path.extname(file).toLowerCase();
  return app.exts.includes(own) ? own : app.exts[0]!;
};

/** The base name a side is staged under: the real name when it already ends in an ending this app claims, else "<side><first ending>". */
export const stageName = (file: string, side: "before" | "after", app: Pick<OfficeApp, "exts">): string => (app.exts.includes(path.extname(file).toLowerCase()) ? path.basename(file) : `${side}${app.exts[0]!}`);

export const officeApp = (key: string): OfficeApp => {
  const app = (OFFICE_APPS as Record<string, OfficeApp | undefined>)[key];
  if (app === undefined) throw new Error(`no Office connector named ${JSON.stringify(key)}`);
  return app;
};
