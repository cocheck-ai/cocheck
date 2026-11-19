import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// once a call's failure event is recorded it is credited with no later change. A failed call that left a
// half-written workbook is not given the cells a later call made when it repaired the file; calls that really overlapped still share.
const probe = (name: string) => path.join(import.meta.dirname, "fixtures", "probe", name);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
// the hook reads no workbook; a half-written save is the generic cut-short check's (connector/claimed.ts), so the
// fixture is a real one: the first bytes of the workbook, as a writer that has not finished leaves it. There is no cell-level credit, so a
// call's credit is its op naming the file (not the op of the cut-short state itself). The expected writers are unchanged.
const PARTIAL = (await readFile(probe("S0.xlsx"))).subarray(0, 2000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function setFirstNumber(bytes: Uint8Array, value: number): Uint8Array {
  const zip = unzipSync(bytes);
  for (const part of Object.keys(zip).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
    const xml = strFromU8(zip[part]!);
    const hit = /<c r="[A-Z]+\d+"(?: s="\d+")?><v>-?[\d.]+<\/v><\/c>/.exec(xml)?.[0];
    if (hit === undefined) continue;
    return zipSync({ ...zip, [part]: strToU8(xml.replace(hit, hit.replace(/<v>[^<]*<\/v>/, `<v>${value}</v>`))) }, { mtime: new Date(2020, 0, 1) });
  }
  throw new Error("no plain number cell in the fixture");
}

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  const file = path.join(folder, "macro.xlsx");
  await copyFile(probe("S0.xlsx"), file);
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder };
  const send = (o: Record<string, unknown>) => handleHook({ session_id: "sess", cwd: folder, tool_name: "Bash", ...o } as HookPayload, opts);
  const input = (id: string) => ({ tool_input: { command: `run ${id}`, description: id }, tool_use_id: id });
  const pre = (id: string) => send({ hook_event_name: "PreToolUse", ...input(id) });
  const post = (id: string) => send({ hook_event_name: "PostToolUse", ...input(id), tool_response: { stdout: "", stderr: "", interrupted: false } });
  const fail = (id: string) => send({ hook_event_name: "PostToolUseFailure", ...input(id), error: "Exit code 1", is_interrupt: false });
  const read = <T,>(fn: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return fn(l);
    } finally {
      l.close();
    }
  };
  const events = () => read((l) => l.fileStatesForTask(1)).filter((s) => s.filePath === file);
  const ops = () => read((l) => l.okOpsForTask(1, 0, l.maxOpId()).map((o) => ({ id: o.id, args: JSON.parse(o.argsJson) as Record<string, any> })));
  const cellOps = (id: string) => {
    const readable = new Set(events().filter((e) => e.prevSha256 !== null && !/could not read at this point \(/.test(e.note)).map((e) => e.stepId));
    return ops().filter((o) => o.args.tool_use_id === id && o.args.path === file && Array.isArray(o.args.steps) && o.args.steps.some((st: number) => readable.has(st)));
  };
  return { file, pre, post, fail, events, ops, cellOps };
}

describe("a failed call is credited with no later change", () => {
  it("call 8 repairs the file call 7 left unreadable: the cells are call 8's alone", async () => {
    const t = await setup();
    const v1 = setFirstNumber(new Uint8Array(await readFile(t.file)), 111);
    await t.pre("toolu_7");
    await writeFile(t.file, PARTIAL);
    await t.fail("toolu_7");
    await t.pre("toolu_8");
    await writeFile(t.file, v1);
    await t.post("toolu_8");
    const readable = t.events().find((s) => s.sha256 === sha(v1))!;
    assert.deepEqual([...readable.credited], ["toolu_8"]);
    assert.doesNotMatch(readable.note, /during call toolu_7/, "the note must not name the failed call");
    assert.equal(t.cellOps("toolu_7").length, 0, "no late op for the failed call");
    assert.equal(t.cellOps("toolu_8").length, 1);
    assert.deepEqual(t.cellOps("toolu_8")[0]!.args.jointWith, ["toolu_8"]);
    assert.equal(t.cellOps("toolu_8")[0]!.args.closedBy, "post");
  });

  it("a failed call that stays open-overlapping with a live one: only the live one gets the later cells", async () => {
    const t = await setup();
    const v1 = setFirstNumber(new Uint8Array(await readFile(t.file)), 111);
    await t.pre("toolu_A");
    await t.pre("toolu_B");
    await writeFile(t.file, PARTIAL);
    await t.fail("toolu_B"); // B fails; A is still running
    await writeFile(t.file, v1);
    await t.post("toolu_A");
    assert.equal(t.cellOps("toolu_B").length, 0);
    assert.equal(t.cellOps("toolu_A").length, 1, "A, still running, made the repair");
    // A and B really overlapped while the file was unreadable; the repair gives B nothing.
    assert.deepEqual([...t.events().find((s) => s.sha256 === sha(v1))!.credited], ["toolu_A"]);
  });

  it("two calls that really overlapped still share the cells and say so", async () => {
    const t = await setup();
    const v1 = setFirstNumber(new Uint8Array(await readFile(t.file)), 111);
    await t.pre("toolu_A");
    await t.pre("toolu_B");
    await writeFile(t.file, v1);
    await t.post("toolu_A");
    await t.post("toolu_B");
    assert.deepEqual([...t.cellOps("toolu_A")[0]!.args.jointWith].sort(), ["toolu_A", "toolu_B"]);
    assert.deepEqual([...t.cellOps("toolu_B")[0]!.args.jointWith].sort(), ["toolu_A", "toolu_B"]);
  });

  it("a call that did NOT fail and left the file unreadable is still credited later", async () => {
    const t = await setup();
    const v1 = setFirstNumber(new Uint8Array(await readFile(t.file)), 111);
    await t.pre("toolu_7");
    await writeFile(t.file, PARTIAL);
    await t.post("toolu_7");
    await t.pre("toolu_8");
    await writeFile(t.file, v1);
    await t.post("toolu_8");
    const readable = t.events().find((s) => s.sha256 === sha(v1))!;
    assert.deepEqual([...readable.credited].sort(), ["toolu_7", "toolu_8"]);
  });
});
