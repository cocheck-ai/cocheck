import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { closureOf } from "../src/signoff.ts";
import { pruneStates, previewsDirOf, storeDirOf, SIGNED_KEEP_MS } from "../src/states.ts";
import { readStoredImage } from "../src/timeline/stored-image.ts";

// A signed version expires on the same schedule as every other file version (everything expires at five weeks). The guard alignment at the bottom stays.

const DAY = 24 * 60 * 60 * 1000;
const sha = (c: string): string => c.repeat(64);

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  const ledger = openLedger(home);
  let skew = 0;
  const tasks = new TaskStore(ledger, home, [createFilesLayer()], () => Date.now() + skew);
  return {
    home, ledger, tasks, file: (n: string) => path.join(folder, n), advance: (ms: number) => (skew = ms),
    cleanup: async () => { ledger.close(); await rm(home, { recursive: true, force: true }); await rm(folder, { recursive: true, force: true }); },
  };
}

function soft(ledger: ReturnType<typeof openLedger>, taskId: number, covered: Array<{ stop: string; status: string; sha256: string | null }>) {
  return ledger.recordSoftSubmission({ taskId, signer: "Dana", rounds: 0, rejections: [], files: [], leftOut: [], closedTask: false, acknowledged: [], reviewer: "Dana", covered });
}

/** Every file left under the task folder (the round copies and the state store), relative to it. */
function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}

describe("the sweep keeps nothing a submission names", () => {
  it("round copies: the signed copies go with the rest, at idle expiry", async () => {
    const t = await setup();
    try {
      await writeFile(t.file("a.txt"), "one\n");
      const id = await t.tasks.touch("c", t.file("a.txt"));
      await writeFile(t.file("a.txt"), "two\n");
      await t.tasks.submit("c", "r1", false);
      // What the person signed: the copies stored right now. The later rounds below add copies no submission names.
      const signedCopies = t.ledger.snapshotsForTask(id).filter((s) => s.sha256 !== null && !s.removed && existsSync(s.snapshotPath));
      assert.ok(signedCopies.length >= 1, "a copy is stored to sign");
      soft(t.ledger, id, signedCopies.map((s, i) => ({ stop: `s${i}`, status: "passed", sha256: s.sha256 })));
      await writeFile(t.file("a.txt"), "three\n");
      await t.tasks.submit("c", "r2", false);
      await writeFile(t.file("a.txt"), "four\n");
      await t.tasks.submit("c", "r3", true);
      const all = t.ledger.snapshotsForTask(id).filter((s) => !s.removed && existsSync(s.snapshotPath));
      assert.ok(all.some((s) => !signedCopies.some((c) => c.id === s.id)), "an unsigned copy is stored too, so the sweep has something to remove");
      t.advance(8 * DAY);
      await t.tasks.sweep();
      assert.equal(closureOf(t.ledger, id)?.kind, "expired");
      const taskDir = path.join(t.home, "tasks", String(id));
      assert.deepEqual(existsSync(taskDir) ? walk(taskDir).filter((f) => f !== "folder.json") : [], [], "no copy is left, signed or not");
      for (const c of signedCopies) assert.equal(existsSync(c.snapshotPath), false, "the signed copy's file is gone");
      t.advance(40 * DAY);
      await t.tasks.sweep();
      assert.ok(t.ledger.valuesExpiredAt(id), "the values expired");
      assert.deepEqual(existsSync(taskDir) ? walk(taskDir).filter((f) => f !== "folder.json") : [], []);
    } finally {
      await t.cleanup();
    }
  });

  it("a task with no submission keeps no copy after the cleanup", async () => {
    const t = await setup();
    try {
      await writeFile(t.file("a.txt"), "one\n");
      const id = await t.tasks.touch("c", t.file("a.txt"));
      await writeFile(t.file("a.txt"), "two\n");
      await t.tasks.submit("c", "r1", true);
      t.advance(8 * DAY);
      await t.tasks.sweep();
      t.advance(40 * DAY);
      await t.tasks.sweep();
      const taskDir = path.join(t.home, "tasks", String(id));
      assert.deepEqual(existsSync(taskDir) ? walk(taskDir).filter((f) => f !== "folder.json") : [], []);
    } finally {
      await t.cleanup();
    }
  });
});

