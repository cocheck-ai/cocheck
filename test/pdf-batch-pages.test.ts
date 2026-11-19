// Batch page drawing. The Windows script's `pngs` mode, renderPdfPages, and pdfPictures' use of it. Every OS: fake children, no powershell.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createWindowsPdf, renderPdfBytesPages, renderPdfPages, WINDOWS_PDF_SCRIPT } from "../public-kit/helpers/pdf.mjs";
import { helperPager, pdfPictures } from "../src/office/connector/pictures.ts";
import { tinyPng } from "./helpers/office-fake.ts";

const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
type Item = { n: number; out: string };

/** A backend over a fake powershell. `behave` gets the requested items and a child; the taskkill fake closes a hung child. */
function rig(behave: (items: Item[], child: any, input: string[]) => void) {
  const spawns: { command: string; args: string[]; input: string }[] = [];
  const kills: string[][] = [];
  const children: any[] = [];
  const backend = createWindowsPdf({
    env: { SystemRoot: "C:\\Windows" },
    exists: (f) => f === PS || existsSync(f),
    run: ((command: string, args: string[]) => {
      kills.push([command, ...args]);
      for (const c of children) setImmediate(() => c.emit("close", 1));
      return { status: 0 };
    }) as never,
    spawn: ((command: string, args: string[]) => {
      const child: any = new EventEmitter();
      child.pid = 777;
      child.stdout = new EventEmitter();
      const call = { command, args, input: "" };
      child.stdin = Object.assign(new EventEmitter(), { end: (d: string) => { call.input = d; } });
      spawns.push(call);
      children.push(child);
      setImmediate(() => {
        const lines = call.input.split("\n");
        const items = lines.slice(2).filter((l) => l !== "").map((l) => { const [n, o] = l.split(" "); return { n: Number(n), out: Buffer.from(o!, "base64").toString("utf8") }; });
        behave(items, child, lines);
      });
      return child;
    }) as never,
  });
  return { backend, spawns, kills };
}
const scratch = (): string => mkdtempSync(path.join(tmpdir(), "pdf-batch-"));
/** The fake draws `n` pages: writes the file, then prints the marker (the real script prints it only after the rename). */
const draw = (child: any, it: Item): void => { writeFileSync(it.out, `png${it.n}`); child.stdout.emit("data", Buffer.from(`PNG-OK ${it.n}\r\n`)); };

describe("the pngs script mode", () => {
  it("one mode, a marker per page after the rename, a .part file, no Add-Type of C# and no -EncodedCommand", () => {
    assert.match(WINDOWS_PDF_SCRIPT, /\$mode -eq 'pngs'/);
    assert.match(WINDOWS_PDF_SCRIPT, /'PNG-OK '\+\$n/);
    assert.ok(WINDOWS_PDF_SCRIPT.indexOf("$out+'.part'") < WINDOWS_PDF_SCRIPT.indexOf("[IO.File]::Move($tmp,$out)"));
    assert.ok(WINDOWS_PDF_SCRIPT.indexOf("[IO.File]::Move($tmp,$out)") < WINDOWS_PDF_SCRIPT.indexOf("'PNG-OK '+$n"));
    assert.ok(!/Add-Type\s+-(TypeDefinition|MemberDefinition)|-EncodedCommand/i.test(WINDOWS_PDF_SCRIPT));
  });
});

