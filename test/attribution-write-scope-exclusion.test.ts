import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPathKit } from "../src/paths.ts";
import { platformFor } from "../src/platform/index.ts";
import { cannotHaveWritten, fsProbe, lexicalProbe, strictReadOnlyPython, writeScope, type ObservedFacts, type StartRecord } from "../src/attribution/write-scope.ts";
import { evidenceDir, rootsFile } from "../src/attribution/tag.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { buildTimeline, type Change, type TimelineInput } from "../src/timeline/timeline.ts";
import type { RawOp, RawState } from "../src/timeline/runs.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";
import { cannotWriteFromFixture, readFixture, score, type ReplayFixture } from "./helpers/attribution-replay.ts";
import { workbookClaims } from "./helpers/claims.ts";

// 52 "can't tell which" steps, all written by Helper 6, at two moments where another helper's Bash call was open.
// Bucket A: H6 created 41 yahoo files with `curl -sf ... -o yahoo_$t.json &` over `T=(...)` while H4's call (curl -o yahoo_{KBND,CNYB.L,
// EMHY}.json, a heredoc into hooked Python that logged no writes, `curl -sIL`) was open. Bucket B: H6 removed 11 yahoo files with
// `rm -f yahoo_{...}.json` while H5's call (`rm` of a PDF, curl to /tmp, `python3 -I -c` reading /tmp) was open. A call whose command
// provably cannot write a file is not credited with it; anything the analyzer does not fully understand stays a suspect.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};

const W = "/w";
const RAW = `${W}/data/raw`;
const H4 = "aead780057dded093";
const H5 = "ac60d2f1f297b9fce";
const H6 = "a176c36ca541bb190";

/** The recorded commands, as the helpers ran them (folder replaced). */
const cmdA_H4 = (raw: string) => `cd ${raw}; now=$(date +%s)
for t in KBND CNYB.L EMHY; do curl -s -A "Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/$t?period1=0&period2=$now&interval=1d&events=div" -o yahoo_$t.json; python3 -W ignore - <<EOF
import json,datetime as D
d=json.load(open("yahoo_$t.json"));r=d['chart'].get('result')
if not r: print("$t",d['chart'].get('error'))
else:
  ts=r[0]['timestamp'];m=r[0]['meta'];f=lambda x:D.datetime.utcfromtimestamp(x).date()
  print("$t",len(ts),f(ts[0]),f(ts[-1]),m.get('longName'),m.get('currency'))
EOF
done
# probe index tickers & Bloomberg pages
for t in %5EBAHDTRUU BAHDTRUU%3AIND LF98TRUU%3AIND; do echo $t; curl -s -A "Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/$t?interval=1d&range=5d" | head -c 200; echo; done
for u in "https://www.bloomberg.com/professional/product/indices/bloomberg-fixed-income-indices/" "https://assets.bbhub.io/professional/sites/10/Bloomberg-Index-Monthly-Returns.pdf"; do echo $u; curl -sIL -A "Mozilla/5.0" "$u" | grep -iE "^HTTP|content-type" | head -4; done`;
const TICKERS_A = ["CEMB", "HYEM", "3081.HK", "2821.HK", "1COV.F", "IDEM.L", "LQDH"];
const cmdA_H6 = (raw: string) => `cd ${raw};
T=(${TICKERS_A.join(" ")})
now=$(date +%s)
for t in $T; do (curl -sf "https://query1.finance.yahoo.com/v8/finance/chart/$t?period1=0&period2=$now&interval=1d&events=div" -H "User-Agent: Mozilla/5.0" -o yahoo_$t.json || { rm -f yahoo_$t.json; echo -n "none:$t "; }) & done; wait; echo`;
const cmdB_H5 = (raw: string) => `cd ${raw}; rm spdji_dashboard_apac_fi_2026-02.pdf; now=$(date +%s)
for t in PLUS.AX CORP.AX CRED.AX 3122.HK 83199.HK; do curl -s "https://query1.finance.yahoo.com/v8/finance/chart/$t?period1=0&period2=$now&interval=1d&events=div" -H "User-Agent: Mozilla/5.0" -o /tmp/y_$t.json; python3 -I -c "
import json,sys,datetime as d
j=json.load(open('/tmp/y_$t.json'));r=j['chart']['result']
if not r: print('$t none');sys.exit()
r=r[0];ts=r.get('timestamp',[]);m=r['meta']
print('$t',len(ts),d.date.fromtimestamp(ts[0]),d.date.fromtimestamp(ts[-1]),m.get('longName') or m.get('shortName'))"; done`;
const TICKERS_B = ["1COV.F", "3011.HK", "3081.HK", "IDEM.L", "KBND"];
const cmdB_H6 = (raw: string) => `cd ${raw}; rm -f yahoo_{${TICKERS_B.join(",")}}.json
for u in "https://indexes.morningstar.com/"; do echo "$u -> $(curl -sL -m 15 -A 'Mozilla/5.0' -o /dev/null -w '%{http_code} %{size_download}' "$u")"; done`;

