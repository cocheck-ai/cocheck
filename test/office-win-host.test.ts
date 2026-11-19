// the PowerShell host transport. Node talks to one long-lived powershell.exe over JSON
// lines (request {id, op, args}; reply {id, ok:true, ...} or {id, ok:false, why}). Every case here runs on every OS against a fake host
// (test/fixtures/office-win/fake-host.mjs, a node script speaking the same protocol); no PowerShell and no Office is ever started.
// The Guards against: the host attaching to the person's own Office (no GetActiveObject anywhere: the grep case below) vs a host
// left running after the job (the EOF case, the process-exit case and the close/closeSync cases below end it).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { OFFICE_APPS } from "../src/office/connector/apps.ts";
import { officePdfs } from "../src/office/connector/office-job.ts";
import { HOST_SCRIPT, RESTRICTED_WHY, WinHost, hostCommand, powershellPath, winOfficeDriver } from "../src/office/connector/office-win.ts";
import { fakeDriver } from "./helpers/office-fake.ts";

const ROOT = path.join(import.meta.dirname, "..");
const FAKE = path.join(import.meta.dirname, "fixtures", "office-win", "fake-host.mjs");
const PARENT = path.join(import.meta.dirname, "fixtures", "office-win", "parent.mjs");
const fake = (mode = "full", marker?: string): WinHost => new WinHost({ command: { command: process.execPath, args: [FAKE, mode, ...(marker ? [marker] : [])] } });
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const goneWithin = async (pid: number, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
};

