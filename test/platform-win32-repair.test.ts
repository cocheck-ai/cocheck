// A v0.1.20 home already holds files with an empty protected ACL. The entry points must repair it before their first read.
// Real icacls on a real temp tree; skipped off Windows.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { openLedger } from "../src/ledger.ts";
import { portFilePath, readPortFile } from "../src/review-server.ts";

const WIN = process.platform === "win32";
const MARKER = ".cocheck-acl-v1";

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** What v0.1.20 left behind: no marker, and every file with an empty protected ACL. */
function breakHome(home: string): string[] {
  rmMarker(home);
  const files = allFiles(home);
  // v0.1.20 left an empty protected ACL (no entry grants anything). Removing every entry can leave a NULL DACL on a runner, which allows everyone,
  // so deny the user outright: the same "Access denied" on read, and an owner's /reset still clears it.
  const sid = /"(S-1-[\d-]+)"/.exec(spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).stdout)![1]!;
  for (const f of files) {
    const r = spawnSync("icacls", [f, "/inheritance:r", "/deny", `*${sid}:(F)`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  // A CI runner's elevated admin can still open a denied file, so the proof of "broken" and of "repaired" is the ACL itself (a user's own machine gets EPERM).
  for (const f of files) assert.match(aclOf(f), /\(N\)|\(DENY\)/, `the setup denied the user on ${f}`);
  return files;
}
const aclOf = (target: string): string => spawnSync("icacls", [target], { encoding: "utf8" }).stdout;

/** After the repair: the user is listed with full control and nothing denies them. */
function assertAclRepaired(files: string[]): void {
  const user = process.env.USERNAME!.toLowerCase();
  for (const f of files) {
    const text = aclOf(f);
    assert.ok(text.toLowerCase().includes(`\\${user}:`), `the ACL of ${f} lists the user:\n${text}`);
    assert.doesNotMatch(text, /\(N\)|\(DENY\)/, `nothing denies the user on ${f}:\n${text}`);
  }
}

function rmMarker(home: string): void {
  if (existsSync(path.join(home, MARKER))) unlinkSync(path.join(home, MARKER));
}

function assertUsable(files: string[]): void {
  for (const f of files) {
    readFileSync(f);
    if (!/\.sqlite(-wal|-shm)?$/.test(f)) writeFileSync(f, readFileSync(f)); // a live ledger file stays as is: opening it is the proof
    assert.ok(statSync(f).isFile());
  }
}

function seedHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "cocheck-repair-"));
  openLedger(home).close();
  mkdirSync(path.join(home, "tasks", "1", "states"), { recursive: true });
  writeFileSync(path.join(home, "tasks", "1", "folder.json"), "{}");
  writeFileSync(path.join(home, "tasks", "1", "states", "s.json"), "{}");
  writeFileSync(path.join(home, "review-token"), "t");
  return home;
}

describe("repair of a v0.1.20 home, real icacls", { skip: !WIN && "Windows only" }, () => {
  it("openLedger opens a home whose files have an empty ACL, and every file is usable afterwards", () => {
    const home = seedHome();
    const files = breakHome(home);
    const ledger = openLedger(home);
    ledger.close();
    assertUsable(allFiles(home));
    assertAclRepaired(files);
    for (const f of allFiles(home).filter((f) => !f.endsWith(".sqlite"))) unlinkSync(f);
  });

  it("the review process starts on such a home: it reads the token and takes the lock", async () => {
    const home = seedHome();
    const files = breakHome(home);
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "review-process.ts")], { stdio: "ignore", env: { ...process.env, COCHECK_HOME: home } });
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    try {
      const end = Date.now() + 30_000;
      while (readPortFile(home) === undefined) {
        assert.ok(Date.now() < end, `the review process never wrote ${portFilePath(home)}`);
        assert.equal(child.exitCode, null, "the review process died early");
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      child.kill();
      await exited;
    }
    assertUsable(allFiles(home));
    assertAclRepaired(files.filter((f) => existsSync(f)));
    for (const f of allFiles(home).filter((f) => !f.endsWith(".sqlite"))) unlinkSync(f);
  });
});
