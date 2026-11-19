import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { workbookClaims } from "./helpers/claims.ts";

// the hook adapter lists the whole watched folder, subfolders included.'s stat filter, Stop hash and caps keep their
// meaning over the tree; version-control and dependency folders are skipped, each skip written once in words; a secret file
// (by name, at any depth) is a hash and a size only, with the line "A secret file was changed: <relative path>".
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (name: string) => path.join(FIXTURES, "probe", name);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const fixture = async (name: string, over: Record<string, unknown>): Promise<HookPayload> =>
  ({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), ...over }) as HookPayload;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type Caps = { fileBytes?: number; taskBytes?: number; scanFiles?: number; scanBytes?: number };

async function setup(opts: { caps?: Caps; files?: Record<string, string>; workbook?: boolean } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  if (opts.workbook !== false) await copyFile(probe("S0.xlsx"), path.join(folder, "casebook.xlsx"));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const put = async (rel: string, data: string) => {
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), data);
  };
  for (const [rel, data] of Object.entries(opts.files ?? {})) await put(rel, data);
  const hostOpts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, ...(opts.caps ? { caps: opts.caps } : {}) };
  const send = (name: string, over: Record<string, unknown> = {}) => fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, hostOpts));
  const call = async (id: string, command: string, act: () => Promise<void>) => {
    const tool_input = { command, description: id };
    await send("claude-pre-bash.json", { tool_use_id: id, tool_input });
    await act();
    await send("claude-post-bash.json", { tool_use_id: id, tool_input });
  };
  const stop = async () => {
    const r = await send("claude-stop.json");
    assert.ok(r.summary, "Stop returned a round summary");
    return r.summary.taskId;
  };
  const read = <T,>(fn: (l: ReturnType<typeof openLedger>) => T): T => {
    const l = openLedger(home);
    try {
      return fn(l);
    } finally {
      l.close();
    }
  };
  const storeFiles = async (taskId = 1): Promise<string[]> => (await readdir(path.join(home, "tasks", String(taskId), "states")).catch(() => [] as string[])).filter((n) => !n.startsWith(".")).sort();
  const states = (taskId = 1) => read((l) => l.fileStatesForTask(taskId));
  return { home, folder, put, call, stop, read, storeFiles, states, send };
}

/** Every file under `dir`, as bytes. */
async function everyFile(dir: string): Promise<Array<{ file: string; bytes: Buffer }>> {
  const out: Array<{ file: string; bytes: Buffer }> = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await everyFile(full)));
    else if (e.isFile()) out.push({ file: full, bytes: await readFile(full) });
  }
  return out;
}

