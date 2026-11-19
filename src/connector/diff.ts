// The production connectorDiff: what a connector says about one changed state of its subject, for the loader.
// One call: the installed manifest (through readInstalledManifests), the two stored states decrypted into a private temp folder, the connector's warm
// process asked once, the answer checked with checkChanges. Any failure throws; the loader turns a throw into an `unavailable` DiffObject.
// Attribution is never read from the answer: credit is CoCheck's own record of which call wrote the file.
// One warm process per connector serves many diffs, for built-in and installed connectors alike (spec: a connector process may
// answer many diffs and must answer each from its inputs only). Calls to one process run one at a time, so each deadline bounds its own call. A call that
// hits its deadline fails and is not retried; that process is ended and the next call starts a new one. Only a process that died before answering (it
// exited, or its input closed: EPIPE), with no deadline, is retried once, on a new process. A process idle for WARM_IDLE_MS is stopped, and every warm
// process is ended when CoCheck's own process exits; neither keeps CoCheck running. The hook never runs this (captures stay in the review process).
// A warm process is reused only while everything that fixed it at spawn is unchanged (warmKeyOf). A changed key gets a new process,
// and the old one is stopped once its in-flight calls end.
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSealed } from "../seal.ts";
import { storeDirOf } from "../states.ts";
import type { DiffObject } from "./diff-object.ts";
import { connectorArgv, connectorById } from "./builtins.ts";
import { startConnector, type ConnectorHandle } from "./runner.ts";
import { connectorEnv, platform, type Platform } from "../platform/index.ts";
import { checkChanges } from "./changes-v1.ts";
import { docToChanges } from "./row-doc.ts";
import { drawnLevel, levelOfDoc } from "./doc-level.ts";
import { diffMsOf, permittedEnvOf } from "./schema.ts";

/** A DiffObject that also carries the connector's cocheck.changes/1 answer, when it sent one (after-snapshot freezes it; the loader never sees this field). */
export type ConnectorDiffResult = DiffObject & { v1doc: Record<string, unknown>; /** The level the document is drawn at: the connector's hello level, capped by what the document holds. */ v1level?: 1 | 2 | 3; /** The connector's hello declared `nothingChanged: true`, so its empty list means "saved again, nothing changed". */ v1nothingChanged?: true };

/**
 * The document a capture freezes for a diff answer: a v1 document with CoCheck's own `source` envelope (who answered, the drawn level, and whether the
 * connector's hello opted into the nothing-changed rule; a `source` the connector wrote is replaced). An envelope without
 * `nothingChanged` (every document frozen before the opt-in existed) never gets the nothing-changed line.
 */
export function frozenDocOf(diff: ConnectorDiffResult, connector: string): Record<string, unknown> {
  return { ...diff.v1doc, source: { by: "connector", name: connector, level: diff.v1level ?? levelOfDoc(diff.v1doc), ...(diff.v1nothingChanged === true ? { nothingChanged: true } : {}) } };
}

export interface ConnectorDiffRow { subject: string; connector: string; before: { ref: string | null }; after: { ref: string | null } }
export interface ConnectorDiffOptions {
  home: string;
  taskId: number;
  /** Bounds the start-up and the diff call each (a manifest's `diffMs` replaces it for the call). Default 20 s. */
  timeoutMs?: number;
  /** How long the warm process may sit idle after this call before it is stopped. Default WARM_IDLE_MS. */
  idleMs?: number;
  /** Where connector credentials are read (tests). Defaults to `platform().secretStore`. */
  secretStore?: Pick<Platform["secretStore"], "get">;
}

let serial = 0;

/** How long a warm connector process may sit idle before it is stopped. One timeout, no pool policy. */
export const WARM_IDLE_MS = 60_000;

interface Warm { key: string; slot: string; handle: Promise<ConnectorHandle>; tail: Promise<unknown>; busy: number; idle?: NodeJS.Timeout; stale?: true }
/** Warm processes by key (warmKeyOf). */
const warm = new Map<string, Warm>();
/** The current warm process of each connector manifest path: at most one, so a changed key replaces it rather than leaving it to idle out. */
const slots = new Map<string, Warm>();

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** A file's identity without reading it: device, inode, size, change and modify times in ns. Null when it is not a file. One stat. */
function fileIdentity(file: string): string | null {
  const s = statSync(file, { bigint: true, throwIfNoEntry: false });
  return s?.isFile() === true ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : null;
}

/**
 * The identity of everything that fixes a connector process at spawn, as one sha256: the connector id, the manifest's path, content
 * and file identity, the argv and the identity of every argv element that is a file from the connector folder (the entry script; the interpreter when
 * its path is absolute), the exact environment the child gets, and each credential's value as a sha256 (never in clear). Cost per call: one stat per
 * argv element plus one for the manifest, a hash over a few hundred bytes, and one secret-store read per declared credential (none for a connector
 * without credentials). Files the entry imports are not watched.
 */
