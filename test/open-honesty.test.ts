import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOpen, settledHealthy } from "../src/cli.ts";
import { createWin32 } from "../src/platform/index.ts";

// `cocheck open` re-checks the review process once after a settle, and opens the browser on Windows with a launcher that keeps the query.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function setup() {
  const userHome = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  dirs.push(userHome);
  const data = path.join(userHome, "data");
  await mkdir(path.join(userHome, ".config", "cocheck"), { recursive: true });
  await writeFile(path.join(userHome, ".config", "cocheck", "install.json"), JSON.stringify({ home: data, hookPath: "/x/hook", launcher: "/x/launch", settingsFile: "/x/settings.json", backupFile: "/x/s.bak", hosts: [], folder: "/x", createdDirs: [], installedAt: "2026-10-28T00:00:00.000Z" }));
  return { userHome, data };
}

describe("open health re-check", () => {
  it("a process that answers once and then dies never prints opened", async () => {
    const { userHome, data } = await setup();
    const opened: string[] = [];
    let answers = 0;
    const res = await runOpen(
      { env: {}, userHome, urlFor: async () => { answers++; return "http://127.0.0.1:9/timeline/1/review?t=secret"; }, open: (u) => void opened.push(u), recheck: async () => answers < 0 },
      "1",
    );
    assert.equal(res.exitCode, 1);
    assert.doesNotMatch(res.stdout, /opened/);
    assert.match(res.stderr, /review\.log/);
    assert.ok(res.stderr.includes(path.join(data, "review.log")));
    assert.equal(opened.length, 0);
  });

  it("a healthy re-check opens, and the line says the link needs its token and cocheck open reopens it", async () => {
    const { userHome } = await setup();
    const opened: string[] = [];
    const res = await runOpen({ env: {}, userHome, urlFor: async () => "http://127.0.0.1:9/x?t=secret", open: (u) => void opened.push(u), recheck: async () => true }, undefined);
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /opened http:\/\/127\.0\.0\.1:9\/x/);
    assert.match(res.stdout, /needs its token/);
    assert.match(res.stdout, /cocheck open/);
    assert.doesNotMatch(res.stdout, /secret/);
    assert.equal(opened.length, 1);
  });

  it("an open that cannot be confirmed prints the full tokened link to stderr, not stdout", async () => {
    const { userHome } = await setup();
    const res = await runOpen({ env: {}, userHome, urlFor: async () => "http://127.0.0.1:9/x?t=secret", open: () => { throw new Error("no"); }, recheck: async () => true }, undefined);
    assert.equal(res.exitCode, 1);
    assert.ok(res.stderr.includes("http://127.0.0.1:9/x?t=secret"));
    assert.doesNotMatch(res.stdout, /secret/);
  });

  it("settledHealthy waits the settle, then reports a closed port as dead", async () => {
    const t0 = Date.now();
    assert.equal(await settledHealthy("/nonexistent-home", "http://127.0.0.1:1/x?t=k", 150), false);
    assert.ok(Date.now() - t0 >= 140);
  });
});

describe("win32 browser launcher", () => {
  const rig = (over: { status?: number | null; error?: Error } = {}) => {
    const calls: { command: string; args: string[] }[] = [];
    const p = createWin32({
      env: {},
      run: (command: string, args: string[]) => { calls.push({ command, args }); return { status: over.status ?? 0, stdout: "", stderr: "", error: over.error }; },
    } as never);
    return { p, calls };
  };
  it("openUrl runs rundll32 url.dll,FileProtocolHandler with the whole url as one argv entry", () => {
    const { p, calls } = rig();
    p.openUrl("http://127.0.0.1:5/timeline/1/review?t=k&x=2");
    assert.deepEqual(calls[0], { command: "rundll32", args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:5/timeline/1/review?t=k&x=2"] });
  });
  it("openUrl throws when the launcher cannot start or exits nonzero", () => {
    assert.throws(() => rig({ status: null, error: new Error("ENOENT") }).p.openUrl("http://x/"));
    assert.throws(() => rig({ status: 1 }).p.openUrl("http://x/"));
  });
});

// Live launcher proof: only on Windows with CI set or COCHECK_T237_LIVE_OPEN=1 (a runner or laptop with a default browser). A one-shot local listener must receive the request with ?t= intact.
describe("win32 live launcher", { skip: process.platform !== "win32" || (process.env.COCHECK_T237_LIVE_OPEN !== "1" && process.env.CI === undefined) }, () => {
  it("the default browser reaches a local listener with the query intact", async () => {
    const { createServer } = await import("node:http");
    const { platform } = await import("../src/platform/index.ts");
    const got = new Promise<string>((resolve) => {
      const server = createServer((req, res) => {
        res.end("ok");
        resolve(req.url ?? "");
        server.close();
        server.closeAllConnections();
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        platform().openUrl(`http://127.0.0.1:${port}/timeline/1/review?t=tok123&x=2`);
      });
    });
    const url = await Promise.race([got, new Promise<string>((_, rej) => setTimeout(() => rej(new Error("no request within 30s")), 30_000))]);
    assert.equal(url, "/timeline/1/review?t=tok123&x=2");
  });
});
