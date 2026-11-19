// The Windows Office driver's host transport. One long-lived powershell.exe per job runs
// office-win.ps1 (beside this module; the build copies it into dist) and answers JSON lines: request {id, op, args}; reply
// {id, ok:true, ...} or {id, ok:false, why}. Node starts it by its full System32 path with -NoProfile -NonInteractive -Sta
// -ExecutionPolicy Bypass, window hidden, the .ps1 read from its file as a scriptblock (no -EncodedCommand; .NET only, no compiled helpers).
// Lifecycle: the host ends on stdin EOF (this process gone), on the `exit` op (close), or by stopHost on the child we spawned (the one stop path).
// Adding an op (C2/C3, and P2's read-only `windows {pid}`): one entry in the .ps1's $Ops plus one typed method here that calls `call`.
// Windows-specific by name (platform-specific code lives in a module whose name says so): the System32 path lives here because Office drivers are connector code.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { endChild } from "../../platform/index.ts";
import type { OfficeExportDriver } from "./office-job.ts";
import { guard } from "./mac-guard.ts";
import { HOST_NOT_STARTED_SENTENCE, RESTRICTED_SENTENCE, exportMethods } from "./office-win-export.ts";
import { lifecycleMethods } from "./office-win-lifecycle.ts";

/** The host script, beside this module in src/ and in dist/ (scripts/copy-connector-assets.mjs copies it there). */
export const HOST_SCRIPT = fileURLToPath(new URL("./office-win.ps1", import.meta.url));

/** Said when the host's PowerShell runs in anything but FullLanguage (AppLocker or WDAC policy): the driver cannot run there. */
export const RESTRICTED_WHY = "PowerShell is restricted by policy";

/** Windows PowerShell 5.1 by its full path, never a PATH lookup. */
export const powershellPath = (env: NodeJS.ProcessEnv = process.env): string => path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/**
 * The real host's command line. The loader checks the language mode first (both lines below are legal in ConstrainedLanguage, where
 * reading the file as a scriptblock is not), so a restricted host answers one plain line and exits instead of failing to load.
 */
