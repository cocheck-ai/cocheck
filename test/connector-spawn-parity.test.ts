// How CoCheck launches a third-party connector, the same on macOS, Windows and Linux.
// Acceptance tests written before the build: every test that needs the runner is skipped ("awaiting connector runner build"), so it runs and
// reports its failure without failing the suite. The build item removes skipped. The runner module is imported inside each test, so a missing
// module fails that one test, not the file load or tsc. Contract the build must meet (src/connector/runner.ts):
//   startConnector({ dir, run, env? }) -> Promise<{ hello, call(method, params, { timeoutMs }), log(), stop() }>
//   `run` is the manifest argv, resolved from `dir`, spawned with no shell and no shebang reliance (Windows .cmd/.exe via PATHEXT through
//   src/platform/); one JSON message per line on stdin/stdout; `hello` is sent first and its result is `handle.hello`.
// The stand-in connector below is a plain Node script (no shebang, not executable), so these files need no OS tool and run on all three OSes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { platform } from "../src/platform/index.ts";

const RUNNER = "../src/connector/runner.ts";

interface Handle {
  hello: Record<string, unknown>;
  call(method: string, params: unknown, opts: { timeoutMs: number }): Promise<unknown>;
  log(): string;
  stop(): Promise<void>;
}
type Start = (opts: { dir: string; run: string[]; env?: Record<string, string> }) => Promise<Handle>;

async function runner(): Promise<Start> {
  const mod = (await import(RUNNER)) as { startConnector?: Start };
  assert.equal(typeof mod.startConnector, "function", "src/connector/runner.ts must export startConnector");
  return mod.startConnector as Start;
}

/** A line-JSON connector: hello answers with what the child saw; `slow` never answers. */
const STAND_IN = `
import readline from "node:readline";
import { writeFileSync } from "node:fs";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line.replace(/\\r$/, ""));
  if (msg.method === "hello") {
    const out = { ok: true, pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2) };
    process.stdout.write(JSON.stringify({ id: msg.id, result: out }) + "\\n");
  } else if (msg.method === "slow") {
    // never answers
  } else {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { echo: msg.params } }) + "\\n");
  }
});
`;

function scratch(name = "cocheck-"): string {
  return mkdtempSync(path.join(tmpdir(), name));
}

function connectorDir(parent: string, folder: string): string {
  const dir = path.join(parent, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "connector.mjs"), STAND_IN); // no shebang, default (non-executable) mode
  return dir;
}

async function dead(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!platform().process.alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("S1 manifest argv runs with no shell: metacharacters arrive as plain arguments, a non-executable script without a shebang starts", async () => {
  const start = await runner();
  const dir = connectorDir(scratch(), "plain");
  const nasty = ['a b', 'say "hi"', "x;touch PWNED", "$(touch PWNED)", "%PATH%", "&& echo no", "it's"];
  const h = await start({ dir, run: [process.execPath, "connector.mjs", ...nasty] });
  try {
    assert.deepEqual(h.hello.argv, nasty);
    assert.equal(existsSync(path.join(dir, "PWNED")), false, "a shell ran part of the argv");
  } finally {
    await h.stop();
  }
});

test("S1 Windows: a bare .cmd stand-in resolves through PATHEXT and runs", { skip: process.platform === "win32" ? false : "Windows only (PATHEXT, batch files)" }, async () => {
  const start = await runner();
  const bin = scratch();
  const dir = connectorDir(scratch(), "cmd");
  writeFileSync(path.join(bin, "cocheck-standin.cmd"), `@echo off\r\n"${process.execPath}" "${path.join(dir, "connector.mjs")}" %*\r\n`);
  const h = await start({ dir, run: ["cocheck-standin", "with space"], env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" } });
  try {
    assert.deepEqual(h.hello.argv, ["with space"]);
  } finally {
    await h.stop();
  }
});

test("S2 a connector folder with spaces and non-ASCII characters starts, and relative argv resolves from that folder", async () => {
  const start = await runner();
  const dir = connectorDir(scratch(), "Müller connector été 日本 dir");
  const h = await start({ dir, run: [process.execPath, "connector.mjs"] });
  try {
    assert.equal(realpathSync(String(h.hello.cwd)), realpathSync(dir));
    assert.deepEqual(await h.call("echo", { name: "été 日本" }, { timeoutMs: 5000 }), { echo: { name: "été 日本" } });
  } finally {
    await h.stop();
  }
});

test("S3 a call that outlives its timeout rejects with a timeout error and the child process is gone", async () => {
  const start = await runner();
  const dir = connectorDir(scratch(), "slow");
  const h = await start({ dir, run: [process.execPath, "connector.mjs"] });
  const pid = Number(h.hello.pid);
  assert.ok(Number.isInteger(pid) && pid > 0, "hello must carry the child's pid for this test");
  try {
    await assert.rejects(h.call("slow", {}, { timeoutMs: 300 }), /time(?:d)? ?out/i);
    assert.equal(await dead(pid), true, "the timed-out connector is still running");
  } finally {
    await h.stop();
  }
});

// ---- bare-name PATH on posix, trailing \r, crash, timeouts, one process per id, stop ----

/** Answers hello with CRLF line ends; `crash` exits the process; `noreply` for hello hangs when started with that argument. */
const CRLF_STAND_IN = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line.replace(/\\r$/, ""));
  if (msg.method === "crash") process.exit(3);
  if (msg.method === "hello" && process.argv[2] === "silent") return;
  process.stdout.write(JSON.stringify({ id: msg.id, result: { pid: process.pid, echo: msg.params } }) + "\\r\\n");
});
`;

function crlfDir(manifest?: unknown): string {
  const dir = path.join(scratch("cocheck-"), "crlf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "connector.mjs"), CRLF_STAND_IN);
  if (manifest !== undefined) writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify(manifest));
  return dir;
}

test("S1 a bare program name resolves through PATH on posix, with no shebang on the connector script (the Windows twin is the .cmd test above and the PATHEXT unit test)", { skip: process.platform === "win32" ? "posix launcher script; Windows uses the .cmd test" : false }, async () => {
  const start = await runner();
  const bin = scratch();
  const dir = connectorDir(scratch(), "bare");
  const launcher = path.join(bin, "cocheck-standin");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, "connector.mjs")}" "$@"\n`, { mode: 0o755 });
  const h = await start({ dir, run: ["cocheck-standin", "with space"], env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } });
  try {
    assert.deepEqual(h.hello.argv, ["with space"]);
  } finally {
    await h.stop();
  }
});

