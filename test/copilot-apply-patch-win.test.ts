import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openLedger } from "../src/ledger.ts";
import { runHook } from "../src/hook-cli.ts";
import { setTracking } from "../src/tracking.ts";

// Copilot CLI 1.0.105 on Windows edits files with `apply_patch`; toolArgs is the bare patch string.
// Replayed through the real hook entry on this platform: CRLF files and patches, a JSON-quoted toolArgs, and the shapes-only `patchRead` record.
// Windows path forms are in copilot-apply-patch-win32-probe.test.ts. Every home and folder is a temp dir.
const SESSION = "5b1c0e52-4d6a-4f0e-9c1a-7a3d2f9e8b10";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function replay(steps: Array<{ id: string; patch: string; files: Record<string, string> }>, sep: string, opts: { crlf?: boolean; eol?: string; quoted?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  dirs.push(root);
  const home = path.join(root, "home");
  const folder = path.join(root, "ws");
  const copilotHome = path.join(root, "copilot");
  await mkdir(home);
  await mkdir(path.join(folder, "t09"), { recursive: true });
  await mkdir(path.join(copilotHome, "session-state"), { recursive: true });
  process.env.COPILOT_HOME = copilotHome;
  setTracking(home, "copilot", SESSION, true, folder);
  let ts = 1792885649000;
  const send = (event: string, stdin: Record<string, unknown>) => {
    ts += 1000;
    return runHook({ argv: ["node", "hook.ts", "--host", "copilot", "--event", event], env: { COCHECK_HOME: home }, journalNow: () => ts, stdin: (async function* () { yield Buffer.from(JSON.stringify({ sessionId: SESSION, timestamp: ts, cwd: folder, ...stdin })); })() });
  };
  await send("userPromptSubmitted", { prompt: "make t09 files" });
  for (const s of steps) {
    let patch = s.patch.split("<SEP>").join(sep);
    if (opts.crlf) patch = patch.split("\n").join("\r\n");
    const args = opts.quoted ? JSON.stringify(patch) : patch;
    await send("preToolUse", { toolName: "apply_patch", toolArgs: args });
    for (const [f, text] of Object.entries(s.files)) await writeFile(path.join(folder, f), text.split("\n").join(opts.eol ?? "\n"));
    await send("postToolUse", { toolName: "apply_patch", toolArgs: args, toolResult: { resultType: "success", textResultForLlm: `Added 1 file(s): ${path.join(folder, "t09", "one.md")}` } });
  }
  const ledger = openLedger(home);
  const ops = ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>));
  ledger.close();
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"), { readOnly: true });
  try {
    const states = (db.prepare("SELECT file_path AS p, credit_basis AS b FROM file_states ORDER BY id").all() as Array<{ p: string; b: string }>).map((r) => ({ file: path.relative(folder, r.p), basis: r.b }));
    return { ops: ops.filter((o) => o.tool_name === "apply_patch"), states, folder, home };
  } finally {
    db.close();
  }
}

const ADD = "*** Begin Patch\n*** Add File: t09<SEP>one.md\n+first\n*** End Patch";
const UPD = "*** Begin Patch\n*** Update File: t09<SEP>one.md\n@@\n-first\n+second\n*** End Patch";
const STEPS = [
  { id: "a", patch: ADD, files: { "t09/one.md": "first\n" } },
  { id: "b", patch: UPD, files: { "t09/one.md": "second\n" } },
];

describe("Copilot apply_patch", () => {
  for (const [name, sep, o] of [["relative with a slash", "/", {}], ["CRLF patch", "/", { crlf: true }], ["toolArgs JSON-quoted", "/", { quoted: true }], ["slash, files saved with CRLF", "/", { eol: "\r\n" }], ["CRLF patch and CRLF files", "/", { crlf: true, eol: "\r\n" }]] as const) {
    it(`Add then Update, ${name}: host-reported-edit and the file named`, async () => {
      const r = await replay(STEPS, sep, o);
      assert.ok(r.states.length >= 2);
      for (const s of r.states) assert.equal(s.basis, "host-reported-edit");
    });
  }

  it("names the file: the credited state is the patched file inside the folder", async () => {
    const r = await replay(STEPS, "/");
    assert.deepEqual([...new Set(r.states.map((x) => x.file.replaceAll("\\", "/")))], ["t09/one.md"]);
  });

  // Must not happen: a patch that names a file outside the task folder is never read as an inside edit, and the call still reads outside.
  for (const [name, header, sep] of [["a slash climb out", "..<SEP>escape.md", "/"], ["a path outside", "/tmp/cocheck-outside/escape.md", "/"]] as const) {
    it(`must not: ${name} still reads outside and gets no host-reported-edit`, async () => {
      const patch = `*** Begin Patch\n*** Add File: ${header}\n+x\n*** End Patch`;
      const r = await replay([{ id: "o", patch, files: { "t09/inside.md": "x\n" } }], sep);
      assert.equal(r.ops.length, 1);
      assert.ok(Array.isArray(r.ops[0]!.outsideRefs) && r.ops[0]!.outsideRefs.some((x: string) => x.endsWith("escape.md")), JSON.stringify(r.ops[0]));
      for (const s of r.states) assert.notEqual(s.basis, "host-reported-edit");
    });
  }

  // Same secret masking as Codex (src/patch-secrets.ts): the section is withheld, the raw value reaches no stored byte, the file stays inferred.
  it("a secret in the patch is withheld from every stored byte and the file is not proven", async () => {
    const secret = "ghp_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";
    const patch = `*** Begin Patch\n*** Add File: t09<SEP>one.md\n+token=${secret}\n*** End Patch`;
    const r = await replay([{ id: "s", patch, files: { "t09/one.md": `token=${secret}\n` } }], "/");
    for (const s of r.states) assert.notEqual(s.basis, "host-reported-edit");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(r.home)) assert.ok(!readFileSync(f).includes(secret), `secret stored in ${path.relative(r.home, f)}`);
  });

  it("records the shape it read (never text or paths) so a Windows run can see why a patch was not credited", async () => {
    const r = await replay(STEPS, "/");
    assert.deepEqual(r.ops.map((o) => o.patchRead), [
      { input: "string", quoted: false, cwd: process.platform === "win32" ? "drive-backslash" : "posix", named: 1, inside: 1, reported: 1 },
      { input: "string", quoted: false, cwd: process.platform === "win32" ? "drive-backslash" : "posix", named: 1, inside: 1, reported: 1 },
    ]);
    const q = await replay(STEPS, "/", { quoted: true });
    assert.equal(q.ops[0]!.patchRead.input, "string");
  });
});
