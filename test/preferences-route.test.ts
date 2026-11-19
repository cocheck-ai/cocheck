import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";

// Preferences live in <home>/preferences.json, behind GET/POST /timeline/<task>/review/preferences (same guard as every POST).
// Guard: a bad value must never reach the file, and keys this build does not know must survive a write.

const TOKEN = "p".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};

async function serve(home: string) {
  const ledger: Ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { quickLook: false });
  cleanups.push(async () => { await new Promise<void>((r) => (server as Server).close(() => r())); ledger.close(); });
  const call = (method: "GET" | "POST", p: string, json?: unknown, over: { token?: string; origin?: string | null; host?: string } = {}): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: over.host ?? `127.0.0.1:${port}` };
      if (over.origin !== null && (method === "POST" || over.origin !== undefined)) headers.origin = over.origin ?? `http://127.0.0.1:${port}`;
      if (method === "POST") headers["content-type"] = "application/json";
      const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${over.token ?? TOKEN}`, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
      });
      req.on("error", reject);
      req.end(method === "POST" ? JSON.stringify(json) : undefined);
    });
  return { ledger, call, task: ledger.openTask("claude:/work"), port };
}

describe("the preferences route", () => {
  it("a missing file means defaults; a POST merges, answers the full object and survives a restart on another port", async () => {
    const home = await tmp();
    const a = await serve(home);
    const url = `/timeline/${a.task}/review/preferences`;
    assert.deepEqual((await a.call("GET", url)).body, { railOrder: "oldest-first" });
    const r = await a.call("POST", url, { railOrder: "newest-first" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { railOrder: "newest-first" });
    assert.deepEqual((await a.call("POST", url, { clean: true })).body, { railOrder: "newest-first", clean: true }, "a partial POST keeps what it did not name");
    assert.deepEqual((await a.call("POST", url, {})).body, { railOrder: "newest-first", clean: true });
    // a second review process on the same home, on its own port
    const b = await serve(home);
    assert.notEqual(b.port, a.port);
    assert.deepEqual((await b.call("GET", `/timeline/${b.task}/review/preferences`)).body, { railOrder: "newest-first", clean: true });
  });

  it("the file is owner-only, and keys this build does not know are kept through a write", async () => {
    const home = await tmp();
    await writeFile(path.join(home, "preferences.json"), JSON.stringify({ future: { a: 1 }, railOrder: "oldest-first" }));
    const s = await serve(home);
    const r = await s.call("POST", `/timeline/${s.task}/review/preferences`, { railOrder: "newest-first", unknownFromClient: 5 });
    assert.equal(r.status, 200);
    const onDisk = JSON.parse(await readFile(path.join(home, "preferences.json"), "utf8"));
    assert.deepEqual(onDisk, { future: { a: 1 }, railOrder: "newest-first" }, "an unknown key in the file is kept; one from the client is not stored");
    assert.equal(r.body.future.a, 1);
    if (process.platform !== "win32") assert.equal((await stat(path.join(home, "preferences.json"))).mode & 0o777, 0o600);
  });

  it("a bad value is 400 and nothing is written, even beside a good one", async () => {
    const home = await tmp();
    const s = await serve(home);
    const url = `/timeline/${s.task}/review/preferences`;
    await s.call("POST", url, { railOrder: "newest-first" });
    const file = path.join(home, "preferences.json");
    const was = await readFile(file, "utf8");
    for (const bad of [{ railOrder: "sideways" }, { railOrder: 1 }, { railOrder: null }, { clean: "yes" }, { clean: 1 }, { railOrder: "oldest-first", clean: "no" }]) {
      assert.equal((await s.call("POST", url, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal(await readFile(file, "utf8"), was);
    await writeFile(file, "not json");
    assert.deepEqual((await s.call("GET", url)).body, { railOrder: "oldest-first" }, "a damaged file reads as defaults");
  });

  it("the guard is the usual one: token, Origin and Host", async () => {
    const home = await tmp();
    const s = await serve(home);
    const url = `/timeline/${s.task}/review/preferences`;
    assert.equal((await s.call("GET", url, undefined, { token: "x".repeat(40) })).status, 403);
    assert.equal((await s.call("POST", url, { railOrder: "newest-first" }, { token: "x".repeat(40) })).status, 403);
    assert.equal((await s.call("POST", url, { railOrder: "newest-first" }, { origin: "http://evil.example" })).status, 403);
    assert.equal((await s.call("POST", url, { railOrder: "newest-first" }, { origin: null })).status, 403);
    assert.equal((await s.call("GET", url, undefined, { origin: "http://evil.example" })).status, 403);
    assert.equal((await s.call("POST", url, { railOrder: "newest-first" }, { host: "evil.example" })).status, 403);
    assert.equal((await s.call("POST", `/timeline/999/review/preferences`, { railOrder: "newest-first" })).status, 404);
    assert.deepEqual((await s.call("GET", url)).body, { railOrder: "oldest-first" }, "nothing refused was stored");
  });
});
