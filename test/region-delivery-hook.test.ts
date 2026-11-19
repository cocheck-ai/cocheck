import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { workbookClaims } from "./helpers/claims.ts";

// The hook adapter lists the whole watched folder, subfolders included. The stat filter, Stop hash and caps keep their
// meaning over the tree; version-control and dependency folders are skipped, each skip written once in words; a secret file
// (by name, at any depth) is a hash and a size only, with the line "A secret file was changed: <relative path>".
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (name: string) => path.join(FIXTURES, "probe", name);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const fixture = async (name: string, over: Record<string, unknown>): Promise<HookPayload> =>
  ({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), ...over }) as HookPayload;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type Caps = { fileBytes?: number; taskBytes?: number; scanFiles?: number; scanBytes?: number };

async function setup(opts: { caps?: Caps; files?: Record<string, string>; workbook?: boolean } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  if (opts.workbook !== false) await copyFile(probe("S0.xlsx"), path.join(folder, "casebook.xlsx"));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const put = async (rel: string, data: string) => {
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), data);
  };
  for (const [rel, data] of Object.entries(opts.files ?? {})) await put(rel, data);
  const hostOpts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, ...(opts.caps ? { caps: opts.caps } : {}) };
  const send = (name: string, over: Record<string, unknown> = {}) => fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, hostOpts));
  const call = async (id: string, command: string, act: () => Promise<void>) => {
    const tool_input = { command, description: id };
    await send("claude-pre-bash.json", { tool_use_id: id, tool_input });
    await act();
    await send("claude-post-bash.json", { tool_use_id: id, tool_input });
  };
  const stop = async () => {
    const r = await send("claude-stop.json");
    assert.ok(r.summary, "Stop returned a round summary");
    return r.summary.taskId;
  };
  const read = <T,>(fn: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return fn(l);
    } finally {
      l.close();
    }
  };
  const storeFiles = async (taskId = 1): Promise<string[]> => (await readdir(path.join(home, "tasks", String(taskId), "states")).catch(() => [] as string[])).filter((n) => !n.startsWith(".")).sort();
  const states = (taskId = 1) => read((l) => l.fileStatesForTask(taskId));
  return { home, folder, put, call, stop, read, storeFiles, states, send };
}


const DELIVERY = path.join(".cocheck", "regions", "0123456789abcdef0123456789abcdef.png");

describe(".cocheck in the task folder is CoCheck's own, never an agent change", () => {
  const allArgs = (t: Awaited<ReturnType<typeof setup>>) => t.read((l) => l.okOpsForTask(1, 0, l.maxOpId())).map((o) => JSON.parse(o.argsJson) as { skipped?: Array<{ folder: string }>; writes?: string[]; edits?: string[]; reported?: Array<{ path: string }> });

  it("the folder walk skips it silently: no state event, nothing stored, no skip note", async () => {
    const t = await setup({ files: { "a.txt": "a\n", [DELIVERY]: "PICTUREBYTES\n" } });
    await t.call("toolu_A", "touch", () => writeFile(path.join(t.folder, DELIVERY), "OVERWRITTEN\n"));
    await writeFile(path.join(t.folder, ".cocheck", "regions", "fedcba9876543210fedcba9876543210.png"), "NEW\n");
    await t.stop();
    assert.ok(!t.states().some((s) => s.filePath.includes(".cocheck")), "no state event for .cocheck");
    const store = await t.storeFiles();
    for (const v of ["PICTUREBYTES\n", "OVERWRITTEN\n", "NEW\n"]) assert.ok(!store.includes(sha(v)), "not stored");
    assert.deepEqual(allArgs(t).flatMap((a) => a.skipped ?? []).filter((x) => x.folder.includes(".cocheck")), []);
    assert.ok(t.states().some((s) => s.filePath.endsWith("a.txt")), "other files are still watched");
  });

  it("a hook write into .cocheck is never recorded as a change; a write beside it is", async () => {
    const t = await setup({ files: { "a.txt": "a\n" } });
    const target = path.join(t.folder, DELIVERY);
    const other = path.join(t.folder, "out.txt");
    for (const [id, file] of [["toolu_W1", target], ["toolu_W2", other]] as const) {
      const tool_input = { file_path: file, content: "x\n" };
      await t.send("claude-pre-bash.json", { tool_use_id: id, tool_name: "Write", tool_input });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "x\n");
      await t.send("claude-post-bash.json", { tool_use_id: id, tool_name: "Write", tool_input });
    }
    await t.stop();
    assert.ok(t.states().some((s) => s.filePath === other), "control: the write beside it is a recorded change");
    assert.ok(!(await t.storeFiles()).includes(sha("x\n")) || t.states().filter((s) => s.sha256 === sha("x\n")).every((s) => !s.filePath.includes(".cocheck")));
    assert.ok(!t.states().some((s) => s.filePath.includes(".cocheck")));
  });
});
