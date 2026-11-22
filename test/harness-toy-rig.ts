import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadOutsiderHarnesses, setBuiltInHarnessDirForTest } from "../src/hosts/index.ts";
import { dumpLedger, goldenView } from "./hook-corpus.ts";
import { runHookTracked } from "./helpers/track.ts";
import { removeHome } from "./helpers/remove-home.ts";

// A toy harness, written as a manifest only (test/fixtures/harnesses/toyagent/), replayed through the real hook entry.
export const TOY = path.join(import.meta.dirname, "fixtures", "harnesses", "toyagent");

export interface ToyRun {
  dump: Record<string, unknown[]>;
  /** The credit basis of each stored file state of the folder, by file name, and the proofs stored beside them. */
  bases: Array<{ file: string; phase: string; basis: string | null; proofs: number }>;
  exits: number[];
  stderr: string[];
}

/** Where the toy manifest is put: the person's harness folder (outsider), or the folder of built-in manifests (a test seam). */
export type ToyPlace = "outsider" | "built-in" | "env-folder";

export async function replayToy(place: ToyPlace = "outsider", mutate?: (manifestPath: string, root: string) => void): Promise<ToyRun> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-toy-")));
  const home = path.join(root, "home");
  const folder = path.join(root, "ws");
  mkdirSync(home);
  mkdirSync(folder);
  writeFileSync(path.join(folder, "data.txt"), "a,b,c\n");
  const target = place === "outsider" ? path.join(home, "harnesses") : path.join(root, place === "built-in" ? "builtin" : "myharnesses");
  mkdirSync(path.join(target, "toyagent"), { recursive: true });
  cpSync(path.join(TOY, "cocheck-harness.json"), path.join(target, "toyagent", "cocheck-harness.json"));
  mutate?.(path.join(target, "toyagent", "cocheck-harness.json"), root);
  const saved = { HOME: process.env.HOME, COCHECK_HARNESS_DIR: process.env.COCHECK_HARNESS_DIR };
  process.env.HOME = root;
  if (place === "built-in") setBuiltInHarnessDirForTest(target);
  if (place === "env-folder") process.env.COCHECK_HARNESS_DIR = target;
  const env: NodeJS.ProcessEnv = { COCHECK_HOME: home, ...(place === "env-folder" ? { COCHECK_HARNESS_DIR: target } : {}) };
  // The tracking helper reads the registry before the hook entry does, so the outsider folder is loaded here as the hook entry loads it.
  loadOutsiderHarnesses(place === "built-in" ? undefined : place === "env-folder" ? target : path.join(home, "harnesses"));
  const exits: number[] = [];
  const stderr: string[] = [];
  try {
    const start = Date.UTC(2026, 10, 21, 12, 0, 0);
    let clock = start;
    const lines = readFileSync(path.join(TOY, "payloads.jsonl"), "utf8").split("\n").filter((l) => l !== "");
    for (const [i, text] of lines.entries()) {
      // The placeholder becomes the folder inside each string; text that is itself JSON (the tool arguments) needs the folder JSON-escaped, any other string the folder as is.
      const fill = (v: unknown): unknown => {
        if (typeof v === "string") {
          let inner = false;
          try {
            inner = typeof JSON.parse(v) === "object";
          } catch {
            // plain text
          }
          return v.split("<folder>").join(inner ? JSON.stringify(folder).slice(1, -1) : folder);
        }
        if (Array.isArray(v)) return v.map(fill);
        if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
        return v;
      };
      const wire = fill(JSON.parse(text)) as { event: string; stdin: Record<string, any> };
      const argv = ["node", "hook.ts", "--host", "toyagent", "--event", wire.event, "--folder", folder];
      const res = await runHookTracked({ argv, env, now: () => (clock += 1000), journalNow: () => start + i * 1000, stdin: (async function* () { yield Buffer.from(JSON.stringify(wire.stdin)); })() });
      exits.push(res.exitCode);
      stderr.push(res.stderr);
      // The write call leaves its file behind right after its Pre, as the real tool would.
      if (wire.event === "beforeTool" && wire.stdin.tool?.name === "write_file") {
        const args = JSON.parse(wire.stdin.tool.args);
        writeFileSync(args.path, args.content);
      }
    }
    const dump = JSON.parse(JSON.stringify(goldenView(dumpLedger(home, folder))).split(root).join("<root>")) as Record<string, unknown[]>;
    const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT id, file_path, phase, credit_basis FROM file_states ORDER BY rowid").all() as Array<{ id: number; file_path: string; phase: string; credit_basis: string | null }>;
      const proofs = db.prepare("SELECT file_state_id AS id, COUNT(*) AS n FROM file_state_proofs GROUP BY file_state_id").all() as Array<{ id: number; n: number }>;
      const bases = rows.map((r) => ({ file: path.basename(r.file_path), phase: r.phase, basis: r.credit_basis, proofs: proofs.find((p) => p.id === r.id)?.n ?? 0 }));
      return { dump, bases, exits, stderr };
    } finally {
      db.close();
    }
  } finally {
    loadOutsiderHarnesses(undefined);
    setBuiltInHarnessDirForTest(undefined);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await removeHome(home, root);
  }
}
