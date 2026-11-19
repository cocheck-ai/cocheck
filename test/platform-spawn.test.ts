// The platform launch rules, pinned on every OS by naming the OS and faking the file system: bare names through PATH (PATHEXT on Windows),
// relative paths from the connector's folder, and .cmd/.bat through `cmd.exe /d /s /c` with every argument escaped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeCmdArgument, mergeEnv, planSpawn, resolveProgram } from "../src/platform/index.ts";

const has = (...files: string[]) => (f: string) => files.includes(f);

test("posix: a bare name is searched through PATH in order, a relative path resolves from the folder", () => {
  const env = { PATH: "/a/bin:/b/bin" };
  assert.equal(resolveProgram("tool", { os: "linux", env, cwd: "/w", isRunnable: has("/b/bin/tool", "/a/bin/tool") }), "/a/bin/tool");
  assert.equal(resolveProgram("tool", { os: "darwin", env, cwd: "/w", isRunnable: has("/b/bin/tool") }), "/b/bin/tool");
  assert.equal(resolveProgram("tool", { os: "linux", env, cwd: "/w", isRunnable: has() }), undefined);
  assert.equal(resolveProgram("./sub/tool", { os: "linux", env, cwd: "/w", isRunnable: has("/w/sub/tool") }), "/w/sub/tool");
  assert.throws(() => planSpawn(["nothing-here"], { os: "linux", env, cwd: "/w", isRunnable: has() }), /nothing-here/);
});

test("win32: a bare name tries each PATHEXT extension in each PATH folder, PATH and PATHEXT read case-insensitively", () => {
  const env = { Path: "C:\\bin;C:\\tools", pathext: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(resolveProgram("cocheck-standin", { os: "win32", env, cwd: "C:\\w", isRunnable: has("C:\\tools\\cocheck-standin.CMD") }), "C:\\tools\\cocheck-standin.CMD");
  assert.equal(resolveProgram("node", { os: "win32", env, cwd: "C:\\w", isRunnable: has("C:\\bin\\node.EXE", "C:\\tools\\node.CMD") }), "C:\\bin\\node.EXE");
  assert.equal(resolveProgram("node.exe", { os: "win32", env, cwd: "C:\\w", isRunnable: has("C:\\bin\\node.exe") }), "C:\\bin\\node.exe");
  assert.equal(resolveProgram("sub\\tool", { os: "win32", env, cwd: "C:\\w", isRunnable: has("C:\\w\\sub\\tool.EXE") }), "C:\\w\\sub\\tool.EXE");
  assert.equal(resolveProgram("none", { os: "win32", env, cwd: "C:\\w", isRunnable: has() }), undefined);
});

test("win32: an .exe is spawned directly, with the argument array untouched and no shell", () => {
  const plan = planSpawn(["node", "a b", 'say "hi"'], { os: "win32", env: { PATH: "C:\\bin" }, cwd: "C:\\w", isRunnable: has("C:\\bin\\node.EXE") });
  assert.deepEqual(plan, { command: "C:\\bin\\node.EXE", args: ["a b", 'say "hi"'], verbatim: false });
});

test("win32: a .cmd or .bat runs through cmd.exe /d /s /c with every argument quoted and every cmd metacharacter caret-escaped", () => {
  const env = { PATH: "C:\\bin", COMSPEC: "C:\\Windows\\System32\\cmd.exe" };
  const plan = planSpawn(["standin", "with space", "x&calc", "%PATH%", 'q"uote', "tail\\"], { os: "win32", env, cwd: "C:\\w", isRunnable: has("C:\\bin\\standin.CMD") });
  assert.equal(plan.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(plan.verbatim, true);
  assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(
    plan.args[3],
    '"^"C:\\bin\\standin.CMD^" ^"with^ space^" ^"x^&calc^" ^"^%PATH^%^" ^"q\\^"uote^" ^"tail\\\\^""',
  );
  assert.equal(planSpawn([".\\run.bat"], { os: "win32", env, cwd: "C:\\w", isRunnable: has("C:\\w\\run.bat") }).command, "C:\\Windows\\System32\\cmd.exe");
});

test("win32: escaping leaves no bare metacharacter and refuses a newline", () => {
  const meta = escapeCmdArgument('a&b|c<d>e^f(g)h!i"j,k;l');
  assert.equal(/(?<!\^)[&|<>()!"]/.test(meta.replace(/\^\^/g, "")), false, meta);
  assert.throws(() => escapeCmdArgument("a\nb"), /newline/);
});

test("win32: a caller's PATH replaces the inherited Path (names are case-insensitive), so the child and the program lookup both see it", () => {
  const inherited = { Path: "C:\\Windows", SystemRoot: "C:\\Windows", pathext: ".EXE" };
  const env = mergeEnv(inherited, { PATH: "C:\\kit", PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32");
  assert.deepEqual(env, { SystemRoot: "C:\\Windows", PATH: "C:\\kit", PATHEXT: ".COM;.EXE;.BAT;.CMD" });
  assert.equal(resolveProgram("cocheck-standin", { os: "win32", env, cwd: "C:\\w", isRunnable: has("C:\\kit\\cocheck-standin.CMD") }), "C:\\kit\\cocheck-standin.CMD");
});

test("posix: env names are case-sensitive, so Path and PATH stay two variables", () => {
  assert.deepEqual(mergeEnv({ Path: "/x", PATH: "/a", HOME: "/h" }, { PATH: "/b" }, "linux"), { Path: "/x", PATH: "/b", HOME: "/h" });
});
