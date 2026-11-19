import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostPlatform } from "../../platform/index.ts";
import { guard } from "./mac-guard.ts";

/**
 * The Mac half of the Office print route's window list: talks to the native helper (src/office/connector/native/cocheck-screen.m, built to dist/office/connector/helpers/cocheck-screen),
 * which lists an app's windows by pid and nothing else (read-only: it signals, hides, captures and creates nothing, and needs no Screen Recording
 * grant). One helper per job, spoken to in JSON lines.
 *
 * This is behind the same test guard as the Office bridge (mac-guard.ts `guard()`): under the test bootstrap the default binary is never
 * started. A test passes `binary` (a fake script) and never reaches the real helper.
 */

/** `<repo>/dist/office/connector/helpers/cocheck-screen` (scripts/build-helpers.mjs writes it there, release.sh check_helpers checks it); the same relative path from src/office/connector and from dist/office/connector. */
export const SCREEN_HELPER = fileURLToPath(new URL("../../../dist/office/connector/helpers/cocheck-screen", import.meta.url));

export type Answer<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; why: string };

export interface ScreenWindow { id: number; layer: number; bounds: { x: number; y: number; w: number; h: number }; onscreen: boolean; title: string }

/** Per-request time limits in ms. */
export const DEFAULT_TIMEOUTS_MS: Record<string, number> = { windows: 5_000, close: 5_000 };

export interface ScreenHelperOptions {
  /** Helper program (tests pass a fake). Default: the shipped helper, behind the test guard. */
  binary?: string;
  /** The helper exits itself after this long. */
  maxMs: number;
  timeoutsMs?: Record<string, number>;
  /** How long to wait for the helper's first line. */
  startMs?: number;
}

type Pending = { resolve: (a: Answer) => void; timer: NodeJS.Timeout };

export class ScreenHelper {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private ended = false;
  private exitCode: number | null | undefined;
  private readonly exitWaiters: (() => void)[] = [];

  private readonly child: ChildProcess;
  private readonly timeouts: Record<string, number>;

  private constructor(child: ChildProcess, timeouts: Record<string, number>) {
    this.child = child;
    this.timeouts = timeouts;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    child.stdout!.on("error", () => undefined);
    child.stdin!.on("error", () => undefined);
    child.stderr?.on("data", () => undefined);
    child.on("error", () => this.onEnd(null));
    child.on("close", (code) => this.onEnd(code));
  }

  /** Starts the helper and waits for its first line. Null when it cannot start, or does not say it is ready in time. */
  static async start(o: ScreenHelperOptions): Promise<ScreenHelper | null> {
    let binary = o.binary;
    if (binary === undefined) {
      guard();
      binary = SCREEN_HELPER;
    }
    let child: ChildProcess;
    try {
      child = spawn(binary, ["--max-ms", String(Math.max(1000, Math.floor(o.maxMs)))], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return null;
    }
    const h = new ScreenHelper(child, { ...DEFAULT_TIMEOUTS_MS, ...o.timeoutsMs });
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), o.startMs ?? 5_000);
      h.readyWaiter = (ok) => { clearTimeout(timer); resolve(ok); };
      if (h.ended) resolve(false);
    });
    if (!ready) {
      h.kill();
      return null;
    }
    return h;
  }

  private readyWaiter: ((ok: boolean) => void) | undefined;

  get alive(): boolean {
    return !this.ended;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) continue;
        msg = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (msg.ready === true) {
        this.readyWaiter?.(true);
        this.readyWaiter = undefined;
        continue;
      }
      const id = typeof msg.req === "number" ? msg.req : -1;
      const p = this.pending.get(id);
      if (p === undefined) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      const { req: _req, ...rest } = msg;
      p.resolve(rest.ok === true ? (rest as Answer) : { ok: false, why: typeof rest.why === "string" ? rest.why : "the helper refused" });
    }
  }

  private onEnd(code: number | null): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    this.readyWaiter?.(false);
    this.readyWaiter = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, why: "the screen helper ended" });
      this.pending.delete(id);
    }
    for (const w of this.exitWaiters.splice(0)) w();
  }

  /** One request, one answer. A timeout, a dead helper or a closed pipe answers `{ok:false}`; nothing here throws. */
  request(cmd: string, args: Record<string, unknown> = {}): Promise<Answer> {
    if (this.ended) return Promise.resolve({ ok: false, why: "the screen helper ended" });
    const id = this.nextId++;
    return new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, why: `the screen helper did not answer ${cmd} in time` });
      }, this.timeouts[cmd] ?? 10_000);
      this.pending.set(id, { resolve, timer });
      try {
        this.child.stdin!.write(`${JSON.stringify({ ...args, cmd, req: id })}\n`, (err) => {
          if (err && this.pending.delete(id)) {
            clearTimeout(timer);
            resolve({ ok: false, why: "the screen helper could not be written to" });
          }
        });
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, why: "the screen helper could not be written to" });
      }
    });
  }

  windows(pid: number): Promise<Answer<{ windows: ScreenWindow[] }>> {
    return this.request("windows", { pid }) as Promise<Answer<{ windows: ScreenWindow[] }>>;
  }
  /** Ends the helper. Escalates to SIGKILL of the helper itself (our own child) if it does not leave. */
  async close(graceMs = 4_000): Promise<void> {
    if (!this.ended) await this.request("close");
    await this.waitExit(graceMs);
    if (!this.ended) this.kill();
  }

  /** Sync best effort for exit handlers: SIGTERM ends the helper. */
  kill(): void {
    try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { if (!this.ended) { try { this.child.kill("SIGKILL"); } catch { /* gone */ } } }, 3_000).unref();
  }

  private waitExit(ms: number): Promise<void> {
    if (this.ended) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.exitWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  get exitedWith(): number | null | undefined {
    return this.exitCode;
  }
}

/**
 * The print route's prompt watch: the shipped helper started for `windows {pid}` only. It never reads a Screen Recording grant: with none macOS still lists
 * owner, layer and bounds (titles come back empty), which is all the open-watch rule uses. Undefined off macOS (the OS name comes through the platform seam).
 */
export function macPromptWindows(os: string | undefined = hostPlatform()?.name): (() => Promise<{ helper: ScreenHelper; close(): Promise<void> } | null>) | undefined {
  if (os !== "darwin") return undefined;
  return async () => {
    if (!existsSync(SCREEN_HELPER)) return null;
    const h = await ScreenHelper.start({ maxMs: 120_000 }).catch(() => null);
    return h === null ? null : { helper: h, close: () => h.close() };
  };
}
