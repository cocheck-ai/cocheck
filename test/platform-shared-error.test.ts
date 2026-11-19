// The secret-store error is one shared type from platform/types.ts, and nothing outside src/platform/ reaches into a per-OS file, so a
// future win32 or linux secretStore throws the type seal.ts already maps to KeyMissingError.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as types from "../src/platform/types.ts";

const ROOT = path.join(import.meta.dirname, "..");
const PER_OS = /\bfrom\s+["'][^"']*platform\/(?:darwin|win32|linux|stub)(?:\.ts|\.js)?["']|\bimport\(\s*["'][^"']*platform\/(?:darwin|win32|linux|stub)(?:\.ts|\.js)?["']/;

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "platform" && e.name !== "node_modules") files(full, out);
    } else if (/\.(?:ts|cjs|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("shared secret-store error", () => {
  it("platform/types.ts exports SecretStoreError", () => {
    assert.equal(typeof (types as Record<string, unknown>).SecretStoreError, "function");
    assert.ok(new (types as unknown as { SecretStoreError: new (m: string) => Error }).SecretStoreError("x") instanceof Error);
  });

  it("no file outside src/platform/ imports a per-OS platform file", () => {
    const bad: string[] = [];
    for (const dir of ["src", "test", "scripts"]) {
      for (const file of files(path.join(ROOT, dir))) {
        if (file === import.meta.filename) continue;
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (PER_OS.test(line)) bad.push(`${path.relative(ROOT, file)}:${i + 1}`);
        });
      }
    }
    assert.deepEqual(bad, []);
  });
});
