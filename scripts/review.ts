#!/usr/bin/env node
/**
 * A stand-in for the review page: read what the person decided on a task's rail. Reads the same ledger as the server
 * (`$COCHECK_HOME/ledger.sqlite`, default `~/.cocheck`).
 *
 *   node scripts/review.ts list <task>
 *   node scripts/review.ts verify <file>
 *   node scripts/review.ts open [task]
 *
 * `list` prints the task's stops by review status (not reviewed, passed, failed), each failed stop with its note, the send-backs, and the
 * submission. It only reads: a verdict, a send-back and a submit are made on the rail page by the person, and there is no CLI verb
 * for any of them. The legacy `reject`, `approve` and `request` verbs, which wrote to the removed review page's tables, are gone.
 * There is no sign verb either: a real sign-off needs a signature (see src/signoff.ts).
 * `verify` exits 0 when the file matches a signed-off hash, 1 otherwise (a soft sign-off answers 1). `open` starts the standalone review
 * process if it isn't running and opens its page (the index, or the task's rail) in the default browser via macOS `open`
 * (`$COCHECK_OPEN_CMD` replaces the command).
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { openLedger, signoffQualifier, type Ledger } from "../src/ledger.ts";
import { BUILD_IDENTITY, openReviewUrl, reviewIndexUrl, reviewProcessCommand } from "../src/review-server.ts";
import { resolveCoCheckHome } from "../src/ledger.ts";
import { formatLocalTime, verifyFile } from "../src/signoff.ts";
import { defaultLayers, loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { summarize } from "../src/timeline/rail/stop-status.ts";

const USAGE = `usage:
  node scripts/review.ts list <task>
  node scripts/review.ts verify <file>
  node scripts/review.ts open [task]`;

class UsageError extends Error {}

/** A refusal or a negative answer that isn't a usage mistake: printed alone, exit 1. */
class Refusal extends Error {}

/** A plain decimal id: digits only, no sign, exponent, hex prefix, whitespace or leading zero. */
function positiveInt(value: string | undefined, what: string): number {
  const n = Number(value);
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n)) {
    throw new UsageError(`${what} must be a plain decimal id (e.g. 12), got ${JSON.stringify(value ?? "")}`);
  }
  return n;
}

/** The task's stops by status, its failed stops with their notes, its send-backs and its submission. Reads the ledger and the stored states; writes nothing. */
async function list(ledger: Ledger, home: string, taskId: number): Promise<string> {
  const loaded = loadRows(ledger, taskId, BUILD_IDENTITY);
  // No picture here: a picture is not needed to name a stop, and a listing must not start another program.
  const input = await loadTimelineInput(ledger, home, loaded, { layers: defaultLayers(), build: BUILD_IDENTITY, quickLook: false, render: async () => null });
  const timeline = buildTimeline(input);
  const model = buildRailModel(timeline);
  const summary = summarize(model, timeline, ledger.stopVerdictsForTask(taskId));
  const lines: string[] = [];
  const { counts } = summary;
  const changes = model.stops.filter((s) => s.change !== undefined).length;
  lines.push(`task ${taskId}: ${model.stops.length} ${model.stops.length === 1 ? "stop" : "stops"}: ${counts.passed} passed, ${counts.failed} failed, ${counts.not_reviewed} not reviewed${changes === 0 ? "; no file change recorded" : ""}`);
  for (const f of summary.failed) lines.push(`FAILED ${f.stop}: ${f.head}${f.note ? ` - "${f.note}"` : ""}`);
  const sendBacks = ledger.sendBacksForTask(taskId);
  if (sendBacks.length > 0) lines.push(`send-backs: ${sendBacks.length}${sendBacks.at(-1)!.note ? `; last overall note: "${sendBacks.at(-1)!.note}"` : ""}`);
  const submitted = ledger.submissionsForTask(taskId).at(-1);
  const signoffs = ledger.signoffsForTask(taskId);
  const record = submitted === undefined ? signoffs.at(-1) : signoffs.find((s) => s.id === submitted.signoffId);
  if (record !== undefined) {
    const qualifier = signoffQualifier(record);
    lines.push(`${submitted === undefined ? "signed off" : "submitted"} by ${record.signer}${qualifier === null ? "" : ` (${qualifier})`} on ${formatLocalTime(record.ts)}`);
  }
  // The latest submission is the current one above; earlier ones are history, newest first. New file states since it mean it can be submitted again.
  const allSubmissions = ledger.submissionsForTask(taskId);
  if (submitted !== undefined && ledger.newWorkSince(taskId, submitted)) lines.push("new work since that submission; it can be submitted again");
  if (allSubmissions.length > 1) {
    lines.push(`earlier submissions: ${allSubmissions.length - 1}`);
    for (const sub of allSubmissions.slice(0, -1).reverse()) {
      const r = signoffs.find((x) => x.id === sub.signoffId);
      const q = r === undefined ? null : signoffQualifier(r);
      lines.push(`  submitted by ${sub.reviewer}${q === null ? "" : ` (${q})`} on ${formatLocalTime(sub.ts)}`);
    }
  }
  return lines.join("\n") + "\n";
}

async function run(argv: string[]): Promise<string> {
  const [command, task] = argv;
  if (command === "list") {
    const taskId = positiveInt(task, "task");
    const home = resolveCoCheckHome();
    const ledger = openLedger(home);
    try {
      if (ledger.taskClient(taskId) === undefined) {
        throw new UsageError(`no task ${taskId}`);
      }
      return await list(ledger, home, taskId);
    } finally {
      ledger.close();
    }
  }
  if (command === "verify") {
    if (!task || argv.length !== 2) {
      throw new UsageError("verify needs exactly one file");
    }
    if (!existsSync(task) || !statSync(task).isFile()) {
      throw new Refusal(`no such file: ${task}`);
    }
    const ledger = openLedger();
    try {
      const result = await verifyFile(ledger, task);
      if (!result.match) {
        // An answer, not an error: printed like a match, with exit 1.
        process.exitCode = 1;
      }
      return `${result.message}\n`;
    } finally {
      ledger.close();
    }
  }
  if (command === "open") {
    if (argv.length > 2) {
      throw new UsageError("open takes at most one task");
    }
    const home = resolveCoCheckHome();
    const taskId = task === undefined ? undefined : positiveInt(task, "task");
    let url: string;
    try {
      url = taskId === undefined ? await reviewIndexUrl(home) : await openReviewUrl(home, taskId);
    } catch {
      throw new Refusal(
        `the review process did not start. Data directory: ${home}\nStart it by hand, then run this again:\n  ${reviewProcessCommand(home)}`,
      );
    }
    try {
      execFileSync(process.env.COCHECK_OPEN_CMD || "open", [url], { stdio: "ignore" });
    } catch {
      throw new Refusal(`could not open a browser; open this yourself: ${url}`);
    }
    return `opened ${url.replace(/\?t=.*$/, "")}\n`;
  }
  throw new UsageError(USAGE);
}

try {
  process.stdout.write(await run(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof UsageError && !error.message.startsWith("usage:")) {
    process.stderr.write(`${USAGE}\n`);
  }
  process.exitCode = 1;
}
