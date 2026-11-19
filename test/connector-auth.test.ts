// SecretStore set/delete on all three OSes and `cocheck connector auth`. Stand-in stores only: the macOS
// code runs against the test bootstrap's `security` stand-in (COCHECK_SECURITY_BIN), Windows against injected fakes
// `secret-tool`. A guard replaces the running OS's real secretStore for every test here and throws if anything reaches it.
// Must not happen: the value reaching argv or output, set/delete touching CoCheck's own sealing key, auth silently storing nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli.ts";
import { readStdinValue, runConnectorAuth, type AuthRun } from "../src/connector-auth.ts";
import { SecretStoreError, createWin32, platform, platformFor, type Platform, type Win32Deps } from "../src/platform/index.ts";

type Store = Platform["secretStore"];
const SECRET = "s3cr3t-T370-9d41c7-do-not-leak";
const SEAL_SERVICE = "cocheck-sealing-key"; // any non-connector service stands for the sealing key's item
const SEAL_KEY = Buffer.alloc(32, 0xab);
const BYTES = Buffer.from([0x00, 0xff, 0x80, 0x22, 0x5c, 0x0a, 0x24, 0x27]); // quotes, backslash, newline, dollar, non-UTF-8: must round-trip

/** Guard against any real credential store: the running OS's secretStore throws and records the reach. */
let reached: string[] = [];
let restoreGuard: () => void = () => {};
function installGuard(): void {
  reached = [];
  const store = platform().secretStore as unknown as Record<string, unknown>;
  const saved = { ...store };
  for (const member of ["get", "create", "set", "delete"]) {
    store[member] = () => {
      reached.push(member);
      throw new Error(`GUARD: a test reached the real credential store (secretStore.${member})`);
    };
  }
  restoreGuard = () => void Object.assign(store, saved);
}
beforeEach(installGuard);
afterEach(() => restoreGuard());

/** In-memory stand-in with the shared shape; `sealing` is the item that must survive. */
function memoryStore(failSet = false): Store & { items: Map<string, Buffer> } {
  const items = new Map<string, Buffer>();
  const k = (s: string, a: string) => `${s}/${a}`;
  return {
    items,
    get: (s, a) => items.get(k(s, a)) ?? null,
    create: (s, a, v) => void items.set(k(s, a), v),
    set(s, a, v) {
      if (failSet) throw new SecretStoreError("the store is locked");
      items.set(k(s, a), v);
    },
    delete: (s, a) => items.delete(k(s, a)),
    location: (s) => `memory ${s}`,
  };
}

function home(credentials: unknown, id = "toy"): string {
  const h = mkdtempSync(path.join(tmpdir(), "cocheck-home-"));
  if (credentials !== undefined) {
    mkdirSync(path.join(h, "connectors", id), { recursive: true });
    writeFileSync(path.join(h, "connectors", id, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id, credentials }));
  }
  return h;
}
const run = (h: string, store: Store, value = SECRET): AuthRun & { reads: number } => {
  const r = { home: h, store, reads: 0, readValue: async () => (r.reads++, value) };
  return r;
};

describe("the guard", () => {
  it("throws and records when the real store is reached", () => {
    assert.throws(() => platform().secretStore.set("cocheck-connector:x", "a", Buffer.from("v")), /GUARD/);
    assert.throws(() => platform().secretStore.delete("cocheck-connector:x", "a"), /GUARD/);
    assert.deepEqual(reached, ["set", "delete"]);
  });
});