/** Start records from `n` distinct processes of one interpreter. */
// The guards take a path kit; these tests compared case exactly
const EXACT = createPathKit({ name: "darwin", paths: { ...platformFor("darwin").paths, foldsCase: false } });
// The recorded run commands are macOS bash with POSIX paths. On Windows the analyzer refuses a path that is not a plain drive form, so such a call
// stays a suspect (the safe direction: joint, never a wrong single owner); the exact macOS outcomes these cases pin do not apply there.
const POSIX_REPLAY = process.platform === "win32" && "macOS recorded commands with POSIX paths: the Windows analyzer refuses them by design (the call stays a suspect)";
const POSIX_LINKS = process.platform === "win32" && "POSIX paths and symlinks (/tmp, a user's directory link): the Windows analyzer refuses them, and links need admin there";
const starts = (n: number, interpreter = "/usr/bin/python3", from = 100): StartRecord[] => Array.from({ length: n }, (_, i) => ({ path: interpreter, pid: from + i, ppid: 1 }));
const clean: ObservedFacts = { tagged: true, wrote: 0, spawned: false, covered: true, starts: [...starts(4), ...starts(2, "/opt/homebrew/bin/node", 200)] };
const excluded = (cmd: string, file: string, facts: ObservedFacts | null = clean, cwd: string | null = W) => cannotHaveWritten(file, writeScope(cmd, cwd), facts ?? undefined, lexicalProbe, EXACT);

describe("write scope: the recorded commands", () => {
  it("bucket A: H4's call writes only yahoo_{KBND,CNYB.L,EMHY}.json and relies on its observed Python child", () => {
    const s = writeScope(cmdA_H4(RAW), W);
    assert.ok(s.known, JSON.stringify(s));
    if (!s.known) return;
    assert.equal(s.observed, true);
    assert.deepEqual(s.targets.map((t) => t.path).sort(), ["CNYB.L", "EMHY", "KBND"].map((t) => `${RAW}/yahoo_${t}.json`).concat(["CNYB.L", "EMHY", "KBND"].map((t) => `${W}/yahoo_${t}.json`)).sort(), "the cd may fail: the old cwd stays possible");
    assert.equal(excluded(cmdA_H4(RAW), `${RAW}/yahoo_CEMB.json`), true);
    assert.equal(excluded(cmdA_H4(RAW), `${RAW}/yahoo_EMHY.json`), false, "a file it names is never excluded");
    assert.equal(excluded(cmdA_H4(RAW), `${RAW}/yahoo_CEMB.json`, { ...clean, wrote: 1 }), false, "its Python logged a write");
    assert.equal(excluded(cmdA_H4(RAW), `${RAW}/yahoo_CEMB.json`, { ...clean, spawned: true }), false, "its Python started a program");
    assert.equal(excluded(cmdA_H4(RAW), `${RAW}/yahoo_CEMB.json`, { ...clean, tagged: false }), false, "untagged: its Python is unobserved");
    assert.equal(excluded(cmdA_H4(RAW), `${RAW}/yahoo_CEMB.json`, { ...clean, covered: false }), false, "the hook's roots do not cover the file");
    assert.equal(excluded(cmdA_H4(RAW), `${RAW}/yahoo_CEMB.json`, null), false, "no hook facts at all");
  });

  it("bucket B: H5's call removes only the PDF, curls to /tmp and reads with a strict python -I -c", { skip: POSIX_REPLAY }, () => {
    const s = writeScope(cmdB_H5(RAW), W);
    assert.ok(s.known, JSON.stringify(s));
    if (!s.known) return;
    assert.equal(s.observed, false, "python -I carries no hook: it passes the strict read-only check instead");
    assert.ok(s.targets.some((t) => t.path === "/tmp/y_PLUS.AX.json"));
    assert.ok(s.targets.some((t) => t.path === `${RAW}/spdji_dashboard_apac_fi_2026-02.pdf`));
    assert.equal(excluded(cmdB_H5(RAW), `${RAW}/yahoo_3081.HK.json`, null), true, "no Python child to observe: no hook facts needed");
    assert.equal(excluded(cmdB_H5(RAW), `${RAW}/spdji_dashboard_apac_fi_2026-02.pdf`, null), false);
  });

  it("H6's own calls name the files: never excluded from them", () => {
    assert.equal(excluded(cmdA_H6(RAW), `${RAW}/yahoo_CEMB.json`), false);
    assert.equal(excluded(cmdB_H6(RAW), `${RAW}/yahoo_3081.HK.json`), false);
  });

  it("strict read-only Python: the allow-list", () => {
    for (const ok of ["import json,sys,datetime as d\nprint(json.load(open('/tmp/a.json'))['x'])", "import csv\nfor r in csv.reader(open('a.csv', 'r')): print(r)", "from datetime import datetime\nimport re, math, statistics\nprint(re.sub('a','b','abc'))"]) assert.equal(strictReadOnlyPython(ok), true, ok);
    for (const bad of [
      "import os\nprint(1)", "open('a','w').close()", "open('a', mode='w')", "f=open\nf('a','w')", "import json\njson.dump({}, open('a'))", "import sys\nsys.modules['os'].remove('a')",
      "().__class__.__base__", "getattr(__builtins__,'open')('a','w')", "exec('x')", "eval('1')", "import shutil", "import pathlib", "import io", "import subprocess", "print('x', file=open('a'))",
      "compile('1','a','exec')", "globals()['x']", "import json as j, pickle", "from os import path", "import sys\nsys.stdout.write('x')", "ｅｖａｌ('1')", "import xlwings as xw\nxw.Book('m.xlsx').save()",
    ]) assert.equal(strictReadOnlyPython(bad), false, bad);
  });
});

