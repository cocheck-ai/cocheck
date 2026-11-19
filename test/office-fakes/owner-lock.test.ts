// The Office owner lock (src/office/connector/shared/lock.ts) and owner (src/office/connector/shared/owner.ts), which the connector uses. These cases moved here
// from the supervisor test when the supervisor and broker it also covered were deleted.
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { FakeClock } from "./fake-clock.ts";
import { tempDirRemovedAtExit } from "../helpers/temp-dirs.ts";
import { OfficeOwner } from "../../src/office/connector/shared/owner.ts";
import { OwnerLock } from "../../src/office/connector/shared/lock.ts";

describe("owner lock: two processes", () => {
  const spawnChild = (path: string): { p: ChildProcess; say: (c: string) => Promise<string> } => {
    const p = spawn(process.execPath, [fileURLToPath(new URL("./lock-child.ts", import.meta.url)), path, "80"], { stdio: ["pipe", "pipe", "inherit"] }) as ChildProcess & { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream };
    let lines: string[] = []; let wake: (() => void) | null = null; let buf = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c: string) => { buf += c; const parts = buf.split("\n"); buf = parts.pop()!; lines.push(...parts); wake?.(); });
    const next = async (): Promise<string> => { while (lines.length === 0) await new Promise<void>((r) => { wake = r; }); return lines.shift()!; };
    return { p, say: async (c) => { if (c !== "") p.stdin.write(`${c}\n`); return next(); } };
  };
  it("exactly one owner; follower takes over after release; stale heartbeat from a killed owner is taken over", async () => {
    const path = join(tempDirRemovedAtExit("office-lock-"), "owner.lock");
    const a = spawnChild(path), b = spawnChild(path);
    try {
      assert.equal(await a.say(""), "ready"); assert.equal(await b.say(""), "ready");
      assert.equal(await a.say("try"), "owner");
      assert.equal(await b.say("try"), "follower");
      await new Promise((r) => setTimeout(r, 60)); // beats (15 ms) keep it fresh past staleMs (80)
      assert.equal(await b.say("try"), "follower");
      assert.equal(await a.say("release"), "released");
      assert.equal(await b.say("try"), "owner");
      // kill the owner without release: no beats, the lock goes stale
      b.p.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 100));
      const c = spawnChild(path);
      try { assert.equal(await c.say(""), "ready"); assert.equal(await c.say("try"), "owner"); } finally { c.p.kill("SIGKILL"); }
    } finally { a.p.kill("SIGKILL"); b.p.kill("SIGKILL"); }
  });
  it("heartbeat on the injectable clock keeps the lock; a stolen lock drops ownership", async () => {
    const path = join(tempDirRemovedAtExit("office-lock-"), "owner.lock");
    const c = new FakeClock();
    const o = new OfficeOwner({ path, clock: c, staleMs: 100, heartbeatMs: 30 });
    assert.equal(o.tryBecomeOwner(), true);
    await c.advance(500);
    assert.equal(o.isOwner(), true);
    assert.equal(OwnerLock.tryAcquire({ path, clock: c, staleMs: 100 }), null);
    o.release();
  });
  it("a throwing heartbeat gives up ownership instead of throwing from the timer", async () => {
    const path = join(tempDirRemovedAtExit("office-lock-"), "owner.lock");
    const c = new FakeClock();
    const o = new OfficeOwner({ path, clock: c, staleMs: 100, heartbeatMs: 30 });
    assert.equal(o.tryBecomeOwner(), true);
    (o as unknown as { lock: { heartbeat: () => boolean } }).lock.heartbeat = () => { throw new Error("EIO"); };
    await c.advance(100);
    assert.equal(o.isOwner(), false);
    o.release();
  });
});
