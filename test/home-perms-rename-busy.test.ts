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
  it("Windows: a target another process holds open for half a second is replaced once it lets go", { skip: !WIN }, async () => {
    const dir = newDir();
    const file = path.join(dir, "review-server.json");
    writeFileSync(file, "old");
    // Opened without share-delete, as a scanner or another reader may: Windows refuses any rename over it while it is open.
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('open'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 700; $f.Close()`], { stdio: ["ignore", "pipe", "inherit"] });
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
