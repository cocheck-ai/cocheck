import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWin32 } from "../src/platform/index.ts";
import { SecretStoreError } from "../src/platform/types.ts";

const BLOB = "QUJD".repeat(20);
const KEY = Buffer.alloc(32, 1);

// A crash after the file is created but before its data lands: the file exists and is empty, then the write throws.
function rig(crash: boolean) {
  const files = new Map<string, string>();
  const crashWrite = (f: string): never => {
    files.set(f, "");
    throw new Error("simulated crash");
  };
  const p = createWin32({
    env: { USERPROFILE: "C:\\Users\\Ana", USERNAME: "Ana", USERDOMAIN: "PC" },
    run: () => ({ status: 0, stdout: BLOB, stderr: "" }),
    readFile: (f) => files.get(f)!,
    mkdir: () => undefined,
    exists: (f) => files.has(f),
    writeFile: (f, d) => (crash ? crashWrite(f) : void files.set(f, d)),
    linkExclusive: (from, to) => {
      if (files.has(to)) throw new Error("EEXIST");
      files.set(to, files.get(from)!);
    },
    remove: (f) => void files.delete(f),
    // The earlier member, kept so old code runs against a fake and never the real disk.
    ...({ writeFileExclusive: (f: string, d: string) => (crash ? crashWrite(f) : void files.set(f, d)) } as object),
  });
  return { p, files };
}

describe("win32 key blob is written whole or not at all", () => {
  it("a crash mid-write leaves no final blob, and the next create succeeds", () => {
    const crashed = rig(true);
    assert.throws(() => crashed.p.secretStore.create("svc", "acct", KEY), SecretStoreError);
    const finals = [...crashed.files.keys()].filter((f) => !f.endsWith(".tmp"));
    assert.deepEqual(finals, [], "no final-name file after a crash");
    const ok = rig(false);
    ok.files.clear();
    // Same store, crash cleared: reuse the crashed rig's files by replaying on a healthy writer.
    const healthy = new Map(crashed.files);
    const p2 = createWin32({
      env: { USERPROFILE: "C:\\Users\\Ana", USERNAME: "Ana", USERDOMAIN: "PC" },
      run: () => ({ status: 0, stdout: BLOB, stderr: "" }),
      readFile: (f) => healthy.get(f)!,
      mkdir: () => undefined,
      exists: (f) => healthy.has(f),
      writeFile: (f, d) => void healthy.set(f, d),
      linkExclusive: (from, to) => {
        if (healthy.has(to)) throw new Error("EEXIST");
        healthy.set(to, healthy.get(from)!);
      },
      remove: (f) => void healthy.delete(f),
    });
    p2.secretStore.create("svc", "acct", KEY);
    assert.ok([...healthy.entries()].some(([f, d]) => !f.endsWith(".tmp") && d === BLOB));
  });

  it("a lost race throws SecretStoreError, leaves the winner byte-identical and no temp behind", () => {
    const { p, files } = rig(false);
    p.secretStore.create("svc", "acct", KEY);
    const [file] = [...files.keys()];
    assert.equal(files.size, 1);
    const before = files.get(file!);
    assert.throws(() => p.secretStore.create("svc", "acct", Buffer.alloc(32, 9)), SecretStoreError);
    assert.equal(files.get(file!), before);
    assert.equal(files.size, 1);
  });
});
