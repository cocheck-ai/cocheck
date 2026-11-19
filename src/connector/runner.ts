// The out-of-process connector runner. One long-lived child per connector id, one JSON message per line on
// stdin and stdout (a trailing \r is tolerated), `hello` first. A credential exists only in the `hello` params: never in the child's environment,
// argv, `log()` or any CoCheck output. Every wait on the child has a timeout; a timed-out child is killed, a crashed one is not restarted.
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECTOR_SET_ENV, connectorEnv, mergeEnv, platform, spawnPiped, type Platform } from "../platform/index.ts";

export interface CredentialSpec {
  /** The key the connector finds the value under in `hello` params `credentials`. */
  name: string;
  /** Defaults to `cocheck-connector:<connector id>`. */
  service?: string;
  /** Defaults to `name`. */
  account?: string;
}

export interface StartOptions {
  dir: string;
  /** The manifest argv; relative paths resolve from `dir`. */
  run: string[];
  /** Extra variables the caller sets itself (a test, the conformance run); added after the allow-list. */
  env?: Record<string, string>;
  /** The variable names the manifest's `permissions.env` lists. The child gets these from the process environment plus a fixed base (CONNECTOR_BASE_ENV), and nothing else of it. */
  envNames?: string[];
  credentials?: CredentialSpec[];
  /** Only `get` is called. Defaults to `platform().secretStore`. */
  secretStore?: Pick<Platform["secretStore"], "get">;
  /** The connector id: the service name's suffix and the one-process-per-id key. Defaults to `id` in `cocheck-connector.json` in `dir`. */
  id?: string;
  /** How long `hello` may take. Default 10 s. */
  helloTimeoutMs?: number;
  /** How long stop() waits for the child to exit after terminate before it is killed. Default 3 s. */
  stopGraceMs?: number;
  /** The child and its pipes do not keep CoCheck's process running (a warm process between calls); a pending request's timer still does. */
  unref?: boolean;
}

export interface ConnectorHandle {
  hello: Record<string, unknown>;
  call(method: string, params: unknown, opts: { timeoutMs: number }): Promise<unknown>;
  /** What the connector wrote to stderr and any non-protocol stdout, credential values redacted. */
  log(): string;
  stop(): Promise<void>;
  /** False once the child exited, was stopped, or cannot be asked any more (closed input, a timed-out call). */
  alive?(): boolean;
  /** The child's pid, for ending it when CoCheck's own process exits. */
  pid?: number;
}

const MANIFEST = "cocheck-connector.json";
/**
 * The published helpers (public-kit/helpers/, spec v1 "Helpers"), told to every connector process as COCHECK_HELPERS_DIR. Found from this
 * module, the same relative path from src/connector and dist/connector, so an installed CoCheck names its own installed copy, never a checkout.
 */
export const HELPERS_DIR = fileURLToPath(new URL("../../public-kit/helpers", import.meta.url));
/** Part of the fixed base set (CONNECTOR_SET_ENV): set by CoCheck, never copied from its environment. */
export const HELPERS_ENV: (typeof CONNECTOR_SET_ENV)[number] = "COCHECK_HELPERS_DIR";
const LOG_CAP = 64 * 1024;
const running = new Map<string, Promise<ConnectorHandle>>();

// Every connector child this process started and that has not exited yet: its pid and its stop(). A connector that ignores the end of its input
// (a keep-alive socket, a timer) would otherwise outlive CoCheck, and on Windows a child is never ended with its parent; its open folder (the
// connector folder is its working directory) then cannot be removed. When this process exits, each one still running is ended, on Windows with
// its whole process tree (platform().process.terminate). An exit handler cannot wait, so this is the synchronous terminate only.
const live = new Map<number, { pid: number | undefined; stop: () => Promise<void> }>();
let liveSerial = 0;
let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const c of live.values()) {
      if (c.pid === undefined) continue;
      try {
        platform().process.terminate(c.pid);
      } catch {
        /* already gone */
      }
    }
  });
}

