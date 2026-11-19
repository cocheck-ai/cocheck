import { afterEach, after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { hasSealHeader, openBytes } from "../src/seal.ts";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { startReviewServer } from "../src/review-server.ts";
import { firstSecretRule } from "../src/secret-scan.ts";
import { trackedClaims } from "./helpers/claims.ts";

// A file whose text holds a gitleaks-shaped secret is a secret file whatever its name: kept as its hash only (never stored, rendered or
// diffed), recorded with the secret line and the reason. The Guards against: a plain file is
// still kept whole and shown. Real hook adapter, real review server, scratch home.

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const TOKEN = "t".repeat(40);
// Built at run time so the source holds no token-shaped literal. A realistic GitHub token: no stopword, entropy over the rule's floor.
const GHP = "ghp_" + "R7xK2mQ9vL4pW8nT3zY6bH1cJ5dF0gS2aE7u";
const PLAIN = "Quarterly notes: revenue up, churn flat.\n";
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

let scratch = "";
before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "cocheck-secret-content-"));
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(start: Record<string, string> = {}) {
  const home = await mkdtemp(path.join(scratch, "home-"));
  const folder = await realpath(await mkdtemp(path.join(scratch, "folder-")));
  await writeFile(path.join(folder, "readme.md"), "start\n");
  for (const [rel, text] of Object.entries(start)) await writeFile(path.join(folder, rel), text);
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => null, quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
  });
  const get = (p: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
  const hostOpts = { perSession: false, host: "claude" as const, home, claimed: trackedClaims, folder };
  const base = JSON.parse(await readFile(path.join(FIXTURES, "hooks", "claude-pre-bash.json"), "utf8")) as HookPayload;
  const send = (over: Record<string, unknown>) => handleHook({ ...base, cwd: folder, ...over } as HookPayload, hostOpts);
  const ask = (prompt: string) => send({ hook_event_name: "UserPromptSubmit", prompt, tool_name: undefined, tool_input: undefined, tool_use_id: undefined });
  const call = async (id: string, act: () => Promise<void>) => {
    const tool_input = { command: "python3 write_files.py", description: "Write the files" };
    await send({ hook_event_name: "PreToolUse", tool_use_id: id, tool_input });
    await act();
    await send({ hook_event_name: "PostToolUse", tool_use_id: id, tool_input, tool_response: { stdout: "", stderr: "" } });
  };
  const stop = async (): Promise<number> => {
    const r = await send({ hook_event_name: "Stop", tool_name: undefined, tool_input: undefined, tool_use_id: undefined });
    assert.ok(r.summary, "the stop closes a task");
    return r.summary.taskId;
  };
  const p = (rel: string) => path.join(folder, rel);
  return { home, ledger, get, ask, call, stop, p };
}

