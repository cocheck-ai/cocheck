// Preloaded by `npm test` (`node --import`): gives the whole run a fresh temp COCHECK_HOME when none is
// set, so no test can reach the real ~/.cocheck. Test child processes inherit the variable; only the
// process that created the directory removes it.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { scrubRecorderEnv } from "./lib/recorder-env.ts";

// A temp folder this process made is removed when it exits. On Windows a process a test left running can still hold a file in it (EBUSY); that
// must not turn the exit into a crash, so it is reported and left for the OS temp cleanup.
function removeAtExit(dir: string): void {
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`test bootstrap: could not remove ${dir}: ${(error as Error).message}`);
    }
  });
}

if (!process.env.COCHECK_HOME) {
  const home = mkdtempSync(path.join(tmpdir(), "cocheck-test-home-"));
  process.env.COCHECK_HOME = home;
  removeAtExit(home);
}

// Same for Claude Code's transcripts: `defaultTranscriptsRoot` reads `$CLAUDE_CONFIG_DIR/projects`, so the run gets an empty
// temp config dir (an explicit value is kept, unless it resolves to the real ~/.claude) and no test can reach the real ~/.claude/projects.
if (!process.env.CLAUDE_CONFIG_DIR || path.resolve(process.env.CLAUDE_CONFIG_DIR) === path.join(homedir(), ".claude")) {
  const dir = mkdtempSync(path.join(tmpdir(), "cocheck-test-claude-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  removeAtExit(dir);
}

// Tests never drive the real Microsoft Excel or PowerPoint. `runAppleScript` refuses under this variable;
// the PATH shim below makes a direct `osascript` spawn (any code path) fail too. Child processes inherit
// both. `COCHECK_ALLOW_REAL_OFFICE=1` is the one explicit opt-in (no unit test sets it).
if (!process.env.COCHECK_TEST_NO_OFFICE) {
  process.env.COCHECK_TEST_NO_OFFICE = "1";
  if (process.env.COCHECK_ALLOW_REAL_OFFICE !== "1") {
    const shimDir = mkdtempSync(path.join(tmpdir(), "cocheck-test-shim-"));
    const shim = path.join(shimDir, "osascript");
    writeFileSync(shim, '#!/bin/sh\necho "test reached the real Office bridge (osascript blocked by the test bootstrap)" >&2\nexit 1\n');
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`;
    removeAtExit(shimDir);
  }
}

// Encryption at rest keeps its key in the macOS Keychain through `security`. Tests never reach the real one: `seal.ts` refuses to
// spawn it under the test runner unless COCHECK_SECURITY_BIN names a stand-in, and this is that stand-in: a shell script keeping each
// account's key in a file of a temp folder (find-generic-password -w, add-generic-password -w <value>; exit 44 not found, 45 duplicate).
// Child processes inherit both variables. Unit tests of the seal itself inject a key provider instead and never run this.
if (!process.env.COCHECK_SECURITY_BIN) {
  const dir = mkdtempSync(path.join(tmpdir(), "cocheck-test-keychain-"));
  const bin = path.join(dir, "security");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      // `security -i` reads one command line from stdin (the way set() keeps the value out of argv); the line is re-split with eval, test-only.
      '[ -n "$COCHECK_SECURITY_ARGV_LOG" ] && echo "$*" >> "$COCHECK_SECURITY_ARGV_LOG"',
      'store="$(dirname "$0")/items"; mkdir -p "$store"',
      'if [ "$1" = "-i" ]; then read -r line; eval "set -- $line"; fi',
      'cmd="$1"; shift; account=""; service=""; value=""; update=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -a) account="$2"; shift ;;',
      '    -s) service="$2"; shift ;;',
      "    -U) update=1 ;;",
      '    -w) if [ "$cmd" = add-generic-password ]; then value="$2"; shift; fi ;;',
      "  esac",
      "  shift",
      "done",
      // One file per service+account, so a connector credential can never alias the sealing key's item.
      'item="$store/$(printf %s "$service@$account" | tr / _)"',
      'case "$cmd" in',
      '  find-generic-password) [ -f "$item" ] && { cat "$item"; echo; exit 0; } || exit 44 ;;',
      '  add-generic-password) [ -f "$item" ] && [ -z "$update" ] && exit 45; printf %s "$value" > "$item"; exit 0 ;;',
      '  delete-generic-password) [ -f "$item" ] && { rm -f "$item"; exit 0; } || exit 44 ;;',
      "esac",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  process.env.COCHECK_SECURITY_BIN = bin;
  removeAtExit(dir);
}

// Call log for `security`. Set COCHECK_SECURITY_CALL_LOG=<file> and the whole run gets a PATH stub named `security` that appends its
// argv to that file and exits 1. The stub catches any spawn by name, the guard in `seal.ts` refuses the absolute /usr/bin/security path, and the
// log must stay empty. The stand-in above is unaffected: it serves COCHECK_SECURITY_BIN, which `seal.ts` runs by path, never by name.
if (process.env.COCHECK_SECURITY_CALL_LOG && !process.env.COCHECK_SECURITY_CALL_STUB) {
  const dir = mkdtempSync(path.join(tmpdir(), "cocheck-test-security-stub-"));
  const stub = path.join(dir, "security");
  writeFileSync(stub, `#!/bin/sh\necho "$0 $*" >> '${process.env.COCHECK_SECURITY_CALL_LOG.replace(/'/g, "'\\''")}'\nexit 1\n`, { mode: 0o755 });
  chmodSync(stub, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.COCHECK_SECURITY_CALL_STUB = stub;
  removeAtExit(dir);
}

// Tests get no built-in connectors (src/connector/builtins.ts) unless a test asks: with this variable the default list is empty, in this process and in
// every child process (they inherit it). A test opts in with setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS), or drops the variable from a
// child's env. An explicit value is kept.
if (process.env.COCHECK_TEST_NO_BUILTIN_CONNECTORS === undefined) process.env.COCHECK_TEST_NO_BUILTIN_CONNECTORS = "1";

// A run started from a shell CoCheck records inherits the attribution recorder (COCHECK_WRITE_LOG, COCHECK_TAG_SESSION, the
// guard loader in NODE_OPTIONS, the hooks folder in PYTHONPATH). Test children never inherit it. This process's own preload, if NODE_OPTIONS
// already loaded one, keeps running: `npm test` (scripts/run-tests.ts) scrubs before the runner starts, so there it never loads at all.
scrubRecorderEnv(process.env);