describe("adversarial: commands the analyzer must not claim to understand stay suspects", () => {
  const F = `${W}/model.xlsx`;
  const cases: Array<[string, string, ObservedFacts | null]> = [
    ["python -c building a path from the environment (-I, no hook)", `python3 -I -c "import os; open(os.environ['D']+'/model.xlsx','w')"`, clean],
    ["python -c building a path from the environment (hooked, but untagged)", `python3 -c "import os; open(os.environ['D']+'/model.xlsx','w')"`, { ...clean, tagged: false }],
    ["a variable-concatenated cp target", `cp a.xlsx "$D"6/x.xlsx`, clean],
    ["tar -xP", "tar -xPf backup.tar", clean],
    ["an xlwings save under -I", `python3 -I -c "import xlwings as xw; xw.Book('model.xlsx').save()"`, clean],
    ["an xlwings save, hooked: Excel is another program", `python3 -c "import xlwings as xw; xw.Book('model.xlsx').save()"`, { ...clean, spawned: true }],
    ["curl -O with a variable URL", `curl -sO "$URL"`, clean],
    ["curl -O with a URL from a command", `U=$(cat url.txt); curl -sO "$U"`, clean],
    ["eval", `eval "curl -so model.xlsx https://x/y"`, clean],
    ["bash script.sh", "bash fetch.sh", clean],
    ["xargs", "ls *.xlsx | xargs rm", clean],
    ["find -delete", "find . -name '*.xlsx' -delete", clean],
    ["sed -i", "sed -i '' 's/a/b/' model.xlsx", clean],
    ["> file redirect", "echo hi > model.xlsx", clean],
    ["tee", "echo hi | tee model.xlsx", clean],
    ["dd of=", "dd if=/dev/zero of=model.xlsx bs=1 count=1", clean],
    ["a heredoc into python without -I that writes (its hook logged it)", "python3 - <<'EOF'\nopen('model.xlsx','w').write('x')\nEOF", { ...clean, wrote: 1 }],
    ["a heredoc into python without -I, untagged", "python3 - <<'EOF'\nopen('model.xlsx','w').write('x')\nEOF", { ...clean, tagged: false }],
    ["an env prefix", "PYTHONPATH= python3 -c 'print(1)'", clean],
    ["python -I running a script file", "python3 -I build.py", clean],
    ["a glob target", "rm -f *.xlsx", clean],
    ["a ~ target", "cp a.xlsx ~/x.xlsx", clean],
    ["rm -r of the folder's parent tree", "rm -rf /w", clean],
    ["mv out of a tree holding the file", "mv /w /tmp/old", clean],
    ["an unbound loop list", "for f in $FILES; do rm $f; done", clean],
    ["a curl config file option", "curl -K cfg.txt https://x/y", clean],
    ["curl --output-dir", "curl --output-dir /w -O https://x/model.xlsx", clean],
    ["curl -O naming the file", "curl -sO https://x/model.xlsx", clean],
    ["a relative target with no known cwd", "touch model.xlsx", clean],
    ["source", ". ./env.sh; curl -so a https://x", clean],
    ["process substitution", "cat <(curl -s https://x) ", clean],
    ["an empty (scrubbed) command", "", clean],
  ];
  for (const [name, cmd, facts] of cases) {
    it(name, () => {
      const cwd = name === "a relative target with no known cwd" ? null : W;
      assert.equal(excluded(cmd, F, facts, cwd), false, JSON.stringify(writeScope(cmd, cwd)));
    });
  }

  it("a cd that may fail keeps the old directory possible (`;`), and only the new one after `&&`", { skip: POSIX_REPLAY }, () => {
    assert.equal(excluded("cd /elsewhere; rm model.xlsx", F), false);
    assert.equal(excluded("cd /elsewhere && rm model.xlsx", F), true);
  });

  it("a symlinked target directory (made by the user) is not followed: the call stays a suspect", { skip: POSIX_LINKS }, async () => {
    const d = await tmp("link");
    await mkdir(path.join(d, "real"));
    await symlink(path.join(d, "real"), path.join(d, "link"));
    const cmd = `curl -s https://x/y -o ${d}/link/out.json`;
    const file = path.join(d, "real", "out.json");
    assert.equal(cannotHaveWritten(file, writeScope(cmd, d), clean, lexicalProbe, EXACT), true, "lexically it would read as another file");
    assert.equal(cannotHaveWritten(file, writeScope(cmd, d), clean, fsProbe(), EXACT), false);
    // a target that is itself a symlink, and a hard-linked target
    await symlink(file, path.join(d, "alias.json"));
    assert.equal(cannotHaveWritten(file, writeScope(`curl -s https://x -o ${d}/alias.json`, d), clean, fsProbe(), EXACT), false);
  });

  it("root's /tmp symlink is followed (macOS), so /tmp targets resolve where they land", { skip: POSIX_LINKS }, async () => {
    const p = fsProbe().canonical("/tmp/cocheck-nothing.json");
    assert.ok(p !== undefined && p.endsWith("/tmp/cocheck-nothing.json"));
  });

  it("a curl config file refuses every curl exclusion", async () => {
    const home = await tmp("curlrc");
    assert.equal(fsProbe({ HOME: home }).curlConfig(), false);
    await writeFile(path.join(home, ".curlrc"), "remote-name-all\n");
    assert.equal(fsProbe({ HOME: home }).curlConfig(), true);
    const probe = fsProbe({ HOME: home });
    assert.equal(cannotHaveWritten(`${W}/model.xlsx`, writeScope("curl -s https://x -o /tmp/a.json", W), clean, probe, EXACT), false);
  });
});

