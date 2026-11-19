import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { utimesSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openLedger } from "../src/ledger.ts";
import { resolveBuildTime, BUILD_TIME, shouldReplaceReview, ensureReviewProcess, openReviewUrl, readPortFile, readOrCreateToken, reviewHomeId, reviewLogPath, lockFilePath, preferredPortFilePath, tokenFilePath, portFilePath } from "../src/review-server.ts";

const SRC = path.join(import.meta.dirname, "..", "src");
const REVIEW_PROCESS = path.join(SRC, "review-process.ts");
const REVIEW_SERVER = path.join(SRC, "review-server.ts");
const REVIEW_CLI = path.join(import.meta.dirname, "..", "scripts", "review.ts");

/** Every pid a test saw serving, so `after` can stop whatever a test left running. */
const seenPids = new Set<number>();
const homes: string[] = [];

async function newHome(withOpenTask = false): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-review-proc-"));
  homes.push(home);
  if (withOpenTask) {
    const ledger = openLedger(home);
    const taskId = ledger.openTask("claude-desktop");
    ledger.recordRound({
      taskId,
      seq: 1,
      intent: "pass",
      clientName: "claude-desktop",
      final: true,
      lastOpId: 1,
      snapshots: [],
      rows: [
        {
          layer: "xlsx",
          kind: "value",
          before: 1,
          after: 2,
          ops: [],
          description: "C3 changed",
          detail: {},
          filePath: path.join(home, "Book.xlsx"),
          location: "Sheet1!C3",
          status: "unlogged",
        },
      ],
    });
    ledger.close();
  }
  return home;
}

