import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewsDirOf, removePreviews } from "../src/states.ts";

// removePreviews still deletes the picture caches and remembered failures an earlier version
// wrote, state by state, so a removed state leaves nothing behind. Nothing renders any more; the files are planted by hand.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const A = "a".repeat(64);
const B = "b".repeat(64);

describe("a removed state takes its remembered failure with it", () => {
  it("removePreviews deletes the stale .failed and .png files of that state only", async () => {
    const h = await mkdtemp(path.join(tmpdir(), "cocheck-q241c-"));
    cleanups.push(async () => { await rm(h, { recursive: true, force: true }); });
    const dir = previewsDirOf(h, 1);
    await mkdir(dir, { recursive: true });
    for (const n of [`${A}.failed`, `${A}.png`, `${B}.failed`]) await writeFile(path.join(dir, n), "x");
    await removePreviews(h, 1, [A]);
    assert.ok(!existsSync(path.join(dir, `${A}.failed`)));
    assert.ok(!existsSync(path.join(dir, `${A}.png`)));
    assert.ok(existsSync(path.join(dir, `${B}.failed`)), "another state's failure was removed");
  });
});
