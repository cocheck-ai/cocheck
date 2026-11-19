import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_CLIENT_NAME_CHARS,
  MAX_CLIENT_VERSION_CHARS,
  MAX_ERROR_TEXT_BYTES,
  openLedger,
  truncateChars,
  truncateUtf8Bytes,
} from "../src/ledger.ts";

function opsRows(home: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path.join(home, "ledger.sqlite"));
  const rows = db.prepare("SELECT * FROM ops ORDER BY id").all() as Record<string, unknown>[];
  db.close();
  return rows;
}

/** Matches a lone (unpaired) UTF-16 surrogate - a sign a surrogate pair got split. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("truncateChars", () => {
  it("leaves a value under the cap unchanged", () => {
    assert.equal(truncateChars("hello", 256), "hello");
  });

  it("truncates a value over the cap, staying within the cap and naming the original length", () => {
    const value = "a".repeat(500_000);
    const result = truncateChars(value, 256);
    assert.ok(Array.from(result).length <= 256);
    assert.match(result, /…\[truncated, 500000 chars\]$/);
    assert.ok(!result.match(LONE_SURROGATE));
  });

  it("never splits a surrogate pair when the cut lands mid-emoji", () => {
    // Each 😀 is one codepoint but two UTF-16 code units - pad so the cap lands mid-run.
    const value = "😀".repeat(300);
    const result = truncateChars(value, 256);
    assert.ok(!result.match(LONE_SURROGATE));
    assert.ok(Array.from(result).length <= 256);
  });
});

describe("truncateUtf8Bytes", () => {
  it("leaves a value under the cap unchanged", () => {
    assert.equal(truncateUtf8Bytes("hello", 4096), "hello");
  });

  it("truncates a value over the cap, staying within the byte cap and naming the original length", () => {
    const value = "b".repeat(500_000);
    const result = truncateUtf8Bytes(value, 4096);
    assert.ok(Buffer.byteLength(result, "utf8") <= 4096);
    assert.match(result, /…\[truncated, 500000 chars\]$/);
    assert.ok(!result.match(LONE_SURROGATE));
  });

  it("produces valid UTF-8 even when the byte cut lands mid multi-byte codepoint", () => {
    // Each euro sign is 3 UTF-8 bytes; a byte cap not a multiple of 3 forces a mid-codepoint cut.
    const value = "€".repeat(2000); // 6000 bytes
    const result = truncateUtf8Bytes(value, 100);
    assert.ok(Buffer.byteLength(result, "utf8") <= 100);
    assert.ok(!result.match(LONE_SURROGATE));
    // Round-tripping through the two encodings must be lossless (i.e. valid UTF-8 throughout).
    assert.equal(Buffer.from(result, "utf8").toString("utf8"), result);
  });
});

describe("ledger recordOp bounds client_name, client_version, and error_text", () => {
  it("truncates a huge client_name and client_version to 256 characters", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-bounds-test-"));
    const ledger = openLedger(home);
    const hugeName = "n".repeat(500_000);
    const hugeVersion = "v".repeat(500_000);
    ledger.recordOp({
      tool: "cocheck_echo_write",
      args: { text: "x" },
      intent: "test client_name/client_version bounds",
      clientName: hugeName,
      clientVersion: hugeVersion,
      durationMs: 1,
      resultCode: "OK",
    });
    const rows = opsRows(home);
    const row = rows[rows.length - 1] as Record<string, unknown>;
    assert.ok((row.client_name as string).length <= MAX_CLIENT_NAME_CHARS);
    assert.ok((row.client_version as string).length <= MAX_CLIENT_VERSION_CHARS);
    assert.match(row.client_name as string, /…\[truncated, 500000 chars\]$/);
    assert.match(row.client_version as string, /…\[truncated, 500000 chars\]$/);
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });

  it("truncates a huge error_text to 4 KiB", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-bounds-test-"));
    const ledger = openLedger(home);
    const hugeError = "e".repeat(500_000);
    ledger.recordOp({
      tool: "cocheck_echo_write",
      args: { text: "x" },
      intent: "test error_text bounds",
      durationMs: 1,
      resultCode: "ERROR",
      errorText: hugeError,
    });
    const rows = opsRows(home);
    const row = rows[rows.length - 1] as Record<string, unknown>;
    assert.ok(Buffer.byteLength(row.error_text as string, "utf8") <= MAX_ERROR_TEXT_BYTES);
    assert.match(row.error_text as string, /…\[truncated, 500000 chars\]$/);
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
});
