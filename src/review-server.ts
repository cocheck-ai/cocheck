import { finishPictures } from "./timeline/rail/made-pictures.ts";
import { connectorRowDoc } from "./connector/row-doc.ts";
import { readFrozen, readPicture } from "./connector/frozen.ts";
import { isKeyMissing, plainSizeOf, readSealed, SealError } from "./seal.ts";
import { afterCreateCall, afterSnapshot, afterSnapshotSerial, OUTCOME_REASON } from "./connector/after-snapshot.ts";
import { MAX_CALL_ANSWER_BYTES } from "./connector/subjects.ts";
import { JOURNAL_STEM } from "./hook-journal.ts";
import { settlePendingCaptures } from "./connector/file-capture.ts";
import { queueOldRows } from "./connector/old-rows.ts";
import { beforeSnapshot, createConnectorPool, SnapshotError, type ConnectorPool } from "./connector/before-snapshot.ts";
import { isUriSubject } from "./connector/subject.ts";
import { pathKit, type PathKit } from "./paths.ts";
import http from "node:http";
import path from "node:path";
import { detachedCwd, platform, type Platform } from "./platform/index.ts";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { writeFileAtomicSync } from "./home-perms.ts";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { MAX_NOTE_REGIONS, MAX_TASK_REGIONS, newSendBackNonce, openLedger, signoffQualifier, SOFT_SIGNATURE, SOFT_SIGNOFF_LABEL, type FileStateRow, type Ledger, type StopVerdictRow, type SubmissionRow } from "./ledger.ts";
import { fileBase, ownProse } from "./display.ts";
import { defaultReviewer } from "./review.ts";
import { isSecretPath } from "./secret-files.ts";
import { noCorePicture } from "./connector/claimed-state.ts";
import { secretShasOf } from "./secret-hashes.ts";
import { defaultTranscriptsRoot } from "./agent-transcripts.ts";
import { revealWithheld } from "./reveal.ts";
import { readRecord } from "./timeline/runs.ts";
import { commandOfCall, defaultLayers, loadRows, loadTimelineInput, taskFolderOf } from "./timeline/load.ts";
import { pdfDrawerName, pdfPagesAvailable, renderPdfPage } from "./timeline/render/pdf-helper.ts";
import { imageTypeOf, readStoredImage } from "./timeline/stored-image.ts";
import { buildTimeline, type Timeline } from "./timeline/timeline.ts";
import { renderGenericPage } from "./timeline/page.ts";
import { rendererFor } from "./timeline/render/registry.ts";
import { wholeViewFor } from "./timeline/render/whole.ts";
import { storeDirOf } from "./states.ts";
import { cropPng, cropPngPath, pngInfo } from "./timeline/render/png-crop.ts";
import { regionsDirOf } from "./states.ts";
import { withDeliveryCopies } from "./region-delivery.ts";
import { MAX_REGION_LINES, regionPicturePath, regionsById, regionsForVerdict, type RegionRef } from "./timeline/rail/regions.ts";
import { OPEN_CAP_BYTES } from "./timeline/broken.ts";
import type { ChangeInfo } from "./timeline/render/types.ts";
import { stat } from "node:fs/promises";
import { activeViewServer, setActiveViewServer, startViewServer } from "./review-view-server.ts";
import { renderErrorPage, reviewCsp, readAsset, renderReviewShell } from "./timeline/rail/page.ts";
import { viewToV1, type CardWords } from "./timeline/render/view-v1.ts";
import { buildRailModel, movePairs, type MoveRecord, type RailModel } from "./timeline/rail/model.ts";
import { liveState } from "./timeline/rail/live.ts";
import { listTracked, type Tracking } from "./tracking.ts";
import { afterSignoff, buildPasses } from "./timeline/rail/passes.ts";
import { carryMoved, changesByStop, stopIdentities, summarize, verdictEvents } from "./timeline/rail/stop-status.ts";
import { buildSendBack, followUpMarker } from "./timeline/rail/send-back.ts";
import type { FormatLayer } from "./formats/layer.ts";
import { readPreferences, updatePreferences } from "./preferences.ts";
import { mcpCardOf, pickEarlierRead, readKeptCall, type EarlierCall } from "./timeline/rail/mcp-card.ts";
import { isReadOnlyMcpTool } from "./credit-guard.ts";
import { connectorMatcherFor } from "./connector/installed-match.ts";
import { ConnectorDownError, createConnectorDiff } from "./connector/diff.ts";
import { readInstalledManifests } from "./connector/installed-manifests.ts";
import { renderHome, sessionOfClient, type HomeSession, type StartedSession, type TitleRoots } from "./home-page.ts";
import { chooseOpenTask, readOpenRecords, type OpenChoice } from "./open-pick.ts";

/**
 * The local review page, served by one standalone process per machine (`review-process.ts`), not
 * by the gateway: the page has to outlive the agent's session. It binds 127.0.0.1 on the
 * install's port (chosen once, kept in `<home>/review-port`; any free port if taken), recorded with its pid in `<home>/review-server.json`. One per-install token
 * (`<home>/review-token`, mode 0600) guards every URL, so links stay valid across restarts:
 *
 *   GET  /?t=<token>                        index: tasks waiting for review with the verdicts last marked, submitted and expired ones collapsed; reads stop verdicts and submissions only
 *   GET  /review/...                        404: the rail lives under /timeline/
 *   GET  /timeline/<task>?t=<token>         the task's timeline (schema "cocheck.timeline/1"), ETag'd; see src/timeline/
 *   GET  /timeline/<task>/call/<id>/command?t=<token>   one call's raw command, for an explicit expand (never in the timeline body)
 *   GET  /timeline/<task>/preview/<sha>?t=<token>       the stored bytes of one of the task's image states (png, jpg, gif, webp, svg), by content hash
 *   GET  /timeline/<task>/pdfpage/<sha>/<page>?t=<token>   page <page> (1-based) of a stored PDF state, drawn by macOS PDFKit (the pictures of a PDF view)
 *   GET  /timeline/<task>/cpic/<sha>?t=<token>          a connector's PNG picture, lifted out of its frozen answer into the task's sealed store
 *   GET  /timeline/<task>/region/<id>?t=<token>         the PNG of one region the person drew on a picture
 *   POST /timeline/<task>/review/region?t=<token>       records one region (a picture crop, a cell range or a line range) of a change's before or after state; answers {id, where, picture}
 *   GET  /timeline/<task>/view/<change key>?t=<token>   one change drawn by its format's renderer: panes, exact boxes, caveats (src/timeline/render/)
 *   GET  /timeline/<task>/page?t=<token>                the general page: one card per changed file, built from the timeline body alone
 *   GET  /timeline/<task>/review?t=<token>              the g-rail review page (shell; its script and CSS come from /timeline-assets/)
 *   GET  /timeline/<task>/review/model?t=<token>        the railroad and moments of the task, built from the timeline body
 *   GET  /timeline/<task>/review/status?t=<token>       each stop's review status (not reviewed, passed, failed) with its history, and the failed list; the passes: markers and stop tags
 *   POST /timeline/<task>/review/verdict?t=<token>      {stop, status, note} -> the stop's new state; the person's own page only, no CLI, MCP or agent path
 *   POST /timeline/<task>/review/sendback?t=<token>     {note?, notes?: boolean} -> the fix prompt for the failed stops and the optional overall note, recorded in the ledger, with its nonce and follow-up marker line
 *   POST /timeline/<task>/review/sendback-copy?t=<token> {id, text} -> one row in send_back_copies: the exact text the person copied
 *   POST /timeline/<task>/review/submit?t=<token>       {acknowledge?: [stop ids]} -> a soft sign-off; refused when a stop is failed or the not-reviewed set is not acknowledged
 *   GET  /timeline-assets/<name>                        the review page's script, CSS and fonts (a fixed list; no data in them)
 *   GET  /timeline/<task>/review/preferences?t=<token>  {railOrder, clean?}: the page's preferences from <home>/preferences.json (the task is ignored); defaults when the file is missing
 *   POST /timeline/<task>/review/preferences?t=<token>  a partial {railOrder?, clean?} -> merged into the file, answers the full object; a bad value is 400
 *   GET  /health                            {"cocheck":"review","home":<id of the data dir's realpath>,"build":<build identity>}, no token
 *   POST /shutdown?t=<token>                stops the process (a newer build is replacing it)
 *
 * Refused with 403: a missing or wrong token, a Host header that isn't 127.0.0.1:<port> or
 * localhost:<port> (DNS rebinding), and a POST whose Origin is another site.
 */

const MAX_BODY_BYTES = 16 * 1024;

/** Every `.ts`/`.js` file under `dir` (never `node_modules`), sorted, so the hash does not depend on directory order. */
function codeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        out.push(...codeFiles(full));
      }
    } else if (/\.(ts|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

/** The package version from the nearest `package.json` above `dir`, or "unknown". */
function packageVersion(dir: string): string {
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      return String(JSON.parse(readFileSync(path.join(d, "package.json"), "utf8")).version);
    } catch {
      // not here: look one level up
    }
    if (path.dirname(d) === d) {
      return "unknown";
    }
  }
}

/**
 * When the code in `dir` was built, in ms. A compiled build (dist/, or the bundle's server/) carries a
 * `build-info.json` written once at the end of `npm run build` and copied unchanged by the packer, so
 * file mtimes (which a copy or a checkout resets) play no part. A run from source has no stamp and
 * uses the commit time of the checkout's HEAD; uncommitted edits do not move it. With neither, 0:
 * unknown age counts as the oldest build, so it never replaces anything.
 */
export function resolveBuildTime(dir: string): number {
  try {
    const stamp = JSON.parse(readFileSync(path.join(dir, "build-info.json"), "utf8")).builtAt;
    if (typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0) {
      return stamp;
    }
  } catch {
    // no stamp: a run from source
  }
  try {
    const seconds = Number(execFileSync("git", ["-C", dir, "log", "-1", "--format=%ct"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  } catch {
    return 0;
  }
}

/** A build's identity and its age (`builtAt`: when it was built, ms; see `resolveBuildTime`). The age orders two builds; the identity only tells them apart. */
export interface BuildInfo {
  build: string;
  builtAt: number;
}

/**
 * Which code this process is: the package version plus a hash of every code file in the directory this
 * module was loaded from, read once at startup. A `src` run and a `dist` run differ (other files, other
 * contents), as does any edit, so a review process left behind by older code never matches a newer gateway.
 */
export const BUILD_IDENTITY: string = (() => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const hash = createHash("sha256");
  try {
    for (const file of codeFiles(dir)) {
      hash.update(path.relative(dir, file)).update("\0").update(readFileSync(file)).update("\0");
    }
  } catch {
    hash.update("unreadable");
  }
  return `${packageVersion(dir)}+${hash.digest("hex").slice(0, 16)}`;
})();

/** When this process's code was built (see `resolveBuildTime`). */
export const BUILD_TIME: number = resolveBuildTime(path.dirname(fileURLToPath(import.meta.url)));

/** What a review process answers once its own install folder is gone. */
export const UPDATED_MESSAGE = "CoCheck was updated, reopening";

/** True when the code this process was loaded from no longer exists on disk. */
export function installFolderGone(file: string = fileURLToPath(import.meta.url)): boolean {
  return !existsSync(file);
}

/**
 * Whether `mine` should replace the review process `running`. Only a build made strictly later does (built-later, not last-touched): a
 * build that reports no age counts as oldest, a tie keeps the one already serving, so two installed
 * builds (a Claude Desktop extension and a Claude Code session in the source tree) settle on the
 * newer one instead of replacing each other on every start.
 */
export function shouldReplaceReview(running: { build?: string; builtAt?: number }, mine: BuildInfo): boolean {
  if (running.build === mine.build) {
    return false;
  }
  return mine.builtAt > (running.builtAt ?? 0);
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, type = "application/json; charset=utf-8", extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    // The token rides in the URL; never leak it to another origin.
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    ...extra,
  });
  res.end(body);
}

/** Aborts when the client hangs up before the answer is sent, so a queued conversion for a request nobody waits on never starts. */
function goneSignal(res: http.ServerResponse): AbortSignal {
  const ctl = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) ctl.abort();
  });
  return ctl.signal;
}

/** Responses to a browser's page load (GET or HEAD asking for text/html), so a refusal a person can land on is a page, not JSON. Keyed by response. */
const pageLoads = new WeakMap<http.ServerResponse, string>();
function wantsPage(req: http.IncomingMessage): boolean {
  const accept = String(req.headers.accept ?? "");
  return (req.method === "GET" || req.method === "HEAD") && /\btext\/html\b/i.test(accept);
}
/** The page for a refused or missing address: the wrong or missing token, a task that isn't here, any other unknown address. Null for every other error. */
function errorPageFor(path: string, status: number, value: unknown): string | null {
  const error = value !== null && typeof value === "object" ? (value as { error?: unknown }).error : undefined;
  if (status === 403 && error === "missing or wrong token") return renderErrorPage("This link has expired", "Run cocheck open in your terminal to open a fresh one.", "cocheck open");
  if (status === 404 && error === "not found") {
    const task = /^\/timeline\/(\d+)(?:\/|$)/.exec(path)?.[1];
    return task !== undefined
      ? renderErrorPage(`Task ${task} isn't on this computer`, "Open CoCheck to see your tasks: run cocheck open in your terminal.", "cocheck open")
      : renderErrorPage("This page isn't here", "Open CoCheck to see your tasks: run cocheck open in your terminal.", "cocheck open");
  }
  return null;
}
function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const path = pageLoads.get(res);
  const page = path === undefined ? null : errorPageFor(path, status, value);
  if (page !== null) return send(res, status, page, "text/html; charset=utf-8");
  send(res, status, JSON.stringify(value));
}

function tokenMatches(expected: Buffer, token: string | null): boolean {
  if (!token) {
    return false;
  }
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** POST /connector/before-snapshot?t=<token> {subject, budgetMs}: seals the connector's state for the subject and answers {ref}, or a JSON error. Never a ref for unsealed bytes. */
async function connectorBeforeSnapshot(home: string, token: Buffer, pool: ConnectorPool, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (!tokenMatches(token, url.searchParams.get("t"))) return sendJson(res, 403, { error: "missing or wrong token" });
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
  if (req.headers["sec-fetch-site"] === "cross-site") return sendJson(res, 403, { error: "cross-origin request refused" });
  let body: { subject?: unknown; tool?: unknown; budgetMs?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "the body is not valid JSON" });
  }
  const { subject, tool, budgetMs } = body ?? {};
  if (typeof subject !== "string" || subject === "" || typeof budgetMs !== "number" || !Number.isFinite(budgetMs) || budgetMs <= 0) {
    return sendJson(res, 400, { error: "the body must be {subject: string, budgetMs: positive number}" });
  }
  try {
    return sendJson(res, 200, await beforeSnapshot({ home, pool, subject, ...(typeof tool === "string" && tool !== "" ? { tool } : {}), budgetMs: Math.min(budgetMs, 10_000) }));
  } catch (error) {
    return sendJson(res, error instanceof SnapshotError ? error.status : 502, { error: error instanceof Error ? error.message : "the connector failed" });
  }
}

