import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openLedger } from "../src/ledger.ts";
import { runHook } from "../src/hook-cli.ts";
import { setTracking } from "../src/tracking.ts";
import { waitsOnHelpers } from "../src/credit-guard.ts";
import { codexToolName } from "../src/hosts/codex.ts";

// Copilot CLI 1.0.103 live run (platforms/copilot-cli/versions/1.0.103). The main agent's `read_agent` calls (wait:true) stay open
// while three helpers write; a read_agent is a wait, so it must never hold credit for a helper's write. The records are the hook inputs
// the CLI logged in its own event log, with the scratch folder swapped for a temp folder; every home and folder here is a fresh temp dir.
const RUN = path.join(import.meta.dirname, "..", "platforms", "copilot-cli", "versions", "1.0.103", "hook-calls.jsonl");
const MAIN = "a4fc20df-a65b-46b0-a846-badfb7c89142";
const MEMO = "58545b81-ac2a-413d-a725-94f786e9d0b5";
const XLSX = "486d8a42-ff3d-4b2c-aa32-c3fad64a9dd9";
const DECK = "0a15c4f9-ad2d-4d67-a1c4-d37f21d8ed8f";

interface Rec {
  event: string;
  stdin: Record<string, any>;
}
/** The file each Post of a writing call left behind (the trimmed records keep no file contents), by the record's index in the file. */
const WRITES: Record<number, { file: string; text: string }> = {
  34: { file: "memo.md", text: "# Revenue Model\nten lines\n" },
  38: { file: "deck.md", text: "# Deck\nversion one\n" },
  43: { file: "deck.md", text: "# Deck\nversion two\n" },
  45: { file: "model.xlsx", text: "workbook bytes stand-in\n" },
  54: { file: "deck.md", text: "# Deck\nversion three\n" },
};

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function records(folder: string): Rec[] {
  const text = readFileSync(RUN, "utf8").split("<scratch>/ws").join(folder).split("<scratch>").join(path.dirname(folder));
  return text.split("\n").filter(Boolean).map((l) => {
    const d = JSON.parse(l);
    return { event: d.event_arg, stdin: d.stdin };
  });
}

async function replay(tamper: (rec: Rec) => Rec = (x) => x) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  dirs.push(root);
  const home = path.join(root, "home");
  const folder = path.join(root, "ws");
  const copilotHome = path.join(root, "copilot");
  await mkdir(home);
  await mkdir(folder);
  await mkdir(path.join(copilotHome, "session-state"), { recursive: true });
  process.env.COPILOT_HOME = copilotHome;
  setTracking(home, "copilot", MAIN, true, folder);
  const recs = records(folder);
  for (const [i, rec] of recs.entries()) {
    const w = WRITES[i];
    if (w) await writeFile(path.join(folder, w.file), w.text);
    const r = tamper(rec);
    const at = typeof r.stdin.timestamp === "number" ? r.stdin.timestamp : undefined;
    await runHook({ argv: ["node", "hook.ts", "--host", "copilot", "--event", r.event], env: { COCHECK_HOME: home }, ...(at === undefined ? {} : { journalNow: () => at }), stdin: (async function* () { yield Buffer.from(JSON.stringify(r.stdin)); })() });
  }
  const ledger = openLedger(home);
  const ops = ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>));
  ledger.close();
  const byId = new Map(ops.filter((o) => typeof o.tool_use_id === "string").map((o) => [o.tool_use_id as string, o] as const));
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
  try {
    /** Per file, per recorded change: who it was credited to ("main" for a call with no agent id). */
    const changes: Record<string, string[][]> = {};
    for (const row of db.prepare("SELECT credited_json AS c, file_path AS p FROM file_states ORDER BY id").all() as Array<{ c: string; p: string }>) {
      (changes[path.basename(row.p)] ??= []).push((JSON.parse(row.c) as string[]).map((id) => (byId.get(id)?.agent_id as string | undefined) ?? (byId.has(id) ? "main" : `unknown:${id}`)).sort());
    }
    return { ops, changes };
  } finally {
    db.close();
  }
}

describe("a Copilot read_agent wait never holds credit for a helper's write", () => {
  it("memo.md, deck.md and model.xlsx are each credited solo to the helper that wrote them, no joint credit", async () => {
    const { changes } = await replay();
    assert.deepEqual(Object.keys(changes).sort(), ["deck.md", "memo.md", "model.xlsx"]);
    for (const [file, owner] of [["memo.md", MEMO], ["model.xlsx", XLSX], ["deck.md", DECK]] as const) {
      assert.ok(changes[file]!.length > 0, file);
      for (const credited of changes[file]!) assert.deepEqual([...new Set(credited)], [owner], `${file} credited to ${credited.join(",")}`);
    }
  });

  it("must not: a main-agent call that is not a wait keeps today's credit (read_agent without wait:true, and any other tool name)", async () => {
    const noWait = await replay((rec) => (rec.stdin.toolName === "read_agent" ? { ...rec, stdin: { ...rec.stdin, toolArgs: { ...rec.stdin.toolArgs, wait: false } } } : rec));
    assert.ok(noWait.changes["model.xlsx"]!.some((c) => c.includes("main")), `without wait:true the open read_agent is still a suspect: ${JSON.stringify(noWait.changes["model.xlsx"])}`);
    const other = await replay((rec) => (rec.stdin.toolName === "read_agent" ? { ...rec, stdin: { ...rec.stdin, toolName: "fetch_agent_notes" } } : rec));
    assert.ok(other.changes["model.xlsx"]!.some((c) => c.includes("main")), `another tool name is still a suspect: ${JSON.stringify(other.changes["model.xlsx"])}`);
  });
});

describe("which calls wait on helpers", () => {
  it("Codex wait_agent and Copilot read_agent with wait:true wait; every other call does not", () => {
    assert.equal(waitsOnHelpers("wait_agent", {}), true);
    assert.equal(waitsOnHelpers(codexToolName("collaborationwait_agent"), {}), true);
    assert.equal(waitsOnHelpers("read_agent", { agent_id: "x", wait: true, timeout: 180 }), true);
    assert.equal(waitsOnHelpers("read_agent", { agent_id: "x" }), false);
    assert.equal(waitsOnHelpers("read_agent", { agent_id: "x", wait: "true" }), false);
    assert.equal(waitsOnHelpers("read_agent", undefined), false);
    assert.equal(waitsOnHelpers("bash", { wait: true }), false);
    assert.equal(waitsOnHelpers("task", { wait: true }), false);
    assert.equal(waitsOnHelpers(undefined, { wait: true }), false);
  });
});
