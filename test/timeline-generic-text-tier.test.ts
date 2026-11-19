import { afterEach, describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { ensureStoreDir } from "../src/states.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { buildTimeline, type Change, type Timeline } from "../src/timeline/timeline.ts";
import { isSecretPath, secretLine } from "../src/secret-files.ts";
import { lineHunks } from "../src/timeline/generic.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";

// the text tier by content. A real ledger and state store in a temp home, synthetic files only. Nothing here runs a server or a
// real folder watch. The definition under test: both stored sides decode as UTF-8 with no NUL byte in the first 64 KB => tier "text",
// whatever the extension.

const FOLDER = "/work";
const CLIENT = "claude:/work";
const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Side {
  bytes: string | Buffer | null;
  /** Leave the bytes out of the store. */
  unstored?: boolean;
}

/** One change to one file: before null = created, after null = deleted. Returns the change the timeline shows for it. */
async function changeOf(name: string, before: string | Buffer | null, after: string | Buffer | null, opts: { unstored?: "before" | "after"; isSecret?: (filePath: string) => boolean; quickLook?: boolean; render?: (file: string, outDir: string) => Promise<string | null> } = {}): Promise<Change> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const ledger: Ledger = openLedger(home);
  cleanups.push(async () => {
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const id = ledger.openTask(CLIENT);
  const states = await ensureStoreDir(home, id);
  await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: FOLDER }));
  const file = `${FOLDER}/${name}`;
  if (before !== null && opts.unstored !== "before") await writeSealed(path.join(states, sha(before)), before);
  if (after !== null && opts.unstored !== "after") await writeSealed(path.join(states, sha(after)), after);
  ledger.recordStep({
    taskId: id, client: CLIENT, seq: 1, phase: "Post", callsOpen: [], credited: ["call-not-in-record"],
    files: [{
      filePath: file,
      sha256: after === null ? "" : sha(after),
      prevSha256: before === null ? null : sha(before),
      size: after === null ? 0 : after.length,
      kept: after === null ? "gone" : "whole",
      note: "",
    }],
  });
  const loaded = loadRows(ledger, id, "t");
  const input = await loadTimelineInput(ledger, home, loaded, { build: "t", quickLook: opts.quickLook ?? false, render: opts.render ?? (async () => null), ...(opts.isSecret ? { isSecret: opts.isSecret } : {}) });
  const t: Timeline = buildTimeline(input);
  assert.equal(t.unplaced.length, 1);
  return t.unplaced[0]!;
}

const lines = (n: number, tag = "line"): string => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