describe("the Windows Office host transport", () => {
  it("hello answers the PowerShell version and FullLanguage", async () => {
    const h = fake();
    try {
      const r = await h.hello(5_000);
      assert.deepEqual(r, { ok: true, version: "5.1.19041.4648", mode: "FullLanguage" });
    } finally {
      await h.close();
    }
  });

  it("a host in ConstrainedLanguage is answered as restricted, in plain words", async () => {
    const h = fake("constrained");
    try {
      const r = await h.hello(5_000);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.why, RESTRICTED_WHY);
      assert.equal(RESTRICTED_WHY, "PowerShell is restricted by policy");
    } finally {
      await h.close();
    }
  });

  it("the loader's own restricted line (before the .ps1 can load) is answered as restricted too", async () => {
    const h = fake("bootstrap-restricted");
    try {
      const r = await h.hello(5_000);
      assert.deepEqual(r, { ok: false, why: RESTRICTED_WHY });
    } finally {
      await h.close();
    }
  });

  it("a timeout answers only that call: the others on the same host still succeed, and a late reply is dropped", async () => {
    const h = fake();
    try {
      const [hung, late, a, b] = await Promise.all([h.call("hang", {}, 200), h.call("late", { ms: 400 }, 150), h.call("echo", { text: "one" }, 5_000), h.call("echo", { text: "two" }, 5_000)]);
      assert.deepEqual(hung, { ok: false, why: "the PowerShell host did not answer hang in 200 ms" });
      assert.deepEqual(late, { ok: false, why: "the PowerShell host did not answer late in 150 ms" });
      assert.deepEqual(a, { ok: true, back: "one" });
      assert.deepEqual(b, { ok: true, back: "two" });
      await new Promise((r) => setTimeout(r, 400)); // the late reply arrives now and must not answer anything
      assert.deepEqual(await h.call("echo", { text: "after" }, 5_000), { ok: true, back: "after" });
      assert.deepEqual(await h.selftest(5_000), { ok: true, retried: 1, text: "Größe 東京" }, "non-ASCII survives the round trip");
    } finally {
      await h.close();
    }
  });

  it("the host exits on stdin EOF when its client dies without a word", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    const marker = path.join(dir, "eof");
    const parent = spawn(process.execPath, [PARENT, "wait", "full", marker], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
    const first = await new Promise<string>((resolve) => parent.stdout.once("data", (d: Buffer) => resolve(d.toString())));
    const { pid, hello } = JSON.parse(first) as { pid: number; hello: { ok: boolean } };
    assert.equal(hello.ok, true);
    assert.ok(alive(pid));
    parent.kill("SIGKILL"); // our own child, by its handle
    try {
      assert.ok(await goneWithin(pid, 5_000), "the host outlived its killed client");
      assert.ok(existsSync(marker) && readFileSync(marker, "utf8") === "eof", "the host left through its EOF path");
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL"); // a host this test started, if the assertion failed
    }
  });

  it("process exit stops a host that would ignore EOF (the program's exit hook calls closeSync, which stops our pid)", async () => {
    const parent = spawn(process.execPath, [PARENT, "exit", "stubborn"], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    parent.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const code = await new Promise<number | null>((resolve) => parent.on("exit", resolve));
    const { pid } = JSON.parse(out.trim()) as { pid: number };
    try {
      assert.equal(code, 0);
      assert.ok(await goneWithin(pid, 5_000), "a host was left running after the client exited");
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("close() asks the host to exit and the process is gone; closeSync() stops a host that ignores EOF", async () => {
    const h = fake();
    assert.equal((await h.hello(5_000)).ok, true);
    const pid = h.pid!;
    await h.close();
    assert.ok(!alive(pid), "close() left the host running");
    assert.equal(h.pid, undefined);
    await h.close(); // a second close is a no-op

    const stubborn = fake("stubborn");
    assert.equal((await stubborn.hello(5_000)).ok, true);
    const spid = stubborn.pid!;
    stubborn.closeSync();
    assert.ok(await goneWithin(spid, 5_000), "closeSync() left the host running");
    stubborn.closeSync(); // a second closeSync is a no-op
  });

  it("close() on a host that ignores the exit request still ends it, through the one stop function", async () => {
    const stopped: number[] = [];
    const h = new WinHost({ command: { command: process.execPath, args: [FAKE, "stubborn"] }, exitWaitMs: 200, stop: (pid) => { stopped.push(pid); process.kill(pid, "SIGKILL"); } });
    assert.equal((await h.hello(5_000)).ok, true);
    const pid = h.pid!;
    await h.close(); // the stubborn fake answers `exit` but stays, and ignores EOF
    assert.deepEqual(stopped, [pid]);
    assert.ok(await goneWithin(pid, 5_000));
  });

  it("guard: under the test bootstrap the real powershell.exe is never spawned", async () => {
    assert.equal(process.env.COCHECK_TEST_NO_OFFICE, "1");
    let spawned = 0;
    const h = new WinHost({ spawnFn: ((..._a: unknown[]) => { spawned++; throw new Error("spawned"); }) as never });
    await assert.rejects(h.hello(1_000), /test reached the real Office bridge/);
    assert.equal(spawned, 0);
    h.closeSync();
  });

  it("the real host command: full System32 path, the fixed flags, the .ps1 loaded as a scriptblock from its file", () => {
    const env = { SystemRoot: "C:\\Windows" };
    assert.equal(powershellPath(env), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    const c = hostCommand("C:\\Program Files\\CoCheck's\\office-win.ps1", env);
    assert.equal(c.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(c.args.slice(0, 7), ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-Command", c.args[6]]);
    assert.equal(c.args.length, 7);
    assert.ok(!c.args.some((a) => /EncodedCommand/i.test(a)));
    assert.match(c.args[6]!, /\[scriptblock\]::Create\(\[IO\.File\]::ReadAllText\('C:\\Program Files\\CoCheck''s\\office-win\.ps1'/);
    assert.match(c.args[6]!, /LanguageMode/, "the loader checks the language mode before it reads the .ps1");
    assert.equal(path.basename(HOST_SCRIPT), "office-win.ps1");
    assert.ok(existsSync(HOST_SCRIPT), "the .ps1 sits beside the module");
  });

  it("the .ps1: hello, selftest and exit in the op table, EOF ends the loop, a 2 s busy retry, UTF-8 streams", () => {
    const ps = readFileSync(HOST_SCRIPT, "utf8");
    for (const op of ["hello", "selftest", "exit"]) assert.match(ps, new RegExp(`^\\s*${op}\\s*=\\s*\\{`, "m"), `op ${op}`);
    assert.match(ps, /\$null -eq \$line\) \{ break \}/, "EOF (ReadLine null) ends the host");
    assert.match(ps, /function Invoke-Busy/);
    assert.match(ps, /\$Ms = 2000/);
    assert.match(ps, /-2147418111/, "RPC_E_CALL_REJECTED");
    assert.match(ps, /-2147417846/, "RPC_E_SERVERCALL_RETRYLATER");
    assert.match(ps, /UTF8Encoding/);
  });

  it("the host never attaches to the person's Office: no GetActiveObject, no Add-Type, no EncodedCommand in any Windows Office file", () => {
    const dir = path.join(ROOT, "src", "office", "connector");
    const files = readdirSync(dir).filter((f) => /win/i.test(f) && /\.(ts|ps1)$/.test(f));
    assert.ok(files.includes("office-win.ps1") && files.includes("office-win.ts"));
    for (const f of files) {
      const text = readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|#|\*|\/\*\*)/.test(l)).join("\n");
      assert.doesNotMatch(text, /GetActiveObject/i, f);
      assert.doesNotMatch(text, /Add-Type/i, f);
      assert.doesNotMatch(text, /-EncodedCommand/i, f);
      assert.doesNotMatch(text, /taskkill/i, f);
    }
  });

  it("winOfficeDriver: a partial driver whose close/closeSync end its host", async () => {
    const d = winOfficeDriver({ command: { command: process.execPath, args: [FAKE, "full"] } });
    assert.equal((await d.host.hello(5_000)).ok, true);
    const pid = d.host.pid!;
    await d.close();
    assert.ok(!alive(pid));
  });

  it("officePdfs calls the driver's close at job end, once, whatever the outcome", async () => {
    for (const running of [false, true]) {
      const f = fakeDriver({ running });
      let closed = 0;
      f.driver.close = async () => void closed++;
      await officePdfs(OFFICE_APPS.word, [{ side: "after", file: fileURLToPath(import.meta.url), name: "a.docx" }], { driver: f.driver, lockPath: path.join(f.stageRoot, "lock"), deadline: Date.now() + 10_000, pollMs: 5, goneWaitMs: 100 });
      assert.equal(closed, 1, running ? "the person's app was open (pending)" : "a drawn job");
    }
  });
});
