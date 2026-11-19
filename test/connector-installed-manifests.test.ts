// One installed-manifest reader behind the registry, the subject templates and the MCP matcher; and the two before-side fixes in the hook.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readInstalledManifests } from "../src/connector/installed-manifests.ts";
import { loadSubjectTemplates, renderSubject } from "../src/connector/subjects.ts";
import { mcpConnectorMatches } from "../src/connector/installed-match.ts";
import { createRegistry } from "../src/connector/registry.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { journalSessionKey, readJournalSession } from "../src/hook-journal.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";

const TOOL = "mcp__notion__notion-update-page";
const manifest = (id: string, matches: unknown) => JSON.stringify({ spec: "cocheck.connector/1", id, version: "0.0.1", entry: "state", matches, run: ["node", "x.mjs"] });
const GOOD = { schemes: ["notion"], mcpTools: [TOOL], subjects: { [TOOL]: "notion://page/{page_id:hex}" } };

function put(home: string, id: string, text: string): string {
  const dir = path.join(home, "connectors", id);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "cocheck-connector.json");
  writeFileSync(file, text);
  return file;
}
const tmpHome = () => mkdtempSync(path.join(tmpdir(), "cocheck-"));
const posix = process.platform === "win32" ? { skip: "needs mkfifo" } : {};

describe("one installed-manifest reader", () => {
  it("reads regular files only, skips a bad manifest, never throws, and all three callers agree", { ...posix, timeout: 10_000 }, () => {
    const home = tmpHome();
    put(home, "notion", manifest("notion", GOOD));
    put(home, "b-garbage", "{not json");
    put(home, "c-invalid", manifest("bad", { subjects: { x: "notion://page/{page-id}" } }));
    mkdirSync(path.join(home, "connectors", "d-dir", "cocheck-connector.json"), { recursive: true });
    mkdirSync(path.join(home, "connectors", "e-fifo"), { recursive: true });
    execFileSync("mkfifo", [path.join(home, "connectors", "e-fifo", "cocheck-connector.json")]);
    const skipped: string[] = [];
    const got = readInstalledManifests(home, { onSkip: (f) => skipped.push(path.basename(path.dirname(f))) });
    assert.deepEqual(got.map((g) => g.manifest.id), ["notion"]);
    assert.deepEqual(skipped, ["b-garbage", "c-invalid", "d-dir", "e-fifo"], "the FIFO and the directory are reported without being opened");
    assert.deepEqual([...loadSubjectTemplates(home)], [[TOOL, "notion://page/{page_id:hex}"]]);
    assert.equal(mcpConnectorMatches(home, "notion", "notion-update-page"), true);
    assert.equal(createRegistry({ home }).forSubject("notion://page/ab").id, "notion");
    assert.deepEqual(readInstalledManifests(path.join(home, "absent")), []);
    assert.deepEqual(readInstalledManifests(undefined), []);
  });
});

describe("an empty subject field never renders", () => {
  it("renderSubject returns undefined for an empty field and for a hex field with no hex digit", () => {
    assert.equal(renderSubject("notion://page/{page_id:hex}", { page_id: "" }), undefined);
    assert.equal(renderSubject("notion://page/{page_id:hex}", { page_id: "zz" }), undefined);
    assert.equal(renderSubject("notion://page/{page_id}", { page_id: "" }), undefined);
    assert.equal(renderSubject("notion://page/{page_id:hex}", { page_id: "2f6c" }), "notion://page/2f6c");
  });
});

const rigs: Rig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.cleanup(); });
const SESSION = "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11";
const pre = (r: Rig, toolInput: unknown) => ({ session_id: SESSION, cwd: r.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: TOOL, tool_use_id: "toolu_1", tool_input: toolInput });
async function drive(toolInput: unknown, localProcess?: unknown) {
  const r = await makeRig();
  rigs.push(r);
  put(r.home, "notion", manifest("notion", GOOD));
  const res: any = await runHook({
    argv: ["node", "hook.ts", "--host", "claude", "--folder", r.folder],
    env: { COCHECK_HOME: r.home },
    stdin: (async function* () { yield Buffer.from(JSON.stringify(pre(r, toolInput))); })(),
    localProcess,
  } as any);
  return { r, res };
}
const NOT_RENDERED = { subject: null, state: "unknown", confidence: "opaque", reason: "subject not rendered" };

describe("a templated tool whose subject cannot be rendered records a before side", () => {
  for (const [label, input] of [["missing field", { properties: {} }], ["empty field", { page_id: "" }], ["field with no hex digit", { page_id: "zz" }]] as const) {
    it(`${label}: before side is unknown/opaque with a null subject, and the local process is never asked`, async () => {
      const asked: unknown[] = [];
      const { r, res } = await drive(input, { request: (q: unknown) => { asked.push(q); return Promise.resolve({ ref: "x" }); } });
      assert.equal(res.exitCode, 0, res.stderr);
      assert.deepEqual(res.beforeSide, NOT_RENDERED);
      assert.equal(asked.length, 0);
      const side = readJournalSession(r.home, journalSessionKey(SESSION)).filter((x) => x.k === "before-side");
      assert.equal(side.length, 1);
      assert.deepEqual(side[0].side, NOT_RENDERED);
    });
  }
});

describe("a failed before-side journal write is noted as degraded", () => {
  it("writes the stderr line and journal.degraded", { ...(process.platform === "win32" || process.getuid?.() === 0 ? { skip: "needs a permission-denied write" } : {}) }, async () => {
    const r0 = { journal: "" };
    const local = {
      request: async () => {
        // the event line is already written; make the next append to the session journal fail
        chmodSync(r0.journal, 0o400);
        return { ref: "snap-1" };
      },
    };
    const r = await makeRig();
    rigs.push(r);
    put(r.home, "notion", manifest("notion", GOOD));
    r0.journal = path.join(r.home, "journal", `${journalSessionKey(SESSION)}.jsonl`);
    const res: any = await runHook({
      argv: ["node", "hook.ts", "--host", "claude", "--folder", r.folder],
      env: { COCHECK_HOME: r.home },
      stdin: (async function* () { yield Buffer.from(JSON.stringify(pre(r, { page_id: "2f6c0e9b-11a1-4b7e-9a53-1d2f6c0e9b11" }))); })(),
      localProcess: local,
    } as any);
    assert.match(res.stderr, /could not record the before side: EACCES/);
    const flag = path.join(r.home, "journal.degraded");
    assert.ok(existsSync(flag), "journal.degraded exists");
    assert.match(readFileSync(flag, "utf8"), /EACCES/);
    assert.equal(readFileSync(flag, "utf8").trim().split("\n").length, 1, "one note: the later housekeeping failure does not write this one");
  });
});
