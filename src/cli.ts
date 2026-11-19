/**
 * The one command a person types after installing: `node scripts/cocheck.ts <command>`, or `cocheck <command>` when linked.
 *
 *   cocheck open [task]       open the task's rail (no task: the latest one) for the home the installer recorded
 *   cocheck track start|stop|status   switch tracking for the session that runs it (the hook does the switching, see src/tracking.ts)
 *   cocheck status            say whether CoCheck is recording, and if not, why
 *   cocheck install ...       the installer, see docs/install.md
 *   cocheck --version         print the package version and, when the build is stamped, when it was built
 *   cocheck uninstall         remove CoCheck's hook entries, stop the review process, say what stays
 *
 * `open` and `status` read ~/.config/cocheck/install.json, so no COCHECK_HOME is needed. `$COCHECK_OPEN_CMD` replaces the macOS `open` command.
 */
import { HOME_REFUSAL, isUnsafeTaskFolder, platform } from "./platform/index.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { installStatus, readInstallRecord, runInstall } from "./install.ts";
import { allProfiles } from "./hosts/index.ts";
import { readCodexHooksList } from "./hosts/codex-trust.ts";
import { listTracked } from "./tracking.ts";
import type { OpenChoice } from "./open-pick.ts";

const USAGE = `usage:
  cocheck open [task]
  cocheck status
  cocheck track start|stop|status
  cocheck connector test <dir> [--states <dir>] [--timeout <ms>]
  cocheck connector test <dir> --cases [<casesDir>]
  cocheck connector auth <id> --name <credential> [--delete]
  cocheck connector create <dir> --id <id>
  cocheck connector doctor [<id>]
  cocheck connector list
  cocheck connector enable|disable <id> <file ending>
  cocheck install --home <dir> [--folder <dir>] [--for claude|codex|copilot|both|all|none, or a comma list]
  cocheck uninstall [--for claude|codex|copilot|both|all, or a comma list]
  cocheck --help
  cocheck --version`;

export interface OpenRun {
  env: NodeJS.ProcessEnv;
  userHome: string;
  /** The page URL for the recorded home; the real one starts the review process. */
  urlFor: (home: string, task: number | undefined) => Promise<string>;
  /** With no task id, the task for the folder the command runs in, or why the list page is shown. Absent: `urlFor(home, undefined)` decides. */
  choose?: (home: string) => OpenChoice;
  /** The task list page URL for the recorded home. Needed when `choose` can answer with a list. */
  listUrlFor?: (home: string) => Promise<string>;
  /** Opens a URL in the browser. */
  open: (url: string) => void;
  /** After the URL is known, true when the review process behind it still answers once it has settled. Absent: no re-check. */
  recheck?: (home: string, url: string) => Promise<boolean>;
}

/** The settle before `cocheck open` re-checks the review process: past the orphan guard's first tick, so a process that dies right after its first answer is caught. */
const OPEN_SETTLE_MS = 2000;

/** Waits `settleMs`, then true when the review server serving `home` on the URL's port answers a health request. */
export async function settledHealthy(home: string, url: string, settleMs: number = OPEN_SETTLE_MS): Promise<boolean> {
  await new Promise((r) => setTimeout(r, settleMs));
  const port = Number(new URL(url).port);
  if (!Number.isInteger(port) || port <= 0) return false;
  const { reviewHealthy } = await import("./review-server.ts");
  return reviewHealthy(port, home);
}

export interface CliResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

