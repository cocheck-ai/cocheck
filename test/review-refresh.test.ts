// An upgrade replaces the running review server. Two installed builds in a scratch folder (copies of src with their own build stamp),
// a scratch HOME and COCHECK_HOME, their own ports. The hook entry of the newer build replaces the older build's server; the same build never does.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { utimesSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { refreshStaleReview, reviewIsOutdated, refreshLockPath } from "../src/review-refresh.ts";
import net from "node:net";
import { readOrCreateToken, readPortFile, reviewLogPath, UPDATED_MESSAGE } from "../src/review-server.ts";
import { placeKit } from "./helpers/install-layout.ts";

const REPO = path.join(import.meta.dirname, "..");
const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-"));
const pids = new Set<number>();

/** An "installed build": a copy of src with its own stamp (and one differing line so its build id differs). */
function install(name: string, builtAt: number): string {
  const root = path.join(scratch, name);
  mkdirSync(root);
  cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"));
  placeKit(root); // public-kit beside src, as every install has it
  writeFileSync(path.join(root, "src", "build-info.json"), JSON.stringify({ builtAt }));
  writeFileSync(path.join(root, "src", "build-marker.ts"), `export const marker = "${name}";\n`);
  return path.join(root, "src");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    assert.ok(Date.now() < end, "timed out");
    await sleep(50);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function get(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

const env = (home: string) => ({ ...process.env, HOME: path.join(scratch, "home"), COCHECK_HOME: home, CLAUDE_CONFIG_DIR: path.join(scratch, "claude") });
mkdirSync(path.join(scratch, "claude"));
process.env.CLAUDE_CONFIG_DIR = path.join(scratch, "claude");
mkdirSync(path.join(scratch, "home"));

async function startOld(src: string, home: string): Promise<{ pid: number; port: number }> {
  const child = spawn(process.execPath, [path.join(src, "review-process.ts")], { detached: true, stdio: "ignore", env: env(home) });
  child.unref();
  await until(() => readPortFile(home) !== undefined);
  const rec = readPortFile(home)!;
  pids.add(rec.pid);
  return rec;
}
const runHook = (src: string, home: string) => spawnSync(process.execPath, [path.join(src, "hook.ts"), "--host", "claude"], { input: "{}", env: env(home), encoding: "utf8", timeout: 20000 });

after(async () => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone
    }
  }
  await sleep(300);
});

describe("a hook event keeps the review server on the installed build", () => {
  const older = install("older", 1_000_000);
  const newer = install("newer", 2_000_000);

  it("a hook event of the same build leaves a live review server alone", async () => {
    const home = mkdtempSync(path.join(scratch, "home-same-"));
    const live = await startOld(older, home);
    const r = runHook(older, home);
    assert.ok(r.status !== null, "hook finished");
    await sleep(1500);
    assert.deepEqual(readPortFile(home), live, "same pid, same port");
    assert.equal((await get(live.port, "/health")).status, 200);
    assert.ok(!/replacing pid/.test(existsSync(reviewLogPath(home)) ? readFileSync(reviewLogPath(home), "utf8") : ""), "nothing logged as replaced");
  });

  it("a hook event of an older build does not replace a newer build's server", async () => {
    const home = mkdtempSync(path.join(scratch, "home-down-"));
    const live = await startOld(newer, home);
    runHook(older, home);
    await sleep(1500);
    assert.deepEqual(readPortFile(home), live);
  });

  it("the next hook event of the newer build replaces the older build's server, even with the older install folder's code gone", async () => {
    const home = mkdtempSync(path.join(scratch, "home-up-"));
    const old = await startOld(older, home);
    const oldHealth = JSON.parse((await get(old.port, "/health")).body);
    // The older install is replaced: its server module is gone from disk (a brew upgrade removes the Cellar folder).
    rmSync(path.join(older, "review-server.ts"));
    const page = await get(old.port, `/?t=${readOrCreateToken(home)}`);
    assert.equal(page.status, 503);
    assert.match(page.body, new RegExp(UPDATED_MESSAGE));
    assert.doesNotMatch(page.body, /KEY_MISSING/);
    const api = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port: old.port, path: "/timeline/1/pdfpage", headers: { host: `127.0.0.1:${old.port}`, accept: "application/json" } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }).on("error", reject);
    });
    assert.equal(api.status, 503);
    assert.equal(JSON.parse(api.body).error, UPDATED_MESSAGE);
    assert.equal((await get(old.port, "/health")).status, 200, "health still answers so the newer build can replace it");

    runHook(newer, home);
    await until(() => {
      const rec = readPortFile(home);
      return rec !== undefined && rec.pid !== old.pid;
    });
    const now = readPortFile(home)!;
    pids.add(now.pid);
    await until(() => !alive(old.pid));
    assert.equal(now.port, old.port, "same port, so the open tab reconnects");
    await until(() => !existsSync(refreshLockPath(home)));
    const health = JSON.parse((await get(now.port, "/health")).body);
    assert.notEqual(health.build, oldHealth.build);
    assert.equal(health.builtAt, 2_000_000);
    assert.equal((await get(now.port, `/?t=${readOrCreateToken(home)}`)).status, 200);
    assert.match(readFileSync(reviewLogPath(home), "utf8"), /replacing pid \d+ \(build [^)]*\) on port \d+ with build/);
  });
});

