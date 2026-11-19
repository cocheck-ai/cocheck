import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTimeline, type Timeline, type TimelineCall } from "../src/timeline/timeline.ts";
import { toolLabel } from "../src/tool-label.ts";
import { openLedger } from "../src/ledger.ts";
import { pruneStates, previewsDirOf, storeDirOf, SIGNED_KEEP_MS } from "../src/states.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";

// The real call-label shape drives non-shell lines; cached previews die with their states; the outside-path scrub
// covers more shapes; paths are normalised before the inside-folder check.

const hooks = { text: (s: string) => s, path: (s: string) => s };
const baseInput = (ops: ReturnType<typeof call>[]) => ({
  taskId: 1, build: "b", ops, fileStates: [], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: true,
});
const calls = (t: Timeline): TimelineCall[] => t.requests.flatMap((r) => r.runs.flatMap((u) => u.calls));
const lineOf = (tool: string, input: Record<string, unknown>, cmd = tool): TimelineCall["line"] => {
  const t = buildTimeline(baseInput([call("c", { tool, cmd, at: 1, extra: { toolLabel: toolLabel(tool, input, hooks) } }), prompt("s1", ["Go."]), stop("s1")]));
  return calls(t)[0]!.line;
};

describe("label shape (the real toolLabel output)", () => {
  it("builds the non-shell lines from label fields, labelled cocheck-translation with basis tool-label", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["Skill", { skill: "cocheck-excel", args: "x" }, "Loaded cocheck-excel instructions"],
      ["Read", { file_path: "/w/a.txt" }, "Read a.txt"],
      ["Edit", { file_path: "/w/a.txt", old_string: "q", new_string: "r" }, "Edited a.txt"],
      ["Write", { file_path: "/w/sub/b.md", content: "body" }, "Wrote b.md"],
      ["ToolSearch", { query: "select:Foo" }, "Looked up a tool"],
      ["WebFetch", { url: "https://example.com/docs/a?token=zzz" }, "Opened example.com"],
      ["Task", { subagent_type: "general-purpose", description: "Survey the repo" }, "Started a helper agent: Survey the repo"],
      ["Task", { subagent_type: "general-purpose" }, "Started a helper agent (general-purpose)"],
      ["mcp__srv__find_things", { path: "/w/a.txt", query: "alpha" }, "Used find things from srv"],
    ];
    for (const [tool, input, text] of cases) {
      const l = lineOf(tool, input);
      assert.deepEqual([l.text, l.source, l.basis], [text, "cocheck-translation", "tool-label"], tool);
    }
  });

  it("an unknown tool with only input field names stays 'Used <tool>' and is a tool translation", () => {
    const l = lineOf("Frobnicate", { alpha: 1, beta: 2 });
    assert.deepEqual([l.text, l.source, l.basis], ["Used Frobnicate", "cocheck-translation", "tool"]);
  });

  it("a shell call never builds its line from the label, and the command never reaches the body", () => {
    const SENTINEL = "SENTINEL_CMD_9f3a";
    const label = toolLabel("Bash", { command: `echo ${SENTINEL}`, description: "d" }, hooks);
    assert.equal(label.fields.command, `echo ${SENTINEL}`, "the real Bash row does hold the command");
    const ops = [call("c", { tool: "Bash", cmd: "ls", at: 1, extra: { toolLabel: label } }), prompt("s1", ["Go."]), stop("s1")];
    const t = buildTimeline(baseInput(ops));
    assert.deepEqual([calls(t)[0]!.line.text, calls(t)[0]!.line.basis], ["Listed files in the folder", "shell"]);
    assert.ok(!JSON.stringify(t).includes(SENTINEL));
    // a non-shell tool name that carries a command field still never reads it
    const odd = lineOf("Frobnicate", { command: `echo ${SENTINEL}` });
    assert.ok(!JSON.stringify(odd).includes(SENTINEL));
  });
});

