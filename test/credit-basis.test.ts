import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evidenceDir } from "../src/attribution/tag.ts";
import { PROOF_METHODS, creditBasisOf } from "../src/attribution/basis.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { normalize } from "../src/normalize.ts";
import { workbookClaims } from "./helpers/claims.ts";

// The ledger stores what each change's credit stands on (`file_states.credit_basis`). Must not happen: a change is never stored
// as `argv-tag` unless the tag evidence for that file names every call it is credited to.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);

async function rig() {
  const home = await tmp("home");
  const folder = await tmp("folder");
  const a = path.join(folder, "a.xlsx");
  await copyFile(probe(0), a);
  const b = path.join(folder, "b.xlsx");
  await copyFile(probe(0), b);
  let clock = Date.parse("2026-10-24T14:00:00Z");
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>, taggedCall = false) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, { ...opts, taggedCall });
  };
  const bash = (event: string, id: string, command: string, tagged = false) => send({ hook_event_name: event, tool_name: "Bash", tool_use_id: id, tool_input: { command }, agent_id: "helper2", agent_type: "general-purpose" }, tagged);
  const wrote = async (call: string, file: string, op = "write") => {
    await mkdir(evidenceDir(home), { recursive: true });
    await appendFile(path.join(evidenceDir(home), `writes-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ v: 1, call, agent: "helper2", pid: 1, ts: clock, op, path: file, via: "python" }) + "\n");
  };
  const states = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).filter((s) => s.prevSha256 !== null).map((s) => ({ file: path.basename(s.filePath), credited: [...s.credited].sort().join("+"), basis: s.creditBasis }));
    } finally {
      l.close();
    }
  };
  await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "warm", tool_input: { command: "true" } });
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  // a first credited change opens the task
  await bash("PreToolUse", "F", "python3 first.py", true);
  await wrote("F", "/usr/bin/python3", "start");
  await copyFile(probe(1), a);
  await wrote("F", a);
  await bash("PostToolUse", "F", "python3 first.py");
  return { bash, wrote, send, states, a, b, write: (n: number) => copyFile(probe(n), a), writeB: (n: number) => copyFile(probe(n), b) };
}

describe("credit_basis: what existing hosts already know", () => {
  it("a change credited to the call whose tag names the file is stored as argv-tag", async () => {
    const t = await rig();
    assert.deepEqual(t.states(), [{ file: "a.xlsx", credited: "F", basis: "argv-tag" }]);
  });

  it("a change credited by the open window, with no tag evidence, is stored as window", async () => {
    const t = await rig();
    await t.bash("PreToolUse", "W", "python3 plain.py");
    await t.write(2);
    await t.bash("PostToolUse", "W", "python3 plain.py");
    assert.deepEqual(t.states().at(-1), { file: "a.xlsx", credited: "W", basis: "window" });
  });

  it("a change nobody is credited with is stored as unattributed", async () => {
    const t = await rig();
    await t.write(2);
    await t.send({ hook_event_name: "Stop", last_assistant_message: "done" });
    assert.deepEqual(t.states().at(-1), { file: "a.xlsx", credited: "", basis: "unattributed" });
  });

  it("two overlapping calls, one named by the file in its own input, are stored as named", async () => {
    const t = await rig();
    await t.send({ hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "N", tool_input: { file_path: t.a, content: "x" } });
    await t.bash("PreToolUse", "O", "python3 other.py");
    await t.write(2);
    await t.send({ hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "N", tool_input: { file_path: t.a, content: "x" } });
    const last = t.states().at(-1)!;
    assert.deepEqual(last, { file: "a.xlsx", credited: "N", basis: "named" });
  });

  // guarded case
  it("tag evidence naming a call the adapter never saw never makes a window credit argv-tag", async () => {
    const t = await rig();
    await t.bash("PreToolUse", "W", "python3 plain.py");
    await t.wrote("ghost", t.a);
    await t.write(2);
    await t.bash("PostToolUse", "W", "python3 plain.py");
    const last = t.states().at(-1)!;
    assert.notEqual(last.basis, "argv-tag", JSON.stringify(last));
  });

  it("tag evidence for one call does not stamp a joint credit that includes an untagged call as argv-tag", async () => {
    const t = await rig();
    await t.bash("PreToolUse", "X", "python3 x.py", true);
    await t.bash("PreToolUse", "Y", "python3 y.py");
    await t.wrote("X", t.a);
    await t.write(2);
    await t.bash("PostToolUse", "Y", "python3 y.py");
    await t.bash("PostToolUse", "X", "python3 x.py");
    const row = t.states().filter((s) => s.file === "a.xlsx").at(-1)!;
    assert.deepEqual(row.credited.split("+"), ["X", "Y"], JSON.stringify(row));
    assert.notEqual(row.basis, "argv-tag", JSON.stringify(row));
  });

  it("tag evidence for call X naming file B does not make X's window credit to file A argv-tag", async () => {
    const t = await rig();
    await t.bash("PreToolUse", "X", "python3 x.py", true);
    await t.wrote("X", t.b);
    await t.write(2);
    await t.writeB(2);
    await t.bash("PostToolUse", "X", "python3 x.py");
    const rows = t.states();
    const rowA = rows.filter((s) => s.file === "a.xlsx").at(-1)!;
    const rowB = rows.filter((s) => s.file === "b.xlsx").at(-1)!;
    assert.equal(rowA.credited, "X", JSON.stringify(rows));
    assert.notEqual(rowA.basis, "argv-tag", JSON.stringify(rowA));
    assert.deepEqual(rowB, { file: "b.xlsx", credited: "X", basis: "argv-tag" });
  });
});

describe("creditBasisOf", () => {
  it("argv-tag needs credit and every credited call named by the tag evidence", () => {
    assert.equal(creditBasisOf({ credited: [], taggedWriters: ["a"], named: false }), "unattributed");
    assert.equal(creditBasisOf({ credited: ["a"], taggedWriters: [], named: false }), "window");
    assert.equal(creditBasisOf({ credited: ["a", "b"], taggedWriters: ["a"], named: false }), "window");
    assert.equal(creditBasisOf({ credited: ["a"], taggedWriters: ["a"], named: false }), "argv-tag");
    assert.equal(creditBasisOf({ credited: ["a"], taggedWriters: [], named: true }), "named");
  });
  it("lists the seven methods", () => {
    assert.deepEqual([...PROOF_METHODS], ["argv-tag", "host-reported-edit", "declared", "named", "window", "joint", "unattributed"]);
  });
});

describe("NormalizedEvent carries proof and a synthetic flag", () => {
  for (const host of ["claude", "codex", "copilot"] as const) {
    it(`${host}: proof is empty and the call id is not synthetic`, () => {
      const ev = normalize(host, { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } });
      assert.deepEqual(ev.proof, []);
      assert.equal(ev.synthetic, false);
    });
  }
});

describe("credit basis", () => {
  it("refuses a basis that is not one of the seven methods", async () => {
    const home = await tmp("bad");
    const l = openLedger(home);
    try {
      const task = l.openTask("c");
      assert.throws(() => l.recordStep({ taskId: task, client: "c", seq: 1, phase: "Post", callsOpen: [], credited: [], files: [{ filePath: "/x", sha256: "a", prevSha256: null, size: 1, kept: "whole", note: "", creditBasis: "guess" as never }] }));
    } finally {
      l.close();
    }
  });
});
