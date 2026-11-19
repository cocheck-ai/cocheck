// Windows PDF pictures. A PDF page whose PNG was fully written counts even though powershell.exe crashes (0xC0000005) at exit.
// Run on any OS with createWin32 fakes: no real powershell runs.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { createWin32, platformFor, type Win32Deps } from "../src/platform/index.ts";
import { pdfScriptForTest } from "../src/platform/win32-docrender.ts";

const SYS = "C:\\Windows";
const CRASH = 3221225477; // 0xC0000005
const OUT = "C:\\t\\page-1.png";

function rig(existing: string[] = []): { deps: Partial<Win32Deps>; spawns: any[]; onSpawn: { fn: (child: any) => void } } {
  const spawns: any[] = [];
  const onSpawn = { fn: (_c: any): void => undefined };
  const deps: Partial<Win32Deps> = {
    env: { SystemRoot: SYS },
    exists: (f) => existing.includes(f) || existsSync(f),
    run: () => ({ status: 0, stdout: "", stderr: "" }),
    kill: () => undefined,
    spawn: ((command: string, args: string[], options: Record<string, any>) => {
      const child: any = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { end: () => undefined });
      spawns.push({ command, args, options });
      setImmediate(() => onSpawn.fn(child));
      return child;
    }) as any,
  };
  return { deps, spawns, onSpawn };
}
const pngOf = (r: ReturnType<typeof rig>, n = 1) => createWin32(r.deps).docRender!.pdf.png("C:\\t\\a.pdf", n, OUT, 300);

describe("(1) darwin", () => {
  it("darwin is unchanged: no docRender", () => {
    assert.equal(platformFor("darwin").docRender, undefined);
  });
});

describe("(2,3) png accepts a finished write despite the exit crash", () => {
  const ps = `${SYS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  it("PNG-OK + file + exit 0xC0000005 is ok", async () => {
    const r = rig([OUT, ps]);
    r.onSpawn.fn = (c) => { c.stdout.emit("data", Buffer.from("PNG-OK\n")); c.emit("close", CRASH); };
    assert.equal(await pngOf(r), "ok");
  });
  it("PNG-OK with CRLF and a clean exit is ok", async () => {
    const r = rig([OUT, ps]);
    r.onSpawn.fn = (c) => { c.stdout.emit("data", Buffer.from("noise\r\nPNG-OK\r\n")); c.emit("close", 0); };
    assert.equal(await pngOf(r), "ok");
  });
  it("crash before the marker fails, even if a file is there", async () => {
    const r = rig([OUT, ps]);
    r.onSpawn.fn = (c) => c.emit("close", CRASH);
    assert.equal(await pngOf(r), "failed");
  });
  it("a marker mid-line does not count", async () => {
    const r = rig([OUT, ps]);
    r.onSpawn.fn = (c) => { c.stdout.emit("data", Buffer.from("xPNG-OK\n")); c.emit("close", CRASH); };
    assert.equal(await pngOf(r), "failed");
  });
  it("PNG-OK but no file fails", async () => {
    const r = rig([ps]);
    r.onSpawn.fn = (c) => { c.stdout.emit("data", Buffer.from("PNG-OK\n")); c.emit("close", CRASH); };
    assert.equal(await pngOf(r), "failed");
  });
  it("a hang is still timeout", async () => {
    const r = rig([OUT, ps]);
    r.onSpawn.fn = () => undefined;
    // taskkill (d.run) does not close the fake child; the hard stop resolves it as timedOut
    const res = await Promise.race([createWin32(r.deps).docRender!.pdf.png("C:\\t\\a.pdf", 1, OUT, 50), new Promise((x) => setTimeout(() => x("hung"), 6500))]);
    assert.equal(res, "timeout");
  });
  it("invalid page number is failed", async () => {
    assert.equal(await pngOf(rig([OUT, ps]), 0), "failed");
  });
});

describe("(3,4) pages and the script", () => {
  const ps = `${SYS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  it("pages: still needs exit 0 (a crash is failed)", async () => {
    const r = rig([ps]);
    r.onSpawn.fn = (c) => { c.stdout.emit("data", Buffer.from("1 100 200\n")); c.emit("close", CRASH); };
    assert.equal(await createWin32(r.deps).docRender!.pdf.pages("C:\\t\\a.pdf", 300), "failed");
    const ok = rig([ps]);
    ok.onSpawn.fn = (c) => { c.stdout.emit("data", Buffer.from("1 100 200\n")); c.emit("close", 0); };
    assert.deepEqual(await createWin32(ok.deps).docRender!.pdf.pages("C:\\t\\a.pdf", 300), { pages: [{ index: 1, width: 100, height: 200 }] });
  });
  it("script writes to a .part file, renames, and prints the marker only after the rename", () => {
    const s = pdfScriptForTest;
    const iPart = s.indexOf("$tmp=$out+'.part'");
    const iMove = s.indexOf("[IO.File]::Move($tmp,$out)");
    const iMark = s.indexOf("PNG-OK");
    assert.ok(iPart >= 0 && iMove > iPart && iMark > iMove);
    // every drawing mode (png and pngs): the marker is written and flushed, then the streams are disposed
    const marks = [...s.matchAll(/PNG-OK/g)].map((m) => m.index!);
    assert.equal(marks.length, 2);
    for (const m of marks) {
      const flush = s.indexOf("[Console]::Out.Flush()", m);
      const disp = s.indexOf("$r.Dispose(); $s.Dispose(); $p.Dispose()", m);
      assert.ok(flush > m && disp > flush, "dispose follows the marker flush in each mode");
    }
    assert.ok(!/\[IO\.File\]::Move\(\$tmp,\$out\);[^}]*Dispose/.test(s), "Draw does not dispose before the marker");
    // braces balance: the join/replace cleanup left a well-formed if/else
    assert.equal((s.match(/\{/g) ?? []).length, (s.match(/\}/g) ?? []).length);
  });
});
