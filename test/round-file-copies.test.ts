import { posixOnly } from "./helpers/platform.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import type { FormatLayer } from "../src/formats/layer.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";
import { signOffForTest } from "./helpers/signed-fixture.ts";
import { plantValueRows } from "./helpers/planted-rows.ts";
import { hardenHome } from "../src/home-perms.ts";

const DAY = 24 * 60 * 60 * 1000;

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

/** Every file under `dir`, recursively, minus folder.json (the watch marker is not a copy). */
async function copiesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name !== "folder.json") out.push(full);
    }
  };
  await walk(dir);
  return out;
}

async function setup(layers: FormatLayer[] = [createFilesLayer()]) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-r2-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-r2-folder-")));
  const ledger = openLedger(home);
  let skew = 0;
  const tasks = new TaskStore(ledger, home, layers, () => Date.now() + skew);
  const file = (n: string) => path.join(folder, n);
  const taskDir = (id: number) => path.join(home, "tasks", String(id));
  return {
    home, folder, ledger, tasks, file, taskDir,
    advance: (ms: number) => (skew = ms),
    cleanup: async () => {
      ledger.close();
      await rm(home, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    },
  };
}

/** Two rounds on a.txt with unrelated b.txt / c.txt in the folder; returns the task id. */
async function twoRounds(t: Awaited<ReturnType<typeof setup>>, final: boolean) {
  await writeFile(t.file("a.txt"), "one\n");
  await writeFile(t.file("b.txt"), "unrelated b\n");
  await writeFile(t.file("c.txt"), "unrelated c\n");
  const id = await t.tasks.touch("c", t.file("a.txt"));
  t.ledger.recordOp({ taskId: id, tool: "cocheck_write", args: { path: t.file("a.txt") }, intent: "edit", clientName: "c", durationMs: 1, resultCode: "OK" });
  await writeFile(t.file("a.txt"), "two\n");
  await t.tasks.submit("c", "first", false);
  // The round writes no value row for a text file, so the one the reader, sign-off and expiry tests need is planted.
  plantValueRows(t.ledger, id, [{ file: t.file("a.txt"), before: "one", after: "two" }]);
  if (final) {
    // Approve the round-1 row so a final submit can close the task.
    for (const r of t.ledger.reviewRowsForTask(id)) {
      t.ledger.recordDecision({ rowId: r.id, decision: "approve", note: "", reviewer: "Dana" });
    }
  } else {
    await writeFile(t.file("a.txt"), "three\n");
  }
  await t.tasks.submit("c", "second", final);
  return id;
}

describe("hashes in the ledger", () => {
  it("records the SHA-256 of each snapshot when it is taken", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    const snap = t.ledger.snapshotsForTask(id).find((s) => s.filePath === t.file("a.txt"))!;
    assert.equal(snap.sha256, sha("one\n"));
    await t.cleanup();
  });

  it("sign-off uses the stored hash, so it needs no copy on disk", async () => {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    t.ledger.recordOp({ taskId: id, tool: "cocheck_write", args: { path: t.file("a.txt") }, intent: "edit", clientName: "c", durationMs: 1, resultCode: "OK" });
    await writeFile(t.file("a.txt"), "two\n");
    await t.tasks.submit("c", "done", false);
    for (const r of t.ledger.reviewRowsForTask(id)) {
      t.ledger.recordDecision({ rowId: r.id, decision: "approve", note: "", reviewer: "Dana" });
    }
    await t.tasks.submit("c", "done", true);
    for (const f of await copiesUnder(t.taskDir(id))) await rm(f);
    const rec = await signOffForTest(t.ledger, id, "Dana");
    assert.deepEqual(rec.files.map((f) => f.sha256), [sha("two\n")]);
    await t.cleanup();
  });
});

describe("results persisted at the round cut", () => {
});

// Round copies are not promised for everything a task keeps. What the gateway's rounds
// copy as diff bases still follows them, and these tests keep that narrower rule; what the hook adapter's per-step store keeps
// is the new rule (every state for the task's life, first and final until the 30-day expiry), tested in hook-state.test.ts.
describe("one round copy per file", () => {
  it("after each round cut, each file holds only its latest copy", async () => {
    const t = await setup();
    const id = await twoRounds(t, false);
    const names = (await copiesUnder(t.taskDir(id))).map((f) => path.basename(f));
    assert.equal(names.filter((n) => n.endsWith("-a.txt")).length, 1);
    await t.cleanup();
  });
});

