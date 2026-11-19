import { darwin } from "./darwin.ts";
import { win32 } from "./win32.ts";
import { PlatformNotBuiltError, type Platform } from "./types.ts";

export * from "./types.ts";
export { HOME_REFUSAL, isUnsafeTaskFolder, userHomeDir } from "./task-folder.ts";
export { createWin32, type Win32Deps } from "./win32.ts";
export { CONNECTOR_BASE_ENV, CONNECTOR_FIXED_ENV, CONNECTOR_SET_ENV, connectorEnv, escapeCmdArgument, mergeEnv, pickEnv, planSpawn, resolveProgram, spawnPiped, type ResolveOptions, type SpawnPlan } from "./spawn.ts";
export { macAppVersion, psCommandLine } from "./darwin.ts";

const BUILT: Partial<Record<string, Platform>> = { darwin, win32 };

/** The implementation for an OS name. An OS with none at all (linux, freebsd, aix) throws `PlatformNotBuiltError`. */
export function platformFor(name: string): Platform {
  const found = BUILT[name];
  if (found === undefined) throw new PlatformNotBuiltError(name, "platform");
  return found;
}

/** The running OS's platform. Looked up when called, never at module load, so import order cannot matter. */
export function platform(): Platform {
  return platformFor(process.platform);
}

/** The running OS's platform, or undefined on an OS with none built (it has no converter either, and must read "unavailable", not throw). */
export const hostPlatform = (): Platform | undefined => {
  try {
    return platform();
  } catch {
    return undefined;
  }
};

/** Whether something limited to `platforms` (OS names such as "darwin"; absent means every OS) is available on the running OS. */
export const availableOn = (platforms: readonly string[] | undefined, os: string = process.platform): boolean => platforms === undefined || platforms.includes(os);

/**
 * Ends a child this process started, when its operation ends (a timeout, a stop). On Windows a child is never ended with its parent and killing
 * a pid leaves the processes it started running, so there the whole tree is ended (platform().process.terminate: taskkill /T /F). Elsewhere it is
 * `child.kill(signal)`, as before.
 */
export function endChild(child: { pid?: number | undefined; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: NodeJS.Signals): boolean }, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32" && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try {
      platform().process.terminate(child.pid);
      return;
    } catch {
      // taskkill and the pid kill both failed: the plain kill below is the last try
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/**
 * The working folder for a long-lived detached CoCheck process serving `home` (the review process, its refresher). Windows keeps a process's
 * working folder open, so started from the caller's folder (the person's project, a test's temp folder) it would stop that folder being removed
 * or renamed for as long as it runs: there it works in `home`. Elsewhere it keeps the caller's, as before. Neither process reads a relative path.
 */
export function detachedCwd(home: string): { cwd?: string } {
  return process.platform === "win32" ? { cwd: home } : {};
}
