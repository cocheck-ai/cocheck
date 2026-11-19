// No preload env on Windows. The per-call tag is not available there, so the SessionStart env lines must not point a session's node
// (NODE_OPTIONS), python (PYTHONPATH) or `cocheck` at the guards. On a v0.1.20 install node died with "Cannot find module
// 'C:UsersAnaCoCheckDataattributionhookscocheck-preload.cjs'" once the env file was sourced.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runHook } from "../src/hook-cli.ts";
import { onDir, prepareSession, sessionEnvLines } from "../src/attribution/tag.ts";
import { platformFor } from "../src/platform/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = (name: string): string => mkdtempSync(path.join(tmpdir(), `cocheck-${name}-`));

/** Git Bash, by its install path first (a bare `bash` on a Windows runner can be WSL's). */
function gitBash(): string | undefined {
  for (const p of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]) if (existsSync(p)) return p;
  return undefined;
}

describe("session env lines by shell dialect", () => {
  it("a cmd platform sets no NODE_OPTIONS, no PYTHONPATH and no ps-based call tag (a preload node cannot load)", () => {
    const home = scratch("lines");
    for (const lines of [sessionEnvLines(home, "s1", platformFor("win32").shellDialect.kind), prepareSession(home, "s1", [home], Date.now(), undefined, platformFor("win32").shellDialect.kind)]) {
      assert.ok(!/NODE_OPTIONS|PYTHONPATH|\bps\b|COCHECK_WRITE_CALL/.test(lines), lines);
    }
  });

  it("a posix platform keeps all four lines (macOS output unchanged)", () => {
    const lines = sessionEnvLines(scratch("posix"), "s1", platformFor("darwin").shellDialect.kind);
    assert.ok(lines.includes("NODE_OPTIONS") && lines.includes("PYTHONPATH") && lines.includes("/bin/ps"), lines);
    assert.equal(lines.split("\n").length, 5);
  });

  it("windows: the real hook writes no preload env, and node runs after the file is sourced", async (t) => {
    if (process.platform !== "win32") return t.skip("Windows only");
    const bash = gitBash();
    assert.ok(bash !== undefined, "Git Bash is on the Windows runner");
    const home = scratch("home");
    const folder = scratch("folder");
    const envFile = path.join(home, "session-env.sh");
    const payload = { session_id: "s1", cwd: folder, hook_event_name: "SessionStart", source: "startup" };
    const res = await runHook({
      argv: ["node", "hook.ts", "--host", "claude", "--folder", folder],
      env: { COCHECK_HOME: home, CLAUDE_ENV_FILE: envFile },
      stdin: (async function* () {
        yield Buffer.from(JSON.stringify(payload));
      })(),
    });
    assert.equal(res.exitCode, 0, res.stderr);
    // The session switched on, as a tracked session is.
    mkdirSync(onDir(home), { recursive: true });
    writeFileSync(path.join(onDir(home), "s1"), "");
    assert.ok(existsSync(envFile), "the hook wrote the env file");
    // The default platform decides here (no injected dialect). That failure itself (Claude Code halving the backslashes of the guard path) is proven
    // on a real Windows machine, not here: plain Git Bash unescapes them fine on CI.
    const written = readFileSync(envFile, "utf8");
    assert.ok(!/NODE_OPTIONS|PYTHONPATH|\bps\b/.test(written), `env file:\n${written}`);
    const env: NodeJS.ProcessEnv = { ...process.env, COCHECK_HOME: home };
    delete env.NODE_OPTIONS;
    const toBash = (p: string): string => p.replace(/\\/g, "/");
    for (const cmd of ["node -e 0"]) {
      const r: { status: number | null; stderr: string } = spawnSync(bash as string, ["-c", `. "${toBash(envFile)}"; ${cmd}`], { env, encoding: "utf8" });
      assert.equal(r.status, 0, `${cmd}\n${r.stderr}\nenv file:\n${written}`);
    }
  });
});
