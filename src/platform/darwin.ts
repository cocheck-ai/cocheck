import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { MARKER } from "../hosts/types.ts";
import { SecretStoreError, isConnectorService, type HookCommandSpec, type ParsedHookCommand, type Platform } from "./types.ts";

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const SHQ = String.raw`'(?:[^']|'\\'')*'`;
const unshq = (s: string): string => s.slice(1, -1).replace(/'\\''/g, "'");

// The command shape CoCheck writes, matched whole: the launcher form, with the Homebrew wrapper's COCHECK_NODE when present. Every path is an shq() token. An entry that merely contains the marker text is the user's own.
const LAUNCHER = new RegExp(`^${MARKER} COCHECK_HOME=(${SHQ})(?: COCHECK_NODE=(${SHQ}))? /bin/sh (${SHQ}) (${SHQ}) --host (\\S+)$`);

function parseHookCommand(command: string): ParsedHookCommand | undefined {
  const m = LAUNCHER.exec(command);
  if (m !== null) return { dataHome: unshq(m[1]!), ...(m[2] === undefined ? {} : { node: unshq(m[2]) }), launcher: unshq(m[3]!), hookPath: unshq(m[4]!), host: m[5]! };
  return undefined;
}

/** `ps -o command=` for `pid` (`-E -ww` adds the environment). `run` is injectable for tests; undefined when ps fails. */
export function psCommandLine(run: typeof execFileSync, pid: number, options: { withEnvironment?: boolean } = {}): string | undefined {
  try {
    return run("ps", [...(options.withEnvironment ? ["-E", "-ww"] : []), "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  } catch {
    return undefined;
  }
}


function harden(dir: string, recursive: boolean, fileMode: number, dirMode: number): void {
  let entries: string[];
  try {
    chmodSync(dir, dirMode);
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (recursive) harden(full, true, fileMode, dirMode);
        else chmodSync(full, dirMode);
      } else if (st.isFile()) {
        chmodSync(full, fileMode);
      }
    } catch {
      // gone between the listing and the chmod
    }
  }
}

function runSecurity(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const bin = process.env.COCHECK_SECURITY_BIN;
  if (!bin) {
    // COCHECK_REAL_SECURITY_PATH only moves where the "real" tool is looked for (a guard test points it at a call recorder); it lifts no check below.
    // The real tool is spawned only for the OS account's own home and outside any test run. A child with a clean env or a temp HOME
    // has no login Keychain to find, and macOS answers that with a dialog on the user's screen, so it never gets that far.
    if (process.env.COCHECK_TEST_NO_OFFICE || process.env.NODE_TEST_CONTEXT) {
      throw new SecretStoreError("under the test runner the real Keychain is off limits; inject a key provider or set COCHECK_SECURITY_BIN");
    }
    const home = process.env.HOME;
    if (!home || path.resolve(home) !== path.resolve(userInfo().homedir)) {
      throw new SecretStoreError("HOME is not the account's real home, so the real Keychain is not used; inject a key provider or set COCHECK_SECURITY_BIN");
    }
  }
  const r = spawnSync(bin || process.env.COCHECK_REAL_SECURITY_PATH || "/usr/bin/security", args, { encoding: "utf8", timeout: 15_000, ...(input === undefined ? {} : { input }) });
  if (r.error) throw new SecretStoreError(`could not run the security tool: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** A double-quoted `security -i` argument. A control character cannot be quoted safely, so it is refused. */
function keychainQuote(text: string): string {
  if (/[\x00-\x1f\x7f]/.test(text)) throw new SecretStoreError("a service or account name holds a control character");
  return `"${text.replace(/[\\"]/g, "\\$&")}"`;
}

function refuseNonConnector(service: string, verb: string): void {
  if (!isConnectorService(service)) throw new SecretStoreError(`refusing to ${verb} "${service}": only connector credentials can be changed here`);
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** An installed Mac app's version, read from its bundle's Info.plist (a file read; the app is never started or scripted). Undefined when it cannot be read. */
export function macAppVersion(appName: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("/usr/bin/defaults", ["read", `/Applications/${appName}.app/Contents/Info`, "CFBundleShortVersionString"], { timeout: 3000 }, (err, out) => resolve(err ? undefined : out.trim() || undefined));
  });
}