describe("the whole tree is watched", () => {
  it("a write in a nested folder is a state event credited to its call", async () => {
    const t = await setup({ files: { "src/deep/notes.txt": "one\n" } });
    const nested = path.join(t.folder, "src", "deep", "notes.txt");
    await t.call("toolu_A", "echo two > src/deep/notes.txt", () => writeFile(nested, "two\n"));
    await t.stop();
    const mine = t.states().filter((s) => s.filePath === nested);
    assert.equal(mine.length, 2, "baseline plus the change");
    assert.equal(mine[1]!.sha256, sha("two\n"));
    assert.deepEqual(mine[1]!.credited, ["toolu_A"]);
    assert.ok((await t.storeFiles()).includes(sha("two\n")), "its bytes are in the store");
  });

  it("a file created in a new nested folder is seen", async () => {
    const t = await setup({ files: { "src/a.txt": "a\n" } });
    const fresh = path.join(t.folder, "out", "run1", "result.csv");
    await t.call("toolu_A", "make out", async () => {
      await mkdir(path.dirname(fresh), { recursive: true });
      await writeFile(fresh, "x,y\n1,2\n");
    });
    await t.stop();
    const mine = t.states().filter((s) => s.filePath === fresh);
    assert.equal(mine.length, 1);
    assert.deepEqual(mine[0]!.credited, ["toolu_A"]);
  });

  it("a nested delete and a nested rename are both recorded", async () => {
    const t = await setup({ files: { "src/gone.txt": "bye\n", "src/old.txt": "keep\n" } });
    const gone = path.join(t.folder, "src", "gone.txt");
    const oldp = path.join(t.folder, "src", "old.txt");
    const renamed = path.join(t.folder, "src", "sub", "new.txt");
    await t.call("toolu_A", "rm src/gone.txt", () => rm(gone));
    await t.call("toolu_B", "mv src/old.txt src/sub/new.txt", async () => {
      await mkdir(path.dirname(renamed), { recursive: true });
      await rename(oldp, renamed);
    });
    await t.stop();
    const all = t.states();
    assert.deepEqual(all.filter((s) => s.filePath === gone).map((s) => s.kept), ["whole", "gone"]);
    assert.deepEqual(all.filter((s) => s.filePath === oldp).map((s) => s.kept), ["whole", "gone"]);
    assert.deepEqual(all.filter((s) => s.filePath === renamed).map((s) => s.sha256), [sha("keep\n")]);
  });

  it("a nested change at Stop with no call open is a state event, never unchanged", async () => {
    const t = await setup({ files: { "a/b/c/deep.txt": "v1\n" } });
    await t.call("toolu_A", "true", async () => {});
    await writeFile(path.join(t.folder, "a", "b", "c", "deep.txt"), "v2\n");
    await t.stop();
    const mine = t.states().filter((s) => s.filePath.endsWith("deep.txt"));
    assert.deepEqual(mine.map((s) => s.sha256), [sha("v1\n"), sha("v2\n")]);
  });
});

