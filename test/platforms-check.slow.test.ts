import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkPlatforms, writeMatrix } from "../scripts/platforms-check.ts";

const REAL = path.join(import.meta.dirname, "..", "platforms");

/** A scratch copy of the real platforms folder with a fresh matrix, so each case breaks exactly one thing. */
async function scratch(): Promise<string> {
  // A small repo root of its own: the OS temp folder as root made every check list a folder of tens of thousands of entries.
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "platforms-check-")), "platforms");
  await cp(REAL, dir, { recursive: true });
  await writeMatrix(dir);
  return dir;
}

async function editCaps(dir: string, platform: string, edit: (j: any) => void): Promise<void> {
  const file = path.join(dir, platform, "capabilities.json");
  const json = JSON.parse(await readFile(file, "utf8"));
  edit(json);
  await writeFile(file, JSON.stringify(json, null, 2));
}

describe("platforms-check", () => {
  it("validates the real platforms folder and finds its matrix fresh", async () => {
    const result = await checkPlatforms(REAL);
    assert.deepEqual(result.errors, []);
    assert.equal(result.stale, false);
  });

  it("fails a capabilities file whose fact lacks a field", async () => {
    const dir = await scratch();
    try {
      await editCaps(dir, "codex", (j) => { delete j.install[0].date; });
      await writeMatrix(dir);
      const result = await checkPlatforms(dir);
      assert.ok(result.errors.some((e) => e.includes("codex") && e.includes("install[0]") && e.includes("date")), result.errors.join("\n"));
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it("fails an unknown top-level key", async () => {
    const dir = await scratch();
    try {
      await editCaps(dir, "claude-code", (j) => { j.surprise = []; });
      await writeMatrix(dir);
      const result = await checkPlatforms(dir);
      assert.ok(result.errors.some((e) => e.includes("claude-code") && e.includes("surprise")), result.errors.join("\n"));
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it("fails a stale matrix", async () => {
    const dir = await scratch();
    try {
      await writeFile(path.join(dir, "matrix.md"), (await readFile(path.join(dir, "matrix.md"), "utf8")) + "\nstale\n");
      const result = await checkPlatforms(dir);
      assert.equal(result.stale, true);
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it("fails a probe: source whose file is not in the repo (a fabricated path must not pass)", async () => {
    const dir = await scratch();
    try {
      await editCaps(dir, "codex", (j) => { j.hooks.events[0].fact.source = "probe:versions/0.162.0-alpha.2/never-recorded.jsonl"; });
      await writeMatrix(dir);
      const result = await checkPlatforms(dir);
      assert.ok(result.errors.some((e) => e.includes("codex") && e.includes("never-recorded.jsonl") && e.includes("not found")), result.errors.join("\n"));
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it("fails a probe: or local: source that points outside the repo", async () => {
    const dir = await scratch();
    try {
      await editCaps(dir, "codex", (j) => {
        j.hooks.events[0].fact.source = "probe:/private/tmp/claude-501/scratchpad/codex-run/payloads-run2.jsonl";
        j.install[0].source = "local:src/nope-not-here.ts";
      });
      await writeMatrix(dir);
      const result = await checkPlatforms(dir);
      assert.ok(result.errors.some((e) => e.includes("payloads-run2.jsonl")), result.errors.join("\n"));
      assert.ok(result.errors.some((e) => e.includes("src/nope-not-here.ts")), result.errors.join("\n"));
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it("fails a probe: source deleted from the recording folder", async () => {
    const dir = await scratch();
    try {
      await rm(path.join(dir, "codex", "versions", "0.162.0-alpha.2", "payloads.jsonl"));
      const result = await checkPlatforms(dir);
      assert.ok(result.errors.some((e) => e.includes("payloads.jsonl") && e.includes("not found")), result.errors.join("\n"));
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  for (const [name, src, needle] of [
    ["a relative probe: path that climbs out of the repo", "probe:../../../../../../../../../etc/hosts", "etc/hosts"],
    ["a probe: path whose case differs from the file on disk", "probe:PLATFORMS/codex/capabilities.json", "PLATFORMS/codex/capabilities.json"],
    ["a probe: path in the platform folder with the wrong case", "probe:Capabilities.json", "Capabilities.json"],
    ["a local:../ path that leaves the repo", "local:../x", "local:../x".slice(6)],
    ["a local:./ path to a file that is not there", "local:./src/never-here.ts", "src/never-here.ts"],
  ] as const) {
    it(`fails ${name} (an outside or wrong-case path must not pass)`, async () => {
      const dir = await scratch();
      try {
        await editCaps(dir, "codex", (j) => { j.hooks.events[0].fact.source = src; });
        await writeMatrix(dir);
        const result = await checkPlatforms(dir);
        assert.ok(result.errors.some((e) => e.includes("codex") && e.includes(needle) && e.includes("not found")), result.errors.join("\n"));
      } finally {
        await rm(path.dirname(dir), { recursive: true, force: true });
      }
    });
  }
});
