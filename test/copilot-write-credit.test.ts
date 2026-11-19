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

// The real hook stdin of the same Copilot 1.0.103 run (raw-hook-stdin.jsonl, decoded from the interleaved capture). The memo helper's
// read-only `wc -l memo.md` and `git status --short` overlapped the deck helper's `apply_patch` (Add File: deck.md); only the writer may
// take the credit. Every home and folder here is a fresh temp dir.
const RUN = path.join(import.meta.dirname, "..", "platforms", "copilot-cli", "versions", "1.0.103", "raw-hook-stdin.jsonl");
const MAIN = "d9b2e3f7-09b6-44cb-bf5e-e3b760bb42b4";
const MEMO = "24353f5c-439a-42a5-a8b3-c3a7ae64d58e";
const XLSX = "de650664-ec39-4126-bf6b-cfb208a72f15";
const DECK = "76d49130-4932-4d08-8029-16d5b191101c";

interface Rec {
  event: string;
  stdin: Record<string, any>;
}
/** The file a writing call left behind (the trimmed records keep no file contents), written right after the record at this index (the call's Pre). */
const WRITES: Record<number, { file: string; text: string }> = {
  30: { file: "memo.md", text: "# Revenue Model\nten lines\n" },
  34: { file: "deck.md", text: "# Deck\nversion one\n" },
  45: { file: "deck.md", text: "# Deck\nversion two\n" },
  47: { file: "model.xlsx", text: "workbook bytes stand-in\n" },
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
    const r = tamper(rec);
    const at = typeof r.stdin.timestamp === "number" ? r.stdin.timestamp : undefined;
    await runHook({ argv: ["node", "hook.ts", "--host", "copilot", "--event", r.event], env: { COCHECK_HOME: home }, ...(at === undefined ? {} : { journalNow: () => at }), stdin: (async function* () { yield Buffer.from(JSON.stringify(r.stdin)); })() });
    if (w) await writeFile(path.join(folder, w.file), w.text);
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

describe("a call whose input names the file takes the credit; a read-only shell call never does", () => {
  it("real Copilot 1.0.103 stdin: memo.md, model.xlsx and both deck.md changes are credited solo to the writing helper, no joint credit", async () => {
    const { changes } = await replay();
    assert.deepEqual(Object.keys(changes).sort(), ["deck.md", "memo.md", "model.xlsx"]);
    for (const [file, owner, n] of [["memo.md", MEMO, 1], ["model.xlsx", XLSX, 1], ["deck.md", DECK, 2]] as const) {
      assert.equal(changes[file]!.length, n, `${file} change count: ${JSON.stringify(changes[file])}`);
      for (const credited of changes[file]!) assert.deepEqual(credited, [owner], `${file} credited to ${credited.join(",")}`);
    }
  });
});