const portFileFor = (home: string, port: number) => writeFileSync(path.join(home, "review-server.json"), JSON.stringify({ pid: process.pid, port }));
const listen = (srv: net.Server | http.Server) => new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as net.AddressInfo).port)));

describe("the hook probe is bounded and single-flight", () => {
  const sockets: net.Server[] = [];
  after(() => sockets.forEach((s) => s.close()));

  it("a listener that trickles a byte every 100 ms does not hold the probe past its deadline", async () => {
    const home = mkdtempSync(path.join(scratch, "home-trickle-"));
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write(" "), 100);
      res.on("close", () => clearInterval(t));
    });
    sockets.push(srv);
    portFileFor(home, await listen(srv));
    const t0 = Date.now();
    assert.equal(await reviewIsOutdated(home, 2_000_000, 300), false);
    assert.ok(Date.now() - t0 < 800, `took ${Date.now() - t0} ms`);
  });

  it("a wedged listener (accepts, never answers) does not hold the probe past its deadline", async () => {
    const home = mkdtempSync(path.join(scratch, "home-wedged-"));
    const srv = net.createServer(() => {});
    sockets.push(srv);
    portFileFor(home, await listen(srv));
    const t0 = Date.now();
    assert.equal(await reviewIsOutdated(home, 2_000_000, 300), false);
    assert.ok(Date.now() - t0 < 800, `took ${Date.now() - t0} ms`);
  });

  it("6 hook events against an outdated server that ignores /shutdown start 1 refresh child, and a stale lock is reclaimed", async () => {
    const home = mkdtempSync(path.join(scratch, "home-flight-"));
    const srv = http.createServer((req, res) => {
      if (req.url === "/health") res.end(JSON.stringify({ cocheck: "review", build: "old", builtAt: 1_000_000 }));
    });
    sockets.push(srv);
    portFileFor(home, await listen(srv));
    let spawned = 0;
    const fake = (() => {
      spawned++;
      return { on() {}, unref() {} };
    }) as unknown as typeof import("node:child_process").spawn;
    await Promise.all(Array.from({ length: 6 }, () => refreshStaleReview(home, 2_000_000, fake)));
    assert.equal(spawned, 1);
    // A child that died without releasing: the lock ages out and the next event may start one.
    const old = new Date(Date.now() - 60_000);
    utimesSync(refreshLockPath(home), old, old);
    await refreshStaleReview(home, 2_000_000, fake);
    assert.equal(spawned, 2);
  });
});
