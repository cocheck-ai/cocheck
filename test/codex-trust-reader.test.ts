import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCodexHooksList } from "../src/hosts/codex-trust.ts";
import { resolveCodexBin } from "../src/hosts/codex-bin.ts";

// R2. The fake app-server mimics the real one seen live: it exits the moment stdin closes, and answers hooks/list (id 2) only
// after a delay, so a reader that closes stdin at once gets nothing. It writes its pid so the test can prove no process is left behind.
let box: string;
afterEach(async () => {
  if (box) await rm(box, { recursive: true, force: true });
});
async function fake(delayMs: number) {
  box = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-t150r2-")));
  const bin = path.join(box, "codex");
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(path.join(box, "pid"))}, String(process.pid));
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (const l of buf.split("\\n")) {
    try { const m = JSON.parse(l); if (m.id === 2) setTimeout(() => process.stdout.write(JSON.stringify({ id: 2, result: { data: [{ cwd: "x", hooks: [{ eventName: "stop", trustStatus: "modified", enabled: true }] }] } }) + "\\n"), ${delayMs}); } catch {}
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`);
  await chmod(bin, 0o755);
  await mkdir(path.join(box, "home"));
  return { bin, home: path.join(box, "home"), pid: path.join(box, "pid") };
}
// The fake app-server is an extensionless #! script found through a ':'-separated PATH; Windows runs codex.exe or a .cmd instead.
const POSIX_FAKE = process.platform === "win32" && "the fake Codex is an extensionless #! script; Windows resolution is pinned by codex-bin-win32";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("the hooks/list reader", () => {
  it("keeps stdin open until the reply, then leaves no app-server behind", { skip: POSIX_FAKE }, async () => {
    const f = await fake(600);
    const r: any = readCodexHooksList(f.home, { PATH: process.env.PATH, COCHECK_CODEX_BIN: f.bin });
    assert.equal(r?.data?.[0]?.hooks?.[0]?.trustStatus, "modified");
    const pid = Number(await readFile(f.pid, "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(alive(pid), false, "the app-server process is gone");
  });
  it("an app-server that never answers ends at the deadline with undefined and no orphan", { skip: POSIX_FAKE }, async () => {
    const f = await fake(60_000);
    const r = readCodexHooksList(f.home, { PATH: process.env.PATH, COCHECK_CODEX_BIN: f.bin, COCHECK_CODEX_PROBE_MS: "700" });
    assert.equal(r, undefined);
    const pid = Number(await readFile(f.pid, "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(alive(pid), false);
  });
  it("Codex absent everywhere reads as undefined, no error", () => {
    assert.equal(readCodexHooksList("/nonexistent/home", { PATH: "/nonexistent", COCHECK_CODEX_BIN: "/nonexistent/codex" }), undefined);
  });
});

describe("binary resolution order", () => {
  it("COCHECK_CODEX_BIN, then PATH, then the bundle; a missing override does not fall through", { skip: POSIX_FAKE }, async () => {
    const f = await fake(0);
    const bundled = path.join(box, "bundled-codex");
    await writeFile(bundled, "#!/bin/sh\n");
    await chmod(bundled, 0o755);
    assert.equal(resolveCodexBin({ PATH: box, COCHECK_CODEX_BIN: bundled }, bundled), bundled);
    assert.equal(resolveCodexBin({ PATH: `/nonexistent:${box}` }, bundled), f.bin);
    assert.equal(resolveCodexBin({ PATH: "/nonexistent" }, bundled), bundled);
    assert.equal(resolveCodexBin({ PATH: "/nonexistent" }, path.join(box, "none")), undefined);
    assert.equal(resolveCodexBin({ PATH: box, COCHECK_CODEX_BIN: path.join(box, "none") }, bundled), undefined);
    assert.ok(existsSync(f.bin));
  });
});