/** POST /connector/after-snapshot?t=<token> {client, task, call, subject, before, beforeAbsent?}: answers 202 at once; the snapshot, the seal and the row happen after the answer (fire and forget). */
async function connectorAfterSnapshot(ledger: Ledger, home: string, token: Buffer, pool: ConnectorPool, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (!tokenMatches(token, url.searchParams.get("t"))) return sendJson(res, 403, { error: "missing or wrong token" });
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
  if (req.headers["sec-fetch-site"] === "cross-site") return sendJson(res, 403, { error: "cross-origin request refused" });
  let body: { client?: unknown; task?: unknown; call?: unknown; subject?: unknown; tool?: unknown; before?: unknown; beforeAbsent?: unknown; callStart?: unknown; callEnd?: unknown; response?: unknown; journal?: unknown };
  try {
    // A create call's body carries the tool's answer (the hook sends none over MAX_CALL_ANSWER_BYTES)
    body = JSON.parse(await readBody(req, MAX_CALL_ANSWER_BYTES + MAX_BODY_BYTES));
  } catch {
    return sendJson(res, 400, { error: "the body is not valid JSON" });
  }
  const { client, task, call, subject, tool, before, beforeAbsent, callStart, callEnd, journal } = body ?? {};
  // A call of a `matches.calls` tool names no subject: the review process renders it from the tool's answer, then reads the item once.
  if (body !== null && typeof body === "object" && Object.hasOwn(body, "response") && subject === undefined) {
    if (typeof client !== "string" || client === "" || typeof call !== "string" || call === "" || typeof tool !== "string" || tool === "" || (task !== null && task !== undefined && !Number.isInteger(task)) || (journal !== undefined && (typeof journal !== "string" || !JOURNAL_STEM.test(journal)))) {
      return sendJson(res, 400, { error: "a create call's body must be {client: string, task: integer|null, call: string, tool: string, response, journal?: 16 hex characters}" });
    }
    sendJson(res, 202, { accepted: true });
    void afterSnapshotSerial(() => afterCreateCall({ home, ledger, pool, client, task: (task as number | null | undefined) ?? null, call, tool, response: body.response, ...(typeof journal === "string" ? { journal } : {}), budgetMs: 10_000 })).catch((): void => {
      try {
        ledger.recordCaptureOutcome({ taskId: null, client, call, subject: "", outcome: "error", reason: OUTCOME_REASON.error });
      } catch {
        // the ledger is unwritable
      }
    });
    return;
  }
  if (typeof client !== "string" || client === "" || typeof call !== "string" || call === "" || typeof subject !== "string" || subject === "" || (task !== null && task !== undefined && !Number.isInteger(task)) || (before !== null && before !== undefined && typeof before !== "string") || (beforeAbsent !== undefined && typeof beforeAbsent !== "boolean") || (beforeAbsent === true && before !== null && before !== undefined) || [callStart, callEnd].some((t) => t !== undefined && (typeof t !== "string" || !Number.isFinite(Date.parse(t))))) {
    return sendJson(res, 400, { error: "the body must be {client: string, task: integer|null, call: string, subject: string, before: string|null, beforeAbsent?: boolean (true only with before null)}" });
  }
  sendJson(res, 202, { accepted: true });
  void afterSnapshotSerial(() => afterSnapshot({ home, ledger, pool, client, task: (task as number | null | undefined) ?? null, call, subject, ...(typeof tool === "string" && tool !== "" ? { tool } : {}), before: (before as string | null | undefined) ?? null, ...(beforeAbsent === true ? { beforeAbsent: true as const } : {}), ...(typeof callStart === "string" && typeof callEnd === "string" ? { callStart, callEnd } : {}), budgetMs: 10_000 })).catch((): void => {
    // afterSnapshot records its own outcome and does not throw; this is the last resort, so a throw is a row and never a silence.
    try {
      ledger.recordCaptureOutcome({ taskId: null, client: client as string, call: call as string, subject: subject as string, outcome: "error", reason: OUTCOME_REASON.error });
    } catch {
      // the ledger is unwritable
    }
  });
}

function readBody(req: http.IncomingMessage, max: number = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The guard every state-changing POST runs, in this order: method (405), Host and Origin (403), token (403), content type (415), task (404),
 * then the body as a JSON object (400). Sends the refusal and gives undefined, or gives the parsed body. `emptyIsObject` lets an empty body and
 * an array stand for `{}` (send-back has no required field); every other route rejects an empty body.
 */
async function postBody(ledger: Ledger, req: http.IncomingMessage, res: http.ServerResponse, url: URL, taskId: number, allowedHosts: string[], token: Buffer, emptyIsObject = false): Promise<Record<string, unknown> | undefined> {
  if (req.method !== "POST") return void sendJson(res, 405, { error: "method not allowed" });
  if (!originAllowed(req, allowedHosts)) return void sendJson(res, 403, { error: "cross-origin request refused" });
  if (!tokenMatches(token, url.searchParams.get("t"))) return void sendJson(res, 403, { error: "missing or wrong token" });
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return void sendJson(res, 415, { error: "send application/json" });
  if (!Number.isSafeInteger(taskId) || !ledger.allTaskIds().includes(taskId)) return void sendJson(res, 404, { error: "not found" });
  try {
    const text = await readBody(req);
    const parsed = emptyIsObject && text.trim() === "" ? {} : JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return {};
    return emptyIsObject && Array.isArray(parsed) ? {} : (parsed as Record<string, unknown>);
  } catch {
    return void sendJson(res, 400, { error: "invalid JSON body" });
  }
}

/** A task whose values expired takes no new note, prompt or copied text: it would sit there unblanked, past the schedule. Answers 410 and returns true. */
function refuseExpired(ledger: Ledger, res: http.ServerResponse, taskId: number): boolean {
  if (ledger.valuesExpiredAt(taskId) === undefined) return false;
  sendJson(res, 410, { error: "This task's values expired, so nothing more is recorded on it.", expired: true });
  return true;
}

/** The timeline body for a task: the cached one when its etag still matches, else built now. A body with a preview still being drawn is a stand-in and is not cached, so the next ask builds again and the finished picture is not lost. */
async function cachedBody(ledger: Ledger, home: string, deps: TimelineDeps, taskId: number, loaded: ReturnType<typeof loadRows>): Promise<{ etag: string; body: string }> {
  settleLoaded(ledger, home, deps, loaded);
  // The body also holds what each installed connector says, so the key is the etag plus the installed connector ids and versions.
  const connectors = installedConnectorsKey(home);
  let hit = deps.cache.get(taskId);
  if (hit === undefined || hit.etag !== loaded.etag || hit.connectors !== connectors) {
    // Connector errors stay per row: createConnectorDiff throws, the loader turns each throw into that row's `unavailable`.
    const one = createConnectorDiff({ home, taskId, timeoutMs: deps.connectorTimeoutMs ?? 10_000 });
    // Within one build, a connector that timed out or would not start fails its remaining rows at once with the same reason (one 10 s wait per connector, not per row). A bad answer to one row (rejected, or an error reply) is that row's alone.
    const down = new Map<string, Error>();
    const connectorDiff: typeof one = async (row) => {
      const known = down.get(row.connector);
      if (known !== undefined) throw known;
      try {
        return await one(row);
      } catch (e) {
        if (e instanceof ConnectorDownError) down.set(row.connector, e as Error);
        throw e;
      }
    };
    const input = await loadTimelineInput(ledger, home, loaded, { layers: deps.layers, build: BUILD_IDENTITY, connectorDiff, ...(deps.quickLook === undefined ? {} : { quickLook: deps.quickLook }) });
    hit = { etag: loaded.etag, connectors, body: JSON.stringify(buildTimeline(input)) };
    if (!hit.body.includes('"pending":true')) deps.cache.set(taskId, hit);
  }
  return hit;
}

/**
 * Catch-up: a loaded task with file rows whose change list was never read (the process was not running at the write, or stopped mid-read) has them read
 * now, in the background, once per row (settleFileCapture joins a read already running). The page shows them as being read until the tag moves.
 */
function settleLoaded(ledger: Ledger, home: string, deps: TimelineDeps, loaded: ReturnType<typeof loadRows>): void {
  if (loaded.fileStates.some((s) => s.capture === "pending")) void settlePendingCaptures(ledger, home, loaded.taskId, deps.connectorTimeoutMs ?? 10_000);
}

/** POST /connector/file-capture?t=<token> {tasks: integer[]}: the hook wrote pending file captures into these tasks. Answers 202 at once and reads them after the answer. */
async function connectorFileCapture(ledger: Ledger, home: string, deps: TimelineDeps, token: Buffer, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (!tokenMatches(token, url.searchParams.get("t"))) return sendJson(res, 403, { error: "missing or wrong token" });
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
  if (req.headers["sec-fetch-site"] === "cross-site") return sendJson(res, 403, { error: "cross-origin request refused" });
  let tasks: unknown;
  try {
    tasks = (JSON.parse(await readBody(req)) as { tasks?: unknown } | null)?.tasks;
  } catch {
    return sendJson(res, 400, { error: "the body is not valid JSON" });
  }
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 64 || !tasks.every((t) => Number.isSafeInteger(t) && (t as number) > 0)) return sendJson(res, 400, { error: "the body must be {tasks: [integer, ...]}" });
  sendJson(res, 202, { accepted: true });
  for (const t of new Set(tasks as number[])) void settlePendingCaptures(ledger, home, t, deps.connectorTimeoutMs ?? 10_000);
}

/** The installed connectors as one string (id and version of each, in folder order); it moves when one is installed, removed or upgraded. */
function installedConnectorsKey(home: string): string {
  return JSON.stringify(readInstalledManifests(home).map((m) => [m.manifest.id, (m.manifest as { version?: unknown }).version ?? null]));
}

/** What the timeline routes need beyond the ledger: the format layers and the last body built per task. */
interface TimelineDeps {
  layers: FormatLayer[];
  quickLook?: boolean;
  /** Where Claude Code keeps its project folders, for the subagent lanes of ops recorded without an agent id. */
  transcriptsRoot: string;
  /** Test seam: the per-row bound on a connector call (default 10 s). */
  connectorTimeoutMs?: number;
  cache: Map<number, { etag: string; connectors?: string; body: string; model?: { key: string; etag: string } }>;
  /** Test seam: the path kit used to match a change to its own file state. */
  pathKit?: () => PathKit;
  /** Where each host keeps its own session files, for the home page names; unset: each host's own folder. */
  titleRoots?: TitleRoots;
}

/** Largest stored state a view reads into memory. */
const VIEW_MAX_BYTES = OPEN_CAP_BYTES;

/**
 * GET /timeline/<task>/view/<change key>. The key is looked up among the task's own changes; the two hashes come from that change and
 * are re-checked as hashes before the store is read, so nothing in the URL is ever a path. A secret file (by name, or by the bytes of
 * any secret-named file in the task) is a 404 and its bytes are never opened.
 */
async function handleView(ledger: Ledger, home: string, deps: TimelineDeps, res: http.ServerResponse, taskId: number, rawKey: string, wholeAsked?: "before" | "after"): Promise<void> {
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  const loaded = loadRows(ledger, taskId, BUILD_IDENTITY, { transcriptsRoot: deps.transcriptsRoot });
  if (loaded.valuesExpiredAt !== null) {
    return sendJson(res, 410, { error: "This task's values expired, and the file states went with them.", expired: true });
  }
  const hit = await cachedBody(ledger, home, deps, taskId, loaded);
  const timeline = JSON.parse(hit.body) as Timeline;
  const changes = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))];
  const change = changes.find((c) => c.id === key);
  if (change === undefined) {
    return sendJson(res, 404, { error: "not found" });
  }
  const states = ledger.fileStatesForTask(taskId);
  const secretShas = secretShasOf(states.map((r) => ({ path: r.filePath, sha: r.sha256, prev: r.prevSha256, note: r.note })));
  const shas = [change.before?.sha256 ?? null, change.after.sha256];
  if (isSecretPath(change.file) || shas.some((s) => s !== null && secretShas.has(s))) {
    return sendJson(res, 404, { error: "not found" });
  }
  const missing: string[] = [];
  const read = async (side: "before" | "after", sha: string | null): Promise<Buffer | null> => {
    if (sha === null || !/^[0-9a-f]{64}$/.test(sha)) return null;
    try {
      const file = path.join(storeDirOf(home, taskId), sha);
      if (plainSizeOf((await stat(file)).size) > VIEW_MAX_BYTES) {
        missing.push(`The ${side} state is too large to draw.`);
        return null;
      }
      return await readSealed(file);
    } catch (error) {
      if (isKeyMissing(error)) throw error;
      if (error instanceof SealError) {
        missing.push(`The ${side} state failed its integrity check, so nothing is compared and nothing is boxed.`);
        return null;
      }
      missing.push(`The ${side} state is no longer in the store, so nothing is compared and nothing is boxed.`);
      return null;
    }
  };
  // A connector row (its timeline change carries a diff object) reaches the page as the same cocheck.changes/1 document, plus `source`; no renderer is chosen by the subject's name.
  if (change.diff !== undefined) {
    const rowBefore = await read("before", shas[0]!), rowAfter = await read("after", shas[1]!);
    const made = await connectorRowDoc(change.diff, { before: rowBefore, after: rowAfter, readFrozen: (ref) => readFrozen(home, taskId, ref) });
    const viewer = activeViewServer();
    const doc = finishPictures(made, { before: rowBefore, after: rowAfter, ...(viewer === undefined ? {} : { mint: (h: string) => viewer.mint(h) }) });
    return send(res, 200, JSON.stringify(doc), "application/json; charset=utf-8", { "cache-control": "private, no-store" });
  }
  // The renderer chosen for the file says whether it has a whole-file view (pages, lines, or a claimed type's card); no ending is named here.
  const renderer = rendererFor(change.file, change.generic as ChangeInfo["generic"], home);
  const whole = wholeViewFor(renderer, change.generic as ChangeInfo["generic"], wholeAsked);
  const before = whole === "after" ? null : await read("before", shas[0]!);
  const after = whole === "before" ? null : await read("after", shas[1]!);
  // One plain sentence of what changed, from the change's own format rows, for the banner of two identical-looking states.
  const rows = change.format?.rows ?? [];
  const changeSentence = rows.length === 0 ? undefined : `${rows.slice(0, 3).map((r) => (r.text.startsWith(r.location) ? r.text : `${r.location}: ${r.text.replace(/^[a-z ]+: /, "")}`)).join("; ")}${rows.length > 3 ? ` (and ${rows.length - 3} more)` : ""}.`;
  const view = await renderer.view(before, after, { ...(whole === undefined ? {} : { whole }), ...(changeSentence === undefined ? {} : { changeSentence }), id: change.id, file: change.file, kind: change.kind, generic: change.generic as ChangeInfo["generic"], missing: [...missing, ...(change.generic.readerCaveats ?? [])], signal: goneSignal(res) });
  // The words of each card come from the rail model's own card and row-note path (the one that scrubs paths and secrets); a secret file's model change has none.
  const railChange = buildRailModel(timeline, { connectorFor: connectorMatcherFor(home) }).stops.flatMap((st) => (st.change !== undefined && st.change.key === change.id ? [st.change] : []))[0];
  const words: CardWords = { cards: [...(railChange?.cards ?? []), ...(railChange?.extraCards ?? [])], rowNotes: railChange?.rowNotes ?? [] };
  return send(res, 200, JSON.stringify(viewToV1(view, words)), "application/json; charset=utf-8", { "cache-control": "private, no-store" });
}

