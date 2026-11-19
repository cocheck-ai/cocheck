// The review process's side of a before-snapshot. A pool of connector processes (at most one per connector id,
// reused across requests, replaced when dead, all stopped on shutdown) and `beforeSnapshot`, which asks the connector that covers a subject for its
// state, seals the bytes for the task and returns the ref. A ref is only returned for bytes already sealed. Every wait is under the caller's budget.
import path from "node:path";
import { existsSync } from "node:fs";
import { readSealed, sha256Hex, writeSealed } from "../seal.ts";
import { ensureStoreDir, storeDirOf } from "../states.ts";
import { readInstalledManifests, type InstalledManifest } from "./installed-manifests.ts";
import { connectorForSubject } from "./installed-match.ts";
import { ownNode, requireRun } from "./run-argv.ts";
import { startConnector, type ConnectorHandle } from "./runner.ts";
import { redactSecrets } from "../secret-scan.ts";
import { checkExportAnswer, checkSnapshotAnswer, EXPORT_METHOD, permittedEnvOf } from "./schema.ts";

/** The home-level sealed store of connector states, content-addressed by the sha256 of the UTF-8 bytes. */
export const connectorStatesDir = (home: string): string => path.join(home, "connector-states");

/** Places a sealed connector state into a task's store under the same ref. Idempotent. Throws when `ref` is not a sha256 or is not in connector-states. */
export async function adoptConnectorState(home: string, taskId: number, ref: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(ref)) throw new Error("not a connector state ref");
  const from = path.join(connectorStatesDir(home), ref);
  if (!existsSync(from)) throw new Error("no such connector state");
  const to = path.join(storeDirOf(home, taskId), ref);
  if (existsSync(to)) return;
  await ensureStoreDir(home, taskId);
  await writeSealed(to, await readSealed(from));
}

export class SnapshotError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const schemeOf = (s: string): string | undefined => /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1]?.toLowerCase();

/** The installed connector covering `subject`: the one winner by the stated order (installed-match.ts: subject template, then schemes, then extensions by longest suffix, then first folder). */
export function installedConnectorFor(home: string, subject: string, tool?: string): InstalledManifest | undefined {
  return connectorForSubject(readInstalledManifests(home), subject, tool);
}

export interface ConnectorPool {
  /** The pooled process for `id`, started if there is none or the previous one died. `startedNow` is true for a process this call started. */
  get(id: string, start: () => Promise<ConnectorHandle>): Promise<{ handle: ConnectorHandle; startedNow: boolean }>;
  evict(id: string, handle: ConnectorHandle): Promise<void>;
  stopAll(): Promise<void>;
  readonly size: number;
}

export function createConnectorPool(): ConnectorPool {
  const live = new Map<string, Promise<ConnectorHandle>>();
  let closed = false;
  return {
    get size() {
      return live.size;
    },
    async get(id, start) {
      if (closed) throw new SnapshotError(503, "the review process is shutting down");
      let p = live.get(id);
      const startedNow = p === undefined;
      if (p === undefined) {
        p = start();
        live.set(id, p);
        p.then(
          (h) => {
            if (closed) void h.stop().catch(() => {});
          },
          () => {
            if (live.get(id) === p) live.delete(id);
          },
        );
      }
      return { handle: await p, startedNow };
    },
    async evict(id, handle) {
      const p = live.get(id);
      if (p !== undefined && (await p.catch(() => undefined)) === handle) live.delete(id);
      await handle.stop().catch(() => {});
    },
    async stopAll() {
      closed = true;
      const all = [...live.values()];
      live.clear();
      await Promise.all(all.map((p) => p.then((h) => h.stop()).catch(() => {})));
    },
  };
}

export interface BeforeSnapshotRequest {
  home: string;
  pool: ConnectorPool;
  subject: string;
  /** The full MCP tool name of the call that reached the subject, when the hook knows it; the winner is decided with it (installed-match.ts `winnerFor`). */
  tool?: string;
  budgetMs: number;
}

const timedOut = (ms: number) => new SnapshotError(504, `the connector did not answer within ${ms} ms`);

