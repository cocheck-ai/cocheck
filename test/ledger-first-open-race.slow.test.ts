import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const LEDGER = path.join(import.meta.dirname, "..", "src", "ledger.ts");

/** Prints READY, waits for a start time on stdin, spins until it, then opens the ledger at `COCHECK_HOME`. */
const CHILD = `
const { openLedger } = await import(${JSON.stringify(LEDGER)});
process.stdout.write("READY\\n");
process.stdin.once("data", (d) => {
  const at = Number(String(d).trim());
  while (Date.now() < at) {}
  try {
    openLedger(process.env.COCHECK_HOME).close();
    process.stdout.write("OK\\n");
  } catch (e) {
    process.stdout.write("FAIL " + (e && e.message) + "\\n");
  }
});
`;

function child(home: string) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
    env: { ...process.env, COCHECK_HOME: home },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  const waiters: Array<() => void> = [];
  proc.stdout.on("data", (d) => {
    out += String(d);
    waiters.splice(0).forEach((w) => w());
  });
  const until = (re: RegExp) =>
    new Promise<string>((resolve) => {
      const check = () => {
        const m = re.exec(out);
        if (m) return resolve(m[0]);
        waiters.push(check);
      };
      check();
    });
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  return { proc, until, exited };
}

describe("two processes creating a fresh ledger at the same instant", () => {
  it("both succeed, 10 iterations, one pair at a time", async () => {
    for (let i = 0; i < 10; i++) {
      const home = await mkdtemp(path.join(tmpdir(), "cocheck-ledger-race-"));
      try {
        const pair = [child(home), child(home)];
        await Promise.all(pair.map((c) => c.until(/READY/)));
        const at = Date.now() + 150;
        for (const c of pair) c.proc.stdin.end(`${at}\n`);
        const results = await Promise.all(pair.map((c) => c.until(/(OK|FAIL[^\n]*)/)));
        await Promise.all(pair.map((c) => c.exited));
        assert.deepEqual(results, ["OK", "OK"], `iteration ${i}`);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  });
});
