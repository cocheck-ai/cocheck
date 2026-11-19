import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guardKit, samePath, toolMayCredit } from "../src/credit-guard.ts";
import { cannotHaveWritten, fsProbe, lexicalProbe, writeScope, type ProbeFs } from "../src/attribution/write-scope.ts";

// The credit guards read paths through the path kit, so a win32 path is judged as it is on Windows. All inputs are win32 forms, run with
// the win32 kit on any OS.
const WIN = guardKit("win32");
const MAC = guardKit("darwin");
const CWD = "C:\\Users\\t\\work";
const FILE = "C:\\Users\\t\\work\\y.py";
const same = (a: string, b: string) => samePath(a, b, false, WIN);
const may = (tool: string, fp: string | null, file = FILE) => toolMayCredit(tool, fp, file, same, WIN);
const clean = { tagged: true, wrote: 0, spawned: false, covered: true, starts: [] };
const cannot = (cmd: string, file = FILE, cwd: string | null = CWD) => cannotHaveWritten(file, writeScope(cmd, cwd, { kit: WIN, pre: lexicalProbe }), clean, lexicalProbe, WIN);

describe("toolMayCredit on win32", () => {
  it("a Write of x.py is not creditable for y.py", () => {
    assert.equal(may("Write", "C:\\Users\\t\\work\\x.py"), false);
    assert.equal(may("Edit", "C:/Users/t/work/x.py"), false);
  });
  it("a differently cased, slash or /c/ form of the same file still is", () => {
    assert.equal(may("Write", "c:\\users\\T\\WORK\\Y.PY"), true);
    assert.equal(may("Write", "C:/Users/t/work/y.py"), true);
    assert.equal(may("MultiEdit", "/c/Users/t/work/y.py"), true);
  });
  it("a relative or missing path stays creditable (unknown is the safe direction)", () => {
    assert.equal(may("Write", "x.py"), true);
    assert.equal(may("Write", null), true);
  });
  it("the Mac kit keeps its verdicts", () => {
    assert.equal(toolMayCredit("Write", "/w/x.py", "/w/y.py", (a, b) => samePath(a, b, false, MAC), MAC), false);
    assert.equal(toolMayCredit("Write", "/W/Y.py", "/w/y.py", (a, b) => samePath(a, b, false, MAC), MAC), true);
  });
});

describe("write-scope on win32", () => {
  it("a Git Bash command's scope is known from a win32 cwd, and a target that is another file excludes the call", () => {
    const s = writeScope("rm -f old.txt", CWD, { kit: WIN, pre: lexicalProbe });
    assert.equal(s.known, true, JSON.stringify(s));
    assert.equal(cannot("rm -f old.txt"), true);
    assert.equal(cannot("cd /c/Users/t/work/sub && rm -f old.txt"), true);
    assert.equal(cannot("cp a.txt b.txt", "C:/Users/t/work/y.py"), true);
  });
  it("a PowerShell or cmd command stays unknown, never excluded", () => {
    for (const cmd of ["Set-Content -Path C:\\Users\\t\\work\\y.py -Value 1", "copy a.txt C:\\Users\\t\\work\\y.py", "echo hi > C:\\other\\out.txt", "python C:/x/run.py"]) {
      assert.equal(writeScope(cmd, CWD, { kit: WIN }).known, false, cmd);
      assert.equal(cannot(cmd), false, cmd);
    }
  });
});