describe("review: each way the first cut could give a wrong single owner", () => {
  const F = `${W}/target.txt`;
  it("1: a hooked child counts as clean only with a trusted start record of its kind", () => {
    const py = `python3 -c "print(1)"`;
    assert.equal(excluded(py, F, { ...clean, starts: [] }), false, "no start record: the hook may never have loaded");
    assert.equal(excluded(py, F, { ...clean, starts: starts(1, "/opt/homebrew/bin/node") }), false, "a node start proves nothing for python");
    assert.equal(excluded(py, F, { ...clean, starts: starts(1, "/w/.venv/bin/python3") }), false, "an interpreter outside the system folders");
    assert.equal(excluded(py, F, { ...clean, starts: [...starts(1), ...starts(1, "/w/python3", 300)] }), false, "one untrusted start spoils the kind");
    assert.equal(excluded(py, F, { ...clean, starts: starts(1) }), true);
    assert.equal(excluded(`node -e "1"`, F, { ...clean, starts: starts(1) }), false);
    for (const cmd of [`PYTHONPATH=; python3 -c "open('target.txt','w')"`, `NODE_OPTIONS=; node -e "require('fs').writeFileSync('target.txt','x')"`, `./python3 -I -c "print(1)"`, `./bin/node x.js`, `.venv/bin/python -c "print(1)"`]) {
      assert.equal(writeScope(cmd, W).known, false, cmd);
    }
    assert.equal(writeScope(`/usr/bin/python3 -I -c "print(1)"`, W).known, true);
  });
  it("2: open(*args), open(**kw) and rebinding sys.stdout are not read-only", () => {
    for (const code of ["a=('target.txt','w'); open(*a)", "import sys; sys.stdout=open(*['target.txt','w']); print('hi')", "open(**dict(mode='w', file='x'))", "import sys; f=open(*('target.txt','a')); sys.stdout=f; print(1)", "from sys import stdout\nstdout = 1"]) {
      assert.equal(strictReadOnlyPython(code), false, code);
    }
    assert.equal(writeScope(`python3 -I - <<'P'\na=['target.txt','w']\nopen(*a)\nP`, W).known, false);
  });
  it("3: a relative path needs a known cwd: none for a helper unless it cds to an absolute path first", () => {
    assert.equal(writeScope("rm -f a.txt", null).known, false);
    assert.equal(writeScope("cd /w && rm -f a.txt", null).known, true);
    assert.equal(writeScope("cd /w; rm -f a.txt", null).known, false, "the cd may fail and the old cwd is unknown");
    assert.equal(writeScope("cd /w; rm -f a.txt", null, { pre: lexicalProbe }).known, true, "a directory that exists at the Pre cannot fail the cd");
  });
  it("4: assignments that change splitting, lookup or the hook, and a bare relative cd (CDPATH), are refused", () => {
    for (const cmd of ["IFS=/; X=foo/target.txt; cd /w; rm -f $X", "IFS=x; X=target.txtxjunk; rm -f $X", "PATH=/w/evil; rm -f other.txt", "CDPATH=/w; cd sub; rm -f target.txt", "HOME=/w; cd /w", "BASH_ENV=/x; rm -f a", "ENV=/x; rm -f a", "PYTHONSTARTUP=x; rm a", "NODE_PATH=x; rm a", "cd sub; rm -f target.txt", "cd w && rm -f a"]) {
      assert.equal(writeScope(cmd, W).known, false, cmd);
    }
    assert.equal(writeScope("cd ./sub && rm -f a", W).known, true);
  });
  it("5: TOCTOU: a symlinked directory removed before the sweep, and a hard-linked target removed before the sweep, keep the call a suspect", { skip: POSIX_LINKS }, async () => {
    const d = await tmp("toctou");
    await mkdir(path.join(d, "folder"));
    await mkdir(path.join(d, "real"));
    const folder = path.join(d, "folder");
    // a symlinked directory the call writes through and then removes
    await symlink(path.join(d, "real"), path.join(folder, "ln"));
    const cmd1 = "curl -so ln/x https://h/a; rm ln";
    assert.equal(writeScope(cmd1, folder, { pre: fsProbe() }).known, false, "at the Pre the link is there: refused");
    const lexical = writeScope(cmd1, folder);
    await unlink(path.join(folder, "ln"));
    assert.equal(cannotHaveWritten(path.join(d, "real", "x"), lexical, clean, fsProbe(), EXACT), false, "at the sweep the directory is gone: refused");
    // a hard link the call writes through and then removes
    await writeFile(path.join(d, "real", "z"), "a");
    await link(path.join(d, "real", "z"), path.join(folder, "y"));
    const cmd2 = "curl -so y https://h/a && rm y";
    assert.equal(writeScope(cmd2, folder, { pre: fsProbe() }).known, false, "at the Pre it has two links: refused");
    const lexical2 = writeScope(cmd2, folder);
    await unlink(path.join(folder, "y"));
    assert.equal(cannotHaveWritten(path.join(d, "real", "z"), lexical2, clean, fsProbe(), EXACT), false, "gone at the sweep, written and removed by the call: refused");
    // a parent that does not exist yet at the Pre
    assert.equal(writeScope("mkdir -p newdir && curl -so newdir/x https://h/a", folder, { pre: fsProbe() }).known, false);
    // the plain case still works
    assert.equal(cannotHaveWritten(path.join(d, "real", "z"), writeScope("curl -so plain.json https://h/a", folder, { pre: fsProbe() }), clean, fsProbe(), EXACT), true);
  });
});

