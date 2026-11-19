import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { TaskStore } from "../src/tasks.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { unopenedOfState } from "../src/timeline/load.ts";
import { readStoredImage } from "../src/timeline/stored-image.ts";
import { macOnly } from "./helpers/platform.ts";
import {
  hasSealHeader,
  KEY_MISSING,
  memoryKeyProvider,
  NO_INDEX_MARKER,
  readSealed,
  sealBytes,
  sealLayer,
  setKeyProvider,
  withPlainPaths,
  writeSealed,
  type KeyProvider,
} from "../src/seal.ts";
import { workbookClaims, trackedClaims } from "./helpers/claims.ts";

// The file copies in the store are encrypted at rest. The key comes from an injected provider (or the test bootstrap's `security`
// stand-in); no case here reaches the real Keychain.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const PLAIN = "ALPHA-BRAVO-CHARLIE secret copy bytes\n";

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => setKeyProvider(memoryKeyProvider(randomBytes(32))));
afterEach(async () => {
  setKeyProvider(null);
  for (const c of cleanups.splice(0).reverse()) await c(); // the last opened closes first: Windows will not delete a database that is still open
});

const noKey: KeyProvider = { get: () => null };

async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Every file under `dir`. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

const holdsPlain = async (file: string, needle = "ALPHA-BRAVO"): Promise<boolean> => (await readFile(file)).includes(Buffer.from(needle));
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: { code?: string }) => e.code);

async function storeSetup() {
  const home = await temp("cocheck-s003-home-");
  const folder = await temp("cocheck-s003-folder-");
  const ledger = openLedger(home);
  cleanups.push(async () => ledger.close());
  const tasks = new TaskStore(ledger, home, [createFilesLayer()]);
  return { home, folder, ledger, tasks, file: (n: string) => path.join(folder, n) };
}

describe("case 1: every copy writer produces ciphertext", () => {
  it("the task store's baseline and round copies are sealed and hold none of the plaintext", async () => {
    const t = await storeSetup();
    await writeFile(t.file("a.txt"), PLAIN);
    const id = await t.tasks.touch("c", t.file("a.txt"));
    t.ledger.recordOp({ taskId: id, tool: "cocheck_write", args: { path: t.file("a.txt") }, intent: "edit", clientName: "c", durationMs: 1, resultCode: "OK" });
    const check = async (): Promise<number> => {
      const copies = filesUnder(path.join(t.home, "tasks", String(id))).filter((f) => /round-\d+/.test(f));
      for (const f of copies) {
        assert.ok(hasSealHeader(await readFile(f)), `${f} is sealed`);
        assert.equal(await holdsPlain(f), false, `${f} holds no plaintext`);
      }
      return copies.length;
    };
    assert.ok((await check()) >= 1, "the baseline copy exists");
    await writeFile(t.file("a.txt"), PLAIN + "more\n");
    await t.tasks.submit("c", "first", false);
    assert.ok((await check()) >= 1, "the round copy exists");
  });

  it("the hook sweep's per-step states are sealed, named by the plaintext hash, and read back", async () => {
    const home = await temp("cocheck-s003-hook-home-");
    const folder = await temp("cocheck-s003-hook-folder-");
    const file = path.join(folder, "casebook.xlsx");
    await copyFile(path.join(FIXTURES, "probe", "S0.xlsx"), file);
    const opts = { host: "claude" as const, home, claimed: workbookClaims, folder };
    const send = async (name: string, over: Record<string, unknown> = {}) =>
      handleHook({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), cwd: folder, ...over } as HookPayload, opts);
    const tool_input = { command: "python3 edit.py", description: "A" };
    await send("claude-pre-bash.json", { tool_use_id: "toolu_A", tool_input });
    const edited = Buffer.concat([await readFile(file), Buffer.from("x")]);
    await writeFile(file, edited);
    await send("claude-post-bash.json", { tool_use_id: "toolu_A", tool_input });
    await send("claude-stop.json");
    const states = path.join(home, "tasks", "1", "states");
    const names = (await readdir(states)).filter((n) => /^[0-9a-f]{64}$/.test(n));
    assert.ok(names.length >= 2, "the first and the edited state are stored");
    for (const n of names) {
      const raw = await readFile(path.join(states, n));
      assert.ok(hasSealHeader(raw), `${n} is sealed`);
      assert.equal(sha(await readSealed(path.join(states, n))), n, "the name stays the plaintext hash");
    }
    assert.ok(names.includes(sha(edited)), "the edited bytes are stored under their plaintext hash");
    assert.ok(existsSync(path.join(home, NO_INDEX_MARKER)), "the writer left the Spotlight marker");
  });
});