describe("must not: cannotHaveWritten is never true for a call that could have written the file (win32 inputs)", () => {
  const cases: Array<[string, string, string]> = [
    ["redirect to the file (Git Bash form)", "echo x > /c/Users/t/work/y.py", FILE],
    ["redirect to the file, other case", "echo x > /c/users/T/WORK/Y.PY", FILE],
    ["redirect to the file, relative", "echo x > y.py", FILE],
    ["append to the file", "echo x >> ./y.py", "c:/users/t/work/Y.py"],
    ["cp target", "cp a.txt /c/Users/t/work/y.py", FILE],
    ["mv target", "mv a.txt y.py", FILE],
    ["relative path after cd", "cd /c/Users/t/work/sub && echo x > ../y.py", FILE],
    ["relative path after cd into the folder", "cd /c/Users/t/work && cp a y.py", FILE],
    ["tree removal holding the file", "rm -rf /c/Users/t/work", FILE],
  ];
  for (const [name, cmd, file] of cases) {
    it(`${name}: stays creditable`, () => {
      assert.equal(cannot(cmd, file), false, JSON.stringify(writeScope(cmd, CWD, { kit: WIN, pre: lexicalProbe })));
    });
  }
  it("an unknown command stays creditable", () => {
    assert.equal(cannot("somecustomtool --go"), false);
    assert.equal(cannot("python3 edit.py"), false);
    assert.equal(cannot("rm -f out.txt", FILE, null), false, "relative target, unknown cwd");
    assert.equal(cannot("echo hi > out.txt"), false, "redirects are unknown");
    assert.equal(cannot("echo hi > $X/y.py"), false);
  });
  it("a call whose cwd is not an absolute win32 path leaves relative targets unknown", () => {
    assert.equal(writeScope("echo x > y.py", "work\\sub", { kit: WIN }).known, false);
  });
});

// the live probe on win32: a fake filesystem keyed only by the native `C:\\...` form, so any `/c/...` lookup would miss
describe("fsProbe on win32 reads through kit.native", () => {
  const dirs = new Set(["C:\\Users", "C:\\Users\\T", "C:\\Users\\T\\work", "C:\\Users\\T\\link", "C:\\Users\\T\\work\\out"]);
  const files = new Set(["C:\\Users\\T\\work\\a.txt", "C:\\Users\\T\\work\\b.txt", "C:\\Users\\T\\work\\other.txt"]);
  const seen: string[] = [];
  const mk = (links: string[] = []): ProbeFs => ({
    lstat(p) {
      seen.push(p);
      const isDir = dirs.has(p);
      const isLink = links.includes(p);
      if (!isDir && !files.has(p) && !isLink) throw new Error("ENOENT");
      return { isSymbolicLink: () => isLink, isFile: () => files.has(p), isDirectory: () => isDir, uid: 0, nlink: 1 };
    },
    readlink: () => "C:\\Users\\T\\work",
    exists: (p) => dirs.has(p) || files.has(p),
  });
  const env = { USERPROFILE: "C:\\Users\\T" };
  const OTHER = "C:\\Users\\T\\work\\other.txt";
  const wcwd = "C:\\Users\\T\\work";

  it("a Git Bash cp a.txt out (a folder) from a win32 cwd excludes the call for other.txt; cp a.txt b.txt (the analyzer reads b.txt as maybe a folder, on the Mac too) stays creditable", () => {
    const probe = fsProbe(env, WIN, mk());
    assert.equal(cannotHaveWritten(OTHER, writeScope("cp a.txt b.txt", wcwd, { pre: probe, kit: WIN }), clean, probe, WIN), false);
    const scope = writeScope("cp a.txt out", wcwd, { pre: probe, kit: WIN });
    assert.equal(scope.known, true, JSON.stringify(scope));
    assert.equal(cannotHaveWritten(OTHER, scope, clean, probe, WIN), true);
    assert.ok(seen.length > 0 && seen.every((p) => p.startsWith("C:\\")), seen.join(" | "));
  });
  it("must not: the file the call writes (any case or form) is never excluded", () => {
    const probe = fsProbe(env, WIN, mk());
    const scope = writeScope("cp a.txt out", wcwd, { pre: probe, kit: WIN });
    for (const f of ["C:\\Users\\T\\work\\out\\a.txt", "c:/users/t/WORK/OUT/A.TXT", "/c/Users/T/work/out/a.txt", "C:\\Users\\T\\work\\out"]) assert.equal(cannotHaveWritten(f, scope, clean, probe, WIN), false, f);
    const tree = writeScope("rm -rf /c/Users/T/work", wcwd, { pre: probe, kit: WIN });
    assert.equal(cannotHaveWritten(OTHER, tree, clean, probe, WIN), false);
  });
  it("a link on the way is never followed: the scope is unknown or the call stays creditable", () => {
    const probe = fsProbe(env, WIN, mk(["C:\\Users\\T\\link"]));
    const scope = writeScope("cp a.txt /c/Users/T/link/b.txt", wcwd, { pre: probe, kit: WIN });
    assert.equal(cannotHaveWritten(OTHER, scope, clean, probe, WIN), false);
  });
  it("a curl config in the Windows home keeps the call creditable", () => {
    const fs = mk();
    const withCfg: ProbeFs = { ...fs, exists: (p) => p === "C:\\Users\\T\\_curlrc" || fs.exists(p) };
    assert.equal(fsProbe(env, WIN, withCfg).curlConfig(), true);
    assert.equal(fsProbe(env, WIN, fs).curlConfig(), false);
  });
});