/** Stops every connector process this process started and awaits each exit (a review server shutting down; test teardown before a home is removed). */
export async function stopAllConnectors(): Promise<void> {
  await Promise.all([...live.values()].map((c) => c.stop().catch(() => {})));
}

/** The pids of connector processes this process started that have not exited yet. */
export function liveConnectorPids(): number[] {
  return [...live.values()].flatMap((c) => (c.pid === undefined ? [] : [c.pid]));
}

function manifestId(dir: string): string | undefined {
  try {
    const id = (JSON.parse(readFileSync(path.join(dir, MANIFEST), "utf8")) as { id?: unknown }).id;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

function checkedTimeout(ms: unknown, what: string): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) throw new Error(`${what} needs a positive timeoutMs; an unbounded wait is not allowed`);
  return ms;
}

/** Reads every declared credential before anything is spawned. Rejects naming the credential (never its value) when one is missing or the store fails. */
function readCredentials(options: StartOptions, id: string | undefined, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  const specs = options.credentials ?? [];
  if (specs.length === 0) return out;
  const store = options.secretStore ?? platform().secretStore;
  for (const spec of specs) {
    let service = spec.service;
    if (service === undefined) {
      if (id === undefined) throw new Error(`connector ${label}: credential "${spec.name}" has no service and the connector has no id (pass id, or add one to ${MANIFEST})`);
      service = `cocheck-connector:${id}`;
    }
    const account = spec.account ?? spec.name;
    let value: Buffer | null;
    try {
      value = store.get(service, account);
    } catch (error) {
      throw new Error(`connector ${label}: could not read credential "${spec.name}" from the credential store: ${(error as Error).message}`);
    }
    if (value === null || value.length === 0) throw new Error(`connector ${label}: the credential "${spec.name}" is not stored; it must be set before the connector starts`);
    out[spec.name] = value.toString("utf8");
  }
  return out;
}

export function startConnector(options: StartOptions): Promise<ConnectorHandle> {
  const id = options.id ?? manifestId(options.dir);
  if (id === undefined) return launch(options, undefined);
  const existing = running.get(id);
  if (existing !== undefined) return existing;
  const started = launch(options, id);
  running.set(id, started);
  started.then(
    (h) => void h.hello,
    () => {
      if (running.get(id) === started) running.delete(id);
    },
  );
  return started;
}

