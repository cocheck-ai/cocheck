import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Server } from "node:http";
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { startReviewServer } from "../src/review-server.ts";
import { railBuildStats } from "../src/timeline/rail/model.ts";
import { workbookClaims } from "./helpers/claims.ts";

// An unchanged task must cost no rail model build at all on a conditional GET. The data home is a temp dir.

const TOKEN = "t".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-304-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-304-folder-")));
  const before = process.env.COCHECK_HOME;
  process.env.COCHECK_HOME = home;
  let clock = Date.now() - 100_000;
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, perSession: false, now: () => (clock += 1000) };
  const hook = (o: Record<string, unknown>) => handleHook({ session_id: "sess", cwd: folder, ...o } as HookPayload, opts);
  await hook({ hook_event_name: "UserPromptSubmit", prompt: "Tidy up the notes" });
  const lines = (await readFile(path.join(import.meta.dirname, "fixtures", "posttoolusefailure.jsonl"), "utf8")).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  for (const p of lines) await hook({ ...p, cwd: undefined });
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => null, quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r())); ledger.close();
    if (before === undefined) delete process.env.COCHECK_HOME; else process.env.COCHECK_HOME = before;
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  const get = (p: string, inm?: string): Promise<{ status: number; etag?: string; body: string }> => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, method: "GET", headers: { host: `127.0.0.1:${port}`, ...(inm ? { "if-none-match": inm } : {}) } }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, etag: res.headers.etag as string | undefined, body: b }));
    });
    req.on("error", reject); req.end();
  });
  return { get };
}

describe("the model 304 builds nothing for an unchanged task", () => {
  it("an unchanged task builds no rail model on a 304 (counted)", async () => {
    const s = await setup();
    const m = "/timeline/1/review/model";
    const a = await s.get(m);
    assert.equal(a.status, 200);
    assert.equal((await s.get(m, a.etag)).status, 304);
    const n = railBuildStats.builds;
    for (let i = 0; i < 5; i++) assert.equal((await s.get(m, a.etag)).status, 304);
    assert.equal(railBuildStats.builds, n, "five unchanged polls built nothing");
  });
});
