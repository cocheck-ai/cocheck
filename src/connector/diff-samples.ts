// The samples an entry-"diff" connector's author ships so `cocheck connector test` can send it real `diffs` requests. CoCheck never invents a
// sample: the connector folder carries `samples/samples.json`, a list of `diffs` request params with the class the author says each one is, and the
// author's recorded history beside it. Under test the connector is told the folder through COCHECK_TEST_SAMPLES and answers from that history.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Problem } from "./schema.ts";

/** The variable the test sets for a diff-entry connector: the samples folder (the same pattern as COCHECK_TEST_STATES for a snapshot connector). */
export const TEST_SAMPLES_ENV = "COCHECK_TEST_SAMPLES";
export const SAMPLES_DIR = "samples";
export const SAMPLES_FILE = "samples.json";
/** Exactly these classes are required, one sample each at least. A sample of any other class is graded on the checks every answer gets, and is optional. */
export const REQUIRED_SAMPLE_CLASSES = ["changed", "no-change", "failed-read"] as const;

export interface DiffSample { index: number; class: string; params: { subject: string; since: string; until: string } }
export interface SamplesRead { dir: string; samples: DiffSample[]; problems: Problem[]; found: boolean }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Reads `<connector>/samples/samples.json`. `found` is false when there is no samples file at all; a file that cannot be read, or a sample that is not
 * well formed, is a problem (never skipped silently), and only the well-formed samples are returned. */
export function readDiffSamples(connectorDir: string): SamplesRead {
  const dir = path.join(connectorDir, SAMPLES_DIR);
  const file = path.join(dir, SAMPLES_FILE);
  const rel = `${SAMPLES_DIR}/${SAMPLES_FILE}`;
  const problems: Problem[] = [];
  if (!existsSync(file)) return { dir, samples: [], problems, found: false };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    problems.push({ file: rel, field: "samples", expected: "a JSON object with a samples list", found: `a file that does not parse (${(error as Error).message})`, fix: 'Write samples.json as {"samples": [...]}.' });
    return { dir, samples: [], problems, found: true };
  }
  return { dir, ...parseDiffSamples(json), found: true };
}

/** The samples a parsed samples.json holds, and a problem for each one that is not well formed (and for a file that is not {"samples": [...]}). */
export function parseDiffSamples(json: unknown): { samples: DiffSample[]; problems: Problem[] } {
  const rel = `${SAMPLES_DIR}/${SAMPLES_FILE}`;
  const problems: Problem[] = [];
  const list = (json as { samples?: unknown } | null)?.samples;
  if (typeof json !== "object" || json === null || !Array.isArray(list)) {
    problems.push({ file: rel, field: "samples", expected: "a list of samples", found: JSON.stringify(list ?? json) ?? "nothing", fix: 'Write samples.json as {"samples": [...]}.' });
    return { samples: [], problems };
  }
  const samples: DiffSample[] = [];
  list.forEach((s: unknown, index) => {
    const field = `samples[${index}]`;
    const o = (typeof s === "object" && s !== null ? s : {}) as { class?: unknown; params?: unknown };
    const p = (typeof o.params === "object" && o.params !== null ? o.params : {}) as { subject?: unknown; since?: unknown; until?: unknown };
    const bad: string[] = [];
    if (!isStr(o.class)) bad.push("class");
    if (!isStr(p.subject)) bad.push("params.subject");
    for (const k of ["since", "until"] as const) if (!isStr(p[k]) || !ISO.test(p[k]) || !Number.isFinite(Date.parse(p[k]))) bad.push(`params.${k}`);
    if (bad.length === 0 && Date.parse(p.since as string) >= Date.parse(p.until as string)) bad.push("params.since before params.until");
    if (bad.length > 0) {
      problems.push({ file: rel, field, expected: 'a class and params {subject, since, until} with ISO 8601 times, since before until', found: `a sample missing or bad in ${bad.join(", ")}`, fix: "Give each sample the class you say it is and the params of one diffs request, as the spec's example shows." });
      return;
    }
    samples.push({ index, class: o.class as string, params: { subject: p.subject as string, since: p.since as string, until: p.until as string } });
  });
  return { samples, problems };
}
