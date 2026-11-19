// ScreenHelper (src/office/connector/screen-macos.ts) against a fake helper script. It never reaches the real helper: the default binary sits behind
// the Office bridge's test guard. The real helper's own contract is test/screen-helper-macos-real-exit.test.ts.
import { posixOnly } from "./helpers/platform.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { ScreenHelper } from "../src/office/connector/screen-macos.ts";

const FAKE = path.join(import.meta.dirname, "fixtures", "fake-screen-helper.mjs");
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withMode<T>(mode: string, f: () => Promise<T>): Promise<T> {
  const saved = process.env.FAKE_MODE;
  process.env.FAKE_MODE = mode;
  try { return await f(); } finally { if (saved === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = saved; }
}

describe("ScreenHelper (windows and close only)", () => {
  it("the default binary is behind the test guard: no test reaches the real helper", async () => {
    await assert.rejects(() => ScreenHelper.start({ maxMs: 5000 }), /real Office bridge/);
  });

  it("carries windows and close, and has no other command (no capture, display, show, hide or guard)", posixOnly("the fake helper is an executable script started through its shebang"), async () => {
    const h = (await ScreenHelper.start({ binary: FAKE, maxMs: 60_000 }))!;
    assert.ok(h);
    const w = await h.windows(123);
    assert.ok(w.ok && w.windows[0]!.onscreen === false);
    for (const gone of ["perm", "requestScreenAccess", "display", "where", "show", "hide", "hidden", "capture", "guardPid"]) assert.equal((h as unknown as Record<string, unknown>)[gone], undefined, gone);
    await h.close();
    assert.equal(h.alive, false);
    assert.equal(h.exitedWith, 0);
  });

  it("a request with no answer times out, and the next request still works", posixOnly("the fake helper is an executable script started through its shebang"), async () => {
    await withMode("hang", async () => {
      const h = (await ScreenHelper.start({ binary: FAKE, maxMs: 60_000, timeoutsMs: { windows: 300 } }))!;
      const t0 = Date.now();
      const c = await h.windows(1);
      assert.ok(!c.ok && /in time/.test(c.why));
      assert.ok(Date.now() - t0 < 2000);
      assert.equal((await h.request("close")).ok, true);
      await h.close();
    });
  });

  it("a helper that dies mid-request answers the request and every later one as ended", posixOnly("the fake helper is an executable script started through its shebang"), async () => {
    await withMode("die", async () => {
      const h = (await ScreenHelper.start({ binary: FAKE, maxMs: 60_000 }))!;
      const a = await h.windows(1);
      assert.ok(!a.ok && /ended/.test(a.why));
      assert.equal(h.alive, false);
      const b = await h.windows(1);
      assert.ok(!b.ok && /ended/.test(b.why));
      await h.close();
    });
  });

  it("a helper that never says ready is given up on", async () => {
    await withMode("silent", async () => {
      assert.equal(await ScreenHelper.start({ binary: FAKE, maxMs: 60_000, startMs: 400 }), null);
    });
  });

  it("a program that cannot be started is null, not a throw", async () => {
    assert.equal(await ScreenHelper.start({ binary: "/nonexistent/cocheck-screen", maxMs: 60_000, startMs: 400 }), null);
  });

  it("junk lines from the helper are ignored", posixOnly("the fake helper is an executable script started through its shebang"), async () => {
    await withMode("garbage", async () => {
      const h = (await ScreenHelper.start({ binary: FAKE, maxMs: 60_000 }))!;
      assert.equal((await h.windows(1)).ok, true);
      await h.close();
    });
  });

  it("kill() ends the helper", posixOnly("the fake helper is an executable script started through its shebang"), async () => {
    const h = (await ScreenHelper.start({ binary: FAKE, maxMs: 60_000 }))!;
    h.kill();
    for (let i = 0; i < 40 && h.alive; i++) await sleepMs(50);
    assert.equal(h.alive, false);
  });
});
