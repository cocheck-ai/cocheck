import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { MARKER } from "../hosts/types.ts";
import { createDocRender } from "./win32-docrender.ts";
import { SecretStoreError, isConnectorService, type HookCommandSpec, type ParsedHookCommand, type Platform } from "./types.ts";

// The hook command on Windows starts Node directly on scripts/hook-launch.mjs: no /bin/sh, and no `VAR=value` prefix (cmd cannot read one), so
// the data home and the pinned Node travel as launcher options. Paths are double-quoted, the one quote cmd, PowerShell and Git Bash all read.
// A path holding a character that one of them still expands inside double quotes (" % $ ` ! ^) is refused, never half-quoted.
//   node "<launcher>" COCHECK_MANAGED=1 --home "<dataHome>" [--node "<node>"] "<hookPath>" --host <host>
const UNSAFE = /["%$`!^\r\n]/;
const Q = '"([^"]*)"';
const COMMAND = new RegExp(`^node ${Q} ${MARKER} --home ${Q}(?: --node ${Q})? ${Q} --host (\\S+)$`);

const quote = (s: string): string => {
  if (UNSAFE.test(s)) throw new Error(`CoCheck cannot put this path in a Windows hook command: ${s}`);
  return `"${s}"`;
};

function build(s: HookCommandSpec): string {
  if (/\s/.test(s.host)) throw new Error(`CoCheck cannot put this host in a Windows hook command: ${s.host}`);
  return `node ${quote(s.launcher)} ${MARKER} --home ${quote(s.dataHome)}${s.node === undefined ? "" : ` --node ${quote(s.node)}`} ${quote(s.hookPath)} --host ${s.host}`;
}

function parse(command: string): ParsedHookCommand | undefined {
  const m = COMMAND.exec(command);
  if (m === null) return undefined;
  return { dataHome: m[2]!, ...(m[3] === undefined ? {} : { node: m[3] }), launcher: m[1]!, hookPath: m[4]!, host: m[5]! };
}

/** What the Windows platform reaches the machine through. Tests inject fakes; the real set is `realDeps`. */
export interface Win32Deps {
  env: NodeJS.ProcessEnv;
  homedir(): string;
  tmpdir(): string;
  /** Runs a program with an argv array (never a shell string), `input` on stdin. `error` is set when it could not start. */
  run(command: string, args: string[], options?: { input?: string; timeout?: number }): { status: number | null; stdout: string; stderr: string; error?: Error };
  runAsync(command: string, args: string[]): Promise<{ status: number | null; error?: Error }>;
  spawn: typeof spawn;
  kill(pid: number, signal?: NodeJS.Signals | 0): void;
  readFile(file: string): string;
  /** Writes `file` (a private temp name, never the final one). */
  writeFile(file: string, data: string): void;
  /** Claims `to` for the complete file `from` atomically and exclusively (hard link): throws when `to` already exists, so two creators cannot both succeed. */
  linkExclusive(from: string, to: string): void;
  /** Removes `file`; callers treat failure as best effort. */
  remove(file: string): void;
  mkdir(dir: string): void;
  exists(file: string): boolean;
  /** Names directly inside `dir`; throws when it cannot be read. */
  readdir(dir: string): string[];
}

const realDeps: Win32Deps = {
  env: process.env,
  homedir,
  tmpdir,
  run(command, args, options = {}) {
    const r = spawnSync(command, args, { encoding: "utf8", input: options.input, timeout: options.timeout ?? 15_000, windowsHide: true });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error === undefined ? {} : { error: r.error }) };
  },
  runAsync: (command, args) =>
    new Promise((resolve) =>
      execFile(command, args, { timeout: 30_000, windowsHide: true }, (error) => {
        const code = (error as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
        resolve({ status: error === null ? 0 : typeof code === "number" ? code : null, ...(error !== null && typeof code !== "number" ? { error } : {}) });
      }),
    ),
  spawn,
  kill: (pid, signal) => void process.kill(pid, signal),
  readFile: (file) => readFileSync(file, "utf8"),
  writeFile: (file, data) => writeFileSync(file, data, { encoding: "utf8" }),
  linkExclusive: (from, to) => linkSync(from, to),
  remove: (file) => unlinkSync(file),
  mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
  exists: existsSync,
  readdir: (dir) => readdirSync(dir),
};