describe("cocheck connector auth", () => {
  it("stores the stdin value under cocheck-connector:<id> / <credential>", async () => {
    const store = memoryStore();
    const r = await runConnectorAuth(["toy", "--name", "token"], run(home(["token"]), store));
    assert.equal(r.exitCode, 0);
    assert.deepEqual([...store.items.entries()], [["cocheck-connector:toy/token", Buffer.from(SECRET)]]);
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
    assert.deepEqual(reached, []);
  });

  it("accepts a manifest that declares credentials as objects with a name", async () => {
    const store = memoryStore();
    const r = await runConnectorAuth(["toy", "--name", "token"], run(home([{ name: "token" }]), store));
    assert.equal(r.exitCode, 0);
    assert.equal(store.items.size, 1);
  });

  it("--delete removes it, and says so when nothing was stored", async () => {
    const store = memoryStore();
    const h = home(["token"]);
    await runConnectorAuth(["toy", "--name", "token"], run(h, store));
    const gone = await runConnectorAuth(["toy", "--name", "token", "--delete"], run(h, store));
    assert.equal(gone.exitCode, 0);
    assert.match(gone.stdout, /Removed/);
    assert.equal(store.items.size, 0);
    assert.match((await runConnectorAuth(["toy", "--name", "token", "--delete"], run(h, store))).stdout, /No credential/);
  });

  it("--delete never reads stdin", async () => {
    const rr = run(home(["token"]), memoryStore());
    await runConnectorAuth(["toy", "--name", "token", "--delete"], rr);
    assert.equal(rr.reads, 0);
  });

  it("an id with no installed manifest fails with one plain line and stores nothing", async () => {
    const store = memoryStore();
    const rr = run(home(undefined), store);
    const r = await runConnectorAuth(["toy", "--name", "token"], rr);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /^no connector "toy" is installed/);
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.equal(store.items.size, 0);
    assert.equal(rr.reads, 0);
  });

  it("a name the manifest does not declare fails with one plain line and stores nothing", async () => {
    const store = memoryStore();
    const r = await runConnectorAuth(["toy", "--name", "other"], run(home(["token"]), store));
    assert.equal(r.exitCode, 1);
    assert.equal(r.stderr, 'connector "toy" does not declare a credential named "other"\n');
    assert.equal(store.items.size, 0);
  });

  it("an id that is a path never leaves the connectors folder", async () => {
    const r = await runConnectorAuth(["../toy", "--name", "token"], run(home(["token"]), memoryStore()));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /is not a connector id/);
  });

  // Must not happen: the value on the command line. Any extra word is refused, and the refusal never echoes it.
  it("a value given in argv is refused and never echoed or stored", async () => {
    const store = memoryStore();
    for (const argv of [["toy", "--name", "token", SECRET], ["toy", SECRET, "--name", "token"], ["toy", "--name", "token", "--value", SECRET], ["toy", "--name", "token", `--value=${SECRET}`]]) {
      const r = await runConnectorAuth(argv, run(home(["token"]), store));
      assert.equal(r.exitCode, 1);
      assert.ok(!r.stderr.includes(SECRET) && !r.stdout.includes(SECRET));
    }
    assert.equal(store.items.size, 0);
  });

  // Must not happen: auth must never report success while storing nothing.
  it("an empty stdin stores nothing and fails", async () => {
    const store = memoryStore();
    const r = await runConnectorAuth(["toy", "--name", "token"], run(home(["token"]), store, ""));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /nothing was stored/);
    assert.equal(store.items.size, 0);
  });

  it("a failing store is a failed command with the store's one line", async () => {
    const r = await runConnectorAuth(["toy", "--name", "token"], run(home(["token"]), memoryStore(true)));
    assert.equal(r.exitCode, 1);
    assert.equal(r.stderr, "the store is locked\n");
  });

  it("main wires `connector auth` through platform().secretStore (the guard trips on --delete) and to the manifest check", async () => {
    const h = home(["token"]);
    const saved = process.env.COCHECK_HOME;
    process.env.COCHECK_HOME = h;
    try {
      const del = await main(["connector", "auth", "toy", "--name", "token", "--delete"]);
      assert.equal(del.exitCode, 1);
      assert.match(del.stderr, /GUARD/);
      assert.deepEqual(reached, ["delete"]);
      const none = await main(["connector", "auth", "nope", "--name", "token"]);
      assert.match(none.stderr, /^no connector "nope" is installed/);
    } finally {
      if (saved === undefined) delete process.env.COCHECK_HOME; else process.env.COCHECK_HOME = saved;
    }
  });
});

describe("reading the value", () => {
  it("from a pipe: all of stdin minus one trailing newline", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadStream;
    const p = readStdinValue(stdin);
    (stdin as unknown as PassThrough).end(`${SECRET}\n`);
    assert.equal(await p, SECRET);
  });

  it("on a terminal: raw mode, a prompt on stderr, and the typed characters are never written back", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, raw: [] as boolean[], setRawMode(on: boolean) { this.raw.push(on); } });
    const err: string[] = [];
    const stderr = { write: (t: string) => (err.push(t), true) } as unknown as NodeJS.WriteStream;
    const p = readStdinValue(stdin as unknown as NodeJS.ReadStream, stderr);
    stdin.write(`${SECRET}x\u007f\r`);
    assert.equal(await p, SECRET);
    assert.deepEqual(stdin.raw, [true, false]);
    assert.ok(!err.join("").includes(SECRET));
  });
});