describe("version-control and dependency folders are skipped, each skip said once", () => {
  const skipped = [".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".cache"];
  it("none of their files is stored or tracked, and each skip is one note in words", async () => {
    const files: Record<string, string> = { "src/a.txt": "a\n" };
    for (const d of skipped) files[`${d}/inner/x.js`] = `inside ${d}\n`;
    files["src/node_modules/y.js"] = "nested dependency\n";
    const t = await setup({ files });
    await t.call("toolu_A", "touch", () => writeFile(path.join(t.folder, "node_modules", "inner", "x.js"), "changed\n"));
    await t.call("toolu_B", "touch", async () => {});
    await t.stop();
    const store = await t.storeFiles();
    for (const d of skipped) assert.ok(!store.includes(sha(`inside ${d}\n`)), `${d} is not stored`);
    assert.ok(!store.includes(sha("nested dependency\n")), "a nested node_modules is skipped too");
    assert.ok(!t.states().some((s) => /node_modules|\.git\//.test(s.filePath)), "no state event for a skipped folder");
    const notes = t.read((l) => l.okOpsForTask(1, 0, l.maxOpId())).map((o) => JSON.parse(o.argsJson) as { skipped?: Array<{ folder: string; note: string }> }).flatMap((a) => a.skipped ?? []);
    const once = (folder: string) => notes.filter((n) => n.folder === folder);
    for (const d of skipped) {
      assert.equal(once(d).length, 1, `${d} is said once`);
      assert.match(once(d)[0]!.note, /skipped|not watched/i);
    }
    assert.equal(once("src/node_modules").length, 1, "a nested one is named by its relative path");
  });
});

describe("the scan caps run across the tree", () => {
  it("a file past the file cap in a subfolder is fingerprint only, with the reason, and its change is still a state", async () => {
    const t = await setup({ caps: { scanFiles: 3 }, files: { "a.txt": "1\n", "z/b.txt": "2\n", "z/y/c.txt": "3\n", "z/y/d.txt": "4\n" } });
    await t.call("toolu_A", "edit", () => writeFile(path.join(t.folder, "z", "y", "d.txt"), "four\n"));
    await t.stop();
    const hashed = t.states().filter((s) => s.kept === "hash");
    assert.ok(hashed.length >= 1, "at least one file is fingerprint only");
    for (const s of hashed) assert.match(s.note, /not copied.*more than 3 files/);
    assert.ok(hashed.every((s) => s.prevSha256 === null), "only the starting copy is limited by the scan caps");
    const nestedHashed = hashed.filter((s) => s.filePath.includes(`${path.sep}z${path.sep}`));
    assert.ok(nestedHashed.length >= 1, "the one past the cap lives in a subfolder");
    const d = t.states().filter((s) => s.filePath.endsWith("d.txt"));
    assert.equal(d.at(-1)!.sha256 === d[0]!.sha256, false, "the change to the fingerprint-only file is a state");
    assert.equal(d.at(-1)!.kept, "whole", "the written state is kept");
  });
});

describe("secret files are a hash and a size, never bytes", () => {
  const SENTINELS = { nested: "SENTINEL-NESTED-ENV-7f3a91", top: "SENTINEL-TOP-ENV-b2c4d8", pem: "SENTINEL-PEM-KEY-19ee05" };
  const files = () => ({
    "config/prod/.env": `API_KEY=${SENTINELS.nested}\n`,
    ".env": `API_KEY=${SENTINELS.top}\n`,
    "certs/server.pem": `-----BEGIN PRIVATE KEY-----\n${SENTINELS.pem}\n-----END PRIVATE KEY-----\n`,
    "src/app.txt": "plain\n",
  });

  it("no sentinel reaches the store, the ledger, a preview or the timeline JSON, and each change says so in words", async () => {
    const t = await setup({ files: files() });
    const nested = path.join(t.folder, "config", "prod", ".env");
    await t.call("toolu_A", "rotate", async () => {
      await writeFile(nested, `API_KEY=${SENTINELS.nested}-v2\n`);
      await writeFile(path.join(t.folder, ".env"), `API_KEY=${SENTINELS.top}-v2\n`);
      await writeFile(path.join(t.folder, "certs", "server.pem"), `${SENTINELS.pem}-v2\n`);
    });
    await t.stop();
    // The timeline JSON, built the way the server builds it.
    const json = await t.read(async (l) => {
      const loaded = loadRows(l, 1, "test");
      return JSON.stringify(buildTimeline(await loadTimelineInput(l, t.home, loaded, { build: "test", quickLook: false })));
    });
    const ledgerDump = t.read((l) => JSON.stringify({ steps: l.stepsForTask(1), states: l.fileStatesForTask(1), ops: l.okOpsForTask(1, 0, l.maxOpId()) }));
    const needles = Object.values(SENTINELS);
    for (const needle of needles) {
      assert.ok(!json.includes(needle), `timeline JSON has no ${needle}`);
      assert.ok(!ledgerDump.includes(needle), `ledger dump has no ${needle}`);
      for (const { file, bytes } of await everyFile(t.home)) assert.ok(!bytes.includes(needle), `${path.relative(t.home, file)} holds no ${needle}`);
    }
    const store = await t.storeFiles();
    for (const body of [`API_KEY=${SENTINELS.top}\n`, `API_KEY=${SENTINELS.top}-v2\n`, `API_KEY=${SENTINELS.nested}-v2\n`]) assert.ok(!store.includes(sha(body)), "the secret's bytes are not in the store");
    const secrets = t.states().filter((s) => /(^|[\\/])\.env$|server\.pem$/.test(s.filePath));
    assert.equal(secrets.length, 6, "baseline and one change for each of the three");
    for (const s of secrets) {
      assert.equal(s.kept, "hash");
      assert.match(s.sha256, /^[0-9a-f]{64}$/);
      assert.ok(s.size > 0);
    }
    const changes = secrets.filter((s) => s.prevSha256 !== null);
    assert.equal(changes.length, 3);
    const rel = (p: string) => path.relative(t.folder, p).replaceAll("\\", "/");
    for (const s of changes) assert.ok(s.note.includes(`A secret file was changed: ${rel(s.filePath)}`), `the line names ${rel(s.filePath)}`);
    assert.equal(sha(`API_KEY=${SENTINELS.nested}-v2\n`), secrets.find((s) => s.filePath === nested && s.prevSha256 !== null)!.sha256, "the hash is of the file's bytes");
  });

  it("a deleted secret and the other secret names are covered too", async () => {
    const names = [".env.local", "id_rsa", "id_ed25519.pub", "credentials.json", "secrets.yaml", ".npmrc", ".netrc", ".pypirc", "a.key", "b.p12", "c.pfx"];
    const t = await setup({ files: Object.fromEntries(names.map((n) => [`deep/${n}`, `TOKEN-${n}\n`])) });
    await t.call("toolu_A", "rm", () => rm(path.join(t.folder, "deep", ".npmrc")));
    await t.stop();
    const store = await t.storeFiles();
    for (const n of names) assert.ok(!store.includes(sha(`TOKEN-${n}\n`)), `${n} is not stored`);
    const gone = t.states().find((s) => s.kept === "gone" && s.filePath.endsWith(".npmrc"))!;
    assert.match(gone.note, /A secret file was changed: deep\/\.npmrc/);
    assert.ok(!t.states().some((s) => /\.example$|app\.txt$/.test(s.filePath) && s.note.includes("secret")));
  });

  it("a non-secret look-alike name is an ordinary file", async () => {
    const t = await setup({ files: { "environment.txt": "plain\n", "keys.txt": "plain2\n" } });
    await t.call("toolu_A", "x", async () => {});
    await t.stop();
    const store = await t.storeFiles();
    assert.ok(store.includes(sha("plain\n")) && store.includes(sha("plain2\n")));
  });
});

describe("links are never followed at any depth", () => {
  it("a nested link, and a folder replaced by a link, never put outside bytes in the store", async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-outside-")));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, "out.txt"), "OUTSIDE-BYTES-1\n");
    const t = await setup({ files: { "sub/keep.txt": "k\n", "dir/inner.txt": "i\n" } });
    await symlink(path.join(outside, "out.txt"), path.join(t.folder, "sub", "link.txt"));
    await t.call("toolu_A", "swap", async () => {
      await rm(path.join(t.folder, "dir"), { recursive: true });
      await symlink(outside, path.join(t.folder, "dir"));
      await writeFile(path.join(outside, "inner.txt"), "OUTSIDE-BYTES-2\n");
    });
    await t.call("toolu_B", "swap2", () => writeFile(path.join(t.folder, "sub", "keep.txt"), "k2\n"));
    await t.stop();
    const store = await t.storeFiles();
    assert.ok(!store.includes(sha("OUTSIDE-BYTES-1\n")) && !store.includes(sha("OUTSIDE-BYTES-2\n")));
    assert.ok(!t.states().some((s) => s.filePath.endsWith("link.txt")));
    const inner = t.states().filter((s) => s.filePath.endsWith("inner.txt"));
    assert.deepEqual(inner.map((s) => s.kept), ["whole", "gone"]);
  });
});

describe("a folder with no workbook is an ordinary task", () => {
  it("only src/app.py, a README and a PNG: a baseline, then a credited change on edit", async () => {
    const t = await setup({ workbook: false, files: { "src/app.py": "print(1)\n", "README.md": "# hi\n" } });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await writeFile(path.join(t.folder, "pic.png"), png);
    const app = path.join(t.folder, "src", "app.py");
    await t.call("toolu_A", "sed -i s/1/2/ src/app.py", () => writeFile(app, "print(2)\n"));
    await t.stop();
    const all = t.states();
    assert.deepEqual(all.filter((s) => s.prevSha256 === null).map((s) => path.relative(t.folder, s.filePath).replaceAll("\\", "/")).sort(), ["README.md", "pic.png", "src/app.py"]);
    const mine = all.filter((s) => s.filePath === app);
    assert.equal(mine.length, 2);
    assert.deepEqual(mine[1]!.credited, ["toolu_A"]);
    assert.ok((await t.storeFiles()).includes(sha(png)), "the picture is stored whole");
  });

  it("a claimed workbook is kept whole on its own allowance and never uses up the general caps", async () => {
    const t = await setup({ caps: { scanFiles: 1 }, files: { "a.txt": "a\n", "b.txt": "b\n" } });
    await t.call("toolu_A", "true", async () => {});
    await t.stop();
    const first = t.states().filter((s) => s.prevSha256 === null);
    assert.equal(first.find((s) => s.filePath.endsWith("casebook.xlsx"))!.kept, "whole");
    assert.equal(first.find((s) => s.filePath.endsWith("a.txt"))!.kept, "whole", "the one general slot goes to the first other file");
    assert.equal(first.find((s) => s.filePath.endsWith("b.txt"))!.kept, "hash");
  });
});

describe("a Python environment is skipped by its marker, whatever its name", () => {
  const notesOf = (t: Awaited<ReturnType<typeof setup>>) =>
    t.read((l) => l.okOpsForTask(1, 0, l.maxOpId())).map((o) => JSON.parse(o.argsJson) as { skipped?: Array<{ folder: string; note: string }> }).flatMap((a) => a.skipped ?? []);

  it("a .pptenv with pyvenv.cfg at the first sweep, created then deleted, leaves zero file states and one note naming an environment", async () => {
    const t = await setup({ files: { "src/a.txt": "a\n", ".pptenv/pyvenv.cfg": "home = /x\n", ".pptenv/lib/site/p.py": "print(1)\n" } });
    await t.call("toolu_A", "mkdir", async () => {
      await mkdir(path.join(t.folder, ".pptenv", "lib", "site"), { recursive: true });
      await writeFile(path.join(t.folder, ".pptenv", "lib", "site", "q.py"), "q\n");
    });
    await t.call("toolu_B", "rm", () => rm(path.join(t.folder, ".pptenv"), { recursive: true, force: true }));
    await t.stop();
    assert.deepEqual(t.states().filter((s) => s.filePath.includes(".pptenv")), [], "no file state under the environment");
    const mine = notesOf(t).filter((n) => n.folder === ".pptenv");
    assert.equal(mine.length, 1, "said once");
    assert.match(mine[0]!.note, /environment/i);
    const steps = t.read((l) => l.okOpsForTask(1, 0, l.maxOpId())).filter((o) => /pptenv/.test(o.argsJson) && !/"skipped"/.test(o.argsJson));
    assert.equal(steps.length, 0, "a call writing only into the environment makes no step");
  });

  it("a conda-meta folder marks an environment too, at any depth", async () => {
    const t = await setup({ files: { "x/envs/e1/conda-meta/history": "h\n", "x/envs/e1/bin/py": "p\n", "x/keep.txt": "k\n" } });
    await t.call("toolu_A", "touch", async () => {});
    await t.stop();
    assert.ok(!t.states().some((s) => s.filePath.includes("e1")), "no state under the conda environment");
    assert.equal(notesOf(t).filter((n) => n.folder === "x/envs/e1").length, 1);
    assert.ok(t.states().some((s) => s.filePath.endsWith("keep.txt")), "its sibling file is still recorded");
  });

  it("an ordinary folder with its own .gitignore is still walked and recorded", async () => {
    const t = await setup({ files: { "work/.gitignore": "*\n", "work/data.txt": "d\n", "work/sub/more.txt": "m\n" } });
    await t.call("toolu_A", "edit", () => writeFile(path.join(t.folder, "work", "data.txt"), "d2\n"));
    await t.stop();
    const paths = t.states().map((s) => s.filePath.replaceAll("\\", "/"));
    assert.ok(paths.some((p) => p.endsWith("work/data.txt")), "data.txt recorded");
    assert.ok(paths.some((p) => p.endsWith("work/sub/more.txt")), "nested file recorded");
    assert.equal(notesOf(t).filter((n) => n.folder === "work").length, 0, "no skip note");
  });

  it("the task folder is still watched when it is itself an environment", async () => {
    const t = await setup({ files: { "pyvenv.cfg": "home = /x\n", "a.txt": "a\n" } });
    await t.call("toolu_A", "edit", () => writeFile(path.join(t.folder, "a.txt"), "b\n"));
    await t.stop();
    assert.ok(t.states().some((s) => s.filePath.endsWith("a.txt")), "a.txt recorded");
    assert.equal(notesOf(t).length, 0, "the task folder is not skipped");
  });
});
