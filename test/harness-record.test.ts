import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installStatus, runInstall } from "../src/install.ts";
import { loadOutsiderHarnesses } from "../src/hosts/index.ts";
import { loadHarnessFolder } from "../src/hosts/harnesses.ts";
import { runHarnessCreate } from "../src/harness-cmd/create.ts";
import { runHarnessCommand, type HarnessIo } from "../src/harness-cmd/index.ts";
import { recordRun, recordStop } from "../src/harness-cmd/record.ts";
import { posixOnly } from "./helpers/platform.ts";
import { TOY } from "./harness-toy-rig.ts";

// `cocheck harness create` and `record`, and the last-event lines of `cocheck status`. Every run uses temp folders; one of them stands in for the real home.
const KIT_SCAFFOLD = path.resolve(import.meta.dirname, "..", "public-kit", "harness", "scaffold");
const hookPath = path.resolve(import.meta.dirname, "..", "src", "hook.ts");
let sandbox: string;
afterEach(async () => {
  loadOutsiderHarnesses(undefined);
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});
const fresh = (): string => (sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), "cocheck-harness-rec-"))));
const io = (cwd: string): HarnessIo & { outText: string; errText: string } => {
  const o = { outText: "", errText: "", out: (t: string) => void (o.outText += `${t}\n`), err: (t: string) => void (o.errText += `${t}\n`), cwd, env: process.env };
  return o;
};

