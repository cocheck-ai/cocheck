// With the win32 platform, a second `create` for the same home must make the core adopt the first key (seal.ts relies on SecretStoreError).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keychainProvider } from "../src/seal.ts";
import { createWin32, platformFor } from "../src/platform/index.ts";

const xor = (b: Buffer): Buffer => Buffer.from(b.map((x) => x ^ 0x55));

describe("seal over the win32 platform", () => {
  it("a second create for the same home returns the first key, not a new one", () => {
    const files = new Map<string, string>();
    // Fake DPAPI: protect returns a blob that is the key XORed so it is not the plain key; unprotect decodes it. No PowerShell runs.
    const fake = createWin32({
      env: { USERPROFILE: "C:\\Users\\Ana", USERNAME: "Ana", USERDOMAIN: "PC" },
      run(command, args, options) {
        if (command !== "powershell.exe") return { status: 0, stdout: "", stderr: "" };
        const script = args[args.length - 1]!;
        if (script.includes("::Protect(")) return { status: 0, stdout: xor(Buffer.from(options!.input!, "hex")).toString("base64"), stderr: "" };
        return { status: 0, stdout: xor(Buffer.from(options!.input!, "base64")).toString("hex"), stderr: "" };
      },
      runAsync: async () => ({ status: 0 }),
      readFile: (f) => files.get(f)!,
      writeFile: (f, d) => void files.set(f, d),
      linkExclusive: (from, to) => {
        if (files.has(to)) throw new Error("EEXIST");
        files.set(to, files.get(from)!);
      },
      remove: (f) => void files.delete(f),
      mkdir: () => undefined,
      exists: (f) => files.has(f),
    });
    const realStore = platformFor("win32").secretStore;
    const platformDesc = Object.getOwnPropertyDescriptor(process, "platform")!;
    (platformFor("win32") as { secretStore: unknown }).secretStore = fake.secretStore;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const first = keychainProvider.create!("/home/a");
      const second = keychainProvider.create!("/home/a");
      assert.equal(first.length, 32);
      assert.ok(second.equals(first), "second create must adopt the first key");
      assert.ok(keychainProvider.get("/home/a")!.equals(first));
    } finally {
      Object.defineProperty(process, "platform", platformDesc);
      (platformFor("win32") as { secretStore: unknown }).secretStore = realStore;
    }
  });
});
