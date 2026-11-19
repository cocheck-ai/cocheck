// The REAL native helper (src/office/connector/native/cocheck-screen.m), compiled by this test into a mkdtemp dir and spawned directly with child_process: never the dist/ binary, never a
// display, never Office. The helper is read-only: `windows {pid}`, `close`, `--max-ms` and `--start-of <pid>`. Must not happen: a helper that can still act on
// another process or the screen (guard, capture, show, hide, display) or that kills a process it was not told about: every one of those commands answers "unknown command", and a
// bystander process survives every way the helper ends.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
const mac = process.platform === "darwin";
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

let bin = "";
before(() => {
  if (!mac) return;
  const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-screen-real-"));
  bin = path.join(scratch, "cocheck-screen");
  const src = process.env.T446_SCREEN_SRC ?? path.join(ROOT, "src", "office", "connector", "native", "cocheck-screen.m");
  const r = spawnSync("clang", ["-fobjc-arc", "-O2", "-framework", "Foundation", "-framework", "CoreGraphics", src, "-o", bin], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

interface Run { helper: ChildProcess; bystander: number; lines: string[]; exit: Promise<{ code: number | null; signal: string | null }>; send(o: unknown): void; answer(req: number): Promise<Record<string, unknown>> }

async function start(args: string[] = []): Promise<Run> {
  const bystander = spawn("sleep", ["300"], { stdio: "ignore" }).pid!;
  const helper = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] });
  const lines: string[] = [];
  let buf = "";
  helper.stdout!.on("data", (d: Buffer) => { buf += String(d); let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  helper.stdin!.on("error", () => { /* helper gone */ });
  const exit = new Promise<{ code: number | null; signal: string | null }>((res) => helper.on("exit", (code, signal) => res({ code, signal })));
  const run: Run = {
    helper, bystander, lines, exit,
    send: (o) => { helper.stdin!.write(JSON.stringify(o) + "\n"); },
    answer: async (req) => {
      for (let i = 0; i < 100; i++) {
        const hit = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m.req === req);
        if (hit) return hit;
        await sleepMs(50);
      }
      throw new Error(`no answer to req ${req}; helper alive=${helper.exitCode === null}`);
    },
  };
  for (let i = 0; i < 100 && lines.length === 0; i++) await sleepMs(50);
  assert.ok(lines[0] && JSON.parse(lines[0]).ready === true, "helper never said ready");
  return run;
}

/** Always leaves nothing of ours behind: the helper and our own bystander sleep, by the pids we spawned. */
function reap(run: Run): void {
  for (const pid of [run.helper.pid!, run.bystander]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

describe("real cocheck-screen helper, read-only (macOS only)", { skip: mac ? false : "macOS only" }, () => {
  it("windows answers a list for a pid; close exits 0", async () => {
    const run = await start();
    try {
      run.send({ cmd: "windows", pid: run.bystander, req: 1 });
      const w = await run.answer(1);
      assert.equal(w.ok, true);
      assert.ok(Array.isArray(w.windows));
      run.send({ cmd: "close", req: 2 });
      assert.equal((await run.answer(2)).ok, true);
      assert.equal((await run.exit).code, 0);
    } finally { reap(run); }
  });

  it("guard, capture, show, hide, hidden, display, where, perm and request are gone: each answers unknown command", async () => {
    const run = await start();
    try {
      let req = 10;
      for (const cmd of ["guard", "capture", "show", "hide", "hidden", "display", "where", "perm", "request"]) {
        run.send({ cmd, pid: run.bystander, lstart: 1, window: 1, out: "/tmp/never.png", w: 100, h: 100, req });
        const a = await run.answer(req++);
        assert.equal(a.ok, false, cmd);
        assert.match(String(a.why), /unknown command/, cmd);
      }
      assert.ok(alive(run.bystander), "the bystander was not touched");
    } finally { reap(run); }
  });

  it("a field of the wrong type answers fail and the helper keeps running", async () => {
    const run = await start();
    try {
      run.send({ cmd: "windows", pid: "12", req: 3 });
      const a = await run.answer(3);
      assert.equal(a.ok, false);
      run.send({ cmd: "windows", pid: run.bystander, req: 4 });
      assert.equal((await run.answer(4)).ok, true);
    } finally { reap(run); }
  });

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
    it(`${sig} ends the helper cleanly and leaves a bystander alive`, async () => {
      const run = await start();
      try {
        process.kill(run.helper.pid!, sig);
        assert.equal((await run.exit).code, 0);
        assert.ok(alive(run.bystander));
      } finally { reap(run); }
    });
  }

  it("stdin EOF and --max-ms end the helper and leave a bystander alive", async () => {
    const a = await start();
    try { a.helper.stdin!.end(); assert.equal((await a.exit).code, 0); assert.ok(alive(a.bystander)); } finally { reap(a); }
    const b = await start(["--max-ms", "800"]);
    try { assert.equal((await b.exit).code, 0); assert.ok(alive(b.bystander)); } finally { reap(b); }
  });

  it("--start-of prints a pid's kernel start time as seconds.microseconds, and exits 1 for a pid that is not there", () => {
    const own = spawnSync(bin, ["--start-of", String(process.pid)], { encoding: "utf8" });
    assert.equal(own.status, 0);
    assert.match(own.stdout, /^\d{10}\.\d{6}\n$/);
    const secs = Number(own.stdout.split(".")[0]);
    assert.ok(Math.abs(secs - Date.now() / 1000) < 10 * 365 * 86400 && secs < Date.now() / 1000);
    assert.equal(spawnSync(bin, ["--start-of", "99999999"], { encoding: "utf8" }).status, 1);
    assert.equal(spawnSync(bin, ["--start-of", "0"], { encoding: "utf8" }).status, 1);
  });
});