/**
 * GET /timeline/<task>/outside-paths. For the task's own files outside the watched folder, { "/outside/<file name>": [directory, ...] }: the
 * page shows it under the file in the Deliverables "Outside the folder" group. It is a route of its own, so no directory ever reaches the cached
 * timeline body or the model. A secret file (by name, or by the bytes of any secret-named file in the task) is left out whole,
 * under every directory it sat in. Files of one name in different directories share a key, so every directory is listed.
 */
function handleOutsidePaths(ledger: Ledger, home: string, res: http.ServerResponse, taskId: number): void {
  const kit = pathKit();
  const folder = taskFolderOf(ledger, home, taskId);
  const states = ledger.fileStatesForTask(taskId);
  const secretShas = secretShasOf(states.map((r) => ({ path: r.filePath, sha: r.sha256, prev: r.prevSha256, note: r.note })));
  const secretPaths = new Set(states.filter((r) => isSecretPath(r.filePath) || secretShas.has(r.sha256) || (r.prevSha256 !== null && secretShas.has(r.prevSha256))).map((r) => r.filePath));
  const out: Record<string, string[]> = {};
  for (const r of states) {
    if (isUriSubject(r.filePath) || !kit.isAbs(r.filePath) || secretPaths.has(r.filePath)) continue;
    const norm = kit.canon(r.filePath);
    if (folder !== null && kit.inside(folder, norm)) continue;
    const key = "/outside/" + kit.baseName(norm);
    const dir = kit.dirName(norm);
    (out[key] ??= []).includes(dir) || out[key]!.push(dir);
  }
  // A name that is secret under any directory shows no path under any.
  for (const p of secretPaths) delete out["/outside/" + kit.baseName(kit.canon(p))];
  return send(res, 200, JSON.stringify(out), "application/json; charset=utf-8", { "cache-control": "private, no-store" });
}

/**
 * GET /timeline/<task>/pdfpage/<sha>/<page>. The hash must be one of the task's own file states of a `.pdf` that is not secret (by name
 * or by bytes), and its bytes must still be in the task's store; the page is drawn by the PDFKit helper from a temp copy on every
 * request (no cache: nothing to expire, nothing that outlives the stored state). Nothing in the URL is ever a path.
 */
async function handlePdfPage(ledger: Ledger, home: string, res: http.ServerResponse, taskId: number, sha: string, n: number): Promise<void> {
  const drawn = await renderStatePage(ledger, home, taskId, sha, n);
  if ("png" in drawn) return send(res, 200, drawn.png, "image/png", { "cache-control": "private, no-store" });
  return sendJson(res, drawn.status, drawn.body);
}

/**
 * GET /timeline/<task>/cpic/<sha>. A connector's PNG picture, lifted out of its answer when the step was frozen (src/connector/frozen.ts). Served only
 * when one of the task's own frozen change lists names `cpic/<sha>` on a row that is not secret (by name, or by the bytes of any secret-named file in
 * the task), and the sealed bytes still hash to the name and read as a PNG. Nothing in the URL is ever a path.
 */
async function handleConnectorPicture(ledger: Ledger, home: string, res: http.ServerResponse, taskId: number, sha: string): Promise<void> {
  if ((ledger.valuesExpiredAt(taskId) ?? null) !== null) return sendJson(res, 410, { error: "This task's values expired, and the pictures went with them.", expired: true });
  const states = ledger.fileStatesForTask(taskId);
  const secretShas = secretShasOf(states.map((r) => ({ path: r.filePath, sha: r.sha256, prev: r.prevSha256, note: r.note })));
  const refs = new Set(states.filter((r) => typeof r.changesSha256 === "string" && !isSecretPath(r.filePath) && !secretShas.has(r.sha256) && (r.prevSha256 === null || !secretShas.has(r.prevSha256))).map((r) => r.changesSha256!));
  const want = `cpic/${sha}`;
  let named = false;
  for (const ref of refs) {
    try {
      const doc = await readFrozen(home, taskId, ref) as { pictures?: unknown };
      if (Array.isArray(doc.pictures) && doc.pictures.some((p) => p !== null && typeof p === "object" && (p as { src?: unknown }).src === want)) { named = true; break; }
    } catch (error) {
      if (isKeyMissing(error)) return sendJson(res, 500, { error: (error as Error).message, code: "KEY_MISSING" });
    }
  }
  if (!named) return sendJson(res, 404, { error: "not found" });
  let png: Buffer | undefined;
  try {
    png = await readPicture(home, taskId, sha);
  } catch (error) {
    return sendJson(res, 500, { error: (error as Error).message, code: "KEY_MISSING" });
  }
  if (png === undefined) return sendJson(res, 404, { error: "not found" });
  return send(res, 200, png, "image/png", { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" });
}

/**
 * Page `n` of a stored state of a task's own `.pdf` file as a PNG, or the refusal to send. The one place a page picture is
 * made: the pdfpage route and the region route both call it, so a region is cut from exactly the picture the page shows.
 */
async function renderStatePage(ledger: Ledger, home: string, taskId: number, sha: string, n: number): Promise<{ png: Buffer } | { status: number; body: Record<string, unknown> }> {
  const states = ledger.fileStatesForTask(taskId);
  const rows = /^[0-9a-f]{64}$/.test(sha) ? states.filter((r) => r.sha256 === sha || r.prevSha256 === sha) : [];
  const secretShas = secretShasOf(states.map((r) => ({ path: r.filePath, sha: r.sha256, prev: r.prevSha256, note: r.note })));
  if (rows.length === 0 || rows.some((r) => isSecretPath(r.filePath)) || secretShas.has(sha) || !rows.every((r) => r.filePath.toLowerCase().endsWith(".pdf")) || !pdfPagesAvailable() || n < 1) {
    return { status: 404, body: { error: "not found" } };
  }
  let bytes: Buffer;
  try {
    const file = path.join(storeDirOf(home, taskId), sha);
    if (plainSizeOf((await stat(file)).size) > VIEW_MAX_BYTES) return { status: 404, body: { error: "This state is too large to draw." } };
    bytes = await readSealed(file);
  } catch (error) {
    if (isKeyMissing(error)) return { status: 500, body: { error: (error as Error).message, code: "KEY_MISSING" } };
    return { status: 404, body: { error: "The state's bytes are no longer in the store.", missing: "The state's bytes are no longer in the store." } };
  }
  const png = await renderPdfPage(bytes, n);
  if (png === null) return { status: 404, body: { error: `${pdfDrawerName()} could not draw this page.` } };
  return { png };
}

/**
 * POST /timeline/<task>/review/sendback: the person sends the failed stops back. The prompt is built here from the task's own record
 * and the stops that are failed now, shown to the person and recorded in the ledger with the stop ids it covers. The body's only field is
 * the optional overall note (text, 2000 characters at most): the prompt carries it and the ledger records it with the send-back, with
 * or without failed stops. With no failed stop and no note the answer is 409 and nothing is recorded. Same rules as every state-changing POST
 *. Nothing is spawned: the person copies the text to their own agent.
 */
const NOT_TRACKING_SENTENCE = "CoCheck was not tracking when this was written; ask the person to start tracking before you fix it.";

async function handleSendBack(ledger: Ledger, home: string, deps: TimelineDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL, taskId: number, allowedHosts: string[], token: Buffer): Promise<void> {
  const body = await postBody(ledger, req, res, url, taskId, allowedHosts, token, true);
  if (body === undefined || refuseExpired(ledger, res, taskId)) return;
  if (body.note !== undefined && typeof body.note !== "string") {
    return sendJson(res, 400, { error: "note must be text" });
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 2000) {
    return sendJson(res, 400, { error: "The note is too long (2000 characters at most)." });
  }
  const regionIds = regionIdsOf(body);
  if (typeof regionIds === "string") return sendJson(res, 400, { error: regionIds });
  const regionProblem = regionIds.length === 0 ? undefined : ledger.regionLinkProblem(taskId, regionIds, null);
  if (regionProblem !== undefined) return sendJson(res, 400, { error: regionProblem });
  // `notes: false` sends the review comments only: the sticky notes stay out of the prompt and are not marked sent. Absent (older pages) or true includes them, as before.
  if (body.notes !== undefined && typeof body.notes !== "boolean") return sendJson(res, 400, { error: "notes must be true or false" });
  const notes = body.notes === false ? [] : ledger.liveNotes(taskId);
  const loaded = loadRows(ledger, taskId, BUILD_IDENTITY, { transcriptsRoot: deps.transcriptsRoot });
  const hit = await cachedBody(ledger, home, deps, taskId, loaded);
  const timeline = JSON.parse(hit.body) as Timeline;
  const model = buildRailModel(timeline, { connectorFor: connectorMatcherFor(home) });
  const summary = summarize(model, timeline, ledger.stopVerdictsForTask(taskId), verdictEvents(ledger.sendBacksForTask(taskId), ledger.submissionsForTask(taskId)));
  // A fail a later state of the file replaced is not sent back, so it does not count here either (anyFailed still counts it, for the page).
  const toSend = summary.failed.filter((f) => !summary.submit.superseded.includes(f.stop));
  if (toSend.length === 0 && note === "" && notes.length === 0) {
    return sendJson(res, 409, { error: "No stop is failed and there is no overall note or note, so there is nothing to send back." });
  }
  // Each failed stop's regions are the ones linked to its latest verdict; the overall ones are the ids this send-back is given.
  const verdictRows = ledger.stopVerdictsForTask(taskId);
  // Every picture the prompt names also gets a copy inside the task folder, where the agent can open it; the prompt names that copy.
  const folder = taskFolderOf(ledger, home, taskId);
  const copied = (refs: RegionRef[]): RegionRef[] => withDeliveryCopies(home, taskId, folder, refs);
  const byStop = new Map(toSend.map((f) => [f.stop, copied(regionsForVerdict(ledger, home, carryMoved(model, timeline, verdictRows).rows.findLast((v) => v.stopId === f.stop)?.id ?? -1))] as const));
  const sent = buildSendBack(model, timeline, summary, note, { byStop, overall: copied(regionsById(ledger, home, taskId, regionIds)), notes: notes.map((n) => ({ text: n.text, region: n.regionId === null ? null : copied(regionsById(ledger, home, taskId, [n.regionId]))[0] ?? null })) });
  // With no session of the task tracked (tracking: listTracked in tracking.ts, one switch file per session), the prompt tells the agent so; the send-back is still allowed and recorded.
  const sessions = ledger.sessionIdsForTask(taskId);
  const untracked = sessions.length > 0 && !listTracked(home).some((t) => sessions.includes(t.session));
  const prompt = untracked ? `${sent.prompt}\n\n${NOT_TRACKING_SENTENCE}` : sent.prompt;
  const nonce = newSendBackNonce();
  const id = ledger.immediate(() => {
    const sendBackId = ledger.appendSendBack({ taskId, prompt, stopIds: sent.stops, reviewer: defaultReviewer(), note, nonce });
    if (regionIds.length > 0) ledger.linkRegions(regionIds, { sendBackId });
    if (notes.length > 0) ledger.markNotesSent(notes, sendBackId);
    return sendBackId;
  });
  ledger.recordActivity(taskId, "reviewer", new Date());
  return sendJson(res, 200, { id, prompt, stops: sent.stops, nonce, marker: followUpMarker(taskId, id, nonce), ...(untracked ? { untracked: true } : {}) });
}

/**
 * GET and POST /timeline/<task>/review/preferences. The preferences are the install's, not the task's, so a GET asks no task; a POST runs the
 * usual guard (which also needs a real task). The file is `<home>/preferences.json`; see preferences.ts.
 */
async function handlePreferences(ledger: Ledger, home: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL, taskId: number, allowedHosts: string[], token: Buffer): Promise<void> {
  if (req.method === "GET") {
    if (!tokenMatches(token, url.searchParams.get("t"))) return sendJson(res, 403, { error: "missing or wrong token" });
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedHosts.some((h) => origin.toLowerCase() === `http://${h}`)) return sendJson(res, 403, { error: "cross-origin request refused" });
    return send(res, 200, JSON.stringify(readPreferences(home)), "application/json; charset=utf-8", { "cache-control": "private, no-store" });
  }
  const body = await postBody(ledger, req, res, url, taskId, allowedHosts, token);
  if (body === undefined) return;
  const out = updatePreferences(home, body);
  if ("error" in out) return sendJson(res, 400, { error: out.error });
  return sendJson(res, 200, out.prefs);
}

/**
 * POST /timeline/<task>/review/sendback-copy {id, text}: the person pressed Copy. `text` is exactly what went to the clipboard: the box text
 * (the person may have edited it), a blank line, then the send-back's own marker line. The ledger appends one row per Copy. A text that does not
 * end with that marker, or a send-back that is not this task's, records nothing. No model is called.
 */
async function handleSendBackCopy(ledger: Ledger, req: http.IncomingMessage, res: http.ServerResponse, url: URL, taskId: number, allowedHosts: string[], token: Buffer): Promise<void> {
  const body = await postBody(ledger, req, res, url, taskId, allowedHosts, token);
  if (body === undefined || refuseExpired(ledger, res, taskId)) return;
  if (typeof body.id !== "number" || typeof body.text !== "string") return sendJson(res, 400, { error: "id must be a send-back id and text must be text" });
  const row = ledger.sendBacksForTask(taskId).find((r) => r.id === body.id);
  if (row === undefined) return sendJson(res, 404, { error: "not found" });
  if (row.nonce === null || !body.text.endsWith(`\n\n${followUpMarker(taskId, row.id, row.nonce)}`)) return sendJson(res, 400, { error: "The copied text must end with this send-back's follow-up line." });
  const copy = ledger.appendSendBackCopy(row.id, body.text);
  return sendJson(res, 200, { id: copy });
}

/**
 * POST /timeline/<task>/review/reveal: the person clicks "Show from your transcript" on a withheld helper field. The body names only the call
 * and the field; the transcript file comes from the task's own record (never the body), is read only when its real path is under the profile
 * root, and the text goes back only when its sha256 matches the recorded one. Nothing is written: no ledger row, cache entry or log line. Any problem
 * answers 404 with no text. Same token, Host, Origin and method rules as every state-changing POST.
 */
async function handleReveal(ledger: Ledger, deps: TimelineDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL, taskId: number, allowedHosts: string[], token: Buffer): Promise<void> {
  const body = await postBody(ledger, req, res, url, taskId, allowedHosts, token);
  if (body === undefined) return;
  const none = () => sendJson(res, 404, { error: "The text is not available from your transcript." });
  if (typeof body.call !== "string" || typeof body.field !== "string") return none();
  const loaded = loadRows(ledger, taskId, BUILD_IDENTITY, { transcriptsRoot: deps.transcriptsRoot });
  if (loaded.valuesExpiredAt !== null) return none();
  const found = readRecord(loaded.ops, []).calls.get(body.call);
  const record = found?.toolLabel?.withheld?.[body.field];
  const text = await revealWithheld(body.field, record, deps.transcriptsRoot, found?.host);
  if (text === undefined) return none();
  return sendJson(res, 200, { call: body.call, field: body.field, text });
}

/** The status route's `notes`: every live sticky note with its region's shape, where and whether it has a picture. */
export function notesOf(ledger: Ledger, home: string, taskId: number, model?: RailModel) {
  // A note stored on the gone record of a moved step shows on the moved stop (`carryMoved` does the same for verdicts).
  const movedStop = new Map((model?.stops ?? []).flatMap((s) => (s.moved === undefined ? [] : [[s.moved.fromStop, s] as const])));
  const regions = new Map(ledger.regionsForTask(taskId).map((r) => [r.id, r]));
  return ledger.liveNotes(taskId).map((n) => {
    const r = n.regionId === null ? undefined : regions.get(n.regionId);
    let region: Record<string, unknown> | null = null;
    if (r !== undefined) {
      region = { change: movedStop.get(`chg-${r.changeKey}`)?.change?.key ?? r.changeKey, side: r.side, kind: r.kind };
      const rect = r.rect;
      if (r.kind === "picture") {
        if (r.page !== null) region.page = r.page;
        if (Array.isArray(rect)) region.rect = rect;
        else if (rect !== null && typeof rect === "object") {
          const o = rect as { rect?: unknown; points?: unknown };
          if (o.rect !== undefined) region.rect = o.rect;
          region.shape = { type: "lasso", points: o.points };
        }
      } else if (rect !== null && typeof rect === "object") {
        const o = rect as { sheet?: unknown; range?: unknown; cells?: unknown; from?: unknown; to?: unknown };
        if (r.kind === "cells") {
          region.sheet = o.sheet;
          region.range = o.range;
          if (o.cells !== undefined) region.cells = o.cells;
        } else {
          region.from = o.from;
          region.to = o.to;
        }
      }
    }
    const ref = r === undefined ? undefined : regionsById(ledger, home, taskId, [r.id])[0];
    return { id: n.id, text: n.text, ts: n.ts, regionId: n.regionId, region, stop: n.stopId === null ? n.stopId : movedStop.get(n.stopId)?.id ?? n.stopId, where: r?.where ?? "", picture: ref?.picture != null };
  });
}

/**
 * POST /timeline/<task>/review/notes {text, regionId?, stop?} -> {id}: a new sticky note (text 1-2000 characters), optionally on an unlinked region of this task.
 * `stop` is the rail stop on show when it was made (1-300 characters, as the page names it); the page goes back to it from the note. Absent is none.
 * POST /timeline/<task>/review/notes/<id> {text} edits it, {deleted: true} retires it. Nothing here touches region_links; the send-back links.
 */
async function handleNotes(ledger: Ledger, req: http.IncomingMessage, res: http.ServerResponse, url: URL, taskId: number, noteId: number | undefined, allowedHosts: string[], token: Buffer): Promise<void> {
  const body = await postBody(ledger, req, res, url, taskId, allowedHosts, token);
  if (body === undefined || refuseExpired(ledger, res, taskId)) return;
  const bad = (error: string) => sendJson(res, 400, { error });
  const textOf = (): string | undefined => {
    if (typeof body.text !== "string") return void bad("text must be text");
    const text = body.text.trim();
    if (text.length < 1 || text.length > 2000) return void bad("A note takes 1 to 2000 characters.");
    return text;
  };
  if (noteId === undefined) {
    const text = textOf();
    if (text === undefined) return;
    let regionId: number | null = null;
    if (body.regionId !== undefined && body.regionId !== null) {
      if (typeof body.regionId !== "number" || !Number.isSafeInteger(body.regionId) || body.regionId < 1) return bad("regionId must be a region id");
      regionId = body.regionId;
    }
    let stop: string | null = null;
    if (body.stop !== undefined && body.stop !== null) {
      if (typeof body.stop !== "string" || body.stop.length < 1 || body.stop.length > 300) return bad("stop must be a step id");
      stop = body.stop;
    }
    const id = ledger.immediate(() => {
      const problem = regionId === null ? undefined : ledger.noteRegionProblem(taskId, regionId);
      if (problem !== undefined) return problem;
      return ledger.appendNote(taskId, text, regionId, stop);
    });
    if (typeof id === "string") return bad(id);
    ledger.recordActivity(taskId, "reviewer", new Date());
    return sendJson(res, 200, { id });
  }
  if (body.deleted === true) {
    if (!ledger.deleteNote(taskId, noteId)) return sendJson(res, 404, { error: "no such note" });
  } else {
    if (body.deleted !== undefined && body.deleted !== false) return bad("deleted must be true");
    const text = textOf();
    if (text === undefined) return;
    if (!ledger.editNote(taskId, noteId, text)) return sendJson(res, 404, { error: "no such note" });
  }
  ledger.recordActivity(taskId, "reviewer", new Date());
  return sendJson(res, 200, { id: noteId });
}

/** The region ids of a note's body (`regions`), or the reason it is not a list of up to `MAX_NOTE_REGIONS` region ids. Absent is none. */
function regionIdsOf(body: Record<string, unknown>): number[] | string {
  const raw = body.regions;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "number" || !Number.isSafeInteger(x) || x < 1)) return "regions must be a list of region ids";
  if (raw.length > MAX_NOTE_REGIONS) return `A note takes at most ${MAX_NOTE_REGIONS} regions.`;
  return raw as number[];
}