async function launch(options: StartOptions, id: string | undefined): Promise<ConnectorHandle> {
  const label = id ?? path.basename(path.resolve(options.dir));
  const credentials = readCredentials(options, id, label);
  const secrets = Object.values(credentials);
  const redact = (text: string): string => secrets.reduce((t, s) => (s === "" ? t : t.split(s).join("[redacted]")), text);

  let child: ChildProcess;
  try {
    child = spawnPiped(options.run, { cwd: options.dir, env: mergeEnv({ ...connectorEnv(process.env, options.envNames ?? []), [HELPERS_ENV]: HELPERS_DIR }, options.env), exactEnv: true });
  } catch (error) {
    throw new Error(`connector ${label}: could not start: ${redact((error as Error).message)}`);
  }
  const pid = child.pid;
  const liveKey = ++liveSerial;
  hookExit();
  if (options.unref === true) {
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr]) (s as unknown as { unref?: () => void } | null)?.unref?.();
  }

  let log = "";
  /**
   * Stream redaction: one per stream. Text is matched together with whatever the stream held back, so a credential split across any chunk
   * boundary is still replaced. A trailing run that could be the start of a credential is held back, out of `log`, until the next write decides it.
   */
  const logStream = (): ((text: string) => void) => {
    let held = "";
    return (text) => {
      const redacted = redact(held + text);
      let keep = 0;
      for (const s of secrets) {
        for (let n = Math.min(s.length - 1, redacted.length); n > keep; n--) {
          if (redacted.endsWith(s.slice(0, n))) {
            keep = n;
            break;
          }
        }
      }
      held = keep > 0 ? redacted.slice(-keep) : "";
      log = (log + redacted.slice(0, redacted.length - keep)).slice(-LOG_CAP);
    };
  };
  const addStderr = logStream();
  const addStdout = logStream();
  let dead: string | undefined;
  let exited = false;
  const exitWaiters: (() => void)[] = [];
  let nextId = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();

  const failAll = (reason: string): void => {
    for (const [key, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(key);
      p.reject(new Error(reason));
    }
  };
  const markDead = (reason: string): void => {
    if (dead === undefined) dead = reason;
    failAll(reason);
  };
  const terminate = (): void => {
    if (exited || pid === undefined) return;
    try {
      platform().process.terminate(pid);
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  };

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => addStderr(chunk));
  child.stdin?.on("error", () => markDead(`connector ${label} closed its input`));
  child.on("error", (error) => {
    markDead(`connector ${label} failed: ${redact(error.message)}`);
    exited = true;
    live.delete(liveKey);
    for (const w of exitWaiters.splice(0)) w();
  });
  child.on("close", (code, signal) => {
    exited = true;
    live.delete(liveKey);
    markDead(`connector ${label} exited${signal !== null ? ` (signal ${signal})` : code !== null ? ` (code ${code})` : ""}`);
    if (id !== undefined) running.delete(id);
    for (const w of exitWaiters.splice(0)) w();
  });

  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.trim() === "") continue;
      let msg: { id?: unknown; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        addStdout(`[stdout] ${line}\n`);
        continue;
      }
      const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
      if (p === undefined) {
        addStdout(`[stdout, unmatched] ${line}\n`);
        continue;
      }
      pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (msg.error !== undefined) {
        const text = typeof msg.error === "string" ? msg.error : typeof (msg.error as { message?: unknown })?.message === "string" ? (msg.error as { message: string }).message : JSON.stringify(msg.error);
        p.reject(new Error(`connector ${label} answered with an error: ${redact(text)}`));
      } else p.resolve(msg.result);
    }
    if (buffer.length > 16 * 1024 * 1024) markDead(`connector ${label} wrote a line over 16 MB`);
  });

  const request = (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
    if (dead !== undefined) return Promise.reject(new Error(dead));
    return new Promise<unknown>((resolve, reject) => {
      const key = nextId++;
      const timer = setTimeout(() => {
        pending.delete(key);
        const reason = `connector ${label}: call "${method}" timed out after ${timeoutMs} ms; the connector was stopped`;
        reject(new Error(reason));
        markDead(reason);
        terminate();
      }, timeoutMs);
      pending.set(key, { resolve, reject, timer });
      const line = JSON.stringify({ id: key, method, params }) + "\n";
      child.stdin?.write(line, (error) => {
        if (error) markDead(`connector ${label} closed its input`);
      });
    });
  };

  const stop = async (): Promise<void> => {
    if (dead === undefined) dead = `connector ${label} was stopped`;
    failAll(dead);
    if (id !== undefined) running.delete(id);
    if (exited) return;
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    terminate();
    const grace = options.stopGraceMs ?? 3000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        const last = setTimeout(resolve, grace);
        last.unref();
        exitWaiters.push(() => {
          clearTimeout(last);
          resolve();
        });
      }, grace);
      exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Its pipes are closed here even when the exit was never seen, so no handle of this process stays open on them.
    for (const s of [child.stdin, child.stdout, child.stderr]) s?.destroy();
  };
  if (!exited) live.set(liveKey, { pid, stop });

  let hello: unknown;
  try {
    hello = await request("hello", Object.keys(credentials).length > 0 ? { credentials } : {}, checkedTimeout(options.helloTimeoutMs ?? 10_000, "hello"));
  } catch (error) {
    await stop();
    throw error;
  }
  if (typeof hello !== "object" || hello === null || Array.isArray(hello)) {
    await stop();
    throw new Error(`connector ${label}: hello did not answer with an object`);
  }

  return {
    hello: hello as Record<string, unknown>,
    call: (method, params, opts) => {
      let ms: number;
      try {
        ms = checkedTimeout(opts?.timeoutMs, `call "${method}"`);
      } catch (error) {
        return Promise.reject(error as Error);
      }
      return request(method, params, ms);
    },
    log: () => log,
    stop,
    alive: () => dead === undefined && !exited,
    ...(pid === undefined ? {} : { pid }),
  };
}
