import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { placeKit } from "./helpers/install-layout.ts";

// The reveal is a best-effort path that returns nothing on failure, so it is also run from the built output
// (tsc to a temp outDir, never the repo's dist/), on fixture transcripts in a temp dir. It must return the text on a match and nothing otherwise.
const root = path.resolve(import.meta.dirname, "..");
let box: string;
after(async () => {
  if (box) await rm(box, { recursive: true, force: true });
});

describe("the built reveal", () => {
  it("returns the text on a hash match under the root and nothing for a mismatch or a link that leaves the root", async () => {
    box = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-build-")));
    const out = path.join(box, "dist");
    const tsc = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json"), "--outDir", out], { cwd: root, encoding: "utf8" });
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
    await symlink(path.join(root, "node_modules"), path.join(box, "node_modules"));
    placeKit(box); // public-kit beside dist, as installed
    const profile = path.join(box, "profile", "-work");
    await mkdir(profile, { recursive: true });
    const text = "password: hunter22 built";
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_b", name: "SendMessage", input: { message: text } }] } }) + "\n";
    const file = path.join(profile, "s.jsonl");
    await writeFile(file, line);
    const outside = path.join(box, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "s.jsonl"), line);
    await symlink(path.join(outside, "s.jsonl"), path.join(profile, "link.jsonl"));
    const sha = createHash("sha256").update(text).digest("hex");
    const { revealWithheld } = await import(path.join(out, "reveal.js"));
    const rec = (f: string, h = sha) => ({ family: "name-assignment", sha256: h, locator: { file: f, id: "toolu_b" } });
    const profileRoot = path.join(box, "profile");
    assert.equal(await revealWithheld("message", rec(file), profileRoot, "claude"), text);
    assert.equal(await revealWithheld("message", rec(file, "0".repeat(64)), profileRoot, "claude"), undefined);
    assert.equal(await revealWithheld("message", rec(path.join(profile, "link.jsonl")), profileRoot, "claude"), undefined);
    assert.equal(await revealWithheld("message", rec(path.join(outside, "s.jsonl")), profileRoot, "claude"), undefined);
    assert.equal(await revealWithheld("message", rec(path.join(profile, "gone.jsonl")), profileRoot, "claude"), undefined);
  });
});