describe("a command that writes nothing at all is never excluded", () => {
  it("readers only (echo, ls, sleep, cat, a strict python -I read) keep the call a suspect: aliases and functions hide there", () => {
    for (const cmd of ["echo one", "ls", "sleep 60", "cat data.csv", `python3 -I -c "print(1)"`]) {
      const s = writeScope(cmd, W);
      assert.ok(s.known, cmd);
      assert.equal(cannotHaveWritten(`${W}/model.xlsx`, s, clean, lexicalProbe, EXACT), false, cmd);
    }
  });
});

describe("re-review: the hook-loaded proof is per process", () => {
  const F = `${W}/target.txt`;
  it("a versioned interpreter (python3.7 has no audit hook) next to a proven python3 is UNKNOWN", () => {
    const cmd = `python3 -c "print(1)"; python3.7 -c "open('target.txt','w')"`;
    assert.equal(writeScope(cmd, W).known, false);
    assert.equal(excluded(cmd, F, { ...clean, starts: starts(1) }), false);
    assert.equal(writeScope(`python3.12 -I -c "print(1)"`, W).known, true, "a strict -I run needs no hook");
  });
  it("two python3 runs need two start records from distinct processes (a sibling whose tag lookup failed leaves none)", () => {
    const cmd = `python3 -c "print(1)"; python3 -c "open('target.txt','w')"`;
    assert.deepEqual(writeScope(cmd, W).known && writeScope(cmd, W), { known: true, targets: [], observed: true, observedKinds: ["python"], runs: { python: 2, node: 0 }, curl: false });
    assert.equal(excluded(cmd, F, { ...clean, starts: starts(1) }), false);
    assert.equal(excluded(cmd, F, { ...clean, starts: [{ path: "/usr/bin/python3", pid: 7, ppid: 1 }, { path: "/usr/bin/python3", pid: 7, ppid: 1 }] }), false, "one process twice");
    assert.equal(excluded(cmd, F, { ...clean, starts: [{ path: "/usr/bin/python3", pid: 7, ppid: 1 }, { path: "/usr/bin/python3", pid: 8, ppid: 7 }] }), false, "the second is the first one's own child");
    assert.equal(excluded(cmd, F, { ...clean, starts: starts(2) }), true);
  });
  it("a loop multiplies the runs: three iterations need three start records", () => {
    const cmd = `for t in a b c; do python3 -c "print('$t')"; done`;
    assert.equal(excluded(cmd, F, { ...clean, starts: starts(2) }), false);
    assert.equal(excluded(cmd, F, { ...clean, starts: starts(3) }), true);
    const arr = `T=(a b c d); for t in "\${T[@]}"; do node -e "1"; done`;
    assert.equal(excluded(arr, F, { ...clean, starts: [...starts(4), ...starts(3, "/opt/homebrew/bin/node", 200)] }), false);
    assert.equal(excluded(arr, F, { ...clean, starts: [...starts(4), ...starts(4, "/opt/homebrew/bin/node", 200)] }), true);
  });
});

// ---- the timeline: synthetic replays of the two buckets ----

const T0 = 1_800_000_000_000;
let sid = 0;
const found = (file: string, at: number, credited: string[], kept = "whole"): RawState => {
  const id = ++sid;
  return { id, step_id: id + 1, task_id: 1, file_path: file, sha256: `h${id}`, prev_sha256: kept === "gone" ? `p${id}` : null, phase: "Post", calls_open_json: JSON.stringify(credited), credited_json: JSON.stringify(credited), size: 1, kept, note: "", ts: new Date(T0 + at).toISOString() };
};
const bash = (id: string, agent: string, cmd: string, at: number, end: number): RawOp =>
  call(id, { tool: "Bash", cmd, at: T0 + at, end: T0 + end, extra: { agent_id: agent, agent_type: "general-purpose", tagged: true, hook: { wrote: 0, spawned: false, covered: true, starts: starts(4) }, cwd: RAW } });