function warmKeyOf(id: string, manifestFile: string, manifest: unknown, run: string[], env: Record<string, string>, creds: Array<{ name: string; value: Buffer | null | Error }>): string {
  const dir = path.dirname(manifestFile);
  return sha256(JSON.stringify([
    id, manifestFile, manifest, fileIdentity(manifestFile),
    run, run.map((a) => fileIdentity(path.resolve(dir, a))),
    Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    creds.map((c) => [c.name, c.value === null ? null : c.value instanceof Error ? "unreadable" : sha256(c.value)]),
  ]));
}
// When CoCheck's process exits, every warm process is ended (runner.ts ends every connector child it started that is still running, on Windows
// with its process tree), so a connector that ignores the end of its input is not left running.

function unpool(w: Warm): void {
  if (warm.get(w.key) === w) warm.delete(w.key);
  if (slots.get(w.slot) === w) slots.delete(w.slot);
}

function retire(w: Warm): void {
  unpool(w);
  if (w.idle !== undefined) clearTimeout(w.idle);
  w.handle.then((h) => h.stop(), () => {}).catch(() => {});
}

/** Stops every warm connector process (tests; a review process shutting down). */
export async function stopWarmConnectors(): Promise<void> {
  const all = [...warm.values()];
  for (const w of all) retire(w);
  await Promise.all(all.map((w) => w.handle.then((h) => h.stop(), () => {}).catch(() => {})));
}

/** Takes a replaced process out of the pool at once and stops it when its last queued call ends (at once when it has none). */
function retireWhenDone(w: Warm): void {
  unpool(w);
  w.stale = true;
  if (w.busy === 0) retire(w);
}

function warmFor(slot: string, key: string, start: () => Promise<ConnectorHandle>): Warm {
  const known = warm.get(key);
  if (known !== undefined) return known;
  const prev = slots.get(slot);
  if (prev !== undefined) retireWhenDone(prev);
  const w: Warm = { key, slot, handle: start(), tail: Promise.resolve(), busy: 0 };
  warm.set(key, w);
  slots.set(slot, w);
  w.handle.then(() => {}, () => unpool(w));
  return w;
}

/** Runs `job` on the warm process after every job already queued on it; the idle clock starts when the last one ends. */
function queued<T>(w: Warm, idleMs: number, job: () => Promise<T>): Promise<T> {
  w.busy++;
  if (w.idle !== undefined) { clearTimeout(w.idle); w.idle = undefined; }
  const run = w.tail.then(job, job);
  w.tail = run.catch(() => {});
  const done = (): void => {
    if (--w.busy > 0) return;
    if (w.stale === true) { retire(w); return; }
    if (warm.get(w.key) !== w) return;
    w.idle = setTimeout(() => retire(w), idleMs);
    w.idle.unref();
  };
  run.then(done, done);
  return run;
}

const DIED = Symbol("died before answering");
const GONE = Symbol("dead while idle");

/** The connector as a whole is unusable (not installed, no runnable entry, could not start, hello or call timed out, credential unreadable). The review body stops asking it for the rest of the build. Every other throw is that row's own. */
export class ConnectorDownError extends Error {
  constructor(message: string) { super(message); this.name = "ConnectorDownError"; }
}

const down = <T>(f: () => T): T => {
  try { return f(); } catch (e) { throw e instanceof ConnectorDownError ? e : new ConnectorDownError((e as Error).message); }
};

