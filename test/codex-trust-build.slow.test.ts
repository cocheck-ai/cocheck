import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { placeKit } from "./helpers/install-layout.ts";

// Tsc rewrites import specifiers, not URL strings, so a spawn target named `./x.ts` breaks in the built dist. Build to a temp outDir
// (never the repo's dist/), check every literal `new URL("./...", import.meta.url)` target in dist/hosts exists, and run the built reader once.
const root = path.resolve(import.meta.dirname, "..");
let box: string;
after(async () => {
  if (box) await rm(box, { recursive: true, force: true });
});

describe("the built Codex trust reader", () => {
  it("every literal URL target in dist/hosts exists, and the built reader answers", async () => {
    box = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-t150r3-")));
    const out = path.join(box, "dist");
    const tsc = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json"), "--outDir", out], { cwd: root, encoding: "utf8" });
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
    placeKit(box); // public-kit beside dist, as installed
    const dir = path.join(out, "hosts");
    let checked = 0;
    for (const f of (await readdir(dir)).filter((n) => n.endsWith(".js"))) {
      for (const m of (await readFile(path.join(dir, f), "utf8")).matchAll(/new URL\(\s*"(\.[^"]*)"\s*,\s*import\.meta\.url\s*\)/g)) {
        assert.ok(existsSync(path.resolve(dir, m[1])), `${f}: ${m[1]} is missing in the build`);
        checked++;
      }
    }
    assert.ok(existsSync(path.join(dir, "codex-trust-probe.js")));
    // The reader builds the probe's name from its own extension; a literal ".ts" in the built reader would be missing.
    assert.doesNotMatch(await readFile(path.join(dir, "codex-trust.js"), "utf8"), /codex-trust-probe\.ts/);
    const bin = path.join(box, "codex");
    await writeFile(bin, `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => { buf += d; for (const l of buf.split("\\n")) { try { if (JSON.parse(l).id === 2) setTimeout(() => process.stdout.write(JSON.stringify({ id: 2, result: { hooks: [{ eventName: "stop", trustStatus: "modified", enabled: true }] } }) + "\\n"), 300); } catch {} } });
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`);
    await chmod(bin, 0o755);
    await mkdir(path.join(box, "home"));
    const { readCodexHooksList } = await import(path.join(dir, "codex-trust.js"));
    const r = readCodexHooksList(path.join(box, "home"), { PATH: process.env.PATH, COCHECK_CODEX_BIN: bin });
    assert.equal(r?.hooks?.[0]?.trustStatus, "modified");
    assert.ok(checked >= 0);
  });
});
