import { posixOnly } from "./helpers/platform.ts";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { runProbe } from "../scripts/probe-host.ts";

// `probe-host.ts copilot`. A fake `copilot` answers --version, reads the repo hook file the probe wrote, runs each hook command with a
// payload, and writes session-state/<id>/events.jsonl under COPILOT_HOME. The real copilot binary and ~/.copilot are never touched.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("GitHub Copilot CLI 7.6.5."); process.exit(0); }
const rec = process.env.FAKE_RECORD;
fs.writeFileSync(rec, JSON.stringify({ args, cwd: process.cwd(), home: process.env.COPILOT_HOME, allowAll: process.env.COPILOT_ALLOW_ALL, hasGit: fs.existsSync(path.join(process.cwd(), ".git")) }));
const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".github", "hooks", "log.json"), "utf8"));
const session = path.join(process.env.COPILOT_HOME, "session-state", "sess-1", "events.jsonl");
fs.mkdirSync(path.dirname(session), { recursive: true });
fs.writeFileSync(session, '{"type":"session.start"}\\n');
for (const list of Object.values(cfg.hooks)) for (const h of list) spawnSync("/bin/sh", ["-c", h.bash], { input: JSON.stringify({ sessionId: "sess-1", cwd: process.cwd() }) });
`;

const made: string[] = [];
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

describe("probe-host copilot", () => {
  it("runs in a scratch git repo with a scratch COPILOT_HOME, the recipe's flags, and writes payloads and the session file", posixOnly("the fake agent is a shebang script and its hooks run through /bin/sh"), async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-probe-test-")));
    made.push(root);
    const bin = path.join(root, "copilot");
    await writeFile(bin, FAKE);
    await chmod(bin, 0o755);
    const home = path.join(root, "home");
    await mkdir(path.join(home, ".copilot"), { recursive: true });
    process.env.FAKE_RECORD = path.join(root, "record");
    const r = await runProbe({ host: "copilot", out: path.join(root, "out"), bin, realHome: home, tmpRoot: root });
    assert.equal(r.dir, path.join(root, "out", "copilot-7.6.5"));
    const seen = JSON.parse(await readFile(path.join(root, "record"), "utf8"));
    assert.deepEqual(seen.args.slice(0, 1), ["-p"]);
    assert.ok(seen.args.includes("--no-auto-update") && seen.args.includes("--no-remote"));
    assert.equal(seen.allowAll, "true");
    assert.equal(seen.hasGit, true);
    assert.ok(seen.home.startsWith(root) && !seen.home.startsWith(path.join(home, ".copilot")), "COPILOT_HOME is a scratch dir");
    const lines = (await readFile(path.join(r.dir, "payloads.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.event === "preToolUse") && lines.some((l) => l.event === "agentStop"));
    assert.deepEqual(await readdir(path.join(r.dir, "sessions")), ["sess-1-events.jsonl"]);
    assert.equal(existsSync(seen.home), false, "the scratch dir is gone");
    assert.deepEqual(await readdir(path.join(home, ".copilot")), [], "the real ~/.copilot stand-in is untouched");
  });
  it("refuses an out inside ~/.copilot", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-probe-test-")));
    made.push(root);
    const home = path.join(root, "home");
    await mkdir(path.join(home, ".copilot"), { recursive: true });
    await assert.rejects(runProbe({ host: "copilot", out: path.join(home, ".copilot", "out"), bin: "/bin/true", realHome: home, tmpRoot: root }), /refusing to write inside/);
  });
});
