// Ends a process and every process it started, synchronously. Windows never ends a child with its parent, and a test file's process can leave a
// connector, a review server or a helper running; ending only the top pid would leave those holding the run (an inherited pipe) or a temp folder.
// win32: taskkill /T /F walks the tree by parent pid. Elsewhere: the descendants are read from `ps` and each gets SIGKILL, deepest first.
import { spawnSync } from "node:child_process";
import path from "node:path";

/** Pids of every live descendant of `root` (not `root` itself), read from `ps -A -o pid=,ppid=`. Empty when `ps` cannot run. */
export function posixDescendants(root: number): number[] {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error !== undefined || r.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const walk = (p: number): void => {
    for (const c of children.get(p) ?? []) {
      if (out.includes(c)) continue;
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

/** Ends `pid` and its whole process tree. Never throws; a process already gone is fine. */
export function killTree(pid: number | undefined, platform: NodeJS.Platform = process.platform): void {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    const taskkill = path.win32.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "taskkill.exe");
    const r = spawnSync(taskkill, ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: 15_000 });
    if (r.error === undefined && r.status === 0) return;
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
    return;
  }
  // The root is paused first so it starts no new child while its tree is read; then the root and its descendants (deepest first) get SIGKILL.
  try {
    process.kill(pid, "SIGSTOP");
  } catch {
    // already gone: its descendants (if any are still listed under it) are still ended below
  }
  const tree = posixDescendants(pid);
  for (const p of [pid, ...tree.reverse()]) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