const POWERSHELL = "powershell.exe";
const PS_BASE = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
// DPAPI, CurrentUser scope. The secret reaches the script on stdin only; the script text on the command line holds no secret.
const PROTECT = "Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); $b = [byte[]]($in -split '(?<=\\G..)' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_, 16) }); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))";
const UNPROTECT = "Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); $b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); ($b | ForEach-Object { $_.ToString('x2') }) -join ''";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The Windows platform over `deps`. `win32` below is the real one. */
export function createWin32(overrides: Partial<Win32Deps> = {}): Platform {
  const d: Win32Deps = { ...realDeps, ...overrides };
  const userHome = (): string => d.env.USERPROFILE || d.homedir();

  // The DPAPI blob (ciphertext only) lives at <home>\AppData\Local\CoCheck\secrets\<sha256 of service+account>.dpapi. DPAPI ties it to this Windows user.
  const blobDir = (): string => path.win32.join(userHome(), "AppData", "Local", "CoCheck", "secrets");
  const blobFile = (service: string, account: string): string => path.win32.join(blobDir(), `${createHash("sha256").update(`${service}\0${account}`).digest("hex")}.dpapi`);

  function powershell(script: string, input: string, what: string): string {
    const r = d.run(POWERSHELL, [...PS_BASE, script], { input });
    if (r.error) throw new SecretStoreError(`could not run PowerShell for ${what}: ${r.error.message}`);
    if (r.status !== 0) throw new SecretStoreError(`DPAPI refused to ${what}: ${r.stderr.trim() || `exit ${r.status}`}`);
    return r.stdout.trim();
  }

  /** The user's SID from `whoami /user`: a grant by SID beats DOMAIN\\name, which fails to resolve on some domain and Microsoft-account machines. */
  function userSid(): string | undefined {
    // By full path: under Git Bash the PATH lists GNU whoami first, which has no /user.
    const r = d.run(path.win32.join(d.env.SystemRoot || d.env.windir || "C:\\Windows", "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { timeout: 10_000 });
    if (r.error || r.status !== 0) return undefined;
    return /"(S-1-[\d-]+)"/.exec(r.stdout)?.[1];
  }

  /** One icacls run. Gives the failure text, or undefined when it worked. A nonzero exit and a "Failed processing N files" line both count. */
  function icacls(args: string[]): string | undefined {
    const r = d.run("icacls", args);
    if (r.error) return `could not run icacls: ${r.error.message}`;
    const failed = /Failed processing (\d+) file/i.exec(r.stdout);
    if (r.status !== 0 || (failed !== null && failed[1] !== "0")) return `icacls ${args[0]} failed: ${(r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`).slice(0, 300)}`;
    return undefined;
  }

  // The folder is reset, then keeps only the user's full control and nothing inherited from above; every child is reset to inherit from it. The old recursive
  // grant with /T puts the folder-only (OI)(CI) flags on files, which strips every file to an empty ACL.
  // A marker file records a finished pass, so the work runs once per folder, not on every hook event.
  const ACL_MARKER = ".cocheck-acl-v1";
  function ownerOnly(dir: string, _recursive: boolean): string | undefined {
    try {
      const marker = path.win32.join(dir, ACL_MARKER);
      if (d.exists(marker)) return undefined;
      const sid = userSid();
      const user = d.env.USERNAME;
      if (sid === undefined && !user) return "could not tell which Windows user to grant: no SID and no USERNAME";
      const who = sid !== undefined ? `*${sid}` : `${d.env.USERDOMAIN ? `${d.env.USERDOMAIN}\\` : ""}${user}`;
      // Reset first: an account granted earlier (a default ACL carries SYSTEM and Administrators as explicit entries) survives /inheritance:r alone.
      const wipe = icacls([dir, "/reset", "/C", "/Q"]);
      if (wipe !== undefined) return wipe;
      const folder = icacls([dir, "/inheritance:r", "/grant:r", `${who}:(OI)(CI)F`, "/C", "/Q"]);
      if (folder !== undefined) return folder;
      if (d.readdir(dir).length > 0) {
        const kids = icacls([path.win32.join(dir, "*"), "/reset", "/T", "/L", "/C"]);
        if (kids !== undefined) return kids;
      }
      d.writeFile(marker, "1\n");
      return undefined;
    } catch (error) {
      return `could not restrict ${dir}: ${(error as Error).message}`;
    }
  }


  /** Seals `value` and writes the blob. `replace` false (the sealing key): an existing blob is never touched. True (a connector credential): the old blob is swapped for the new one. */
  function store(service: string, account: string, value: Buffer, replace: boolean): void {
    const hex = value.toString("hex");
    const sealed = powershell(PROTECT, hex, "protect the key");
    // Only ciphertext is ever written: anything that is not base64, or that is the value itself in a plain form, is a failed protect.
    if (!BASE64.test(sealed) || sealed === value.toString("base64") || (hex.length >= 32 && sealed.toLowerCase().includes(hex))) throw new SecretStoreError("DPAPI returned something that is not a sealed key, so nothing was stored");
    try {
      d.mkdir(blobDir());
      // Whole or not at all: write a temp file in the same folder, then claim the final name with an exclusive link, so the final name
      // only ever holds a complete blob. A crash leaves at most an ignored temp file; a lost race throws and leaves the winner untouched.
      const final = blobFile(service, account);
      const temp = `${final}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        d.writeFile(temp, sealed);
        if (replace && d.exists(final)) d.remove(final);
        d.linkExclusive(temp, final);
      } finally {
        try { d.remove(temp); } catch { /* best effort: a leftover temp is ignored by get */ }
      }
    } catch (error) {
      throw new SecretStoreError(`could not store the DPAPI blob${replace ? "" : " (an existing one is never replaced)"}: ${(error as Error).message}`);
    }
    ownerOnly(blobDir(), false);
  }

  return {
    name: "win32",
    paths: {
      userHome,
      tmpDir: () => d.tmpdir(),
      isAbs: (p) => path.win32.isAbsolute(p),
      toPosix: (p) => p.replace(/\\/g, "/"),
      caseSensitive: false,
      foldsCase: true,
    },
    openUrl(url) {
      // explorer.exe drops everything after "?" in a URL on some builds and exits 1 even when it worked, so it cannot say whether the page opened.
      // rundll32 hands the whole URL to the default browser as one argv entry (no shell, so "&" is safe) and exits 0 on success.
      const r = d.run("rundll32", ["url.dll,FileProtocolHandler", url], { timeout: 15_000 });
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`rundll32 url.dll,FileProtocolHandler exited ${r.status}`);
    },
    async openFile(file, app) {
      const r = app === undefined ? await d.runAsync("explorer.exe", [file]) : await d.runAsync(app, [file]);
      return r.error === undefined && (app === undefined || r.status === 0);
    },
    process: {
      alive(pid) {
        try {
          d.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM";
        }
      },
      // Windows does not end a child with its parent, so a program started through a wrapper (cmd.exe for a .cmd connector, a launcher) would
      // leave its own children running: the whole tree is ended with taskkill /T /F. When taskkill cannot run or fails, the pid alone is ended
      // (process.kill, which throws when it is already gone).
      terminate(pid) {
        if (Number.isSafeInteger(pid) && pid > 0) {
          const r = d.run(path.win32.join(d.env.SystemRoot || d.env.windir || "C:\\Windows", "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { timeout: 10_000 });
          if (r.error === undefined && r.status === 0) return;
        }
        d.kill(pid);
      },
      commandLine(pid) {
        if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
        const r = d.run(POWERSHELL, [...PS_BASE, `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`]);
        if (r.error || r.status !== 0) return undefined;
        const line = r.stdout.replace(/\r?\n$/, "");
        return line.trim() === "" ? undefined : line;
      },
      homeIdentity: "argument",
      spawnDetached(command, args, options = {}) {
        const child = d.spawn(command, args, { ...options, detached: true, windowsHide: true, stdio: "ignore" });
        child.unref();
        return child.pid;
      },
    },
    secretStore: {
      location: () => `a DPAPI-protected file in ${blobDir()}`,
      get(service, account) {
        const file = blobFile(service, account);
        if (!d.exists(file)) return null;
        let blob: string;
        try {
          blob = d.readFile(file).trim();
        } catch (error) {
          throw new SecretStoreError(`could not read the DPAPI blob: ${(error as Error).message}`);
        }
        const key = Buffer.from(powershell(UNPROTECT, blob, "unprotect the key"), "hex");
        if (!isConnectorService(service) && key.length !== 32) throw new SecretStoreError("the DPAPI blob is not a 32-byte key");
        return key;
      },
      create(service, account, key) {
        store(service, account, key, false);
      },
      set(service, account, value) {
        if (!isConnectorService(service)) throw new SecretStoreError(`refusing to store "${service}": only connector credentials can be changed here`);
        store(service, account, value, true);
      },
      delete(service, account) {
        if (!isConnectorService(service)) throw new SecretStoreError(`refusing to remove "${service}": only connector credentials can be changed here`);
        const file = blobFile(service, account);
        if (!d.exists(file)) return false;
        try {
          d.remove(file);
        } catch (error) {
          throw new SecretStoreError(`could not remove the DPAPI blob: ${(error as Error).message}`);
        }
        return true;
      },
    },
    hookCommand: { build, parse, isMarked: (command) => command.startsWith("node ") && command.includes(` ${MARKER} `) },
    fsSecurity: { fileMode: 0o600, dirMode: 0o700, ownerOnly },
    office: { liveExcel: false, render: false, thumbnails: false },
    docRender: createDocRender(d),
    shellDialect: { kind: "cmd", shell: "cmd.exe" },
  };
}

export const win32: Platform = createWin32();
