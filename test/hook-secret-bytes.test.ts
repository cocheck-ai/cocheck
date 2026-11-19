import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { startReviewServer } from "../src/review-server.ts";
type PreviewRenderer = (file: string, outDir: string) => Promise<string | null>; // legacy seam, ignored since
import { workbookClaims } from "./helpers/claims.ts";

// a file renamed to a secret name has its earlier whole copy deleted, and reads as secret everywhere.
// Documented gaps: a secret renamed or copied to a plain name, and a general secret-hash set across the task. Run through the real hook adapter and the real review server on a scratch home.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (name: string) => path.join(FIXTURES, "probe", name);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const TOKEN = "t".repeat(40);
const fixture = async (name: string, over: Record<string, unknown>): Promise<HookPayload> =>
  ({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), ...over }) as HookPayload;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function everyFile(dir: string): Promise<Array<{ file: string; bytes: Buffer }>> {
  const out: Array<{ file: string; bytes: Buffer }> = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await everyFile(full)));
    else if (e.isFile()) out.push({ file: full, bytes: await readFile(full) });
  }
  return out;
}

async function setup(files: Record<string, string>) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-q205r2-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-q205r2-folder-")));
  await copyFile(probe("S0.xlsx"), path.join(folder, "casebook.xlsx"));
  const put = async (rel: string, data: string) => {
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), data);
  };
  for (const [rel, data] of Object.entries(files)) await put(rel, data);
  const ledger = openLedger(home);
  const renders: string[] = [];
  const previewRenderer: PreviewRenderer = async (file, outDir) => {
    renders.push(file);
    const out = path.join(outDir, `${path.basename(file)}.png`);
    await writeFile(out, "PNG-BYTES");
    return out;
  };
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer, quickLook: true });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const get = (p: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
  const hostOpts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder };
  const send = (name: string, over: Record<string, unknown> = {}) => fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, hostOpts));
  const call = async (id: string, command: string, act: () => Promise<void>) => {
    const tool_input = { command, description: id };
    await send("claude-pre-bash.json", { tool_use_id: id, tool_input });
    await act();
    await send("claude-post-bash.json", { tool_use_id: id, tool_input });
  };
  const stop = async () => {
    const r = await send("claude-stop.json");
    assert.ok(r.summary);
    return r.summary.taskId;
  };
  const p = (rel: string) => path.join(folder, rel);
  return { home, folder, ledger, renders, get, call, stop, p, put };
}

/** Greps every place a secret could surface for `needle`, and asks the routes for every hash of the task. */
async function assertNowhere(t: Awaited<ReturnType<typeof setup>>, taskId: number, needle: string, bytesSha: string): Promise<void> {
  for (const { file, bytes } of await everyFile(t.home)) assert.ok(!bytes.includes(needle), `${path.relative(t.home, file)} holds no ${needle}`);
  const store = await readdir(path.join(t.home, "tasks", String(taskId), "states")).catch(() => [] as string[]);
  assert.ok(!store.includes(bytesSha), "the secret bytes are not in the store");
  const dump = JSON.stringify({ steps: t.ledger.stepsForTask(taskId), states: t.ledger.fileStatesForTask(taskId), ops: t.ledger.okOpsForTask(taskId, 0, t.ledger.maxOpId()), removals: t.ledger.stateRemovalsForTask(taskId) });
  assert.ok(!dump.includes(needle), "ledger dump");
  const tl = await t.get(`/timeline/${taskId}`);
  assert.equal(tl.status, 200);
  assert.ok(!tl.body.includes(needle), "timeline JSON");
  const page = await t.get(`/timeline/${taskId}/page`);
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes(needle), "page");
  const hashes = new Set(t.ledger.fileStatesForTask(taskId).flatMap((r) => [r.sha256, ...(r.prevSha256 ? [r.prevSha256] : [])]));
  assert.ok(hashes.has(bytesSha), "the secret's hash is in the record");
  const res = await t.get(`/timeline/${taskId}/preview/${bytesSha}`);
  assert.equal(res.status, 404, "preview of the secret bytes");
  assert.deepEqual(t.renders, [], "nothing was rendered");
  // Every state with these bytes, under any name, is a secret fingerprint in the timeline.
  const body = JSON.parse(tl.body) as unknown;
  const found: Array<{ file: string; generic: { tier: string; secret?: boolean; label: string } }> = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.file === "string" && o.generic && typeof o.generic === "object") found.push(o as never);
      Object.values(o).forEach(walk);
    }
  };
  walk(body);
  for (const c of found) {
    const row = t.ledger.fileStatesForTask(taskId).find((r) => (r.sha256 === bytesSha || r.prevSha256 === bytesSha) && r.filePath.endsWith(c.file));
    if (!row) continue;
    assert.equal(c.generic.tier, "fingerprint", c.file);
    assert.equal(c.generic.secret, true, c.file);
    assert.match(c.generic.label, /^A secret file was changed: /);
  }
  assert.ok(found.length > 0, "the timeline has changes");
}

describe("a secret is its bytes", () => {
  it("a plain file renamed to .env inside one call leaves no copy and no text", async () => {
    const S = "SENTINEL-PLAIN-TO-ENV-91f3";
    const t = await setup({ "a.txt": `TOKEN=${S}\n` });
    await t.call("toolu_A", "mv a.txt .env", () => rename(t.p("a.txt"), t.p(".env")));
    const id = await t.stop();
    await assertNowhere(t, id, S, sha(`TOKEN=${S}\n`));
    assert.ok(t.ledger.stateRemovalsForTask(id).some((r) => r.sha256 === sha(`TOKEN=${S}\n`) && /secret/.test(r.reason)), "the removal says so in words");
  });

  it("an empty secret-named file does not make every empty file a secret", async () => {
    const t = await setup({ ".env": "", "pkg/__init__.py": "" });
    await t.call("toolu_A", "touch", () => writeFile(t.p("pkg/other.txt"), ""));
    const id = await t.stop();
    const tl = JSON.parse((await t.get(`/timeline/${id}`)).body) as unknown;
    const text = JSON.stringify(tl);
    assert.ok(!/A secret file was changed: pkg/.test(text), "no empty plain file is called secret");
    assert.ok((await readdir(path.join(t.home, "tasks", String(id), "states"))).includes(sha("")), "the empty plain file is stored like any other");
  });
});
