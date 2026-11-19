// While an Office app is asked to open a staged copy, CoCheck watches for a prompt that blocks the open. Platform-free: the window list comes through `WindowScreen.windows`
// (the screen helper, by pid; no Accessibility grant) and the confirmation through the app's own document list, so fakes exercise exactly this code.
//
// What is observable (apps launched hidden by CoCheck):
//   - Real prompts. Excel (chart axes crossing an axis that does not exist): two new untitled windows (410x384, 260x234) within about 0.7 s; the open never answers; Excel
//     answers its workbook list in 0.1-0.3 s, over and over (163 times in 60 s), never with the copy. PowerPoint (malformed slide): one new untitled 1600x900 window holding
//     the repair prompt; the open never answers; the presentation list answers at once, empty. Word (malformed XML) shows no prompt: the open answers and no document appears.
//   - Healthy opens. Small and large files (200-page docx with images, 100-slide pptx, 10.7 MB xlsx) open in 0.5-1.1 s. Slow ones (an Excel workbook recalculating 300 000
//     formulas: 3.8 s; a 6 000-table docx: 2.3 s) list no untitled window while the open is pending, and the document-list request does NOT answer (no answer in 2 s) while
//     the app is busy opening. Word adds an untitled 500x500 helper window (the repo's live fixture word-look-live.json, window 31117), seen right after the open
//     answered; a slower open could list it while still pending, so a window alone is never enough.
// The rule: while the open is pending, a sized window of our pid that was not listed before the open and whose title names no copy of this launch stays listed `holdMs`; then
// the app must answer its document list `confirmations` times in a row, each within `confirmMs`, without the copy, with the open still pending. A list that does not answer
// (the app is busy) or that names the copy resets the confirmation. With no way to ask for the list, there is no prompt verdict at all. The prompt's text is NOT read.
// Windows (no driver yet): this module is the seam. A Windows driver whose screen helper answers `WindowScreen.windows(pid)` (a top-level window list by process, with titles and
// sizes) gets the same rule and the same words; whether Office for Windows shows its repair prompt as a separate top-level window of the same process is not yet observed.
import type { WindowScreen } from "./office-job.ts";

export interface OpenWatch {
  helper: WindowScreen;
  pid: number;
  /** Window ids listed right before the open (the app's own shells and any copy already open in this launch). */
  before: ReadonlySet<number>;
  /** The staged copies' names without their ending (this one, and any other copy of the same launch): a window whose title contains one is a copy's own. */
  names: readonly string[];
  now?: () => number;
  /** How often the list is read while the open is pending, ms (default 250). */
  tickMs?: number;
  /** How long a stray window must stay listed, ms (default 1500). */
  holdMs?: number;
  /**
   * The app's own document list, asked with a cap of `confirmMs`: "absent" (it answered, and the copy is not in it), "present" (the copy is open) or "no-answer". Absent:
   * a window alone is never a prompt verdict.
   */
  confirm?: (timeoutMs: number) => Promise<"absent" | "present" | "no-answer">;
  /** How many answers in a row must say "absent" (default 2), and the cap on each (default 1500 ms). */
  confirmations?: number;
  confirmMs?: number;
}

export interface StrayWindow { id: number; w: number; h: number }
export type Watched<T> = { done: T } | { prompt: { afterMs: number; windows: StrayWindow[] } };

export const PROMPT_TICK_MS = 250;
export const PROMPT_HOLD_MS = 1_500;
export const PROMPT_CONFIRMATIONS = 2;
export const PROMPT_CONFIRM_MS = 1_500;

const stray = (w: { id: number; layer: number; bounds: { w: number; h: number }; title: string }, before: ReadonlySet<number>, names: readonly string[]): boolean =>
  w.layer === 0 && w.bounds.w > 1 && w.bounds.h > 1 && !before.has(w.id) && !names.some((n) => n !== "" && w.title.includes(n));

/**
 * Races the open `call` against the window list. Answers `{ done }` when the call settles first, or `{ prompt }` once a stray window has stayed listed `holdMs` while the call is
 * still pending. The call is never cancelled here: after a prompt the caller stops the app it launched (which ends the call), and nothing in the prompt is ever clicked.
 */
export async function watchedOpen<T>(call: Promise<T>, o: OpenWatch): Promise<Watched<T>> {
  const now = o.now ?? Date.now;
  const tick = o.tickMs ?? PROMPT_TICK_MS, hold = o.holdMs ?? PROMPT_HOLD_MS;
  const t0 = now();
  let settled: { v: T } | undefined;
  let failure: { e: unknown } | undefined;
  const done = call.then((v) => { settled = { v }; }, (e: unknown) => { failure = { e }; });
  let since: number | undefined, absent = 0;
  const pending = (): boolean => settled === undefined && failure === undefined;
  for (;;) {
    const waited = await Promise.race([done.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), tick))]);
    if (waited || !pending()) break;
    const list = await o.helper.windows(o.pid).catch(() => ({ ok: false as const, why: "no answer" }));
    if (!pending()) break;
    const found = list.ok ? list.windows.filter((w) => stray(w, o.before, o.names)) : [];
    if (found.length === 0) { since = undefined; absent = 0; continue; }
    since ??= now();
    if (now() - since < hold || o.confirm === undefined) continue;
    // the window held: the app must also answer its document list, without the copy, while the open is still pending
    const said = await o.confirm(o.confirmMs ?? PROMPT_CONFIRM_MS).catch(() => "no-answer" as const);
    if (!pending()) break;
    absent = said === "absent" ? absent + 1 : 0;
    if (absent >= (o.confirmations ?? PROMPT_CONFIRMATIONS)) return { prompt: { afterMs: since - t0, windows: found.map((w) => ({ id: w.id, w: w.bounds.w, h: w.bounds.h })) } };
  }
  if (failure !== undefined) throw failure.e;
  return { done: settled!.v };
}
