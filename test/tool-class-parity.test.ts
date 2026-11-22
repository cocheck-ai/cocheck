// Every tool name the credit rules once read from one global table gives the same answer through the host's own tool classes.
// The OLD side is a frozen copy of those global tables (as they stood before each host declared its own). A host's table holds only
// names that host reports, so a name another host reports is not a member for it: that narrowing is the one difference, and it is pinned here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasFileInput, isBackgroundableShell, isLauncherTool, isReadTool, isShellTool, isWaitTool, launcherMayCredit, shellDialectOf, toolMayCredit, toolNeverWrites, waitsOnHelpers, writeTargetsOf, editTargetsOf } from "../src/credit-guard.ts";
import { isPatchTool } from "../src/patch-secrets.ts";
import { profileOf, toolEntryOf } from "../src/hosts/index.ts";

// ---- frozen old tables ----
const NO_CREDIT = new Set(["Read", "Glob", "Grep", "SendMessage", "LS", "NotebookRead", "WebFetch", "WebSearch", "ToolSearch", "Skill", "TodoWrite", "TodoRead", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "BashOutput", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "ListMcpResourcesTool", "ReadMcpResourceTool", "glob", "rg", "view", "send_message", "list_agents"]);
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const SHELL = /^(bash|shell|sh|zsh|exec|exec_command|local_shell|container\.exec|run_shell_command|terminal|powershell|pwsh)$/i;
const WRITE_PATH_FIELD: Record<string, readonly string[]> = { write: ["file_path", "path"], edit: ["file_path", "path"], multiedit: ["file_path"], create: ["path", "file_path"], notebookedit: ["notebook_path"] };
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to):[ \t]*(.+?)[ \t]*$/gm;
const oldWriteTargets = (tool: string, input: unknown): string[] => {
  const t = tool.toLowerCase();
  const out: string[] = [];
  const fields = Object.hasOwn(WRITE_PATH_FIELD, t) ? WRITE_PATH_FIELD[t] : undefined;
  if (fields !== undefined && typeof input === "object" && input !== null) {
    for (const f of fields) {
      const v = (input as Record<string, unknown>)[f];
      if (typeof v === "string" && v !== "") {
        out.push(v);
        break;
      }
    }
  }
  if (t === "apply_patch" || t === "patch") {
    const texts: string[] = typeof input === "string" ? [input] : typeof input === "object" && input !== null ? ["input", "patch", "command", "diff"].map((k) => (input as Record<string, unknown>)[k]).filter((v): v is string => typeof v === "string") : [];
    for (const text of texts) for (const m of text.matchAll(PATCH_HEADER)) out.push(m[1]!);
  }
  return out;
};
const oldLauncher = (t: string): boolean => t === "Agent" || t === "Task" || t === "task" || t === "spawn_agent";
const oldWait = (t: string): boolean => t === "wait_agent";
const oldWaits = (t: string, input: unknown): boolean => oldWait(t) || (t === "read_agent" && typeof input === "object" && input !== null && (input as { wait?: unknown }).wait === true);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const oldPatchSecrets = (t: string): boolean => /(^|[.:/])(apply_patch|patch)$/i.test(t);