describe("the state store", () => {
  async function plant(shas: string[], signedShas: string[]) {
    const t = await setup();
    await writeFile(t.file("a.txt"), "one\n");
    const id = await t.tasks.touch("c", t.file("a.txt"));
    assert.equal(id, 1);
    const store = storeDirOf(t.home, 1);
    const prev = previewsDirOf(t.home, 1);
    await mkdir(store, { recursive: true });
    await mkdir(prev, { recursive: true });
    for (const s of shas) {
      await writeFile(path.join(store, s), "bytes");
      await writeFile(path.join(prev, `${s}.png`), "png");
    }
    if (signedShas.length > 0) soft(t.ledger, 1, signedShas.map((s, i) => ({ stop: `s${i}`, status: "passed", sha256: s })));
    return { ...t, store, prev };
  }
  const NOW = Date.now();

  for (const [name, closure] of [
    ["idle expiry", { kind: "expired" as const, ts: new Date(NOW).toISOString() }],
    ["30 days after sign-off", { kind: "signed" as const, ts: new Date(NOW - SIGNED_KEEP_MS - 1000).toISOString() }],
    ["sign-off (middle states)", { kind: "signed" as const, ts: new Date(NOW).toISOString() }],
  ] as const) {
    it(`${name}: the signed state and its picture go like every other stored state, once the rule drops them`, async () => {
      const t = await plant([sha("a"), sha("b"), sha("c")], [sha("b")]);
      try {
        await pruneStates(t.ledger, 1, closure, NOW);
        assert.deepEqual(existsSync(t.store) ? await readdir(t.store) : [], []);
        assert.deepEqual(existsSync(t.prev) && name !== "sign-off (middle states)" ? await readdir(t.prev) : [], []);
      } finally {
        await t.cleanup();
      }
    });
  }

  it("after the cleanup the page gets no picture for the signed version either", async () => {
    const t = await plant([sha("a"), sha("b")], [sha("b")]);
    try {
      await pruneStates(t.ledger, 1, { kind: "signed", ts: new Date(NOW - SIGNED_KEEP_MS - 1000).toISOString() }, NOW);
      for (const k of [sha("a"), sha("b")]) {
        assert.equal(await readStoredImage(t.home, 1, k), null);
      }
    } finally {
      await t.cleanup();
    }
  });
});

describe("(kept) the expiry guard and closureOf agree", () => {
  // The chosen rule: a soft sign-off closes nothing. closureOf already ignores it; the guard trigger now ignores it too, so a soft
  // sign-off never lets values expire sooner than an unsigned task would.
  it("values_expired refuses a task whose only sign-off is soft, even long after it", async () => {
    const t = await setup();
    try {
      await writeFile(t.file("a.txt"), "one\n");
      const id = await t.tasks.touch("c", t.file("a.txt"));
      soft(t.ledger, id, []);
      assert.equal(closureOf(t.ledger, id), undefined);
      assert.throws(() => t.ledger.expireValues(id, new Date(Date.now() + 400 * DAY)), /values expire only 30 days after a task closed/);
    } finally {
      await t.cleanup();
    }
  });

  it("an expiry closure still lets the values go 30 days later, soft sign-off or not", async () => {
    const t = await setup();
    try {
      await writeFile(t.file("a.txt"), "one\n");
      const id = await t.tasks.touch("c", t.file("a.txt"));
      soft(t.ledger, id, []);
      t.advance(8 * DAY);
      await t.tasks.sweep();
      t.advance(40 * DAY);
      await t.tasks.sweep();
      assert.ok(t.ledger.valuesExpiredAt(id));
    } finally {
      await t.cleanup();
    }
  });
});