function replayBucket(ops: RawOp[], states: RawState[], exclusion: boolean): Change[] {
  const all = [prompt("s1", ["go"]), ...ops, stop("s1")];
  const seed = { ...found(`${W}/seed.txt`, 0, []), step_id: 1 };
  const fx: ReplayFixture = { name: "write-scope-exclusion", folder: W, host: "claude", ops: all, fileStates: [seed, ...states], evidence: {}, golden: {} };
  const input: TimelineInput = { taskId: 1, build: "t", ops: all, fileStates: fx.fileStates, folder: W, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, host: "claude", ...(exclusion ? { cannotWrite: cannotWriteFromFixture(fx) } : {}) };
  const t = buildTimeline(input);
  const out = new Map<string, Change>();
  for (const r of t.requests) for (const run of r.runs) for (const c of run.calls) for (const ch of c.changes ?? []) out.set(ch.id, ch);
  for (const ch of t.unplaced) out.set(ch.id, ch);
  return states.map((s) => out.get(`c${s.id}`)!);
}
const who = (ch: Change) => ({ kind: ch.by.kind, calls: [...ch.by.calls].sort() });

describe("synthetic replays of the recorded buckets (timeline)", () => {
  const bucketA = () => {
    const ops = [bash("h4", H4, cmdA_H4(RAW), 0, 4000), bash("h6", H6, cmdA_H6(RAW), 2000, 3000)];
    const states = TICKERS_A.map((t) => found(`${RAW}/yahoo_${t}.json`, 3010, ["h4", "h6"]));
    return { ops, states };
  };
  const bucketB = () => {
    const ops = [bash("h5", H5, cmdB_H5(RAW), 0, 4000), bash("h6", H6, cmdB_H6(RAW), 2000, 3500)];
    const states = TICKERS_B.filter((t) => t !== "KBND").map((t) => found(`${RAW}/yahoo_${t}.json`, 3510, ["h5", "h6"], "gone"));
    return { ops, states };
  };

  it("red: without the exclusion both buckets read as 'can't tell which'", () => {
    for (const b of [bucketA(), bucketB()]) for (const ch of replayBucket(b.ops, b.states, false)) assert.equal(ch.by.kind, "joint");
  });

  it("bucket A: Helper 6 alone created the files", () => {
    const b = bucketA();
    for (const ch of replayBucket(b.ops, b.states, true)) assert.deepEqual(who(ch), { kind: "call", calls: ["h6"] });
  });

  it("bucket B: Helper 6 alone removed the files", { skip: POSIX_REPLAY }, () => {
    const b = bucketB();
    for (const ch of replayBucket(b.ops, b.states, true)) assert.deepEqual(who(ch), { kind: "call", calls: ["h6"] });
  });

  it("with three calls open and only one excluded, the change stays joint between the other two", () => {
    const ops = [bash("h4", H4, cmdA_H4(RAW), 0, 4000), bash("h6", H6, cmdA_H6(RAW), 2000, 3000), bash("hx", H5, "bash fetch.sh", 1000, 3500)];
    const [ch] = replayBucket(ops, [found(`${RAW}/yahoo_CEMB.json`, 3010, ["h4", "h6", "hx"])], true);
    assert.deepEqual(who(ch!), { kind: "joint", calls: ["h6", "hx"] });
  });
});

describe("replay harness: recorded run", () => {
  it("as recorded: 126 of 167 exact; bucket A's 41 stay joint (the run's logs predate start records, so H4's Python is unproven)", { skip: POSIX_REPLAY }, () => {
    const f = readFixture("recorded-run-c");
    const s = score(f, buildTimeline);
    assert.equal(s.changes, 167);
    assert.equal(s.wrongSingle, 0, s.misses.join("\n"));
    assert.equal(s.wronglyOutside, 0, s.misses.join("\n"));
    assert.equal(s.exact, 126, s.misses.join("\n"));
    assert.equal(s.joint, 41);
    assert.ok(s.misses.filter((m) => m.includes("joint")).every((m) => /pricefeed_/.test(m)));
  });

  it("with the start record today's hook would log for H4's Python child: 167 of 167 exact", { skip: POSIX_REPLAY }, () => {
    const f = readFixture("recorded-run-c");
    const ops = f.ops.map((o) => {
      const a = JSON.parse(o.args_json ?? "{}");
      if (typeof a.tool_use_id !== "string" || !a.tool_use_id.endsWith("9ogxPbiK")) return o;
      return { ...o, args_json: JSON.stringify({ ...a, hook: { ...a.hook, starts: starts(3, "/opt/homebrew/opt/python@3.13/bin/python3.13") } }) };
    });
    const s = score({ ...f, ops }, buildTimeline);
    assert.equal(s.exact, 167, s.misses.join("\n"));
    assert.equal(s.wrongSingle + s.wronglyOutside, 0);
  });

  it("a recorded run without exclusion: the 52 steps are joint, none wrong", async () => {
    const { replayInput } = await import("./helpers/attribution-replay.ts");
    const f = readFixture("recorded-run-c");
    const s = score(f, buildTimeline, replayInput(f, true, false));
    assert.equal(s.joint, 52);
    assert.equal(s.exact, 115);
    assert.equal(s.wrongSingle + s.wronglyOutside, 0);
  });

  it("the exclusion never removes a golden writer in the recorded runs (scores unchanged where nothing was joint)", () => {
    const expect: Record<string, number> = { "recorded-run-b": 116, "recorded-run-a": 143 };
    for (const [name, exact] of Object.entries(expect)) {
      const s = score(readFixture(name), buildTimeline);
      assert.equal(s.exact, exact, s.misses.join("\n"));
      assert.equal(s.wrongSingle + s.wronglyOutside, 0);
    }
  });
});