// On win32 a path word is known only as a plain `/c/seg/seg` drive form; every alias form is unknown, so the call stays creditable
describe("fail-closed: Windows aliases of the file are never read as another file", () => {
  const aliases: Array<[string, string, string]> = [
    ["8.3 short name of a folder", "rm -f /c/PROGRA~1/y.py", "C:\\Program Files\\y.py"],
    ["8.3 short name of a relative segment", "rm -f WORK~1/y.py", FILE],
    ["8.3 short name after cd", "cd /c/Users/t/WORK~1 && rm -f y.py", FILE],
    ["/cygdrive form", "rm -f /cygdrive/c/Users/t/work/other.py", FILE],
    ["msys /tmp mount", "rm -f /tmp/other.py", "C:\\Users\\t\\AppData\\Local\\Temp\\y.py"],
    ["msys /usr mount", "rm -f /usr/bin/other", "C:\\Program Files\\Git\\usr\\bin\\y"],
    ["msys /home mount", "rm -f /home/t/other.py", FILE],
    ["/dev and /proc", "rm -f /dev/other /proc/other", FILE],
    ["UNC host", "rm -f //host/share/other.py", FILE],
    ["trailing dot", "rm -f /c/Users/t/work/y.py.", FILE],
    ["trailing space", "rm -f '/c/Users/t/work/y.py '", FILE],
    ["trailing dot, relative", "rm -f other.py.", FILE],
    ["alternate stream", "rm -f '/c/Users/t/work/y.py:s'", FILE],
    ["percent expansion", "rm -f '/c/Users/%USERPROFILE%/other.py'", FILE],
    ["device name", "rm -f /c/Users/t/work/nul", FILE],
    ["cp destination folder alias", "cp a.txt /c/PROGRA~1", "C:\\Program Files\\a.txt"],
  ];
  for (const [name, cmd, file] of aliases) {
    it(`${name}: unknown, the call stays creditable`, () => {
      const s = writeScope(cmd, CWD, { kit: WIN, pre: lexicalProbe });
      assert.equal(s.known, false, JSON.stringify(s));
      assert.equal(cannot(cmd, file), false);
    });
  }
  it("a cwd that is not a plain drive form makes the scope unknown", () => {
    for (const cwd of ["C:\\PROGRA~1\\x", "\\\\host\\share\\x", "C:\\Users\\t\\work.", "/cygdrive/c/x"]) assert.equal(writeScope("rm -f a.txt", cwd, { kit: WIN, pre: lexicalProbe }).known, false, cwd);
  });
  it("the plain drive form stays known and excludes another file", () => {
    assert.equal(cannot("rm -f old.txt"), true);
    assert.equal(cannot("rm -f /c/Users/t/work/sub.dir/old-1.txt"), true);
  });
});