/** `cocheck open`: names "not recording" with its reason first, then opens the page. A page that cannot open is still an error. */
export async function runOpen(run: OpenRun, task: string | undefined): Promise<CliResult> {
  if (task !== undefined && !/^[1-9][0-9]*$/.test(task)) return { exitCode: 1, stdout: "", stderr: `task must be a plain decimal id (e.g. 12), got ${JSON.stringify(task)}\n${USAGE}\n` };
  const status = installStatus(run.env, run.userHome, readCodexHooksList);
  if (status.record === undefined) return { exitCode: 1, stdout: "", stderr: status.text };
  const notice = status.recording && (status.hostProblems ?? []).length === 0 ? "" : status.text;
  let url: string;
  let why = "";
  try {
    let picked = task === undefined ? Number.NaN : Number(task);
    if (task === undefined && run.choose !== undefined) {
      const choice = run.choose(status.record.home);
      if ("task" in choice) picked = choice.task;
      else why = `opened the task list, not a task: ${choice.list}. Run \`cocheck open <id>\` for one task.\n`;
    }
    url = !Number.isNaN(picked) ? await run.urlFor(status.record.home, picked) : why !== "" && run.listUrlFor !== undefined ? await run.listUrlFor(status.record.home) : await run.urlFor(status.record.home, undefined);
  } catch {
    return { exitCode: 1, stdout: notice, stderr: `the review process did not start. Data directory: ${status.record.home}\n` };
  }
  if (run.recheck !== undefined && !(await run.recheck(status.record.home, url))) {
    return { exitCode: 1, stdout: notice, stderr: `the review process stopped right after it started, so nothing was opened. Its log: ${path.join(status.record.home, "review.log")}\n` };
  }
  try {
    run.open(url);
  } catch {
    return { exitCode: 1, stdout: notice, stderr: `could not open a browser; open this yourself: ${url}\n` };
  }
  return { exitCode: 0, stdout: `${notice}${why}opened ${url.replace(/\?t=.*$/, "")} (the link needs its token; \`cocheck open\` opens it again)\n`, stderr: "" };
}

/** `cocheck --version`: the package.json version, then the build stamp (dist/build-info.json, written by `npm run build`) when there is one. */
export function versionText(root: string = path.resolve(import.meta.dirname, "..")): string {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  try {
    const { builtAt } = JSON.parse(readFileSync(path.join(root, "dist", "build-info.json"), "utf8")) as { builtAt: number };
    if (Number.isFinite(builtAt)) return `cocheck ${version} (built ${new Date(builtAt).toISOString()})\n`;
  } catch {
    // no stamp: a source checkout that was never built
  }
  return `cocheck ${version}\n`;
}

/**
 * `cocheck track start|stop|status`. The switch itself is made by the hook, which sees this exact command on a PreToolUse and keys it by
 * the host's session id; the CLI alone knows no session and never guesses one, so it only says what will happen and lists what is tracked.
 */
export function runTrack(args: string[], userHome: string, interactive = false, cwd: string = process.cwd()): CliResult {
  const verb = args[0];
  if (args.length !== 1 || (verb !== "start" && verb !== "stop" && verb !== "status")) return { exitCode: 1, stdout: "", stderr: `usage: cocheck track start|stop|status\n` };
  if (verb === "start") {
    if (isUnsafeTaskFolder(cwd, userHome)) return { exitCode: 1, stdout: "", stderr: `${HOME_REFUSAL}\n` };
    // A person typing in a plain terminal has a TTY on both ends; an agent's shell tool runs with its output captured (no TTY). Only the hook switches tracking, so a typed command changes nothing.
    if (interactive) return { exitCode: 0, stdout: "This changes nothing: tracking is switched per session by the agent, not by this command. In your agent session, tell the agent \"start tracking\".\n", stderr: "" };
    const rec = readInstallRecord(userHome);
    const names = rec === undefined ? [] : rec.hosts.map((h) => allProfiles().find((p) => p.key === h.host)?.displayName ?? h.host);
    if (names.length === 0) return { exitCode: 0, stdout: "CoCheck's hook is not installed (no host is recorded), so nothing will be recorded. Run: cocheck install --home <dir> --for <host>\n", stderr: "" };
    if (names.length === 1) return { exitCode: 0, stdout: `CoCheck's hook is installed for ${names[0]}. Tracking starts for this session with its next call. Nothing is recorded before that.\n`, stderr: "" };
    return { exitCode: 0, stdout: `CoCheck's hook is installed for ${names.join(", ")}. Tracking starts for this session with its next call, if it runs in one of those. Nothing is recorded before that.\n`, stderr: "" };
  }
  if (verb === "stop") return { exitCode: 0, stdout: "Tracking stops for this session; nothing more is recorded until it is started again. What was recorded stays.\n", stderr: "" };
  const record = readInstallRecord(userHome);
  if (record === undefined) return { exitCode: 1, stdout: "", stderr: "CoCheck is not installed (no install record).\n" };
  const tracked = listTracked(record.home);
  const lines = tracked.length === 0 ? "No session is tracked right now.\n" : `${tracked.length} session${tracked.length === 1 ? " is" : "s are"} tracked right now:\n${tracked.map((t) => `  ${t.host} ${t.session}${t.folder === undefined ? "" : ` in ${t.folder}`}\n`).join("")}`;
  return { exitCode: 0, stdout: `${lines}Tracking is per session; a session records only after \`cocheck track start\` ran in it.\n`, stderr: "" };
}

