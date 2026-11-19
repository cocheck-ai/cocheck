// clause 5: the Mac driver's kill sends TERM or KILL as asked, and only to the process whose start time matches. The "Excel" here is a
// `sleep` this test starts itself (never a real Office app); the only process ever signalled is that child, by pid.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { macOfficeDriver, startedAt } from "../src/office/connector/office-macos.ts";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (child: ReturnType<typeof spawn>): Promise<boolean> => child.exitCode !== null || child.signalCode !== null || await new Promise<boolean>((res) => { const t = setTimeout(() => res(false), 3000); child.once("exit", () => { clearTimeout(t); res(true); }); });

describe("macOfficeDriver.kill", { skip: process.platform !== "darwin" ? "macOS only (ps lstart)" : false }, () => {
  process.env.COCHECK_ALLOW_REAL_OFFICE = "1"; // the guard exists for tests that reach Office; this one only signals its own sleep
  const make = async () => {
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    const d = macOfficeDriver();
    const started = await startedAt(child.pid!);
    assert.ok(started !== null);
    return { child, d, started: started! };
  };
  it("a start time that does not match leaves the process alone (a reused pid is someone else's), under any TZ", async () => {
    const { child, d, started } = await make();
    try {
      d.kill(child.pid!, "KILL", started - 3_600_000);
      d.kill(child.pid!, "TERM", started + 5_000);
      assert.ok(alive(child.pid!), "not signalled");
      const tz = process.env.TZ;
      process.env.TZ = "Pacific/Auckland";
      try { d.kill(child.pid!, "KILL", started - 60_000); } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
      assert.ok(alive(child.pid!), "not signalled under another TZ either");
    } finally { child.kill("SIGKILL"); await waitDead(child); }
  });
  it("TERM with the right start time ends it by SIGTERM (not SIGKILL)", async () => {
    const { child, d, started } = await make();
    try {
      d.kill(child.pid!, "TERM", started);
      assert.ok(await waitDead(child));
      assert.equal(child.signalCode, "SIGTERM");
    } finally { child.kill("SIGKILL"); }
  });
  it("KILL (the default) with the right start time ends it by SIGKILL; without a start time it still signals", async () => {
    const a = await make();
    try { a.d.kill(a.child.pid!, "KILL", a.started); assert.ok(await waitDead(a.child)); assert.equal(a.child.signalCode, "SIGKILL"); } finally { a.child.kill("SIGKILL"); }
    const b = await make();
    try { b.d.kill(b.child.pid!); assert.ok(await waitDead(b.child)); assert.equal(b.child.signalCode, "SIGKILL"); } finally { b.child.kill("SIGKILL"); }
  });
});
