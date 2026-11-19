import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger, type RecordReviewRowInput } from "../src/ledger.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { ownProse } from "../src/display.ts";
import { cellSourced, pageViolations, taskCommands, visibleTextNodes } from "../scripts/lib/page-invariant.ts";
import { workbookClaims } from "./helpers/claims.ts";

// The display invariant on the whole page, over an adversarial set of commands and descriptions and over the
// Codex Work-leg fixture. Temp data homes and folders only; no app is opened.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const probe = (n: number) => path.join(FIXTURES, "probe", `S${n}.xlsx`);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type Op = NonNullable<RecordReviewRowInput["ops"]>[number];

interface Case {
  name: string;
  command: string;
  /** The host's description, or undefined for a row stored as "command - description" with the tail in `intentTail`. */
  description?: string;
  /** Text appended as " - <tail>" with no recorded description (an old row). */
  intentTail?: string;
  tool?: string;
}

const LONG = "Update the discount rate and then check the result against the model. ".repeat(80);

const CASES: Case[] = [
  { name: "heredoc python", command: "python3 - <<'PY'\nimport openpyxl\nwb = openpyxl.load_workbook('/Users/someone/work/casebook.xlsx')\nwb['Inputs']['B17'] = 0.21\nwb.save('/Users/someone/work/casebook.xlsx')\nPY" },
  { name: "python -c", command: `python -c "import openpyxl; wb=openpyxl.load_workbook('model.xlsx'); wb.save('model2.xlsx')"`, description: "" },
  { name: "PowerShell", command: String.raw`powershell -NoProfile -Command "Copy-Item C:\Users\someone\Documents\casebook.xlsx D:\backup\casebook.xlsx -Force"` },
  { name: "intent tail repeats the command", command: "python3 fix.py casebook.xlsx", intentTail: "python3 fix.py" },
  { name: "intent tail is the whole command", command: "cp a.xlsx b.xlsx", intentTail: "cp a.xlsx b.xlsx" },
  { name: "host description is a command", command: "python3 recalc.py casebook.xlsx", description: "python3 recalc.py" },
  { name: "Windows path", command: String.raw`copy "C:\Users\someone\My Documents\casebook.xlsx" "C:\Temp\casebook2.xlsx"`, description: String.raw`C:\Temp\casebook2.xlsx` },
  { name: "path with spaces", command: `cp "/Users/someone/Work Files/casebook copy.xlsx" "/Users/someone/Work Files/casebook final.xlsx"`, description: "/Users/someone/Work Files/casebook final.xlsx" },
  { name: "5 KB description", command: "python3 edit.py casebook.xlsx", description: LONG },
  { name: "description with a newline", command: "python3 edit.py casebook.xlsx", description: "Update the rate\nthen save the file" },
  { name: "description shares a long run with the command", command: "python3 /opt/tools/recalculate_workbook_values.py casebook.xlsx", description: "Run recalculate_workbook_values.py now please" },
  { name: "tool id in the description", command: "ls", description: "mcp__cocheck__excel_set_value then more words" },
  { name: "MCP tool with no file", command: "", tool: "mcp__filesystem__list_directory", description: "" },
  { name: "genuine description", command: "python3 edit.py casebook.xlsx", description: "Update the discount rate" },
];

function hookOp(c: Case, i: number): Op {
  const tail = c.description !== undefined && c.description !== "" ? ` - ${c.description}` : c.intentTail !== undefined ? ` - ${c.intentTail}` : "";
  return {
    opId: i + 1,
    tool: c.tool ?? "Bash",
    intent: c.command === "" ? (c.tool ?? "Bash") : `${c.command}${tail}`,
    client: "claude",
    callId: `toolu_${i}`,
    closedBy: "post",
    ...(c.description !== undefined ? { description: c.description } : {}),
  } as Op;
}

