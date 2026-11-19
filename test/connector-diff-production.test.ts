import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createConnectorDiff } from "../src/connector/diff.ts";
import { memoryKeyProvider, setKeyProvider, writeSealed } from "../src/seal.ts";
import { ensureStoreDir } from "../src/states.ts";
import { removeHome } from "./helpers/remove-home.ts";

// The production connectorDiff. One call asks the connector, hands it the two stored states decrypted into a private temp folder, checks the
// answer, and leaves nothing behind: the temp folder is removed, and the connector's warm process does not outlive its idle timeout.
const ROOT = path.resolve(import.meta.dirname, "..");
const TOY = path.join(ROOT, "public-kit", "conformance", "fixtures", "toy");
const FX = path.join(import.meta.dirname, "fixtures", "connector-diff");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const notes = (...n: Array<[string, string]>) => JSON.stringify({ notes: n.map(([id, text]) => ({ id, text })) });
const BEFORE = notes(["n1", "buy milk"]), AFTER = notes(["n1", "buy oat milk"]);

const ORIGINAL_TMP = process.env.TMPDIR;
const restoreTmp = () => { if (ORIGINAL_TMP === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = ORIGINAL_TMP; };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  setKeyProvider(null);
});

async function rig(connectorDir: string, id: string) {
  setKeyProvider(memoryKeyProvider());
  restoreTmp();
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const scratch = await mkdtemp(path.join(tmpdir(), "cocheck-tmp-"));
  process.env.TMPDIR = scratch; // the temp folders the call makes land here, so the test can list them
  cleanups.push(async () => { restoreTmp(); await removeHome(home, scratch); });
  await mkdir(path.join(home, "connectors"), { recursive: true });
  await cp(connectorDir, path.join(home, "connectors", id), { recursive: true });
  const states = await ensureStoreDir(home, 1);
  for (const body of [BEFORE, AFTER]) await writeSealed(path.join(states, sha(body)), body);
  return { home, scratch };
}
const row = (connector: string, subject: string) => ({ subject, connector, before: { ref: sha(BEFORE) }, after: { ref: sha(AFTER) } });
const childCount = (): number => {
  try { return execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).split("\n").filter(Boolean).length; } catch { return 0; }
};
const posix = process.platform === "win32" ? { skip: "needs pgrep" } : {};

describe("connectorDiff", () => {
  it("answers with the connector's changes, the row's own refs and subject kept, and removes its temp folder", async () => {
    const { home, scratch } = await rig(TOY, "toy-notes");
    const d = await createConnectorDiff({ home, taskId: 1 })(row("toy-notes", "/work/edit.notes.json"));
    assert.equal(d.producer, "connector");
    assert.equal(d.connector, "toy-notes");
    assert.deepEqual(d.before, { ref: sha(BEFORE) });
    assert.deepEqual(d.changes.map((c) => [c.kind, c.anchors[0]!.label, c.after?.value]), [["changed", "Note n1", "buy oat milk"]]);
    assert.equal(d.subject, "/work/edit.notes.json", "the row's own subject is kept");
    assert.deepEqual(await readdir(scratch), [], "the decrypted states are gone");
  });

  // The connector's process stays warm for the next diff, so "no process outlives the call" became "none outlives its idle timeout".
  it("no connector process outlives its idle timeout, on success, on a rejected answer and on a timeout; the temp folder goes with each call", posix, async () => {
    const before = childCount();
    for (const [dir, id, ms] of [[TOY, "toy-notes", 10_000], [path.join(FX, "older-shape"), "fx-older-shape", 10_000], [path.join(FX, "hang"), "fx-hang", 600]] as const) {
      const { home, scratch } = await rig(dir, id);
      await createConnectorDiff({ home, taskId: 1, timeoutMs: ms, idleMs: 200 })(row(id, "/work/x.fx.json")).catch(() => {});
      assert.deepEqual(await readdir(scratch), [], `${id}: temp folder removed`);
      const end = Date.now() + 8000;
      while (childCount() !== before && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      assert.equal(childCount(), before, `${id}: no child left after the idle timeout`);
    }
  });

  it("an answer in the older change-list shape is rejected with a message naming it, so the loader would show `unavailable`", async () => {
    const { home } = await rig(path.join(FX, "older-shape"), "fx-older-shape");
    await assert.rejects(createConnectorDiff({ home, taskId: 1 })(row("fx-older-shape", "/work/x.fx.json")), /rejected.*older change-list shape.*no longer reads/);
  });

  it("a connector that never answers times out", async () => {
    const { home } = await rig(path.join(FX, "hang"), "fx-hang");
    await assert.rejects(createConnectorDiff({ home, taskId: 1, timeoutMs: 500 })(row("fx-hang", "/work/x.fx.json")), /timed out/);
  });

  it("a connector that is not installed rejects", async () => {
    const { home } = await rig(TOY, "toy-notes");
    await assert.rejects(createConnectorDiff({ home, taskId: 1 })(row("nope", "/work/x.json")), /not installed/);
  });

  // Run is an argv list or a platform map; the production diff resolves it as validate.ts does.
  const withRun = async (run: unknown, id: string) => {
    const r = await rig(TOY, id);
    const mf = path.join(r.home, "connectors", id, "cocheck-connector.json");
    const m = JSON.parse(readFileSync(mf, "utf8"));
    m.id = id; m.run = run;
    await writeFile(mf, JSON.stringify(m));
    return r;
  };
  it("runs the toy with an argv run and with a platform-map run, both green", async () => {
    const argv = ["node", "connector.mjs"];
    for (const [id, run] of [["toy-argv", argv], ["toy-map", { darwin: argv, win32: argv }]] as const) {
      const { home } = await withRun(run, id);
      const d = await createConnectorDiff({ home, taskId: 1 })(row(id, "/work/edit.notes.json"));
      assert.deepEqual(d.changes.map((c) => [c.kind, c.anchors[0]!.label]), [["changed", "Note n1"]], id);
    }
  });
  it("a platform map with no entry for this OS rejects, naming the OS", async () => {
    const { home } = await withRun({ plan9: ["node", "connector.mjs"] }, "toy-noos");
    await assert.rejects(createConnectorDiff({ home, taskId: 1 })(row("toy-noos", "/work/x.notes.json")), new RegExp(`no entry for ${process.platform}`));
  });
});
