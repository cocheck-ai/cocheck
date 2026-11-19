import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guardKit } from "../src/credit-guard.ts";
import { cannotHaveWritten, lexicalProbe, writeScope, type PathProbe } from "../src/attribution/write-scope.ts";

// On win32 writeScope reads a bounded set of PowerShell and cmd forms with literal drive paths (mapped to Git Bash's /c/... form), so an
// agent's plain PowerShell write is known and the other open calls can be excluded from it. Every other form stays unknown (never excluded).
const WIN = guardKit("win32");
const MAC = guardKit("darwin");
const CWD = "C:\\Users\\t\\work";
const W = "/c/Users/t/work";
const clean = { tagged: true, wrote: 0, spawned: false, covered: true, starts: [] };
const ps = (cmd: string, pre: PathProbe = lexicalProbe) => writeScope(cmd, CWD, { kit: WIN, pre, shell: "powershell" });
const bash = (cmd: string) => writeScope(cmd, CWD, { kit: WIN, pre: lexicalProbe });
const targets = (s: ReturnType<typeof writeScope>) => {
  assert.equal(s.known, true, JSON.stringify(s));
  return (s as { targets: Array<{ path: string; tree: boolean; removes?: true }> }).targets.map((t) => `${t.path}${t.tree ? " tree" : ""}${t.removes ? " rm" : ""}`).sort();
};
/** The call provably did not write `file` (the exclusion the scope feeds). */
const cannot = (s: ReturnType<typeof writeScope>, file: string) => cannotHaveWritten(file, s, clean, lexicalProbe, WIN);

