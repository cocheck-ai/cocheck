// A credential reaches a connector in the `hello` request, never in environment variables, argv or
// output. CoCheck owns storage (src/platform/ secretStore); the connector owns meaning. Acceptance tests written before the build: the ones
// that need the runner are pending ("awaiting connector runner build"). Contract (src/connector/runner.ts):
//   startConnector({ dir, run, credentials: [{ name, service, account }], secretStore? }) -> { hello, call, log(), stop() }
//   For each entry CoCheck reads the value from `secretStore` (default: platform().secretStore) and sends `params.credentials[name]` (a string)
//   in the `hello` request. A missing value or a failing store rejects startConnector loudly; it never starts the connector without it.
// Must not happen: a test that touches a real credential store, or one that passes only on a Mac. The guard below trips on any real
// store, in this process and in child processes, and its own tests (green today) prove it trips. Everything else uses an in-memory
// stand-in and a Node connector, so no test depends on macOS.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { platform } from "../src/platform/index.ts";

const RUNNER = "../src/connector/runner.ts";
const SECRET = "s3cr3t-T361-8f2a1c-do-not-leak";

interface Handle {
  hello: Record<string, unknown>;
  call(method: string, params: unknown, opts: { timeoutMs: number }): Promise<unknown>;
  log(): string;
  stop(): Promise<void>;
}
type Store = { get(service: string, account: string): Buffer | null; create(service: string, account: string, key: Buffer): void; location(service: string): string };
type Start = (opts: { dir: string; run: string[]; credentials: { name: string; service: string; account: string }[]; secretStore?: Store }) => Promise<Handle>;

async function runner(): Promise<Start> {
  const mod = (await import(RUNNER)) as { startConnector?: Start };
  assert.equal(typeof mod.startConnector, "function", "src/connector/runner.ts must export startConnector");
  return mod.startConnector as Start;
}

/** Reports whether the secret it was handed shows up in its own environment or argv, and echoes what hello carried. */
const STAND_IN = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line.replace(/\\r$/, ""));
  if (msg.method !== "hello") return;
  const creds = (msg.params && msg.params.credentials) || {};
  const secrets = Object.values(creds).map(String);
  const inEnv = Object.entries(process.env).some(([k, v]) => secrets.some((s) => s && (String(v).includes(s) || k.includes(s))));
  const inArgv = process.argv.some((a) => secrets.some((s) => s && a.includes(s)));
  process.stdout.write(JSON.stringify({ id: msg.id, result: { received: creds, inEnv, inArgv } }) + "\\n");
});
`;

function connectorDir(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "cocheck-t361k-")), "cred connector");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "connector.mjs"), STAND_IN);
  return dir;
}

/** In-memory stand-in for Keychain, Credential Manager and libsecret. */
function standInStore(items: Record<string, string>): Store & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get(service, account) {
      reads.push(`${service}/${account}`);
      const v = items[`${service}/${account}`];
      return v === undefined ? null : Buffer.from(v);
    },
    create(service, account, key) {
      items[`${service}/${account}`] = key.toString();
    },
    location: (service) => `the stand-in store (${service})`,
  };
}

/**
 * Guard against any real credential store. In this process the running OS's `secretStore` throws; for child processes the macOS `security`
 * stand-in variable points at a tripwire and a PATH shim named `security` / `secret-tool` records the call. `tripped()` lists every reach.
 * Returns a restore function.
 */
function installGuard(): { tripped(): string[]; restore(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), "cocheck-guard-"));
  const trip = path.join(dir, "tripped.log");
  const saved: Record<string, string | undefined> = { COCHECK_SECURITY_BIN: process.env.COCHECK_SECURITY_BIN, PATH: process.env.PATH };
  if (process.platform !== "win32") {
    const body = `#!/bin/sh\necho "child reached a real store: $0 $*" >> '${trip.replace(/'/g, "'\\''")}'\nexit 99\n`;
    for (const name of ["tripwire", "security", "secret-tool"]) {
      writeFileSync(path.join(dir, name), body);
      chmodSync(path.join(dir, name), 0o755);
    }
    process.env.COCHECK_SECURITY_BIN = path.join(dir, "tripwire");
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
  }
  const store = platform().secretStore as unknown as Record<string, unknown>;
  const original = { get: store.get, create: store.create };
  const throwing = (member: string) => () => {
    writeFileSync(trip, `in-process reach: platform().secretStore.${member}\n`, { flag: "a" });
    throw new Error(`GUARD: a test reached the real credential store (secretStore.${member})`);
  };
  store.get = throwing("get");
  store.create = throwing("create");
  return {
    tripped: () => (existsSync(trip) ? readFileSync(trip, "utf8").split("\n").filter(Boolean) : []),
    restore() {
      store.get = original.get;
      store.create = original.create;
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    },
  };
}