async function rowsPage(cases: Case[], request: string | undefined) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-q191r2-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const ledger = openLedger(home);
  try {
    const taskId = ledger.openTask("claude");
    const rows: RecordReviewRowInput[] = cases.map((c, i) => ({
      filePath: "/work/proj/casebook.xlsx",
      layer: "xlsx",
      kind: "value",
      location: `Sheet1!B${i + 1}`,
      status: "explained",
      before: 1,
      after: 2,
      ops: [hookOp(c, i)],
      description: `B${i + 1} changed`,
      detail: {},
    }));
    ledger.recordRound({ taskId, seq: 1, intent: "go", clientName: "claude", final: true, lastOpId: 1, snapshots: [], rows });
    void request;
    const model = reviewModel(ledger, taskId);
    return { model, html: renderReviewPage(model) };
  } finally {
    ledger.close();
  }
}

describe("the whole-page invariant on the adversarial set", () => {
  it("row Why cells: no command text is visible and the genuine description still is", async () => {
    const { model, html } = await rowsPage(CASES, undefined);
    const commands = CASES.map((c) => c.command).filter((c) => c !== "");
    assert.deepEqual(pageViolations(html, commands, { allow: cellSourced(model) }), []);
    const text = visibleTextNodes(html).join("\n");
    assert.match(text, /“Update the discount rate”/, "a genuine description stays visible");
    assert.match(text, /“Update the rate then save the file”|Bash call on casebook\.xlsx/);
    // every row has some reason visible, in words
    assert.equal(model.files[0]!.sheets[0]!.rows.every((r) => r.intents.length === 1), true);
    // an MCP tool with no file gets a label in words, never its raw id
    assert.ok(!text.includes("mcp__") && !text.includes("list_directory"));
    assert.match(text, /list directory call/);
    // the 5 KB description is clipped, not dumped
    assert.ok(Math.max(...visibleTextNodes(html).map((n) => n.length)) < 600);
  });

  it("the check can fail: a visible command is caught", () => {
    assert.ok(pageViolations(`<td>python3 x.py && echo $HOME</td>`, ["python3 x.py && echo $HOME"]).length >= 2);
    assert.deepEqual(pageViolations(`<details class="raw"><summary>show command</summary><pre>python3 x.py && echo $HOME</pre></details>`, []), []);
    assert.ok(pageViolations(`<details class="raw"><summary>/usr/bin/python3 x.py</summary><pre>a</pre></details>`, []).length > 0, "a summary is visible");
  });
});

async function hookSetup(opts: { cwdInWorkspace?: boolean } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-q191r2-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-q191r2-folder-")));
  const ws = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-q191r2-ws-")));
  await mkdir(path.join(ws, "outputs"));
  await mkdir(path.join(ws, "my folder"));
  await copyFile(probe(0), path.join(folder, "casebook.xlsx"));
  await copyFile(probe(0), path.join(ws, "outputs", "casebook.xlsx"));
  await copyFile(probe(0), path.join(ws, "my folder", "casebook copy.xlsx"));
  cleanups.push(async () => {
    for (const d of [home, folder, ws]) await rm(d, { recursive: true, force: true });
  });
  const hookOpts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, outsideWatching: true };
  const send = (event: string, over: Record<string, unknown>) => handleHook({ session_id: "s1", cwd: opts.cwdInWorkspace ? ws : folder, hook_event_name: event, ...over } as HookPayload, hookOpts);
  const call = async (id: string, tool: string, input: Record<string, unknown>) => {
    await send("PreToolUse", { tool_use_id: id, tool_name: tool, tool_input: input });
    await send("PostToolUse", { tool_use_id: id, tool_name: tool, tool_input: input });
  };
  const finish = async () => {
    const r = await send("Stop", {});
    assert.ok(r.summary);
    const ledger = openLedger(home);
    try {
      const model = reviewModel(ledger, r.summary.taskId);
      return { model, html: renderReviewPage(model), commands: taskCommands(ledger, r.summary.taskId) };
    } finally {
      ledger.close();
    }
  };
  return { home, folder, ws, send, call, finish };
}