describe("secret in a file's text", () => {
  it("the gitleaks rules find the test token (and allow AWS's documentation key, as gitleaks does)", () => {
    assert.equal(firstSecretRule(GHP), "github-pat");
    assert.equal(firstSecretRule(`echo "AKIA${"IOSFODNN7EXAMPLE"}"`), undefined, "gitleaks allowlists AWS's documentation key (aws-access-token: .+EXAMPLE$)");
    // The live test's token holds the alphabet run, a gitleaks global stopword, so gitleaks itself does not flag it.
    assert.equal(firstSecretRule("ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"), undefined);
  });

  it("a plain-named file holding a token is withheld whole with the reason, never stored or shown; a plain file is kept and shown", async () => {
    const t = await setup();
    await t.ask("Create t21/config.txt with the token I gave you, and t21/notes.txt with the notes.");
    await t.call("toolu_W1", async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(t.p("t21"), { recursive: true });
      await writeFile(t.p("t21/config.txt"), `${GHP}\n`);
      await writeFile(t.p("t21/notes.txt"), PLAIN);
    });
    const id = await t.stop();

    const states = t.ledger.fileStatesForTask(id);
    const config = states.find((r) => r.filePath.replaceAll("\\", "/").endsWith("t21/config.txt"));
    const notes = states.find((r) => r.filePath.replaceAll("\\", "/").endsWith("t21/notes.txt"));
    assert.ok(config && notes, "both files have a state");
    assert.equal(config.kept, "hash", "the secret-holding file is kept as its hash only");
    assert.match(config.note, /^A secret file was changed: t21\/config\.txt; its text holds a value that looks like a secret \(gitleaks rule github-pat\)/);
    assert.equal(notes.kept, "whole", "the plain file is kept whole");
    const store = await readdir(path.join(t.home, "tasks", String(id), "states")).catch(() => [] as string[]);
    assert.ok(!store.includes(config.sha256), "the secret's bytes are not in the store");
    assert.ok(store.includes(sha(PLAIN)), "the plain file's bytes are in the store");

    const tl = await t.get(`/timeline/${id}`);
    assert.equal(tl.status, 200);
    assert.ok(!tl.body.includes(GHP), "the timeline holds no token");
    assert.match(tl.body, /A secret file was changed: t21\/config\.txt/);
    const page = await t.get(`/timeline/${id}/page`);
    assert.equal(page.status, 200);
    assert.ok(!page.body.includes(GHP), "the page holds no token");
    assert.ok(page.body.includes("A secret file was changed: t21/config.txt"), "the page says why the file is withheld");
    assert.ok(page.body.includes("Quarterly notes"), "the plain file's text is still on the page");
    assert.ok(!JSON.stringify({ states, ops: t.ledger.okOpsForTask(id, 0, t.ledger.maxOpId()) }).includes(GHP), "the ledger holds no token");
  });

  it("round path: a file plain at the start that gains a token leaves no token in review rows, round copies or states", async () => {
    const t = await setup({ "config.txt": PLAIN, "notes.txt": "Meeting notes.\n" });
    await t.call("toolu_R1", () => writeFile(t.p("config.txt"), PLAIN + `token=${GHP}\n`));
    await t.call("toolu_R1b", () => writeFile(t.p("notes.txt"), "Meeting notes.\nship on Friday\n"));
    const id = await t.stop();
    await assertNoToken(t, id);
    // the round writes no row; each change is a file state (the page's text diff comes from the states).
    const changed = t.ledger.fileStatesForTask(id).filter((x) => x.prevSha256 !== null).map((x) => path.basename(x.filePath));
    assert.ok(changed.includes("config.txt"), "the change to the secret file is still a state");
    assert.ok(changed.includes("notes.txt"), "the plain file's change is still a state");
  });

  it("round path: a token file present at the start, then edited, leaves no token in review rows, round copies or states", async () => {
    const t = await setup({ "config.txt": `token=${GHP}\n` });
    await t.call("toolu_R2a", () => writeFile(t.p("notes.txt"), PLAIN));
    await t.call("toolu_R2b", () => writeFile(t.p("config.txt"), `token=${GHP}\nmore=1\n`));
    const id = await t.stop();
    await assertNoToken(t, id);
  });

  it("a token past the first 4 MB of a large text file is found in its last 2 MB", async () => {
    const t = await setup();
    const big = "log line without anything in it\n".repeat(Math.ceil((5 * 1024 * 1024) / 32)) + `token=${GHP}\n`;
    await t.call("toolu_B1", () => writeFile(t.p("big.log"), big));
    const id = await t.stop();
    const row = t.ledger.fileStatesForTask(id).find((r) => r.filePath.endsWith("big.log"));
    assert.equal(row?.kept, "hash");
    await assertNoToken(t, id);
  });
});

async function homeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await homeFiles(f)));
    else if (e.isFile()) out.push(f);
  }
  return out;
}

/** No token in the ledger's review rows, in any file under the home (sealed copies opened: round folders, states), or on the page. */
async function assertNoToken(t: Awaited<ReturnType<typeof setup>>, id: number): Promise<void> {
  assert.ok(!JSON.stringify([t.ledger.reviewRowsForTask(id), t.ledger.fileStatesForTask(id)]).includes(GHP), "review rows and file states hold no token");
  const rounds = await homeFiles(path.join(t.home, "tasks", String(id)));
  assert.ok(rounds.some((f) => /round-\d+/.test(f)), "the task has round copies");
  for (const f of await homeFiles(t.home)) {
    const raw = await readFile(f);
    const b: Buffer = hasSealHeader(raw) ? openBytes(raw, f, t.home) : raw;
    assert.ok(!b.includes(GHP), `${path.relative(t.home, f)} holds no token`);
  }
  const page = await t.get(`/timeline/${id}/page`);
  assert.ok(!page.body.includes(GHP), "the page holds no token");
}