/** A `LoadOptions.connectorDiff` for one task in one CoCheck home. */
export function createConnectorDiff(opts: ConnectorDiffOptions): (row: ConnectorDiffRow) => Promise<ConnectorDiffResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const idleMs = opts.idleMs ?? WARM_IDLE_MS;
  return async (row): Promise<ConnectorDiffResult> => {
    const installed = connectorById(opts.home, row.connector);
    if (installed === undefined) throw new ConnectorDownError(`the connector '${row.connector}' is not installed`);
    const manifest = installed.manifest as unknown as { run?: unknown; credentials?: Array<{ name: string }> };
    const run = down(() => connectorArgv(installed));
    // The manifest's diffMs bounds the diff call; start-up keeps the caller's bound.
    const callMs = diffMsOf(installed.manifest) ?? timeoutMs;
    // The states live in a private temp folder under the subject's own base name, so a connector that reads the name sees the file's name.
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-connector-diff-"));
    let handle: ConnectorHandle | undefined;
    let answer: { subject?: unknown; changes?: unknown; caveats?: unknown } = {};
    try {
      const store = storeDirOf(opts.home, opts.taskId);
      const base = path.basename(row.subject) || "state";
      const put = async (side: "before" | "after", ref: string | null): Promise<string> => {
        const sideDir = path.join(dir, side);
        await mkdir(sideDir, { mode: 0o700 });
        const file = path.join(sideDir, base);
        // A side that does not exist (a new or a removed subject) is an empty file.
        await writeFile(file, ref === null ? Buffer.alloc(0) : await readSealed(path.join(store, ref)), { mode: 0o600 });
        return file;
      };
      const before = await put("before", row.before.ref);
      const after = await put("after", row.after.ref);
      // Each credential is read once per call for the key; a new process is started with the values the key was built from.
      const service = `cocheck-connector:${row.connector}`;
      const specs = manifest.credentials ?? [];
      const secrets = specs.length === 0 ? undefined : (opts.secretStore ?? platform().secretStore);
      const creds = specs.map((c) => { try { return { name: c.name, value: secrets!.get(service, c.name) }; } catch (e) { return { name: c.name, value: e as Error }; } });
      const key = warmKeyOf(row.connector, installed.file, installed.manifest, run, connectorEnv(process.env, permittedEnvOf(installed.manifest)), creds);
      const readOnce: Pick<Platform["secretStore"], "get"> | undefined = secrets === undefined ? undefined : {
        get: (svc, account) => {
          const c = svc === service ? creds.find((x) => x.name === account) : undefined;
          // An unreadable credential is asked again, so the runner reports the store's own refusal.
          return c !== undefined && !(c.value instanceof Error) ? c.value : secrets.get(svc, account);
        },
      };
      const start = (): Promise<ConnectorHandle> => startConnector({
        dir: path.dirname(installed.file),
        run,
        // A unique key per process: a replaced process is never handed back by the runner.
        id: `${row.connector}#warm-${process.pid}-${++serial}`,
        helloTimeoutMs: Math.max(1, timeoutMs),
        envNames: permittedEnvOf(installed.manifest),
        credentials: specs.map((c) => ({ name: c.name, service })),
        unref: true,
        ...(readOnce === undefined ? {} : { secretStore: readOnce }),
      });
      const ask = (w: Warm): Promise<typeof GONE | typeof DIED | { answer: unknown; h: ConnectorHandle }> => queued(w, idleMs, async () => {
        let h: ConnectorHandle;
        try { h = await w.handle; } catch (e) { throw new ConnectorDownError((e as Error).message); }
        // A process that died while idle never saw this call: it is replaced without counting as a retry.
        if (h.alive?.() === false) { retire(w); return GONE; }
        try {
          return { answer: await h.call("diff", { before, after }, { timeoutMs: callMs }), h };
        } catch (e) {
          const m = (e as Error).message;
          // An error reply is this row's; the process answered and stays.
          if (/answered with an error/.test(m)) throw e;
          // Anything else leaves the process unusable: it is ended, and the next call starts a new one.
          retire(w);
          // A call that hit its deadline means the connector hangs: recorded as failed, never retried.
          if (/call "[^"]*" timed out after/.test(m)) throw new ConnectorDownError(m);
          // Died before answering (exited, or its input closed: EPIPE): retried once.
          if (/ exited\b| closed its input/.test(m)) { lastDeath = e as Error; return DIED; }
          throw e;
        }
      });
      let lastDeath: Error | undefined;
      let retried = false;
      let replacedIdle = false;
      for (;;) {
        const got = await ask(warmFor(installed.file, key, start));
        if (got === GONE && !replacedIdle) { replacedIdle = true; continue; }
        if (got === GONE) lastDeath = new Error(`connector ${row.connector} exited before it was asked`);
        if (got === GONE || got === DIED) { if (retried) throw lastDeath!; retried = true; continue; }
        answer = got.answer as typeof answer;
        handle = got.h;
        break;
      }
      // The answer must be a cocheck.changes/1 document, checked at the level the connector declared in hello (its document may be that level or lower).
      const bad = checkChanges(answer, ((l) => (l === 1 || l === 2 || l === 3 ? l : 3))(handle.hello["level"]));
      if (bad.length > 0) throw new Error(`its answer was rejected: ${bad[0]!.field || "answer"} ${bad[0]!.fix}`);
      const declared = handle.hello["level"];
      const lv = levelOfDoc(answer);
      if ((declared === 1 || declared === 2 || declared === 3) && lv > declared) throw new Error(`its answer was rejected: level it declared level ${declared} in hello but answered a level ${lv} document`);
      const doc = answer as unknown as Record<string, unknown>;
      return {
        spec: "cocheck.diff/1", subject: row.subject, connector: row.connector, producer: "connector", before: row.before, after: row.after,
        changes: docToChanges(doc), caveats: Array.isArray(doc.caveats) ? (doc.caveats as unknown[]).filter((c): c is string => typeof c === "string") : [], v1doc: doc, v1level: drawnLevel(doc, declared), ...(handle.hello["nothingChanged"] === true ? { v1nothingChanged: true as const } : {}),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
