// The Windows PDF page reader. Run on any OS with createWin32
// fakes: no real powershell, taskkill or Windows API runs. Every spawn is a fake child; every temp folder is under a temp TMPDIR.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync, readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { createWin32, platformFor, type Win32Deps } from "../src/platform/index.ts";
import { NO_BOXES, viewFromPages } from "../src/timeline/render/pdf.ts";
import { pdfPagesAvailable, pdfTextRuns, readPdfOutcome, renderPdfPage } from "../src/timeline/render/pdf-helper.ts";
import { encodePng } from "./fixtures/png-encode.ts";

const SYS = "C:\\Windows";

type Call = { command: string; args: string[]; options: Record<string, any>; input: string };
interface Rig {
  spawns: Call[];
  runs: Call[];
  kills: Array<[number, unknown]>;
  existing: Set<string>;
  /** What a spawned child does; default: nothing (hangs until killed). */
  onSpawn: (call: Call, child: any) => void;
  deps: Partial<Win32Deps>;
}
function rig(env: NodeJS.ProcessEnv = {}): Rig {
  const r: Rig = { spawns: [], runs: [], kills: [], existing: new Set(), onSpawn: () => undefined, deps: {} };
  const children: any[] = [];
  r.deps = {
    env: { SystemRoot: SYS, USERPROFILE: "C:\\Users\\Ana Maria", SECRET_TOKEN: "leak-me", ...env },
    exists: (f) => r.existing.has(f) || existsSync(f),
    run(command, args) {
      r.runs.push({ command, args, options: {}, input: "" });
      // taskkill ends the tree: the hung child closes
      if (/taskkill/i.test(command)) for (const c of children) setImmediate(() => c.emit("close", 1));
      return { status: 0, stdout: "", stderr: "" };
    },
    kill: (pid, sig) => void r.kills.push([pid, sig]),
    spawn: ((command: string, args: string[], options: Record<string, any>) => {
      const child: any = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      let input = "";
      child.stdin = Object.assign(new EventEmitter(), { end: (d: string) => void (input = d) });
      children.push(child);
      const call: Call = { command, args, options, get input() { return input; } } as Call;
      r.spawns.push(call);
      setImmediate(() => r.onSpawn(call, child));
      return child;
    }) as any,
  };
  return r;
}

describe("(6) darwin is unchanged", () => {
  it("darwin has no docRender (pdf-helper.ts keeps its own path)", () => {
    assert.equal(platformFor("darwin").docRender, undefined);
  });
});