// ---- what each host reports (written out here, from the recorded runs and the host's own tool list) ----
const OWN: Record<string, string[]> = {
  claude: ["Read", "Glob", "Grep", "SendMessage", "LS", "NotebookRead", "WebFetch", "WebSearch", "ToolSearch", "Skill", "TodoWrite", "TodoRead", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "BashOutput", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "ListMcpResourcesTool", "ReadMcpResourceTool", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task", "Bash", "PowerShell", "pwsh", "apply_patch", "patch"],
  codex: ["send_message", "list_agents", "apply_patch", "patch", "spawn_agent", "wait_agent", "Bash", "shell", "sh", "zsh", "exec", "exec_command", "local_shell", "container.exec", "run_shell_command", "terminal", "powershell", "pwsh"],
  copilot: ["glob", "rg", "view", "list_agents", "Read", "Edit", "Bash", "create", "edit", "apply_patch", "patch", "task", "read_agent", "bash", "powershell", "pwsh"],
};
const oldNames = [...NO_CREDIT, ...FILE_TOOLS, ...WRITE_TOOLS, "bash", "shell", "sh", "zsh", "exec", "exec_command", "local_shell", "container.exec", "run_shell_command", "terminal", "powershell", "pwsh", "PowerShell", "Bash", "write", "edit", "multiedit", "create", "notebookedit", "apply_patch", "patch", "Agent", "Task", "task", "spawn_agent", "wait_agent", "read_agent"];
const variants = (n: string): string[] => [n, n.toUpperCase(), n.toLowerCase(), n[0]!.toUpperCase() + n.slice(1)];
const NAMESPACES = ["", "functions.", "collab:", "ns/"];
const universe = [...new Set([...oldNames, ...Object.values(OWN).flat()].flatMap(variants)), "constructor", "Foo", "mcp__x__patch", "toString", "__proto__"];
const hosts = Object.keys(OWN);
const lower = (h: string) => new Set(OWN[h]!.map((n) => n.toLowerCase()));
const exact = (h: string) => new Set(OWN[h]!);

test("every old table name has an owner among the hosts (none is orphaned)", () => {
  for (const n of oldNames) assert.ok(hosts.some((h) => lower(h).has(n.toLowerCase())), n);
});

for (const h of [...hosts, null, "gemini"]) {
  const own = (n: string, ci: boolean): boolean => (h === null || h === "gemini" ? true : ci ? lower(h).has(n.toLowerCase()) : exact(h).has(n));
  test(`class membership of every old-table name equals the old tables (${h ?? "no host"})`, () => {
    for (const n of universe) {
      const where = `${h}:${n}`;
      // never credited, and the path check of a file tool (both read exact names)
      const oldBlocked = NO_CREDIT.has(n) || FILE_TOOLS.has(n);
      assert.equal(!toolMayCredit(n, "/x/a", "/x/b", (a, b) => a === b, undefined, h), oldBlocked && own(n, false), `may-credit ${where}`);
      assert.equal(toolNeverWrites(n, h), NO_CREDIT.has(n) && own(n, false), `never-writes ${where}`);
      // shell, in any letter case, and its dialects
      assert.equal(isShellTool(n, h), SHELL.test(n) && own(n, true), `shell ${where}`);
      assert.equal(shellDialectOf(n, h) === "powershell", /^(powershell|pwsh)$/i.test(n) && own(n, true), `powershell ${where}`);
      assert.equal(shellDialectOf(n, h) === "bash", n.toLowerCase() === "bash" && own(n, true), `bash ${where}`);
      assert.equal(isBackgroundableShell(n, h), n === "Bash" && own(n, false), `backgroundable ${where}`);
      // the files a call's own input names, whatever the letter case
      const input = { file_path: "/a", path: "/b", notebook_path: "/n", input: "*** Add File: /p\n+x", patch: "*** Update File: /q" };
      assert.deepEqual(writeTargetsOf(n, input, h), own(n, true) && Object.hasOwn(WRITE_PATH_FIELD, n.toLowerCase()) || own(n, true) && /^(apply_patch|patch)$/i.test(n) ? oldWriteTargets(n, input) : [], `targets ${where}`);
      assert.deepEqual(writeTargetsOf(n, "*** Add File: /p", h), own(n, true) ? oldWriteTargets(n, "*** Add File: /p") : [], `patch text ${where}`);
      assert.equal(editTargetsOf(n, input, (p) => p.startsWith("/"), undefined, h) !== undefined, own(n, true) && (Object.hasOwn(WRITE_PATH_FIELD, n.toLowerCase()) || /^(apply_patch|patch)$/i.test(n)), `edit targets ${where}`);
      // helpers
      assert.equal(isLauncherTool(n, h), oldLauncher(n) && own(n, false), `launcher ${where}`);
      assert.equal(launcherMayCredit(n, true, h), !(oldLauncher(n) && own(n, false)), `launcher may credit ${where}`);
      assert.equal(isWaitTool(n, h), oldWait(n) && own(n, false), `wait ${where}`);
      assert.equal(waitsOnHelpers(n, { wait: true }, h), oldWaits(n, { wait: true }) && own(n, false), `waits(flag) ${where}`);
      assert.equal(waitsOnHelpers(n, {}, h), oldWaits(n, {}) && own(n, false), `waits(no flag) ${where}`);
      // the timeline's read and write signals
      assert.equal(hasFileInput(n, h), WRITE_TOOLS.has(n) && own(n, false), `file input ${where}`);
      assert.equal(isReadTool(n, h), n === "Read" && own(n, false), `read ${where}`);
      assert.equal(toolEntryOf(h, n)?.backgroundFlag === true, (n === "Agent" || n === "Task") && own(n, false), `background flag ${where}`);
      // patch scrubbing reads the namespaced form too
      for (const ns of NAMESPACES) {
        const full = ns + n;
        const last = full.slice(full.search(/[^.:/]*$/));
        assert.equal(isPatchTool(full, h), oldPatchSecrets(full) && own(last, true), `patch tool ${h}:${full}`);
      }
    }
  });
}

test("a name two hosts mean differently keeps each host's own meaning", () => {
  // Copilot's `edit` and `create` write by `path`, with no file-input shape and no path check; Claude's `Edit` and `Write` have both.
  assert.equal(toolEntryOf("copilot", "edit")?.class, "edit");
  assert.equal(hasFileInput("edit", "copilot"), false);
  assert.equal(toolMayCredit("edit", "/x/a", "/x/b", (a, b) => a === b, undefined, "copilot"), true);
  assert.equal(toolMayCredit("Edit", "/x/a", "/x/b", (a, b) => a === b, undefined, "claude"), false);
  assert.deepEqual(writeTargetsOf("create", { path: "/p", file_path: "/f" }, "copilot"), ["/p"]);
  // `task` launches under Copilot; Claude's launcher is `Task` and its `task` is no launch; Codex's launcher is `spawn_agent`.
  assert.equal(isLauncherTool("task", "copilot"), true);
  assert.equal(isLauncherTool("task", "claude"), false);
  assert.equal(isLauncherTool("Task", "copilot"), false);
  assert.equal(isLauncherTool("spawn_agent", "codex"), true);
  assert.equal(isLauncherTool("spawn_agent", "claude"), false);
  // `apply_patch` is a patch for Codex and Copilot, not a Claude tool
  assert.equal(isPatchTool("apply_patch", "codex"), true);
  assert.equal(isPatchTool("apply_patch", "claude"), true);
  // `read_agent` waits only with its flag, under Copilot; `wait_agent` always, under Codex
  assert.equal(waitsOnHelpers("read_agent", { wait: true }, "copilot"), true);
  assert.equal(waitsOnHelpers("read_agent", {}, "copilot"), false);
  assert.equal(waitsOnHelpers("wait_agent", {}, "codex"), true);
  // a host with a profile and a name it does not declare: unknown, creditable
  assert.equal(toolNeverWrites("Glob", "copilot"), false);
});

// ---- names seen in the recordings under platforms/, by the host that recorded them ----
// Frozen from the recordings: hook payload `tool_name`/`toolName` fields, Codex and Claude session tool-call names, and the tool lists in the
// Copilot session-events and events files (`{"name":..., "schema_hash":...}`). A host's profile reads each name after its own `toolName` strip.
const RECORDED: Record<string, string[]> = {
  claude: ["Bash"],
  codex: ["Bash", "collaborationspawn_agent", "collaborationwait_agent", "exec"],
  copilot: ["Bash", "Edit", "Read", "apply_patch", "bash", "dynamic_workflows_manage", "edit", "fetch_copilot_cli_documentation", "github-mcp-server-get_copilot_space", "github-mcp-server-get_file_contents", "github-mcp-server-list_copilot_spaces", "github-mcp-server-search_code", "github-mcp-server-search_users", "glob", "list_agents", "list_bash", "read_agent", "read_bash", "rg", "run_dynamic_workflow", "search_code_subagent", "session_store_sql", "skill", "sql", "stop_bash", "task", "task_complete", "view", "web_fetch", "web_search", "write_agent"],
};
const RECORDED_INPUTS = [{ wait: true }, {}];
const oldBundle = (n: string): unknown[] => [
  NO_CREDIT.has(n), FILE_TOOLS.has(n), SHELL.test(n), /^(powershell|pwsh)$/i.test(n), n.toLowerCase() === "bash", n === "Bash", oldLauncher(n), oldWait(n),
  ...RECORDED_INPUTS.map((i) => oldWaits(n, i)), WRITE_TOOLS.has(n), n === "Read", oldPatchSecrets(n), oldWriteTargets(n, { file_path: "/a", path: "/b", notebook_path: "/n", patch: "*** Add File: /p" }),
];
const newBundle = (h: string, n: string): unknown[] => [
  toolNeverWrites(n, h), toolEntryOf(h, n)?.pathChecked === true, isShellTool(n, h), shellDialectOf(n, h) === "powershell", shellDialectOf(n, h) === "bash", isBackgroundableShell(n, h), isLauncherTool(n, h), isWaitTool(n, h),
  ...RECORDED_INPUTS.map((i) => waitsOnHelpers(n, i, h)), hasFileInput(n, h), isReadTool(n, h), isPatchTool(n, h), writeTargetsOf(n, { file_path: "/a", path: "/b", notebook_path: "/n", patch: "*** Add File: /p" }, h),
];
for (const [h, names] of Object.entries(RECORDED)) {
  test(`every tool name a ${h} recording holds keeps the answer the old union gave`, () => {
    const moved = names.filter((raw) => {
      const n = profileOf(h).toolName?.(raw, {}) ?? raw;
      return JSON.stringify(newBundle(h, n)) !== JSON.stringify(oldBundle(n));
    });
    assert.deepEqual(moved, [], `${h}: names whose class moved`);
  });
}
