import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { startFromPayload } from "./helpers/track.ts";
import { openLedger } from "../src/ledger.ts";
import { workbookClaims } from "./helpers/claims.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";
import { handleHook, type HookOptions, type HookPayload, type HookResult } from "../src/hook-adapter.ts";

const ZIP_MTIME = new Date(2020, 0, 1);
const FIXTURES = path.join(import.meta.dirname, "fixtures", "hooks");

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

/** A one-sheet workbook holding the given numbers, keyed by A1 address (single-letter columns). */
function book(cells: Record<string, number>): Uint8Array {
  const byRow = new Map<number, string[]>();
  for (const [addr, v] of Object.entries(cells)) {
    const row = Number(addr.slice(1));
    byRow.set(row, [...(byRow.get(row) ?? []), `<c r="${addr}"><v>${v}</v></c>`]);
  }
  const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([r, cs]) => `<row r="${r}">${cs.sort().join("")}</row>`);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
  const enc = new TextEncoder();
  return zipSync({
    "xl/workbook.xml": enc.encode(WORKBOOK_XML),
    "xl/_rels/workbook.xml.rels": enc.encode(WORKBOOK_RELS),
    "xl/worksheets/sheet1.xml": enc.encode(sheet),
  }, { mtime: ZIP_MTIME });
}

