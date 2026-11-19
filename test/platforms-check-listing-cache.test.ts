// platforms-check reads each folder's listing once per check. Without the cache every cited path re-read every folder above it, and a
// scratch copy's repo root was the OS temp folder (about 128,000 entries on a dev Mac): one scratch check took 18 s and the slow test file
// hit the 600 s per-file cap. The cache lives for one check only, so a file deleted between two checks is still caught.
import assert from "node:assert/strict";
import fsp, { cp, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { checkPlatforms, writeMatrix } from "../scripts/platforms-check.ts";

const REAL = path.join(import.meta.dirname, "..", "platforms");
const roots: string[] = [];
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** A copy of the platforms folder inside a fresh, small repo root. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "platforms-cache-"));
  roots.push(root);
  const dir = path.join(root, "platforms");
  await cp(REAL, dir, { recursive: true });
  await writeMatrix(dir);
  return dir;
}

/** Counts readdir calls per path while `run` runs (the script's named import is a live binding, synced after the swap). */
async function countReaddirs(run: () => Promise<unknown>): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const real = fsp.readdir;
  (fsp as { readdir: unknown }).readdir = (p: unknown, ...rest: unknown[]) => {
    const key = path.resolve(String(p));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    (fsp as { readdir: unknown }).readdir = real;
    syncBuiltinESMExports();
  }
  return counts;
}

describe("platforms-check listing cache", () => {
  it("one check reads the repo root's listing once, and no folder more than twice", async () => {
    const dir = await scratch();
    const counts = await countReaddirs(async () => assert.deepEqual((await checkPlatforms(dir)).errors, []));
    assert.equal(counts.get(path.dirname(dir)), 1, "the repo root is listed once");
    // loadPlatforms lists `dir` with file types for its platform folders, besides the cached plain listing.
    const worst = Math.max(...counts.values());
    assert.ok(worst <= 2, `a folder was listed ${worst} times: ${[...counts].filter(([, n]) => n > 2).map(([p, n]) => `${p} x${n}`).join(", ")}`);
  });

  it("the cache does not outlive a check: a cited file deleted between two checks is reported by the second", async () => {
    const dir = await scratch();
    assert.deepEqual((await checkPlatforms(dir)).errors, []);
    await rm(path.join(dir, "codex", "versions", "0.162.0-alpha.2", "payloads.jsonl"));
    const second = await checkPlatforms(dir);
    assert.ok(second.errors.some((e) => e.includes("payloads.jsonl")), second.errors.join("\n"));
  });
});