describe("PowerShell forms (the host's PowerShell tool)", () => {
  it("Set-Content -Path with a C:\\ path", () => {
    const s = ps("Set-Content -Path C:\\Users\\t\\work\\out.txt -Value 'x'");
    assert.deepEqual(targets(s), [`${W}/out.txt`]);
    assert.equal(cannot(s, `${CWD}\\other.py`), true);
    assert.equal(cannot(s, `${CWD}\\out.txt`), false);
  });
  it("Add-Content -LiteralPath with a C:/ path", () => assert.deepEqual(targets(ps("Add-Content -LiteralPath C:/Users/t/work/log.txt -Value hi")), [`${W}/log.txt`]));
  it("Set-Content positional path and value, relative", () => assert.deepEqual(targets(ps("Set-Content out.txt 'hello world'")), [`${W}/out.txt`]));
  it("Out-File in a pipeline from a literal string, and with -InputObject", () => {
    assert.deepEqual(targets(ps("'hi' | Out-File -FilePath .\\out.txt -Encoding utf8")), [`${W}/out.txt`]);
    assert.deepEqual(targets(ps('Out-File -LiteralPath "C:\\Users\\t\\work\\o.txt" -InputObject "x" -Append')), [`${W}/o.txt`]);
  });
  it("New-Item -ItemType File writes its path (with -Name joined); -ItemType Directory writes no file", () => {
    assert.deepEqual(targets(ps("New-Item -ItemType File -Path notes.txt -Force")), [`${W}/notes.txt`]);
    assert.deepEqual(targets(ps("New-Item -Path C:\\Users\\t\\work\\sub -Name n.txt -ItemType File")), [`${W}/sub/n.txt`]);
    assert.deepEqual(targets(ps("New-Item -ItemType Directory -Path sub")), []);
  });
  it("Copy-Item writes the destination (and dest\\basename), never the source", () => {
    const s = ps("Copy-Item -Path a.txt -Destination C:\\Users\\t\\work\\out");
    assert.deepEqual(targets(s), [`${W}/out`, `${W}/out/a.txt`]);
    assert.equal(cannot(s, `${CWD}\\a.txt`), true, "the source is only read");
  });
  it("Move-Item removes the source and writes the destination tree", () => assert.deepEqual(targets(ps("Move-Item a.txt done")), [`${W}/a.txt tree rm`, `${W}/done tree`, `${W}/done/a.txt tree`]));
  it("Remove-Item removes the path as a tree (with or without -Recurse)", () => {
    assert.deepEqual(targets(ps("Remove-Item -Path old.txt")), [`${W}/old.txt tree rm`]);
    assert.deepEqual(targets(ps("Remove-Item -LiteralPath C:\\Users\\t\\work\\tmp -Recurse -Force")), [`${W}/tmp tree rm`]);
  });
  it("Rename-Item removes the source and writes the new name beside it", () => assert.deepEqual(targets(ps("Rename-Item -Path C:\\Users\\t\\work\\a.txt -NewName b.txt")), [`${W}/a.txt tree rm`, `${W}/b.txt tree`]));
  it("> and >> redirection, also on a listed cmdlet, and to $null", () => {
    assert.deepEqual(targets(ps("'x' > out.txt")), [`${W}/out.txt`]);
    assert.deepEqual(targets(ps('"x" >> C:\\Users\\t\\work\\out.txt')), [`${W}/out.txt`]);
    assert.deepEqual(targets(ps("Copy-Item a.txt b.txt 2> err.txt")), [`${W}/b.txt`, `${W}/b.txt/a.txt`, `${W}/err.txt`]);
    assert.deepEqual(targets(ps("Remove-Item old.txt 2>&1 > $null")), [`${W}/old.txt tree rm`]);
  });
  it("unambiguous parameter prefixes and aliases count; statements joined by ; and newlines", () => {
    assert.deepEqual(targets(ps("set-content -pat out.txt -va 1")), [`${W}/out.txt`]);
    assert.deepEqual(targets(ps("Copy-Item -LP a.txt -Dest b.txt; Remove-Item c.txt\nSet-Content d.txt 1")), [`${W}/b.txt`, `${W}/b.txt/a.txt`, `${W}/c.txt tree rm`, `${W}/d.txt`]);
  });
  it("powershell(.exe) -Command and pwsh -Command wrappers run inside PowerShell", () => {
    assert.deepEqual(targets(ps('powershell -NoProfile -Command "Set-Content -Path C:\\Users\\t\\work\\out.txt -Value 1"')), [`${W}/out.txt`]);
    assert.deepEqual(targets(ps("pwsh.exe -nop -c 'Remove-Item old.txt'")), [`${W}/old.txt tree rm`]);
  });
});

describe("cmd forms (through cmd /c)", () => {
  it("copy writes the destination; a source known to be a file keeps it a single file", () => {
    assert.deepEqual(targets(ps("cmd /c copy /Y a.txt C:\\Users\\t\\work\\b.txt")), [`${W}/b.txt tree`, `${W}/b.txt/a.txt tree`], "lexically the source may be a folder");
    const fileAtPre: PathProbe = { ...lexicalProbe, dirExists: (p) => p !== `${W}/a.txt` };
    assert.deepEqual(targets(ps("cmd /c copy a.txt b.txt", fileAtPre)), [`${W}/b.txt`, `${W}/b.txt/a.txt`]);
  });
  it("move removes the source and writes the destination", () => assert.deepEqual(targets(ps('cmd /c "move a.txt done"')), [`${W}/a.txt tree rm`, `${W}/done tree`, `${W}/done/a.txt tree`]));
  it("del and erase remove (a folder operand's files too)", () => {
    assert.deepEqual(targets(ps("cmd /c del /q old.txt")), [`${W}/old.txt tree rm`]);
    assert.deepEqual(targets(ps("cmd.exe /c erase C:\\Users\\t\\work\\old.txt")), [`${W}/old.txt tree rm`]);
  });
  it("ren and rename", () => {
    assert.deepEqual(targets(ps("cmd /c ren a.txt b.txt")), [`${W}/a.txt tree rm`, `${W}/b.txt tree`]);
    assert.deepEqual(targets(ps("cmd /c rename sub\\a.txt b.txt")), [`${W}/sub/a.txt tree rm`, `${W}/sub/b.txt tree`]);
  });
  it("mkdir and md write no file", () => {
    assert.deepEqual(targets(ps("cmd /c mkdir out")), []);
    assert.deepEqual(targets(ps("cmd /c md C:\\Users\\t\\work\\a b")), []);
  });
  it("type and echo with > and >>", () => {
    assert.deepEqual(targets(ps('cmd /c "type a.txt > b.txt"')), [`${W}/b.txt`]);
    assert.deepEqual(targets(ps('cmd /c "echo hi >> C:\\Users\\t\\work\\log.txt"')), [`${W}/log.txt`]);
    assert.deepEqual(targets(ps('cmd /c "echo hi > out.txt && del old.txt"')), [`${W}/old.txt tree rm`, `${W}/out.txt`]);
    assert.deepEqual(targets(ps('cmd /c "echo hi > nul"')), []);
    assert.deepEqual(targets(ps("cmd /c type a.txt > b.txt")), [`${W}/b.txt`], "unquoted, PowerShell itself redirects");
    assert.equal(ps("cmd /c echo hi > nul").known, false, "unquoted, PowerShell writes a file named nul: a device name, unknown");
  });
});