/** At most this many lines in one line region. */
const MAX_REGION_SPAN_LINES = 400;

/** [x, y, w, h] as fractions of the picture: finite, inside 0..1, w and h above 0. Null when it is not. */
function parseFractions(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 4 || raw.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  const [x, y, w, h] = raw as [number, number, number, number];
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x > 1 || y > 1 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) return null;
  return [x, y, w, h];
}

/**
 * The points of a lasso, each [x, y] finite and inside 0 to 1 as fractions of the picture, 3 to 400 of them. Returns the points and their bounding box as
 * [x, y, w, h]; null when they are not, or when the box has no area.
 */
function parseLasso(raw: unknown): { points: Array<[number, number]>; box: [number, number, number, number] } | null {
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > 400) return null;
  const points: Array<[number, number]> = [];
  for (const pt of raw) {
    if (!Array.isArray(pt) || pt.length !== 2 || pt.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) return null;
    points.push([pt[0] as number, pt[1] as number]);
  }
  const xs = points.map((q) => q[0]);
  const ys = points.map((q) => q[1]);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const [w, h] = [Math.max(...xs) - x0, Math.max(...ys) - y0];
  return w > 0 && h > 0 ? { points, box: [x0, y0, w, h] } : null;
}

/**
 * POST /timeline/<task>/review/region: the person drew a spot on one change's before or after picture or text. The body names the change key
 * and the side, never a sha or a path: the state is the one the task's own timeline holds for that change and side, so the region can only be of the
 * version the person was looking at. A picture is cut server-side from the same render the page loads (the pdfpage route's, or the stored PNG's) and
 * written plain at `regions/<id>.png` under the task folder, mode 0600; lines write no file. (The cell-region kind is not accepted; stored cell regions still read back through the status route.) A secret file is a 404 with nothing recorded.
 * Answers {id, where, picture}.
 */
async function handleRegion(ledger: Ledger, home: string, deps: TimelineDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL, taskId: number, allowedHosts: string[], token: Buffer): Promise<void> {
  const body = await postBody(ledger, req, res, url, taskId, allowedHosts, token);
  if (body === undefined || refuseExpired(ledger, res, taskId)) return;
  const bad = (error: string) => sendJson(res, 400, { error });
  if (body.side !== "before" && body.side !== "after") return bad('side must be "before" or "after"');
  if (typeof body.change !== "string" || body.change === "" || body.change.length > 512) return bad("change must be a change key");
  const side: "before" | "after" = body.side;
  const kind = body.kind;
  if (kind !== "picture" && kind !== "lines") return bad('kind must be "picture" or "lines"');
  // Everything that can be judged from the body alone is judged before the timeline is built.
  let fractions: [number, number, number, number] | null = null;
  let page: number | null = null;
  let lasso: ReturnType<typeof parseLasso> = null;
  let span: [number, number] = [0, 0];
  if (kind === "picture") {
    const shape = body.shape;
    if (shape !== undefined && shape !== null) {
      const type = typeof shape === "object" && !Array.isArray(shape) ? (shape as { type?: unknown }).type : undefined;
      if (type === "lasso") {
        lasso = parseLasso((shape as { points?: unknown }).points);
        if (lasso === null) return bad("a lasso needs 3 to 400 points [x, y], each inside 0 to 1, that span an area");
      } else if (type !== "box") return bad('shape must be {"type": "box"} or {"type": "lasso", "points": [...]}');
    }
    fractions = lasso !== null ? lasso.box : parseFractions(body.rect);
    if (fractions === null) return bad("rect must be [x, y, w, h] as fractions of the picture, inside 0 to 1");
    if (body.page !== undefined && body.page !== null) {
      if (typeof body.page !== "number" || !Number.isSafeInteger(body.page) || body.page < 1 || body.page > 99999) return bad("page must be a page number or null");
      page = body.page;
    }
  } else {
    const { from, to } = body;
    if (typeof from !== "number" || typeof to !== "number" || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > 10_000_000) return bad("from and to must be line numbers, from first");
    if (to - from + 1 > MAX_REGION_SPAN_LINES) return bad(`A line region is at most ${MAX_REGION_SPAN_LINES} lines.`);
    span = [from, to];
  }
  const loaded = loadRows(ledger, taskId, BUILD_IDENTITY, { transcriptsRoot: deps.transcriptsRoot });
  if (loaded.valuesExpiredAt !== null) return sendJson(res, 410, { error: "This task's values expired, and the file states went with them.", expired: true });
  const hit = await cachedBody(ledger, home, deps, taskId, loaded);
  const timeline = JSON.parse(hit.body) as Timeline;
  const change = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))].find((c) => c.id === body.change);
  if (change === undefined) return sendJson(res, 404, { error: "not found" });
  const states = ledger.fileStatesForTask(taskId);
  const secretShas = secretShasOf(states.map((r) => ({ path: r.filePath, sha: r.sha256, prev: r.prevSha256, note: r.note })));
  const shas = [change.before?.sha256 ?? null, change.after.sha256];
  if (isSecretPath(change.file) || shas.some((s) => s !== null && secretShas.has(s))) return sendJson(res, 404, { error: "not found" });
  // The state the change key and side name, and no other: a pass's before is that pass's own previous state, never the file's last one.
  const sha = side === "before" ? shas[0]! : shas[1]!;
  if (sha === null || !/^[0-9a-f]{64}$/.test(sha)) return sendJson(res, 404, { error: `This change has no ${side} version.` });
  if (ledger.regionsForTask(taskId).length >= MAX_TASK_REGIONS) return sendJson(res, 409, { error: `A task keeps at most ${MAX_TASK_REGIONS} regions.` });
  const name = fileBase(change.file);
  const readState = async (): Promise<Buffer | null> => {
    try {
      const file = path.join(storeDirOf(home, taskId), sha);
      if (plainSizeOf((await stat(file)).size) > VIEW_MAX_BYTES) return null;
      return await readSealed(file);
    } catch (error) {
      if (isKeyMissing(error)) throw error;
      return null;
    }
  };
  let where: string;
  let stored: unknown;
  let crop: Buffer | undefined;
  if (kind === "picture") {
    const file = change.file;
    const paged = /\.pdf$/i.test(file);
    // A state a connector reads has no picture CoCheck draws (no Quick
    // Look picture, no page either), so there is nothing to cut.
    const blocked = noCorePicture(home, states);
    if (blocked.file(file) || blocked.sha(sha)) return sendJson(res, 404, { error: "not found" });
    if (paged && page === null) return bad("This file is drawn in pages: say which page.");
    if (!paged && page !== null) return bad("This file is drawn as one picture: page must be null.");
    let source: Buffer;
    if (paged) {
      const drawn = await renderStatePage(ledger, home, taskId, sha, page!);
      if (!("png" in drawn)) return sendJson(res, drawn.status, drawn.body);
      source = drawn.png;
    } else {
      const row = states.find((r) => r.sha256 === sha || r.prevSha256 === sha);
      if (imageTypeOf(row?.filePath ?? file) === null) return sendJson(res, 404, { error: "not found" });
      const stored = await readStoredImage(home, taskId, sha);
      if (stored === null) return sendJson(res, 404, { error: "The state's bytes are no longer in the store.", missing: "The state's bytes are no longer in the store." });
      source = stored;
    }
    const info = pngInfo(source);
    if ("refused" in info) return sendJson(res, 422, { error: `CoCheck cannot cut this picture: ${info.refused}.` });
    const [fx, fy, fw, fh] = fractions!;
    const x0 = Math.min(info.width - 1, Math.round(fx * info.width));
    const y0 = Math.min(info.height - 1, Math.round(fy * info.height));
    const x1 = Math.min(info.width, Math.round((fx + fw) * info.width));
    const y1 = Math.min(info.height, Math.round((fy + fh) * info.height));
    if (x1 - x0 < 8 || y1 - y0 < 8) return bad("The region is too small: it must cover at least 8 by 8 pixels of the picture.");
    const cut = lasso !== null
      ? cropPngPath(source, x0, y0, x1 - x0, y1 - y0, lasso.points.map(([px, py]) => [px * info.width, py * info.height] as [number, number]))
      : cropPng(source, x0, y0, x1 - x0, y1 - y0);
    if ("refused" in cut) return sendJson(res, 422, { error: `CoCheck cannot cut this picture: ${cut.refused}.` });
    crop = cut.png;
    where = `${paged ? `page ${page} of ` : ""}the ${side} version of ${name}`;
    stored = lasso !== null ? { type: "lasso", rect: fractions, points: lasso.points } : fractions;
  } else {
    if (change.generic.tier !== "text" || change.generic.secret === true) return bad("Line regions are for text files.");
    where = span[0] === span[1] ? `line ${span[0]} of the ${side} version of ${name}` : `lines ${span[0]} to ${span[1]} of the ${side} version of ${name}`;
    const lines: string[] = [];
    const bytes = await readState();
    if (bytes !== null) {
      const all = bytes.toString("utf8").split(/\r?\n/);
      for (let n = span[0]; n <= span[1] && n <= all.length && lines.length < MAX_REGION_LINES; n++) lines.push(`${n}: ${all[n - 1]!.slice(0, 300)}`);
    }
    stored = { from: span[0], to: span[1], lines };
  }
  const file = (id: number) => regionPicturePath(home, taskId, id);
  const id = ledger.appendRegion({ taskId, changeKey: change.id, side, kind, sha, page, rect: stored, where, picture: crop !== undefined }, (newId) => {
    if (crop === undefined) return;
    const dir = regionsDirOf(home, taskId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    try {
      writeFileSync(file(newId), crop, { mode: 0o600 });
      chmodSync(file(newId), 0o600);
    } catch (error) {
      rmSync(file(newId), { force: true });
      throw error;
    }
  });
  ledger.recordActivity(taskId, "reviewer", new Date());
  return sendJson(res, 200, { id, where, picture: crop !== undefined });
}