describe("text tier by content", () => {
  const cases: Array<[string, string, string]> = [
    ["tool.py", "def f():\n    return 1\n", "def f():\n    return 2\n"],
    ["data.json", '{\n  "a": 1\n}\n', '{\n  "a": 2\n}\n'],
    ["page.html", "<p>one</p>\n", "<p>two</p>\n"],
    ["main.ts", "const a = 1;\n", "const a = 2;\n"],
    ["run-me", "#!/bin/sh\necho one\n", "#!/bin/sh\necho two\n"],
    ["table.csv", "a,b\n1,2\n", "a,b\n1,3\n"],
  ];
  for (const [name, before, after] of cases) {
    it(`${name}: a line diff, labelled in words, never "binary file changed"`, async () => {
      const c = await changeOf(name, before, after);
      assert.equal(c.generic.tier, "text");
      assert.equal(c.generic.label, "Text, 1 line changed");
      const ops = c.generic.text!.hunks.flatMap((h) => h.lines.map((l) => l.op + l.text));
      assert.ok(ops.some((l) => l.startsWith("-")) && ops.some((l) => l.startsWith("+")));
      assert.equal(c.generic.text!.cut, undefined);
      assert.ok(!JSON.stringify(c).includes("binary file changed"), "a text change never reads binary file changed");
      assert.ok(!JSON.stringify(c).includes("no readable detail"));
    });
  }

  it("hunk numbers and 3 lines of context: a change on line 10 of 20", async () => {
    const before = lines(20);
    const after = before.replace("line 10\n", "line ten\n");
    const h = (await changeOf("n.py", before, after)).generic.text!.hunks;
    assert.equal(h.length, 1);
    assert.deepEqual([h[0]!.beforeStart, h[0]!.beforeLines, h[0]!.afterStart, h[0]!.afterLines], [7, 7, 7, 7]);
    assert.deepEqual(h[0]!.lines.map((l) => l.op), [" ", " ", " ", "-", "+", " ", " ", " "]);
    assert.equal(h[0]!.lines[3]!.text, "line 10");
    assert.equal(h[0]!.lines[4]!.text, "line ten");
  });

  it("two far-apart changes make two hunks; near ones merge", () => {
    const a = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const far = a.map((x, i) => (i === 3 || i === 30 ? "X" + x : x));
    assert.equal(lineHunks(a, far).hunks.length, 2);
    const near = a.map((x, i) => (i === 3 || i === 8 ? "X" + x : x));
    assert.equal(lineHunks(a, near).hunks.length, 1);
  });

  it("counts changed lines by the existing line alignment: 4 edited lines read '4 lines changed'", async () => {
    const before = lines(30);
    let after = before;
    for (const n of [2, 11, 20, 29]) after = after.replace(`line ${n}\n`, `edited ${n}\n`);
    const c = await changeOf("many.txt", before, after);
    assert.equal(c.generic.label, "Text, 4 lines changed");
    assert.equal(c.generic.text!.hunks.length, 4);
  });

  it("a created file diffs against empty; a deleted one against empty after", async () => {
    const made = await changeOf("new.py", null, "a = 1\nb = 2\n");
    assert.equal(made.kind, "created");
    assert.equal(made.generic.tier, "text");
    assert.match(made.generic.label, /new file, 2 lines/i);
    assert.deepEqual(made.generic.text!.hunks.map((h) => [h.beforeStart, h.beforeLines, h.afterStart, h.afterLines]), [[0, 0, 1, 2]]);
    assert.deepEqual(made.generic.text!.hunks[0]!.lines.map((l) => l.op), ["+", "+"]);
    const gone = await changeOf("old.py", "a = 1\nb = 2\n", null);
    assert.equal(gone.kind, "deleted");
    assert.equal(gone.generic.tier, "text");
    assert.match(gone.generic.label, /deleted, 2 lines/i);
    assert.deepEqual(gone.generic.text!.hunks.map((h) => [h.beforeStart, h.beforeLines, h.afterStart, h.afterLines]), [[1, 2, 0, 0]]);
    assert.deepEqual(gone.generic.text!.hunks[0]!.lines.map((l) => l.op), ["-", "-"]);
  });

  it("a 3 MB log is text with its hunks cut, and the cut says so in words", async () => {
    const big = "2026-10-10 12:00:00 INFO something happened here\n".repeat(65_000);
    assert.ok(big.length > 3 * 1024 * 1024 - 200_000);
    const c = await changeOf("run.log", big, big + "one more\n");
    assert.equal(c.generic.tier, "text");
    assert.deepEqual(c.generic.text!.hunks, []);
    assert.match(c.generic.text!.cut!, /MB.*limit.*not listed/);
  });

  it("over 2,000 changed lines the hunks are cut and say so", async () => {
    const before = lines(3000, "a");
    const after = lines(3000, "b");
    const c = await changeOf("churn.txt", before, after);
    assert.equal(c.generic.tier, "text");
    assert.match(c.generic.label, /3000 lines changed/);
    assert.match(c.generic.text!.cut!, /only the first 2000 are listed/);
    const shown = c.generic.text!.hunks.flatMap((h) => h.lines).filter((l) => l.op === "+").length;
    assert.ok(shown <= 2000 && shown >= 1990, `shown ${shown}`);
  });

  it("a NUL-bearing .txt is a fingerprint, never text", async () => {
    const c = await changeOf("notes.txt", Buffer.from("hello\0world\n"), Buffer.from("hello\0there\n"));
    assert.equal(c.generic.tier, "fingerprint");
    assert.equal(c.generic.text, undefined);
    assert.ok(c.generic.fingerprint!.before && c.generic.fingerprint!.after);
    assert.notEqual(c.generic.fingerprint!.before!.sha, c.generic.fingerprint!.after!.sha);
  });

  it("bytes that are not UTF-8 are a fingerprint", async () => {
    const c = await changeOf("blob.dat", Buffer.from([0xff, 0xfe, 0x41, 0x80]), Buffer.from([0xff, 0xfe, 0x42, 0x80]));
    assert.equal(c.generic.tier, "fingerprint");
  });

  it("one side text and the other binary is a fingerprint", async () => {
    const c = await changeOf("mixed.json", "{}\n", Buffer.from([0, 1, 2]));
    assert.equal(c.generic.tier, "fingerprint");
  });

  it("a file with no stored bytes is a fingerprint, with the reason in words", async () => {
    const c = await changeOf("gone.py", "a = 1\n", "a = 2\n", { unstored: "before" });
    assert.equal(c.generic.tier, "fingerprint");
    assert.match(c.generic.fingerprint!.note, /not available/);
  });

  it("a secret file is secret by default, through the default load path with no stub", async () => {
    for (const name of [".env", "a/b/.env", ".env.production", "deploy/key.pem", "id_rsa", ".npmrc"]) {
      const c = await changeOf(name, "API_KEY=SENTINEL_SECRET_1\n", "API_KEY=SENTINEL_SECRET_2\n");
      assert.equal(c.generic.tier, "fingerprint", name);
      assert.equal(c.generic.secret, true, name);
      assert.equal(c.generic.text, undefined, name);
      assert.equal(c.generic.label, secretLine(name), name);
      assert.equal(c.generic.label, `A secret file was changed: ${name}`);
      assert.equal(c.format, null, name);
      assert.ok(!JSON.stringify(c).includes("SENTINEL_SECRET"), `no secret content anywhere in the change for ${name}`);
    }
  });

  it("the sentinel appears nowhere in the timeline JSON, a created or deleted secret file included", async () => {
    for (const [b, a] of [[null, "TOKEN=SENTINEL_SECRET_3\n"], ["TOKEN=SENTINEL_SECRET_4\n", null]] as const) {
      const c = await changeOf("a/b/.env", b, a);
      assert.equal(c.generic.secret, true);
      assert.ok(!JSON.stringify(c).includes("SENTINEL_SECRET"));
    }
  });

  it("isSecretPath matches by base name at any depth and leaves ordinary files alone", () => {
    for (const yes of [".env", "x/.env", ".env.local", "k.pem", "a/b/server.key", "c.p12", "c.pfx", "id_rsa", "id_rsa.pub", "id_ed25519", "credentials.json", "secrets.yaml", ".npmrc", ".netrc", ".pypirc"]) assert.equal(isSecretPath(yes), true, yes);
    for (const no of ["environment.md", "notes.txt", "env", "keyboard.ts", "monkey.py", "secrets-guide.md", "dir.env/readme.txt"]) assert.equal(isSecretPath(no), false, no);
  });

  it("a custom isSecret replaces the default (the flag alone decides)", async () => {
    const c = await changeOf(".env", "A=1\n", "A=2\n", { isSecret: () => false });
    assert.equal(c.generic.tier, "text");
    assert.equal(c.generic.secret, undefined);
  });

  it("tier order is text, then picture, then the floor: a text file is text, an image file is a picture (svg too), any other binary is the floor", async () => {
    const t = await changeOf("run.py", "a = 11\n", "a = 22\n");
    assert.equal(t.generic.tier, "text");
    const b = await changeOf("shot.png", Buffer.from([0, 1, 2]), Buffer.from([0, 1, 3]));
    assert.equal(b.generic.tier, "picture");
    const s = await changeOf("logo.svg", '<svg><rect width="1"/></svg>\n', '<svg><rect width="2"/></svg>\n');
    assert.equal(s.generic.tier, "picture");
    const f = await changeOf("blob.bin", Buffer.from([0, 1, 2]), Buffer.from([0, 1, 3]));
    assert.equal(f.generic.tier, "fingerprint");
  });

  it("line-ending-only change: text tier, no lines listed, says why", async () => {
    const c = await changeOf("crlf.txt", "a\nb\n", "a\r\nb\r\n");
    assert.equal(c.generic.tier, "text");
    assert.deepEqual(c.generic.text!.hunks, []);
    assert.match(c.generic.label, /no line changed/);
  });

  it("the format part stays beside generic and never replaces it", async () => {
    const c = await changeOf("notes.txt", "a\n", "b\n");
    assert.equal(c.format?.module, "files");
    assert.equal(c.generic.tier, "text");
  });
});

describe("the files layer reads text by content too", () => {
  it("a .py edit is a line row, not 'binary file changed'", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-layer-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(path.join(dir, "a.py"), "x = 1\n");
    await writeFile(path.join(dir, "b.py"), "x = 2\n");
    const rows = await createFilesLayer().diff(path.join(dir, "a.py"), path.join(dir, "b.py"));
    assert.deepEqual(rows.map((r) => r.kind), ["line changed"]);
  });
  it("a NUL-bearing .txt-less binary stays 'binary file changed'", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-layer-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(path.join(dir, "a.bin"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(dir, "b.bin"), Buffer.from([0, 1, 3]));
    const rows = await createFilesLayer().diff(path.join(dir, "a.bin"), path.join(dir, "b.bin"));
    assert.deepEqual(rows.map((r) => r.kind), ["binary file changed"]);
  });
});
