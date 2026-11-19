import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// The Node write hook replaces child_process.exec/execFile; the replacement must keep `util.promisify.custom`, or
// `promisify(execFile)` resolves to a bare stdout string and a rejection loses .stdout/.stderr (every recorded agent's script, and
// CoCheck's own copyXattrs). The env is set explicitly here: the preload from this tree, a temp write log, an active session.

const PRELOAD = path.join(import.meta.dirname, "..", "src", "attribution", "hooks", "cocheck-preload.cjs");

const SCRIPT = String.raw`
const cp = require("node:child_process");
const { promisify } = require("node:util");
const execFileP = promisify(cp.execFile);
const execP = promisify(cp.exec);
const fail = async (p) => { try { await p; return null; } catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; } };
(async () => {
  const out = {
    wrapped: cp.execFile.__cocheckWrapped === true && cp.exec.__cocheckWrapped === true,
    execFile: await execFileP("/bin/echo", ["hi"]),
    exec: await execP("printf out; printf err >&2"),
    execFileFail: await fail(execFileP("/bin/ls", ["/cocheck-no-such-path"])),
    execFail: await fail(execP("printf out2; printf err2 >&2; exit 3")),
  };
  process.stdout.write(JSON.stringify(out));
})();
`;

describe("promisify(exec/execFile) under the Node write hook", () => {
  it("resolves to {stdout, stderr}, rejects with .stdout/.stderr/.code, and still records the spawns", { skip: process.platform === "win32" && "drives /bin/bash and /bin/ls, and the per-call tag is read from a POSIX ancestor's command line" }, () => {
    const w = realpathSync(mkdtempSync(path.join(tmpdir(), "cocheck-")));
    try {
      const log = path.join(w, "log");
      mkdirSync(path.join(log, "active"), { recursive: true });
      writeFileSync(path.join(log, "active", "s144"), "");
      writeFileSync(path.join(log, "roots.json"), JSON.stringify([w]));
      writeFileSync(path.join(w, "run.cjs"), SCRIPT);
      // node is not the shell's last command, so the shell stays its parent and the tag is in an ancestor's command line
      const cmd = `node run.cjs && true\n# cocheck-call:toolu_T144:agT144`;
      const r = spawnSync("/bin/bash", ["-c", cmd], {
        cwd: w,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: w, NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}`, COCHECK_WRITE_LOG: log, COCHECK_TAG_SESSION: "s144" },
      });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.wrapped, true, "the preload is loaded");
      assert.deepEqual(out.execFile, { stdout: "hi\n", stderr: "" });
      assert.deepEqual(out.exec, { stdout: "out", stderr: "err" });
      assert.equal(out.execFileFail.code, 1);
      assert.equal(out.execFileFail.stdout, "");
      assert.match(out.execFileFail.stderr, /cocheck-no-such-path/);
      assert.deepEqual(out.execFail, { code: 3, stdout: "out2", stderr: "err2" });

      const lines = readdirSync(log)
        .filter((n) => n.startsWith("writes-"))
        .flatMap((n) => readFileSync(path.join(log, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
      const spawns = lines.filter((l) => l.op === "spawn").map((l) => l.path).sort();
      assert.deepEqual(spawns, ["echo", "ls", "sh"]);
      assert.ok(lines.every((l) => l.call === "toolu_T144" && l.agent === "agT144"));
      assert.ok(lines.some((l) => l.op === "start"), "a start record names the call");
    } finally {
      rmSync(w, { recursive: true, force: true });
    }
  });

  it("the wrapped functions keep the originals' own properties", () => {
    const r = spawnSync(process.execPath, ["-e", `const cp=require("node:child_process");const u=require("node:util");process.stdout.write(JSON.stringify([cp.exec.__cocheckWrapped===true,typeof cp.exec[u.promisify.custom],typeof cp.execFile[u.promisify.custom],cp.execFile.name,cp.execFile.length]))`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}`, COCHECK_WRITE_LOG: path.join(tmpdir(), "cocheck-unused"), COCHECK_TAG_SESSION: "s144" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [true, "function", "function", "execFile", 4]);
  });
});