export const darwin: Platform = {
  name: "darwin",
  paths: {
    userHome: () => userInfo().homedir,
    tmpDir: () => tmpdir(),
    isAbs: (p) => path.posix.isAbsolute(p),
    toPosix: (p) => p,
    caseSensitive: false,
    foldsCase: false,
  },
  openUrl: (url) => void execFileSync(process.env.COCHECK_OPEN_CMD || "open", [url], { stdio: "ignore" }),
  openFile: (file, app) => new Promise((resolve) => execFile("open", [...(app === undefined ? [] : ["-a", app]), file], { timeout: 30_000 }, (error) => resolve(error === null))),
  process: {
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM: the pid exists but belongs to another user - alive.
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    terminate: (pid) => process.kill(pid, "SIGTERM"),
    commandLine: (pid, options) => psCommandLine(execFileSync, pid, options),
    homeIdentity: "environment",
    spawnDetached(command, args, options = {}) {
      const child = spawn(command, args, { ...options, detached: true, stdio: "ignore" });
      child.unref();
      return child.pid;
    },
  },
  secretStore: {
    get(service, account) {
      const r = runSecurity(["find-generic-password", "-s", service, "-a", account, "-w"]);
      if (r.status === 44) return null; // errSecItemNotFound
      if (r.status !== 0) throw new SecretStoreError(`the Keychain refused: ${r.stderr.trim() || `exit ${r.status}`}`);
      const key = Buffer.from(r.stdout.trim(), "hex");
      if (!isConnectorService(service) && key.length !== 32) throw new SecretStoreError("the Keychain item is not a 32-byte key");
      return key;
    },
    create(service, account, key) {
      // The key travels on the stdin of `security -i`, never in argv (so `ps` cannot show it). No -U: an existing item is never replaced.
      const r = runSecurity(["-i"], `add-generic-password -s ${keychainQuote(service)} -a ${keychainQuote(account)} -w "${key.toString("hex")}"\n`);
      if (r.status !== 0) throw new SecretStoreError(`the Keychain would not store a new key: ${r.stderr.trim() || `exit ${r.status}`}`);
      // `security -i` can exit 0 after a command failed (an item that already exists included); read it back so a key that was not kept is never used.
      const back = this.get(service, account);
      if (back === null || !back.equals(key)) throw new SecretStoreError("the Keychain did not keep the new key");
    },
    set(service, account, value) {
      refuseNonConnector(service, "store");
      // The value travels on the stdin of `security -i`, never in argv (so `ps` cannot show it). Stored as hex text, as `create` does, so any bytes round-trip through `get`.
      const r = runSecurity(["-i"], `add-generic-password -U -s ${keychainQuote(service)} -a ${keychainQuote(account)} -w "${value.toString("hex")}"\n`);
      if (r.status !== 0) throw new SecretStoreError(`the Keychain would not store the credential: ${firstLine(r.stderr) || `exit ${r.status}`}`);
      // `security -i` can exit 0 after a command failed; read it back so a store that kept nothing is never reported as stored.
      const back = this.get(service, account);
      if (back === null || !back.equals(value)) throw new SecretStoreError("the Keychain did not keep the credential, so nothing was stored");
    },
    delete(service, account) {
      refuseNonConnector(service, "remove");
      const r = runSecurity(["delete-generic-password", "-s", service, "-a", account]);
      if (r.status === 44) return false;
      if (r.status !== 0) throw new SecretStoreError(`the Keychain would not remove the credential: ${firstLine(r.stderr) || `exit ${r.status}`}`);
      return true;
    },
    location: (service) => `the "${service}" item in your login Keychain`,
  },
  hookCommand: {
    build: (s: HookCommandSpec) => `${MARKER} COCHECK_HOME=${shq(s.dataHome)}${s.node === undefined ? "" : ` COCHECK_NODE=${shq(s.node)}`} /bin/sh ${shq(s.launcher)} ${shq(s.hookPath)} --host ${s.host}`,
    parse: parseHookCommand,
    isMarked: (command) => command.startsWith(`${MARKER} `),
  },
  fsSecurity: { fileMode: FILE_MODE, dirMode: DIR_MODE, ownerOnly: (dir, recursive) => void harden(dir, recursive, FILE_MODE, DIR_MODE) },
  office: { liveExcel: true, render: true, thumbnails: true },
  shellDialect: { kind: "posix", shell: "/bin/sh" },
};