test("guard: the in-process real store throws and is recorded (green today: this tests the guard itself)", () => {
  const g = installGuard();
  try {
    assert.throws(() => platform().secretStore.get("svc", "acct"), /GUARD/);
    assert.throws(() => platform().secretStore.create("svc", "acct", Buffer.from("x")), /GUARD/);
    assert.equal(g.tripped().length, 2);
  } finally {
    g.restore();
  }
});

test("guard: a child process that runs the macOS store tool, by variable or by name, is caught (posix shells only)", { skip: process.platform === "win32" ? "posix shim scripts only" : false }, () => {
  const g = installGuard();
  try {
    for (const bin of [process.env.COCHECK_SECURITY_BIN as string, "security", "secret-tool"]) {
      assert.throws(() => execFileSync(bin, ["find-generic-password", "-w"], { stdio: "pipe", env: process.env }), (e: { status?: number }) => e.status === 99);
    }
    assert.equal(g.tripped().length, 3);
    assert.ok(g.tripped().every((l) => l.startsWith("child reached a real store")));
  } finally {
    g.restore();
  }
});

test("K1 the credential arrives in the hello request, and is in no environment variable, argument or log line", async () => {
  const g = installGuard();
  try {
    const start = await runner();
    const store = standInStore({ "cocheck.toy/token": SECRET });
    const h = await start({ dir: connectorDir(), run: [process.execPath, "connector.mjs"], credentials: [{ name: "token", service: "cocheck.toy", account: "token" }], secretStore: store });
    try {
      assert.deepEqual(h.hello.received, { token: SECRET });
      assert.equal(h.hello.inEnv, false, "the credential reached the connector's environment");
      assert.equal(h.hello.inArgv, false, "the credential reached the connector's argv");
      assert.equal(h.log().includes(SECRET), false, "the credential reached CoCheck's output about the connector");
      assert.deepEqual(store.reads, ["cocheck.toy/token"]);
    } finally {
      await h.stop();
    }
    assert.deepEqual(g.tripped(), [], "a real credential store was reached");
  } finally {
    g.restore();
  }
});

test("K1 a missing credential rejects loudly and the connector is never started without it", async () => {
  const g = installGuard();
  try {
    const start = await runner();
    await assert.rejects(
      start({ dir: connectorDir(), run: [process.execPath, "connector.mjs"], credentials: [{ name: "token", service: "cocheck.toy", account: "token" }], secretStore: standInStore({}) }),
      /token/,
    );
    assert.deepEqual(g.tripped(), []);
  } finally {
    g.restore();
  }
});

test("K1 must not: with no stand-in store given, the runner reaches the real store, the guard fires, and the run fails instead of sending an empty credential", async () => {
  const g = installGuard();
  try {
    const start = await runner();
    await assert.rejects(start({ dir: connectorDir(), run: [process.execPath, "connector.mjs"], credentials: [{ name: "token", service: "cocheck.toy", account: "token" }] }), /GUARD|credential/i);
    assert.ok(g.tripped().some((l) => l.includes("secretStore.get")), "the default path must go through platform().secretStore");
  } finally {
    g.restore();
  }
});

// ---- the credential exists only in hello params ----

type StartAny = (opts: Record<string, unknown>) => Promise<Handle>;

