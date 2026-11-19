// The Windows Office driver's lifecycle: stage root, the gate, a proven launch, ready, document
// count, a gated quit, a checked kill, and the owned-record file with its sweep. Windows-specific by name: platform-specific code lives in a module whose name says so. The ops live in
// office-win.ps1 under "# --- lifecycle ops ---"; this module only calls them through the job's WinHost.
// Safety rules: the person's own Office is never driven or killed. A launch the host cannot prove (exactly one new pid of the image, started
// after the launch began) is "not-ours" and nothing more is sent to it. kill re-reads image and start time and calls TerminateProcess on that
// pid only (never a tree kill: COM-launched Office is not our child anyway). An app whose quit was refused (documents open, or the person
// took control) is the person's from then on: its record is dropped and kill refuses it. The sweep never kills an Office with a visible window.
// Start times are epoch ms read by the same host op (procInfo) every time, so no TZ or locale enters a comparison (a value two processes compare is environment-independent).
import { readFile, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { platform } from "../../platform/index.ts";
import type { OfficeApp, OfficeAppKey } from "./apps.ts";
import type { WinHost } from "./office-win.ts";

/** The process image (Process.ProcessName, no .exe) of each app. */
export const OFFICE_IMAGE: Record<OfficeAppKey, string> = { excel: "EXCEL", word: "WINWORD", powerpoint: "POWERPNT" };

/** Two reads of one process's start time come from the same host op, so they differ only by rounding; a reused pid starts later than this. */
export const START_MATCH_MS = 1_000;

/** What `office-<app>.owned.json` holds: the Office this connector launched, and the connector itself, for the next job's sweep. */
export interface OwnedRecord {
  pid: number;
  startedAtMs: number;
  image: string;
  connectorPid: number;
  /** null when the connector's own start time could not be read: the sweep then treats a live pid of that number as the connector. */
  connectorStartedAtMs: number | null;
}

export const ownedRecordPath = (lockDir: string, key: OfficeAppKey): string => path.join(lockDir, `office-${key}.owned.json`);

export type ProcInfo = { gone: true } | { gone: false; image: string; startedAtMs: number; visibleWindow: boolean } | null;

export interface LifecycleOptions {
  /** For stageRoot (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** The stop path (default `killOnePid`: TerminateProcess on that pid alone; never platform().process.terminate, which is a tree kill on Windows). */
  terminate?: (pid: number) => void;
  /** Liveness of a pid (default platform().process.alive). */
  aliveFn?: (pid: number) => boolean;
  /** This connector's pid (default process.pid). */
  selfPid?: number;
  /** ready's retry interval (default 250 ms). */
  pollMs?: number;
  /** How long sweepOwned waits for a terminated Office to leave the process table (default 5000 ms). */
  goneWaitMs?: number;
}

/**
 * An Office kill: the verified pid alone (process.kill, which is TerminateProcess on Windows). Never platform().process.terminate: on Windows that is
 * taskkill /T /F (a tree kill), which would also end whatever that Office started.
 */
export const killOnePid = (pid: number): void => {
  process.kill(pid);
};

const sameImage = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sameStart = (a: number, b: number): boolean => Math.abs(a - b) <= START_MATCH_MS;

export function lifecycleMethods(host: WinHost, o: LifecycleOptions = {}) {
  const terminate = o.terminate ?? killOnePid;
  const aliveFn = o.aliveFn ?? ((pid: number) => platform().process.alive(pid));
  const selfPid = o.selfPid ?? process.pid;
  /** The folder of the job's lock, known once the job's sweep ran; launches are recorded there. */
  let recordDir: string | undefined;
  /** Pids this driver launched and proved, with what kill must find before it signals them. */
  const owned = new Map<number, { key: OfficeAppKey; startedAtMs: number; image: string }>();
  const ownedByApp = new Map<OfficeAppKey, number>();

  const procInfo = async (pid: number): Promise<ProcInfo> => {
    const r = await host.call("procInfo", { pid }, 10_000);
    if (!r.ok) return null;
    if (r.gone === true) return { gone: true };
    if (typeof r.image !== "string" || typeof r.startedAtMs !== "number") return null;
    return { gone: false, image: r.image, startedAtMs: r.startedAtMs, visibleWindow: r.visibleWindow === true };
  };
  const dropRecord = async (key: OfficeAppKey): Promise<void> => {
    if (recordDir !== undefined) await unlink(ownedRecordPath(recordDir, key)).catch(() => undefined);
  };
  /** Dead only on proof: gone, or that pid now started at another time. A read that fails, or no start time to compare, means alive. */
  const connectorDead = async (rec: OwnedRecord): Promise<boolean> => {
    const info = await procInfo(rec.connectorPid);
    if (info === null) return false;
    if (info.gone) return true;
    return rec.connectorStartedAtMs !== null && !sameStart(info.startedAtMs, rec.connectorStartedAtMs);
  };

  return {
    stageRoot(): string {
      const env = o.env ?? process.env;
      return path.join(env.USERPROFILE ?? env.HOME ?? "", "AppData", "Local", "CoCheck", "stage");
    },

    /** Any process of the app's image. A host that cannot answer counts as running: the gate then leaves the app alone. */
    async isRunning(app: OfficeApp): Promise<boolean> {
      const r = await host.call("isRunning", { app: app.key }, 15_000);
      return r.ok ? r.running !== false : true;
    },

    async launch(app: OfficeApp): Promise<number | null | "not-ours"> {
      const r = await host.call("launch", { app: app.key }, 60_000);
      if (!r.ok) return null;
      if (r.notOurs === true) return "not-ours";
      if (typeof r.pid !== "number" || typeof r.startedAtMs !== "number") return null;
      const image = OFFICE_IMAGE[app.key];
      owned.set(r.pid, { key: app.key, startedAtMs: r.startedAtMs, image });
      ownedByApp.set(app.key, r.pid);
      if (recordDir !== undefined) {
        const self = await procInfo(selfPid);
        const rec: OwnedRecord = { pid: r.pid, startedAtMs: r.startedAtMs, image, connectorPid: selfPid, connectorStartedAtMs: self !== null && !self.gone ? self.startedAtMs : null };
        await writeFile(ownedRecordPath(recordDir, app.key), JSON.stringify(rec), { mode: 0o600 }).catch(() => undefined);
      }
      return r.pid;
    },

    /** True once the proven app answers a property read after being hidden; false at the deadline, or at once when the host holds no proven app. */
    async ready(app: OfficeApp, deadline: number): Promise<boolean> {
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return false;
        const r = await host.call("ready", { app: app.key }, left);
        if (r.ok && r.ready === true) return true;
        if (!r.ok && r.why === "not launched") return false;
        await new Promise((res) => setTimeout(res, Math.min(o.pollMs ?? 250, Math.max(0, deadline - Date.now()))));
      }
    },

    async documentCount(app: OfficeApp, timeoutMs: number): Promise<number | null> {
      const r = await host.call("documentCount", { app: app.key }, timeoutMs);
      return r.ok && typeof r.count === "number" ? r.count : null;
    },

    /** Quits only with no documents and no UserControl (checked in the host). A refusal hands the app to the person: record dropped, kill refused. */
    async quit(app: OfficeApp, timeoutMs: number): Promise<void> {
      const r = await host.call("quit", { app: app.key }, timeoutMs);
      if (!r.ok) return;
      const pid = ownedByApp.get(app.key);
      if (r.refused === true && pid !== undefined) owned.delete(pid);
      ownedByApp.delete(app.key);
      await dropRecord(app.key);
    },

    alive(pid: number): boolean {
      return aliveFn(pid);
    },

    /**
     * Stops exactly `pid`, a pid this driver launched and still owns, once procInfo shows the same image and start time; then removes its record.
     * `signal` is moot on Windows (TerminateProcess either way). Returns a promise (the check goes through the host); the sync interface
     * ignores it, and a kill cut short by process exit leaves the record for the next job's sweep.
     */
    async kill(pid: number, _signal?: "TERM" | "KILL", startedAtMs?: number): Promise<void> {
      const mine = owned.get(pid);
      if (mine === undefined) return;
      const expected = startedAtMs ?? mine.startedAtMs;
      const info = await procInfo(pid);
      if (info === null) return;
      if (!info.gone) {
        if (!sameImage(info.image, mine.image) || !sameStart(info.startedAtMs, expected)) return;
        try { terminate(pid); } catch { /* gone */ }
      }
      owned.delete(pid);
      if (ownedByApp.get(mine.key) === pid) ownedByApp.delete(mine.key);
      await dropRecord(mine.key);
    },

    /**
     * At job start, holding the lock, before the gate: the record of an Office a dead connector launched. Matching image and start time with no
     * visible window: killed. Visible window: left alone. Mismatched or gone: nothing. In all three the record is deleted. A live (or unreadable)
     * connector, or an unreadable Office pid, leaves the record as it is. Also makes `lockDir` where this job's launches are recorded.
     */
    async sweepOwned(app: OfficeApp, lockDir: string): Promise<void> {
      recordDir = lockDir;
      await mkdir(this.stageRoot(), { recursive: true }).catch(() => undefined);
      const file = ownedRecordPath(lockDir, app.key);
      const text = await readFile(file, "utf8").catch(() => null);
      if (text === null) return;
      let rec: OwnedRecord;
      try {
        rec = JSON.parse(text) as OwnedRecord;
      } catch {
        await unlink(file).catch(() => undefined);
        return;
      }
      if (typeof rec.pid !== "number" || typeof rec.startedAtMs !== "number" || typeof rec.image !== "string" || typeof rec.connectorPid !== "number" || !sameImage(rec.image, OFFICE_IMAGE[app.key])) {
        await unlink(file).catch(() => undefined);
        return;
      }
      if (!(await connectorDead(rec))) return;
      const info = await procInfo(rec.pid);
      if (info === null) return;
      if (!info.gone && sameImage(info.image, rec.image) && sameStart(info.startedAtMs, rec.startedAtMs) && !info.visibleWindow) {
        try { terminate(rec.pid); } catch { /* gone */ }
        // TerminateProcess returns before the process is out of the table: wait for exactly this pid, so the gate that follows does not see it dying.
        // Not gone in time: carry on, and the gate answers pending, which is safe.
        const until = Date.now() + (o.goneWaitMs ?? 5_000);
        for (;;) {
          const now = await procInfo(rec.pid);
          if (now === null || now.gone || !sameImage(now.image, rec.image) || !sameStart(now.startedAtMs, rec.startedAtMs)) break;
          const left = until - Date.now();
          if (left <= 0) break;
          await new Promise((res) => setTimeout(res, Math.min(o.pollMs ?? 250, left)));
        }
      }
      await unlink(file).catch(() => undefined);
    },
  };
}
