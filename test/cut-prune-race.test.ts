import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { signOffForTest } from "./helpers/signed-fixture.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";

// Resolves when the child prints its first stdout chunk ("held"); rejects if the child exits or errors
// first, or after timeoutMs, so a broken child fails the test instead of hanging the run.
function waitForHeld(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (fn: () => void) => { clearTimeout(timer); child.stdout!.off("data", onData); child.off("exit", onExit); child.off("error", onError); fn(); };
    const onData = () => done(resolve);
    const onExit = (code: number | null, signal: string | null) => done(() => reject(new Error(`lock child exited before printing "held" (code ${code}, signal ${signal})`)));
    const onError = (err: Error) => done(() => reject(err));
    const timer = setTimeout(() => done(() => reject(new Error(`lock child did not print "held" within ${timeoutMs}ms`))), timeoutMs);
    child.stdout!.once("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

/**
 * A reviewer cut reads the task's previous copy; a submit that records a round prunes that
 * copy. Two stores on one ledger stand in for the review process and the gateway. The hook fires
 * after the cut has chosen its previous copy and made its own new one, and lets the submit run
 * as far as it can before the cut goes on to read.
 */
describe("a reviewer cut and a submit on one task never race on a copy", () => {
  // The test "the submit's prune never removes the copy an in-flight cut still reads" is deleted with its reader: the round diff was the
  // only code that read the previous round's copy while a cut ran, and a cut now reads no copy.
  it("a sign-off's close-prune never removes the copy an in-flight cut still reads", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
    const ledger = openLedger(home);
    try {
      const file = path.join(folder, "a.txt");
      await writeFile(file, "one\ntwo\nthree\n");
      let armed = false;
      let signing: Promise<unknown> | undefined;
      let taskId = 0;
      const real = createFilesLayer();
      const hooked = {
        ...real,
        snapshot: async (...args: Parameters<typeof real.snapshot>) => {
          const mode = await real.snapshot(...args);
          if (armed && signing === undefined) {
            signing = signOffForTest(ledger, taskId, "Dana");
            await Promise.race([signing.catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
          }
          return mode;
        },
      };
      const reviewer = new TaskStore(ledger, home, [hooked]);
      taskId = await reviewer.touch("c", file);
      await writeFile(file, "one\nTWO\nthree\n");
      await reviewer.submit("c", "edit", false);
      for (const r of ledger.reviewRowsForTask(taskId)) ledger.recordDecision({ rowId: r.id, decision: "approve", note: "", reviewer: "Dana" });
      armed = true;
      await reviewer.cutReviewerRound(taskId);
      await signing;
      assert.equal(ledger.signoffsForTask(taskId).length, 1, "signed off");
      assert.notEqual(signing, undefined, "the hook ran the sign-off");
    } finally {
      ledger.close();
      await rm(home, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("a lock held by another OS process makes the cut wait, then proceed", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
    const ledger = openLedger(home);
    const lockPath = path.join(home, "locks", "task-1.lock");
    const lockModule = pathToFileURL(path.resolve("src/file-lock.ts")).href;
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `import { acquireFileLock } from ${JSON.stringify(lockModule)};
       const release = await acquireFileLock(${JSON.stringify(lockPath)});
       console.log("held");
       process.stdin.resume();
       process.stdin.on("end", async () => { await release(); process.exit(0); });`,
    ], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      const file = path.join(folder, "a.env");
      await writeFile(file, "one\ntwo\nthree\n");
      const tasks = new TaskStore(ledger, home, [createFilesLayer()]);
      const id = await tasks.touch("c", file);
      assert.equal(id, 1);
      await writeFile(file, "one\nTWO\nthree\n");
      await waitForHeld(child);

      let finished = false;
      const cutting = tasks.cutReviewerRound(id).then((r) => ((finished = true), r));
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(finished, false, "the cut waits while the other process holds the lock");
      assert.equal(ledger.roundsForTask(id).length, 0, "nothing recorded while it waits");

      const exited = new Promise((r) => child.once("exit", r));
      child.stdin.end();
      await exited;
      const cut = await cutting;
      assert.notEqual(cut, undefined, "the cut proceeds once the lock is released");
      assert.equal(ledger.roundsForTask(id).length, 1);
    } finally {
      child.kill();
      ledger.close();
      await rm(home, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    }
  });
});
