// the REAL powershell.exe host, Windows only (skipped elsewhere). Runs on the GitHub windows-latest
// runner (Windows PowerShell 5.1 at its System32 path, no Office installed). No Office is started: only the hello, selftest, windows and exit ops.
// Guard opt-out, and only here: WinHost guards (mac-guard.ts `guard()`) when no `command` is given; these tests pass the real host command
// (`hostCommand(script)`) explicitly, which is the one path the guard lets through. The default path stays guarded (office-win-stop and office-win-host).
// Hard caps: every test 60 s at most; each host is closed in `finally`, and the after() hook ends any child this file spawned (by its own handle,
// endChild) so no powershell.exe outlives the file. The runner's per-file kill (150 s) is the last backstop.
// The Guards against: a test hanging or leaving a powershell.exe behind (the caps and cleanup above) vs a test passing without ever starting the
// real PowerShell (every host test asserts a real pid of a powershell.exe child and the FullLanguage answer).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { HOST_SCRIPT, WinHost, hostCommand, powershellPath } from "../src/office/connector/office-win.ts";
import { endChild } from "../src/platform/index.ts";

const WIN = process.platform === "win32";
const CAP = { timeout: 60_000 };
const children = new Set<ChildProcess>();

after(() => {
  for (const c of children) endChild(c);
});

/** A spawn that records each child (for the after() cleanup and the EOF case) and may set the child's environment. */
function recordingSpawn(env?: NodeJS.ProcessEnv, sink?: (c: ChildProcess) => void): typeof spawn {
  return ((command: string, args: string[], options: Record<string, unknown>) => {
    const c = spawn(command, args, { ...options, ...(env ? { env } : {}) });
    children.add(c);
    sink?.(c);
    return c;
  }) as unknown as typeof spawn;
}

/** The real host, started from `script` (default the shipped .ps1), its stdout also collected. */
function realHost(o: { script?: string; env?: NodeJS.ProcessEnv } = {}): { host: WinHost; child: () => ChildProcess | undefined; stdout: () => string } {
  let child: ChildProcess | undefined;
  let out = "";
  const host = new WinHost({
    command: hostCommand(o.script ?? HOST_SCRIPT),
    spawnFn: recordingSpawn(o.env, (c) => {
      child = c;
      c.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    }),
  });
  return { host, child: () => child, stdout: () => out };
}

/** Runs powershell.exe to its end (stdin closed), capped; the child is ended by its handle if the cap is hit. */
function runPs(args: string[], env: NodeJS.ProcessEnv = process.env, capMs = 30_000): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const c = spawn(powershellPath(), args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.add(c);
    let out = "";
    c.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    c.stderr?.resume();
    const t = setTimeout(() => endChild(c), capMs);
    c.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout: out });
    });
  });
}

const exitedWithin = (c: ChildProcess, ms: number): Promise<boolean> =>
  c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve(true)
    : new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), ms);
        c.once("exit", () => {
          clearTimeout(t);
          resolve(true);
        });
      });

/** A real host answered: a powershell.exe child with a pid, and hello in FullLanguage with a version. */
async function assertRealHello(h: ReturnType<typeof realHost>): Promise<void> {
  const r = await h.host.hello(30_000);
  assert.equal(r.ok, true, `hello failed: ${JSON.stringify(r)}`);
  assert.equal(r.ok && r.mode, "FullLanguage");
  assert.match(r.ok ? r.version : "", /^\d+\.\d+/);
  const pid = h.host.pid;
  assert.ok(typeof pid === "number" && pid > 0, "a real pid");
  assert.equal(h.child()?.spawnfile, powershellPath(), "the System32 powershell.exe itself");
}