async function fixture(name: string, over: Record<string, unknown> = {}): Promise<HookPayload> {
  return { ...JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")), ...over } as HookPayload;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(initial: Record<string, number> = { A1: 1 }, extra: Partial<HookOptions> = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-hook-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-hook-folder-")));
  const file = path.join(folder, "model.xlsx");
  await writeFile(file, book(initial));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, ...extra };
  const send = (name: string, over: Record<string, unknown> = {}): Promise<HookResult> =>
    fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, opts));
  const pre = (id: string, command: string, over: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
    send("claude-pre-bash.json", { tool_use_id: id, tool_input: { command, description: `desc ${id}`, ...input }, ...over });
  const post = (id: string, command: string, over: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
    send("claude-post-bash.json", { tool_use_id: id, tool_input: { command, description: `desc ${id}`, ...input }, ...over });
  const stop = () => send("claude-stop.json");
  const write = (cells: Record<string, number>) => writeFile(file, book(cells));
  const opsOf = (taskId: number) => {
    const ledger = openLedger(home);
    try {
      return ledger.okOpsForTask(taskId, 0, ledger.maxOpId()).map((o) => ({ ...o, args: JSON.parse(o.argsJson) as Record<string, unknown> }));
    } finally {
      ledger.close();
    }
  };
  return { home, folder, file, opts, pre, post, stop, write, opsOf, send };
}

const usable = (r: HookResult) => {
  assert.ok(r.summary, "Stop returned a round summary");
  return r.summary;
};
// cell-level credit does not exist. An op credited with a change names the file (`files`, in
// place of its cell list); who is credited is read from the file states (no round row). The expected writers are main's.
const files = (o: { args: Record<string, unknown> }) => (typeof o.args.path === "string" ? [path.basename(o.args.path)] : []);
/** Who is credited with each change after the starting copy, per state (the round writes no row, so this is the credit record). */
const credits = (home: string, taskId: number): string[][] => {
  const ledger = openLedger(home);
  try {
    const states = ledger.fileStatesForTask(taskId);
    const first = Math.min(...states.map((x) => x.stepId));
    return states.filter((x) => x.stepId !== first).map((x) => [...x.credited].sort());
  } finally {
    ledger.close();
  }
};
const closedBy = (ops: Array<{ args: Record<string, unknown> }>, id: string) => ops.filter((o) => o.args.tool_use_id === id).map((o) => o.args.closedBy);

const pageOf = (home: string, taskId: number): string => {
  const ledger = openLedger(home);
  try {
    return renderReviewPage(reviewModel(ledger, taskId));
  } finally {
    ledger.close();
  }
};

describe("hook adapter: how each call closed", () => {
  it("(1) every op records post, failure, stop, expiry or ghost-post", async () => {
    let now = 1_000_000;
    const t = await setup(undefined, { now: () => now });
    await t.pre("toolu_P", "p");
    await t.post("toolu_P", "p");
    await t.pre("toolu_X", "x");
    await t.send("claude-post-bash.json", { hook_event_name: "PostToolUseFailure", tool_use_id: "toolu_X", tool_input: { command: "x", description: "desc toolu_X" } });
    await t.post("toolu_G", "g"); // Post whose Pre was never seen
    await t.pre("toolu_E", "e");
    now += 11 * 60_000;
    await t.pre("toolu_S", "s"); // sweeps and expires E
    await t.write({ A1: 2 });
    const s = usable(await t.stop()); // closes S
    const ops = t.opsOf(s.taskId);
    assert.deepEqual(closedBy(ops, "toolu_P"), ["post"]);
    assert.deepEqual(closedBy(ops, "toolu_X"), ["failure"]);
    assert.deepEqual(closedBy(ops, "toolu_G"), ["ghost-post"]);
    assert.deepEqual(closedBy(ops, "toolu_E"), ["expiry"]);
    assert.deepEqual(closedBy(ops, "toolu_S"), ["stop"]);
  });

  it("(1) the review page's per-call drill-down says how the call closed", async () => {
    const t = await setup();
    await t.pre("toolu_A", "agent write");
    await t.write({ A1: 2 });
    await t.post("toolu_A", "agent write");
    await t.pre("toolu_F", "ghost");
    await t.write({ A1: 2, A2: 7 });
    await t.pre("toolu_H", "sweeper"); // F is open: it takes the A2 change
    await t.post("toolu_H", "sweeper");
    const s = usable(await t.stop());
    const html = pageOf(t.home, s.taskId);
    assert.match(html, /toolu_A[^<]*closed by post/);
    assert.match(html, /toolu_F[^<]*closed by stop/);
  });
});

describe("hook adapter: the folder must be real (CLI, exit 1 never 2)", () => {
  const HOOK = path.join(import.meta.dirname, "..", "src", "hook.ts");
  async function runCli(env: Record<string, string>, args: string[], stdin: string) {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-hook-cli-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const baseEnv: Record<string, string | undefined> = { ...process.env, COCHECK_HOME: home };
    delete baseEnv.CLAUDE_PROJECT_DIR;
    startFromPayload(home, ["--host", "claude", ...args], stdin);
    return await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK, "--host", "claude", ...args], { env: { ...baseEnv, ...env }, cwd: tmpdir() });
      let stderr = "";
      let stdout = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.stdout.on("data", (d) => (stdout += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr, stdout }));
      child.stdin.end(stdin);
    });
  }
  const payload = async (folder: string) => JSON.stringify(await fixture("claude-pre-bash.json", { cwd: folder, tool_use_id: "toolu_C" }));

  async function realFolder(withBook: boolean): Promise<string> {
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-hook-cli-folder-")));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    if (withBook) await writeFile(path.join(folder, "model.xlsx"), book({ A1: 1 }));
    return folder;
  }

  it("(2) a relative --folder exits 1 and says so", async () => {
    const r = await runCli({}, ["--folder", "some/relative"], await payload("/"));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /relative/);
    assert.equal(r.stdout, "");
  });

  it("(2) a relative CLAUDE_PROJECT_DIR exits 1 and says so", async () => {
    const r = await runCli({ CLAUDE_PROJECT_DIR: "." }, [], await payload("/"));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /relative/);
  });

  it("(2) a missing folder exits 1 and says so", async () => {
    const folder = await realFolder(true);
    const r = await runCli({}, ["--folder", path.join(folder, "typo")], await payload(folder));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not exist/);
  });

  it("(2) a folder that is a file exits 1 and says so", async () => {
    const folder = await realFolder(true);
    const r = await runCli({}, ["--folder", path.join(folder, "model.xlsx")], await payload(folder));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a directory/);
  });

  it("(2) a folder with no workbook at the first event starts a task normally", async () => {
    const folder = await realFolder(false);
    const r = await runCli({ CLAUDE_PROJECT_DIR: folder }, [], await payload(folder));
    assert.equal(r.code, 0, r.stderr);
  });

  it("(2) a good folder still exits 0 and prints nothing", async () => {
    const folder = await realFolder(true);
    const r = await runCli({}, ["--folder", folder], await payload(folder));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "");
  });

  it("(2) later events in a folder that has state do not fail when the workbooks are gone", async () => {
    const t = await setup();
    await t.pre("toolu_A", "a");
    await rm(t.file);
    await t.post("toolu_A", "a");
    const s = usable(await t.stop());
    assert.ok(credits(t.home, s.taskId).length > 0, "the deleted workbook is a state");
  });
});

