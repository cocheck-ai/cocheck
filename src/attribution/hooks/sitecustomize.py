# CoCheck: records which Claude Code Bash call wrote a file, from inside a Python child.
#
# Run by the guard loader CoCheck writes under its home (PYTHONPATH names the guard, never this file, which an upgrade can remove);
# imported directly it also works. It does nothing unless COCHECK_WRITE_LOG names a directory and the session (COCHECK_TAG_SESSION)
# has had a call tagged. On the process's first write or program start it looks for the call's tag ("# cocheck-call:<call>:<agent>")
# in its ancestors' command lines, nearest first; with no tag it stops for good. It records writes only under the registered
# folders (roots.json), and records "spawn" when the process starts another program (os.system, subprocess, exec, spawn), since
# that program's writes are not seen. In a tagged session it also records "start" (with sys.executable) once it finds the tag, the
# proof that this process carried the hook. It never prints, never raises into the program, and chains to the user's own sitecustomize.
import os as _os
import sys as _sys


def _cocheck_install():
    log_dir = _os.environ.get("COCHECK_WRITE_LOG")
    session = _os.environ.get("COCHECK_TAG_SESSION", "")
    if not log_dir or not _os.path.isabs(log_dir) or not hasattr(_sys, "addaudithook"):
        return
    if not session or "/" in session or session.startswith("."):
        return
    import re
    import time
    import _thread
    import json

    tag_re = re.compile(r"# cocheck-call:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})")
    write_flags = _os.O_WRONLY | _os.O_RDWR | _os.O_APPEND | _os.O_CREAT | _os.O_TRUNC
    busy = set()
    seen = set()
    state = {"tag": None, "looked": False, "roots": None}
    log_prefix = _os.path.join(log_dir, "")
    hooked = re.compile(r"^(python(\d+(\.\d+)*)?|node)$")

    def cmdline(pid):
        # (ppid, command line) of a process, or None.
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as f:
                cmd = f.read().replace(b"\0", b" ").decode("utf-8", "replace")
            with open("/proc/%d/stat" % pid, "rb") as f:
                ppid = int(f.read().rsplit(b")", 1)[1].split()[1])
            return ppid, cmd
        except Exception:
            pass
        try:
            import subprocess
            out = subprocess.run(["/bin/ps", "-ww", "-o", "ppid=,command=", "-p", str(pid)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 timeout=2).stdout.decode("utf-8", "replace").strip()
            if not out:
                return None
            ppid, _, cmd = out.partition(" ")
            return int(ppid), cmd
        except Exception:
            return None

    shells = ("sh", "bash", "zsh", "dash", "ksh")

    def is_c_shell(cmd):
        words = cmd.split()
        if not words or _os.path.basename(words[0]).lstrip("-") not in shells:
            return False
        return any(re.match(r"^-[A-Za-z]*c[A-Za-z]*$", w) for w in words[1:4])

    def env_tag():
        # The call's own shell put "<call>:<agent>" in the environment before the command ran; a child that outlives that shell
        # (a forked pipeline stage whose shell aborted) inherits it, when no ancestor is left to read the tag from.
        m = re.match(r"^([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})$", _os.environ.get("COCHECK_WRITE_CALL", ""))
        return m.groups() if m else None

    def find_tag():
        pid = _os.getppid()
        for _ in range(12):
            if pid <= 1:
                return env_tag()  # the call's shell is gone: this process was left running by it
            got = cmdline(pid)
            if got is None:
                return env_tag()
            ppid, cmd = got
            found = tag_re.findall(cmd)
            if found:
                return found[-1]
            if is_c_shell(cmd):
                return None  # the nearest `<shell> -c` is the call's own shell: never look past it (a nested session's outer call)
            pid = ppid
        return None

    def look():
        if not state["looked"]:
            state["looked"] = True
            if _os.path.exists(_os.path.join(log_dir, "active", session)):
                state["tag"] = find_tag()
                try:
                    with open(_os.path.join(log_dir, "roots.json"), "rb") as f:
                        state["roots"] = [r for r in json.loads(f.read().decode("utf-8")) if isinstance(r, str) and r.startswith("/")]
                except Exception:
                    state["roots"] = []
        return state["tag"]

    def under_roots(path):
        roots = state["roots"] or []
        for cand in (path, None):
            if cand is None:
                try:
                    cand = _os.path.join(_os.path.realpath(_os.path.dirname(path)), _os.path.basename(path))
                except Exception:
                    return False
            for r in roots:
                if cand == r or cand.startswith(r.rstrip("/") + "/"):
                    return True
        return False

    def record(op, path):
        if op == "spawn" or op == "start":
            if not isinstance(path, str):
                path = _os.fsdecode(path) if isinstance(path, bytes) else "?"
            key = (op, path)
        else:
            if isinstance(path, bytes):
                path = _os.fsdecode(path)
            if not isinstance(path, str) or path == "":
                return
            path = _os.path.abspath(path)
            if path.startswith(log_prefix) or path.startswith("/dev/") or "__pycache__" in path:
                return
            key = (op, path)
        if key in seen:
            return
        tag = look()
        if tag is None:
            return
        if op != "spawn" and op != "start" and not under_roots(path):
            return
        seen.add(key)
        rec = {"v": 1, "call": tag[0], "agent": tag[1], "pid": _os.getpid(), "ts": int(time.time() * 1000),
               "op": op, "path": path, "via": "python"}
        if op == "start":
            rec["ppid"] = _os.getppid()
        line = json.dumps(rec) + "\n"
        name = _os.path.join(log_dir, "writes-%s.jsonl" % time.strftime("%Y-%m-%d", time.gmtime()))
        try:
            fd = _os.open(name, _os.O_WRONLY | _os.O_APPEND | _os.O_CREAT, 0o600)
        except FileNotFoundError:
            _os.makedirs(log_dir, 0o700, exist_ok=True)
            fd = _os.open(name, _os.O_WRONLY | _os.O_APPEND | _os.O_CREAT, 0o600)
        try:
            _os.write(fd, line.encode("utf-8", "surrogateescape"))
        finally:
            _os.close(fd)

    def spawned(exe):
        # A Python or Node child carries its own hook; anything else (or a shell) writes where no hook sees.
        name = _os.path.basename(_os.fsdecode(exe) if isinstance(exe, bytes) else str(exe))
        if not hooked.match(name):
            record("spawn", name)

    def hook(event, args):
        if state["looked"] and state["tag"] is None:
            return
        if event not in ("open", "os.rename", "os.remove", "os.truncate", "shutil.copyfile",
                         "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.startfile"):
            return
        me = _thread.get_ident()
        if me in busy:
            return
        busy.add(me)
        try:
            if event == "open":
                path, mode, flags = args[0], args[1], args[2]
                if isinstance(path, int):
                    return
                writes = (any(c in mode for c in "wax+") if isinstance(mode, str)
                          else isinstance(flags, int) and (flags & write_flags) != 0)
                if writes:
                    record("write", path)
            elif event == "os.rename":
                record("remove", args[0])
                record("write", args[1])
            elif event == "os.remove":
                record("remove", args[0])
            elif event == "os.truncate":
                if not isinstance(args[0], int):
                    record("write", args[0])
            elif event == "shutil.copyfile":
                record("write", args[1])
            elif event == "subprocess.Popen":
                exe, argv = args[0], args[1]
                if exe is None:
                    if isinstance(argv, (str, bytes)):
                        exe = "sh"
                    elif argv:
                        exe = list(argv)[0]
                spawned(exe if exe is not None else "?")
            elif event == "os.system" or event == "os.startfile":
                record("spawn", "sh")
            elif event == "os.spawn":
                spawned(args[1])
            else:
                spawned(args[0])
        except Exception:
            pass
        finally:
            busy.discard(me)

    _sys.addaudithook(hook)

    # Once the tag is found, a "start" record names the call and this interpreter, so "logged no write" is only ever trusted for a
    # call whose children provably carried the hook (one that never loaded, or found no tag, leaves no start record).
    if _os.path.exists(_os.path.join(log_dir, "active", session)):
        me = _thread.get_ident()
        busy.add(me)
        try:
            record("start", _sys.executable or "?")
        except Exception:
            pass
        finally:
            busy.discard(me)


try:
    _cocheck_install()
except Exception:
    pass


def _cocheck_chain():
    if globals().get("_COCHECK_GUARDED"):
        return  # the guard chains
    # Runs the next sitecustomize on sys.path, the one this file shadows.
    import importlib.machinery
    import importlib.util
    here = _os.path.dirname(_os.path.abspath(__file__))
    rest = [p for p in _sys.path if _os.path.abspath(p or ".") != here]
    spec = importlib.machinery.PathFinder.find_spec("sitecustomize", rest)
    if spec is None or spec.loader is None or not spec.origin:
        return
    if _os.path.dirname(_os.path.abspath(spec.origin)) == here:
        return
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


try:
    _cocheck_chain()
except Exception:
    pass