// ---- live: the adapter excludes at the sweep, and the ledger holds the narrowed credit ----

async function live() {
  const home = await tmp("home");
  const folder = await tmp("folder");
  const raw = path.join(folder, "data", "raw");
  await mkdir(raw, { recursive: true });
  await writeFile(path.join(raw, "spdji_dashboard_apac_fi_2026-02.pdf"), "%PDF");
  await mkdir(evidenceDir(home), { recursive: true });
  await writeFile(rootsFile(home), JSON.stringify([folder]) + "\n");
  let clock = Date.parse("2026-10-23T12:00:00Z");
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>, taggedCall = false) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: raw, hook_event_name: "", ...over } as HookPayload, { ...opts, taggedCall });
  };
  const ag = (n: string) => ({ agent_id: n, agent_type: "general-purpose" });
  const pre = (id: string, agent: string, command: string, tagged = true) => send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command }, ...ag(agent) }, tagged);
  const post = (id: string, agent: string, command: string) => send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command }, ...ag(agent) });
  const credits = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).filter((s) => s.prevSha256 !== null || s.credited.length > 0).map((s) => `${path.basename(s.filePath)}:${[...s.credited].sort().join("+")}`);
    } finally {
      l.close();
    }
  };
  /** What a hooked child's guard logs when it loads and finds the tag. */
  let pid = 1000;
  const started = async (call: string, interpreter = "/usr/bin/python3", n = 1) => {
    for (let i = 0; i < n; i++) await appendFile(path.join(evidenceDir(home), `writes-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ v: 1, call, agent: "x", pid: ++pid, ppid: 1, ts: clock, op: "start", path: interpreter, via: "python" }) + "\n");
  };
  return { home, folder, raw, pre, post, credits, send, started };
}

describe("live: the adapter's sweep", () => {
  it("bucket A live: files H6 curls while H4's call is open are credited to H6 alone", { skip: POSIX_REPLAY }, async () => {
    const L = await live();
    await L.send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await L.pre("h4", H4, cmdA_H4(L.raw));
    await L.started("h4", "/usr/bin/python3", 3); // its loop starts Python three times
    await L.pre("h6", H6, cmdA_H6(L.raw));
    for (const t of ["CEMB", "HYEM"]) await writeFile(path.join(L.raw, `yahoo_${t}.json`), "{}");
    await L.post("h6", H6, cmdA_H6(L.raw));
    assert.deepEqual(L.credits().filter((c) => c.startsWith("yahoo_")).sort(), ["yahoo_CEMB.json:h6", "yahoo_HYEM.json:h6"]);
  });

  it("red, live (review 1): H4 tagged but its Python never logged a start record (the hook did not load): joint", async () => {
    const L = await live();
    await L.send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await L.pre("h4", H4, cmdA_H4(L.raw));
    await L.pre("h6", H6, cmdA_H6(L.raw));
    await writeFile(path.join(L.raw, "yahoo_CEMB.json"), "{}");
    await L.post("h6", H6, cmdA_H6(L.raw));
    assert.deepEqual(L.credits().filter((c) => c.startsWith("yahoo_")), ["yahoo_CEMB.json:h4+h6"]);
  });

  it("red, live (review 1): H4's start record names a venv interpreter: joint", async () => {
    const L = await live();
    await L.send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await L.pre("h4", H4, cmdA_H4(L.raw));
    await L.started("h4", path.join(L.folder, ".venv/bin/python3"));
    await L.pre("h6", H6, cmdA_H6(L.raw));
    await writeFile(path.join(L.raw, "yahoo_CEMB.json"), "{}");
    await L.post("h6", H6, cmdA_H6(L.raw));
    assert.deepEqual(L.credits().filter((c) => c.startsWith("yahoo_")), ["yahoo_CEMB.json:h4+h6"]);
  });

  it("red, live (review 3): a helper's relative target with no cd to an absolute path keeps it a suspect (its payload cwd is the main thread's)", async () => {
    const L = await live();
    await L.send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await L.pre("h4", H4, "curl -s https://x/y -o yahoo_KBND.json");
    await L.pre("h6", H6, cmdA_H6(L.raw));
    await writeFile(path.join(L.raw, "yahoo_CEMB.json"), "{}");
    await L.post("h6", H6, cmdA_H6(L.raw));
    assert.deepEqual(L.credits().filter((c) => c.startsWith("yahoo_")), ["yahoo_CEMB.json:h4+h6"]);
  });

  it("red, live (review 5): a target that is a hard link at the Pre keeps the call a suspect", async () => {
    const L = await live();
    await writeFile(path.join(L.folder, "other.json"), "{}");
    await link(path.join(L.folder, "other.json"), path.join(L.raw, "y.json"));
    const cmd = `cd ${L.raw} && curl -s https://x/y -o y.json && rm y.json`;
    await L.send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await L.pre("h4", H4, cmd);
    await L.pre("h6", H6, cmdA_H6(L.raw));
    await writeFile(path.join(L.folder, "other.json"), "{\"x\":1}");
    await unlink(path.join(L.raw, "y.json"));
    await L.post("h6", H6, cmdA_H6(L.raw));
    // H4 wrote it through the hard link: it stays a suspect. (H6 stays one too: its targets that are gone at the sweep are ones it both curls
    // and removes, which could have been links; conservative, never wrong.)
    assert.deepEqual(L.credits().filter((c) => c.startsWith("other")), ["other.json:h4+h6"]);
  });

  it("red, live: the same with H4 untagged (its Python unobserved) stays joint", async () => {
    const L = await live();
    await L.send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await L.pre("h4", H4, cmdA_H4(L.raw), false);
    await L.pre("h6", H6, cmdA_H6(L.raw));
    await writeFile(path.join(L.raw, "yahoo_CEMB.json"), "{}");
    await L.post("h6", H6, cmdA_H6(L.raw));
    assert.deepEqual(L.credits().filter((c) => c.startsWith("yahoo_")), ["yahoo_CEMB.json:h4+h6"]);
  });

  it("bucket B live: files H6 removes while H5's call is open are credited to H6 alone", async () => {
    const L = await live();
    for (const t of ["3011.HK", "IDEM.L"]) await writeFile(path.join(L.raw, `yahoo_${t}.json`), "{}");
    await L.send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await L.pre("h5", H5, cmdB_H5(L.raw));
    await L.pre("h6", H6, cmdB_H6(L.raw));
    for (const t of ["3011.HK", "IDEM.L"]) await rm(path.join(L.raw, `yahoo_${t}.json`));
    await L.post("h6", H6, cmdB_H6(L.raw));
    assert.deepEqual(L.credits().filter((c) => c.startsWith("yahoo_")).sort(), ["yahoo_3011.HK.json:h6", "yahoo_IDEM.L.json:h6"]);
  });

  it("live: a user symlink in H4's target directory keeps H4 a suspect", async () => {
    const L = await live();
    await mkdir(path.join(L.folder, "elsewhere"));
    await symlink(path.join(L.folder, "elsewhere"), path.join(L.raw, "lnk"));
    const cmd = `cd ${L.raw}; curl -s https://x/y -o lnk/yahoo_CEMB.json`;
    await L.send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    await L.pre("h4", H4, cmd);
    await L.pre("h6", H6, cmdA_H6(L.raw));
    await writeFile(path.join(L.raw, "yahoo_CEMB.json"), "{}");
    await L.post("h6", H6, cmdA_H6(L.raw));
    assert.deepEqual(L.credits().filter((c) => c.startsWith("yahoo_")), ["yahoo_CEMB.json:h4+h6"]);
  });
});