describe("the real powershell.exe host (Windows only)", { skip: !WIN && "Windows only: needs the real powershell.exe" }, () => {
  it("hello answers FullLanguage and a version under a hostile profile (junk on stdout, then a throw): -NoProfile keeps it out", CAP, async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), "cocheck-profile-"));
    const marker = path.join(home, "profile-ran.txt");
    const env = { ...process.env, USERPROFILE: home, HOME: home };
    const junk = `Write-Output 'PROFILE-JUNK'\n[Console]::Out.WriteLine('PROFILE-JUNK')\nSet-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value ran\nthrow 'the profile threw'\n`;
    mkdirSync(path.join(home, "Documents", "WindowsPowerShell"), { recursive: true });
    writeFileSync(path.join(home, "Documents", "WindowsPowerShell", "profile.ps1"), junk);
    // Where this environment's PowerShell looks for the current user's profile; when it lies under the temp home, a control run without -NoProfile
    // proves the junk profile is live there.
    const where = await runPs(["-NoProfile", "-NonInteractive", "-Command", "$PROFILE.CurrentUserAllHosts"], env);
    const profilePath = where.stdout.trim();
    const redirected = profilePath.toLowerCase().startsWith(home.toLowerCase());
    if (redirected) {
      if (!existsSync(profilePath)) {
        mkdirSync(path.dirname(profilePath), { recursive: true });
        writeFileSync(profilePath, junk);
      }
      const control = await runPs(["-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "exit 0"], env);
      assert.match(control.stdout, /PROFILE-JUNK/, "control: without -NoProfile the junk profile runs");
      assert.ok(existsSync(marker), "control: the profile wrote its marker");
      writeFileSync(marker, ""); // reset (no deletes): the host run must leave it empty
    } else {
      t.diagnostic(`declared limit: this PowerShell reads the profile at ${profilePath}, not under the temp USERPROFILE; no control run`);
    }
    const h = realHost({ env });
    try {
      await assertRealHello(h);
      assert.doesNotMatch(h.stdout(), /PROFILE-JUNK/, "no profile output on the host's stdout");
      const ran = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
      assert.equal(ran, "", "the profile never ran in the host");
    } finally {
      await h.host.close();
    }
  });

  it("selftest answers retried 1, and a non-ASCII text round-trips through a request", CAP, async () => {
    const h = realHost();
    try {
      await assertRealHello(h);
      const text = "Zürich, São Paulo, Kraków, 東京, Ελλάδα, ✓";
      const r = await h.host.call("selftest", { text }, 30_000);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.retried, 1);
      assert.equal(r.got, "answered");
      assert.equal(r.text, text);
    } finally {
      await h.host.close();
    }
  });

  it("the host started from a script copy under a path with a space, a non-ASCII name and an apostrophe answers hello", CAP, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cocheck-path-"));
    const dir = path.join(root, "with space", "Zürich 東京", "O'Neil");
    mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "office-win.ps1");
    copyFileSync(HOST_SCRIPT, script);
    const h = realHost({ script });
    try {
      await assertRealHello(h);
    } finally {
      await h.host.close();
    }
  });

  it("EOF on stdin ends the host within 5 s", CAP, async () => {
    const h = realHost();
    try {
      await assertRealHello(h);
      const c = h.child()!;
      c.stdin!.end();
      assert.ok(await exitedWithin(c, 5_000), "the host left on EOF");
    } finally {
      await h.host.close();
    }
  });

  it("close() ends the host", CAP, async () => {
    const h = realHost();
    try {
      await assertRealHello(h);
      const c = h.child()!;
      await h.host.close();
      assert.ok(await exitedWithin(c, 5_000), "the host is gone after close()");
      assert.equal(h.host.pid, undefined);
    } finally {
      await h.host.close();
    }
  });

  it("the windows op on the host's own pid answers ok:true with a windows array (UI Automation loads by assembly name, no Add-Type)", CAP, async () => {
    const h = realHost();
    try {
      await assertRealHello(h);
      const r = await h.host.call("windows", { pid: h.host.pid }, 30_000);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(Array.isArray(r.windows), `windows is an array: ${JSON.stringify(r)}`);
    } finally {
      await h.host.close();
    }
  });

  it("the loader's restricted line: under ConstrainedLanguage set in-process, the real loader answers restricted and exits", CAP, async (t) => {
    const set = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'";
    const probe = await runPs(["-NoProfile", "-NonInteractive", "-Command", `${set}; [string]$ExecutionContext.SessionState.LanguageMode`]);
    if (probe.stdout.trim() !== "ConstrainedLanguage") {
      t.skip(`declared limit: PowerShell did not allow setting ConstrainedLanguage in-process (it answered ${JSON.stringify(probe.stdout.trim())})`);
      return;
    }
    const args = hostCommand().args;
    const loader = args[args.length - 1]!;
    const r = await runPs([...args.slice(0, -1), `${set}; ${loader}`]);
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ id: null, ok: false, why: "restricted", mode: "ConstrainedLanguage" }]);
    assert.equal(r.code, 0);
  });
});

