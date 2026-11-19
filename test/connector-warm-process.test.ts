// One warm process per connector id serves many diffs, for built-in and installed connectors alike.
// (1) a 50-file burst on two connectors (one installed, one built-in) counts one spawn per connector, and every file gets its own change;
// (2) A, B, A in one process answers byte for byte what fresh processes answer;
// (3) a hung process: the call that hit the deadline fails, is not retried, and the process is replaced for the next call, which succeeds;
// (4) a process that died before answering (exit, or EPIPE on the request) is retried once, never twice, and the frozen hello is the answering process's;
// (5) an idle warm process exits on its own: after the idle timeout, and when the review process that started it exits (even if it ignores end of input);
// (6) the hook never reaches the warm process: its runtime import graph has neither diff.ts nor runner.ts.
// Must not happen: state leaking between diffs shows the wrong change on the wrong file (1, 2); a hung process stalls every later capture (3).
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import * as D from "../src/connector/diff.ts";
import { createConnectorDiff, frozenDocOf } from "../src/connector/diff.ts";
import { setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { memoryKeyProvider, setKeyProvider, writeSealed } from "../src/seal.ts";
import { ensureStoreDir } from "../src/states.ts";
import { platform } from "../src/platform/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FX = path.join(import.meta.dirname, "fixtures", "connector-warm", "warm");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// Warm processes are stopped when the review process exits; a call never starts one it does not stop.
const stopWarm = async (): Promise<void> => { await ((D as Record<string, unknown>)["stopWarmConnectors"] as (() => Promise<void>) | undefined)?.(); };
const alive = (pid: number): boolean => platform().process.alive(pid);
const waitFor = async (ok: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return ok();
};

// The fixture makes EPIPE by closing its descriptor 0, a POSIX way to close a pipe's reading end.
const posix = process.platform === "win32" ? { skip: "EPIPE fixture closes fd 0 (POSIX)" } : {};

afterEach(async () => { await stopWarm(); setKeyProvider(null); setBuiltinConnectorsForTest(undefined); });

async function rig(ids: string[] = ["fx-warm"]) {
  setKeyProvider(memoryKeyProvider());
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const dirs: Record<string, string> = {};
  for (const id of ids) dirs[id] = await connectorFolder(path.join(home, "connectors", id), id);
  const store = await ensureStoreDir(home, 1);
  const put = async (text: string): Promise<string> => { await writeSealed(path.join(store, sha(text)), text); return sha(text); };
  const row = async (connector: string, subject: string, before: string, after: string) => ({ subject, connector, before: { ref: await put(before) }, after: { ref: await put(after) } });
  return { home, dirs, row };
}
async function connectorFolder(dir: string, id: string): Promise<string> {
  await mkdir(path.dirname(dir), { recursive: true });
  await cp(FX, dir, { recursive: true });
  const mf = path.join(dir, "cocheck-connector.json");
  await writeFile(mf, JSON.stringify({ ...JSON.parse(await readFile(mf, "utf8")), id }));
  return dir;
}
const spawnsOf = (dir: string): number[] => (existsSync(path.join(dir, "spawns.log")) ? readFileSync(path.join(dir, "spawns.log"), "utf8").split("\n").filter(Boolean).map(Number) : []);
const labelOf = (d: D.ConnectorDiffResult): unknown => ((d.v1doc?.["changes"] as Array<{ label?: unknown }> | undefined) ?? [])[0]?.label;

describe("one warm process per connector", () => {
  it("a 50-file burst on an installed and a built-in connector counts one spawn per connector, each file answered with its own change", async () => {
    const r = await rig(["fx-warm"]);
    const builtinDir = await connectorFolder(path.join(await mkdtemp(path.join(tmpdir(), "cocheck-builtin-")), "fx-warm-builtin"), "fx-warm-builtin");
    setBuiltinConnectorsForTest([{ id: "fx-warm-builtin", dir: builtinDir }]);
    const rows: D.ConnectorDiffRow[] = [];
    for (let i = 0; i < 50; i++) for (const c of ["fx-warm", "fx-warm-builtin"]) rows.push(await r.row(c, `/work/f${i}.warm.txt`, `before ${c} ${i}`, `after ${c} ${i}`));
    // A new closure per row, as each capture makes one: the warm process belongs to the connector, not to a closure.
    const got = await Promise.all(rows.map((row) => createConnectorDiff({ home: r.home, taskId: 1 })(row)));
    got.forEach((d, i) => {
      const want = `after ${rows[i]!.connector} ${Math.floor(i / 2)}`;
      assert.equal(labelOf(d), want, `row ${i} shows its own file's change`);
      assert.equal(d.subject, rows[i]!.subject);
    });
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 1, "installed connector: one spawn for 50 diffs");
    assert.equal(spawnsOf(builtinDir).length, 1, "built-in connector: one spawn for 50 diffs");
  });

  it("A, B, A in one process answers byte for byte what fresh processes answer", async () => {
    const r = await rig();
    const A = await r.row("fx-warm", "/work/a.warm.txt", "alpha", "alpha two");
    const B = await r.row("fx-warm", "/work/b.warm.txt", "beta", "beta two");
    const run = createConnectorDiff({ home: r.home, taskId: 1 });
    const warm = [];
    for (const row of [A, B, A]) warm.push(JSON.stringify(frozenDocOf(await run(row), "fx-warm")));
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 1, "A, B, A ran in one process");
    const fresh = [];
    for (const row of [A, B, A]) { await stopWarm(); fresh.push(JSON.stringify(frozenDocOf(await run(row), "fx-warm"))); }
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 4, "each fresh answer came from its own process");
    assert.deepEqual(warm, fresh);
    assert.notEqual(warm[0], warm[1], "A and B are different answers, so a leak would show");
  });

  it("a hung process: the call that hit the deadline fails and is not retried; the process is replaced and the next diff succeeds", async () => {
    const r = await rig();
    const run = createConnectorDiff({ home: r.home, taskId: 1, timeoutMs: 800 });
    await run(await r.row("fx-warm", "/work/w.warm.txt", "x", "warm up"));
    const [hungPid] = spawnsOf(r.dirs["fx-warm"]!);
    await assert.rejects(run(await r.row("fx-warm", "/work/h.warm.txt", "x", "HANG")), /timed out after 800 ms/);
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 1, "a deadline is never retried");
    assert.ok(await waitFor(() => !alive(hungPid!), 5000), "the hung process is gone");
    const next = await run(await r.row("fx-warm", "/work/n.warm.txt", "x", "after the hang"));
    assert.equal(labelOf(next), "after the hang");
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 2, "one replacement process");
  });

  it("a process that exits before answering is retried once, and the frozen hello is the answering process's", async () => {
    const r = await rig();
    const run = createConnectorDiff({ home: r.home, taskId: 1 });
    const d = await run(await r.row("fx-warm", "/work/d.warm.txt", "x", "DIE-ONCE"));
    assert.equal(labelOf(d), "DIE-ONCE");
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 2);
    assert.equal(d.v1nothingChanged, true, "the second process's hello declared nothingChanged; the first's did not");
    assert.equal((frozenDocOf(d, "fx-warm")["source"] as Record<string, unknown>)["nothingChanged"], true);
  });

  it("a process that exits before answering every time is retried once and never twice", async () => {
    const r = await rig();
    await assert.rejects(createConnectorDiff({ home: r.home, taskId: 1 })(await r.row("fx-warm", "/work/d.warm.txt", "x", "DIE")), /exited \(code 3\)/);
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 2);
  });

  it("an EPIPE before the answer is retried once and succeeds", posix, async () => {
    const r = await rig();
    await writeFile(path.join(r.dirs["fx-warm"]!, "epipe-once"), "");
    const d = await createConnectorDiff({ home: r.home, taskId: 1 })(await r.row("fx-warm", "/work/e.warm.txt", "x", "after epipe"));
    assert.equal(labelOf(d), "after epipe");
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 2);
  });

  it("an EPIPE every time is retried once and never twice", posix, async () => {
    const r = await rig();
    await writeFile(path.join(r.dirs["fx-warm"]!, "epipe"), "");
    await assert.rejects(createConnectorDiff({ home: r.home, taskId: 1 })(await r.row("fx-warm", "/work/e.warm.txt", "x", "y")), /closed its input/);
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 2);
    for (const pid of spawnsOf(r.dirs["fx-warm"]!)) assert.ok(await waitFor(() => !alive(pid), 8000), `pid ${pid} was stopped`);
  });

  it("an idle warm process exits on its own after the idle timeout, even one that ignores the end of its input", async () => {
    const r = await rig();
    await writeFile(path.join(r.dirs["fx-warm"]!, "ignore-eof"), "");
    await createConnectorDiff({ home: r.home, taskId: 1, idleMs: 300 })(await r.row("fx-warm", "/work/i.warm.txt", "x", "y"));
    const [pid] = spawnsOf(r.dirs["fx-warm"]!);
    assert.ok(alive(pid!), "still warm right after the call");
    assert.ok(await waitFor(() => !alive(pid!), 8000), "gone after the idle timeout");
  });

  it("when the review process exits, its warm process does not outlive it, even one that ignores the end of its input", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "cocheck-child-"));
    const dir = await connectorFolder(path.join(work, "home", "connectors", "fx-warm"), "fx-warm");
    await writeFile(path.join(dir, "ignore-eof"), "");
    const url = (f: string) => pathToFileURL(path.join(ROOT, "src", f)).href;
    const script = path.join(work, "review.ts");
    await writeFile(script, `import { createConnectorDiff } from ${JSON.stringify(url("connector/diff.ts"))};
import { memoryKeyProvider, setKeyProvider, writeSealed } from ${JSON.stringify(url("seal.ts"))};
import { ensureStoreDir } from ${JSON.stringify(url("states.ts"))};
import { createHash } from "node:crypto"; import path from "node:path";
setKeyProvider(memoryKeyProvider());
const home = ${JSON.stringify(path.join(work, "home"))};
const store = await ensureStoreDir(home, 1);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
for (const t of ["x", "y"]) await writeSealed(path.join(store, sha(t)), t);
const d = await createConnectorDiff({ home, taskId: 1 })({ subject: "/work/c.warm.txt", connector: "fx-warm", before: { ref: sha("x") }, after: { ref: sha("y") } });
process.stdout.write(JSON.stringify(d.v1doc));
`);
    // The child ends on its own once its work is done: the warm process must not keep it running, and must not outlive it.
    const res = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000 });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /"label":"y"/);
    const [pid] = spawnsOf(dir);
    assert.ok(pid !== undefined);
    assert.ok(await waitFor(() => !alive(pid!), 5000), "the warm process is gone once the review process exits");
  });

  // The pool key is everything that fixes the process at spawn. Must not happen: an old process answers for new code, a new manifest
  // or a rotated credential, and under steady captures it never idles out.
  it("a connector.mjs rewritten in place between two calls gives the new code's answer, and the old process is stopped, not left to idle", async () => {
    const r = await rig();
    const run = createConnectorDiff({ home: r.home, taskId: 1 });
    assert.equal(labelOf(await run(await r.row("fx-warm", "/work/a.warm.txt", "one", "two"))), "two");
    const [oldPid] = spawnsOf(r.dirs["fx-warm"]!);
    const entry = path.join(r.dirs["fx-warm"]!, "connector.mjs");
    await writeFile(entry, (await readFile(entry, "utf8")).replace("label: after + key", 'label: "NEWCODE " + after + key'));
    assert.equal(labelOf(await run(await r.row("fx-warm", "/work/a.warm.txt", "one", "two"))), "NEWCODE two", "the rewritten code answered");
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 2);
    assert.ok(await waitFor(() => !alive(oldPid!), 5000), "the old process was stopped (the idle clock is 60 s)");
  });

  it("a manifest edited in place between two calls gets a new process", async () => {
    const r = await rig();
    const run = createConnectorDiff({ home: r.home, taskId: 1 });
    await run(await r.row("fx-warm", "/work/a.warm.txt", "one", "two"));
    const mf = path.join(r.dirs["fx-warm"]!, "cocheck-connector.json");
    await writeFile(mf, JSON.stringify({ ...JSON.parse(await readFile(mf, "utf8")), version: "0.0.2" }));
    await run(await r.row("fx-warm", "/work/a.warm.txt", "one", "two"));
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 2);
  });

  it("a credential value changed between two calls gets a new spawn that hellos with the new value; the same value reuses the process", async () => {
    const r = await rig();
    const mf = path.join(r.dirs["fx-warm"]!, "cocheck-connector.json");
    await writeFile(mf, JSON.stringify({ ...JSON.parse(await readFile(mf, "utf8")), credentials: [{ name: "token" }] }));
    let value = "first-token";
    const reads: string[] = [];
    const secretStore = { get: (service: string, account: string) => { reads.push(`${service}/${account}`); return Buffer.from(value); } };
    const run = createConnectorDiff({ home: r.home, taskId: 1, secretStore });
    const k = (v: string) => ` key:${sha(v).slice(0, 8)}`;
    assert.equal(labelOf(await run(await r.row("fx-warm", "/work/a.warm.txt", "one", "two"))), "two" + k("first-token"));
    assert.equal(labelOf(await run(await r.row("fx-warm", "/work/a.warm.txt", "one", "three"))), "three" + k("first-token"));
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 1, "same value, same process");
    const [oldPid] = spawnsOf(r.dirs["fx-warm"]!);
    value = "rotated-token";
    assert.equal(labelOf(await run(await r.row("fx-warm", "/work/a.warm.txt", "one", "two"))), "two" + k("rotated-token"));
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 2, "a rotated credential starts a new process");
    assert.ok(await waitFor(() => !alive(oldPid!), 5000), "the process holding the old credential was stopped");
    assert.ok(reads.every((x) => x === "cocheck-connector:fx-warm/token"));
  });

  it("an allowed env value changed between two calls gets a new spawn", async () => {
    const r = await rig();
    const mf = path.join(r.dirs["fx-warm"]!, "cocheck-connector.json");
    await writeFile(mf, JSON.stringify({ ...JSON.parse(await readFile(mf, "utf8")), permissions: { env: ["T511_WARM_ENV"] } }));
    const was = process.env["T511_WARM_ENV"];
    try {
      process.env["T511_WARM_ENV"] = "a";
      const run = createConnectorDiff({ home: r.home, taskId: 1 });
      await run(await r.row("fx-warm", "/work/a.warm.txt", "one", "two"));
      await run(await r.row("fx-warm", "/work/a.warm.txt", "one", "two"));
      assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 1);
      process.env["T511_WARM_ENV"] = "b";
      await run(await r.row("fx-warm", "/work/a.warm.txt", "one", "two"));
      assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 2);
    } finally {
      if (was === undefined) delete process.env["T511_WARM_ENV"]; else process.env["T511_WARM_ENV"] = was;
    }
  });

  it("a late reply from a process whose call hit its deadline is never read as the next call's answer", posix, async () => {
    const r = await rig();
    // The process ignores SIGTERM, so it lives on to write its late answer (stop() kills it 3 s later).
    await writeFile(path.join(r.dirs["fx-warm"]!, "ignore-term"), "");
    const run = createConnectorDiff({ home: r.home, taskId: 1, timeoutMs: 800 });
    await assert.rejects(run(await r.row("fx-warm", "/work/s.warm.txt", "x", "SLOW")), /timed out after 800 ms/);
    // The next call is asked while the late answer is still on its way, and it must get its own.
    const next = run(await r.row("fx-warm", "/work/n.warm.txt", "x", "next"));
    const lateLog = path.join(r.dirs["fx-warm"]!, "late.log");
    assert.ok(await waitFor(() => existsSync(lateLog), 5000), "the late answer was really written");
    assert.equal(labelOf(await next), "next");
    assert.equal(spawnsOf(r.dirs["fx-warm"]!).length, 2);
    assert.equal(readFileSync(lateLog, "utf8").trim(), `late ${spawnsOf(r.dirs["fx-warm"]!)[0]}`, "the late answer came from the first process");
    // A third call on the same warm process also gets its own answer, not the late one.
    assert.equal(labelOf(await run(await r.row("fx-warm", "/work/t.warm.txt", "x", "third"))), "third");
  });

  it("the hook never reaches the warm process: its runtime imports reach neither diff.ts nor runner.ts", () => {
    const seen = new Set<string>();
    const stack = ["hook.ts", "hook-cli.ts"].map((f) => path.join(ROOT, "src", f));
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)(?!\s+type\b)[^;]*?from\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
        const p = path.resolve(path.dirname(f), m[1] ?? m[2]!);
        if (existsSync(p)) stack.push(p);
      }
    }
    assert.ok(seen.size > 20, `the walk read the hook's graph (${seen.size} files)`);
    for (const f of ["connector/diff.ts", "connector/runner.ts"]) assert.ok(!seen.has(path.join(ROOT, "src", f)), `the hook imports ${f}`);
  });
});