describe("what closed means for round copies", () => {
  it("a sign-off leaves no file copies, and the rows and the sign-off record stay", async () => {
    const t = await setup();
    const id = await twoRounds(t, true);
    await signOffForTest(t.ledger, id, "Dana");
    assert.deepEqual(await copiesUnder(t.taskDir(id)), []);
    assert.ok(t.ledger.reviewRowsForTask(id).length > 0, "the rows stay");
    assert.equal(t.ledger.signoffsForTask(id).length, 1, "the sign-off record stays");
    await t.cleanup();
  });

  it("a final submit without sign-off keeps at most one copy per touched file and none of the unrelated ones", async () => {
    const t = await setup();
    const id = await twoRounds(t, true);
    const names = (await copiesUnder(t.taskDir(id))).map((f) => path.basename(f));
    assert.ok(names.length <= 1, names.join(","));
    assert.equal(names.some((n) => /-(b|c)\.txt$/.test(n)), false);
    await t.cleanup();
  });
});

describe("expiry", () => {
  it("a task idle for 7 days is closed as expired, not signed off, its copies deleted", async () => {
    const t = await setup();
    const id = await twoRounds(t, false);
    t.advance(7 * DAY + 1000);
    await t.tasks.sweep();
    assert.deepEqual(await copiesUnder(t.taskDir(id)), []);
    assert.equal(t.ledger.closureForTask(id)?.kind, "expired");
    const html = renderReviewPage(reviewModel(t.ledger, id));
    assert.match(html, /expired, not signed off/);
    await t.cleanup();
  });

  it("a task idle for 6 days is left alone", async () => {
    const t = await setup();
    const id = await twoRounds(t, false);
    t.advance(6 * DAY);
    await t.tasks.sweep();
    assert.equal(t.ledger.closureForTask(id), undefined);
    assert.ok((await copiesUnder(t.taskDir(id))).length >= 1);
    await t.cleanup();
  });
});

describe("permissions", () => {
  it("the ledger and its WAL and SHM files are 0600 and the home and task folders 0700", posixOnly("owner-only mode bits (0600/0700)"), async () => {
    const t = await setup();
    const id = await twoRounds(t, false);
    await writeFile(path.join(t.home, "review.log"), "x", { mode: 0o644 });
    await writeFile(path.join(t.home, "review-port"), "1\n", { mode: 0o644 });
    await hardenHome(t.home);
    for (const f of ["ledger.sqlite", "ledger.sqlite-wal", "ledger.sqlite-shm", "review.log", "review-port"]) {
      assert.equal((await stat(path.join(t.home, f))).mode & 0o777, 0o600, f);
    }
    for (const d of [t.home, path.join(t.home, "tasks"), t.taskDir(id)]) {
      assert.equal((await stat(d)).mode & 0o777, 0o700, d);
    }
    for (const f of await copiesUnder(t.taskDir(id))) assert.equal((await stat(f)).mode & 0o777, 0o600, f);
    await t.cleanup();
  });
});

describe("existing installs", () => {
  it("the first start of the new build trims, expires and hardens an old-layout home", posixOnly("owner-only mode bits (0600/0700)"), async () => {
    const t = await setup();
    const id = await twoRounds(t, false);
    // Old layout: copies for every round, world-readable.
    const old = path.join(t.taskDir(id), "round-0");
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, "9-old.txt"), "stale copy", { mode: 0o644 });
    await chmod(t.taskDir(id), 0o755);
    t.advance(8 * DAY);
    await t.tasks.sweep();
    assert.deepEqual(await copiesUnder(t.taskDir(id)), []);
    await hardenHome(t.home);
    assert.equal((await stat(t.taskDir(id))).mode & 0o777, 0o700);
    await t.cleanup();
  });

});

describe("ledger values expire", () => {
  it("values of a task closed over 30 days ago are removed; locations stay", async () => {
    const t = await setup();
    const id = await twoRounds(t, true);
    await signOffForTest(t.ledger, id, "Dana");
    t.advance(31 * DAY);
    await t.tasks.sweep();
    const rows = t.ledger.reviewRowsForTask(id);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(r.location.length > 0);
      assert.equal(r.before, null);
      assert.equal(r.after, null);
    }
    assert.ok(t.ledger.valuesExpiredAt(id) !== undefined, "the ledger records the expiry");
    await t.cleanup();
  });

  it("a task closed 29 days ago keeps its values", async () => {
    const t = await setup();
    const id = await twoRounds(t, true);
    await signOffForTest(t.ledger, id, "Dana");
    t.advance(29 * DAY);
    await t.tasks.sweep();
    assert.ok(t.ledger.reviewRowsForTask(id).some((r) => r.after !== null));
    await t.cleanup();
  });
});

void readFile;
