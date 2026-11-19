/**
 * The plain line a failed step shows: the line of the host's own words that says what went wrong, with the words themselves kept beside
 * it for "Show output". It is a view on `RailStop.failure`; the send-back prompt and the submission record keep the raw error and never read it.
 */

/** What the page shows for a failed step: the line, and the host's own words behind it. */
export interface Failure {
  blurb: string;
  raw: string;
  /** False when the host recorded no words: `raw` is then CoCheck's own sentence, not a quote, and the page offers no "what the host said". */
  hasText: boolean;
}

/** What the model build knows about one failed stop: the host's words, and whether there are any. */
export interface FailureInput {
  raw: string;
  hasText: boolean;
}

/** Lines that never carry the cause: trace frames, headers, notices, a bare exit code. */
const NOISE = /^(at |File |Traceback|Require stack|Node\.js v|\[notice\]|throw |[~^\s]+$|exit code \d+$)/i;
/** Lines that read as the error itself. */
const ERRORISH = /error|exception|no such file|not found|cannot|can't|couldn't|denied|invalid|not available|no module named/i;

/**
 * The line that says what went wrong, cut to one readable line: the last error-looking line that is not a header or a trace frame (the
 * final line of a Python traceback, the line naming the missing module or file); else the first line that says anything; else the first line.
 */
export function firstMeaningfulLine(raw: string): string {
  const lines = raw.split("\n").map((l) => l.trim());
  const said = lines.filter((l) => /[\p{L}\p{N}]/u.test(l) && !NOISE.test(l));
  const line = [...said].reverse().find((l) => ERRORISH.test(l)) ?? said[0] ?? lines.find((l) => l !== "") ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** Sets `failure` on every failed stop: the first meaningful line of the host's words, and the words themselves. */
export function attachFailureLines(model: { stops: Array<{ id: string; failure?: Failure }> }, raws: ReadonlyMap<string, FailureInput>): void {
  for (const stop of model.stops) {
    const r = raws.get(stop.id);
    if (r) stop.failure = { blurb: firstMeaningfulLine(r.raw), raw: r.raw, hasText: r.hasText };
  }
}
