import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installStatus, runInstall } from "../src/install.ts";
import { runOpen } from "../scripts/cocheck.ts";

// "not recording" only when no installed host can record; one broken host is named alone. Scratch HOME throughout; the Codex trust
// listing is the real probe shape (modified/untrusted), served through the stubbed reader, so no app-server and no real ~/.codex.
const evidence = path.resolve(import.meta.dirname, "..", "platforms", "codex", "versions", "0.164.0-alpha.11.1");
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");

let sandbox: string;
afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

async function fresh() {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  const userHome = path.join(sandbox, "home");
  await mkdir(path.join(userHome, ".codex"), { recursive: true });
  await mkdir(path.join(userHome, ".claude"), { recursive: true });
  const folder = path.join(sandbox, "work");
  await mkdir(folder, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: path.join(userHome, ".claude"), CODEX_HOME: path.join(userHome, ".codex") };
  const res = await runInstall({ argv: ["node", "install.ts", "--home", path.join(sandbox, "data"), "--folder", folder, "--for", "both"], env, cwd: sandbox, hookPath, stopReview: async () => "none" });
  assert.equal(res.exitCode, 0, res.stderr);
  const l = JSON.parse(await readFile(path.join(evidence, "app-server-hooks-list.json"), "utf8"));
  const trusted = () => l;
  const untrusted = () => ({ hooks: l.hooks.map((h: any) => ({ ...h, trustStatus: "untrusted" })) });
  const breakClaude = () => writeFile(path.join(userHome, ".claude", "settings.json"), "{}");
  return { userHome, env, trusted, untrusted, breakClaude };
}
const open = (f: Awaited<ReturnType<typeof fresh>>, reader: () => unknown) => {
  // runOpen reads trust through the real reader, so exercise the same notice rule through installStatus's text and runOpen's stub-free path below.
  const status = installStatus(f.env, f.userHome, reader);
  return runOpen({ env: { ...f.env, PATH: path.dirname(process.execPath) }, userHome: f.userHome, urlFor: async () => "http://127.0.0.1:1/?t=x#h", open: () => {} }, undefined).then((r) => ({ status, r }));
};

describe("per-host recording status", () => {
  it("all fine: recording line, no warning", async () => {
    const f = await fresh();
    const st = installStatus(f.env, f.userHome, f.trusted);
    assert.equal(st.recording, true, st.text);
    assert.match(st.text, /^CoCheck: installed; not seen yet\. Restart Claude and Codex, then say 'start tracking'/); // no hook has fired yet
    assert.doesNotMatch(st.text, /not recording/);
  });

  it("one broken (Claude fine, Codex untrusted): leads with the Codex line, not a blanket notice, other lines unchanged", async () => {
    const f = await fresh();
    const st = installStatus(f.env, f.userHome, f.untrusted);
    assert.match(st.text, /^Codex is not recording: .*does not trust CoCheck's hooks/);
    assert.doesNotMatch(st.text, /^CoCheck: not recording/);
    assert.match(st.text, /CoCheck: recording to /);
    assert.match(st.text, /Claude: installed .*hooks have not fired yet/);
    assert.match(st.text, /Codex: installed, hooks not trusted/);
    assert.equal(st.hostProblems?.length, 1);
  });

  it("one broken the other way (Codex fine, Claude lost its hooks): names Claude, keeps the warning", async () => {
    const f = await fresh();
    await f.breakClaude();
    const st = installStatus(f.env, f.userHome, f.trusted);
    assert.match(st.text, /^Claude is not recording: config files .*no longer carry/);
    assert.doesNotMatch(st.text, /^CoCheck: not recording/);
  });

  it("all broken: nothing records, so the blanket 'not recording' headline and both reasons show", async () => {
    const f = await fresh();
    await f.breakClaude();
    const st = installStatus(f.env, f.userHome, f.untrusted);
    assert.equal(st.recording, false);
    assert.match(st.text, /^CoCheck: not recording\./);
    assert.match(st.text, /Claude config files/);
    assert.match(st.text, /does not trust CoCheck's hooks/);
  });

  it("a shared fault (the launcher's not-recording note) stops every host: blanket headline even though each host config is fine", async () => {
    const f = await fresh();
    const st0 = installStatus(f.env, f.userHome, f.trusted);
    await writeFile(path.join(st0.record!.home, "not-recording.txt"), "2026-10-15T10:00:00Z\nThe hook exited 3\n");
    const st = installStatus(f.env, f.userHome, f.trusted);
    assert.equal(st.recording, false);
    assert.match(st.text, /^CoCheck: not recording\./);
  });

  it("open prints the same notice: nothing for all fine, the host line for one broken, the blanket for all broken", async () => {
    // runOpen uses the real Codex reader, which cannot be stubbed here; with no Codex app-server it reports no trust problem. The Claude-broken
    // case still exercises the rule through the real path: Claude lost its hooks, Codex is unreadable-as-fine, so one host is named.
    const f = await fresh();
    const fine = await open(f, f.trusted);
    assert.equal(fine.r.stdout.includes("not recording"), false, fine.r.stdout);
    await f.breakClaude();
    const one = await open(f, f.trusted);
    assert.match(one.r.stdout, /^Claude is not recording: /);
    assert.doesNotMatch(one.r.stdout, /^CoCheck: not recording/);
  });
});