test("S1 a program name that is not on PATH rejects naming the program, and starts nothing", async () => {
  const start = await runner();
  await assert.rejects(start({ dir: connectorDir(scratch(), "nobin"), run: ["cocheck-no-such-program"] }), /cocheck-no-such-program/);
});

test("S1 one JSON message per line: CRLF line ends from the connector are tolerated", async () => {
  const start = await runner();
  const h = await start({ dir: crlfDir(), run: [process.execPath, "connector.mjs"] });
  try {
    assert.deepEqual(await h.call("echo", { a: 1 }, { timeoutMs: 5000 }), { pid: h.hello.pid, echo: { a: 1 } });
  } finally {
    await h.stop();
  }
});

test("S3 a call with no timeout is refused, so no wait is unbounded", async () => {
  const start = await runner();
  const h = await start({ dir: crlfDir(), run: [process.execPath, "connector.mjs"] });
  try {
    await assert.rejects(h.call("echo", {}, {} as { timeoutMs: number }), /timeoutMs/);
    await assert.rejects(h.call("echo", {}, { timeoutMs: Number.POSITIVE_INFINITY }), /timeoutMs/);
  } finally {
    await h.stop();
  }
});

test("S3 the timeout error names the method", async () => {
  const start = await runner();
  const h = await start({ dir: connectorDir(scratch(), "slow2"), run: [process.execPath, "connector.mjs"] });
  try {
    await assert.rejects(h.call("slow", {}, { timeoutMs: 200 }), /"slow".*timed out/);
  } finally {
    await h.stop();
  }
});

test("S3 a connector that never answers hello rejects within helloTimeoutMs and the child is gone (must not: a hung connector must not hold CoCheck)", async () => {
  const start = (await runner()) as unknown as (o: Record<string, unknown>) => Promise<Handle>;
  const t0 = Date.now();
  await assert.rejects(start({ dir: crlfDir(), run: [process.execPath, "connector.mjs", "silent"], helloTimeoutMs: 400 }), /hello.*timed out/);
  assert.ok(Date.now() - t0 < 8000, "the hello wait was not bounded");
});

test("S3 a crashed connector: the next call rejects naming the connector, and it is not restarted", async () => {
  const start = await runner();
  const h = await start({ dir: crlfDir({ id: "crash", version: "1" }), run: [process.execPath, "connector.mjs"] });
  const pid = Number(h.hello.pid);
  await assert.rejects(h.call("crash", {}, { timeoutMs: 5000 }), /crash/);
  assert.equal(await dead(pid), true);
  await assert.rejects(h.call("echo", {}, { timeoutMs: 5000 }), /crash/);
  await h.stop();
  // a fresh start after a crash is a new process, started by the caller; the runner itself never restarts one
  const again = await start({ dir: crlfDir({ id: "crash", version: "1" }), run: [process.execPath, "connector.mjs"] });
  try {
    assert.notEqual(again.hello.pid, pid);
  } finally {
    await again.stop();
  }
});

test("S3 one long-lived process per connector id: a second start returns the same process, stop() ends it", async () => {
  const start = await runner();
  const dir = crlfDir({ id: "once", version: "1" });
  const a = await start({ dir, run: [process.execPath, "connector.mjs"] });
  const b = await start({ dir, run: [process.execPath, "connector.mjs"] });
  const pid = Number(a.hello.pid);
  assert.equal(b.hello.pid, a.hello.pid);
  assert.equal(await a.call("echo", 1, { timeoutMs: 5000 }).then(() => true), true);
  await a.stop();
  assert.equal(await dead(pid), true, "stop() left the process running");
  await assert.rejects(a.call("echo", 1, { timeoutMs: 1000 }), /once/);
});

test("S3 stop() ends the process through the platform's terminate", async () => {
  const start = await runner();
  const h = await start({ dir: crlfDir(), run: [process.execPath, "connector.mjs"] });
  const pid = Number(h.hello.pid);
  const real = platform().process.terminate;
  const seen: number[] = [];
  (platform().process as { terminate: (p: number) => void }).terminate = (p) => {
    seen.push(p);
    real(p);
  };
  try {
    await h.stop();
  } finally {
    (platform().process as { terminate: (p: number) => void }).terminate = real;
  }
  assert.deepEqual(seen, [pid]);
  assert.equal(await dead(pid), true);
});