describe("case 1b: the hook adopts an old folder-keyed copy into the task store as ciphertext", () => {
  it("a plaintext legacy copy ends up sealed in the store, named by its hash, with no plaintext left under the home", async () => {
    const home = await temp("cocheck-s003-adopt-home-");
    const folder = await temp("cocheck-s003-adopt-folder-");
    const ledger = openLedger(home);
    const client = `claude-hook:${folder}`;
    const taskId = ledger.openTask(client);
    ledger.close();
    const key = createHash("sha256").update(client).digest("hex").slice(0, 16);
    const copies = path.join(home, "hooks", key, "copies");
    await mkdir(copies, { recursive: true });
    const legacy = path.join(copies, sha(PLAIN));
    await writeFile(legacy, PLAIN);
    const file = path.join(folder, "notes.txt");
    await writeFile(file, PLAIN);
    const state = { files: { [file]: { copy: legacy, sha: sha(PLAIN), size: PLAIN.length, mtimeNs: "1", ino: "1", ctimeNs: "1", first: sha(PLAIN), kept: "whole" } } };
    await writeFile(path.join(home, "hooks", key, "state.json"), JSON.stringify(state));
    const opts = { host: "claude" as const, home, claimed: trackedClaims, folder, perSession: false };
    const payload = { ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", "claude-pre-bash.json"), "utf8")), cwd: folder };
    await handleHook(payload as HookPayload, opts);
    const adopted = path.join(home, "tasks", String(taskId), "states", sha(PLAIN));
    assert.ok(hasSealHeader(await readFile(adopted)), "the adopted copy is ciphertext");
    assert.equal((await readSealed(adopted)).toString(), PLAIN);
    for (const f of filesUnder(home)) {
      if (f.includes("ledger") || f.endsWith("state.json")) continue;
      assert.equal(await holdsPlain(f), false, `${f} holds no plaintext`);
    }
  });
});

describe("case 1c: the folder watch's one-round copy of a new file is read through the seal", () => {
  it("a file created in the watched folder is copied as ciphertext for the round, and the copy is gone afterwards", async () => {
    const t = await storeSetup();
    await writeFile(t.file("a.txt"), PLAIN);
    const id = await t.tasks.touch("c", t.file("a.txt"));
    await writeFile(t.file("newcomer.txt"), PLAIN);
    const summary = await t.tasks.submit("c", "a new file appeared", false);
    const row = summary.files.find((f) => f.path === t.file("newcomer.txt"));
    assert.ok(row && row.snapshotMode !== "missing", "the newcomer was read for the round (no diff of it is kept)");
    for (const f of filesUnder(path.join(t.home, "tasks", String(id)))) {
      if (f.endsWith("folder.json")) continue;
      assert.equal(await holdsPlain(f), false, `${f} holds no plaintext`);
    }
  });
});

describe("case 2: identity stays the plaintext hash; identical bytes dedup", () => {
  it("a snapshot's recorded hash is the plaintext's, and two copies of equal bytes compare equal", async () => {
    const t = await storeSetup();
    await writeFile(t.file("a.txt"), PLAIN);
    const id = await t.tasks.touch("c", t.file("a.txt"));
    const snap = t.ledger.snapshotsForTask(id).find((s) => s.filePath === t.file("a.txt"))!;
    assert.equal(snap.sha256, sha(PLAIN));
    assert.equal(sha(await readSealed(snap.snapshotPath)), sha(PLAIN));
    t.ledger.recordOp({ taskId: id, tool: "cocheck_write", args: { path: t.file("a.txt") }, intent: "noop", clientName: "c", durationMs: 1, resultCode: "OK" });
    const summary = await t.tasks.submit("c", "unchanged file", false);
    assert.equal(summary.rows?.length ?? 0, 0, "unchanged bytes diff to nothing even though each sealed copy differs on disk");
  });
});

describe("case 3: a missing key on read is loud, and not 'missing state'", () => {
  it("readSealed and the timeline readers raise KEY_MISSING", async () => {
    const dir = await temp("cocheck-s003-read-");
    const home = await temp("cocheck-s003-tl-home-");
    const file = path.join(dir, "x");
    await writeSealed(file, Buffer.from(PLAIN));
    const stateDir = path.join(home, "tasks", "1", "states");
    const hash = sha(PLAIN);
    await writeSealed(path.join(stateDir, hash), Buffer.from(PLAIN));
    setKeyProvider(noKey);
    assert.equal(await codeOf(readSealed(file)), KEY_MISSING);
    const stored = new Map([[hash, 10]]);
    assert.equal(await codeOf(unopenedOfState(home, 1, hash, "notes.txt", stored, [])), KEY_MISSING, "not a caveat that the file 'could not be opened'");
  });
});

describe("case 4: a missing key on write writes nothing", () => {
  it("writeSealed leaves no file and no temp file", async () => {
    const dir = await temp("cocheck-s003-write-");
    setKeyProvider(noKey);
    assert.equal(await codeOf(writeSealed(path.join(dir, "sub", "copy"), Buffer.from(PLAIN))), KEY_MISSING);
    assert.deepEqual(filesUnder(dir), []);
  });

  it("the task store takes no baseline and leaves nothing under tasks/", async () => {
    const t = await storeSetup();
    await writeFile(t.file("a.txt"), PLAIN);
    setKeyProvider(noKey);
    assert.equal(await codeOf(t.tasks.touch("c", t.file("a.txt"))), KEY_MISSING);
    assert.deepEqual(filesUnder(path.join(t.home, "tasks")), []);
  });
});

describe("case 3b: a store that holds sealed files and has no key never gets a new one", () => {
  it("writing raises KEY_MISSING and does not generate a key; an empty home still gets its first key", async () => {
    const home = await temp("cocheck-s003-lostkey-");
    await writeSealed(path.join(home, "tasks", "1", "states", sha("a")), Buffer.from("a"));
    let created = 0;
    setKeyProvider({ get: () => null, create: () => (created++, randomBytes(32)) });
    assert.equal(await codeOf(writeSealed(path.join(home, "tasks", "1", "states", sha("b")), Buffer.from("b"))), KEY_MISSING);
    assert.equal(created, 0, "no key was generated");
    assert.equal(existsSync(path.join(home, "tasks", "1", "states", sha("b"))), false);
    const fresh = await temp("cocheck-s003-freshkey-");
    await writeSealed(path.join(fresh, "tasks", "1", "states", sha("c")), Buffer.from("c"));
    assert.equal(created, 1, "a home with nothing sealed gets its first key");
  });

  it("the Keychain account follows the home's realpath, so a symlinked path finds the same key", async () => {
    const real = await temp("cocheck-s003-real-");
    const link = path.join(await temp("cocheck-s003-linkdir-"), "home");
    await symlink(real, link);
    setKeyProvider(null);
    const viaLink = path.join(link, "tasks", "1", "states", sha("x"));
    await writeSealed(viaLink, Buffer.from(PLAIN));
    setKeyProvider(null);
    assert.equal((await readSealed(path.join(real, "tasks", "1", "states", sha("x")))).toString(), PLAIN);
  });
});

describe("case 3c: a stored image under a missing key says so", () => {
  it("readStoredImage throws KEY_MISSING instead of answering 'no bytes'", async () => {
    const home = await temp("cocheck-s003-peek-");
    const hash = sha(PLAIN);
    await writeSealed(path.join(home, "tasks", "1", "states", hash), Buffer.from(PLAIN));
    setKeyProvider(noKey);
    await assert.rejects(readStoredImage(home, 1, hash), (e: Error) => e.message.includes(KEY_MISSING));
  });
});

describe("case 5: decrypted temp files are private and short-lived", () => {
  it("withPlainPaths hands out a 0700 folder and 0600 files, and removes them afterwards, on failure too", async () => {
    const dir = await temp("cocheck-s003-tmp-");
    const sealed = path.join(dir, "notes.txt");
    await writeSealed(sealed, Buffer.from(PLAIN));
    let seen = "";
    await withPlainPaths([sealed, null], async ([plain, none]) => {
      seen = path.dirname(path.dirname(plain!));
      assert.equal(none, null);
      assert.equal(path.basename(plain!), "notes.txt", "the extension survives");
      assert.equal(statSync(plain!).mode & 0o777, 0o600);
      assert.equal(statSync(seen).mode & 0o777, 0o700);
      assert.equal(await readFile(plain!, "utf8"), PLAIN);
    });
    assert.equal(existsSync(seen), false);
    await assert.rejects(withPlainPaths([sealed], async ([plain]) => {
      seen = path.dirname(path.dirname(plain!));
      throw new Error("boom");
    }));
    assert.equal(existsSync(seen), false);
  });

  it("a sealed layer's diff and snapshot leave no cocheck temp folder behind", async () => {
    const dir = await temp("cocheck-s003-layer-");
    const layer = sealLayer(createFilesLayer());
    const a = path.join(dir, "a.txt");
    await writeFile(a, PLAIN);
    const before = path.join(dir, "before.txt");
    const after = path.join(dir, "after.txt");
    const mine = () => readdirSync(tmpdir()).filter((n) => /^cocheck-(plain|snap)-/.test(n));
    const was = new Set(mine());
    assert.equal(await layer.snapshot(a, before), "copy");
    await layer.snapshot(a, after);
    await layer.diff(before, after);
    assert.ok(hasSealHeader(await readFile(before)));
    assert.deepEqual(mine().filter((n) => !was.has(n)), []);
  });
});

describe("cases 7 and 8: tamper, truncation and a wrong key fail authentication", () => {
  it("a flipped byte, a truncation and another key all raise SEAL_AUTH", async () => {
    const dir = await temp("cocheck-s003-auth-");
    const f = path.join(dir, "copy");
    await writeSealed(f, Buffer.from(PLAIN));
    const good = await readFile(f);
    const flipped = Buffer.from(good);
    flipped[flipped.length - 20] ^= 1;
    await writeFile(f, flipped);
    assert.equal(await codeOf(readSealed(f)), "SEAL_AUTH");
    await writeFile(f, good.subarray(0, good.length - 5));
    assert.equal(await codeOf(readSealed(f)), "SEAL_AUTH");
    await writeFile(f, good.subarray(0, 20));
    assert.equal(await codeOf(readSealed(f)), "SEAL_AUTH");
    await writeFile(f, good);
    assert.equal((await readSealed(f)).toString(), PLAIN);
    setKeyProvider(memoryKeyProvider(randomBytes(32)));
    assert.equal(await codeOf(readSealed(f)), "SEAL_AUTH", "a wrong key");
  });

  it("a plaintext file in the store is refused, not read", async () => {
    const dir = await temp("cocheck-s003-plain-");
    const f = path.join(dir, "copy");
    await writeFile(f, PLAIN);
    assert.equal(await codeOf(readSealed(f)), "NOT_SEALED");
  });

  it("a tampered copy never reaches the differ", async () => {
    const dir = await temp("cocheck-s003-tamper-");
    const layer = sealLayer(createFilesLayer());
    const src = path.join(dir, "a.txt");
    await writeFile(src, PLAIN);
    const before = path.join(dir, "before.txt");
    const after = path.join(dir, "after.txt");
    await layer.snapshot(src, before);
    await layer.snapshot(src, after);
    const bytes = await readFile(after);
    bytes[bytes.length - 30] ^= 1;
    await writeFile(after, bytes);
    assert.equal(await codeOf(layer.diff(before, after)), "SEAL_AUTH");
  });
});

describe("case 9: tests never reach the real Keychain", macOnly("the macOS Keychain provider"), () => {
  it("under the runner the Keychain provider refuses without a stand-in, and the bootstrap's stand-in is a temp script", async () => {
    const bin = process.env.COCHECK_SECURITY_BIN;
    assert.ok(bin && bin.startsWith(tmpdir()) && !bin.startsWith("/usr/bin"), "the bootstrap installed a temp stand-in for `security`");
    delete process.env.COCHECK_SECURITY_BIN;
    try {
      setKeyProvider(null);
      const dir = await temp("cocheck-s003-kc-");
      const f = path.join(dir, "copy");
      assert.equal(await codeOf(writeSealed(f, Buffer.from(PLAIN))), KEY_MISSING);
      assert.equal(existsSync(f), false);
    } finally {
      process.env.COCHECK_SECURITY_BIN = bin;
    }
  });

  it("the Keychain provider, through the stand-in, creates a key once and reuses it", async () => {
    setKeyProvider(null);
    const dir = await temp("cocheck-s003-kc2-");
    const f = path.join(dir, "copy");
    await writeSealed(f, Buffer.from(PLAIN));
    setKeyProvider(null); // forget the cached key: the next read asks the stand-in again
    assert.equal((await readSealed(f)).toString(), PLAIN);
  });
});

describe("case 10: the writer creates the exclusion marker", () => {
  it("a sealed write under a home leaves .metadata_never_index in that home", async () => {
    const home = await temp("cocheck-s003-marker-");
    assert.equal(existsSync(path.join(home, NO_INDEX_MARKER)), false);
    await writeSealed(path.join(home, "tasks", "1", "states", sha("x")), Buffer.from("x"));
    assert.equal(existsSync(path.join(home, NO_INDEX_MARKER)), true);
  });
});
