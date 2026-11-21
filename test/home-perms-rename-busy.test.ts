// writeFileAtomicSync over a target another process holds for a moment. On Windows a rename over a file that is open elsewhere fails
// (EPERM/EBUSY); CoCheck's own readers poll review-server.json every 50 ms while a review process writes it, and a second `cocheck open`
// crashed the review process that way. The write waits a short while for the target instead of failing at once.
// Real OS semantics only: the Windows case holds the target open from PowerShell; the macOS case makes it immutable (chflags uchg). Each is
// skipped on the other OSes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { writeFileAtomicSync } from "../src/home-perms.ts";

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const dirs: string[] = [];
const locked: string[] = [];

function newDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "cocheck-rename-busy-"));
  dirs.push(d);
  return d;
}

after(async () => {
  if (MAC) for (const f of locked) spawnSync("chflags", ["nouchg", f]);
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("writeFileAtomicSync over a busy target", () => {
  it("Windows: a target another process holds open is replaced once it lets go, 300 ms into the write", { skip: !WIN }, async () => {
    const dir = newDir();
    const file = path.join(dir, "review-server.json");
    writeFileSync(file, "old");
    const q = (p: string): string => p.replace(/'/g, "''");
    // Opened without share-delete, as a scanner or another reader may: Windows refuses any rename over it while it is open.
    // The hold ends 300 ms after the write's own temp file appears, so it is timed against the write's retry window, not against the clock
    // since PowerShell printed 'open'. Only .NET calls after 'open': a cmdlet such as Start-Sleep can autoload its module on first use. The old
    // hold (Start-Sleep 700 ms after 'open') once outlasted the 2 s retry window on a loaded runner, where PowerShell took twice its usual start.
    const tmp = `${file}.${process.pid}.tmp`;
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$f = [IO.File]::Open('${q(file)}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('open'); [Console]::Out.Flush(); ` +
      `$w = [Diagnostics.Stopwatch]::StartNew(); while (-not [IO.File]::Exists('${q(tmp)}') -and $w.ElapsedMilliseconds -lt 30000) { [Threading.Thread]::Sleep(5) }; ` +
      `[Threading.Thread]::Sleep(300); $f.Close()`], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise((r) => ps.once("exit", r));
    await new Promise<void>((resolve, reject) => {
      ps.stdout.on("data", (d: Buffer) => d.toString().includes("open") && resolve());
      ps.once("exit", () => reject(new Error("powershell exited before opening the file")));
    });
    const probe = path.join(dir, "probe.tmp");
    writeFileSync(probe, "x");
    assert.throws(() => renameSync(probe, file), (e: NodeJS.ErrnoException) => ["EPERM", "EBUSY", "EACCES"].includes(e.code ?? ""), "the OS refuses a plain rename while the target is held");
    writeFileAtomicSync(file, "new");
    assert.equal(readFileSync(file, "utf8"), "new");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp") && f !== "probe.tmp"), [], "no temp file left");
    await exited;
  });

  it("macOS: a target the OS refuses to replace for 300 ms is replaced once it is free", { skip: !MAC }, () => {
    const dir = newDir();
    const file = path.join(dir, "review-server.json");
    writeFileSync(file, "old");
    assert.equal(spawnSync("chflags", ["uchg", file]).status, 0);
    locked.push(file);
    const probe = path.join(dir, "probe.tmp");
    writeFileSync(probe, "x");
    assert.throws(() => renameSync(probe, file), { code: "EPERM" }, "the OS refuses a plain rename while the target is immutable");
    // Freed by another process while the write is waiting (the write blocks this thread).
    spawn("sh", ["-c", `sleep 0.3; chflags nouchg '${file}'`], { stdio: "ignore" });
    writeFileAtomicSync(file, "new");
    assert.equal(readFileSync(file, "utf8"), "new");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp") && f !== "probe.tmp"), [], "no temp file left");
  });

  it("macOS: a target that stays refused throws the rename's error after the wait, leaving no temp file", { skip: !MAC }, () => {
    const dir = newDir();
    const file = path.join(dir, "review-server.json");
    writeFileSync(file, "old");
    assert.equal(spawnSync("chflags", ["uchg", file]).status, 0);
    locked.push(file);
    const t0 = Date.now();
    assert.throws(() => writeFileAtomicSync(file, "new"), { code: "EPERM" });
    assert.ok(Date.now() - t0 >= 1000, "it waited before giving up");
    assert.equal(readFileSync(file, "utf8"), "old");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "the temp file is removed");
  });

  it("a lasting error that is not a busy target (the folder is gone) throws at once", () => {
    const dir = newDir();
    const t0 = Date.now();
    assert.throws(() => writeFileAtomicSync(path.join(dir, "missing", "f.json"), "x"), { code: "ENOENT" });
    assert.ok(Date.now() - t0 < 500);
  });
});