// ---- the display: a joint step never links one candidate's call ----

describe("rail: a 'can't tell which' step links no single candidate's call", () => {
  it("joint changes carry no call; a change credited to one call links that call", async () => {
    const { buildRailModel } = await import("../src/timeline/rail/model.ts");
    const ops = [prompt("s1", ["go"]), bash("j1", H4, "bash a.sh", 0, 4000), bash("j2", H6, "bash b.sh", 1000, 3000), bash("one", H6, "bash c.sh", 5000, 6000), stop("s1")];
    const seed = { ...found(`${W}/seed.txt`, 0, []), step_id: 1 };
    const states = [found(`${RAW}/yahoo_A.json`, 3010, ["j1", "j2"]), found(`${RAW}/yahoo_B.json`, 3010, ["j1", "j2"]), found(`${RAW}/yahoo_C.json`, 6010, ["one"])];
    const input: TimelineInput = { taskId: 1, build: "t", ops, fileStates: [seed, ...states], folder: W, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, host: "claude" };
    const m = buildRailModel(buildTimeline(input));
    const stopOf = (name: string) => m.stops.find((s) => s.change?.file.endsWith(name))!;
    assert.equal(stopOf("yahoo_A.json").lane, "unsure");
    assert.equal(stopOf("yahoo_A.json").call, undefined, JSON.stringify(stopOf("yahoo_A.json").call));
    assert.equal(stopOf("yahoo_B.json").call, undefined);
    assert.match(stopOf("yahoo_C.json").call?.id ?? "", /one$/);
  });
});