export function hostCommand(script: string = HOST_SCRIPT, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const quoted = `'${script.replace(/'/g, "''")}'`;
  const loader = [
    "$m = [string]$ExecutionContext.SessionState.LanguageMode",
    `if ($m -ne 'FullLanguage') { Write-Output ('{"id":null,"ok":false,"why":"restricted","mode":"' + $m + '"}'); exit 0 }`,
    `& ([scriptblock]::Create([IO.File]::ReadAllText(${quoted}, [Text.Encoding]::UTF8)))`,
  ].join("; ");
  return { command: powershellPath(env), args: ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-Command", loader] };
}

/**
 * The one way the host process is stopped: the host child this process spawned, through the platform layer's `endChild` (fix/win-ci-hangs' helper).
 * On Windows that ends the host's tree (taskkill /T /F on our own child's pid, the pid alone when taskkill fails); elsewhere `child.kill`. Only ever
 * our own child, never a pid read from anywhere else. Office kills never come here: they stay single-pid (office-win-lifecycle.ts).
 */
export function stopHost(child: Parameters<typeof endChild>[0]): void {
  endChild(child);
}

export type HostReply = ({ ok: true } & Record<string, unknown>) | { ok: false; why: string; caveat?: string };
export type Hello = { ok: true; version: string; mode: string } | { ok: false; why: string };

export interface WinHostOptions {
  /** The host to run instead of the real powershell.exe (tests: a fake JSON-lines host). Absent: the real host, behind `guard()`. */
  command?: { command: string; args: string[] };
  /** Test seam for the spawn call itself. */
  spawnFn?: typeof spawn;
  /** How long close() waits for the host to leave after `exit` before stopping its pid (default 2 s). */
  exitWaitMs?: number;
  /** The stop path, given the pid of the host child (tests). Absent: `stopHost` on the child itself. */
  stop?: (pid: number) => void;
}

interface Pending { resolve: (r: HostReply) => void; timer: NodeJS.Timeout }

/** One PowerShell host, started on first use. Calls run concurrently; each has its own timer, and a timeout answers only that call. */
export class WinHost {
  private child: ChildProcess | undefined;
  private exited: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private restricted = false;
  private readonly o: WinHostOptions;

  constructor(o: WinHostOptions = {}) {
    this.o = o;
  }

  /** The pid of the running host, undefined when none runs. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  private start(): ChildProcess {
    if (this.child !== undefined) return this.child;
    let cmd = this.o.command;
    if (cmd === undefined) {
      guard(); // the real host never starts under the test bootstrap
      cmd = hostCommand();
    }
    const child = (this.o.spawnFn ?? spawn)(cmd.command, cmd.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    // The host never keeps this process alive on its own: a pending call's timer does while it waits, and the process-exit hook
    // (closeSync) or the host's EOF ends a host left behind.
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr]) (s as unknown as { unref?: () => void } | null)?.unref?.();
    child.stdin?.on("error", () => undefined); // a host that died mid-write: its calls are answered by the exit below
    child.stderr?.resume();
    child.on("error", () => undefined);
    this.exited = new Promise((resolve) => child.once("close", () => resolve()));
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.once("close", () => {
      if (this.child === child) this.child = undefined;
      const why = this.restricted ? RESTRICTED_WHY : "the PowerShell host ended";
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.resolve({ ok: false, why });
      }
    });
    return child;
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; ok?: unknown; why?: unknown } & Record<string, unknown>;
    try {
      msg = JSON.parse(line.replace(/\r$/, ""));
    } catch {
      return;
    }
    if (msg.ok === false && msg.why === "restricted") this.restricted = true;
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (p === undefined) return; // a reply after its call timed out: answers nothing
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    const { id: _id, ...rest } = msg;
    const why = typeof rest.why === "string" ? rest.why : "the PowerShell host gave no reason";
    // a host caveat ('no-local-pdf-printer') travels with the failure
    p.resolve(rest.ok === true ? (rest as HostReply) : typeof rest.caveat === "string" ? { ok: false, why, caveat: rest.caveat } : { ok: false, why });
  }

  /** Sends one op and waits up to `timeoutMs` for its reply. Never rejects for the host's sake: a timeout or a dead host is an ok:false reply. */
  call(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<HostReply> {
    if (this.restricted) return Promise.resolve({ ok: false, why: RESTRICTED_WHY });
    let child: ChildProcess;
    try {
      child = this.start();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, why: `the PowerShell host did not answer ${op} in ${timeoutMs} ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      child.stdin?.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  /** The host's PowerShell version and language mode; anything but FullLanguage is answered as restricted. */
  async hello(timeoutMs = 20_000): Promise<Hello> {
    const r = await this.call("hello", {}, timeoutMs);
    if (!r.ok) return r;
    if (r.mode !== "FullLanguage") {
      this.restricted = true;
      return { ok: false, why: RESTRICTED_WHY };
    }
    return { ok: true, version: String(r.version), mode: String(r.mode) };
  }

  /** Exercises the host's .NET and its busy-retry helper without any Office. */
  selftest(timeoutMs = 20_000): Promise<HostReply> {
    return this.call("selftest", {}, timeoutMs);
  }

  /** Ends the host: asks it to exit and closes its stdin; a host still there after `exitWaitMs` is stopped by its pid. */
  async close(): Promise<void> {
    const child = this.child;
    if (child === undefined || this.exited === undefined) return;
    const exited = this.exited;
    const waitMs = this.o.exitWaitMs ?? 2_000;
    void this.call("exit", {}, waitMs);
    child.stdin?.end();
    let timer: NodeJS.Timeout | undefined;
    const late = await Promise.race([exited.then(() => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), waitMs)))]);
    clearTimeout(timer);
    if (late) {
      this.stop(child);
      await exited;
    }
    if (this.child === child) this.child = undefined;
  }

  /** Ends the host at once, synchronously (process exit, signal cleanup): stops the pid we spawned. */
  closeSync(): void {
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    try { child.stdin?.end(); } catch { /* gone */ }
    this.stop(child);
  }

  private stop(child: ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (this.o.stop !== undefined) this.o.stop(child.pid);
    else stopHost(child);
  }
}

/**
 * The job's first ask of the host: hello, once, before the isRunning gate. isRunning counts a host that cannot answer as "running", which
 * would tell the person "Excel is open, pages later" forever, so a restricted PowerShell, a host that cannot start (or never answers) is caught here
 * and said plainly. It lives in the driver, so office-job.ts stays OS-neutral.
 */
async function preflight(host: WinHost): Promise<string | null> {
  try {
    const h = await host.hello();
    if (h.ok) return null;
    // only a detected refusal (ConstrainedLanguage or the loader's restricted line) is said as policy; a slow or failed start is not
    return h.why === RESTRICTED_WHY ? RESTRICTED_SENTENCE : HOST_NOT_STARTED_SENTENCE;
  } catch {
    return HOST_NOT_STARTED_SENTENCE;
  }
}

/** The Windows Office driver (export-driver.ts returns one per call: a fresh host per job): C1 host, C2 lifecycle, C3 exports, C6 preflight. */
export function winOfficeDriver(o: WinHostOptions = {}): Required<Pick<OfficeExportDriver, "close" | "closeSync" | "exportPdf" | "openDocuments" | "preflight">> & ReturnType<typeof lifecycleMethods> & { host: WinHost } {
  const host = new WinHost(o);
  return { host, ...lifecycleMethods(host), ...exportMethods(host), preflight: () => preflight(host), close: () => host.close(), closeSync: () => host.closeSync() };
}