/** Every file under dir with its content, for an unchanged-tree check. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

describe("cocheck harness create", () => {
  it("makes a folder whose manifest validates as an outsider and loads from the outsider folder", () => {
    const root = fresh();
    const o = io(root);
    assert.equal(runHarnessCreate(["fancy-bot"], o), 0, o.errText);
    const dir = path.join(root, "fancy-bot");
    assert.ok(existsSync(path.join(dir, "recordings")) && readdirSync(path.join(dir, "recordings")).length === 0);
    const manifest = JSON.parse(readFileSync(path.join(dir, "cocheck-harness.json"), "utf8"));
    assert.equal(manifest.key, "fancy-bot");
    assert.match(readFileSync(path.join(dir, "cocheck-harness.json"), "utf8"), /FANCY_BOT_HOME/);
    const loaded = loadHarnessFolder(root, "outsider", ["claude", "codex", "copilot"]);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.profiles.map((p) => p.key), ["fancy-bot"]);
    assert.match(readFileSync(path.join(dir, "README.md"), "utf8"), /cocheck harness record fancy-bot /);
    assert.match(o.outText, /harnesses\/fancy-bot\//);
    assert.match(o.outText, /pull request/);
  });

  it("the shipped starter itself validates as an outsider manifest", () => {
    const root = fresh();
    mkdirSync(path.join(root, "myagent"));
    cpSync(path.join(KIT_SCAFFOLD, "cocheck-harness.json"), path.join(root, "myagent", "cocheck-harness.json"));
    assert.deepEqual(loadHarnessFolder(root, "outsider", []).errors, []);
  });

  it("honors --dir, and refuses a built-in key, a bad key, an existing folder", () => {
    const root = fresh();
    const o = io(root);
    assert.equal(runHarnessCreate(["mine", "--dir", "sub"], o), 0, o.errText);
    assert.ok(existsSync(path.join(root, "sub", "mine", "cocheck-harness.json")));
    for (const [args, why] of [[["claude"], /already a host/], [["all"], /already a host/], [["Bad Key"], /not a valid key/], [["mine", "--dir", "sub"], /already exists/]] as const) {
      const e = io(root);
      assert.equal(runHarnessCreate([...args], e), 1);
      assert.match(e.errText, why);
    }
    assert.ok(!existsSync(path.join(root, "claude")) && !existsSync(path.join(root, "all")), "a refused key writes nothing");
    const before = snapshot(path.join(root, "sub"));
    runHarnessCreate(["mine", "--dir", "sub"], io(root));
    assert.deepEqual(snapshot(path.join(root, "sub")), before, "an existing folder is left as it was");
  });

  it("is reachable through the router", async () => {
    const root = fresh();
    const o = io(root);
    assert.equal(await runHarnessCommand(["create", "viarouter"], o), 0, o.errText);
    assert.ok(existsSync(path.join(root, "viarouter", "cocheck-harness.json")));
  });
});

// A stand-in harness: reads the hook config from where the manifest's path template points (TOYAGENT_HOME) and calls each hook the way a harness would.
const FAKE = `import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const cfg = JSON.parse(readFileSync(process.env.TOYAGENT_HOME + "/hooks.json", "utf8"));
for (const ev of ["userPrompt", "beforeTool", "finished"]) {
  const payload = { sessionId: "s1", workspace: { roots: [process.cwd()] }, note: process.env.FAKE_NOTE ?? "plain" };
  const r = spawnSync(cfg.hooks[ev][0].run, { shell: true, input: JSON.stringify(payload), encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stderr); process.exit(9); }
}
`;
const SLEEPER = `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`;

function rig() {
  const root = fresh();
  const realHome = path.join(root, "realhome");
  const planted = {
    [path.join(realHome, ".toyagent", "hooks.json")]: '{"version":1,"hooks":{"finished":[{"run":"real-user-hook"}]}}\n',
    [path.join(realHome, ".claude", "settings.json")]: '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep"}]}]}}\n',
  };
  for (const [f, body] of Object.entries(planted)) {
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  }
  const fake = path.join(root, "fake-harness.mjs");
  writeFileSync(fake, FAKE);
  const sleeper = path.join(root, "sleeper.mjs");
  writeFileSync(sleeper, SLEEPER);
  const tmpRoot = path.join(root, "tmp");
  mkdirSync(tmpRoot);
  const out = path.join(root, "out");
  const env = { PATH: process.env.PATH, HOME: realHome, TOYAGENT_HOME: path.join(realHome, ".toyagent") };
  const base = { key: "toyagent", manifest: path.join(TOY, "cocheck-harness.json"), out, tmpRoot, realHome, env, cwd: root };
  return { root, realHome, fake, sleeper, tmpRoot, out, base };
}

describe("cocheck harness record", () => {
  it("records one line per hook call in the shared shape, and the real home is untouched", posixOnly("the logging hook is run through a POSIX shell"), async () => {
    const r = rig();
    const before = snapshot(r.realHome);
    const res = await recordRun({ ...r.base, command: [process.execPath, r.fake] });
    assert.equal(res.exitCode, 0, res.messages.join("\n"));
    const lines = readFileSync(path.join(r.out, "payloads.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((l) => l.event), ["userPrompt", "beforeTool", "finished"]);
    assert.deepEqual(lines.map((l) => l.argv), [["--event", "userPrompt"], ["--event", "beforeTool"], ["--event", "finished"]]);
    for (const l of lines) {
      assert.deepEqual(Object.keys(l).sort(), ["argv", "event", "stdin", "ts"]);
      assert.equal(typeof l.stdin, "string");
      assert.equal(JSON.parse(l.stdin).sessionId, "s1");
      assert.ok(Math.abs(l.ts - Date.now() / 1000) < 600);
    }
    assert.deepEqual(readdirSync(r.out), ["payloads.jsonl"]);
    assert.deepEqual(snapshot(r.realHome), before, "nothing under the real home changed, and nothing was added");
    assert.deepEqual(readdirSync(r.tmpRoot), [], "the scratch folder is gone");
  });

  it("scrubs emails and the home path, and a token-shaped string fails the run with nothing written", posixOnly("POSIX shell"), async () => {
    const r = rig();
    const ok = await recordRun({ ...r.base, command: [process.execPath, r.fake], env: { ...r.base.env, FAKE_NOTE: `${r.realHome}/x mail me@corp.example` } });
    assert.equal(ok.exitCode, 0, ok.messages.join("\n"));
    const text = readFileSync(path.join(r.out, "payloads.jsonl"), "utf8");
    assert.ok(!text.includes(r.realHome) && !text.includes("me@corp.example"));
    assert.match(text, /\/Users\/<user>\/x mail user@example\.com/);
    const r2 = rig();
    const bad = await recordRun({ ...r2.base, command: [process.execPath, r2.fake], env: { ...r2.base.env, FAKE_NOTE: "Bearer abcdefgh12345678" } });
    assert.equal(bad.exitCode, 1);
    assert.match(bad.messages.join("\n"), /token-shaped/);
    assert.ok(!existsSync(r2.out), "nothing is written for a token-shaped string");
  });

  it("an interrupt stops the child it started and removes only its scratch folder", posixOnly("process liveness by signal 0"), async () => {
    const r = rig();
    const pidFile = path.join(r.root, "child.pid");
    const ac = new AbortController();
    const run = recordRun({ ...r.base, command: [process.execPath, r.sleeper, pidFile], signal: ac.signal });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((res) => setTimeout(res, 50));
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0);
    ac.abort();
    const res = await run;
    assert.equal(res.interrupted, true);
    assert.equal(res.exitCode, 130);
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the child is gone");
    assert.deepEqual(readdirSync(r.tmpRoot), []);
    assert.ok(existsSync(path.join(r.realHome, ".toyagent", "hooks.json")));
  });

  it("a timeout stops the child by its handle", posixOnly("process liveness by signal 0"), async () => {
    const r = rig();
    const pidFile = path.join(r.root, "child.pid");
    const res = await recordRun({ ...r.base, command: [process.execPath, r.sleeper, pidFile], timeoutSeconds: 1 });
    assert.equal(res.exitCode, 1);
    assert.match(res.messages.join("\n"), /stopped after 1 seconds/);
    assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), /ESRCH/);
  });

  it("without a command prints the scratch folder and env, --stop finishes and scrubs, and --stop refuses a folder it did not make", posixOnly("POSIX shell"), async () => {
    const r = rig();
    const before = snapshot(r.realHome);
    const res = await recordRun({ ...r.base });
    assert.equal(res.exitCode, 0);
    assert.ok(res.scratch && existsSync(res.scratch));
    assert.match(res.messages.join("\n"), /export TOYAGENT_HOME=/);
    const cfg = JSON.parse(readFileSync(path.join(res.scratch!, "env", "TOYAGENT_HOME", "hooks.json"), "utf8"));
    const ran = spawnSync(cfg.hooks.beforeTool[0].run, { shell: true, input: '{"sessionId":"s"}', encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const stop = recordStop(res.scratch!, { realHome: r.realHome });
    assert.equal(stop.exitCode, 0, stop.messages.join("\n"));
    assert.equal(readFileSync(path.join(r.out, "payloads.jsonl"), "utf8").split("\n").filter(Boolean).length, 1);
    assert.ok(!existsSync(res.scratch!));
    assert.deepEqual(snapshot(r.realHome), before);
    // A folder with no marker is neither read nor removed.
    const stranger = path.join(r.root, "cocheck-record-stranger");
    mkdirSync(stranger);
    writeFileSync(path.join(stranger, "keep.txt"), "mine");
    assert.equal(recordStop(stranger).exitCode, 1);
    assert.ok(existsSync(path.join(stranger, "keep.txt")));
  });

  it("a workspace-scoped config ({project}) is written in the scratch work folder, where the harness runs", posixOnly("POSIX shell"), async () => {
    const r = rig();
    const before = snapshot(r.realHome);
    const m = JSON.parse(readFileSync(path.join(TOY, "cocheck-harness.json"), "utf8"));
    m.install.path = "{project}/.toyagent/hooks.json";
    const dir = path.join(r.root, "toy-project", "toyagent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "cocheck-harness.json"), JSON.stringify(m));
    const res = await recordRun({ ...r.base, manifest: path.join(dir, "cocheck-harness.json") });
    assert.equal(res.exitCode, 0, res.messages.join("\n"));
    const file = path.join(res.scratch!, "work", ".toyagent", "hooks.json");
    assert.ok(existsSync(file), res.messages.join("\n"));
    assert.match(res.messages.join("\n"), new RegExp(`cd .*${path.join(res.scratch!, "work").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    recordStop(res.scratch!, { realHome: r.realHome }); // no hook ran, so nothing is written; this removes the scratch folder
    assert.ok(!existsSync(res.scratch!));
    assert.deepEqual(snapshot(r.realHome), before);
  });

  it("refuses an existing payload file and an --out inside the harness's real config folder", async () => {
    const r = rig();
    mkdirSync(r.out);
    writeFileSync(path.join(r.out, "payloads.jsonl"), "old\n");
    const a = await recordRun({ ...r.base, command: [process.execPath, r.fake] });
    assert.equal(a.exitCode, 1);
    assert.equal(readFileSync(path.join(r.out, "payloads.jsonl"), "utf8"), "old\n");
    const b = await recordRun({ ...r.base, out: path.join(r.realHome, ".toyagent", "rec"), command: [process.execPath, r.fake] });
    assert.equal(b.exitCode, 1);
    assert.ok(!existsSync(path.join(r.realHome, ".toyagent", "rec")));
  });

  it("the router prints usage for a bad call", async () => {
    const r = rig();
    const o = io(r.root);
    assert.equal(await runHarnessCommand(["record", "toyagent"], o), 2);
    assert.match(o.errText, /usage: cocheck harness record <key> --manifest <path> --out <dir>/);
  });
});

describe("status: the last event seen per harness", () => {
  it("shows the last event for a built-in and an outsider harness, and 'no event seen yet' before one", async () => {
    const root = fresh();
    const userHome = path.join(root, "home");
    mkdirSync(path.join(userHome, ".claude"), { recursive: true });
    const folder = path.join(root, "work");
    mkdirSync(folder);
    const dataHome = path.join(root, "data");
    cpSync(TOY, path.join(dataHome, "harnesses", "toyagent"), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: userHome, CLAUDE_CONFIG_DIR: path.join(userHome, ".claude"), CODEX_HOME: path.join(userHome, ".codex"), COPILOT_HOME: path.join(userHome, ".copilot") };
    const res = await runInstall({ argv: ["node", "install.ts", "--home", dataHome, "--folder", folder, "--for", "claude"], env, cwd: root, hookPath, stopReview: async () => "none" });
    assert.equal(res.exitCode, 0, res.stderr);
    const none = installStatus(env, userHome, undefined).text;
    assert.match(none, /Claude: installed \([^)]*\); hooks have not fired yet\n    no event seen yet\n/);
    assert.match(none, /Toy Agent \(your harness\):\n    no event seen yet\n/);
    const j = path.join(dataHome, "journal");
    mkdirSync(j, { recursive: true });
    const line = (host: string, event: string, ms: number) => JSON.stringify({ v: 1, k: "event", host, event, at: new Date(Date.now() - ms).toISOString() });
    writeFileSync(path.join(j, "s.jsonl"), `${line("claude", "PreToolUse", 5 * 60_000)}\n${line("toyagent", "beforeTool", 2 * 3_600_000)}\n`);
    const text = installStatus(env, userHome, undefined).text;
    assert.match(text, /hooks last fired 5 min ago \([^)]*\)\n    last event: PreToolUse, 5 min ago \(/);
    assert.match(text, /Toy Agent \(your harness\):\n    last event: beforeTool, 2 h ago \(/);
  });
});