/** Echoes the credential to stderr and to a non-protocol stdout line, to prove log() redacts it. */
const LEAKY_STAND_IN = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const creds = (msg.params && msg.params.credentials) || {};
  const s = Object.values(creds)[0] || "";
  process.stderr.write("debug token=" + s + "\\n");
  process.stdout.write("not json " + s + "\\n");
  process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");
});
`;
const MARKER_STAND_IN = `
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./started.txt", import.meta.url), "started");
`;

function dirWith(file: string, body: string, manifest?: unknown): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "cocheck-t369k-")), "c");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), body);
  if (manifest !== undefined) writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify(manifest));
  return dir;
}

test("K1 the runner's own stdout and stderr, and log(), carry no credential, even when the connector echoes it", async () => {
  const g = installGuard();
  const seen: string[] = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  const spy = (orig: typeof outWrite) => ((chunk: unknown, ...rest: unknown[]) => {
    seen.push(String(chunk));
    return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof outWrite;
  try {
    const start = await runner();
    const store = standInStore({ "cocheck.toy/token": SECRET });
    process.stdout.write = spy(outWrite);
    process.stderr.write = spy(errWrite);
    let log: string;
    try {
      const h = await start({ dir: dirWith("connector.mjs", LEAKY_STAND_IN), run: [process.execPath, "connector.mjs"], credentials: [{ name: "token", service: "cocheck.toy", account: "token" }], secretStore: store });
      await h.call("again", {}, { timeoutMs: 5000 });
      await h.stop();
      log = h.log();
    } finally {
      process.stdout.write = outWrite;
      process.stderr.write = errWrite;
    }
    assert.ok(log.includes("debug token="), "the connector's stderr is kept in the log");
    assert.equal(log.includes(SECRET), false, "log() carries the credential");
    assert.equal(seen.some((s) => s.includes(SECRET)), false, "the runner's own stdout or stderr carries the credential");
    assert.deepEqual(g.tripped(), []);
  } finally {
    g.restore();
  }
});

test("K1 an error answer that quotes the credential is redacted in the rejection", async () => {
  const g = installGuard();
  try {
    const body = `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (l) => { const m = JSON.parse(l); if (m.method === "hello") { process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\\n"); return; }
  process.stdout.write(JSON.stringify({ id: m.id, error: { message: "bad token " + Object.values(JSON.parse(l).params || {}).join("") } }) + "\\n"); });`;
    const start = await runner();
    const h = await start({ dir: dirWith("connector.mjs", body), run: [process.execPath, "connector.mjs"], credentials: [{ name: "token", service: "cocheck.toy", account: "token" }], secretStore: standInStore({ "cocheck.toy/token": SECRET }) });
    try {
      await assert.rejects(h.call("x", { v: SECRET }, { timeoutMs: 5000 }), (e: Error) => /bad token/.test(e.message) && !e.message.includes(SECRET));
    } finally {
      await h.stop();
    }
  } finally {
    g.restore();
  }
});

test("K1 the store entry is cocheck-connector:<id> / <credential name>, with the id from the manifest or from an explicit id option", async () => {
  const g = installGuard();
  try {
    const start = (await runner()) as unknown as StartAny;
    const items = { "cocheck-connector:toy-from-manifest/token": SECRET, "cocheck-connector:toy-explicit/token": SECRET };
    const byManifest = standInStore(items);
    const a = await start({ dir: dirWith("connector.mjs", STAND_IN, { id: "toy-from-manifest", version: "1" }), run: [process.execPath, "connector.mjs"], credentials: [{ name: "token" }], secretStore: byManifest });
    try {
      assert.deepEqual(a.hello.received, { token: SECRET });
      assert.deepEqual(byManifest.reads, ["cocheck-connector:toy-from-manifest/token"]);
    } finally {
      await a.stop();
    }
    const explicit = standInStore(items);
    const b = await start({ dir: dirWith("connector.mjs", STAND_IN), id: "toy-explicit", run: [process.execPath, "connector.mjs"], credentials: [{ name: "token" }], secretStore: explicit });
    try {
      assert.deepEqual(explicit.reads, ["cocheck-connector:toy-explicit/token"]);
    } finally {
      await b.stop();
    }
    await assert.rejects(start({ dir: dirWith("connector.mjs", STAND_IN), run: [process.execPath, "connector.mjs"], credentials: [{ name: "token" }], secretStore: standInStore(items) }), /no id/);
    assert.deepEqual(g.tripped(), []);
  } finally {
    g.restore();
  }
});

test("K1 must not: a missing credential, or a store that throws, never starts the connector", async () => {
  const g = installGuard();
  try {
    const start = await runner();
    for (const store of [standInStore({}), { ...standInStore({}), get: () => { throw new Error("store offline"); } }]) {
      const dir = dirWith("connector.mjs", MARKER_STAND_IN);
      await assert.rejects(start({ dir, run: [process.execPath, "connector.mjs"], credentials: [{ name: "token", service: "cocheck.toy", account: "token" }], secretStore: store }), /token/);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(existsSync(path.join(dir, "started.txt")), false, "the connector was started without its credential");
    }
    assert.deepEqual(g.tripped(), []);
  } finally {
    g.restore();
  }
});

test("K1 the runner only calls secretStore.get", async () => {
  const g = installGuard();
  try {
    const start = await runner();
    const store = standInStore({ "cocheck.toy/token": SECRET });
    const only = { get: store.get } as unknown as Store;
    const h = await start({ dir: connectorDir(), run: [process.execPath, "connector.mjs"], credentials: [{ name: "token", service: "cocheck.toy", account: "token" }], secretStore: only });
    await h.stop();
  } finally {
    g.restore();
  }
});

/** Writes the credential in two pieces with a delay on stderr, and on a non-protocol stdout line, as a real child does when its pipe flushes mid-value. */
const SPLIT_STAND_IN = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "hello") {
    const s = Object.values((msg.params && msg.params.credentials) || {})[0] || "";
    process.stdout.write(JSON.stringify({ id: msg.id, result: { len: s.length } }) + "\\n");
    process.stderr.write("tok=" + s.slice(0, 5));
    await sleep(100);
    process.stderr.write(s.slice(5) + "\\n");
    process.stdout.write("noise " + s.slice(0, 7));
    await sleep(100);
    process.stdout.write(s.slice(7) + "\\n");
    process.stdout.write(JSON.stringify({ id: 0, result: 1 }) + "\\n");
  } else process.stdout.write(JSON.stringify({ id: msg.id, result: "ok" }) + "\\n");
});
`;

