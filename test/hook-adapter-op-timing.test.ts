import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// every hook op records the call's wall-clock start and end and the adapter's own processing time. A missing or
// skewed clock records "unknown", never 0 (the live run of recorded 0 ms for every op).
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (n: number) => path.join(FIXTURES, "probe", `S${n}.xlsx`);
const fixture = async (name: string, over: Record<string, unknown>): Promise<HookPayload> =>
  ({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), ...over }) as HookPayload;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type Row = { duration_ms: number; args: Record<string, unknown> };
let lastHome = "";

async function runCall(now?: () => number): Promise<Row[]> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-hook-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-hook-folder-")));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  lastHome = home;
  const file = path.join(folder, "casebook.xlsx");
  await copyFile(probe(0), file);
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, ...(now ? { now } : {}) };
  const send = (name: string) => fixture(name, { cwd: folder, tool_use_id: "c1", tool_input: { command: "c1", description: "c1" } }).then((p) => handleHook(p, opts));
  await send("claude-pre-bash.json");
  await copyFile(probe(1), file);
  await send("claude-post-bash.json");
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"));
  try {
    const rows = db.prepare("SELECT duration_ms, args_json FROM ops ORDER BY id").all() as Array<{ duration_ms: number; args_json: string }>;
    return rows.map((r) => ({ duration_ms: r.duration_ms, args: JSON.parse(r.args_json) }));
  } finally {
    db.close();
  }
}

describe("hook op timing", () => {
  it("records wall start, wall end and the adapter's processing time, not 0 ms", async () => {
    const rows = await runCall();
    assert.ok(rows.length > 0, "the call logged ops");
    for (const r of rows) {
      assert.equal(typeof r.args.openedAt, "number");
      assert.equal(typeof r.args.closedAt, "number");
      assert.equal(typeof r.args.processingMs, "number");
      assert.ok((r.args.processingMs as number) > 0, "processing time is a real measurement");
      assert.ok(r.duration_ms > 0, `ledger duration_ms is ${r.duration_ms}, not 0`);
    }
  });

  it("records unknown, never 0, when the clock is skewed or missing", async () => {
    let t = 1_000_000;
    const backwards = await runCall(() => (t -= 1000));
    for (const r of backwards) {
      assert.equal(r.args.wallMs, "unknown");
      assert.notEqual(r.duration_ms, 0);
    }
    const missing = await runCall(() => Number.NaN);
    for (const r of missing) {
      assert.equal(r.args.wallMs, "unknown");
      assert.equal(r.args.closedAt, "unknown");
    }
  });

  it("hook-calls.ts labels processing as adapter overhead and wall as call runtime", async () => {
    await runCall();
    const out = execFileSync("node", [path.join(import.meta.dirname, "..", "scripts", "hook-calls.ts"), lastHome, "--all"], { encoding: "utf8" });
    assert.match(out, /adapter overhead [\d.]+ ms/);
    assert.match(out, /call runtime [\d.]+ ms/);
    assert.match(out, /median adapter overhead [\d.]+ ms, median call runtime [\d.]+ ms over 1 timed call/);
  });
});