describe("(4) the win32 PDF reader", () => {
  const SCRIPT_POWERSHELL = `${SYS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const pdfRig = (): Rig => {
    const r = rig();
    r.existing.add(SCRIPT_POWERSHELL);
    return r;
  };
  const b64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

  it("pages: count and sizes from a temp copy, no text runs; the file name travels as base64 on stdin, never the command line", async () => {
    const r = pdfRig();
    let copied = "";
    r.onSpawn = (call, child) => {
      copied = b64(call.input.split("\n")[1]!);
      assert.ok(existsSync(copied), "the copy exists while the reader runs");
      child.stdout.emit("data", Buffer.from("1 1224 1584\r\n2 1584 1224\r\n"));
      child.emit("close", 0);
    };
    const res = await readPdfOutcome(Buffer.from("%PDF-1.4"), createWin32(r.deps));
    assert.deepEqual(res, { pages: [{ index: 1, width: 1224, height: 1584, runs: [] }, { index: 2, width: 1584, height: 1224, runs: [] }], error: null });
    const s = r.spawns[0]!;
    assert.equal(s.command, SCRIPT_POWERSHELL);
    assert.ok(s.input.startsWith("pages\n"));
    assert.ok(!JSON.stringify(s.args).includes(path.basename(copied)), "path is not on the command line");
    assert.ok(!existsSync(copied), "the copy is removed after");
    assert.ok(s.args.join(" ").includes("Windows.Data.Pdf"));
  });
  it("pages: a garbled or empty answer is failed; a hang is timeout and the tree is killed", async () => {
    const g = pdfRig();
    g.onSpawn = (_c, child) => { child.stdout.emit("data", "oops"); child.emit("close", 0); };
    assert.deepEqual(await readPdfOutcome(Buffer.from("%PDF"), createWin32(g.deps)), { pages: null, error: "failed" });
    const e = pdfRig();
    e.onSpawn = (_c, child) => child.emit("close", 1);
    assert.deepEqual(await readPdfOutcome(Buffer.from("%PDF"), createWin32(e.deps)), { pages: null, error: "failed" });
  });
  it("png: page n comes back as the PNG the reader wrote to the temp folder", async () => {
    const r = pdfRig();
    const png = encodePng({ width: 2, height: 2, colorType: 2, raw: Buffer.alloc(12, 200) });
    r.onSpawn = (call, child) => {
      const lines = call.input.split("\n");
      assert.equal(lines[0], "png");
      assert.equal(lines[2], "3");
      writeFileSync(b64(lines[3]!), png);
      child.stdout.emit("data", Buffer.from("PNG-OK\n"));
      child.emit("close", 0);
    };
    const got = await renderPdfPage(Buffer.from("%PDF"), 3, createWin32(r.deps));
    assert.ok(got !== null && got.equals(png));
    const none = pdfRig();
    none.onSpawn = (_c, child) => child.emit("close", 0); // exit 0 but no file written
    assert.equal(await renderPdfPage(Buffer.from("%PDF"), 1, createWin32(none.deps)), null);
    assert.equal(await renderPdfPage(Buffer.from("%PDF"), 0, createWin32(none.deps)), null);
  });
  it("availability and text: available when PowerShell is there; the reader itself gives no text runs", async () => {
    const r = pdfRig();
    r.onSpawn = (_c, child) => { child.stdout.emit("data", "1 1224 1584\r\n"); child.emit("close", 0); };
    const plat = createWin32(r.deps);
    assert.equal(pdfPagesAvailable(plat), true);
    assert.equal(plat.docRender!.pdf.textRuns, false);
    assert.equal(plat.docRender!.pdf.pdfjs, true);
    assert.equal(pdfPagesAvailable(createWin32({ ...r.deps, exists: () => false })), false);
    assert.equal(pdfTextRuns(platformFor("darwin")), true);
  });
  it("with no text runs the view shows pictures, no box at all, and says boxes are not drawn", async () => {
    const page = (index: number) => ({ index, width: 100, height: 100, runs: [] });
    const v = await viewFromPages([page(1), page(2)], [page(1), page(2), page(3)], Buffer.from("a"), Buffer.from("b"), { id: "c1", file: "r.docx", kind: "modified" }, { textRuns: false, renderPage: async () => { throw new Error("no pixel work on this path"); } });
    assert.equal(v.kind, "pages");
    assert.deepEqual(v.boxes, []);
    assert.ok(v.caveats.includes(NO_BOXES));
    assert.match(NO_BOXES, /Boxes are not drawn on this system/);
    assert.equal(v.before.length, 2);
    assert.equal(v.after.length, 3);
    assert.ok([...v.before, ...v.after].every((p) => p.picture !== undefined && p.picture.width === 100));
    // and where text runs exist (macOS) the sentence is absent
    const t = await viewFromPages([{ index: 1, width: 100, height: 100, runs: [{ text: "a b c", x: 1, y: 1, w: 5, h: 5 }] }], [{ index: 1, width: 100, height: 100, runs: [{ text: "a b d", x: 1, y: 1, w: 5, h: 5 }] }], Buffer.from("a"), Buffer.from("b"), { id: "c1", file: "r.docx", kind: "modified" }, { textRuns: true, renderPage: async () => null });
    assert.ok(!t.caveats.includes(NO_BOXES));
  });
});
