import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSecretPath, secretLine } from "../src/secret-files.ts";

describe("secret file names", () => {
  it("matches the name list at any depth", () => {
    for (const p of [".env", ".env.local", "a/b/.env", "x/server.pem", "k.key", "c.p12", "c.pfx", "id_rsa", "id_rsa.pub", "id_ed25519", "credentials.json", "credentials", "secrets.yml", ".npmrc", ".netrc", ".pypirc", "/abs/dir/.env.production"]) {
      assert.equal(isSecretPath(p), true, p);
    }
  });
  it("leaves ordinary files alone", () => {
    for (const p of ["notes.txt", "environment.md", "env.ts", "keys.md", "monkey.txt", "secrets/readme.md", "my-credentials-guide.md", "package.json", "rsa.txt"]) {
      assert.equal(isSecretPath(p), false, p);
    }
  });
  it("words the line with the relative path", () => {
    assert.equal(secretLine("a/b/.env"), "A secret file was changed: a/b/.env");
  });
});