const SKIP_WIN = process.platform === "win32" ? "the macOS stand-in is a shell script" : false;
describe("darwin secretStore against the bootstrap `security` stand-in", { skip: SKIP_WIN }, () => {
  const d = (): Store => platformFor("darwin").secretStore;
  const argvLog = path.join(mkdtempSync(path.join(tmpdir(), "cocheck-argv-")), "argv.log");
  // The darwin code is the code under test here, so the in-process guard steps aside; the real Keychain is still unreachable: COCHECK_SECURITY_BIN is the stand-in (asserted below) and runSecurity refuses the real tool under the test runner.
  beforeEach(() => { restoreGuard(); process.env.COCHECK_SECURITY_ARGV_LOG = argvLog; writeFileSync(argvLog, ""); });
  afterEach(() => { delete process.env.COCHECK_SECURITY_ARGV_LOG; });

  it("is the stand-in, never the real tool", () => {
    assert.match(process.env.COCHECK_SECURITY_BIN ?? "", /cocheck-test-keychain-/);
  });

  it("set, get, replace, delete round-trip any bytes", () => {
    const s = d();
    s.set("cocheck-connector:toy", "token", BYTES);
    assert.deepEqual(s.get("cocheck-connector:toy", "token"), BYTES);
    s.set("cocheck-connector:toy", "token", Buffer.from(SECRET));
    assert.deepEqual(s.get("cocheck-connector:toy", "token"), Buffer.from(SECRET));
    assert.equal(s.delete("cocheck-connector:toy", "token"), true);
    assert.equal(s.get("cocheck-connector:toy", "token"), null);
    assert.equal(s.delete("cocheck-connector:toy", "token"), false);
  });

  // Must not happen: the value in argv. The tool only ever sees `-i`; the line carrying the value goes on stdin.
  it("the value never appears in the arguments `security` was started with", () => {
    d().set("cocheck-connector:toy", "token", Buffer.from(SECRET));
    const log = readFileSync(argvLog, "utf8");
    assert.ok(log.includes("-i"), log);
    assert.ok(!log.includes(SECRET) && !log.includes(Buffer.from(SECRET).toString("hex")), log);
  });

  // Must not happen: the sealing key in argv, where `ps` shows it to the same user while the call runs.
  it("create keeps the key out of the arguments `security` was started with, and the key reads back", () => {
    d().create(SEAL_SERVICE, "home-argv", SEAL_KEY);
    const log = readFileSync(argvLog, "utf8");
    assert.ok(log.includes("-i"), log);
    assert.ok(!log.includes(SEAL_KEY.toString("hex")), log);
    assert.deepEqual(d().get(SEAL_SERVICE, "home-argv"), SEAL_KEY);
  });

  it("create refuses an item that already exists and leaves the first key in place", () => {
    const s = d();
    s.create(SEAL_SERVICE, "home-dup", SEAL_KEY);
    const other = Buffer.alloc(32, 7);
    assert.throws(() => s.create(SEAL_SERVICE, "home-dup", other), SecretStoreError);
    assert.deepEqual(s.get(SEAL_SERVICE, "home-dup"), SEAL_KEY);
  });

  // Must not happen: CoCheck's own sealing key.
  it("the sealing item survives set and delete of a connector credential with the same account", () => {
    const s = d();
    s.create(SEAL_SERVICE, "home-1", SEAL_KEY);
    s.set("cocheck-connector:toy", "home-1", Buffer.from(SECRET));
    assert.deepEqual(s.get(SEAL_SERVICE, "home-1"), SEAL_KEY);
    s.delete("cocheck-connector:toy", "home-1");
    assert.deepEqual(s.get(SEAL_SERVICE, "home-1"), SEAL_KEY);
  });

  it("set and delete refuse any service outside the connector prefix, and the item stays", () => {
    const s = d();
    s.create(SEAL_SERVICE, "home-2", SEAL_KEY);
    assert.throws(() => s.set(SEAL_SERVICE, "home-2", Buffer.from("x")), SecretStoreError);
    assert.throws(() => s.delete(SEAL_SERVICE, "home-2"), SecretStoreError);
    assert.throws(() => s.set("cocheck-connector:", "home-2", Buffer.from("x")), SecretStoreError);
    assert.deepEqual(s.get(SEAL_SERVICE, "home-2"), SEAL_KEY);
  });

  it("get of a sealing item still demands a 32-byte key", () => {
    const s = d();
    s.create(SEAL_SERVICE, "home-3", SEAL_KEY);
    assert.equal(s.get(SEAL_SERVICE, "home-3")!.length, 32);
  });
});