describe("hook adapter: the ghost-call window (pins existing behavior)", () => {
  it("(3) a Pre with no Post absorbs a hand edit found at a later Pre sweep", async () => {
    let now = 1_000_000;
    const t = await setup(undefined, { now: () => now });
    await t.pre("toolu_F", "denied"); // no Post ever
    now += 60_000;
    await t.write({ A1: 99 }); // a hand edit
    await t.pre("toolu_G", "ls");
    await t.post("toolu_G", "ls");
    const s = usable(await t.stop());
    const f = t.opsOf(s.taskId).filter((o) => o.args.tool_use_id === "toolu_F");
    assert.deepEqual(f.map(files), [["model.xlsx"]]);
    assert.deepEqual(credits(t.home, s.taskId), [["toolu_F"]]);
    assert.deepEqual(f.map((o) => o.args.closedBy), ["stop"]);
  });

  it("(3) the same edit found after the ghost expired stays unlogged", async () => {
    let now = 1_000_000;
    const t = await setup(undefined, { now: () => now });
    await t.pre("toolu_F", "denied");
    now += 11 * 60_000;
    await t.write({ A1: 99 });
    await t.pre("toolu_G", "ls");
    await t.post("toolu_G", "ls");
    const s = usable(await t.stop());
    assert.deepEqual(t.opsOf(s.taskId).flatMap(files), []);
    assert.deepEqual(credits(t.home, s.taskId), [[]]);
  });

  it("(3) the same edit made after Stop closed the ghost stays unlogged", async () => {
    const t = await setup();
    await t.pre("toolu_F", "denied");
    await t.stop();
    await t.write({ A1: 99 });
    await t.pre("toolu_G", "ls");
    await t.post("toolu_G", "ls");
    const s = usable(await t.stop());
    assert.deepEqual(t.opsOf(s.taskId).flatMap(files), []);
    assert.deepEqual(credits(t.home, s.taskId), [[]]);
  });
});

describe("hook adapter: the background call (pins existing behavior)", () => {
  it("(4) after run_in_background, later sequential ops are joint with it until Stop", async () => {
    const t = await setup();
    await t.pre("toolu_BG", "job &", {}, { run_in_background: true });
    await t.post("toolu_BG", "job &", {}, { run_in_background: true });
    const cells: Record<string, number> = { A1: 1 };
    for (let i = 1; i <= 3; i++) {
      await t.pre(`toolu_S${i}`, "s");
      cells[`B${i}`] = i;
      await t.write({ ...cells });
      await t.post(`toolu_S${i}`, "s");
    }
    const s = usable(await t.stop());
    const ops = t.opsOf(s.taskId).filter((o) => files(o).length > 0);
    for (let i = 1; i <= 3; i++) {
      const o = ops.find((x) => x.args.tool_use_id === `toolu_S${i}`)!;
      assert.deepEqual(o.args.jointWith, ["toolu_BG", `toolu_S${i}`]);
    }
    assert.ok(ops.some((o) => o.args.tool_use_id === "toolu_BG"), "the background call carries the change too");
  });

  it("(4) after Stop, or after expiry, a later sequential op is not joint with it", async () => {
    let now = 1_000_000;
    const t = await setup(undefined, { now: () => now });
    await t.pre("toolu_BG", "job &", {}, { run_in_background: true });
    await t.post("toolu_BG", "job &", {}, { run_in_background: true });
    now += 11 * 60_000;
    await t.pre("toolu_S1", "s");
    await t.write({ A1: 2 });
    await t.post("toolu_S1", "s");
    await t.pre("toolu_BG2", "job &", {}, { run_in_background: true });
    await t.post("toolu_BG2", "job &", {}, { run_in_background: true });
    await t.stop();
    await t.pre("toolu_S2", "s");
    await t.write({ A1: 3 });
    await t.post("toolu_S2", "s");
    const s = usable(await t.stop());
    const ops = t.opsOf(s.taskId).filter((o) => files(o).length > 0);
    assert.deepEqual(ops.find((x) => x.args.tool_use_id === "toolu_S1")!.args.jointWith, ["toolu_S1"]);
    assert.deepEqual(ops.find((x) => x.args.tool_use_id === "toolu_S2")!.args.jointWith, ["toolu_S2"]);
  });
});