test("K1 (stream) a credential split across chunks on stderr or a non-protocol stdout line never reaches log(), not even as a partial", async () => {
  const g = installGuard();
  try {
    const start = (await runner()) as unknown as StartAny;
    const store = standInStore({ "cocheck.toy/token": SECRET });
    const h = await start({ dir: dirWith("connector.mjs", SPLIT_STAND_IN), run: [process.execPath, "connector.mjs"], credentials: [{ name: "token", service: "cocheck.toy", account: "token" }], secretStore: store });
    const snapshots: string[] = [];
    for (let i = 0; i < 8; i++) {
      snapshots.push(h.log());
      await new Promise((r) => setTimeout(r, 40));
    }
    await h.call("again", {}, { timeoutMs: 5000 });
    snapshots.push(h.log());
    await h.stop();
    snapshots.push(h.log());
    for (const s of snapshots) {
      assert.equal(s.includes(SECRET), false, "log() carries the credential");
      assert.equal(s.includes(SECRET.slice(0, 5)), false, "log() carries the first half of the credential");
      assert.equal(s.includes(SECRET.slice(5)), false, "log() carries the second half of the credential");
    }
    const final = snapshots[snapshots.length - 1];
    assert.ok(final.includes("tok=[redacted]") && final.includes("noise [redacted]"), `both split writes are kept, redacted: ${JSON.stringify(final)}`);
    assert.deepEqual(g.tripped(), []);
  } finally {
    g.restore();
  }
});