/** GET /timeline/<task>/region/<id>: the PNG of one picture region of this task. The id is digits and is looked up in the task's own rows; no path comes from the request. */
async function handleRegionImage(ledger: Ledger, home: string, res: http.ServerResponse, taskId: number, rawId: string): Promise<void> {
  const row = ledger.regionsForTask(taskId).find((r) => r.id === Number(rawId));
  if (row === undefined || !row.picture) return sendJson(res, 404, { error: "not found" });
  let png: Buffer;
  try {
    png = readFileSync(regionPicturePath(home, taskId, row.id));
  } catch {
    return sendJson(res, 404, { error: "The region's picture is no longer there." });
  }
  return send(res, 200, png, "image/png", { "cache-control": "private, no-store" });
}

/**
 * POST /timeline/<task>/review/verdict: the person sets one stop's status. Same rules as every other state-changing POST:
 * the page token, an Origin that is this server's own, a JSON body. The fingerprint and subject are never taken from the body: the server
 * builds the stop's identity from the task's own record, so a verdict can only be bound to the content the stop has now.
 */
async function handleVerdict(ledger: Ledger, home: string, deps: TimelineDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL, taskId: number, allowedHosts: string[], token: Buffer): Promise<void> {
  const body = await postBody(ledger, req, res, url, taskId, allowedHosts, token);
  if (body === undefined || refuseExpired(ledger, res, taskId)) return;
  const status = body.status;
  if (status !== "passed" && status !== "failed" && status !== "not_reviewed") {
    return sendJson(res, 400, { error: 'status must be "passed", "failed" or "not_reviewed"' });
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (status === "failed" && note === "") {
    return sendJson(res, 400, { error: "Failing a stop needs a short note: say what is wrong." });
  }
  if (note.length > 2000) {
    return sendJson(res, 400, { error: "The note is too long (2000 characters at most)." });
  }
  if (typeof body.stop !== "string") {
    return sendJson(res, 400, { error: "stop must be a stop id" });
  }
  const regionIds = regionIdsOf(body);
  if (typeof regionIds === "string") return sendJson(res, 400, { error: regionIds });
  if (regionIds.length > 0 && status !== "failed") return sendJson(res, 400, { error: "Only a failed step takes regions." });
  const loaded = loadRows(ledger, taskId, BUILD_IDENTITY, { transcriptsRoot: deps.transcriptsRoot });
  const hit = await cachedBody(ledger, home, deps, taskId, loaded);
  const timeline = JSON.parse(hit.body) as Timeline;
  const model = buildRailModel(timeline, { connectorFor: connectorMatcherFor(home) });
  const identity = stopIdentities(model, timeline).get(body.stop);
  if (identity === undefined) {
    return sendJson(res, 404, { error: "no such stop in this task" });
  }
  // Every region is judged before anything is recorded: one that does not belong refuses the whole save and links nothing.
  const stopChange = changesByStop(timeline).get(body.stop);
  // A region whose only link is to an EARLIER verdict of this same stop that is no longer the stop's latest verdict (the person pressed U
  // and is saving the draft again) cannot be linked a second time (region_links is append-only, one link per region), so it is saved as a copy:
  // a new region row with the same where, locator and picture file. A region of the stop's live fail, of another stop, or held by a note is refused as before.
  const verdictsOfStop = ledger.stopVerdictsForTask(taskId).filter((v) => v.stopId === body.stop);
  const latestOfStop = verdictsOfStop.length === 0 ? undefined : Math.max(...verdictsOfStop.map((v) => v.id));
  const taskRegions = new Map(ledger.regionsForTask(taskId).map((r) => [r.id, r]));
  const copies = new Set(regionIds.filter((rid) => {
    const r = taskRegions.get(rid);
    return r !== undefined && r.verdictId !== undefined && r.stopId === body.stop && r.verdictId !== latestOfStop;
  }));
  if (regionIds.length > 0) {
    let problem: string | undefined;
    if (stopChange === undefined) problem = "This step is not a file change, so it has nothing to point at.";
    else {
      problem = ledger.regionLinkProblem(taskId, regionIds.filter((rid) => !copies.has(rid)), stopChange.id);
      if (problem === undefined && copies.size > 0) {
        if (regionIds.length > MAX_NOTE_REGIONS) problem = `A note takes at most ${MAX_NOTE_REGIONS} regions.`;
        else if (new Set(regionIds).size !== regionIds.length) problem = "A region is listed twice.";
        else if (taskRegions.size + copies.size > MAX_TASK_REGIONS) problem = `A task keeps at most ${MAX_TASK_REGIONS} regions.`;
        else {
          const held = new Set(ledger.liveNotes(taskId).flatMap((n) => (n.regionId === null ? [] : [n.regionId])));
          const bad = [...copies].find((rid) => held.has(rid) || taskRegions.get(rid)!.changeKey !== stopChange.id);
          if (bad !== undefined) problem = held.has(bad) ? `Region ${bad} is already part of a note.` : `Region ${bad} was drawn on a different step.`;
        }
      }
    }
    if (problem !== undefined) return sendJson(res, 400, { error: problem });
  }
  // The copies are written first (appendRegion opens its own write); a copy left behind by a failed save is an unlinked region the task cap bounds.
  const linked = regionIds.map((rid) => {
    if (!copies.has(rid)) return rid;
    const r = taskRegions.get(rid)!;
    const copyId = ledger.appendRegion({ taskId, changeKey: r.changeKey, side: r.side, kind: r.kind, sha: r.sha, page: r.page, rect: r.rect, where: r.where, picture: r.picture }, (newId) => {
      if (!r.picture || !existsSync(regionPicturePath(home, taskId, rid))) return;
      copyFileSync(regionPicturePath(home, taskId, rid), regionPicturePath(home, taskId, newId));
      chmodSync(regionPicturePath(home, taskId, newId), 0o600);
    });
    return copyId;
  });
  ledger.immediate(() => {
    const verdictId = ledger.appendStopVerdict({ taskId, stopId: body.stop as string, subject: identity.subject, fingerprint: identity.fingerprint, status, note, reviewer: defaultReviewer() });
    if (linked.length > 0) ledger.linkRegions(linked, { verdictId });
  });
  ledger.recordActivity(taskId, "reviewer", new Date());
  const summary = summarize(model, timeline, ledger.stopVerdictsForTask(taskId), verdictEvents(ledger.sendBacksForTask(taskId), ledger.submissionsForTask(taskId)));
  return sendJson(res, 200, { stop: body.stop, state: summary.stops[body.stop], anyFailed: summary.anyFailed, anyNotReviewed: summary.anyNotReviewed, counts: summary.counts, submit: summary.submit });
}

/**
 * POST /timeline/<task>/review/submit: the person submits the task. Soft sign-off: a sign-off row with the
 * signature kind "soft", which every surface reads as "soft sign-off, not verified". Same rules as every state-changing POST. The server
 * enforces the three rules itself, from the verdicts it holds, and never takes a status from the body:
 *   a stop failed now (and not replaced by a later state of its file) -> 409, nothing recorded;
 *   a stop not reviewed -> 409 unless the body's `acknowledge` is exactly that set of stop ids (a changed set is a 409 again);
 *   otherwise it goes straight through.
 * The acknowledgement is recorded with the submission. A soft sign-off can be forged by anything that can read the page token; accepted for prototyping.
 */
async function handleSubmit(ledger: Ledger, home: string, deps: TimelineDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL, taskId: number, allowedHosts: string[], token: Buffer): Promise<void> {
  const body = await postBody(ledger, req, res, url, taskId, allowedHosts, token);
  if (body === undefined) return;
  const ack = body.acknowledge;
  if (ack !== undefined && (!Array.isArray(ack) || ack.some((x) => typeof x !== "string"))) {
    return sendJson(res, 400, { error: "acknowledge must be a list of stop ids" });
  }
  // Read before the timeline is built. A file state that lands after this is not in what the person looked at; the check below refuses.
  const stateMark = ledger.maxFileStateId(taskId);
  const loaded = loadRows(ledger, taskId, BUILD_IDENTITY, { transcriptsRoot: deps.transcriptsRoot });
  const hit = await cachedBody(ledger, home, deps, taskId, loaded);
  const timeline = JSON.parse(hit.body) as Timeline;
  const model = buildRailModel(timeline, { connectorFor: connectorMatcherFor(home) });
  const reviewer = defaultReviewer();
  const files = [...new Map(ledger.fileStatesForTask(taskId).map((f) => [f.filePath, { path: f.filePath, sha256: f.sha256 }])).values()];
  const latestRound = ledger.roundsForTask(taskId).at(-1);
  const changes = changesByStop(timeline);
  const acknowledged = [...new Set((ack as string[] | undefined) ?? [])].sort();
  let refusal: { code: string; error: string; notReviewed?: string[] } | null = null;
  try {
    // The check reads the verdicts inside the write lock, so a verdict given while this request was loading cannot slip past it.
    const recorded = ledger.recordSoftSubmission(
      { taskId, signer: reviewer, rounds: latestRound?.seq ?? 0, rejections: [], files, leftOut: [], closedTask: false, acknowledged, reviewer, stateMark },
      () => {
        const last = ledger.submissionsForTask(taskId).at(-1);
        const verdictRows = ledger.stopVerdictsForTask(taskId);
        // New work is a new file state, a step the last sign-off did not cover, or a verdict or file version that differs from what it covered.
        const since = afterSignoff(model, timeline, verdictRows, last);
        if (last !== undefined && !ledger.newWorkSince(taskId, last) && since.changed.length === 0 && since.newSteps.length === 0) {
          refusal = { code: "NOTHING_NEW", error: "Nothing new has come in since you signed off, so there is nothing more to sign off." };
          throw new Error(refusal.code);
        }
        if (ledger.maxFileStateId(taskId) !== stateMark) {
          refusal = { code: "WORK_MOVED", error: "New work came in while you were signing off. Look at the page again, then sign off." };
          throw new Error(refusal.code);
        }
        const { submit, stops: states } = summarize(model, timeline, verdictRows, verdictEvents(ledger.sendBacksForTask(taskId), ledger.submissionsForTask(taskId)));
        if (model.stops.length === 0) {
          refusal = { code: "NOTHING_TO_SUBMIT", error: "There is nothing in this task to sign off." };
        } else if (submit.blocking.length > 0) {
          refusal = { code: "FAILED_STOPS", error: `${submit.blocking.length === 1 ? "A stop is" : `${submit.blocking.length} stops are`} failed, so this task cannot be signed off. Fix or reset ${submit.blocking.length === 1 ? "it" : "them"} first.`, notReviewed: submit.notReviewed };
        } else if (submit.notReviewed.length > 0) {
          const want = [...submit.notReviewed].sort();
          if (acknowledged.length === 0) {
            refusal = { code: "ACK_REQUIRED", error: `${want.length === 1 ? "1 stop is" : `${want.length} stops are`} not looked at. Confirm that to sign off.`, notReviewed: submit.notReviewed };
          } else if (acknowledged.length !== want.length || acknowledged.some((id, i) => id !== want[i])) {
            refusal = { code: "ACK_STALE", error: "The steps not looked at changed since you were asked. Look again and confirm the current set.", notReviewed: submit.notReviewed };
          }
        }
        if (refusal !== null) throw new Error((refusal as { code: string }).code);
        // What this submission covers: every stop with the status it has now and the file version it stands on. Built from the verdicts this check just read, under the same lock.
        return model.stops.map((stop) => ({ stop: stop.id, status: states[stop.id]?.status ?? "not_reviewed", sha256: changes.get(stop.id)?.after.sha256 ?? null }));
      },
    );
    ledger.recordActivity(taskId, "reviewer", new Date());
    return sendJson(res, 200, { submitted: true, n: ledger.submissionsForTask(taskId).length, id: recorded.submissionId, signoffId: recorded.signoffId, signature: SOFT_SIGNATURE, label: SOFT_SIGNOFF_LABEL, acknowledged });
  } catch (error) {
    if (refusal !== null) return sendJson(res, 409, refusal);
    throw error;
  }
}

/**
 * GET /timeline/<task>/review/mcp/<call id>: the card of an MCP call no connector handles. Built server-side from the call's kept values (sealed
 * and secret-scrubbed in the task's store, scrubbed again on the way out) and the task's own record; the answer is plain strings (see src/timeline/rail/mcp-card.ts).
 * The call must be an MCP call of this task's record; nothing else is read. Same token, Host, Origin and method rules as the other timeline routes.
 */
async function handleMcpCard(ledger: Ledger, home: string, deps: TimelineDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL, taskId: number, rawCall: string, allowedHosts: string[], token: Buffer): Promise<void> {
  if (!tokenMatches(token, url.searchParams.get("t"))) return sendJson(res, 403, { error: "missing or wrong token" });
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedHosts.some((h) => origin.toLowerCase() === `http://${h}`)) return sendJson(res, 403, { error: "cross-origin request refused" });
  if (!ledger.allTaskIds().includes(taskId)) return sendJson(res, 404, { error: "not found" });
  let callId: string;
  try {
    callId = decodeURIComponent(rawCall);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  const loaded = loadRows(ledger, taskId, BUILD_IDENTITY, { transcriptsRoot: deps.transcriptsRoot });
  if (loaded.valuesExpiredAt !== null) return sendJson(res, 410, { error: "This task's values expired.", expired: true });
  const timeline = JSON.parse((await cachedBody(ledger, home, deps, taskId, loaded)).body) as Timeline;
  const calls = timeline.requests.flatMap((q) => q.runs.flatMap((r) => r.calls));
  const at = calls.findIndex((c) => c.id === callId);
  const call = at < 0 ? undefined : calls[at]!;
  if (call === undefined || call.mcp === undefined) return sendJson(res, 404, { error: "not found" });
  const kept = await readKeptCall(home, taskId, callId);
  // The earlier reads: calls on the same server before this one (by start time when both have one, else record order), oldest first.
  const before = calls.filter((c, i) => c.id !== callId && c.mcp?.server === call.mcp!.server && c.tool != null && isReadOnlyMcpTool(c.tool) && (c.start != null && call.start != null ? c.start < call.start : i < at));
  const earlier: EarlierCall[] = [];
  if (kept !== null) {
    for (const c of before) {
      const k = await readKeptCall(home, taskId, c.id);
      if (k !== null) earlier.push({ tool: k.tool, failed: c.outcome === "failed", kept: k });
    }
  }
  const card = mcpCardOf({ server: call.mcp.server, tool: call.mcp.tool, failed: call.outcome === "failed" }, kept, kept === null ? undefined : pickEarlierRead(kept.input, earlier));
  return send(res, 200, JSON.stringify(card), "application/json; charset=utf-8", { "cache-control": "private, no-store" });
}

async function handleTimeline(ledger: Ledger, home: string, deps: TimelineDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL, target: { task: string; callId?: string; sha?: string; page?: boolean; viewKey?: string; pdfPage?: { sha: string; n: number }; outsidePaths?: boolean; review?: "shell" | "model" | "status"; regionId?: string; cpic?: string }, allowedHosts: string[], token: Buffer): Promise<void> {
  if (!tokenMatches(token, url.searchParams.get("t"))) {
    return sendJson(res, 403, { error: "missing or wrong token" });
  }
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "method not allowed" });
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedHosts.some((h) => origin.toLowerCase() === `http://${h}`)) {
    return sendJson(res, 403, { error: "cross-origin request refused" });
  }
  const taskId = Number(target.task);
  if (!Number.isSafeInteger(taskId) || !ledger.allTaskIds().includes(taskId)) {
    return sendJson(res, 404, { error: "not found" });
  }
  if (target.pdfPage !== undefined) {
    return handlePdfPage(ledger, home, res, taskId, target.pdfPage.sha, target.pdfPage.n);
  }
  if (target.regionId !== undefined) {
    return handleRegionImage(ledger, home, res, taskId, target.regionId);
  }
  if (target.cpic !== undefined) {
    return handleConnectorPicture(ledger, home, res, taskId, target.cpic);
  }
  if (target.outsidePaths === true) {
    return handleOutsidePaths(ledger, home, res, taskId);
  }
  if (target.viewKey !== undefined) {
    const w = url.searchParams.get("whole");
    return handleView(ledger, home, deps, res, taskId, target.viewKey, w === "before" || w === "after" ? w : undefined);
  }
  if (target.review === "shell") {
    // The shell holds the task number and nothing else, so it answers before any timeline is built; the page asks for the model next.
    return send(res, 200, renderReviewShell(taskId, notRecordingReason(home)), "text/html; charset=utf-8", { "cache-control": "private, no-store", "content-security-policy": reviewCsp(activeViewServer()?.origin) });
  }
  if (target.callId === undefined && target.sha === undefined) {
    // Rows the hook recorded with no connector, whose file a built-in claims now, are queued before the rows are read, so this body already
    // shows them as being read; settleLoaded reads them one at a time, under the task lock, through the live capture path.
    queueOldRows(ledger, home, taskId);
    const loaded = loadRows(ledger, taskId, BUILD_IDENTITY, { transcriptsRoot: deps.transcriptsRoot });
    // Before any 304, so a page that last saw a row as being read still gets it read in a fresh process.
    settleLoaded(ledger, home, deps, loaded);
    // The body holds what the installed connectors say, so the tag moves when one is installed, removed or upgraded.
    const connectorsKey = installedConnectorsKey(home);
    const bodyTag = connectorsKey === "[]" ? loaded.etag : `${loaded.etag.slice(0, -1)}-${createHash("sha256").update(connectorsKey).digest("hex").slice(0, 12)}"`;
    const headers = { etag: bodyTag, "cache-control": "private, no-cache" };
    if (target.page !== true && target.review === undefined && req.headers["if-none-match"] === bodyTag) {
      res.writeHead(304, headers);
      return void res.end();
    }
    // The model route answers 304 without building the rail model only when everything its answer is made of is unchanged: the loaded etag
    // (the cached body is keyed on it and a pending body is never cached), the installed connectors, the live flag and the quiet minutes.
    const modelKeyOf = (ls: { live: boolean; quietMin: number | null }): string => JSON.stringify([loaded.etag, installedConnectorsKey(home), ls.live, ls.quietMin]);
    if (target.review === "model") {
      const seen = deps.cache.get(taskId);
      if (seen !== undefined && seen.etag === loaded.etag && seen.model !== undefined && req.headers["if-none-match"] === seen.model.etag && seen.model.key === modelKeyOf(liveState(loaded.ops, Date.now()))) {
        res.writeHead(304, { etag: seen.model.etag, "cache-control": "private, no-cache" });
        return void res.end();
      }
    }
    const hit = await cachedBody(ledger, home, deps, taskId, loaded);
    if (target.review === "status") {
      const body = JSON.parse(hit.body) as Timeline;
      const all = ledger.submissionsForTask(taskId);
      const submitted = all.at(-1);
      const signoffs = ledger.signoffsForTask(taskId);
      const signoff = submitted === undefined ? undefined : signoffs.find((s) => s.id === submitted.signoffId);
      const entry = (sub: (typeof all)[number], n: number) => ({ id: sub.id, n, ts: sub.ts, reviewer: sub.reviewer, acknowledged: sub.acknowledged, covered: sub.covered, label: signoffQualifier(signoffs.find((s) => s.id === sub.signoffId) ?? { signature: null }) });
      // "none" (never submitted), "submitted" (nothing new since the latest), "new_work" (file states landed since the latest: submit again).
      const railModel = buildRailModel(body, { connectorFor: connectorMatcherFor(home) }), verdictRows = ledger.stopVerdictsForTask(taskId);
      // The markers of the send-backs and submissions and the tags of the stops after them, from file history alone.
      const passes = buildPasses(railModel, body, verdictRows, ledger.sendBacksForTask(taskId), all);
      // new_work: anything after the latest sign-off (a file state, a new step, a changed verdict or version), so an old sign-off never reads as covering it.
      const submitState = submitted === undefined ? "none" : ledger.newWorkSince(taskId, submitted) || passes.afterSignoff.changed.length > 0 || passes.afterSignoff.newSteps.length > 0 ? "new_work" : "submitted";
      const follow = ledger.followOf(taskId);
      const state = { ...summarize(railModel, body, verdictRows, verdictEvents(ledger.sendBacksForTask(taskId), all)), notes: notesOf(ledger, home, taskId, railModel), passes, follow: follow === undefined ? null : { task: follow.fromTask, sentAt: follow.sentAt }, followedBy: ledger.followersOf(taskId).map((f) => ({ task: f.taskId })), submitState, submitted: submitted === undefined || signoff === undefined ? null : entry(submitted, all.length), earlier: all.slice(0, -1).map((sub, i) => entry(sub, i + 1)).reverse() };
      return send(res, 200, JSON.stringify(state), "application/json; charset=utf-8", { "cache-control": "private, no-store" });
    }
    if (target.review !== undefined) {
      // The page polls this route while the agent works. The tag is the hash of the answer itself, so a 304 can never hide a change
      // that came from outside the ledger (the live flag turning off at the idle window).
      // No await from here to the end of the build: the key is read in the same step as the inputs the body is made from.
      const ls = liveState(loaded.ops, Date.now());
      const modelKey = target.review === "model" ? modelKeyOf(ls) : "";
      const body = JSON.stringify({ ...buildRailModel(JSON.parse(hit.body), { connectorFor: connectorMatcherFor(home) }), live: ls.live, ...(ls.quietMin === null ? {} : { quietMin: ls.quietMin }) });
      const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
      // Remembered only on a cached (finished, not pending) body, with the key read in the same synchronous step as the body.
      const kept = deps.cache.get(taskId);
      if (target.review === "model" && kept !== undefined && kept.etag === loaded.etag) kept.model = { key: modelKey, etag };
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag, "cache-control": "private, no-cache" });
        return void res.end();
      }
      return send(res, 200, body, "application/json; charset=utf-8", { "cache-control": "private, no-cache", etag });
    }
    if (target.page === true) {
      // The general page: built from the timeline body alone, and it loads its pictures from the preview route (img-src 'self').
      const html = renderGenericPage(JSON.parse(hit.body), url.searchParams.get("t")!);
      return send(res, 200, html, "text/html; charset=utf-8", {
        "cache-control": "private, no-store",
        // Scripts and the page's own fetch are allowed only on a page with a preview still running; every other page stays script-free.
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; ${html.includes("data-pending") ? "script-src 'unsafe-inline'; connect-src 'self'; " : ""}img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      });
    }
    return send(res, 200, hit.body, "application/json; charset=utf-8", headers);
  }
  // Neither id below ever reaches the file system as a path: a call id is looked up in the task's own ops, and a hash must be one of
  // the task's own file states before its bytes are read from the task's own store.
  if (target.callId !== undefined) {
    let callId: string;
    try {
      callId = decodeURIComponent(target.callId);
    } catch {
      return sendJson(res, 404, { error: "not found" });
    }
    const loaded = loadRows(ledger, taskId, BUILD_IDENTITY, { transcriptsRoot: deps.transcriptsRoot });
    if (loaded.valuesExpiredAt !== null) {
      return sendJson(res, 410, { error: "This task's values expired, and the command went with them.", expired: true });
    }
    const found = commandOfCall(loaded, callId);
    if (found === undefined) {
      return sendJson(res, 404, { error: "not found" });
    }
    if (found.command === null) {
      return sendJson(res, 404, { error: "This call ran no command." });
    }
    return sendJson(res, 200, { call: callId, tool: found.tool, command: found.command, note: "The raw command as the host recorded it. It is local to this machine and is never part of the timeline." });
  }
  const sha = target.sha!;
  const row = /^[0-9a-f]{64}$/.test(sha) ? ledger.fileStatesForTask(taskId).find((r) => r.sha256 === sha || r.prevSha256 === sha) : undefined;
  if (row === undefined) {
    return sendJson(res, 404, { error: "not found" });
  }
  // A secret file's states are never rendered, cached or served, whichever hash is asked for.
  const taskStates = ledger.fileStatesForTask(taskId);
  // By name, and by bytes: a state with the hash of any secret-named file's bytes in the task is a secret under every name.
  if (taskStates.some((r) => (r.sha256 === sha || r.prevSha256 === sha) && isSecretPath(r.filePath)) || secretShasOf(taskStates.map((r) => ({ path: r.filePath, sha: r.sha256, prev: r.prevSha256, note: r.note }))).has(sha)) {
    return sendJson(res, 404, { error: "not found" });
  }
  // No picture of a state a connector reads, under any name that shares its bytes.
  if (noCorePicture(home, taskStates).sha(sha)) {
    return sendJson(res, 404, { error: "not found" });
  }
  // The stored bytes themselves, by hash, with the content type of the file's own image extension (never the bytes' own claim).
  const type = taskStates.filter((r) => r.sha256 === sha || r.prevSha256 === sha).map((r) => imageTypeOf(r.filePath)).find((t) => t !== null);
  if (type === undefined || type === null) {
    return sendJson(res, 404, { error: "not found" });
  }
  const bytes = await readStoredImage(home, taskId, sha);
  if (bytes === null) {
    const missing = "The state's bytes are no longer in the store.";
    return sendJson(res, 404, { error: missing, missing });
  }
  // The browser may only draw this as an image: no script, nothing loaded, sandboxed even if the address is opened on its own.
  return send(res, 200, bytes, type, { "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "same-origin" });
}

/**
 * Whether a state-changing POST comes from the page itself: Origin must be present and exactly
 * `http://<allowed host>` (no case folding, "null" and absent both refused). A cross-site
 * Sec-Fetch-Site is refused whatever the Origin says.
 */
function originAllowed(req: http.IncomingMessage, allowedHosts: string[]): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  return typeof origin === "string" && allowedHosts.some((h) => origin === `http://${h}`);
}

