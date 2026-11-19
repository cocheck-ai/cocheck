// `connector auth` set/remove, the runner's read and `connector doctor` against the REAL win32 secretStore code,
// with only its process runner faked (a reversible DPAPI Protect/Unprotect fake) and its file ops in memory. Runs on every OS.
// Must not happen: the credential value in plain form on disk, in argv or in output, versus a stored credential the runner cannot read back.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runConnectorAuth } from "../src/connector-auth.ts";
import { runConnectorDoctor } from "../src/connector-doctor.ts";
import { startConnector } from "../src/connector/runner.ts";
import { createWin32, type Win32Deps } from "../src/platform/index.ts";

const SECRET = "s3cr3t-T541-win32-5be0a1-do-not-leak";
const HASH = createHash("sha256").update(SECRET).digest("hex");

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
      if (last.includes("::Protect(")) return { status: 0, stdout: Buffer.from(`P:${options?.input ?? ""}`).toString("base64") + "\r\n", stderr: "" };
      if (last.includes("::Unprotect(")) return { status: 0, stdout: Buffer.from(options?.input ?? "", "base64").toString().slice(2) + "\r\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    readFile: (f) => files.get(f)!,
    writeFile: (f, data) => void files.set(f, data),
    linkExclusive(from, to) {
      if (files.has(to)) throw new Error("EEXIST");
      files.set(to, files.get(from)!);
    },
    remove: (f) => void files.delete(f),
    mkdir: () => undefined,
    exists: (f) => files.has(f),
    readdir: () => [...files.keys()].map((f) => f.split("\\").pop()!),
  };
  return { store: createWin32(deps).secretStore, files, calls };
}

const GOOD = `const c=require("node:crypto");process.stdin.on("data",d=>{const m=JSON.parse(String(d).split("\\n")[0]);const v=m.params&&m.params.credentials&&m.params.credentials.token;const ok=typeof v==="string"&&c.createHash("sha256").update(v).digest("hex")==="${HASH}";console.log(JSON.stringify(ok?{id:m.id,result:{ok:true}}:{id:m.id,error:"credential mismatch"}));});`;

function home(): string {
  const h = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  const dir = path.join(h, "connectors", "toy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "c.cjs"), GOOD);
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "toy", version: "0.1.0", entry: "diff", matches: { extensions: [".x"] }, run: [process.execPath, "c.cjs"], credentials: [{ name: "token" }] }));
  return h;
}

const forms = [SECRET, Buffer.from(SECRET).toString("hex"), Buffer.from(SECRET).toString("base64")];
const plainIn = (text: string) => forms.some((f) => text.includes(f));

describe("connector auth and doctor over the real win32 secretStore", () => {
  it("set, runner read-back, doctor, replace and remove; the value is never in argv, a written file or any output", async () => {
    const { store, files, calls } = rig();
    const h = home();
    const out: string[] = [];
    const auth = (argv: string[], value = SECRET) => runConnectorAuth(argv, { home: h, store, readValue: async () => value });

    const set = await auth(["toy", "--name", "token"]);
    out.push(set.stdout, set.stderr);
    assert.equal(set.exitCode, 0, set.stderr);
    assert.match(set.stdout, /Stored credential "token"/);
    assert.ok([...files.keys()].some((f) => f.endsWith(".dpapi")), "a DPAPI blob was written");

    // The runner's own read path gets the exact value back.
    assert.deepEqual(store.get("cocheck-connector:toy", "token"), Buffer.from(SECRET));

    const doctor = await runConnectorDoctor([], { home: h, store, helloTimeoutMs: 5000 });
    out.push(doctor.stdout, doctor.stderr);
    assert.equal(doctor.exitCode, 0, doctor.stdout);
    assert.match(doctor.stdout, /credential "token" stored: yes/);
    assert.match(doctor.stdout, /hello answered/);

    // The real runner delivers the stored value to the connector (the connector checks its hash, so a wrong value fails hello).
    const handle = await startConnector({ dir: path.join(h, "connectors", "toy"), run: [process.execPath, "c.cjs"], id: "toy", credentials: [{ name: "token" }], secretStore: store, helloTimeoutMs: 5000 });
    await handle.stop();

    // Replace with a different value: read-back follows, doctor's hello now fails the hash check.
    const other = await auth(["toy", "--name", "token"], "another-value-T541");
    assert.equal(other.exitCode, 0, other.stderr);
    assert.deepEqual(store.get("cocheck-connector:toy", "token"), Buffer.from("another-value-T541"));
    assert.equal((await runConnectorDoctor([], { home: h, store, helloTimeoutMs: 5000 })).exitCode, 1);
    await auth(["toy", "--name", "token"]);

    const del = await auth(["toy", "--name", "token", "--delete"]);
    out.push(del.stdout, del.stderr);
    assert.equal(del.exitCode, 0, del.stderr);
    assert.match(del.stdout, /Removed credential/);
    assert.equal(store.get("cocheck-connector:toy", "token"), null);
    const again = await auth(["toy", "--name", "token", "--delete"]);
    assert.match(again.stdout, /No credential "token" was stored/);
    const gone = await runConnectorDoctor([], { home: h, store, helloTimeoutMs: 5000 });
    assert.equal(gone.exitCode, 1);
    assert.match(gone.stdout, /credential "token" stored: no/);

    // Must not happen: plain-form value on disk, argv, or any output.
    assert.ok(calls.some((c) => c.command === "powershell.exe"));
    for (const c of calls) for (const a of c.args) assert.ok(!plainIn(a), `argv of ${c.command} holds the value`);
    for (const [f, data] of files) assert.ok(!plainIn(data) && !plainIn(f), `file ${f} holds the value`);
    for (const t of out) assert.ok(!plainIn(t));
  });
});