describe("outside, path-unknown and worked-in lines", () => {
  it("show the file name and the reason; the path and the command are behind details", async () => {
    const t = await hookSetup({ cwdInWorkspace: true });
    const book = path.join(t.ws, "outputs", "casebook.xlsx");
    const spaced = path.join(t.ws, "my folder", "casebook copy.xlsx");
    await t.call("c1", "Bash", { command: `python3 - <<'PY'\nimport openpyxl\nwb = openpyxl.load_workbook('${book}')\nprint($HOME)\nPY`, description: "Update the discount rate" });
    await t.call("c2", "Bash", { command: `python -c "import openpyxl; openpyxl.load_workbook('${book}')"` });
    await t.call("c3", "Bash", { command: `cp "${spaced}" "${spaced}.bak" && echo done`, description: `cp "${spaced}" "${spaced}.bak"` });
    await t.call("c4", "Bash", { command: String.raw`powershell -Command "Get-Content C:\Users\someone\casebook.xlsx | Out-Null"`, description: String.raw`powershell -Command "Get-Content C:\Users` });
    await t.call("c5", "Bash", { command: "python3 recalc.py", description: "python3 recalc.py" });
    await t.call("c6", "mcp__filesystem__list_directory", {});
    await t.call("c7", "Bash", { command: `python3 edit.py ${book}`, description: "Update the rate\nthen save" });
    await t.call("c8", "Bash", { command: `python3 edit.py ${book}`, description: LONG });
    const { model, html, commands } = await t.finish();
    assert.ok(commands.length >= 6);
    assert.deepEqual(pageViolations(html, commands, { allow: cellSourced(model) }), []);
    const text = visibleTextNodes(html).join("\n");
    assert.match(text, /Work outside the watched folder/);
    assert.match(text, /Update the discount rate/, "the genuine description is the visible reason");
    assert.match(text, /casebook\.xlsx/, "the base name is visible");
    assert.match(text, /casebook copy\.xlsx/, "a name with spaces shows as the base name");
    assert.match(text, /path unknown/);
    assert.ok(!text.includes(t.ws) && !text.includes(t.folder), "no full path is visible");
    assert.match(html, /<details class="raw"><summary[^>]*>show path<\/summary>/);
    assert.ok(html.includes(book), "the full path stays available behind show path");
    assert.ok(!text.includes("mcp__"));
  });

  it("the Codex Work leg fixture", async () => {
    const t = await hookSetup({ cwdInWorkspace: true });
    const leg = JSON.parse(await readFile(path.join(FIXTURES, "hooks", "codex-work-leg.json"), "utf8")) as { calls: Array<{ id: string; command: string }> };
    const book = path.join(t.ws, "outputs", "casebook.xlsx");
    for (const [i, c] of leg.calls.entries()) {
      const command = c.command.replaceAll("{FOLDER}", t.folder);
      await t.send("PreToolUse", { tool_use_id: c.id, tool_name: "Bash", tool_input: { command } });
      if (i === 8) await copyFile(probe(1), book);
      await t.send("PostToolUse", { tool_use_id: c.id, tool_name: "Bash", tool_input: { command } });
    }
    const { model, html, commands } = await t.finish();
    assert.ok(commands.length >= leg.calls.length - 2);
    assert.deepEqual(pageViolations(html, commands, { allow: cellSourced(model) }), []);
    assert.match(visibleTextNodes(html).join("\n"), /Work outside the watched folder/);
  });
});

describe("prose", () => {
  it("a note that names a path shows the base name", () => {
    assert.equal(ownProse("/Users/x/Work Files/big.bin is 12.4 MB (limit 10 MB per file); changes to it were not watched."), "big.bin is 12.4 MB (limit 10 MB per file); changes to it were not watched.");
    assert.equal(ownProse("folder /Users/x/My Folder has 5001 files (limit 5000); other files there were not watched."), "folder My Folder has 5001 files (limit 5000); other files there were not watched.");
    assert.equal(ownProse(String.raw`could not read /Users/x/a.xlsx: ENOENT, and C:\Temp\b.xlsx too.`), "could not read a.xlsx: ENOENT, and b.xlsx too.");
  });
});