describe("renderPdfPages (fake runner)", () => {
  it("all pages ok: one spawn, named outputs, one status per page in order", async () => {
    const dir = scratch();
    const r = rig((items, child) => { for (const i of items) draw(child, i); child.emit("close", 0); });
    const res = await renderPdfPages("C:\\x\\state.pdf", [1, 2, 3], dir, 5_000, r.backend);
    assert.deepEqual(res.map((p) => [p.page, p.status, path.basename(p.out)]), [[1, "ok", "page-1.png"], [2, "ok", "page-2.png"], [3, "ok", "page-3.png"]]);
    assert.equal(r.spawns.length, 1);
    assert.equal(readFileSync(res[2]!.out, "utf8"), "png3");
  });
  it("a timeout after k pages keeps exactly those k and fails the rest; the kill is scoped to the child's pid", async () => {
    const dir = scratch();
    const r = rig((items, child) => { for (const i of items.slice(0, 2)) draw(child, i); /* then hangs */ });
    const res = await renderPdfPages("C:\\x\\state.pdf", [1, 2, 3, 4], dir, 60, r.backend);
    assert.deepEqual(res.map((p) => p.status), ["ok", "ok", "failed", "failed"]);
    assert.deepEqual(r.kills.map((k) => k.slice(1)), [["/PID", "777", "/T", "/F"]]);
  });
  it("a page whose marker never printed is failed even though a file exists (a half-written or stale file)", async () => {
    const dir = scratch();
    const r = rig((items, child) => {
      draw(child, items[0]!);
      writeFileSync(items[1]!.out, "half"); // written, no marker
      writeFileSync(items[2]!.out + ".part", "half");
      child.emit("close", 0);
    });
    const res = await renderPdfPages("C:\\x\\state.pdf", [1, 2, 3], dir, 5_000, r.backend);
    assert.deepEqual(res.map((p) => p.status), ["ok", "failed", "failed"]);
    assert.ok(existsSync(res[1]!.out));
  });
  it("a marker for a page nobody asked for credits nothing; a marker for page 1 never credits page 10", async () => {
    const dir = scratch();
    const r = rig((items, child) => { writeFileSync(items[1]!.out, "x"); child.stdout.emit("data", Buffer.from("PNG-OK 1\nPNG-OK 99\nPNG-OK 10x\n")); child.emit("close", 0); });
    const res = await renderPdfPages("C:\\x\\state.pdf", [10, 1], dir, 5_000, r.backend);
    assert.deepEqual(res.map((p) => [p.page, p.status]), [[10, "failed"], [1, "ok"]]);
  });
  it("a non-ASCII path and output folder travel as base64 on stdin, never on the command line", async () => {
    const dir = path.join(scratch(), "Zoë 报告");
    (await import("node:fs")).mkdirSync(dir);
    const file = "C:\\Users\\Zoë\\Désk\\报告 final.pdf";
    let seen: string[] = [];
    const r = rig((items, child, lines) => { seen = lines; for (const i of items) draw(child, i); child.emit("close", 0); });
    const res = await renderPdfPages(file, [2], dir, 5_000, r.backend);
    assert.equal(res[0]!.status, "ok");
    assert.equal(seen[0], "pngs");
    assert.equal(Buffer.from(seen[1]!, "base64").toString("utf8"), file);
    assert.equal(Buffer.from(seen[2]!.split(" ")[1]!, "base64").toString("utf8"), path.join(dir, "page-2.png"));
    assert.ok(!r.spawns[0]!.args.join(" ").includes("Zoë"));
  });
  it("no batch backend: every page failed, nothing thrown", async () => {
    const res = await renderPdfPages("x.pdf", [1, 2], scratch(), 1_000, null);
    assert.deepEqual(res.map((p) => p.status), ["failed", "failed"]);
  });
  it("renderPdfBytesPages returns bytes for finished pages and null for the rest", async () => {
    const r = rig((items, child) => { draw(child, items[0]!); child.emit("close", 0); });
    const m = await renderPdfBytesPages(Buffer.from("%PDF"), [1, 2], { windows: r.backend, timeoutMs: 5_000 });
    assert.equal(m.get(1)?.toString(), "png1");
    assert.equal(m.get(2), null);
  });
});

describe("pdfPictures", () => {
  const text = ["a", "b", "c"];
  it("with a batch pager: one pngs call per side, no per-page calls, a null page is left out and named", async () => {
    const calls: string[] = [];
    const pager = {
      pages: async () => text,
      png: async () => { calls.push("png"); return null; },
      pngs: async (_p: Buffer, pages: number[]) => { calls.push(`pngs ${pages.join(",")}`); return new Map(pages.map((n) => [n, n === 2 ? null : tinyPng(`p${n}`)])); },
    };
    const r = await pdfPictures({ before: Buffer.from("b"), after: Buffer.from("a") }, pager, 1e9, "Microsoft Word");
    assert.deepEqual(calls, ["pngs 1,2,3", "pngs 1,2,3"]);
    assert.deepEqual(r.pictures.map((p) => p.id), ["before:page1", "before:page3", "after:page1", "after:page3"]);
    assert.deepEqual(r.caveats.length, 2);
  });
  it("the Mac path is unchanged: without pngs the pager's png is called per page in the old order", async () => {
    const calls: string[] = [];
    const pager = { pages: async () => text, png: async (pdf: Buffer, n: number) => { calls.push(`${pdf.toString()}${n}`); return tinyPng("x"); } };
    await pdfPictures({ before: Buffer.from("B"), after: Buffer.from("A") }, pager, 1e9, "Microsoft Word");
    assert.deepEqual(calls, ["B1", "A1", "B2", "A2", "B3", "A3"]);
  });
  it("helperPager has no batch call off Windows", { skip: process.platform === "win32" ? "not applicable on Windows" : false }, () => assert.equal((helperPager as { pngs?: unknown }).pngs, undefined));
});
