// The hook's production client of the long-lived review process (`HookRun.localProcess`). Reads the port from `<home>/review-server.json` and the
// token from `<home>/review-token`, posts one before-snapshot request, and gives up at `budgetMs`. A missing file, a closed port or any HTTP error rejects.
// It never starts the server or a connector, and holds no socket past its budget.
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

/** The most the hook waits for the review process to accept a fire-and-forget request (after-snapshot, file capture); it does the work after answering. */
export const AFTER_SNAPSHOT_ACCEPT_MS = 200;

/** Why the review process did not take an after-snapshot request. */
export type AfterNotTakenReason = "not running" | "refused" | "no answer in time";

/** The rejection of `afterSnapshot` when the review process did not take the request; `reason` is the class the page's gap row names. */
export class AfterNotTaken extends Error {
  readonly reason: AfterNotTakenReason;
  constructor(reason: AfterNotTakenReason) {
    super(`the review process did not take the request: ${reason}`);
    this.reason = reason;
    this.name = "AfterNotTaken";
  }
}

export interface LocalProcess {
  /** Resolves `{ ref: null }` only when the review process answered 200 with `ref` exactly null (the connector said the item does not exist); every other answer without a ref rejects. */
  request(req: { kind: "before-snapshot"; subject: string; tool?: string; budgetMs: number}): Promise<{ ref: string | null }>;
  /** Tells the review process to snapshot the subject's after state. Resolves when the process accepted the request (it does the work after answering); rejects with `AfterNotTaken` naming why it did not. */
  afterSnapshot?(req: AfterSnapshotBody & { budgetMs: number }): Promise<void>;
}

export interface AfterSnapshotBody {
  client: string;
  task: number | null;
  call: string;
  /** Absent on a create call of a `matches.calls` tool, whose body carries `response` instead (the review process renders the subject from it). */
  subject?: string;
  /** The tool's answer as the host handed it, on a create call only. */
  response?: unknown;
  /** The hook journal's file stem of the calling session, on a create call only (16 hex characters). */
  journal?: string;
  /** The full MCP tool name of the call (the winner is decided with it). */
  tool?: string;
  before: string | null;
  /** True only when the before side was absent (the connector said the item did not exist); only ever sent with `before: null`. */
  beforeAbsent?: true;
  /** The call's start and end (ISO 8601, the hook journal's times); a diff-entry connector is asked for the window they bound. */
  callStart?: string;
  callEnd?: string;
}

export function httpLocalProcess(home: string): LocalProcess {
  return {
    afterSnapshot: (req) =>
      new Promise((resolve, reject) => {
        let port: number;
        let token: string;
        try {
          port = Number(JSON.parse(readFileSync(path.join(home, "review-server.json"), "utf8")).port);
          token = readFileSync(path.join(home, "review-token"), "utf8").trim();
        } catch {
          return reject(new AfterNotTaken("not running"));
        }
        if (!Number.isInteger(port) || port <= 0 || token === "") return reject(new AfterNotTaken("not running"));
        const { budgetMs, ...fields } = req;
        const body = JSON.stringify(fields);
        let late = false;
        // Every rejection says why the request was not taken. A closed port is no process; our own timer is no answer in time; anything else the process did is a refusal.
        const fail = (e: unknown): void => { clearTimeout(timer); reject(late ? new AfterNotTaken("no answer in time") : new AfterNotTaken((e as NodeJS.ErrnoException)?.code === "ECONNREFUSED" ? "not running" : "refused")); };
        const r = http.request(
          { hostname: "127.0.0.1", port, path: `/connector/after-snapshot?t=${encodeURIComponent(token)}`, method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
          (res) => {
            res.resume();
            res.on("end", () => { clearTimeout(timer); res.statusCode === 202 ? resolve() : reject(new AfterNotTaken("refused")); });
            res.on("error", fail);
          },
        );
        const timer = setTimeout(() => { late = true; r.destroy(new Error("budget passed")); }, budgetMs);
        r.on("error", fail);
        r.end(body);
      }),
    request: (req) =>
      new Promise((resolve, reject) => {
        let port: number;
        let token: string;
        try {
          port = Number(JSON.parse(readFileSync(path.join(home, "review-server.json"), "utf8")).port);
          token = readFileSync(path.join(home, "review-token"), "utf8").trim();
        } catch (error) {
          return reject(error);
        }
        if (!Number.isInteger(port) || port <= 0 || token === "") return reject(new Error("no review process recorded"));
        const body = JSON.stringify({ subject: req.subject, ...(req.tool !== undefined ? { tool: req.tool } : {}), budgetMs: req.budgetMs });
        const r = http.request(
          { hostname: "127.0.0.1", port, path: `/connector/before-snapshot?t=${encodeURIComponent(token)}`, method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("error", (e) => { clearTimeout(timer); reject(e); });
            res.on("end", () => {
              clearTimeout(timer);
              try {
                if (res.statusCode !== 200) return reject(new Error(`review process answered ${res.statusCode}`));
                const answer = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
                const ref = answer !== null && typeof answer === "object" ? (answer as { ref?: unknown }).ref : undefined;
                // A 200 whose ref is exactly null is the connector saying the item does not exist (absent); anything else without a ref is a failure.
                if (ref === null) return resolve({ ref: null });
                typeof ref === "string" && ref !== "" ? resolve({ ref }) : reject(new Error("no ref"));
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        const timer = setTimeout(() => r.destroy(new Error("budget passed")), req.budgetMs);
        r.on("error", (e) => { clearTimeout(timer); reject(e); });
        r.end(body);
      }),
  };
}

/** The recorded port and token of the review process, or undefined when none is recorded. */
function recordedProcess(home: string): { port: number; token: string } | undefined {
  try {
    const port = Number(JSON.parse(readFileSync(path.join(home, "review-server.json"), "utf8")).port);
    const token = readFileSync(path.join(home, "review-token"), "utf8").trim();
    return Number.isInteger(port) && port > 0 && token !== "" ? { port, token } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tells the review process to read the pending file captures of `tasks` (POST /connector/file-capture). Waits at most AFTER_SNAPSHOT_ACCEPT_MS for it
 * to accept; no process, a refusal or the budget are all silent (the rows stay pending and are read when they are next loaded). Never throws, never starts anything.
 */
export function nudgeFileCapture(home: string, tasks: number[], budgetMs = AFTER_SNAPSHOT_ACCEPT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    const rec = recordedProcess(home);
    if (rec === undefined) return resolve();
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => { clearTimeout(timer); resolve(); };
    try {
      const body = JSON.stringify({ tasks });
      const r = http.request(
        { hostname: "127.0.0.1", port: rec.port, path: `/connector/file-capture?t=${encodeURIComponent(rec.token)}`, method: "POST", headers: { host: `127.0.0.1:${rec.port}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
        (res) => { res.resume(); res.on("end", done); res.on("error", done); },
      );
      timer = setTimeout(() => { r.destroy(); resolve(); }, budgetMs);
      r.on("error", done);
      r.end(body);
    } catch {
      done();
    }
  });
}