function get(port: number, pathAndQuery: string, host = `127.0.0.1:${port}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: pathAndQuery, headers: { host } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

function token(home: string): string {
  return readFileSync(tokenFilePath(home), "utf8").trim();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    assert.ok(Date.now() < end, "timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function start(home: string): Promise<number> {
  const port = await ensureReviewProcess(home);
  seenPids.add(readPortFile(home)!.pid);
  return port;
}

async function stop(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await until(() => !alive(pid));
}

after(async () => {
  for (const pid of seenPids) {
    await stop(pid);
  }
  for (const home of homes) {
    await rm(home, { recursive: true, force: true });
  }
});

describe("the standalone review process", () => {
  it("keeps serving after the process that started it exits", async () => {
    const home = await newHome(true);
    const parentScript = path.join(home, "parent.ts");
    writeFileSync(
      parentScript,
      `import { ensureReviewProcess } from ${JSON.stringify(REVIEW_SERVER)};\n` +
        `process.stdout.write(String(await ensureReviewProcess(${JSON.stringify(home)})));\n`,
    );
    const parent = spawnSync(process.execPath, [parentScript], { encoding: "utf8", env: { ...process.env, COCHECK_HOME: home } });
    assert.equal(parent.status, 0, parent.stderr);
    const port = Number(parent.stdout);
    const pid = readPortFile(home)!.pid;
    seenPids.add(pid);
    assert.ok(alive(pid), "the review process outlived its parent");
    const page = await get(port, `/timeline/1/review?t=${token(home)}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /data-task="1"/);
  });

  it("a second start leaves exactly one review listener (plus the connector view listener) and exits 0 without binding", async () => {
    const home = await newHome();
    const port = await start(home);
    const first = readPortFile(home)!;
    const second = spawnSync(process.execPath, [REVIEW_PROCESS], { encoding: "utf8", env: { ...process.env, COCHECK_HOME: home }, timeout: 10_000 });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readPortFile(home), first, "the port file still names the first instance");
    assert.equal(await ensureReviewProcess(home), port, "the gateway path reuses it too");
    const lsof = spawnSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", String(first.pid)], { encoding: "utf8" });
    // The process holds two loopback listeners by design, the review port and the connector view port; a second start adds none.
    assert.equal(lsof.stdout.trim().split("\n").length, 3, `header plus the review and view listeners:\n${lsof.stdout}`);
    assert.equal(lsof.stdout.split("\n").filter((l) => l.includes(`:${port} `)).length, 1, "exactly one listener on the review port");
  });

  it("three simultaneous starts end with one live server", async () => {
    const home = await newHome();
    const runs = await Promise.all(
      [1, 2, 3].map(
        () =>
          new Promise<{ code: number | null; pid: number | undefined }>((resolve) => {
            const child = spawn(process.execPath, [REVIEW_PROCESS], { stdio: "ignore", env: { ...process.env, COCHECK_HOME: home } });
            seenPids.add(child.pid!);
            const timer = setTimeout(() => resolve({ code: null, pid: child.pid }), 4000);
            child.once("exit", (code) => {
              clearTimeout(timer);
              resolve({ code, pid: child.pid });
            });
          }),
      ),
    );
    const stillRunning = runs.filter((r) => r.code === null);
    assert.equal(stillRunning.length, 1, "exactly one start kept running");
    assert.deepEqual(runs.filter((r) => r.code !== null).map((r) => r.code), [0, 0]);
    assert.equal(readPortFile(home)!.pid, stillRunning[0]!.pid);
  });

  it("replaces a stale port file (nothing listening) with a fresh spawn", async () => {
    const home = await newHome();
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    writeFileSync(portFilePath(home), JSON.stringify({ pid: 2 ** 22 + 1, port: deadPort }));
    const port = await start(home);
    assert.notEqual(port, deadPort);
    const rec = readPortFile(home)!;
    assert.equal(rec.port, port);
    assert.notEqual(rec.pid, 2 ** 22 + 1);
    assert.equal((await get(port, "/health")).status, 200);
  });

  it("recovers from a lock left by a dead process", async () => {
    const home = await newHome();
    writeFileSync(path.join(home, "review-server.lock"), String(2 ** 22 + 1));
    const port = await start(home);
    assert.equal((await get(port, "/health")).status, 200);
  });

  it("refuses a missing or wrong token and a foreign Host with 403, on the index and a task page", async () => {
    const home = await newHome(true);
    const port = await start(home);
    const t = token(home);
    assert.equal((await get(port, `/timeline/1/review?t=${t}`)).status, 200);
    assert.equal((await get(port, "/timeline/1/review")).status, 403);
    assert.equal((await get(port, `/timeline/1/review?t=${"0".repeat(t.length)}`)).status, 403);
    assert.equal((await get(port, "/")).status, 403);
    assert.equal((await get(port, `/?t=wrong`)).status, 403);
    assert.equal((await get(port, `/timeline/1/review?t=${t}`, `evil.example:${port}`)).status, 403);
    assert.equal((await get(port, `/timeline/1/review?t=${t}`, `localhost:${port}`)).status, 200);
    // Nothing is served under /review/; a foreign Host is still refused.
    assert.equal((await get(port, `/review/1?t=${t}`)).status, 404);
    assert.equal((await get(port, `/review/1?t=${t}`, `evil.example:${port}`)).status, 403);
  });

  it("keeps the token in a 0600 file and the URL stable across a restart", async () => {
    const home = await newHome(true);
    const url1 = await openReviewUrl(home, 1);
    seenPids.add(readPortFile(home)!.pid);
    const mode = statSync(tokenFilePath(home)).mode & 0o777;
    assert.equal(mode, 0o600);
    const pid1 = readPortFile(home)!.pid;
    await stop(pid1);
    const url2 = await openReviewUrl(home, 1);
    seenPids.add(readPortFile(home)!.pid);
    assert.notEqual(readPortFile(home)!.pid, pid1, "a new process");
    assert.equal(new URL(url2).search, new URL(url1).search, "same token");
    assert.equal(new URL(url2).pathname, "/timeline/1/review");
    const res = await get(Number(new URL(url2).port), new URL(url2).pathname + new URL(url2).search);
    assert.equal(res.status, 200);
  });

  it("keeps an existing token file's contents and never widens its mode", async () => {
    const home = await newHome();
    writeFileSync(tokenFilePath(home), "a".repeat(48) + "\n", { mode: 0o600 });
    chmodSync(tokenFilePath(home), 0o600);
    const port = await start(home);
    assert.equal((await get(port, "/", `127.0.0.1:${port}`)).status, 403);
    assert.equal((await get(port, `/?t=${"a".repeat(48)}`)).status, 200);
    assert.equal(statSync(tokenFilePath(home)).mode & 0o777, 0o600);
  });

  it("the index lists tasks not signed off and links to each page", async () => {
    const home = await newHome(true);
    const port = await start(home);
    const t = token(home);
    const index = await get(port, `/?t=${t}`);
    assert.equal(index.status, 200);
    assert.match(index.body, new RegExp(`href="/timeline/1/review\\?t=${t}"`));
    assert.match(index.body, /<h3>(Today|Earlier)<\/h3>/, "the task is a row under a sentence-case section header");
    const empty = await newHome();
    const emptyPort = await start(empty);
    assert.match((await get(emptyPort, `/?t=${token(empty)}`)).body, /No sessions yet/);
  });

  it("steps down when its port file is removed", async () => {
    const home = await newHome();
    await start(home);
    const pid = readPortFile(home)!.pid;
    await rm(portFilePath(home));
    await until(() => !alive(pid), 6000);
  });

  it("`review.ts open [task]` starts the process if needed and hands the URL to the opener", async () => {
    const home = await newHome(true);
    // Outside the home: CoCheck now makes every file under it owner read/write only, so a script there would lose its x bit.
    const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-opener-"));
    const opener = path.join(scratch, "opener.sh");
    const record = path.join(scratch, "opened.txt");
    writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(record)}\n`, { mode: 0o755 });
    const env = { ...process.env, COCHECK_HOME: home, COCHECK_OPEN_CMD: opener };
    const out = execFileSync(process.execPath, [REVIEW_CLI, "open", "1"], { env, encoding: "utf8" });
    seenPids.add(readPortFile(home)!.pid);
    assert.ok(existsSync(record));
    const url = new URL(readFileSync(record, "utf8"));
    assert.equal(url.pathname, "/timeline/1/review");
    assert.doesNotMatch(out, /\?t=/, "the token is not echoed to the terminal");
    assert.equal((await get(Number(url.port), url.pathname + url.search)).status, 200);
    execFileSync(process.execPath, [REVIEW_CLI, "open"], { env, encoding: "utf8" });
    assert.equal(new URL(readFileSync(record, "utf8")).pathname, "/");
    assert.equal(new URL(readFileSync(record, "utf8")).port, url.port, "same process, no second server");
  });

  it("does not trust a port file copied from another home's live process", async () => {
    const homeA = await newHome();
    const portA = await start(homeA);
    const pidA = readPortFile(homeA)!.pid;
    const homeB = await newHome();
    writeFileSync(portFilePath(homeB), JSON.stringify({ pid: pidA, port: portA }));
    const portB = await start(homeB);
    assert.notEqual(portB, portA, "a fresh process for home B");
    assert.notEqual(readPortFile(homeB)!.pid, pidA);
    assert.ok(alive(pidA), "home A's process is untouched");
  });

  it("reclaims a lock held by a live unrelated pid with no port file", async () => {
    const home = await newHome();
    writeFileSync(path.join(home, "review-server.lock"), "1");
    const port = await start(home);
    assert.equal((await get(port, "/health")).status, 200);
  });

  it("keeps the same port across a restart of the review process", async () => {
    const home = await newHome();
    const port1 = await start(home);
    const pid1 = readPortFile(home)!.pid;
    await stop(pid1);
    const port2 = await start(home);
    assert.notEqual(readPortFile(home)!.pid, pid1);
    assert.equal(port2, port1);
  });

  it("falls back to another port when the recorded one is taken", async () => {
    const home = await newHome();
    const port1 = await start(home);
    await stop(readPortFile(home)!.pid);
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(port1, "127.0.0.1", r));
    try {
      const port2 = await start(home);
      assert.notEqual(port2, port1);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it("`review.ts open` prints the data directory and the manual start command when ensure fails", async () => {
    const home = await newHome();
    mkdirSync(path.join(home, "review-server.lock"));
    const run = spawnSync(process.execPath, [REVIEW_CLI, "open"], {
      encoding: "utf8",
      env: { ...process.env, COCHECK_HOME: home, COCHECK_REVIEW_START_TIMEOUT_MS: "1500" },
    });
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes(home), run.stderr);
    assert.ok(run.stderr.includes(`COCHECK_HOME=${home} `) && run.stderr.includes("review-process.ts"), run.stderr);
    assert.doesNotMatch(run.stderr, /\n\s+at /, "no stack trace");
  });
});

describe("an outdated review process", () => {
  /** A stand-in for a review process left by older code: answers /health with another build id. `honorsShutdown` false mimics a pre-/shutdown build. */
  function fakeOld(home: string, port: number, honorsShutdown: boolean, build = "", builtAt = ""): { pid: number } {
    const script = path.join(home, "fake-review-process.mjs");
    writeFileSync(
      script,
      `import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [home, port, homeId, honors, build, builtAt] = process.argv.slice(2);
const token = readFileSync(path.join(home, "review-token"), "utf8").trim();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/health") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ cocheck: "review", home: homeId, build: build || "old-build", builtAt: builtAt ? Number(builtAt) : undefined }));
  }
  // Like the real server: a state-changing POST needs an Origin equal to an allowed host.
  const originOk = req.headers.origin === "http://127.0.0.1:" + port || req.headers.origin === "http://localhost:" + port;
  if (url.pathname === "/shutdown" && req.method === "POST" && honors === "1" && url.searchParams.get("t") === token && originOk) {
    res.end("{}");
    server.closeAllConnections();
    return server.close(() => process.exit(0));
  }
  res.statusCode = 404;
  res.end("{}");
});
server.listen(Number(port), "127.0.0.1", () => {
  writeFileSync(path.join(home, "review-server.json"), JSON.stringify({ pid: process.pid, port: Number(port) }));
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    const child = spawn(process.execPath, [script, home, String(port), reviewHomeId(home), honorsShutdown ? "1" : "0", build, builtAt], { stdio: "ignore" });
    seenPids.add(child.pid!);
    return { pid: child.pid! };
  }

  async function freePort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const p = (s.address() as net.AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return p;
  }

  for (const honors of [true, false]) {
    it(`is replaced on the same port and URL (old process ${honors ? "honors /shutdown" : "predates it, so SIGTERM"})`, async () => {
      const home = await newHome();
      const t = readOrCreateToken(home);
      const port = await freePort();
      writeFileSync(preferredPortFilePath(home), `${port}\n`);
      const old = fakeOld(home, port, honors);
      await until(() => readPortFile(home)?.pid === old.pid);
      await until(() => !!readPortFile(home));
      assert.equal(JSON.parse((await get(port, "/health")).body).build, "old-build");
      assert.equal(await openReviewUrl(home, 1), `http://127.0.0.1:${port}/timeline/1/review?t=${t}`, "the URL stays the same");
      const now = readPortFile(home)!;
      seenPids.add(now.pid);
      assert.notEqual(now.pid, old.pid);
      assert.equal(now.port, port);
      await until(() => !alive(old.pid));
      const health = JSON.parse((await get(port, "/health")).body);
      assert.equal(health.cocheck, "review");
      assert.ok(typeof health.build === "string" && health.build !== "old-build");
      const log = readFileSync(reviewLogPath(home), "utf8");
      assert.match(log, /replac/i, "the replacement is in review.log");
      if (honors) {
        assert.match(log, /stopped through \/shutdown/, "the HTTP /shutdown path ran");
        assert.doesNotMatch(log, /needed SIGTERM/, "no SIGTERM fallback");
      } else {
        assert.match(log, /needed SIGTERM/);
      }
    });
  }

  it("shouldReplaceReview: only a strictly newer build replaces; unknown age counts as oldest", () => {
    const mine = { build: "b", builtAt: 2000 };
    assert.equal(shouldReplaceReview({ build: "a", builtAt: 1000 }, mine), true);
    assert.equal(shouldReplaceReview({ build: "a", builtAt: 3000 }, mine), false, "a newer build never yields to an older one");
    assert.equal(shouldReplaceReview({ build: "a", builtAt: 2000 }, mine), false, "a tie keeps the running one");
    assert.equal(shouldReplaceReview({ build: "a" }, mine), true, "a build that reports no age is older");
    assert.equal(shouldReplaceReview({ build: "b", builtAt: 2000 }, mine), false, "same build");
  });

  it("two builds alternating ensure: the newer one's review process is never replaced by the older one", async () => {
    const home = await newHome();
    readOrCreateToken(home);
    const port = await freePort();
    writeFileSync(preferredPortFilePath(home), `${port}\n`);
    // Ages are set around this checkout's own, since the takeover below is a real process with the real one.
    const NEWER = BUILD_TIME - 1000;
    const newer = fakeOld(home, port, true, "newer-build", String(NEWER));
    await until(() => readPortFile(home)?.pid === newer.pid);
    // The older build (say a Claude Code session in the source tree) asks for the review page, again and again.
    const older = { build: "older-build", builtAt: NEWER - 5000 };
    for (let i = 0; i < 3; i++) {
      assert.equal(await ensureReviewProcess(home, 8000, older), port);
      assert.equal(readPortFile(home)?.pid, newer.pid, `round ${i}: the older build must not replace the newer one`);
      assert.ok(alive(newer.pid));
    }
    assert.doesNotMatch(existsSync(reviewLogPath(home)) ? readFileSync(reviewLogPath(home), "utf8") : "", /replac/i);
    // A strictly newer build still takes over, and the older one then yields to it.
    assert.equal(await ensureReviewProcess(home, 8000, { build: "newest-build", builtAt: NEWER + 500 }), port);
    const now = readPortFile(home)!;
    seenPids.add(now.pid);
    assert.notEqual(now.pid, newer.pid);
    assert.equal(await ensureReviewProcess(home, 8000, older), port);
    assert.equal(readPortFile(home)?.pid, now.pid, "and the older build leaves the takeover alone");
  });

  it("build age is the stamp written at build time: touching or repacking an older build later does not make it newer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cocheck-build-age-"));
    homes.push(root);
    const mk = (name: string, builtAt: number | undefined) => {
      const dir = path.join(root, name);
      mkdirSync(dir);
      writeFileSync(path.join(dir, "index.js"), `// ${name}`);
      if (builtAt !== undefined) writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({ builtAt }));
      return dir;
    };
    const older = mk("older", 1_000_000);
    const newer = mk("newer", 2_000_000);
    // The older build is repacked / checked out / touched after the newer one was made.
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(older, later, later);
    utimesSync(path.join(older, "index.js"), later, later);
    utimesSync(path.join(older, "build-info.json"), later, later);
    assert.equal(resolveBuildTime(older), 1_000_000);
    assert.equal(resolveBuildTime(newer), 2_000_000);
    const o = { build: "o", builtAt: resolveBuildTime(older) };
    const n = { build: "n", builtAt: resolveBuildTime(newer) };
    assert.equal(shouldReplaceReview(o, n), true, "the newer build replaces the older");
    assert.equal(shouldReplaceReview(n, o), false, "the older build, touched later, still yields");
    // No stamp, no git history: age unknown counts as oldest, never as 'just now'.
    assert.equal(resolveBuildTime(mk("unstamped", undefined)), 0);
    assert.equal(resolveBuildTime(path.join(root, "corrupt-" + 1)), 0);
  });

  it("npm run build stamps dist; the stamp script writes the time once and the pack copy keeps it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-stamp-"));
    homes.push(dir);
    const script = path.join(import.meta.dirname, "..", "scripts", "stamp-build.mjs");
    execFileSync(process.execPath, [script, dir]);
    const stamp = JSON.parse(readFileSync(path.join(dir, "build-info.json"), "utf8"));
    assert.ok(Number.isInteger(stamp.builtAt) && Math.abs(stamp.builtAt - Date.now()) < 60_000);
    assert.equal(resolveBuildTime(dir), stamp.builtAt);
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"));
    // Moved the build chain into scripts/build.mjs: package.json runs it, and it runs the stamp.
    assert.match(pkg.scripts.build, /scripts\/build\.mjs/);
    const buildScript = readFileSync(path.join(import.meta.dirname, "..", "scripts", "build.mjs"), "utf8");
    assert.match(buildScript, /stamp-build\.mjs/);
  });

  it("a live process with the same build id is reused, not restarted", async () => {
    const home = await newHome();
    const port = await start(home);
    const first = readPortFile(home)!;
    const build = JSON.parse((await get(port, "/health")).body).build;
    assert.ok(typeof build === "string" && build.length > 0, "/health carries a build id");
    assert.equal(await ensureReviewProcess(home), port);
    assert.deepEqual(readPortFile(home), first);
    assert.ok(alive(first.pid));
  });

  it("a non-CoCheck listener on the port is never sent a shutdown or a signal", async () => {
    const home = await newHome();
    const seen: string[] = [];
    const foreign = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.end("hello");
    });
    await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", r));
    const port = (foreign.address() as net.AddressInfo).port;
    const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    seenPids.add(bystander.pid!);
    writeFileSync(portFilePath(home), JSON.stringify({ pid: bystander.pid, port }));
    writeFileSync(preferredPortFilePath(home), `${port}\n`);
    try {
      const got = await start(home);
      assert.notEqual(got, port);
      assert.ok(alive(bystander.pid!), "the pid in the port file was not signalled");
      assert.ok(!seen.some((s) => s.startsWith("POST")), `no shutdown sent: ${seen.join(", ")}`);
    } finally {
      await new Promise<void>((r) => foreign.close(() => r()));
    }
  });

  // On Windows rmSync on the lock threw EPERM from the orphan guard and killed the process with a stack trace.
  // A non-empty directory in the lock's place makes rmSync throw on any OS.
  it("a lock it cannot delete is logged and the process still exits cleanly", async () => {
    const home = await newHome(true);
    await start(home);
    const pid = readPortFile(home)!.pid;
    const lock = lockFilePath(home);
    rmSync(lock, { force: true });
    mkdirSync(lock);
    writeFileSync(path.join(lock, "held"), "x");
    rmSync(portFilePath(home), { force: true });
    await until(() => !alive(pid));
    const log = readFileSync(reviewLogPath(home), "utf8");
    assert.match(log, /could not remove .*review-server\.lock/);
    assert.doesNotMatch(log, /node:fs|Uncaught|at stop/);
  });
});
