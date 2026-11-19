import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { runProbe } from "../scripts/probe-host.ts";

// A fake host that emits personal values (emails, the home path, token-shaped strings) into hook stdin and the session file.
// FAKE_STDIN is the hook stdin text; FAKE_SESSION is the session file text. Both come from the test.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("fake-host 9.8.7"); process.exit(0); }
const isCodex = !!process.env.CODEX_HOME;
let commands = [];
let session;
if (isCodex) {
  const cfg = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
  commands = [...cfg.matchAll(/^command = (".*")$/gm)].map((m) => JSON.parse(m[1]));
  session = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "18", "rollout-fake.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
} else {
  const settings = JSON.parse(fs.readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
  for (const groups of Object.values(settings.hooks)) for (const g of groups) for (const h of g.hooks) commands.push(h.command);
  session = path.join(process.env.FAKE_CLAUDE_PROJECTS, "t.jsonl");
  fs.mkdirSync(path.dirname(session), { recursive: true });
}
fs.writeFileSync(session, process.env.FAKE_SESSION + "\\n");
for (const c of commands) {
  const stdin = JSON.stringify({ hook_event_name: "x", transcript_path: session, extra: process.env.FAKE_STDIN });
  spawnSync("/bin/sh", ["-c", c], { input: stdin });
}
`;

const made: string[] = [];
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

async function setup(stdin: string, session: string) {
  const root = await mkdtemp(path.join(tmpdir(), "cocheck-probe-test-"));
  made.push(root);
  const bin = path.join(root, "fakehost");
  await writeFile(bin, FAKE);
  await chmod(bin, 0o755);
  const auth = path.join(root, "auth-src.json");
  await writeFile(auth, "{}");
  const home = path.join(root, "home");
  await mkdir(home);
  process.env.FAKE_STDIN = stdin;
  process.env.FAKE_SESSION = session;
  process.env.FAKE_CLAUDE_PROJECTS = path.join(root, "claude-projects");
  return { root, bin, auth, home, out: path.join(root, "out") };
}

async function allText(dir: string): Promise<string> {
  let s = "";
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    s += e.isDirectory() ? await allText(p) : (await readFile(p, "utf8")) + "\n";
  }
  return s;
}

describe("probe-host scrubs recordings", () => {
  for (const host of ["codex", "claude"] as const) {
    it(`${host}: emails and the home path are replaced in payloads and session files`, async () => {
      const probe = await setup("", "");
      const real = await realpath(probe.home);
      const stdin = `cwd ${probe.home}/proj and ${real}/proj mail jane.doe+x@mail.example.net`;
      const session = `{"cwd":"${probe.home}/a","by":"someone@corp.example.org","r":"${real}/b"}`;
      process.env.FAKE_STDIN = stdin;
      process.env.FAKE_SESSION = session;
      const r = await runProbe({ host, out: probe.out, bin: probe.bin, authSrc: probe.auth, realHome: probe.home, tmpRoot: probe.root });
      const text = await allText(r.dir);
      assert.ok(!text.includes(probe.home), "home path leaked");
      assert.ok(!text.includes(real), "real home path leaked");
      assert.ok(!/jane\.doe|mail\.example\.net|someone@|corp\.example/.test(text), "email leaked");
      assert.ok(text.includes("user@example.com"));
      assert.ok(text.includes("/Users/<user>/proj"));
      const sess = await readFile(path.join(r.dir, "sessions", host === "codex" ? "rollout-fake.jsonl" : "t.jsonl"), "utf8");
      assert.ok(sess.includes("/Users/<user>/a") && sess.includes("user@example.com") && sess.includes("/Users/<user>/b"));
    });
  }

  const planted: Array<[string, string]> = [
    ["sk-", "key sk-abcdefghijklmnopqrstuvwx1234"],
    ["ghp_", "tok ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["gho_", "tok gho_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["jwt", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123_-xyz"],
    ["bearer", "Authorization: Bearer abc123DEF456ghi789"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
  ];
  for (const [name, value] of planted) {
    it(`a planted ${name} in the payload fails the run and leaves nothing in <out>`, async () => {
      const t = await setup(value, "{}");
      await assert.rejects(
        runProbe({ host: "claude", out: t.out, bin: t.bin, realHome: t.home, tmpRoot: t.root }),
        (e: Error) => /token-shaped/.test(e.message) && /removed/.test(e.message),
      );
      assert.equal(existsSync(path.join(t.out, "claude-9.8.7")), false);
    });
  }

  it("a planted token in a session file fails the run and removes the written files", async () => {
    const t = await setup("fine", '{"k":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}');
    await assert.rejects(runProbe({ host: "codex", out: t.out, bin: t.bin, authSrc: t.auth, realHome: t.home, tmpRoot: t.root }), /token-shaped/);
    assert.equal(existsSync(path.join(t.out, "codex-9.8.7")), false);
  });

  it("clean recordings pass and ordinary words like Bearer or sk- alone do not trip the check", async () => {
    const t = await setup("the Bearer of task-list sk-1", "{}");
    const r = await runProbe({ host: "claude", out: t.out, bin: t.bin, realHome: t.home, tmpRoot: t.root });
    assert.ok(existsSync(path.join(r.dir, "payloads.jsonl")));
  });
});
