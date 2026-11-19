// Installed-manifest reads are bounded: over 64 KiB is skipped, and anything that is not a regular file is skipped without a full read.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readInstalledManifests } from "../src/connector/installed-manifests.ts";

const manifest = (id: string, pad = "") => JSON.stringify({ spec: "cocheck.connector/1", id, version: "0.0.1", entry: "state", matches: { schemes: ["notion"] }, run: ["node", "x.mjs"], pad });
const posix = process.platform === "win32" ? { skip: "needs mkfifo" } : {};
function put(home: string, dir: string, text: string): void {
  mkdirSync(path.join(home, "connectors", dir), { recursive: true });
  writeFileSync(path.join(home, "connectors", dir, "cocheck-connector.json"), text);
}

describe("bounded manifest reads", () => {
  it("skips a manifest over 64 KiB with a reason naming the folder, and still loads a normal one", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    put(home, "notion", manifest("notion"));
    put(home, "big", manifest("big", "x".repeat(64 * 1024)));
    const skips: Array<[string, string]> = [];
    const got = readInstalledManifests(home, { onSkip: (f, why) => skips.push([f, why]) });
    assert.deepEqual(got.map((g) => g.manifest.id), ["notion"]);
    assert.equal(skips.length, 1);
    assert.match(skips[0]![1], /big/);
    assert.match(skips[0]![1], /64 KiB/);
  });

  it("a manifest of exactly 64 KiB still loads (the cap is over, not at)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    const base = manifest("edge").length;
    put(home, "edge", manifest("edge", "x".repeat(64 * 1024 - base)));
    assert.deepEqual(readInstalledManifests(home).map((g) => g.manifest.id), ["edge"]);
  });

  it("skips a FIFO and a directory with a reason naming the folder, in under 2 s", { ...posix, timeout: 10_000 }, () => {
    const home = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    mkdirSync(path.join(home, "connectors", "c-fifo"), { recursive: true });
    execFileSync("mkfifo", [path.join(home, "connectors", "c-fifo", "cocheck-connector.json")]);
    mkdirSync(path.join(home, "connectors", "d-dir", "cocheck-connector.json"), { recursive: true });
    const skips: string[] = [];
    const t0 = Date.now();
    const got = readInstalledManifests(home, { onSkip: (_f, why) => skips.push(why) });
    assert.ok(Date.now() - t0 < 2000);
    assert.deepEqual(got, []);
    assert.equal(skips.length, 2);
    assert.match(skips[0]!, /c-fifo/);
    assert.match(skips[1]!, /d-dir/);
  });
});