describe("Git Bash (the host's Bash tool) running a PowerShell wrapper", () => {
  it("powershell.exe -Command with a literal script is read as that PowerShell", () => {
    assert.deepEqual(targets(bash(String.raw`powershell.exe -NoProfile -Command "Set-Content -Path C:\Users\t\work\out.txt -Value 1"`)), [`${W}/out.txt`]);
    assert.deepEqual(targets(bash(`pwsh -Command 'Copy-Item a.txt C:/Users/t/work/b.txt'`)), [`${W}/b.txt`, `${W}/b.txt/a.txt`]);
  });
  it("existing Git Bash forms are read as before", () => {
    assert.deepEqual(targets(bash("rm -f old.txt")), [`${W}/old.txt rm`]);
    assert.equal(bash("Set-Content -Path C:\\Users\\t\\work\\y.py -Value 1").known, false, "a bare PowerShell command from the Bash tool is still unknown");
  });
});

describe("fail-closed: everything outside the bound stays unknown", () => {
  const psCases: Array<[string, string]> = [
    ["variable path", "Set-Content -Path $f -Value 1"],
    ["variable in a double-quoted path", 'Set-Content -Path "$env:TEMP\\x.txt" -Value 1'],
    ["variable value", "Set-Content -Path a.txt -Value $x"],
    ["subexpression", "Set-Content -Path a.txt -Value $(Get-Date)"],
    ["wildcard", "Remove-Item *.txt"],
    ["wildcard with -Recurse", "Remove-Item -Path C:\\Users\\t\\work\\* -Recurse"],
    ["Copy-Item -Recurse over a wildcard tree", "Copy-Item -Path src\\* -Destination dst -Recurse"],
    ["bracket wildcard in -Path", "Set-Content -Path 'a[1].txt' -Value 1"],
    ["pipeline from an unlisted cmdlet", "Get-Content a.txt | Set-Content b.txt"],
    ["pipeline into an unlisted cmdlet", "'x' | Tee-Object -FilePath out.txt"],
    ["pipeline into Copy-Item", "'a.txt' | Copy-Item -Destination b.txt"],
    ["pipeline after a listed cmdlet", "Copy-Item a b -PassThru | Set-Content c.txt"],
    ["alias sc", "sc out.txt 1"],
    ["alias del (PowerShell)", "del old.txt"],
    ["alias copy (PowerShell)", "copy a.txt b.txt"],
    ["alias ni", "ni -ItemType File x.txt"],
    ["alias echo with a redirect", "echo x > out.txt"],
    ["script block", "& { Set-Content a.txt 1 }"],
    ["Invoke-Command", "Invoke-Command -ScriptBlock { Set-Content a.txt 1 }"],
    ["UNC path", "Set-Content \\\\host\\share\\x.txt 1"],
    ["UNC destination", "Copy-Item a.txt \\\\host\\s\\b.txt"],
    ["drive-relative path", "Set-Content C:x.txt 1"],
    ["root-relative path", "Set-Content \\Users\\t\\x.txt 1"],
    ["8.3 short name", "Set-Content C:\\PROGRA~1\\x.txt 1"],
    ["trailing dot", "Set-Content C:\\Users\\t\\work\\y.py. 1"],
    ["alternate stream", "Set-Content 'C:\\Users\\t\\work\\y.py:s' 1"],
    ["ambiguous prefix -Pa", "Set-Content -Pa out.txt -Value 1"],
    ["colon parameter form", "Set-Content -Path:out.txt -Value 1"],
    ["unlisted parameter -Stream", "Set-Content out.txt 1 -Stream s"],
    ["unlisted parameter -Filter", "Remove-Item . -Filter *.txt"],
    ["comma list", "Remove-Item a.txt,b.txt"],
    ["backtick escape", 'Set-Content "a`.txt" 1'],
    ["line continuation", "Set-Content a.txt `\n 1"],
    ["smart quote", "Set-Content \u2018a.txt\u2019 1"],
    ["en dash parameter", "Set-Content \u2013Path a.txt 1"],
    ["New-Item without -ItemType", "New-Item x.txt"],
    ["New-Item SymbolicLink", "New-Item -ItemType SymbolicLink -Path l -Value C:\\x"],
    ["Copy-Item without a destination", "Copy-Item C:\\Users\\t\\a.txt"],
    ["Rename-Item -NewName with a path", "Rename-Item a.txt C:\\x\\b.txt"],
    ["comment", "Set-Content a.txt 1 # done"],
    ["too many positionals", "Remove-Item a.txt b.txt"],
    ["joined quote", "Set-Content a'.txt' 1"],
    ["powershell -File", "powershell -File x.ps1"],
    ["powershell -EncodedCommand", "powershell -EncodedCommand ZQBjAGgAbwA="],
    ["pwsh without -Command", "pwsh 'Set-Content a.txt 1'"],
    ["cmd percent variable", "cmd /c del %TEMP%\\x.txt"],
    ["cmd caret escape", "cmd /c copy a^.txt b.txt"],
    ["cmd concatenation", "cmd /c copy a.txt+b.txt c.txt"],
    ["cmd del /s", "cmd /c del /s x.txt"],
    ["cmd forward slash path", "cmd /c copy a.txt C:/Users/t/work/b.txt"],
    ["cmd /k", "cmd /k del x.txt"],
    ["cmd pipe", "cmd /c type a.txt | sort > b.txt"],
    ["cmd unlisted command", "cmd /c xcopy a b"],
    ["cmd echo. form", "cmd /c echo.>out.txt"],
    ["cmd copy with one operand", "cmd /c copy C:\\x\\a.txt"],
    ["cmd wildcard", "cmd /c del *.txt"],
    ["cmd UNC", "cmd /c del \\\\host\\s\\x.txt"],
    ["cmd group", "cmd /c (del a.txt)"],
  ];
  for (const [name, cmd] of psCases) {
    it(`${name}: unknown, never excluded`, () => {
      const s = ps(cmd);
      assert.equal(s.known, false, `${cmd} => ${JSON.stringify(s)}`);
      assert.equal(cannot(s, `${CWD}\\y.py`), false);
    });
  }
  const bashCases: Array<[string, string]> = [
    ["cmd /c from Git Bash (its /c is rewritten to C:/)", "cmd /c del C:\\Users\\t\\work\\old.txt"],
    ["cmd //c from Git Bash", "cmd //c del old.txt"],
    ["wrapper with a bash variable", 'powershell -Command "Set-Content $F 1"'],
    ["wrapper with a POSIX-looking path Git Bash rewrites", "powershell -Command 'Set-Content /c/Users/t/work/a.txt 1'"],
    ["wrapper with a redirect outside", "powershell -Command 'Set-Content a.txt 1' > log.txt"],
    ["wrapper inside a list", "cd /c/Users && powershell -Command 'Set-Content a.txt 1'"],
  ];
  for (const [name, cmd] of bashCases) {
    it(`${name}: unknown, never excluded`, () => {
      const s = bash(cmd);
      assert.equal(s.known, false, `${cmd} => ${JSON.stringify(s)}`);
      assert.equal(cannot(s, `${CWD}\\y.py`), false);
    });
  }
  it("the shell unnamed: a PowerShell or cmd command is unknown, as before", () => {
    for (const cmd of ["Set-Content -Path C:\\Users\\t\\work\\y.py -Value 1", "copy a.txt C:\\Users\\t\\work\\y.py"]) assert.equal(bash(cmd).known, false, cmd);
  });
  it("PowerShell off win32 stays unknown", () => {
    assert.equal(writeScope("Set-Content -Path out.txt -Value 1", "/w", { kit: MAC, shell: "powershell" }).known, false);
  });
  it("a relative path with no known cwd is unknown", () => {
    assert.equal(writeScope("Set-Content out.txt 1", null, { kit: WIN, shell: "powershell" }).known, false);
  });
});