describe("outside paths in the body", () => {
  const body = (text: string): string => {
    const t = buildTimeline(baseInput([call("c", { desc: text, at: 1 }), prompt("s1", [text]), stop("s1")]));
    return JSON.stringify(t);
  };
  const forms: Array<[string, string, string[]]> = [
    ["file URL", "Open file:///Users/zed/Secret%20Dir/plan.txt now", ["zed", "Secret", "plan"]],
    ["file URL with spaces", "Open file:///Users/zed/Secret Dir/q3 plan.txt now", ["zed", "Secret", "plan"]],
    ["file URL, one slash", "Open file:/Users/zed/Secret/plan.txt now", ["zed", "Secret", "plan"]],
    ["sftp URL", "Fetch sftp://box.internal/home/zed/keys/id.txt now", ["box.internal", "zed", "keys"]],
    ["smb URL", "Fetch smb://nas/share/zed/plan.txt now", ["nas", "zed"]],
    ["Windows drive path", "Open C:\\Users\\zed\\Secret\\plan.txt now", ["zed", "Secret", "plan"]],
    ["Windows path with spaces", "Open C:\\Users\\zed\\My Secret Dir\\q3 plan.txt now", ["zed", "Secret", "plan"]],
    ["UNC path", "Open \\\\fileserver\\zed$\\Secret\\plan.txt now", ["fileserver", "zed", "Secret"]],
    ["path with spaces", "Open /Users/zed/My Secret Dir/q3 plan.txt now", ["zed", "Secret", "plan"]],
    ["path with ../ out of the folder", "Open /w/../Users/zed/plan.txt now", ["zed", "Users"]],
  ];
  for (const [name, text, banned] of forms) {
    it(`cuts a ${name}`, () => {
      const b = body(text);
      for (const s of banned) assert.ok(!b.includes(s), `${s} leaked in ${b}`);
    });
  }
  it("keeps plain http(s) URLs and inside paths", () => {
    const b = body("See https://example.com/a/b and /w/sub/a.txt");
    assert.ok(b.includes("https://example.com/a/b"));
    assert.ok(b.includes("sub/a.txt") && !b.includes("/w/sub"));
  });
  it("a named file that climbs out of the folder is not shown as inside", () => {
    const t = buildTimeline(baseInput([call("c", { desc: "x", named: ["/w/../Users/zed/plan.txt"], at: 1 }), prompt("s1", ["Go."]), stop("s1")]));
    assert.ok(!JSON.stringify(t).includes("zed"));
    assert.deepEqual(calls(t)[0]!.files, []);
  });
});

describe("cached previews die with their states", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const sha = (c: string): string => c.repeat(64);
  async function plant(shas: string[]) {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-q202r2-"));
    cleanups.push(home);
    const ledger = openLedger(home);
    const store = storeDirOf(home, 1);
    const prev = previewsDirOf(home, 1);
    await mkdir(store, { recursive: true });
    await mkdir(prev, { recursive: true });
    for (const s of shas) {
      await writeFile(path.join(store, s), "bytes");
      await writeFile(path.join(prev, `${s}.png`), "png");
    }
    return { home, ledger, prev };
  }
  const NOW = Date.now();

  it("an unsigned task's idle expiry removes the whole previews folder", async () => {
    const { home, ledger, prev } = await plant([sha("a"), sha("b")]);
    await writeFile(path.join(prev, "stray.png"), "x");
    try {
      await pruneStates(ledger, 1, { kind: "expired", ts: new Date(NOW).toISOString() }, NOW);
      assert.equal(existsSync(prev), false);
      assert.deepEqual(await readdir(storeDirOf(home, 1)).catch(() => []), []);
    } finally {
      ledger.close();
    }
  });

  it("the 30-day value expiry removes the whole previews folder, even for states already gone", async () => {
    const { ledger, prev } = await plant([sha("a")]);
    await writeFile(path.join(prev, `${sha("c")}.png`), "orphan");
    try {
      await pruneStates(ledger, 1, { kind: "signed", ts: new Date(NOW - SIGNED_KEEP_MS - 1000).toISOString() }, NOW);
      assert.equal(existsSync(prev), false);
    } finally {
      ledger.close();
    }
  });

  it("a sign-off drops the middle states and their previews, and keeps no picture without its state", async () => {
    // No file_states rows: no state is an endpoint, so every stored state is a middle state and drops.
    const { ledger, prev } = await plant([sha("a"), sha("b")]);
    try {
      await pruneStates(ledger, 1, { kind: "signed", ts: new Date(NOW).toISOString() }, NOW);
      assert.deepEqual(existsSync(prev) ? await readdir(prev) : [], []);
    } finally {
      ledger.close();
    }
  });

  it("a signed task keeps an endpoint's preview only while its state is stored, and drops an orphaned picture", async () => {
    const { ledger, prev } = await plant([sha("a")]);
    await writeFile(path.join(prev, `${sha("d")}.png`), "orphan");
    try {
      await pruneStates(ledger, 1, { kind: "signed", ts: new Date(NOW).toISOString() }, NOW);
      assert.ok(!existsSync(path.join(prev, `${sha("d")}.png`)));
    } finally {
      ledger.close();
    }
  });
});
