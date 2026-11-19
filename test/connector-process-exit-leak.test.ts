// Windows CI run 44198410073: connector processes outlived the operation that started them. Windows never ends a child with its parent, a
// connector that keeps running after its input ends (a keep-alive socket, a timer) is not ended by the end of its input, and a live connector
// keeps its folder (its working directory, spec "Launch") open, so the CoCheck home holding it cannot be removed. The rule pinned here: when the
// process that started a connector exits, every connector it started is ended (on Windows with its whole process tree), and the home deletes.
// Each case runs a real owner process (the review process's role) that starts the connector, records its pid, and exits; this test then checks
// the pid is gone and removes the home with no retry.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const src = (f: string) => JSON.stringify(pathToFileURL(path.join(ROOT, "src", f)).href);

// A connector that keeps running after its input ends. It appends its own pid to the file named by its first argument.
const STUBBORN = `import readline from "node:readline";
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], process.pid + "\\n");
setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ id: m.id, result }) + "\\n");
  if (m.method === "hello") return reply({ spec: "cocheck.connector/1", level: 1, methods: ["diff", "snapshot"] });
  if (m.method === "snapshot") return reply({ subject: m.params.subject, state: "state" });
  if (m.method === "diff") return reply({ spec: "cocheck.changes/1", changes: [] });
});
`;

const TOOL = "mcp__stub__update-page";

// The owner: starts the connector through the production path named by its mode, writes "started" once the connector answered, and exits.
// warm: one createConnectorDiff call (the process stays warm, unref'd, so the owner's event loop ends by itself).
// pool: one before-snapshot through the review server's connector pool (the hook's path); the pooled child keeps the owner alive, so it exits.
const OWNER = `
const [home, mode, marker] = process.argv.slice(2);
const { memoryKeyProvider, setKeyProvider, writeSealed } = await import(${src("seal.ts")});
setKeyProvider(memoryKeyProvider());
if (mode === "warm") {
  const { createHash } = await import("node:crypto");
  const path = (await import("node:path")).default;
  const { ensureStoreDir } = await import(${src("states.ts")});
  const { createConnectorDiff } = await import(${src("connector/diff.ts")});
  const states = await ensureStoreDir(home, 1);
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  for (const s of ["a", "b"]) await writeSealed(path.join(states, sha(s)), Buffer.from(s));
  await createConnectorDiff({ home, taskId: 1 })({ subject: "/work/page.txt", connector: "stub", before: { ref: sha("a") }, after: { ref: sha("b") } }).catch(() => {});
  (await import("node:fs")).writeFileSync(marker, "started");
} else {
  const { beforeSnapshot, createConnectorPool } = await import(${src("connector/before-snapshot.ts")});
  await beforeSnapshot({ home, pool: createConnectorPool(), subject: "stub://page/0a1b", tool: ${JSON.stringify(TOOL)}, budgetMs: 10000 });
  (await import("node:fs")).writeFileSync(marker, "started");
  process.exit(0);
}
`;

const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-exit-leak-"));
const ownerFile = path.join(scratch, "owner.mjs");
writeFileSync(ownerFile, OWNER);
const leftovers: number[] = [];
after(() => {
  for (const pid of leftovers) {
    try { process.kill(pid); } catch { /* gone */ }
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/** A home with the stub connector installed under connectors/stub, run as `run` (relative to the connector folder). */
function home(name: string, run: (dir: string, pids: string) => string[]): { home: string; pids: string } {
  const h = path.join(scratch, name);
  const dir = path.join(h, "connectors", "stub");
  mkdirSync(dir, { recursive: true });
  const pids = path.join(scratch, `${name}.pids`);
  writeFileSync(path.join(dir, "stub.mjs"), STUBBORN);
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({
    spec: "cocheck.connector/1", id: "stub", version: "0.0.1", entry: "state",
    matches: { extensions: [".txt"], mcpTools: [TOOL], subjects: { [TOOL]: "stub://page/{page_id:hex}" } },
    run: run(dir, pids),
  }));
  return { home: h, pids };
}

async function runOwner(h: string, mode: "warm" | "pool"): Promise<void> {
  const marker = path.join(scratch, `${path.basename(h)}.started`);
  const child = spawn(process.execPath, [ownerFile, h, mode, marker], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, stderr);
  assert.ok(existsSync(marker), `the owner started the connector\n${stderr}`);
}

async function assertEnded(h: { home: string; pids: string }): Promise<void> {
  const pids = readFileSync(h.pids, "utf8").split("\n").filter(Boolean).map(Number);
  assert.ok(pids.length > 0, "the connector recorded its pid");
  leftovers.push(...pids);
  // The owner has exited. Its connector must already be gone, or go within a moment (the OS reaps it); never a minute later.
  const end = Date.now() + 3000;
  while (pids.some(alive) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pids.filter(alive), [], "every connector process the owner started is gone once the owner exited");
  // No retry: an open connector folder fails this on Windows (EBUSY).
  rmSync(h.home, { recursive: true, force: true });
  assert.equal(existsSync(h.home), false);
}

describe("connector processes end with the process that started them", () => {
  it("a warm connector (diff) that ignores the end of its input is gone once its owner's operation ends, and its home deletes", async () => {
    const h = home("warm", (_dir, pids) => ["node", "stub.mjs", pids]);
    await runOwner(h.home, "warm");
    await assertEnded(h);
  });

  it("a pooled before-snapshot connector (the hook's path) that ignores the end of its input is gone once the review process exits, and its home deletes", async () => {
    const h = home("pool", (_dir, pids) => ["node", "stub.mjs", pids]);
    await runOwner(h.home, "pool");
    await assertEnded(h);
  });

  it("on Windows, a connector started through a .cmd wrapper is ended with its whole process tree (cmd.exe and the program it started)", { skip: process.platform !== "win32" && "a .cmd wrapper runs only on Windows" }, async () => {
    const h = home("tree", (dir, pids) => {
      writeFileSync(path.join(dir, "stub.cmd"), `@"${process.execPath}" "%~dp0stub.mjs" %*\r\n`);
      return ["./stub.cmd", pids];
    });
    await runOwner(h.home, "warm");
    await assertEnded(h);
  });
});