async function handle(ledger: Ledger, timeline: TimelineDeps, home: string, token: Buffer, req: http.IncomingMessage, res: http.ServerResponse, port: number, homeId: string, onShutdown?: () => void, pool: ConnectorPool = createConnectorPool()): Promise<void> {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(String(req.headers.host ?? "").toLowerCase())) {
    return sendJson(res, 403, { error: "forbidden host" });
  }
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/health") {
    return sendJson(res, 200, { cocheck: "review", home: homeId, build: BUILD_IDENTITY, builtAt: BUILD_TIME });
  }
  if (url.pathname === "/shutdown") {
    if (req.method === "POST" && !originAllowed(req, allowedHosts)) {
      return sendJson(res, 403, { error: "cross-origin request refused" });
    }
    if (!tokenMatches(token, url.searchParams.get("t"))) {
      return sendJson(res, 403, { error: "missing or wrong token" });
    }
    if (req.method !== "POST" || !onShutdown) {
      return sendJson(res, 405, { error: "method not allowed" });
    }
    sendJson(res, 200, { stopping: true });
    // Every pooled connector process stops before the process goes.
    return void setImmediate(() => void pool.stopAll().catch(() => {}).finally(onShutdown));
  }
  if (installFolderGone()) {
    // The install this process runs from was replaced (brew upgrade, tarball install). Say so plainly instead of failing on a missing file or key; a newer build replaces this process on the next hook event or `cocheck open`.
    const wantsJson = String(req.headers.accept ?? "").includes("json") || url.pathname.startsWith("/api/");
    return wantsJson
      ? sendJson(res, 503, { error: UPDATED_MESSAGE, code: "UPDATED" })
      : send(res, 503, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>CoCheck</title><p>${UPDATED_MESSAGE}</p>`, "text/html; charset=utf-8");
  }
  if (url.pathname === "/connector/before-snapshot") {
    return connectorBeforeSnapshot(home, token, pool, req, res, url);
  }
  if (url.pathname === "/connector/after-snapshot") {
    return connectorAfterSnapshot(ledger, home, token, pool, req, res, url);
  }
  if (url.pathname === "/connector/file-capture") {
    return connectorFileCapture(ledger, home, timeline, token, req, res, url);
  }
  if (url.pathname === "/") {
    if (!tokenMatches(token, url.searchParams.get("t"))) {
      return sendJson(res, 403, { error: "missing or wrong token" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method not allowed" });
    }
    return send(res, 200, homePage(ledger, url.searchParams.get("t")!, timeline.titleRoots, listTracked(home)), "text/html; charset=utf-8");
  }
  const assetMatch = /^\/timeline-assets\/(.+)$/.exec(url.pathname);
  if (assetMatch) {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    let name: string;
    try {
      name = decodeURIComponent(assetMatch[1]!);
    } catch {
      return sendJson(res, 404, { error: "not found" });
    }
    const asset = await readAsset(name);
    if (asset === undefined) return sendJson(res, 404, { error: "not found" });
    return send(res, 200, asset.body, asset.type, { "cache-control": "no-cache" });
  }
  const mcpMatch = /^\/timeline\/(\d+)\/review\/mcp\/([^/]+)$/.exec(url.pathname);
  if (mcpMatch) return handleMcpCard(ledger, home, timeline, req, res, url, Number(mcpMatch[1]), mcpMatch[2]!, allowedHosts, token);
  const timelineMatch = /^\/timeline\/(\d+)(?:\/(?:call\/([^/]+)\/command|preview\/([^/]+)|view\/([^/]+)|pdfpage\/([^/]+)\/(\d{1,5})|(page)|(outside-paths)|(review(?:\/model|\/status|\/verdict|\/sendback|\/sendback-copy|\/submit|\/reveal|\/region|\/notes(?:\/\d{1,9})?|\/preferences)?)|region\/(\d{1,9})|cpic\/([0-9a-f]{64})))?$/.exec(url.pathname);
  if (timelineMatch) {
    const review = timelineMatch[9] === undefined ? undefined : timelineMatch[9] === "review" ? ("shell" as const) : timelineMatch[9] === "review/status" ? ("status" as const) : timelineMatch[9] === "review/verdict" ? ("verdict" as const) : ("model" as const);
    const noteRoute = timelineMatch[9] === undefined ? null : /^review\/notes(?:\/(\d+))?$/.exec(timelineMatch[9]);
    if (noteRoute !== null) return handleNotes(ledger, req, res, url, Number(timelineMatch[1]), noteRoute[1] === undefined ? undefined : Number(noteRoute[1]), allowedHosts, token);
    if (timelineMatch[9] === "review/preferences") return handlePreferences(ledger, home, req, res, url, Number(timelineMatch[1]), allowedHosts, token);
    if (timelineMatch[9] === "review/submit") return handleSubmit(ledger, home, timeline, req, res, url, Number(timelineMatch[1]), allowedHosts, token);
    if (timelineMatch[9] === "review/sendback-copy") return handleSendBackCopy(ledger, req, res, url, Number(timelineMatch[1]), allowedHosts, token);
    if (timelineMatch[9] === "review/sendback") return handleSendBack(ledger, home, timeline, req, res, url, Number(timelineMatch[1]), allowedHosts, token);
    if (timelineMatch[9] === "review/reveal") return handleReveal(ledger, timeline, req, res, url, Number(timelineMatch[1]), allowedHosts, token);
    if (timelineMatch[9] === "review/region") return handleRegion(ledger, home, timeline, req, res, url, Number(timelineMatch[1]), allowedHosts, token);
    if (review === "verdict") return handleVerdict(ledger, home, timeline, req, res, url, Number(timelineMatch[1]), allowedHosts, token);
    return handleTimeline(ledger, home, timeline, req, res, url, { task: timelineMatch[1]!, callId: timelineMatch[2], sha: timelineMatch[3], viewKey: timelineMatch[4], ...(timelineMatch[5] === undefined ? {} : { pdfPage: { sha: timelineMatch[5], n: Number(timelineMatch[6]) } }), page: timelineMatch[7] === "page", ...(timelineMatch[8] === undefined ? {} : { outsidePaths: true }), ...(timelineMatch[10] === undefined ? {} : { regionId: timelineMatch[10] }), ...(timelineMatch[11] === undefined ? {} : { cpic: timelineMatch[11] }), ...(review === undefined ? {} : { review }) }, allowedHosts, token);
  }
  return sendJson(res, 404, { error: "not found" });
}

/**
 * The index (stop verdicts and submissions only; no review row, round or item is read). Every task with something recorded
 * (a file state, a verdict or an old round) is listed, newest activity first:
 *   waiting     not submitted, not expired: its files and the verdicts last marked ("1 failed, 2 passed", or "nothing marked yet").
 *               "Last marked" counts each stop's latest verdict row as it stands; the rail itself resets a stop whose content changed.
 *   signed off  the rail's Sign off (a soft sign-off in the record) and any sign-off with no submission behind it, collapsed, in the rail's words.
 *               A task with new work since its latest sign-off is also in the waiting list (see `workSinceSignoff`).
 *   expired     closed by the 7-day expiry without a submission, collapsed.
 * Every link goes to the rail.
 */
/**
 * Whether anything came after `sub`: a new file state, or a covered stop whose latest verdict now differs from the status the sign-off recorded.
 * The index has no timeline, so a verdict is read by stop id (a changed file version is a new file state, which `newWorkSince` already sees).
 * A sign-off with no covered list falls back to verdict rows given after it.
 */
function workSinceSignoff(ledger: Ledger, taskId: number, sub: SubmissionRow, verdicts: StopVerdictRow[]): boolean {
  if (ledger.newWorkSince(taskId, sub)) return true;
  if (sub.covered === null) return verdicts.some((v) => Date.parse(v.ts) > Date.parse(sub.ts));
  const into = movedInto(ledger.fileStatesForTask(taskId));
  const latest = new Map<string, string>();
  for (const v of verdicts) latest.set(into.get(v.stopId) ?? v.stopId, v.status);
  return sub.covered.some((c) => (latest.get(into.get(c.stop) ?? c.stop) ?? "not_reviewed") !== c.status);
}

/**
 * The old stop id of every gone record that a move pairs with a new file, to the new file's stop id, read from file states alone (the index has
 * no timeline), by the same rule the rail model pairs by (`movePairs`). The index has no folder or secret list, so it pairs on step and bytes
 * only; a pair the rail would refuse as secret or outside is folded here when it is not. A per-task count then never shows the old id as a stop.
 */
export function movedInto(states: readonly FileStateRow[]): Map<string, string> {
  const recs = states.flatMap((f): MoveRecord[] => {
    const kind = f.prevSha256 === null ? "created" : f.kept === "gone" ? "deleted" : null;
    return kind === null || isSecretPath(f.filePath) ? [] : [{ id: `chg-c${f.id}`, step: f.stepId, file: f.filePath, kind, sha: kind === "deleted" ? f.prevSha256! : f.sha256 }];
  });
  return new Map(movePairs(recs).map((p) => [p.gone.id, p.made.id] as const));
}

/**
 * A listed task's standing, by the index's own rules: signed off (and no new work since), expired, or waiting; a waiting task with a stop marked
 * is "reviewed", one with nothing marked is "unreviewed". No new verdict model: the same signoffs, closure and stop verdicts the index reads.
 */
function standingOf(ledger: Ledger, id: number): Pick<HomeSession, "standing" | "signed" | "newWork"> {
  const verdicts = ledger.stopVerdictsForTask(id);
  const submissions = ledger.submissionsForTask(id);
  const submitted = submissions.at(-1);
  const signoffs = ledger.signoffsForTask(id);
  const closure = ledger.closureForTask(id);
  const record = (submitted === undefined ? undefined : signoffs.find((r) => r.id === submitted.signoffId)) ?? signoffs.at(-1);
  if (record !== undefined && !(closure !== undefined && Date.parse(closure.ts) > Date.parse(record.ts))) {
    const earlier = record.id === submitted?.signoffId ? submissions.length - 1 : 0;
    const signed = { by: record.signer, at: record.ts, earlier };
    const newWork = submitted !== undefined && record.id === submitted.signoffId && workSinceSignoff(ledger, id, submitted, verdicts);
    return { standing: newWork ? "reviewed" : "signed", signed, newWork };
  }
  if (closure !== undefined) return { standing: "expired" };
  // Marked the way the index counts it: each stop's latest verdict (a moved file's under its new id), "not reviewed" being unmarked.
  const into = movedInto(ledger.fileStatesForTask(id));
  const latest = new Map<string, string>();
  for (const v of verdicts) latest.set(into.get(v.stopId) ?? v.stopId, v.status);
  return { standing: [...latest.values()].some((v) => v === "passed" || v === "failed") ? "reviewed" : "unreviewed" };
}

/** GET /: the home. Every listed session is one row, newest first (its standing a glyph unless it is the default). */
export function homePage(ledger: Ledger, token: string, titleRoots?: TitleRoots, tracked: readonly Tracking[] = []): string {
  const listed = listedReviewTasks(ledger);
  const sessions = listed.map((t): HomeSession => ({ id: t.id, ts: t.ts, ...standingOf(ledger, t.id) }));
  // A session whose tracking is on but that has no listed task yet (nothing recorded) is told on the home page. Only a switched-on session counts, so an untracked one is never a phantom.
  const seen = new Set(listed.map((t) => sessionOfClient(ledger.taskClient(t.id))));
  const started = tracked.filter((t) => !seen.has(t.session)).map((t): StartedSession => ({ host: t.host, ...(t.folder === undefined ? {} : { folder: t.folder }) }));
  return renderHome(ledger, token, sessions, titleRoots, started);
}

/** The tasks the index lists: those with any recorded review activity, each with its newest activity. */
export function listedReviewTasks(ledger: Ledger): Array<{ id: number; ts: string }> {
  const out: Array<{ id: number; ts: string }> = [];
  for (const id of ledger.allTaskIds()) {
    if (ledger.fileStatesForTask(id).length === 0 && ledger.stopVerdictsForTask(id).length === 0 && ledger.submissionsForTask(id).length === 0 && ledger.signoffsForTask(id).length === 0 && ledger.roundsForTask(id).length === 0) continue;
    out.push({ id, ts: ledger.lastActivity(id) ?? "" });
  }
  return out;
}

/**
 * Starts the review HTTP server on an ephemeral 127.0.0.1 port, serving `ledger` and guarded by
 * `token`. Resolves once it is listening.
 */
export function startReviewServer(
  ledger: Ledger,
  token: string,
  home: string,
  preferredPort = 0,
  onShutdown?: () => void,
  options: { /** No effect (nothing is rendered); kept so existing callers compile. */ previewRenderer?: (file: string, outDir: string) => Promise<string | null>; layers?: FormatLayer[]; quickLook?: boolean; transcriptsRoot?: string; pathKit?: () => PathKit; titleRoots?: TitleRoots; connectorTimeoutMs?: number } = {},
): Promise<{ server: http.Server; port: number; viewPort: number }> {
  const homeId = reviewHomeId(home);
  const expected = Buffer.from(token);
  const timeline: TimelineDeps = {
    layers: options.layers ?? defaultLayers(),
    ...(options.quickLook === undefined ? {} : { quickLook: options.quickLook }),
    transcriptsRoot: options.transcriptsRoot ?? defaultTranscriptsRoot(),
    ...(options.connectorTimeoutMs === undefined ? {} : { connectorTimeoutMs: options.connectorTimeoutMs }),
    cache: new Map(),
    ...(options.pathKit === undefined ? {} : { pathKit: options.pathKit }),
    ...(options.titleRoots === undefined ? {} : { titleRoots: options.titleRoots }),
  };
  return new Promise((resolve, reject) => {
    let port = 0;
    const pool = createConnectorPool();
    const server = http.createServer((req, res) => {
      if (wantsPage(req)) pageLoads.set(res, String(req.url ?? "/").split(/[?#]/)[0]!);
      handle(ledger, timeline, home, expected, req, res, port, homeId, onShutdown, pool).catch((error: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: ownProse(error instanceof Error ? error.message : String(error)) });
        }
      });
    });
    server.on("close", () => void pool.stopAll().catch(() => {}));
    const listen = (wanted: number) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        // The install's recorded port is taken: any free port will do for this run.
        if (wanted !== 0 && error.code === "EADDRINUSE") {
          listen(0);
        } else {
          reject(error);
        }
      });
      server.listen(wanted, "127.0.0.1", () => {
        server.removeAllListeners("error");
        port = (server.address() as AddressInfo).port;
        // The second loopback origin for sandboxed connector views; it closes with the main listener.
        startViewServer().then((view) => {
          setActiveViewServer(view);
          server.once("close", () => { view.server.close(); if (activeViewServer() === view) setActiveViewServer(undefined); });
          resolve({ server, port, viewPort: view.port });
        }, reject);
      });
    };
    listen(preferredPort);
  });
}

/** Why the hook cannot record, from the launcher's `<home>/not-recording.txt` (a time line, then the reason), or undefined when it can. */
export function notRecordingReason(home: string): string | undefined {
  try {
    const reason = readFileSync(path.join(home, "not-recording.txt"), "utf8").split("\n").slice(1).join(" ").trim().slice(0, 400);
    return reason === "" ? undefined : reason;
  } catch {
    return undefined;
  }
}

/** The recorded state of the live review process: `<home>/review-server.json`. */
export function portFilePath(home: string): string {
  return path.join(home, "review-server.json");
}

/** The review process's liveness note: `<home>/review-process-heartbeat.json`, refreshed every few seconds while it runs. */
export function heartbeatFilePath(home: string): string {
  return path.join(home, "review-process-heartbeat.json");
}

/** A heartbeat older than this does not count (it also guards against a recycled pid). */
export const HEARTBEAT_MAX_AGE_MS = 15_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;

export interface Heartbeat {
  pid: number;
  home: string;
  port: number;
  at: number;
}

function canonicalHome(home: string): string {
  try {
    return realpathSync(home);
  } catch {
    return path.resolve(home);
  }
}

/** Writes the heartbeat atomically (temp file, then rename). */
export function writeHeartbeat(home: string, port: number, pid: number = process.pid, now: number = Date.now()): void {
  const file = heartbeatFilePath(home);
  const record: Heartbeat = { pid, home: canonicalHome(home), port, at: now };
  writeFileAtomicSync(file, JSON.stringify(record), pid);
}

export function readHeartbeat(home: string): Heartbeat | undefined {
  try {
    const p = JSON.parse(readFileSync(heartbeatFilePath(home), "utf8")) as Partial<Heartbeat>;
    return Number.isInteger(p.pid) && Number.isInteger(p.port) && typeof p.home === "string" && typeof p.at === "number" ? (p as Heartbeat) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when a fresh heartbeat names this home and `recorded`'s pid and port, and that pid is alive by signal 0
 * (ok or EPERM; ESRCH is dead). Needs no `ps` and no network, so it works inside a sandbox that blocks both.
 */
export function heartbeatShowsLive(home: string, recorded: PortRecord, now: number = Date.now()): boolean {
  const beat = readHeartbeat(home);
  if (!beat || beat.pid !== recorded.pid || beat.port !== recorded.port || beat.home !== canonicalHome(home)) {
    return false;
  }
  const age = now - beat.at;
  if (age < -HEARTBEAT_MAX_AGE_MS || age >= HEARTBEAT_MAX_AGE_MS) {
    return false;
  }
  try {
    process.kill(recorded.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The port chosen once per install and reused by every later review process, so the URL survives a restart. */
export function preferredPortFilePath(home: string): string {
  return path.join(home, "review-port");
}

export function readPreferredPort(home: string): number {
  const n = Number(readFileSync(preferredPortFilePath(home), "utf8").trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
}

/** Identifies a data directory by its realpath, so another install's review process is told apart. */
export function reviewHomeId(home: string): string {
  let real = path.resolve(home);
  try {
    real = realpathSync(home);
  } catch {
    // not created yet
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

export function tokenFilePath(home: string): string {
  return path.join(home, "review-token");
}

export function lockFilePath(home: string): string {
  return path.join(home, "review-server.lock");
}

/** The per-install token, created (mode 0600, 192 random bits) on first use and kept after. */
export function readOrCreateToken(home: string): string {
  mkdirSync(home, { recursive: true });
  const file = tokenFilePath(home);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (existing.length >= 32) {
        return existing;
      }
    } catch {
      // not there yet
    }
    try {
      writeFileSync(file, randomBytes(24).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // Another start is creating it right now; read it on the next pass.
    }
  }
  return readFileSync(file, "utf8").trim();
}

export interface PortRecord {
  pid: number;
  port: number;
}

export function readPortFile(home: string): PortRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(portFilePath(home), "utf8")) as Partial<PortRecord>;
    return Number.isInteger(parsed.pid) && Number.isInteger(parsed.port) ? (parsed as PortRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** The outcome of one /health request: what answered (`health`), or the connection-level error code that stopped it (`errorCode`, e.g. ECONNREFUSED, EPERM; absent for a timeout or a reply that is not this home's). */
export interface HealthProbe {
  health?: { build?: string; builtAt?: number };
  errorCode?: string;
}

/**
 * Error codes of a connect() that a sandbox refused (Codex's macOS sandbox, network restricted): EPERM and EACCES.
 * ASSUMPTION: no recorded Codex error text names the code (platforms/codex has only the policy, network_access false, and a recorded run's
 * "the review process did not start"); macOS Seatbelt denies socket connects with EPERM, EACCES is the other errno a denial may surface as.
 * ECONNREFUSED, timeouts and bad replies are never sandbox signs: a dead or wedged process outside a sandbox gets replaced.
 */
export const SANDBOX_CONNECT_ERRORS: ReadonlySet<string> = new Set(["EPERM", "EACCES"]);

/** Asks 127.0.0.1:`port`'s /health whether a review server for `home` is there, keeping the connection error code. */
export function reviewHealthProbe(port: number, home: string, timeoutMs = 1000): Promise<HealthProbe> {
  const homeId = reviewHomeId(home);
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/health", headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const ok = res.statusCode === 200 && parsed.cocheck === "review" && parsed.home === homeId;
            resolve(ok ? { health: { build: typeof parsed.build === "string" ? parsed.build : undefined, builtAt: typeof parsed.builtAt === "number" ? parsed.builtAt : undefined } } : {});
          } catch {
            resolve({});
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", (err) => resolve({ errorCode: (err as NodeJS.ErrnoException).code }));
  });
}

/** What a review server serving `home` answers on 127.0.0.1:`port`'s /health (a field it does not report is undefined), or undefined if nothing CoCheck's for `home` does. */
export async function reviewHealth(port: number, home: string, timeoutMs = 1000): Promise<{ build?: string; builtAt?: number } | undefined> {
  return (await reviewHealthProbe(port, home, timeoutMs)).health;
}

/** True when the review server serving `home` answers a health request on 127.0.0.1:`port`. */
export async function reviewHealthy(port: number, home: string, timeoutMs = 1000): Promise<boolean> {
  return (await reviewHealth(port, home, timeoutMs)) !== undefined;
}

/** Review processes this process spawned (tests stop them; the gateway never does). */
const spawned = new Set<ChildProcess>();

/** The review process's stderr log under the data directory. */
export function reviewLogPath(home: string): string {
  return path.join(home, "review.log");
}

/** A log past this size is moved to `review.log.1` (replacing the last one) before the next append. */
const MAX_REVIEW_LOG_BYTES = 1024 * 1024;

/** Opens `review.log` for appending, rotating it first when it has grown past `maxBytes`. */
function openReviewLog(home: string, maxBytes = MAX_REVIEW_LOG_BYTES): number {
  mkdirSync(home, { recursive: true });
  const file = reviewLogPath(home);
  try {
    if (statSync(file).size > maxBytes) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    // no log yet
  }
  return openSync(file, "a", 0o600);
}

/** Appends `text` to `review.log`, rotating first when the log is past the cap (checked before every append). */
export function appendReviewLog(home: string, text: string | Uint8Array, maxBytes = MAX_REVIEW_LOG_BYTES): void {
  const fd = openReviewLog(home, maxBytes);
  try {
    writeSync(fd, Buffer.from(text));
  } finally {
    closeSync(fd);
  }
}

/**
 * Makes `stream.write` (the review process's stderr) append through the size-checked writer, so the
 * log rotates during the process's life. The inherited file descriptor only covers output before this runs.
 */
export function installReviewLogWriter(stream: { write: (chunk: string | Uint8Array) => boolean }, home: string, maxBytes = MAX_REVIEW_LOG_BYTES): void {
  stream.write = (chunk: string | Uint8Array): boolean => {
    try {
      appendReviewLog(home, chunk, maxBytes);
    } catch {
      // logging must never take the server down
    }
    return true;
  };
}

/** Appends one timestamped line to `review.log`. */
function logReview(home: string, line: string): void {
  appendReviewLog(home, `${new Date().toISOString()} ${line}\n`);
}

/** The argument a review process carries on win32, where its environment cannot be read: its home, last on the command line. */
export const REVIEW_HOME_ARG = "--cocheck-home=";

/** The arguments after the entry script that start the review process for `home`: none on darwin (the home travels in the environment), the home argument on win32. */
export function reviewProcessArgs(entry: string, home: string, plat: Platform = platform()): string[] {
  return plat.process.homeIdentity === "argument" ? [entry, `${REVIEW_HOME_ARG}${home}`] : [entry];
}

/** True when `pid`'s command line is a review process (never signal a pid recycled by something else). */
export function isReviewProcessPid(pid: number, plat: Platform = platform()): boolean {
  try {
    return /review-process\b/.test(plat.process.commandLine(pid) ?? "");
  } catch {
    return false;
  }
}

/**
 * True when `pid` is a review process serving `home`: its command line shows a review process and its home matches. On darwin the home is its
 * environment (`ps -E`, same user) carrying COCHECK_HOME=`home` exactly; on win32 it is the `--cocheck-home=<home>` argument the command line
 * carries (no other process's environment is read). Needs no network; false when the command line cannot be read.
 */
export function isReviewProcessFor(pid: number, home: string, plat: Platform = platform()): boolean {
  try {
    const byArgument = plat.process.homeIdentity === "argument";
    const line = plat.process.commandLine(pid, { withEnvironment: !byArgument });
    // On win32 the script must be the review-process entry itself, not any argument that merely starts with the word.
    if (line === undefined || !(byArgument ? /[\\/]review-process\.[cm]?[jt]s\b/ : /review-process\b/).test(line)) {
      return false;
    }
    const homes = new Set([home, path.resolve(home)]);
    try {
      homes.add(realpathSync(home));
    } catch {
      // no such directory yet
    }
    if (byArgument) {
      // The home argument is last; the OS may quote it (`"--cocheck-home=C:\\a b"`), so it must end the line or the quote.
      const trimmed = line.trimEnd();
      return [...homes].some((h) => trimmed.endsWith(`${REVIEW_HOME_ARG}${h}`) || trimmed.endsWith(`${REVIEW_HOME_ARG}${h}"`));
    }
    // `ps -E` joins the environment with spaces, so a home with spaces is ambiguous: the value must end the line or be followed by the next KEY= token.
    return [...homes].some((h) => {
      const at = line.indexOf(`COCHECK_HOME=${h}`);
      if (at < 0 || (at > 0 && line[at - 1] !== " ")) {
        return false;
      }
      return /^(\s*$| [A-Za-z_][A-Za-z0-9_]*=)/.test(line.slice(at + `COCHECK_HOME=${h}`.length));
    });
  } catch {
    return false;
  }
}

