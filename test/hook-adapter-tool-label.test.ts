import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// every call's op records `toolLabel`, taken from the tool input by an allowlist of field names that name things. Content
// fields are never stored, a secret-looking value or a URL query never reaches the ledger, and an odd input never blocks the hook.
const probe = path.join(import.meta.dirname, "fixtures", "probe", "S0.xlsx");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(host: "claude" | "codex" = "claude", outsideWatching = true) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  await copyFile(probe, path.join(folder, "casebook.xlsx"));
  cleanups.push(async () => {
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  const opts = { perSession: false, host, home, claimed: workbookClaims, folder, outsideWatching, now: () => (clock += 1000) };
  const send = (over: Record<string, unknown>) => handleHook({ session_id: "s1", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  let n = 0;
  /** One call with the given tool and raw input; returns the args of the op it logged (the whole JSON text too). */
  const call = async (tool_name: string, tool_input: unknown) => {
    const id = `c${++n}`;
    await send({ hook_event_name: "PreToolUse", tool_name, tool_use_id: id, tool_input });
    await send({ hook_event_name: "PostToolUse", tool_name, tool_use_id: id, tool_input });
    const ledger = openLedger(home);
    try {
      const rows = ledger.okOpsForTask(1, 0, ledger.maxOpId()).filter((o) => (JSON.parse(o.argsJson) as { tool_use_id?: string }).tool_use_id === id);
      assert.equal(rows.length, 1, "one op for the call");
      return { args: JSON.parse(rows[0]!.argsJson) as Record<string, any>, text: rows[0]!.argsJson };
    } finally {
      ledger.close();
    }
  };
  return { call, folder, send };
}

describe("toolLabel", () => {
  it("Read, Edit and Write record the file path only; a Write's content is never stored", async () => {
    const { call, folder } = await setup();
    const f = path.join(folder, "notes.md");
    assert.deepEqual((await call("Read", { file_path: f, offset: 3, limit: 10 })).args.toolLabel, { fields: { file_path: f } });
    const edit = await call("Edit", { file_path: f, old_string: "OLD-SECRET-BODY", new_string: "NEW-BODY-TEXT" });
    assert.deepEqual(edit.args.toolLabel, { fields: { file_path: f } });
    const write = await call("Write", { file_path: f, content: "WRITE-CONTENT-MUST-NOT-LAND" });
    assert.deepEqual(write.args.toolLabel, { fields: { file_path: f } });
    for (const r of [edit, write]) assert.ok(!/OLD-SECRET-BODY|NEW-BODY-TEXT|WRITE-CONTENT-MUST-NOT-LAND/.test(r.text));
  });

  it("Skill, ToolSearch, Glob, Grep and WebSearch record the name, query or pattern", async () => {
    const { call, folder } = await setup();
    assert.deepEqual((await call("Skill", { skill: "cocheck-excel", args: "do the thing" })).args.toolLabel, { fields: { skill: "cocheck-excel" } });
    assert.deepEqual((await call("ToolSearch", { query: "select:EndConversation", max_results: 3 })).args.toolLabel, { fields: { query: "select:EndConversation" } });
    assert.deepEqual((await call("Grep", { pattern: "foo\\(bar\\)", path: folder, output_mode: "content" })).args.toolLabel, { fields: { pattern: "foo\\(bar\\)", path: folder } });
    assert.deepEqual((await call("Glob", { pattern: "**/*.xlsx" })).args.toolLabel, { fields: { pattern: "**/*.xlsx" } });
    assert.deepEqual((await call("WebSearch", { query: "node test runner" })).args.toolLabel, { fields: { query: "node test runner" } });
  });

  it("a helper-agent call records its type, description and brief, cut keeping its ending", async () => {
    const { call } = await setup();
    const r = await call("Task", { subagent_type: "general-purpose", description: "Survey the repo", prompt: "BRIEF-TEXT first line\nsecond line" });
    assert.deepEqual(r.args.toolLabel, { fields: { subagent_type: "general-purpose", description: "Survey the repo", prompt: "BRIEF-TEXT first line\nsecond line" } });
    const long = `START-${"x ".repeat(5000)}-THE-END`;
    const f = (await call("Agent", { description: "d", prompt: long })).args.toolLabel as { fields: { prompt: string } };
    assert.ok(f.fields.prompt.length < long.length && f.fields.prompt.startsWith("START-") && f.fields.prompt.endsWith("-THE-END"), f.fields.prompt.slice(-30));
  });

  it("WebFetch records scheme, host and path; a token in the query or fragment never lands", async () => {
    const { call } = await setup();
    const r = await call("WebFetch", { url: "https://user:pw@example.com/docs/a?token=abc123SECRETvalue&x=1#frag", prompt: "summarise" });
    assert.deepEqual(r.args.toolLabel, { fields: { url: "https://example.com/docs/a" } });
    assert.ok(!/abc123SECRETvalue|user:pw|frag/.test(r.text));
    const bad = await call("WebFetch", { url: "not a url?token=zzzSECRET" });
    assert.equal(bad.args.toolLabel.fields.url, undefined);
    assert.ok(!bad.text.includes("zzzSECRET"));
  });

  it("an MCP tool records its input field names only, plus path and url fields", async () => {
    const { call } = await setup();
    const r = await call("mcp__github__search_code", { query: "repo:a/b filename:x", body: "BODY-NOT-STORED", per_page: 5 });
    assert.deepEqual(r.args.toolLabel, { fields: {}, inputFields: ["query", "body", "per_page"] });
    assert.ok(!/repo:a\/b|BODY-NOT-STORED/.test(JSON.stringify(r.args.toolLabel)));
    const u = await call("mcp__fetcher__get", { url: "https://user:pw@example.com/a/b?token=abc123SECRETvalue#frag", title: "T" });
    assert.deepEqual(u.args.toolLabel, { fields: { url: "https://example.com/a/b" }, inputFields: ["url", "title"] });
    assert.ok(!/abc123SECRETvalue|user:pw|frag/.test(u.text));
    const p = await call("mcp__fs__read", { path: "/w/a.txt", name: "NAME-NOT-STORED", pattern: "PAT-NOT-STORED" });
    assert.deepEqual(p.args.toolLabel.inputFields, ["path", "name", "pattern"]);
    assert.ok(!/NAME-NOT-STORED|PAT-NOT-STORED/.test(JSON.stringify(p.args.toolLabel)));
  });

  it("an MCP connector's query and title values never reach the label (email in a Gmail query, a Notion page title)", async () => {
    const { call } = await setup();
    const gmail = await call("mcp__claude_ai_Gmail__search_threads", { query: "from:jane.doe@example.com invoice", name: "Jane Doe" });
    const notion = await call("mcp__notion__create_page", { title: "Q4 layoff plan", pattern: "salary" });
    for (const r of [gmail, notion]) {
      const label = JSON.stringify(r.args.toolLabel);
      assert.ok(!/jane|example\.com|invoice|layoff|salary/i.test(label), label);
      assert.deepEqual(r.args.toolLabel.fields, {});
    }
    assert.deepEqual(gmail.args.toolLabel.inputFields, ["query", "name"]);
    assert.deepEqual(notion.args.toolLabel.inputFields, ["title", "pattern"]);
  });

  it("an unknown tool records its input field names, never values", async () => {
    const { call } = await setup();
    const r = await call("FancyNewTool", { query: "QUERY-VALUE-HIDDEN", content: "CONTENT-HIDDEN", mode: "x" });
    assert.deepEqual(r.args.toolLabel, { fields: {}, inputFields: ["query", "content", "mode"] });
    assert.ok(!/QUERY-VALUE-HIDDEN|CONTENT-HIDDEN/.test(r.text));
  });

  // the old sk-/api_key=/password:/hex-run fixtures pinned hand-written shapes that are gone; the fixtures are gitleaks vendor formats.
  it("a secret-looking value is dropped and the drop is recorded", async () => {
    const { call } = await setup();
    const r = await call("Grep", { pattern: "AKIAIOSFODNN7REALKEY", path: "ghp_Z8k2Qm4Xv7Rt1Pw9Yb3Nc6Hd5Jf0Lg8Ae2SW" });
    assert.deepEqual(r.args.toolLabel, { fields: {}, dropped: { pattern: "secret-looking value, not recorded", path: "secret-looking value, not recorded" } });
    assert.ok(!/AKIAIOSFODNN7REALKEY|ghp_Z8k2Qm/.test(r.text));
    for (const q of ["xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx", "export STRIPE_KEY=sk_live_4eC39HqLyjWDarjtT1zdp7dc"]) {
      const s = await call("ToolSearch", { query: q });
      assert.equal(s.args.toolLabel.fields.query, undefined, q);
      assert.ok(s.args.toolLabel.dropped.query);
    }
  });

  it("each string is cut at 200 characters", async () => {
    const { call } = await setup();
    const r = await call("ToolSearch", { query: "word ".repeat(100) });
    assert.equal(r.args.toolLabel.fields.query.length, 200);
  });

  it("a Codex shell call records the command and description through the same extractor", async () => {
    const { call } = await setup("codex");
    const r = await call("Bash", { command: "python3 bump.py", description: "Raise prices" });
    assert.deepEqual(r.args.toolLabel, { fields: { command: "python3 bump.py", description: "Raise prices" } });
  });

  it("outside watching off masks an outside path and path words in the label", async () => {
    const { call, folder } = await setup("claude", false);
    const r = await call("Read", { file_path: "/etc/hosts" });
    assert.deepEqual(r.args.toolLabel, { fields: { file_path: "[outside path]" } });
    assert.ok(!r.text.includes("/etc/hosts"));
    const inside = await call("Read", { file_path: path.join(folder, "a.md") });
    assert.equal(inside.args.toolLabel.fields.file_path, path.join(folder, "a.md"));
    const q = await call("Grep", { pattern: "x", path: "~/Documents" });
    assert.equal(q.args.toolLabel.fields.path, "[outside path]");
    const home = await call("ToolSearch", { query: "look in /Users/someone/private/file.txt" });
    assert.ok(!home.text.includes("/Users/someone"));
  });

  it("a missing or odd tool_input never blocks the hook", async () => {
    const { call } = await setup();
    for (const input of [undefined, null, "just a string", 42, ["a"], { skill: { nested: 1 } }, { file_path: 7 }]) {
      const r = await call("Read", input);
      assert.equal(typeof r.args.toolLabel?.fields, "object");
    }
  });
});
