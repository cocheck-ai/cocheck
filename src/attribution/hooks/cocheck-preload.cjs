// CoCheck: records which Claude Code Bash call wrote a file, from inside a Node child.
//
// Required by the guard loader CoCheck writes under its home (NODE_OPTIONS names the guard, never this file, which an upgrade can
// remove). Does nothing unless COCHECK_WRITE_LOG names a directory and the session (COCHECK_TAG_SESSION) has had a call tagged. On
// the process's first write or program start it looks for the call's tag ("# cocheck-call:<call>:<agent>") in its ancestors' command
// lines, nearest first; with no tag it stops for good. Writes are recorded only under the registered folders (roots.json); starting
// a program other than node or python is recorded as "spawn", since that program's writes are not seen. It wraps fs's write entry points, keeps
// their behaviour (arguments, return values, throws and callbacks pass through untouched), never prints, and guards against
// re-entry: its own log write and its `ps` lookup run on the original functions with the guard held.
"use strict";
(() => {
  const logDir = process.env.COCHECK_WRITE_LOG;
  const session = process.env.COCHECK_TAG_SESSION || "";
  if (!logDir || !require("node:path").isAbsolute(logDir)) return;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) return;
  const fs = require("node:fs");
  const path = require("node:path");
  const orig = {
    openSync: fs.openSync,
    writeSync: fs.writeSync,
    closeSync: fs.closeSync,
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
    realpathSync: fs.realpathSync,
    mkdirSync: fs.mkdirSync,
  };
  const TAG = /# cocheck-call:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})/g;
  const logPrefix = path.join(logDir, path.sep);
  const seen = new Set();
  let busy = false;
  let looked = false;
  let tag = null;
  let roots = [];
  const HOOKED = /^(python(\d+(\.\d+)*)?|node)$/;

  const look = () => {
    if (looked) return tag;
    looked = true;
    if (!orig.existsSync(path.join(logDir, "active", session))) return null;
    tag = findTag();
    try {
      const r = JSON.parse(orig.readFileSync(path.join(logDir, "roots.json"), "utf8"));
      roots = Array.isArray(r) ? r.filter((x) => typeof x === "string" && x.startsWith("/")) : [];
    } catch {
      roots = [];
    }
    return tag;
  };
  const inRoot = (p) => roots.some((r) => p === r || p.startsWith(r.replace(/\/+$/, "") + "/"));
  const underRoots = (p) => {
    if (inRoot(p)) return true;
    try {
      return inRoot(path.join(orig.realpathSync(path.dirname(p)), path.basename(p)));
    } catch {
      return false;
    }
  };

  const commandLine = (pid) => {
    try {
      const cmd = orig.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").join(" ");
      const stat = orig.readFileSync(`/proc/${pid}/stat`).toString("utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1]);
      return { ppid, cmd };
    } catch {}
    try {
      const r = require("node:child_process").spawnSync("/bin/ps", ["-ww", "-o", "ppid=,command=", "-p", String(pid)], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
      const out = r.stdout ? r.stdout.toString("utf8").trim() : "";
      if (!out) return null;
      const sp = out.indexOf(" ");
      return { ppid: Number(sp < 0 ? out : out.slice(0, sp)), cmd: sp < 0 ? "" : out.slice(sp + 1) };
    } catch {
      return null;
    }
  };

  const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
  const isCShell = (cmd) => {
    const w = cmd.split(/\s+/).filter(Boolean);
    if (w.length === 0 || !SHELLS.has(path.basename(w[0]).replace(/^-+/, ""))) return false;
    return w.slice(1, 4).some((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
  };

  // The call's own shell put "<call>:<agent>" in the environment before the command ran; a child that outlives that shell
  // inherits it, when no ancestor is left to read the tag from.
  const envTag = () => {
    const m = /^([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})$/.exec(process.env.COCHECK_WRITE_CALL || "");
    return m ? [m[1], m[2]] : null;
  };

  const findTag = () => {
    let pid = process.ppid;
    if (pid <= 1) return envTag();
    for (let i = 0; i < 12 && pid > 1; i++) {
      const got = commandLine(pid);
      if (!got) return envTag();
      let last = null;
      for (const m of got.cmd.matchAll(TAG)) last = m;
      if (last) return [last[1], last[2]];
      // The nearest `<shell> -c` is the call's own shell: never look past it (a nested session's outer call).
      if (isCShell(got.cmd)) return null;
      pid = got.ppid;
    }
    return null;
  };

  const pathOf = (p) => {
    if (typeof p === "string") return p;
    if (Buffer.isBuffer(p)) return p.toString("utf8");
    if (p instanceof URL && p.protocol === "file:") return require("node:url").fileURLToPath(p);
    return null;
  };

  const record = (op, target) => {
    if (busy || (looked && tag === null)) return;
    busy = true;
    try {
      let p;
      if (op === "spawn" || op === "start") p = String(target);
      else {
        p = pathOf(target);
        if (!p) return;
        p = path.resolve(p);
        if (p.startsWith(logPrefix) || p.startsWith("/dev/")) return;
      }
      const key = `${op}\0${p}`;
      if (seen.has(key)) return;
      if (look() === null) return;
      if (op !== "spawn" && op !== "start" && !underRoots(p)) return;
      seen.add(key);
      const now = new Date();
      const line = JSON.stringify({ v: 1, call: tag[0], agent: tag[1], pid: process.pid, ts: now.getTime(), op, path: p, via: "node", ...(op === "start" ? { ppid: process.ppid } : {}) }) + "\n";
      const name = path.join(logDir, `writes-${now.toISOString().slice(0, 10)}.jsonl`);
      let fd;
      try {
        fd = orig.openSync(name, "a", 0o600);
      } catch (e) {
        if (!e || e.code !== "ENOENT") throw e;
        orig.mkdirSync(logDir, { recursive: true, mode: 0o700 });
        fd = orig.openSync(name, "a", 0o600);
      }
      try {
        orig.writeSync(fd, line);
      } finally {
        orig.closeSync(fd);
      }
    } catch {
      // never into the program
    } finally {
      busy = false;
    }
  };

  const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC;
  const writesFlag = (flags) => (flags === undefined || flags === null ? false : typeof flags === "number" ? (flags & WRITE_FLAGS) !== 0 : /[wa+x]/.test(String(flags)));
  const fdLike = (p) => typeof p === "number" || (p && typeof p === "object" && typeof p.fd === "number" && !(p instanceof URL));

  const PROMISIFY = require("node:util").promisify.custom;

  /**
   * Wraps `obj[name]` so `pick(args)` names what it writes; the original runs exactly as called. The original's own properties carry
   * over (exec and execFile hold `util.promisify.custom`, without which `promisify(execFile)` resolves to a bare stdout and its
   * errors lose .stdout/.stderr); a promisify hook is itself wrapped so it records like the plain call, once.
   */
  const wrap = (obj, name, pick) => {
    const fn = obj && obj[name];
    if (typeof fn !== "function" || fn.__cocheckWrapped) return;
    let inner = 0; // > 0 while a wrapped promisify hook runs: a call it makes back into `wrapped` is already recorded
    const note = (args) => {
      if (busy || inner > 0) return;
      try {
        for (const [op, target] of pick(args)) if (!fdLike(target)) record(op, target);
      } catch {}
    };
    const wrapped = function (...args) {
      note(args);
      return fn.apply(this, args);
    };
    for (const key of Reflect.ownKeys(fn)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      const d = Object.getOwnPropertyDescriptor(fn, key);
      if (key === PROMISIFY && typeof d.value === "function") {
        const custom = d.value;
        const hook = function (...args) {
          note(args);
          inner++;
          try {
            return custom.apply(this, args);
          } finally {
            inner--;
          }
        };
        Object.defineProperty(hook, "name", { value: custom.name });
        Object.defineProperty(hook, "length", { value: custom.length });
        d.value = hook;
      }
      try {
        Object.defineProperty(wrapped, key, d);
      } catch {}
    }
    Object.defineProperty(wrapped, "__cocheckWrapped", { value: true });
    Object.defineProperty(wrapped, "name", { value: fn.name });
    Object.defineProperty(wrapped, "length", { value: fn.length });
    obj[name] = wrapped;
  };

  const flagsArg = (opt, dflt) => (typeof opt === "string" ? dflt : opt && typeof opt === "object" && opt.flag !== undefined ? opt.flag : dflt);
  const openPick = ([p, flags]) => (writesFlag(flags) ? [["write", p]] : []);
  const writeFilePick = ([p, , opt]) => (writesFlag(flagsArg(opt, "w")) ? [["write", p]] : []);
  const appendPick = ([p, , opt]) => (writesFlag(flagsArg(opt, "a")) ? [["write", p]] : []);
  const renamePick = ([a, b]) => [["remove", a], ["write", b]];
  const copyPick = ([, b]) => [["write", b]];
  const removePick = ([p]) => [["remove", p]];
  const streamPick = ([p, opt]) => (writesFlag(flagsArg(opt, "w")) ? [["write", p]] : []);

  for (const [name, pick] of [
    ["open", openPick], ["openSync", openPick],
    ["writeFile", writeFilePick], ["writeFileSync", writeFilePick],
    ["appendFile", appendPick], ["appendFileSync", appendPick],
    ["rename", renamePick], ["renameSync", renamePick],
    ["copyFile", copyPick], ["copyFileSync", copyPick], ["cp", copyPick], ["cpSync", copyPick],
    ["unlink", removePick], ["unlinkSync", removePick],
    ["truncate", removePick.length ? ([p]) => [["write", p]] : null], ["truncateSync", ([p]) => [["write", p]]],
    ["createWriteStream", streamPick],
  ]) if (pick) wrap(fs, name, pick);
  const cp = require("node:child_process");
  const exeName = (f) => path.basename(String(f || "?"));
  const spawnPick = ([file, a, o]) => {
    const opts = Array.isArray(a) ? o : a;
    const shell = opts && typeof opts === "object" && opts.shell;
    const name = exeName(file);
    return shell || !HOOKED.test(name) ? [["spawn", shell ? "sh" : name]] : [];
  };
  const shellPick = () => [["spawn", "sh"]];
  for (const [name, pick] of [
    ["spawn", spawnPick], ["spawnSync", spawnPick], ["execFile", spawnPick], ["execFileSync", spawnPick],
    ["exec", shellPick], ["execSync", shellPick],
  ]) wrap(cp, name, pick);
  const fsp = fs.promises;
  for (const [name, pick] of [
    ["open", openPick], ["writeFile", writeFilePick], ["appendFile", appendPick],
    ["rename", renamePick], ["copyFile", copyPick], ["cp", copyPick], ["unlink", removePick], ["truncate", ([p]) => [["write", p]]],
  ]) wrap(fsp, name, pick);
  // Once the tag is found, a "start" record names the call and this interpreter, so "logged no write" is only ever trusted for a
  // call whose children provably carried the hook (one that never loaded, or found no tag, leaves no start record).
  try {
    if (orig.existsSync(path.join(logDir, "active", session))) record("start", process.execPath);
  } catch {
    // never into the program
  }
})();