describe("a call is never excluded from a file its PowerShell or cmd command can write", () => {
  const F = `${CWD}\\y.py`;
  const cases: Array<[string, string, string]> = [
    ["Set-Content", "Set-Content -Path y.py -Value 1", F],
    ["Set-Content, other case and slash", "set-content -LiteralPath c:/users/T/WORK/Y.PY -Value 1", F],
    ["Add-Content", "Add-Content y.py 1", F],
    ["Out-File", "'x' | Out-File y.py", F],
    ["redirect", "'x' >> .\\y.py", F],
    ["New-Item File", "New-Item -ItemType File -Name y.py -Path .", F],
    ["Copy-Item destination file", "Copy-Item a.txt y.py", F],
    ["Copy-Item into a destination folder", "Copy-Item C:\\Users\\t\\y.py -Destination C:\\Users\\t\\work", F],
    ["Copy-Item positional after named -Destination binds to -Path", "Copy-Item -Destination C:\\Users\\t\\work C:\\elsewhere\\y.py", F],
    ["Copy-Item positional after named -Path binds to -Destination", "Copy-Item y.py -Path a.txt", F],
    ["Copy-Item -Recurse of a folder into the work folder", "Copy-Item -Path C:\\src\\pkg -Destination C:\\Users\\t -Recurse", `C:\\Users\\t\\pkg\\y.py`],
    ["Move-Item source (removed)", "Move-Item y.py C:\\elsewhere", F],
    ["Move-Item destination", "Move-Item C:\\elsewhere\\a.txt y.py", F],
    ["Remove-Item of the folder", "Remove-Item C:\\Users\\t\\work -Recurse", F],
    ["Rename-Item source", "Rename-Item y.py z.py", F],
    ["Rename-Item new name", "Rename-Item a.py y.py", F],
    ["cmd copy into the folder (source may be a folder)", "cmd /c copy C:\\src C:\\Users\\t\\work", F],
    ["cmd move", "cmd /c move a.txt y.py", F],
    ["cmd del of the folder", "cmd /c del C:\\Users\\t\\work", F],
    ["cmd ren", "cmd /c ren a.py y.py", F],
    ["cmd echo redirect", "cmd /c echo x > y.py", F],
    ["wrapper", "powershell -Command 'Set-Content y.py 1'", F],
  ];
  for (const [name, cmd, file] of cases) {
    it(`${name}: stays creditable`, () => {
      const s = ps(cmd);
      assert.equal(s.known, true, `${cmd} => ${JSON.stringify(s)}`);
      assert.equal(cannot(s, file), false, `${cmd} => ${JSON.stringify(s)}`);
    });
  }
});
