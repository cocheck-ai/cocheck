// Keeps the review server on the installed build. A brew upgrade or a tarball install leaves the previous build's review server
// running (its install folder may be gone). A hook event does a cheap check: if the
// recorded server answers /health with an older build than this install, one detached child (`review-refresh`) replaces it.
// Light on purpose: the hook entry must not load review-server.ts, so this file reads the port file and build stamp itself.
// An older or equal build in this process never triggers anything, so a live review of the same build is never touched.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detachedCwd } from "./platform/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** When this install was built (the `build-info.json` stamp written at build time), or 0 from source: unknown age never replaces anything. */
function ownBuiltAt(dir: string = here): number {
  try {
    const stamp = JSON.parse(readFileSync(path.join(dir, "build-info.json"), "utf8")).builtAt;
    return typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
  } catch {
    return 0;
  }
}

/** The /health answer's `builtAt` (0 when the server reports none), or undefined when nothing CoCheck's answers. */
function probeBuiltAt(port: number, timeoutMs: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    // One overall deadline: the socket-idle timeout alone never fires on a listener that trickles bytes.
    const deadline = setTimeout(() => {
      req.destroy();
      resolve(undefined);
    }, timeoutMs);
    deadline.unref();
    const req = http.get({ hostname: "127.0.0.1", port, path: "/health", headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve(res.statusCode === 200 && parsed.cocheck === "review" ? (typeof parsed.builtAt === "number" ? parsed.builtAt : 0) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.on("close", () => clearTimeout(deadline));
  });
}

/** The single-flight lock: at most one refresh child per data home. A lock older than this is a dead child's. */
const REFRESH_LOCK_STALE_MS = 30_000;
export const refreshLockPath = (home: string): string => path.join(home, "review-refresh.lock");

/** Takes the lock, or false when a live-looking child holds it. */
function takeRefreshLock(home: string): boolean {
  const lock = refreshLockPath(home);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (Date.now() - statSync(lock).mtimeMs <= REFRESH_LOCK_STALE_MS) return false;
        rmSync(lock, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** The child calls this when it ends. */
export function releaseRefreshLock(home: string): void {
  try {
    rmSync(refreshLockPath(home), { force: true });
  } catch {
    // a stale lock ages out
  }
}

/**
 * True when the review server recorded under `home` runs an older build than this one. Never throws; false when no server is
 * recorded or answers (a hook event does not start a review process, only replaces an outdated one).
 */
export async function reviewIsOutdated(home: string, mine: number = ownBuiltAt(), timeoutMs = 300): Promise<boolean> {
  if (mine <= 0) return false;
  try {
    const port = Number(JSON.parse(readFileSync(path.join(home, "review-server.json"), "utf8")).port);
    if (!Number.isInteger(port)) return false;
    const theirs = await probeBuiltAt(port, timeoutMs);
    return theirs !== undefined && mine > theirs;
  } catch {
    return false;
  }
}

/** Starts the detached replacement when the recorded review server is outdated. Never throws. */
export async function refreshStaleReview(home: string, mine?: number, spawnFn: typeof spawn = spawn): Promise<boolean> {
  try {
    if (!(await reviewIsOutdated(home, mine))) return false;
    if (!takeRefreshLock(home)) return false;
    const ext = path.extname(fileURLToPath(import.meta.url));
    const child = spawnFn(process.execPath, [path.join(here, `review-refresh-process${ext}`)], { detached: true, stdio: "ignore", env: { ...process.env, COCHECK_HOME: home }, ...detachedCwd(home) }); // Windows: never the caller's folder
    child.on("error", () => releaseRefreshLock(home));
    child.unref();
    return true;
  } catch {
    return false;
  }
}
