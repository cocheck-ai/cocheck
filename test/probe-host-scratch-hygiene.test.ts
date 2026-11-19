import { posixOnly } from "./helpers/platform.ts";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { realpath, chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { runProbe, sweepStaleScratch } from "../scripts/probe-host.ts";

// A fake host binary: answers --version, then feeds fixed payloads to the hook commands it finds in the scratch config,
// the way the real host would, and writes a session file where the real one would.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const rec = process.env.FAKE_RECORD;
if (args[0] === "--version") { console.log(process.env.FAKE_VERSION_LINE || "fake-host 9.8.7"); process.exit(0); }
const isCodex = !!process.env.CODEX_HOME;
let commands = [];
let session;
if (isCodex) {
  const cfg = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
  commands = [...cfg.matchAll(/^command = (".*")$/gm)].map((m) => JSON.parse(m[1]));
  session = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "18", "rollout-fake.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(rec + ".auth", fs.existsSync(path.join(process.env.CODEX_HOME, "auth.json")) ? (fs.statSync(path.join(process.env.CODEX_HOME, "auth.json")).mode & 0o777).toString(8) : "missing");
  fs.writeFileSync(rec + ".authpath", path.join(process.env.CODEX_HOME, "auth.json"));
} else {
  const settings = JSON.parse(fs.readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
  for (const groups of Object.values(settings.hooks)) for (const g of groups) for (const h of g.hooks) commands.push(h.command);
  session = path.join(process.env.FAKE_CLAUDE_PROJECTS, "t.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
}
fs.writeFileSync(rec + ".args", JSON.stringify(args));
fs.writeFileSync(session, '{"type":"fake"}\\n');
for (const c of commands) {
  const ev = c.split(" ").filter((x) => /^[A-Z][A-Za-z]+$/.test(x.replace(/"/g, "")))[0];
  spawnSync("/bin/sh", ["-c", c], { input: JSON.stringify({ hook_event_name: "x", transcript_path: session }) });
}
if (process.env.FAKE_FAIL) { console.error("boom"); process.exit(3); }
`;

const made: string[] = [];
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

async function tmpRoot(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "cocheck-probe-test-"));
  made.push(d);
  return d;
}

async function setup() {
  const root = await tmpRoot();
  const bin = path.join(root, "fakehost");
  await writeFile(bin, FAKE);
  await chmod(bin, 0o755);
  const auth = path.join(root, "auth-src.json");
  await writeFile(auth, '{"token":"secret"}');
  const out = path.join(root, "out");
  const home = path.join(root, "home");
  await mkdir(home);
  const record = path.join(root, "record");
  const projects = path.join(root, "claude-projects");
  process.env.FAKE_RECORD = record;
  process.env.FAKE_CLAUDE_PROJECTS = projects;
  delete process.env.FAKE_FAIL;
  return { root, bin, auth, out, home, record };
}

describe("probe-host", () => {
  it("codex: files land in <out>/codex-<version>/ and the auth copy is gone", posixOnly("the fake agent is a shebang script and its hooks run through /bin/sh"), async () => {
    const t = await setup();
    const r = await runProbe({ host: "codex", out: t.out, bin: t.bin, authSrc: t.auth, realHome: t.home, tmpRoot: t.root });
    assert.equal(r.dir, path.join(await realpath(t.root), "out", "codex-9.8.7"));
    const lines = (await readFile(path.join(r.dir, "payloads.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.length >= 5);
    assert.ok(lines.some((l) => l.event === "PreToolUse"));
    assert.equal(JSON.parse(lines[0].stdin).hook_event_name, "x");
    const sessions = await readdir(path.join(r.dir, "sessions"));
    assert.deepEqual(sessions, ["rollout-fake.jsonl"]);
    assert.equal(await readFile(t.record + ".auth", "utf8"), "600");
    const args = JSON.parse(await readFile(t.record + ".args", "utf8"));
    assert.ok(args.includes("--dangerously-bypass-hook-trust"));
    assert.ok(args.includes("exec"));
    assert.equal(existsSync(await readFile(t.record + ".authpath", "utf8")), false);
    // the source auth is untouched
    assert.equal(await readFile(t.auth, "utf8"), '{"token":"secret"}');
  });

  it("codex: the auth copy is gone after a forced failure too", posixOnly("the fake agent is a shebang script and its hooks run through /bin/sh"), async () => {
    const t = await setup();
    process.env.FAKE_FAIL = "1";
    await assert.rejects(runProbe({ host: "codex", out: t.out, bin: t.bin, authSrc: t.auth, realHome: t.home, tmpRoot: t.root }), /exit|3|boom/);
    delete process.env.FAKE_FAIL;
    assert.equal(existsSync(await readFile(t.record + ".authpath", "utf8")), false);
  });

  it("claude: uses --setting-sources empty plus --settings, copies the transcript named in the payload", posixOnly("the fake agent is a shebang script and its hooks run through /bin/sh"), async () => {
    const t = await setup();
    const r = await runProbe({ host: "claude", out: t.out, bin: t.bin, realHome: t.home, tmpRoot: t.root });
    assert.equal(r.dir, path.join(await realpath(t.root), "out", "claude-9.8.7"));
    const args = JSON.parse(await readFile(t.record + ".args", "utf8"));
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
    assert.ok(args.includes("-p"));
    assert.ok(existsSync(path.join(r.dir, "payloads.jsonl")));
    assert.deepEqual(await readdir(path.join(r.dir, "sessions")), ["t.jsonl"]);
  });

  it("detects the version from a noisy --version line", posixOnly("the fake agent is a shebang script and its hooks run through /bin/sh"), async () => {
    const t = await setup();
    process.env.FAKE_VERSION_LINE = "2.1.143 (Claude Code)";
    try {
      const r = await runProbe({ host: "claude", out: t.out, bin: t.bin, realHome: t.home, tmpRoot: t.root });
      assert.equal(path.basename(r.dir), "claude-2.1.143");
    } finally {
      delete process.env.FAKE_VERSION_LINE;
    }
  });

  it("refuses an <out> inside ~/.codex or ~/.claude, and writes nothing", async () => {
    const t = await setup();
    for (const dot of [".codex", ".claude"]) {
      const bad = path.join(t.home, dot, "probe");
      await assert.rejects(runProbe({ host: "codex", out: bad, bin: t.bin, authSrc: t.auth, realHome: t.home, tmpRoot: t.root }), /refus/i);
      assert.equal(existsSync(path.join(t.home, dot)), false);
    }
    assert.equal(existsSync(t.record + ".args"), false);
  });

  it("refuses an <out> that reaches ~/.codex through a symlink", async () => {
    const t = await setup();
    await mkdir(path.join(t.home, ".codex"));
    const link = path.join(t.root, "link");
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(t.home, ".codex"), link);
    await assert.rejects(runProbe({ host: "codex", out: path.join(link, "x"), bin: t.bin, authSrc: t.auth, realHome: t.home, tmpRoot: t.root }), /refus/i);
    assert.deepEqual(await readdir(path.join(t.home, ".codex")), []);
  });
});

describe("probe-host scratch hygiene", () => {
  const HOUR = 3600_000;
  const age = async (d: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    await utimes(d, t, t);
  };

  it("sweep removes a stale cocheck-probe-XXXXXX dir, keeps a fresh one and any other prefix", async () => {
    const root = await tmpRoot();
    const stale = path.join(root, "cocheck-probe-aB3dE9");
    const fresh = path.join(root, "cocheck-probe-zZ9yX8");
    const other = path.join(root, "other-probe-aB3dE9");
    const near = path.join(root, "cocheck-probe2-aB3dE9");
    const testDir = path.join(root, "cocheck-probe-test-aB3dE9");
    for (const d of [stale, fresh, other, near, testDir]) {
      await mkdir(d);
      await writeFile(path.join(d, "auth.json"), "x");
    }
    for (const d of [stale, other, near, testDir]) await age(d, 2 * HOUR);
    await sweepStaleScratch(root);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(other), true);
    assert.equal(existsSync(near), true);
    // the tests' own prefix never matches the probe's scratch pattern, even when old
    assert.equal(existsSync(testDir), true);
  });

  it("sweep does not follow a stale symlink or remove a plain file with the prefix", async () => {
    const root = await tmpRoot();
    const victim = path.join(root, "victim");
    await mkdir(victim);
    await writeFile(path.join(victim, "keep"), "x");
    const { symlink, lutimes } = await import("node:fs/promises");
    const link = path.join(root, "cocheck-probe-LnK123");
    await symlink(victim, link);
    await lutimes(link, new Date(0), new Date(0));
    const file = path.join(root, "cocheck-probe-FiL123");
    await writeFile(file, "x");
    await age(file, 2 * HOUR);
    await sweepStaleScratch(root);
    assert.equal(existsSync(path.join(victim, "keep")), true);
    assert.equal(existsSync(file), true);
  });

  it("runProbe sweeps stale scratch in its tmp root at start", posixOnly("the fake agent is a shebang script and its hooks run through /bin/sh"), async () => {
    const t = await setup();
    const stale = path.join(t.root, "cocheck-probe-St4le1");
    await mkdir(stale);
    await age(stale, 2 * HOUR);
    await runProbe({ host: "claude", out: t.out, bin: t.bin, realHome: t.home, tmpRoot: t.root });
    assert.equal(existsSync(stale), false);
  });

  it("SIGTERM during the host run removes the scratch dir (and the auth copy) before exit", posixOnly("the fake agent is a shebang script and its hooks run through /bin/sh"), async () => {
    const t = await setup();
    const hang = path.join(t.root, "hanghost");
    await writeFile(hang, '#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("1.2.3"); process.exit(0); }\nrequire("node:fs").writeFileSync(process.env.FAKE_RECORD + ".up", "1");\nsetInterval(() => {}, 1000);\n');
    await chmod(hang, 0o755);
    const tmp = path.join(t.root, "tmp");
    await mkdir(tmp);
    const script = path.resolve(import.meta.dirname, "../scripts/probe-host.ts");
    const child = spawn(process.execPath, [script, "codex", "--out", t.out, "--bin", hang, "--auth", t.auth], {
      env: { ...process.env, TMPDIR: tmp, HOME: t.home },
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
    for (let i = 0; i < 200 && !existsSync(t.record + ".up"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(t.record + ".up"), "host never started");
    child.kill("SIGTERM");
    await exited;
    assert.deepEqual((await readdir(tmp)).filter((n) => n.startsWith("cocheck-probe-")), []);
  });
});
