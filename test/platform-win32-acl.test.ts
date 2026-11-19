// Windows owner-only permissions. The fake-runner tests run on any OS; the real-effect test runs real icacls and only on Windows.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createWin32, type Win32Deps } from "../src/platform/index.ts";

type Run = Win32Deps["run"];
const SID = "S-1-5-21-1349216834-2179519218-2598434495-1001";

function rig(run: Run, over: Partial<Win32Deps> = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const files = new Set<string>();
  const p = createWin32({
    env: { USERNAME: "Ana", USERDOMAIN: "PC" },
    run: (command, args, options) => {
      calls.push({ command, args });
      return run(command, args, options);
    },
    writeFile: (f) => void files.add(f),
    exists: (f) => files.has(f),
    readdir: () => ["a.txt"],
    ...over,
  });
  return { p, calls, files };
}
const ok: Run = (command) => (/whoami\.exe$/.test(command) ? { status: 0, stdout: `"pc\\ana","${SID}"\r\n`, stderr: "" } : { status: 0, stdout: "Successfully processed 3 files; Failed processing 0 files\r\n", stderr: "" });

describe("win32 ownerOnly with a fake runner", () => {
  it("grants the folder by SID, resets the children, and leaves a marker", () => {
    const { p, calls, files } = rig(ok);
    assert.equal(p.fsSecurity.ownerOnly("C:\\h", true), undefined);
    assert.deepEqual(calls[1]!.args, ["C:\\h", "/reset", "/C", "/Q"]);
    assert.deepEqual(calls[2]!.args, ["C:\\h", "/inheritance:r", "/grant:r", `*${SID}:(OI)(CI)F`, "/C", "/Q"]);
    assert.ok(!calls[2]!.args.includes("/T"), "the folder grant never recurses: /T put folder flags on files");
    assert.deepEqual(calls[3]!.args, ["C:\\h\\*", "/reset", "/T", "/L", "/C"]);
    assert.deepEqual([...files], ["C:\\h\\.cocheck-acl-v1"]);
  });

  it("runs once per home: with the marker present nothing runs", () => {
    const { p, calls } = rig(ok);
    p.fsSecurity.ownerOnly("C:\\h", false);
    const first = calls.length;
    for (let i = 0; i < 5; i++) p.fsSecurity.ownerOnly("C:\\h", i % 2 === 0);
    assert.equal(calls.length, first);
  });

  it("a nonzero icacls exit is reported, and no marker is written so the next call retries", () => {
    const { p, files } = rig((command) => (/whoami\.exe$/.test(command) ? ok(command, []) : { status: 5, stdout: "", stderr: "Access is denied." }));
    assert.match(p.fsSecurity.ownerOnly("C:\\h", true) ?? "", /Access is denied/);
    assert.equal(files.size, 0);
  });

  it("exit 0 with 'Failed processing 2 files' is a failure, not a clean run", () => {
    const { p, files } = rig((command) => (/whoami\.exe$/.test(command) ? ok(command, []) : { status: 0, stdout: "Successfully processed 1 files; Failed processing 2 files\r\n", stderr: "" }));
    assert.match(p.fsSecurity.ownerOnly("C:\\h", true) ?? "", /Failed processing 2/);
    assert.equal(files.size, 0);
  });

  it("an icacls that cannot start is reported", () => {
    const { p } = rig((command) => (/whoami\.exe$/.test(command) ? ok(command, []) : { status: null, stdout: "", stderr: "", error: new Error("ENOENT") }));
    assert.match(p.fsSecurity.ownerOnly("C:\\h", true) ?? "", /ENOENT/);
  });
});

// Real icacls on a real temp tree. Guards against flags that leave files with an empty ACL, so that every read throws EPERM.
describe("win32 ownerOnly, real icacls", { skip: process.platform !== "win32" ? "Windows only" : false }, () => {
  it("the user keeps read, write and delete on every nested file and folder; no inheritance from outside; no other account", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cocheck-acl-"));
    mkdirSync(path.join(home, "sub", "deep"), { recursive: true });
    const files = [path.join(home, "a.txt"), path.join(home, "sub", "b.txt"), path.join(home, "sub", "deep", "c.txt")];
    for (const f of files) writeFileSync(f, "x");
    const acl = (target: string): string => spawnSync("icacls", [target], { encoding: "utf8" }).stdout;
    console.log(`before:\n${acl(home)}`);
    const p = createWin32({
      run: (command, args, options) => {
        const r = spawnSync(command, args, { encoding: "utf8", input: options?.input, timeout: 15_000, windowsHide: true });
        console.log(`ran ${command} ${args.join(" ")} -> ${r.status}\n${r.stdout}${r.stderr}`);
        return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
    });
    assert.equal(p.fsSecurity.ownerOnly(home, true), undefined);
    const user = process.env.USERNAME!.toLowerCase();
    for (const target of [home, path.join(home, "sub"), path.join(home, "sub", "deep"), ...files]) {
      const text = acl(target);
      console.log(text.trim());
      assert.ok(text.toLowerCase().includes(`\\${user}:`), `the ACL of ${target} lists the user:\n${text}`);
      assert.doesNotMatch(text, /Everyone|BUILTIN\\|NT AUTHORITY\\|NT SERVICE\\/i, `no other account on ${target}:\n${text}`);
    }
    // Inheritance from outside is gone: the folder's own ACL has no (I) entry.
    assert.doesNotMatch(acl(home), /\(I\)/, "the home inherits nothing from its parent");
    for (const f of files) {
      assert.equal(readFileSync(f, "utf8"), "x");
      writeFileSync(f, "y");
    }
    writeFileSync(path.join(home, "sub", "new.txt"), "n"); // a file made later inherits the user's grant
    assert.equal(readFileSync(path.join(home, "sub", "new.txt"), "utf8"), "n");
    assert.ok(readdirSync(path.join(home, "sub", "deep")).includes("c.txt"));
    for (const f of [...files, path.join(home, "sub", "new.txt")]) unlinkSync(f);
    assert.ok(existsSync(path.join(home, ".cocheck-acl-v1")));
  });
});