export async function main(argv: string[]): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") return { exitCode: 0, stdout: `${USAGE}\n`, stderr: "" };
  if (command === "--version" || command === "-v" || command === "version") return { exitCode: 0, stdout: versionText(), stderr: "" };
  const userHome = process.env.HOME || homedir();
  if (command === "open") {
    if (rest.length > 1) return { exitCode: 1, stdout: "", stderr: `open takes at most one task\n${USAGE}\n` };
    const { pickOpenChoice, reviewIndexUrl, openReviewUrl } = await import("./review-server.ts");
    return runOpen(
      {
        env: process.env,
        userHome,
        urlFor: (home, task) => (task === undefined ? reviewIndexUrl(home) : openReviewUrl(home, task)),
        choose: (home) => pickOpenChoice(home, process.cwd(), process.env),
        listUrlFor: reviewIndexUrl,
        open: (url) => platform().openUrl(url),
        recheck: settledHealthy,
      },
      rest[0],
    );
  }
  if (command === "status") {
    const status = installStatus(process.env, userHome, readCodexHooksList);
    return { exitCode: status.recording && (status.hostProblems ?? []).length === 0 ? 0 : 1, stdout: status.text, stderr: "" };
  }
  if (command === "track") return runTrack(rest, userHome, process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (command === "connector" && rest[0] === "test") {
    const { runConnectorTest } = await import("./connector-test-cli.ts");
    const { resolveCoCheckHome } = await import("./ledger.ts");
    return runConnectorTest(rest.slice(1), { home: resolveCoCheckHome() });
  }
  if (command === "connector" && rest[0] === "auth") {
    const { runConnectorAuth, readStdinValue } = await import("./connector-auth.ts");
    const { resolveCoCheckHome } = await import("./ledger.ts");
    return runConnectorAuth(rest.slice(1), { home: resolveCoCheckHome(), store: platform().secretStore, readValue: () => readStdinValue() });
  }
  if (command === "connector" && rest[0] === "create") {
    const { runConnectorCreate } = await import("./connector-create.ts");
    return runConnectorCreate(rest.slice(1));
  }
  if (command === "connector" && rest[0] === "doctor") {
    const { runConnectorDoctor } = await import("./connector-doctor.ts");
    const { resolveCoCheckHome } = await import("./ledger.ts");
    return runConnectorDoctor(rest.slice(1), { home: resolveCoCheckHome(), store: platform().secretStore });
  }
  if (command === "connector" && (rest[0] === "list" || rest[0] === "enable" || rest[0] === "disable")) {
    const { runConnectorList, runConnectorSwitch } = await import("./connector-types-cli.ts");
    const { resolveCoCheckHome } = await import("./ledger.ts");
    return rest[0] === "list" ? runConnectorList(rest.slice(1), { home: resolveCoCheckHome() }) : runConnectorSwitch(rest, { home: resolveCoCheckHome() });
  }
  if (command === "install" || command === "uninstall") {
    return runInstall({ argv: ["node", "install.ts", ...(command === "uninstall" ? ["--uninstall"] : []), ...rest], env: process.env, cwd: process.cwd() });
  }
  return { exitCode: 1, stdout: "", stderr: `${USAGE}\n` };
}
