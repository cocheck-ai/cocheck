import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { utimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeSessionTitle, codexSessionTitle, copilotSessionTitle, TITLE_MAX } from "../src/hosts/session-titles.ts";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { creditCounts, sessionName, shortenRequest } from "../src/home-page.ts";
import { homePage, readOrCreateToken, startReviewServer } from "../src/review-server.ts";

// the home page and the harness session names. Every file here is a synthetic fixture made in a temp folder; nothing reads a real
// ~/.claude, ~/.codex or ~/.copilot (an unset root is refused under the test runner, and one test says so).
const scratch = mkdtempSync(path.join(tmpdir(), "cocheck-"));
let n = 0;
const dir = (name: string): string => {
  const d = path.join(scratch, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const uuid = (k: number): string => `${String(k).padStart(8, "0")}-1111-4222-8333-444444444444`;
const U1 = uuid(1);
const U2 = uuid(2);
const U3 = uuid(3);

/** A snapshot of a folder: every file's name, size, mtime and content hash. Equal before and after means nothing was written, created or removed. */
function snapshot(root: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(root, p)}|${statSync(p).size}|${statSync(p).mtimeMs}|${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return out.join("\n");
}

function claudeFixture(records: Record<string, string[]>): string {
  const root = dir("claude-projects");
  mkdirSync(path.join(root, "-work-proj"), { recursive: true });
  for (const [session, lines] of Object.entries(records)) writeFileSync(path.join(root, "-work-proj", `${session}.jsonl`), lines.join("\n") + "\n");
  return root;
}
const aiTitle = (session: string, title: string): string => JSON.stringify({ type: "ai-title", sessionId: session, aiTitle: title });
const userLine = (text: string): string => JSON.stringify({ type: "user", message: { role: "user", content: text } });

describe("Claude Code title reader", () => {
  it("a wrong session id never yields another session's title", () => {
    const root = claudeFixture({ [U1]: [aiTitle(U1, "Alpha work")], [U2]: [aiTitle(U2, "Beta work")] });
    assert.equal(claudeSessionTitle(U1, root), "Alpha work");
    assert.equal(claudeSessionTitle(U2, root), "Beta work");
    assert.equal(claudeSessionTitle(U3, root), undefined, "an id with no transcript has no title, not the newest one");
    for (const bad of ["../x", "a/b", "", ".hidden", `${U1}/../${U2}`, U1.slice(0, 20)]) assert.equal(claudeSessionTitle(bad, root), undefined, bad);
  });

  it("a record in the file that names another session id is skipped", () => {
    const root = claudeFixture({ [U1]: [aiTitle(U1, "Own title"), aiTitle(U2, "Forked-from title (later in the file)")] });
    assert.equal(claudeSessionTitle(U1, root), "Own title");
    const only = claudeFixture({ [U1]: [aiTitle(U2, "Someone else's")] });
    assert.equal(claudeSessionTitle(U1, only), undefined);
  });

  it("the last ai-title wins, and only the title string leaves the reader", () => {
    const root = claudeFixture({ [U1]: [userLine("TRANSCRIPT-SECRET-ONE build the model"), aiTitle(U1, "First title"), userLine("TRANSCRIPT-SECRET-TWO"), aiTitle(U1, "Final   title\twith\nbreaks"), userLine("TRANSCRIPT-SECRET-THREE")] });
    const title = claudeSessionTitle(U1, root);
    assert.equal(title, "Final title with breaks");
    assert.doesNotMatch(String(title), /TRANSCRIPT-SECRET/);
  });

  it("a very long title is capped", () => {
    const root = claudeFixture({ [U1]: [aiTitle(U1, "x".repeat(5000))] });
    assert.ok([...claudeSessionTitle(U1, root)!].length <= TITLE_MAX);
  });

  it("finds the title in a transcript larger than one read block", () => {
    const filler = Array.from({ length: 4000 }, (_, i) => userLine(`filler line ${i} ${"y".repeat(120)}`));
    const root = claudeFixture({ [U1]: [aiTitle(U1, "Early title"), ...filler] });
    assert.equal(claudeSessionTitle(U1, root), "Early title");
    const late = claudeFixture({ [U1]: [...filler, aiTitle(U1, "Late title"), ...filler.slice(0, 50)] });
    assert.equal(claudeSessionTitle(U1, late), "Late title");
  });

  it("a missing, corrupt or non-title file answers undefined without throwing", () => {
    assert.equal(claudeSessionTitle(U1, path.join(scratch, "no-such-root")), undefined);
    const garbage = claudeFixture({ [U1]: ["{not json", '{"type":"ai-title"', '"ai-title"', JSON.stringify({ type: "ai-title", sessionId: U1, aiTitle: 42 }), JSON.stringify({ type: "ai-title", sessionId: U1 })] });
    assert.equal(claudeSessionTitle(U1, garbage), undefined);
  });

  it("is read-only: the folder is byte-identical after a read", () => {
    const root = claudeFixture({ [U1]: [aiTitle(U1, "Alpha")] });
    const before = snapshot(root);
    claudeSessionTitle(U1, root);
    claudeSessionTitle(U2, root);
    assert.equal(snapshot(root), before);
  });
});

function codexFixture(opts: { index?: string[]; threads?: Array<[string, string]>; wal?: boolean }): string {
  const root = dir("codex-home");
  if (opts.index) writeFileSync(path.join(root, "session_index.jsonl"), opts.index.join("\n") + "\n");
  if (opts.threads) {
    const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
    db.exec(`${opts.wal ? "PRAGMA journal_mode=WAL;" : ""}CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT)`);
    for (const [id, title] of opts.threads) db.prepare("INSERT INTO threads (id, title, first_user_message) VALUES (?, ?, 'CODEX-SECRET-PROMPT')").run(id, title);
    db.close();
  }
  return root;
}
const idx = (id: string, name: string): string => JSON.stringify({ id, thread_name: name, updated_at: "2026-11-01T00:00:00Z" });

describe("Codex title reader", () => {
  it("thread_name from the index, by exact id, last line wins", () => {
    const root = codexFixture({ index: [idx(U1, "Old name"), idx(U2, "Other thread"), idx(U1, "New name")] });
    assert.equal(codexSessionTitle(U1, root), "New name");
    assert.equal(codexSessionTitle(U2, root), "Other thread");
    assert.equal(codexSessionTitle(U3, root), undefined, "a wrong session id never yields another thread's name");
  });

  it("threads.title when the index has no name for the thread; the index wins when it has one", () => {
    const root = codexFixture({ index: [idx(U1, "Indexed")], threads: [[U1, "Db title 1"], [U2, "Db title 2"]] });
    assert.equal(codexSessionTitle(U1, root), "Indexed");
    assert.equal(codexSessionTitle(U2, root), "Db title 2");
    assert.equal(codexSessionTitle(U3, root), undefined);
  });

  it("returns only the title, never the thread's other columns", () => {
    const root = codexFixture({ threads: [[U1, "Db title"]] });
    const title = codexSessionTitle(U1, root);
    assert.equal(title, "Db title");
    assert.doesNotMatch(String(title), /CODEX-SECRET/);
  });

  it("is read-only: a WAL-mode database and the index are byte-identical after a read, and no -shm or -wal appears", () => {
    const root = codexFixture({ index: [idx(U1, "Indexed")], threads: [[U2, "Db title"]], wal: true });
    const before = snapshot(root);
    codexSessionTitle(U1, root);
    codexSessionTitle(U2, root);
    codexSessionTitle(U3, root);
    assert.equal(snapshot(root), before);
    assert.deepEqual(readdirSync(root).filter((f) => /-(shm|wal)$/.test(f)), []);
  });

  it("a corrupt index, a corrupt database or a missing folder answers undefined without throwing", () => {
    const root = dir("codex-bad");
    writeFileSync(path.join(root, "session_index.jsonl"), "{nope\n\u0000\u0001garbage\n");
    writeFileSync(path.join(root, "state_5.sqlite"), "this is not a database");
    assert.equal(codexSessionTitle(U1, root), undefined);
    assert.equal(codexSessionTitle(U1, path.join(scratch, "absent")), undefined);
    assert.equal(codexSessionTitle("not-a-uuid", root), undefined);
  });
});

function copilotFixture(files: Record<string, string>): string {
  const root = dir("copilot-state");
  for (const [session, yaml] of Object.entries(files)) {
    mkdirSync(path.join(root, session), { recursive: true });
    writeFileSync(path.join(root, session, "workspace.yaml"), yaml);
  }
  return root;
}

describe("Copilot title reader", () => {
  it("name from workspace.yaml (plain and quoted), by exact session folder", () => {
    const root = copilotFixture({ [U1]: `id: ${U1}\ncwd: /work\nname: Refactor the parser\nuser_named: false\n`, [U2]: `id: ${U2}\nname: "Quoted: name"\n` });
    assert.equal(copilotSessionTitle(U1, root), "Refactor the parser");
    assert.equal(copilotSessionTitle(U2, root), "Quoted: name");
    assert.equal(copilotSessionTitle(U3, root), undefined);
  });

  it("a workspace.yaml whose id is another session is refused, and a missing name is undefined", () => {
    const root = copilotFixture({ [U1]: `id: ${U2}\nname: Not mine\n`, [U3]: `id: ${U3}\ncwd: /work\n` });
    assert.equal(copilotSessionTitle(U1, root), undefined);
    assert.equal(copilotSessionTitle(U3, root), undefined);
  });

  it("is read-only and survives a missing or binary file", () => {
    const root = copilotFixture({ [U1]: `id: ${U1}\nname: Mine\n`, [U2]: "\u0000\u0001\u0002" });
    const before = snapshot(root);
    assert.equal(copilotSessionTitle(U1, root), "Mine");
    assert.doesNotThrow(() => copilotSessionTitle(U2, root));
    assert.equal(copilotSessionTitle(U3, path.join(scratch, "absent")), undefined);
    assert.equal(snapshot(root), before);
  });
});

describe("the strict workspace.yaml reader", () => {
  const wsRoot = (content: string | Buffer): string => {
    const root = dir("copilot-ws");
    mkdirSync(path.join(root, U1), { recursive: true });
    writeFileSync(path.join(root, U1, "workspace.yaml"), content);
    return root;
  };
  const titleOf = (content: string | Buffer, session = U1): string | undefined => copilotSessionTitle(session, wsRoot(content));
  const file = (nameLine: string, extra = ""): string => `id: ${U1}\ncwd: /work\n${nameLine}\nuser_named: false\n${extra}`;
  const nameOf = (value: string): string | undefined => titleOf(file(`name: ${value}`));
  const table = (rows: Array<[string, string | undefined]>, make: (input: string) => string | undefined): void => {
    for (const [input, want] of rows) assert.equal(make(input), want, JSON.stringify(input));
  };

  it("the recorded 1.0.93 workspace.yaml, verbatim, gives its name with '' unescaped", () => {
    const sample = readFileSync(path.join(import.meta.dirname, "..", "platforms", "copilot-cli", "versions", "1.0.93", "session-workspace.yaml"), "utf8");
    const sid = "a192d0a1-4f6c-4619-a1fa-51d2fff6e1b0";
    const root = dir("copilot-real");
    mkdirSync(path.join(root, sid), { recursive: true });
    writeFileSync(path.join(root, sid, "workspace.yaml"), sample);
    assert.equal(copilotSessionTitle(sid, root), "Say what you do before each command. Run two shell commands: 'wc -l data.csv' then 'head -n 2 data.csv'. Then say done.");
    assert.equal(copilotSessionTitle(U1, root), undefined, "the same file is nobody else's");
  });

  it("values that are titles", () => {
    table(
      [
        ['"a\\tb\\e c"', "a b c"],
        ["Issue#12 fix", "Issue#12 fix"],
        ["a:b", "a:b"],
        ["-x title", "-x title"],
        ["?x", "?x"],
        [":x", ":x"],
        ["Fix a, b [x]", "Fix a, b [x]"],
        ["Plain title # a comment", "Plain title"],
        ["'It''s fine'", "It's fine"],
        ["'Single' # c", "Single"],
        ['"Quoted: name"  # c', "Quoted: name"],
        ['"Say \\"hi\\" \\x41\\u00e9\\U0001F600 \\/ \\\\"', 'Say "hi" Aé\u{1F600} / \\'],
        ["null thing", "null thing"],
        ["Fix a > b in x", "Fix a > b in x"],
      ],
      nameOf,
    );
  });

  it("a 300-character one-line name is capped by cleanTitle", () => {
    assert.ok([...nameOf("w".repeat(300))!].length <= TITLE_MAX);
  });

  it("wrong session: the id must be present, single-line, and exactly this session", () => {
    const body = `cwd: /work\nname: Mine\n`;
    const cases: Array<[string, string]> = [
      ["id missing", body],
      ["id another session", `id: ${U2}\n${body}`],
      ["id as anchor", `id: &a ${U1}\n${body}`],
      ["id as block scalar", `id: |\n  ${U1}\n${body}`],
      ["id as folded scalar", `id: >-\n  ${U1}\n${body}`],
      ["id empty", `id:\n${body}`],
      ["BOM then another id", `﻿id: ${U2}\n${body}`],
      ["id only nested", `meta:\n  id: ${U1}\n${body}`],
      ["duplicate id, wrong first", `id: ${U2}\nid: ${U1}\n${body}`],
      ["duplicate id, right first", `id: ${U1}\nid: ${U2}\n${body}`],
      ["a second document with its own id and name", `id: ${U1}\n${body}---\nid: ${U2}\nname: Other\n`],
      ["id in quotes of another session", `id: "${U2}"\n${body}`],
    ];
    for (const [label, content] of cases) assert.equal(titleOf(content), undefined, label);
    assert.equal(titleOf(`﻿id: ${U1}\n${body}`), "Mine", "a leading BOM on the right id is stripped once");
    assert.equal(titleOf(`id: "${U1}" # c\n${body}`), "Mine");
  });

  it("cut-off values: a value that continues on another line is no title", () => {
    const cases: Array<[string, string]> = [
      ["plain name folded onto an indented next line", file("name: foo bar\n  baz qux")],
      ["folded double-quoted", file('name: "foo\n  bar"')],
      ["folded single-quoted", file("name: 'foo\n  bar'")],
      ["value on the next indented line", file("name:\n  foo")],
      ["name, a comment line, then an indented line", file("name: foo\n# note\n  more")],
      ["id folded", `id: ${U1}\n  more\ncwd: /w\nname: Mine\n`],
    ];
    for (const [label, content] of cases) assert.equal(titleOf(content), undefined, label);
    assert.equal(titleOf(file("name: foo\n# note\n\n")), "foo", "comments and blank lines after a value do not cut it");
  });

  it("syntax is no title", () => {
    table(
      [
        ["|", undefined], ["|-", undefined], [">", undefined], [">-", undefined], ["# c", undefined], ["#c", undefined], ["?", undefined], ["...", undefined], ["---", undefined],
        ["- x".slice(0, 1), undefined], ["- x", undefined], ["? x", undefined], [": x", undefined], ["foo: bar", undefined], ["foo:", undefined], ["name:value", "name:value"],
        ["''", undefined], ['""', undefined], ['"bad \\q"', undefined], ['"\\uD800"', undefined], ['"\\U00110000"', undefined], ['"\\x4"', undefined], ['"tab\u0001ctl"', undefined],
        ["&anchor value", undefined], ["*alias", undefined], ["!!str tagged", undefined], ["!tag x", undefined], ["{a: 1}", undefined], ["[a, b]", undefined],
        ["~", undefined], ["null", undefined], ["Null", undefined], ["NULL", undefined], ['"unterminated', undefined], ["'unterminated", undefined],
        ['"two" trailing', undefined], ["'two' trailing", undefined], ["%x", undefined], ["@x", undefined], ["`x", undefined], ["x: y", undefined], ["tab\u0001ctl", undefined],
      ],
      nameOf,
    );
    for (const ch of [..."-?:,[]{}#&*!|>'\"%@`"]) {
      const asTitle = "-?:".includes(ch) ? `${ch}x` : undefined;
      assert.equal(nameOf(`${ch}x title`.slice(0, 1) + "x"), asTitle, `first character ${ch}`);
      assert.equal(nameOf(`${ch} x`), undefined, `${ch} then a space`);
    }
    const files: Array<[string, string]> = [
      ["a column-0 tab line", `id: ${U1}\n\tname: x\nname: Mine\n`],
      ["%YAML", `%YAML 1.2\n${file("name: Mine")}`],
      ["a flow-mapping file", `{id: ${U1}, name: Mine}\n`],
      ["a document marker", `---\n${file("name: Mine")}`],
      ["a sequence line", `- id: ${U1}\n  name: Mine\n`],
      ["a quoted key", `"name": Mine\nid: ${U1}\n`],
      ["no space after the colon", `id: ${U1}\nname:Mine\n`],
      ["key space colon", `id: ${U1}\nname : Mine\n`],
      ["a flow-style line at column 0", `id: ${U1}\n[a, b]\nname: Mine\n`],
    ];
    for (const [label, content] of files) assert.equal(titleOf(content), undefined, label);
  });

  it("the wrong key is never read as the name", () => {
    const cases: Array<[string, string]> = [
      ["name nested under another key", `id: ${U1}\nmeta:\n  name: Fake\n`],
      ["branch_name only", `id: ${U1}\nbranch_name: Fake\n`],
      ["display_name only", `id: ${U1}\ndisplay_name: Fake\n`],
      ["a commented name", `id: ${U1}\n# name: Fake\n`],
      ["summary block holding name: Fake", `id: ${U1}\nsummary: |\n  name: Fake\n`],
    ];
    for (const [label, content] of cases) assert.equal(titleOf(content), undefined, label);
    assert.equal(titleOf(`id: ${U1}\nbranch_name: Fake\nname: Real\ndisplay_name: Fake\n`), "Real");
    assert.equal(titleOf(`id: ${U1}\nname: Real\nmeta:\n  name: Fake\n`), "Real", "an indented name under a later key is not the top-level name");
  });

  it("a U+2028 inside a value is not a line break: the file-shape gate refuses the file", () => {
    assert.equal(titleOf(`id: ${U1}\ncwd: /a name: Fake\nname: Real\n`), undefined);
    assert.equal(titleOf(`id: ${U1}\ncwd: /a b\nname: Real\n`), undefined);
  });

  it("CRLF and CR-only files read correctly", () => {
    assert.equal(titleOf(file("name: Mine").replace(/\n/g, "\r\n")), "Mine");
    assert.equal(titleOf(file("name: Mine").replace(/\n/g, "\r")), "Mine");
    assert.equal(titleOf(file("name: 'It''s'").replace(/\n/g, "\r\n")), "It's");
  });

  it("is read-only; binary, invalid UTF-8 and oversized files answer undefined", () => {
    const root = wsRoot(file("name: Mine"));
    const before = snapshot(root);
    assert.equal(copilotSessionTitle(U1, root), "Mine");
    assert.equal(snapshot(root), before);
    assert.equal(titleOf(Buffer.from([0x00, 0x01, 0x02, 0xff])), undefined);
    assert.equal(titleOf(Buffer.concat([Buffer.from(`id: ${U1}\nname: `), Buffer.from([0xc3, 0x28]), Buffer.from("\n")])), undefined, "invalid UTF-8");
    assert.equal(titleOf(`id: ${U1}\nname: Mine\n# ${"x".repeat(1024 * 1024)}\n`), undefined, "over 1 MiB");
  });
});

describe("Claude title across project folders", () => {
  const two = (a: string[] | undefined, b: string[] | undefined, newer: "a" | "b" | "none" = "none"): string => {
    const root = dir("claude-two");
    for (const [name, lines, when] of [["-aaa", a, newer === "a" ? 2_000_000_000 : 1_000_000_000], ["-bbb", b, newer === "b" ? 2_000_000_000 : 1_000_000_000]] as const) {
      mkdirSync(path.join(root, name), { recursive: true });
      if (lines !== undefined) {
        const f = path.join(root, name, `${U1}.jsonl`);
        writeFileSync(f, lines.join("\n") + "\n");
        utimesSync(f, when, when);
      }
    }
    return root;
  };
  it("a first folder holding the file with no title does not hide a later folder's title", () => {
    assert.equal(claudeSessionTitle(U1, two([userLine("no title here")], [aiTitle(U1, "From bbb")])), "From bbb");
  });
  it("when several folders hold a title, the newest file wins", () => {
    assert.equal(claudeSessionTitle(U1, two([aiTitle(U1, "From aaa")], [aiTitle(U1, "From bbb")], "a")), "From aaa");
    assert.equal(claudeSessionTitle(U1, two([aiTitle(U1, "From aaa")], [aiTitle(U1, "From bbb")], "b")), "From bbb");
  });
  it("another session's file name is still never opened", () => {
    assert.equal(claudeSessionTitle(U2, two([aiTitle(U1, "From aaa")], [aiTitle(U1, "From bbb")])), undefined);
  });
});

describe("readers refuse the real home under the test runner", () => {
  it("with no root and no environment variable, each answers undefined (the real ~/.claude, ~/.codex and ~/.copilot are never read)", () => {
    const keep = { c: process.env.CLAUDE_CONFIG_DIR, x: process.env.CODEX_HOME, p: process.env.COPILOT_HOME };
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    delete process.env.COPILOT_HOME;
    try {
      assert.equal(claudeSessionTitle(U1), undefined);
      assert.equal(codexSessionTitle(U1), undefined);
      assert.equal(copilotSessionTitle(U1), undefined);
    } finally {
      if (keep.c !== undefined) process.env.CLAUDE_CONFIG_DIR = keep.c;
      if (keep.x !== undefined) process.env.CODEX_HOME = keep.x;
      if (keep.p !== undefined) process.env.COPILOT_HOME = keep.p;
    }
  });
});

// ---- the home page ----

const FOLDER = "/work/demo";
const claudeClient = (session?: string): string => `claude-hook:${FOLDER}${session === undefined ? "" : `?session=${session}`}`;
const codexClient = (session: string): string => `codex-hook:${FOLDER}?session=${session}`;

interface FileSpec {
  file: string;
  credited?: string[];
  basis?: "argv-tag" | "host-reported-edit" | "unattributed";
  same?: boolean;
}

function addTask(ledger: Ledger, client: string, createdAt: string, files: FileSpec[], opts: { prompt?: string; steps?: number } = {}): number {
  const id = ledger.openTask(client, new Date(createdAt));
  files.forEach((f, i) => {
    const sha = createHash("sha256").update(`${f.file}-${i}`).digest("hex");
    ledger.recordStep({
      taskId: id,
      client,
      seq: i + 1,
      phase: "Post",
      callsOpen: [],
      credited: [],
      files: [{ filePath: `${FOLDER}/${f.file}`, sha256: sha, prevSha256: f.same ? sha : "0".repeat(64), size: 3, kept: "hash", note: "", credited: f.credited ?? [], ...(f.basis === undefined ? {} : { creditBasis: f.basis }) }],
    });
  });
  if (opts.prompt !== undefined) ledger.recordOp({ taskId: id, tool: "hook", args: { hookEvent: "UserPromptSubmit", session_id: "s", prompts: [opts.prompt] }, intent: "", durationMs: 0, resultCode: "ok" });
  return id;
}

function homeLedger(): { ledger: Ledger; home: string } {
  const home = dir("cocheck-home");
  return { ledger: openLedger(home), home };
}

const credit = (file: string): FileSpec => ({ file, credited: ["call-1"], basis: "host-reported-edit" });
const text = (html: string): string => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

const trk = (host: string, session: string, folder: string) => ({ host, session, folder, since: "2026-11-02T10:00:00Z" });

describe("home: one row per task", () => {
  it("every session is a row, newest first, each linking to its own review page; the default status has no pill or glyph", () => {
    const { ledger } = homeLedger();
    const old = addTask(ledger, claudeClient(U1), "2026-10-28T10:00:00Z", [credit("old.txt")], { prompt: "OLD-REQUEST first" });
    ledger.appendStopVerdict({ taskId: old, stopId: "chg-c1", subject: "s", fingerprint: "f", status: "passed", note: "", reviewer: "me" });
    const mid = addTask(ledger, claudeClient(U2), "2026-10-30T10:00:00Z", [credit("mid.txt")], { prompt: "MID-REQUEST second" });
    const newest = addTask(ledger, codexClient(U3), "2026-11-02T10:00:00Z", [credit("new.txt")], { prompt: "NEW-REQUEST third" });
    const html = homePage(ledger, "tok");
    const rows = [...html.matchAll(/<a class="row" href="([^"]+)">([\s\S]*?)<\/a>/g)];
    assert.deepEqual(rows.map((m) => m[1]), [`/timeline/${newest}/review?t=tok`, `/timeline/${mid}/review?t=tok`, `/timeline/${old}/review?t=tok`], "newest first");
    assert.match(rows[0]![2]!, /NEW-REQUEST third/);
    assert.match(rows[1]![2]!, /MID-REQUEST second/);
    assert.match(rows[2]![2]!, /OLD-REQUEST first/);
    assert.match(rows[2]![2]!, /title="In review"/, "a marked task shows a glyph");
    assert.doesNotMatch(rows[0]![2]!, /title="|role="img"/, "the default standing shows nothing");
    assert.doesNotMatch(html, /Not reviewed|class="pill|class="hero|Review session/);
    assert.doesNotMatch(html, /text-transform:\s*uppercase/, "no all-caps headers");
    assert.match(html, /<h3>(Today|Earlier)<\/h3>/);
    ledger.close();
  });

  it("sessions that are tracking but empty collapse to one line naming the folders", () => {
    const { ledger } = homeLedger();
    const none = homePage(ledger, "tok", {}, [trk("codex", "s1", "/w/codex-run"), trk("claude", "s2", "/w/b"), trk("claude", "s3", "/w/c")]);
    assert.match(text(none), /Tracking in codex-run and 2 more, nothing recorded yet/);
    assert.equal(none.split("Tracking in").length - 1, 1);
    assert.match(text(homePage(ledger, "tok", {}, [trk("codex", "s1", "/w/codex-run")])), /Tracking in codex-run, nothing recorded yet/);
    ledger.close();
  });

  it("with nothing unreviewed the page says how many still wait; with no session there is no row", () => {
    const { ledger } = homeLedger();
    const empty = homePage(ledger, "tok");
    assert.doesNotMatch(empty, /class="row"|Review session/);
    assert.match(empty, /No sessions yet\. Sessions start untracked/);
    const t = addTask(ledger, claudeClient(U1), "2026-10-28T10:00:00Z", [credit("a.txt")]);
    ledger.appendStopVerdict({ taskId: t, stopId: "chg-c1", subject: "s", fingerprint: "f", status: "failed", note: "", reviewer: "me" });
    const html = homePage(ledger, "tok");
    assert.doesNotMatch(html, /Review session/);
    assert.match(html, /1 session marked but not signed off yet/);
    assert.doesNotMatch(html, /Nothing is waiting/);
    assert.match(html, new RegExp(`<a class="row" href="/timeline/${t}/review\\?t=tok">`));
    ledger.close();
  });

  it("the old review list is gone: each session appears once", () => {
    const { ledger } = homeLedger();
    const t = addTask(ledger, claudeClient(U1), "2026-10-28T10:00:00Z", [credit("a.txt")]);
    const html = homePage(ledger, "tok");
    assert.doesNotMatch(html, /Review list|nothing marked yet/);
    assert.equal(html.split(`/timeline/${t}/review`).length - 1, 1);
    ledger.close();
  });
});

describe("host label", () => {
  it("a Claude Code task is labelled Claude Code, as in mockup D", () => {
    const { ledger } = homeLedger();
    addTask(ledger, claudeClient(U1), "2026-10-28T10:00:00Z", [credit("a.txt")]);
    addTask(ledger, claudeClient(U2), "2026-10-29T10:00:00Z", [credit("b.txt")]);
    const flat = text(homePage(ledger, "tok"));
    assert.match(flat, /Claude Code/);
    assert.doesNotMatch(flat, /Claude (?!Code)/);
    ledger.close();
  });
});

describe("home: counts are credited files only", () => {
  it("credited files are counted and the rest are a note", () => {
    const states = [
      { filePath: "/w/a.txt", sha256: "a1", prevSha256: null, credited: ["c1"], creditBasis: "argv-tag" },
      { filePath: "/w/a.txt", sha256: "a2", prevSha256: "a1", credited: ["c2"], creditBasis: "host-reported-edit" },
      { filePath: "/w/b.txt", sha256: "b1", prevSha256: null, credited: [], creditBasis: null },
      { filePath: "/w/c.txt", sha256: "c1", prevSha256: null, credited: ["c3"], creditBasis: "unattributed" },
      { filePath: "/w/d.txt", sha256: "d1", prevSha256: "d1", credited: ["c4"], creditBasis: "argv-tag" },
    ] as unknown as Parameters<typeof creditCounts>[0];
    const c = creditCounts(states);
    assert.equal(c.credited, 1);
    assert.equal(c.uncredited, 2);
    assert.deepEqual(c.shown, ["/w/a.txt"]);
  });

  it("the card shows the credited count and the uncredited note, and the folder is not the session's work", () => {
    const { ledger } = homeLedger();
    addTask(ledger, claudeClient(U1), "2026-10-28T10:00:00Z", [credit("one.txt"), credit("two.txt"), { file: "found.txt" }, { file: "other.txt", credited: ["c"], basis: "unattributed" }], { prompt: "do things" });
    const t2 = addTask(ledger, claudeClient(U2), "2026-10-29T10:00:00Z", [credit("solo.txt")], { prompt: "solo" });
    ledger.appendStopVerdict({ taskId: t2, stopId: "chg-c1", subject: "s", fingerprint: "f", status: "passed", note: "", reviewer: "me" });
    const html = homePage(ledger, "tok");
    const flat = text(html);
    assert.match(flat, /2 files/);
    assert.match(flat, /\+ 2 found changed on disk, not credited/);
    assert.match(flat, /1 file\b/);
    assert.doesNotMatch(html, /found\.txt|other\.txt/, "uncredited files are counted, never listed as the session's work");
    ledger.close();
  });
});

describe("home: names", () => {
  it("each session shows its own harness title; a session with no title file falls back to its own first request, never another's title", () => {
    const { ledger } = homeLedger();
    const cl = claudeFixture({ [U1]: [aiTitle(U1, "Alpha harness title")], [U2]: [aiTitle(U2, "Beta harness title")] });
    const cx = codexFixture({ index: [idx(U3, "Gamma codex thread")] });
    const a = addTask(ledger, claudeClient(U1), "2026-10-28T10:00:00Z", [credit("a.txt")], { prompt: "request a" });
    const b = addTask(ledger, claudeClient(U2), "2026-10-29T10:00:00Z", [credit("b.txt")], { prompt: "request b" });
    const c = addTask(ledger, codexClient(U3), "2026-10-30T10:00:00Z", [credit("c.txt")], { prompt: "request c" });
    const d = addTask(ledger, claudeClient(uuid(9)), "2026-10-31T10:00:00Z", [credit("d.txt")], { prompt: "Create the quarterly summary and then also do a second long thing that goes on and on past the cut" });
    const roots = { claude: cl, codex: cx };
    assert.equal(sessionName(ledger, a, roots).name, "Alpha harness title");
    assert.equal(sessionName(ledger, b, roots).name, "Beta harness title");
    assert.equal(sessionName(ledger, c, roots).name, "Gamma codex thread");
    const fallback = sessionName(ledger, d, roots);
    assert.equal(fallback.from, "request");
    assert.match(fallback.name, /^Create the quarterly summary/);
    assert.ok(fallback.name.length < 70 && fallback.name.endsWith("…"), fallback.name);
    const html = homePage(ledger, "tok", roots);
    for (const [id, name] of [[a, "Alpha harness title"], [b, "Beta harness title"], [c, "Gamma codex thread"]] as const) {
      const card = new RegExp(`/timeline/${id}/review\\?t=tok">([\\s\\S]*?)</a>`).exec(html)?.[1] ?? new RegExp(`class="hero"[\\s\\S]*?/timeline/${id}/review`).exec(html)?.[0] ?? "";
      assert.match(card, new RegExp(name), `task ${id}`);
    }
    ledger.close();
  });

  it("a task whose client names no session never takes a title, even when the folder holds transcripts", () => {
    const { ledger } = homeLedger();
    const cl = claudeFixture({ [U1]: [aiTitle(U1, "Somebody's title")] });
    const t = addTask(ledger, claudeClient(), "2026-10-28T10:00:00Z", [credit("a.txt")], { prompt: "folder-only client request" });
    assert.deepEqual(sessionName(ledger, t, { claude: cl }), { name: "folder-only client request", from: "request" });
    ledger.close();
  });

  it("a missing or corrupt harness file falls back to the shortened first request and the page still renders", () => {
    const { ledger } = homeLedger();
    const bad = claudeFixture({ [U1]: ["{{{ not json", "\u0000\u0001"] });
    const t = addTask(ledger, claudeClient(U1), "2026-10-28T10:00:00Z", [credit("a.txt")], { prompt: "fallback request text" });
    const none = addTask(ledger, claudeClient(U2), "2026-10-29T10:00:00Z", [credit("b.txt")]);
    for (const roots of [{ claude: bad }, { claude: path.join(scratch, "does-not-exist") }, {}] as Array<Record<string, string>>) {
      const html = homePage(ledger, "tok", roots);
      assert.match(html, /fallback request text/);
      assert.match(html, new RegExp(`Session ${none}`), "no title and no request: the plain id");
      assert.match(html, /<\/html>$/);
    }
    ledger.close();
    assert.equal(t > 0, true);
  });

  it("only the title is copied: no other transcript text reaches the page", () => {
    const { ledger } = homeLedger();
    const cl = claudeFixture({ [U1]: [userLine("TRANSCRIPT-SECRET please wire up the key sk-abc"), aiTitle(U1, "Just the title"), userLine("TRANSCRIPT-SECRET again")] });
    addTask(ledger, claudeClient(U1), "2026-10-28T10:00:00Z", [credit("a.txt")], { prompt: "typed request" });
    const html = homePage(ledger, "tok", { claude: cl });
    assert.match(html, /Just the title/);
    assert.doesNotMatch(html, /TRANSCRIPT-SECRET|sk-abc/);
    ledger.close();
  });

  it("names are HTML-escaped", () => {
    const { ledger } = homeLedger();
    const cl = claudeFixture({ [U1]: [aiTitle(U1, '<script>alert("x")</script> & <b>')] });
    addTask(ledger, claudeClient(U1), "2026-10-28T10:00:00Z", [credit("a.txt")]);
    const html = homePage(ledger, "tok", { claude: cl });
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &lt;b&gt;/);
    ledger.close();
  });

  it("shortenRequest keeps a short request whole and cuts a long one at a word", () => {
    assert.equal(shortenRequest("  Fix the bug\nand more lines"), "Fix the bug");
    assert.equal(shortenRequest("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"), "one two three four five six seven eight nine ten eleven twelve…");
  });
});

describe("home: served by the review server", () => {
  const closers: Array<() => void> = [];
  after(() => closers.forEach((c) => c()));

  it("GET / with the token serves the cards with harness names; the wrong token is refused; the harness folder is untouched", async () => {
    const { ledger, home } = homeLedger();
    const cl = claudeFixture({ [U1]: [aiTitle(U1, "Served title")] });
    const t = addTask(ledger, claudeClient(U1), "2026-10-28T10:00:00Z", [credit("a.txt")], { prompt: "r" });
    const before = snapshot(cl);
    const token = readOrCreateToken(home);
    const { server, port } = await startReviewServer(ledger, token, home, 0, undefined, { quickLook: false, titleRoots: { claude: cl } });
    closers.push(() => server.close());
    const res = await fetch(`http://127.0.0.1:${port}/?t=${token}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Served title/);
    assert.match(html, new RegExp(`href="/timeline/${t}/review\\?t=${token}"`));
    assert.equal((await fetch(`http://127.0.0.1:${port}/?t=wrong`)).status, 403);
    assert.equal(snapshot(cl), before);
    chmodSync(cl, 0o755);
  });
});