describe("win32 secretStore with injected fakes", () => {
  function rig() {
    const files = new Map<string, string>();
    const calls: { command: string; args: string[]; input?: string }[] = [];
    const deps: Partial<Win32Deps> = {
      env: { USERPROFILE: "C:\\Users\\Ana", USERNAME: "Ana", USERDOMAIN: "PC" },
      homedir: () => "C:\\Users\\Fallback",
      tmpdir: () => "C:\\Temp",
      run(command, args, options) {
        calls.push({ command, args, ...(options?.input === undefined ? {} : { input: options.input }) });
        const last = args[args.length - 1] ?? "";
        // Protect: base64 of the input; Unprotect: back to the hex text. A reversible fake, never the value in plain form.
        if (last.includes("::Protect(")) return { status: 0, stdout: Buffer.from(`P:${options?.input ?? ""}`).toString("base64") + "\r\n", stderr: "" };
        if (last.includes("::Unprotect(")) return { status: 0, stdout: Buffer.from(options?.input ?? "", "base64").toString().slice(2) + "\r\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      runAsync: async () => ({ status: 0 }),
      readFile: (f) => files.get(f)!,
      writeFile: (f, data) => void files.set(f, data),
      linkExclusive(from, to) {
        if (files.has(to)) throw new Error("EEXIST");
        files.set(to, files.get(from)!);
      },
      remove: (f) => void files.delete(f),
      mkdir: () => undefined,
      exists: (f) => files.has(f),
      readdir: () => [],
    };
    return { s: createWin32(deps).secretStore, files, calls };
  }

  it("set, replace, get, delete", () => {
    const { s } = rig();
    s.set("cocheck-connector:toy", "token", BYTES);
    assert.deepEqual(s.get("cocheck-connector:toy", "token"), BYTES);
    s.set("cocheck-connector:toy", "token", Buffer.from(SECRET));
    assert.deepEqual(s.get("cocheck-connector:toy", "token"), Buffer.from(SECRET));
    assert.equal(s.delete("cocheck-connector:toy", "token"), true);
    assert.equal(s.get("cocheck-connector:toy", "token"), null);
    assert.equal(s.delete("cocheck-connector:toy", "token"), false);
  });

  it("the value is on stdin of PowerShell only, never in an argument", () => {
    const { s, calls } = rig();
    s.set("cocheck-connector:toy", "token", Buffer.from(SECRET));
    const ps = calls.filter((c) => c.command === "powershell.exe");
    assert.ok(ps.length > 0);
    for (const c of calls) for (const a of c.args) assert.ok(!a.includes(SECRET) && !a.includes(Buffer.from(SECRET).toString("hex")));
  });

  it("the sealing blob survives set and delete of a connector credential, and non-connector set/delete is refused", () => {
    const { s, files } = rig();
    s.create(SEAL_SERVICE, "home-1", SEAL_KEY);
    s.set("cocheck-connector:toy", "home-1", Buffer.from(SECRET));
    s.delete("cocheck-connector:toy", "home-1");
    assert.deepEqual(s.get(SEAL_SERVICE, "home-1"), SEAL_KEY);
    const before = [...files.entries()].filter(([f]) => f.endsWith(".dpapi"));
    assert.throws(() => s.set(SEAL_SERVICE, "home-1", Buffer.from("x")), SecretStoreError);
    assert.throws(() => s.delete(SEAL_SERVICE, "home-1"), SecretStoreError);
    assert.deepEqual([...files.entries()].filter(([f]) => f.endsWith(".dpapi")), before);
  });
});