function postShutdown(port: number, token: string): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: `/shutdown?t=${encodeURIComponent(token)}`, method: "POST", headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }, timeout: 1000 },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve());
    req.end();
  });
}

async function waitUntilGone(home: string, port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await reviewHealthy(port, home))) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Stops the live review process `recorded` (it answered /health for `home` with another build): asks it
 * with the token-guarded POST /shutdown, and if it does not go
 * sends SIGTERM to the port file's pid once its command line shows a review process. Only ever
 * called for a listener that already proved it is this home's review server. Logs the replacement;
 * true once the port is free, false if it would not stop (the old one then keeps serving).
 */
async function retireOutdated(home: string, recorded: PortRecord, oldBuild: string | undefined, selfBuild: string = BUILD_IDENTITY): Promise<boolean> {
  logReview(home, `cocheck review: replacing pid ${recorded.pid} (build ${oldBuild ?? "unknown"}) on port ${recorded.port} with build ${selfBuild}`);
  await postShutdown(recorded.port, readOrCreateToken(home));
  if (await waitUntilGone(home, recorded.port, 2000)) {
    logReview(home, `cocheck review: pid ${recorded.pid} stopped through /shutdown`);
    return true;
  }
  if (isReviewProcessPid(recorded.pid)) {
    logReview(home, `cocheck review: pid ${recorded.pid} needed SIGTERM`);
    try {
      process.kill(recorded.pid, "SIGTERM");
    } catch {
      // already gone
    }
    if (await waitUntilGone(home, recorded.port, 5000)) {
      return true;
    }
  }
  logReview(home, `cocheck review: outdated pid ${recorded.pid} on port ${recorded.port} would not stop; keeping it`);
  return false;
}

