// Finds review processes (review-process.js / .ts) whose COCHECK_HOME is under the OS temp dir. Used by
// the test bootstrap, the leftover check and the probe and fidelity runners. A process with any other home
// (the real ~/.cocheck, an installed extension) is never listed, so it can never be stopped from here.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ReviewProc {
  pid: number;
  home: string;
}

const tempRoots = (): string[] => {
  const roots = new Set([path.resolve(tmpdir()), "/tmp", "/private/tmp"]);
  for (const root of [...roots]) {
    try {
      roots.add(realpathSync(root));
    } catch {
      // missing: the plain path is all there is
    }
  }
  return [...roots];
};

export const isUnderTemp = (home: string): boolean =>
  tempRoots().some((root) => {
    const rel = path.relative(root, home);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });

/** Review processes owned by this user whose COCHECK_HOME is under the OS temp dir. */
export function tempReviewProcesses(): ReviewProc[] {
  let out: string;
  try {
    // `eww` appends the process environment to the command column.
    out = execFileSync("ps", ["eww", "-U", String(process.getuid?.() ?? ""), "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const found: ReviewProc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !/review-process\.(?:js|ts)(?:\s|$)/.test(m[2]!)) continue;
    const pid = Number(m[1]);
    const home = / COCHECK_HOME=(\S+)/.exec(m[2]!)?.[1];
    if (home && pid !== process.pid && isUnderTemp(home)) found.push({ pid, home });
  }
  return found;
}

const sameDir = (a: string, b: string): boolean => {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
};

/** Sends SIGTERM to the given temp-home review processes (default: all), then SIGKILL to any that outlast ~2s. Returns the pids signalled. */
export function killTempReviewProcesses(procs: ReviewProc[] = tempReviewProcesses()): number[] {
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && tempReviewProcesses().some((p) => procs.some((q) => q.pid === p.pid))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  for (const p of tempReviewProcesses()) {
    if (!procs.some((q) => q.pid === p.pid)) continue;
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return procs.map((p) => p.pid);
}

/** Stops the review processes serving `home`, if it is under the OS temp dir. For test teardowns, before the home is removed. */
export function stopTempReviewProcessesFor(home: string): number[] {
  return killTempReviewProcesses(tempReviewProcesses().filter((p) => sameDir(p.home, home)));
}

/** Stops the review processes whose home is `dir` or inside it (a runner's scratch root), if `dir` is under the OS temp dir. */
export function stopTempReviewProcessesUnder(dir: string): number[] {
  const inside = (p: ReviewProc) => {
    const rel = path.relative(path.resolve(dir), path.resolve(p.home));
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  return isUnderTemp(path.resolve(dir)) ? killTempReviewProcesses(tempReviewProcesses().filter(inside)) : [];
}
