import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openLedger } from "../src/ledger.ts";
import { writeSealed } from "../src/seal.ts";
import { ensureStoreDir } from "../src/states.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { buildTimeline, type Change } from "../src/timeline/timeline.ts";
import { isUriSubject } from "../src/connector/subject.ts";
import { pathKit } from "../src/paths.ts";

// the ledger's file_path holds a subject (an absolute path, or a connector's URI) and file_states has a `connector` column (NULL = a built-in file).

const sha = (b: string): string => createHash("sha256").update(b).digest("hex");
const URI = "notion://page/abc";
const CLIENT = "claude:/work";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tempHome = async (): Promise<string> => {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-subjects-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
};

/** Every change in a timeline, wherever the model placed it (under a call, or unplaced). */
function allChanges(node: unknown, out: Change[] = []): Change[] {
  if (Array.isArray(node)) node.forEach((x) => allChanges(x, out));
  else if (typeof node === "object" && node !== null) {
    const o = node as Record<string, unknown>;
    if ("credit" in o && "generic" in o && "kind" in o) out.push(o as unknown as Change);
    else Object.values(o).forEach((x) => allChanges(x, out));
  }
  return out;
}

describe("isUriSubject", () => {
  for (const s of ["notion://page/x", "linear://issue/ENG-1", "file:///x"]) it(`${s} is a URI subject`, () => assert.equal(isUriSubject(s), true));
  for (const s of ["/Users/a/b.xlsx", "C:\\a\\b.docx", "C:/a/b.docx", "relative/b.txt", "c:\\x", "/Users/a/notion://page/x"]) it(`${s} is a file`, () => assert.equal(isUriSubject(s), false));
});

describe("a URI subject row", () => {
  it("is written by the normal writer, credited and loaded by the timeline like a file row, with no filesystem call on the URI", async () => {
    const home = await tempHome();
    const ledger = openLedger(home);
    cleanups.push(async () => ledger.close());
    const id = ledger.openTask(CLIENT);
    const states = await ensureStoreDir(home, id);
    await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
    const a = "title: one\n";
    const b = "title: two\n";
    await writeSealed(path.join(states, sha(a)), a);
    await writeSealed(path.join(states, sha(b)), b);
    const callId = "toolu_1";
    ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: [URI], description: "edit", narration: { source: "none", text: "none" } } });
    ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Edit."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
    const file = (sh: string, prev: string | null, body: string) => ({ filePath: URI, connector: "notion", sha256: sh, prevSha256: prev, size: body.length, kept: "whole" as const, note: "" });
    ledger.recordStep({ taskId: id, client: CLIENT, seq: 1, phase: "Post", callsOpen: [callId], credited: [callId], files: [file(sha(a), null, a)] });
    ledger.recordStep({ taskId: id, client: CLIENT, seq: 2, phase: "Post", callsOpen: [callId], credited: [callId], files: [file(sha(b), sha(a), b)] });
    const stored = ledger.fileStatesForTask(id);
    assert.deepEqual(stored.map((r) => [r.filePath, r.connector]), [[URI, "notion"], [URI, "notion"]]);

    // Stub every filesystem entry point and path.resolve; record each argument. Nothing may name the URI.
    const seen: string[] = [];
    const orig = new Map<string, unknown>();
    const stubs: Array<[object, string]> = [[fs, "statSync"], [fs, "lstatSync"], [fs, "existsSync"], [fs, "readFileSync"], [fs, "realpathSync"], [fs, "accessSync"], [fs, "readdirSync"], [path, "resolve"]];
    for (const [obj, name] of stubs) {
      const real = (obj as Record<string, unknown>)[name] as (...a: unknown[]) => unknown;
      orig.set(`${obj === fs ? "fs" : "path"}.${name}`, real);
      (obj as Record<string, unknown>)[name] = function (this: unknown, ...a: unknown[]) {
        for (const x of a) if (typeof x === "string") seen.push(x);
        return real.apply(this, a);
      };
    }
    syncBuiltinESMExports();
    let changes: Change[];
    try {
      const loaded = loadRows(ledger, id, "t");
      const input = await loadTimelineInput(ledger, home, loaded, { build: "t", quickLook: false, render: async () => null });
      const t = buildTimeline(input);
      changes = allChanges(t);
    } finally {
      for (const [obj, name] of stubs) (obj as Record<string, unknown>)[name] = orig.get(`${obj === fs ? "fs" : "path"}.${name}`);
      syncBuiltinESMExports();
    }
    assert.ok(seen.length > 0, "the stub saw the loader's own calls, so it is wired");
    assert.deepEqual(seen.filter((s) => s.includes(URI) || s.includes("page/abc")), [], "no filesystem or resolve call names the URI");
    assert.equal(changes.length, 2, "both URI rows are on the rail, like file rows");
    assert.deepEqual(changes.map((c) => c.kind).sort(), ["created", "modified"]);
    assert.ok(changes.every((c) => c.credit.calls.includes(callId)), "credited to the call that named it");
    // a row with a connector is a state core draws no view of, so its text bytes are no lines: a fingerprint marked claimed
    const g = changes.find((c) => c.kind === "modified")!.generic as { tier: string; claimed?: true };
    assert.deepEqual([g.tier, g.claimed], ["fingerprint", true]);
  });
});

describe("the URI as a path, a path as a URI", () => {
  const kit = pathKit();
  it("a real absolute file path is never read as a URI and stays on the rail", async () => {
    for (const p of ["/Users/a/b.xlsx", "C:\\a\\b.docx", "C:/a/b.docx", "/work/a.txt"]) assert.equal(isUriSubject(p), false);
    const home = await tempHome();
    const ledger = openLedger(home);
    cleanups.push(async () => ledger.close());
    const id = ledger.openTask(CLIENT);
    const states = await ensureStoreDir(home, id);
    await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
    await writeSealed(path.join(states, sha("x\n")), "x\n");
    ledger.recordStep({ taskId: id, client: CLIENT, seq: 1, phase: "Post", callsOpen: [], credited: ["call-not-in-record"], files: [{ filePath: "/work/a.txt", sha256: sha("x\n"), prevSha256: null, size: 2, kept: "whole", note: "" }] });
    const t = buildTimeline(await loadTimelineInput(ledger, home, loadRows(ledger, id, "t"), { build: "t", quickLook: false, render: async () => null }));
    assert.equal(t.unplaced.length, 1);
    assert.equal(ledger.fileStatesForTask(id)[0]!.connector, null);
  });
});