/** Seals the connector's state for `subject` into the home-level store (no task needed) and returns its ref (sha256 hex of the UTF-8 bytes), or null when the entity does not exist. Throws SnapshotError. */
export async function beforeSnapshot(req: BeforeSnapshotRequest): Promise<{ ref: string | null }> {
  const { home, subject, budgetMs } = req;
  const deadline = Date.now() + budgetMs;
  const installed = installedConnectorFor(home, subject, req.tool);
  if (installed === undefined) throw new SnapshotError(404, "no installed connector covers this subject");
  // A diff-entry connector has no snapshot to give; asking would fail and evict its pooled process.
  if ((installed.manifest as { entry?: string }).entry === "diff") throw new SnapshotError(409, "this connector's entry is diff: it has no snapshot");
  // An export connector (entry "export") is asked for `export` and answers { text }; the text is the state, drawn later by CoCheck's own text renderer.
  const isExport = (installed.manifest as { entry?: string }).entry === "export";
  const answer = isExport ? await askConnector({ ...req, method: EXPORT_METHOD, params: { subject } }) : await askConnector({ ...req, method: "snapshot", params: { subject } });
  const problems = isExport ? checkExportAnswer(answer) : checkSnapshotAnswer(answer);
  if (problems.length > 0) throw new SnapshotError(502, `the connector's answer was rejected: ${problems[0]!.field || "answer"} ${problems[0]!.fix}`);
  const state = isExport ? (answer as { text: string | null })["text"] : (answer as { state: string | null }).state;
  if (state === null) return { ref: null };
  // The state is secret-scanned before it is sealed; what is stored (and hashed) is the redacted text.
  const bytes = Buffer.from(redactSecrets(state), "utf8");
  const ref = sha256Hex(bytes);
  if (deadline - Date.now() <= 0) throw timedOut(budgetMs);
  await writeSealed(path.join(connectorStatesDir(home), ref), bytes);
  return { ref };
}

/** One request to the pooled process of the connector covering `subject`, under the caller's budget. Returns the raw answer. Throws SnapshotError. */
export async function askConnector(req: BeforeSnapshotRequest & { method: string; params: unknown }): Promise<unknown> {
  const { home, pool, subject, budgetMs } = req;
  const deadline = Date.now() + budgetMs;
  const left = (): number => deadline - Date.now();
  const installed = installedConnectorFor(home, subject, req.tool);
  if (installed === undefined) throw new SnapshotError(404, "no installed connector covers this subject");
  const manifest = installed.manifest as unknown as { run?: unknown; credentials?: Array<{ name: string }> };
  const id = installed.manifest.id;
  let run: string[];
  try {
    run = ownNode(requireRun(manifest.run));
  } catch (error) {
    throw new SnapshotError(502, (error as Error).message);
  }
  const start = (): Promise<ConnectorHandle> =>
    startConnector({
      dir: path.dirname(installed.file),
      run,
      id,
      helloTimeoutMs: Math.max(1, left()),
      envNames: permittedEnvOf(installed.manifest),
      credentials: (manifest.credentials ?? []).map((c) => ({ name: c.name, service: `cocheck-connector:${id}` })),
    });

  let timer: NodeJS.Timeout | undefined;
  const work = async (): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      if (left() <= 0) throw timedOut(budgetMs);
      const { handle, startedNow } = await pool.get(id, start);
      try {
        return await handle.call(req.method, req.params, { timeoutMs: Math.max(1, left()) });
      } catch (error) {
        await pool.evict(id, handle);
        // A reused process that died between requests gets one fresh start; a timeout or an answer that was an error does not.
        const m = (error as Error).message;
        const diedIdle = !startedNow && attempt === 0 && /exited|closed its input|was stopped|failed:/.test(m) && !/timed out|answered with an error/.test(m);
        if (!diedIdle) throw error;
      }
    }
  };
  let answer: unknown;
  try {
    const w = work();
    w.catch(() => {});
    answer = await Promise.race([w, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timedOut(budgetMs)), budgetMs); })]);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    const m = (error as Error).message;
    throw new SnapshotError(/timed out/.test(m) ? 504 : 502, `the connector failed: ${m}`);
  } finally {
    clearTimeout(timer);
  }
  return answer;
}