/**
 * Makes sure a review process is serving `home`'s ledger: checks the recorded port with a health
 * request and, if nothing answers, spawns `review-process` detached (stdout ignored, stderr appended
 * to `review.log`, unref'd) so it outlives this process. A recorded process that does not answer in time but whose heartbeat is fresh is
 * busy, not gone: it is waited for, never doubled. Resolves its port.
 */
export async function ensureReviewProcess(
  home: string,
  timeoutMs = Number(process.env.COCHECK_REVIEW_START_TIMEOUT_MS) || 8000,
  self: BuildInfo = { build: BUILD_IDENTITY, builtAt: BUILD_TIME },
  probe: typeof reviewHealthProbe = reviewHealthProbe,
): Promise<number> {
  const recorded = readPortFile(home);
  let { health, errorCode } = recorded ? await probe(recorded.port, home) : ({} as HealthProbe);
  if (recorded && !health && errorCode === undefined && heartbeatShowsLive(home, recorded)) {
    // No answer in time, but its heartbeat is fresh: the recorded process is alive and busy (a Windows Office drawing can hold it past the
    // probe's second), not gone. Wait for it rather than start a second one beside it; only a heartbeat that goes stale (a wedged or dead
    // process) lets a new one start.
    const deadline = Date.now() + timeoutMs;
    while (!health && errorCode === undefined && Date.now() < deadline && heartbeatShowsLive(home, recorded)) {
      await new Promise((r) => setTimeout(r, 100));
      ({ health, errorCode } = await probe(recorded.port, home));
    }
    if (!health && errorCode === undefined && heartbeatShowsLive(home, recorded)) {
      return recorded.port;
    }
  }
  if (recorded && health) {
    // Only a build made strictly later replaces the one serving (built-later, not last-touched); an earlier-built caller uses what is running.
    if (!shouldReplaceReview(health, self)) {
      return recorded.port;
    }
    if (!(await retireOutdated(home, recorded, health.build, self.build))) {
      return recorded.port;
    }
  } else if (recorded && errorCode !== undefined && SANDBOX_CONNECT_ERRORS.has(errorCode) && (heartbeatShowsLive(home, recorded) || isReviewProcessFor(recorded.pid, home))) {
    // Only a connect the sandbox refused (EPERM/EACCES) lands here, never a refusal, timeout or bad reply, so a dead or wedged process outside a sandbox is still replaced.
    // The recorded pid is still a live review process (a fresh heartbeat naming this home and port with a pid that answers signal 0, or, where ps runs, its command line and COCHECK_HOME show it, so a recycled pid or another home's process does not count), so it is serving: never start a second one beside it.
    return recorded.port;
  }
  const ext = path.extname(fileURLToPath(import.meta.url));
  const entry = fileURLToPath(new URL(`./review-process${ext}`, import.meta.url));
  // The process is detached with no terminal, so its stderr (a skipped sweep, a fatal error) goes to
  // an append-only log in the data directory.
  const log = openReviewLog(home);
  const child = spawn(process.execPath, reviewProcessArgs(entry, home), {
    detached: true,
    stdio: ["ignore", "ignore", log],
    env: { ...process.env, COCHECK_HOME: home },
    ...detachedCwd(home), // Windows: never the caller's folder, which it would keep from being removed
  });
  closeSync(log);
  child.unref();
  spawned.add(child);
  child.once("exit", () => spawned.delete(child));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = readPortFile(home);
    if (now && (await reviewHealthy(now.port, home))) {
      return now.port;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the review process did not start");
}

/** The shell command that starts the review process for `home` by hand. */
export function reviewProcessCommand(home: string): string {
  const ext = path.extname(fileURLToPath(import.meta.url));
  const entry = fileURLToPath(new URL(`./review-process${ext}`, import.meta.url));
  const quote = (v: string) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  return `COCHECK_HOME=${quote(home)} node ${quote(entry)}`;
}

/** The page URL for `taskId` on the review process serving `home`, starting it if needed. */
export async function openReviewUrl(home: string, taskId: number): Promise<string> {
  const port = await ensureReviewProcess(home);
  return `http://127.0.0.1:${port}/timeline/${taskId}/review?t=${readOrCreateToken(home)}`;
}

/** The index page URL (`node scripts/review.ts open` with no task). */
export async function reviewIndexUrl(home: string): Promise<string> {
  const port = await ensureReviewProcess(home);
  return `http://127.0.0.1:${port}/?t=${readOrCreateToken(home)}`;
}

/** The task `cocheck open` with no id lands on for a process running in `cwd`, or why the list page is shown instead. */
export function pickOpenChoice(home: string, cwd: string, env: NodeJS.ProcessEnv, now: number = Date.now()): OpenChoice {
  const ledger = openLedger(home);
  try {
    const tasks = listedReviewTasks(ledger).map((t) => ({ ...t, client: ledger.taskClient(t.id) }));
    return chooseOpenTask(tasks, cwd, env, readOpenRecords(home), now);
  } finally {
    ledger.close();
  }
}
