// The win32 Platform, run on any OS with injected runners. Each member's exact argv is pinned; no real PowerShell, explorer or icacls runs.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SecretStoreError, createWin32, type Win32Deps } from "../src/platform/index.ts";

type Call = { command: string; args: string[]; input?: string };
const KEY = Buffer.from("ab".repeat(32), "hex");
const BLOB = "QUJDREVGRw==";

function rig(over: Partial<Win32Deps> & { protect?: { status: number | null; stdout: string; stderr?: string; error?: Error } } = {}) {
  const calls: Call[] = [];
  const files = new Map<string, string>();
  const writes: string[] = [];
  const deps: Partial<Win32Deps> = {
    env: { USERPROFILE: "C:\\Users\\Ana", USERNAME: "Ana", USERDOMAIN: "PC", HOME: "/wrong/home" },
    homedir: () => "C:\\Users\\Fallback",
    tmpdir: () => "C:\\Temp",
    run(command, args, options) {
      calls.push({ command, args, ...(options?.input === undefined ? {} : { input: options.input }) });
      if (command === "powershell.exe") {
        if (args[args.length - 1]!.includes("::Protect(")) return { status: 0, stdout: BLOB + "\r\n", stderr: "", ...over.protect };
        return { status: 0, stdout: "ab".repeat(32) + "\r\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    runAsync: async (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
    readFile: (f) => files.get(f)!,
    writeFile: (f, data) => {
      files.set(f, data);
      writes.push(data);
    },
    linkExclusive: (from, to) => {
      if (files.has(to)) throw new Error("EEXIST");
      files.set(to, files.get(from)!);
    },
    remove: (f) => void files.delete(f),
    mkdir: () => undefined,
    exists: (f) => files.has(f),
    readdir: () => [],
    ...over,
  };
  delete (deps as { protect?: unknown }).protect;
  return { p: createWin32(deps), calls, files, writes };
}

describe("win32 paths", () => {
  it("home from USERPROFILE (never HOME), tmp, absolute, posix, case", () => {
    const { p } = rig();
    assert.equal(p.paths.userHome(), "C:\\Users\\Ana");
    assert.equal(p.paths.tmpDir(), "C:\\Temp");
    assert.equal(p.paths.isAbs("C:\\x\\y"), true);
    assert.equal(p.paths.isAbs("\\\\srv\\share"), true);
    assert.equal(p.paths.isAbs("rel\\x"), false);
    assert.equal(p.paths.toPosix("C:\\x\\y"), "C:/x/y");
    assert.equal(p.paths.caseSensitive, false);
    assert.equal(createWin32({ env: { HOME: "/h" }, homedir: () => "C:\\Fallback" }).paths.userHome(), "C:\\Fallback");
  });
});

describe("win32 open and process", () => {
  it("openUrl runs rundll32 and openFile runs explorer.exe, each with an argv array", async () => {
    const { p, calls } = rig();
    p.openUrl("https://x.test/?a=1&b=2");
    assert.deepEqual(calls[0], { command: "rundll32", args: ["url.dll,FileProtocolHandler", "https://x.test/?a=1&b=2"] });
    assert.equal(await p.openFile("C:\\a b\\f.xlsx"), true);
    assert.deepEqual(calls[1], { command: "explorer.exe", args: ["C:\\a b\\f.xlsx"] });
    assert.equal(await p.openFile("C:\\f.xlsx", "C:\\Office\\EXCEL.EXE"), true);
    assert.deepEqual(calls[2], { command: "C:\\Office\\EXCEL.EXE", args: ["C:\\f.xlsx"] });
  });

  it("openUrl throws and openFile resolves false when the opener cannot start", async () => {
    const { p } = rig({ run: () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }), runAsync: async () => ({ status: null, error: new Error("ENOENT") }) });
    assert.throws(() => p.openUrl("https://x"), /ENOENT/);
    assert.equal(await p.openFile("C:\\f"), false);
  });

  it("alive uses signal 0, EPERM counts as alive, terminate ends the whole tree with taskkill and kills the pid only when taskkill fails", () => {
    const sent: Array<[number, unknown]> = [];
    const runs: Call[] = [];
    let taskkill = { status: 0 as number | null, stdout: "", stderr: "" };
    const { p } = rig({
      kill(pid, signal) {
        sent.push([pid, signal]);
        if (pid === 2) throw Object.assign(new Error("x"), { code: "ESRCH" });
        if (pid === 3) throw Object.assign(new Error("x"), { code: "EPERM" });
      },
      run(command, args) {
        runs.push({ command, args });
        return taskkill;
      },
    });
    assert.equal(p.process.alive(1), true);
    assert.equal(p.process.alive(2), false);
    assert.equal(p.process.alive(3), true);
    p.process.terminate(9);
    assert.deepEqual(runs, [{ command: "C:\\Windows\\System32\\taskkill.exe", args: ["/T", "/F", "/PID", "9"] }]);
    assert.deepEqual(sent, [[1, 0], [2, 0], [3, 0]]);
    // taskkill failed (128: no such process): the pid alone is ended, and its throw (gone) reaches the caller.
    taskkill = { status: 128, stdout: "", stderr: "not found" };
    assert.throws(() => p.process.terminate(2), /x/);
    assert.deepEqual(sent.at(-1), [2, undefined]);
  });

  it("spawnDetached passes detached and windowsHide with no stdio", () => {
    let seen: unknown[] = [];
    const { p } = rig({
      spawn: ((...a: unknown[]) => ((seen = a), { pid: 77, unref() {} })) as unknown as Win32Deps["spawn"],
    });
    assert.equal(p.process.spawnDetached("node", ["a.js"], { cwd: "C:\\w" }), 77);
    assert.deepEqual(seen, ["node", ["a.js"], { cwd: "C:\\w", detached: true, windowsHide: true, stdio: "ignore" }]);
  });
});

describe("win32 secretStore (DPAPI)", () => {
  const ps = (c: Call) => c.args.slice(0, -1);
  it("create sends the key on stdin only, CurrentUser scope, and stores only the blob", () => {
    const { p, calls, files, writes } = rig();
    p.secretStore.create("svc", "acct", KEY);
    const c = calls[0]!;
    assert.equal(c.command, "powershell.exe");
    assert.deepEqual(ps(c), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
    assert.equal(c.input, KEY.toString("hex"));
    assert.ok(c.args[c.args.length - 1]!.includes("DataProtectionScope]::CurrentUser"));
    for (const a of c.args) assert.ok(!a.includes(KEY.toString("hex")));
    assert.deepEqual(writes, [BLOB, "1\n"]); // the blob, then the permissions marker
    const [file] = [...files.keys()];
    assert.match(file!, /^C:\\Users\\Ana\\AppData\\Local\\CoCheck\\secrets\\[0-9a-f]{64}\.dpapi$/);
    assert.deepEqual(calls[3], { command: "icacls", args: ["C:\\Users\\Ana\\AppData\\Local\\CoCheck\\secrets", "/inheritance:r", "/grant:r", "PC\\Ana:(OI)(CI)F", "/C", "/Q"] }); // calls[1] is whoami, calls[2] the reset
  });

  it("get returns null with no blob, and the key after unprotect with the blob on stdin", () => {
    const { p, calls } = rig();
    assert.equal(p.secretStore.get("svc", "acct"), null);
    p.secretStore.create("svc", "acct", KEY);
    calls.length = 0;
    assert.deepEqual(p.secretStore.get("svc", "acct"), KEY);
    assert.equal(calls[0]!.input, BLOB);
    assert.ok(calls[0]!.args[calls[0]!.args.length - 1]!.includes("::Unprotect("));
    for (const a of calls[0]!.args) assert.ok(!a.includes(BLOB));
  });

  it("get refuses a blob that does not unprotect to 32 bytes", () => {
    const { p } = rig({ run: (c, a) => (c === "powershell.exe" && a[a.length - 1]!.includes("::Unprotect(") ? { status: 0, stdout: "abcd", stderr: "" } : { status: 0, stdout: BLOB, stderr: "" }) });
    p.secretStore.create("s", "a", KEY);
    assert.throws(() => p.secretStore.get("s", "a"), SecretStoreError);
  });

  // Guard: when DPAPI fails, the shared error is thrown and the key is written nowhere in plain text.
  it("DPAPI failure throws SecretStoreError and writes nothing", () => {
    for (const protect of [
      { status: 1, stdout: "", stderr: "boom" },
      { status: null, stdout: "", stderr: "", error: new Error("no powershell") },
      { status: 0, stdout: KEY.toString("hex") },
      { status: 0, stdout: KEY.toString("base64") },
      { status: 0, stdout: "" },
    ]) {
      const { p, files, writes } = rig({ protect });
      assert.throws(() => p.secretStore.create("s", "a", KEY), SecretStoreError);
      assert.equal(files.size, 0);
      assert.deepEqual(writes, []);
    }
  });

  // Guard: a second create must not replace the first key (seal.ts adopts the existing key on SecretStoreError).
  it("create on an existing blob throws SecretStoreError and leaves the blob byte-identical", () => {
    const { p, files } = rig();
    p.secretStore.create("svc", "acct", KEY);
    const [file] = [...files.keys()];
    const before = files.get(file!);
    const other = Buffer.alloc(32, 7);
    assert.throws(() => p.secretStore.create("svc", "acct", other), SecretStoreError);
    assert.equal(files.get(file!), before);
    assert.equal([...files.keys()].filter((f) => f.endsWith(".dpapi")).length, 1);
  });

  it("a failed disk write is a SecretStoreError too", () => {
    const { p } = rig({ writeFile: () => { throw new Error("EACCES"); } });
    assert.throws(() => p.secretStore.create("s", "a", KEY), SecretStoreError);
  });
});

describe("win32 fsSecurity, office, shell", () => {
  it("ownerOnly grants the folder (no /T), then resets the children to inherit, and never throws", () => {
    const { p, calls } = rig({ readdir: () => ["a.txt"] });
    assert.equal(p.fsSecurity.ownerOnly("C:\\d", true), undefined);
    assert.deepEqual(calls[0], { command: "C:\\Windows\\System32\\whoami.exe", args: ["/user", "/fo", "csv", "/nh"] });
    assert.deepEqual(calls[1], { command: "icacls", args: ["C:\\d", "/reset", "/C", "/Q"] });
    assert.deepEqual(calls[2], { command: "icacls", args: ["C:\\d", "/inheritance:r", "/grant:r", "PC\\Ana:(OI)(CI)F", "/C", "/Q"] }); // no SID from the rig's whoami: falls back to DOMAIN\\name
    assert.deepEqual(calls[3], { command: "icacls", args: ["C:\\d\\*", "/reset", "/T", "/L", "/C"] });
    const bad = rig({ readdir: () => [], run: () => { throw new Error("no icacls"); } });
    assert.doesNotThrow(() => bad.p.fsSecurity.ownerOnly("C:\\d", false));
    assert.doesNotThrow(() => createWin32({ env: {} }).fsSecurity.ownerOnly("C:\\d", false));
  });

  it("office is all false and the dialect is cmd", () => {
    const { p } = rig();
    assert.deepEqual(p.office, { liveExcel: false, render: false, thumbnails: false });
    assert.equal(p.shellDialect.kind, "cmd");
    assert.equal(p.name, "win32");
  });

  it("hookCommand is the shared hook command", () => {
    const { p } = rig();
    const s = { dataHome: "C:\\h", launcher: "C:\\l.mjs", hookPath: "C:\\k.js", host: "claude" };
    assert.deepEqual(p.hookCommand.parse(p.hookCommand.build(s)), s);
  });
});
