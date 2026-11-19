// Dev-only: a maintainer tool for building test fixtures. Not part of the shipped product.
// Builds an attribution replay fixture from a recorded run, read-only. The ledger is opened read-only (never migrated, never
// written); the host's transcripts are read for how each call ended (`callEvidenceOf`) and for the golden owner of each change.
//
//   node scripts/attribution-fixture.ts --task 9 --name example [--ledger ~/CoCheckData/ledger.sqlite] [--transcripts ~/.claude/projects]
//
// Writes test/fixtures/attribution/<name>.json. What a fixture keeps, and nothing more: per call its id, tool, lane (session, agent id,
// type, launcher), open and close times and how it closed, its file_path (Write/Edit), and its command with every secret-looking command
// dropped, every heredoc body that is not script text blanked (no file contents) and script bodies cut to the lines the write signal reads;
// email addresses and the home folder are replaced by placeholders everywhere; per file state its path, phase, open and credited
// lists, time, kept flag and a short stand-in for its hashes; per call the transcript evidence; per change its golden owner.
//
// Golden owners come from the transcripts: the writers of a change are the calls whose run (tool_use to tool_result, plus the first sweep
// after it) holds the sweep that found it and whose input shows a write of that file (`callWritesFile`, a Write/Edit path, or a delete).
// One agent among them is the owner. Several, or none, is ambiguous: such changes need a reviewed label in
// test/fixtures/attribution/reviewed.json ({ "<name>": { "<state id>": { "owner": "<agent id>|main", "why": "..." } } }), or the
// generator stops and lists them.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { callEvidenceOf } from "../src/agent-transcripts.ts";
import { looksSecret } from "../src/tool-label.ts";
import { callDeletesFile, callWritesFile, parseShell, SCRIPT_RUNNERS } from "../src/timeline/write-signal.ts";
import type { RawOp } from "../src/timeline/runs.ts";
import { writeScope } from "../src/attribution/write-scope.ts";

const arg = (k: string, d?: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (d === undefined) throw new Error(`--${k} is required`);
  return d;
};
const task = Number(arg("task"));
const name = arg("name");
const ledgerPath = arg("ledger", path.join(homedir(), "CoCheckData", "ledger.sqlite"));
const root = arg("transcripts", path.join(homedir(), ".claude", "projects"));
const here = path.dirname(new URL(import.meta.url).pathname);
const outDir = path.join(here, "..", "test", "fixtures", "attribution");

const db = new DatabaseSync(ledgerPath, { readOnly: true });
const client = String((db.prepare("SELECT client FROM tasks WHERE id = ?").get(task) as { client: string }).client);
const folder = client.replace(/^[\w-]+-hook:/, "").replace(/\?session=.*$/, "").replace(/\/+$/, "");
const host = /^([\w-]+)-hook:/.exec(client)?.[1] ?? null;
const rawOps = db.prepare("SELECT id, tool, intent, args_json FROM ops WHERE task_id = ? AND result_code IN ('OK', 'TOOL_FAILED') ORDER BY id").all(task) as Array<{ id: number; tool: string; intent: string; args_json: string }>;
const stepTs = new Map((db.prepare("SELECT id, ts FROM steps WHERE task_id = ?").all(task) as Array<{ id: number; ts: string }>).map((r) => [r.id, r.ts]));
const states = db.prepare("SELECT id, step_id, file_path, sha256, prev_sha256, phase, calls_open_json, credited_json, kept FROM file_states WHERE task_id = ? ORDER BY id").all(task) as Array<Record<string, string | number | null>>;

// ---- calls ----
const NOTE = / \[(joint attribution|cells found after)[^\]]*\]/g;
const keep = ["tool_use_id", "tool_name", "session_id", "agent_id", "agent_type", "launch_tool_use_id", "openedAt", "closedAt", "closedBy", "startSeq", "background", "host", "namedFiles", "ended", "tagged", "hook"];
const listed = new Set<string>();
for (const s of states) for (const k of ["calls_open_json", "credited_json"]) for (const id of JSON.parse(String(s[k] ?? "[]")) as string[]) listed.add(id);

/** A command with no file contents: a heredoc body is kept only when it feeds an interpreter or writes a script file. */
function scrubCommand(cmd: string): string {
  if (looksSecret(cmd)) return "";
  const parsed = parseShell(cmd);
  if (parsed.bodies.length === 0) return cmd;
  let out = cmd;
  parsed.bodies.forEach((body, i) => {
    const owner = parsed.commands[parsed.owners[i]!];
    const prog = (owner?.words[0] ?? "").slice((owner?.words[0] ?? "").lastIndexOf("/") + 1);
    const script = SCRIPT_RUNNERS.test(prog) || [...(owner?.redirects ?? []), ...(owner?.words ?? [])].some((w) => /\.(py|js|mjs|cjs|ts|rb|pl|sh|applescript|scpt)$/.test(w));
    if (body.trim() === "") return;
    // a data file's body is file contents: dropped; a script's is cut to the lines the write signal reads (assignments and write calls with a literal)
    out = out.replace(body, script ? cutScript(body) : "");
  });
  return out;
}

/** Script text cut to what the write signal reads: lines with a quoted literal that assign a name or call a write, save, open or delete. */
function cutScript(body: string): string {
  const keep = body.split("\n").filter((l) => /['"]/.test(l) && !/^\s*#/.test(l) && /(^\s*[\w.\[\]'"]+\s*=[^=]|\b(save|savefig|write|writeFile|writeFileSync|to_csv|to_excel|to_json|dump|open|remove|unlink|unlinkSync|rmSync|rename|copy|copyfile|move|Path)\b)/.test(l));
  return keep.join("\n") + "\n";
}

const HOME = homedir();
const HOME_SLUG = HOME.replace(/[^A-Za-z0-9]/g, "-");
/** The last pass over the whole fixture: no email address, no real home folder (a placeholder stands in, the same everywhere so paths still match). */
function scrubText(t: string): string {
  return t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com").split(HOME).join("/Users/user").split(HOME_SLUG).join("-Users-user");
}

const ops: RawOp[] = [];
/** The commands the scrub changed, as they ran (never written to the fixture). */
const originals = new Map<string, string>();
const callIds = new Set<string>();
const merged = new Map<string, { id: number; tool: string; intent: string; args: Record<string, unknown> }>();
for (const o of rawOps) {
  let a: Record<string, unknown>;
  try {
    a = JSON.parse(o.args_json);
  } catch {
    continue;
  }
  const id = typeof a.tool_use_id === "string" ? a.tool_use_id : null;
  if (id === null || !listed.has(id)) continue;
  const args: Record<string, unknown> = {};
  for (const k of keep) if (a[k] !== undefined) args[k] = a[k];
  const label = a.toolLabel as { fields?: Record<string, unknown> } | undefined;
  const fp = label?.fields?.file_path;
  if (typeof fp === "string") args.toolLabel = { fields: { file_path: fp } };
  const description = String(a.description ?? "").trim();
  let command = String(o.intent ?? "").replace(NOTE, "");
  if (description && command.endsWith(" - " + description)) command = command.slice(0, -(description.length + 3));
  const prev = merged.get(id);
  if (prev === undefined) {
    callIds.add(id);
    const scrubbed = scrubCommand(command);
    if (scrubbed !== command) originals.set(id, command);
    merged.set(id, { id: o.id, tool: o.tool, intent: scrubbed, args });
    continue;
  }
  // one op per call: what later ops of the call add (a failure, a Post after expiry, more named files) is merged in, as runs.ts reads it
  if (args.closedBy === "failure" || (args.closedBy === "post" && prev.args.closedBy === "expiry")) {
    prev.args.closedBy = args.closedBy;
    if (args.closedAt !== undefined) prev.args.closedAt = args.closedAt;
  }
  if (Array.isArray(args.namedFiles)) prev.args.namedFiles = [...new Set([...((prev.args.namedFiles as string[] | undefined) ?? []), ...(args.namedFiles as string[])])];
  if (prev.args.ended === undefined && args.ended !== undefined) prev.args.ended = args.ended;
}
for (const m of merged.values()) ops.push({ id: m.id, tool: m.tool, intent: m.intent, args_json: JSON.stringify(m.args) });

// ---- states (hashes become short stand-ins) ----
const shaIds = new Map<string, string>();
const shaOf = (h: string | null): string | null => (h === null ? null : (shaIds.get(h) ?? (shaIds.set(h, `s${shaIds.size + 1}`), `s${shaIds.size}`)));
const fileStates = states.map((s) => ({
  id: Number(s.id),
  step_id: Number(s.step_id),
  file_path: String(s.file_path),
  sha256: shaOf(String(s.sha256))!,
  prev_sha256: shaOf(s.prev_sha256 === null ? null : String(s.prev_sha256)),
  phase: String(s.phase),
  calls_open_json: String(s.calls_open_json),
  credited_json: String(s.credited_json),
  kept: String(s.kept),
  ts: stepTs.get(Number(s.step_id)) ?? null,
}));

// ---- evidence ----
const evidence = callEvidenceOf(rawOps.map((o) => ({ id: o.id, tool: o.tool, intent: o.intent, args_json: o.args_json })), { root, folder });

// ---- golden owners from the transcripts ----
interface Use { id: string; agent: string; tool: string; input: Record<string, unknown>; at: number; end: number | null; cwd: string | null }
const uses = new Map<string, Use>();
const sessions = new Set(rawOps.flatMap((o) => { try { const a = JSON.parse(o.args_json); return typeof a.session_id === "string" ? [a.session_id] : []; } catch { return []; } }));
const project = path.join(root, folder.replace(/[^A-Za-z0-9]/g, "-"));
const files: Array<{ file: string; agent: string }> = [];
for (const sid of sessions) {
  const main = path.join(project, `${sid}.jsonl`);
  try { if (lstatSync(main).isFile()) files.push({ file: main, agent: "main" }); } catch { /* none */ }
  const sub = path.join(project, sid, "subagents");
  try { for (const n of readdirSync(sub)) if (/^agent-.+\.jsonl$/.test(n)) files.push({ file: path.join(sub, n), agent: n.slice(6, -6) }); } catch { /* none */ }
}
for (const { file, agent } of files) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let o: { timestamp?: string; isSidechain?: boolean; cwd?: unknown; message?: { content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    if (agent === "main" && o.isSidechain === true) continue;
    const at = Date.parse(o.timestamp ?? "");
    for (const b of (Array.isArray(o.message?.content) ? o.message!.content : []) as Array<Record<string, unknown>>) {
      if (!Number.isFinite(at)) continue;
      if (b.type === "tool_use" && typeof b.id === "string" && !uses.has(b.id)) uses.set(b.id, { id: b.id, agent, tool: String(b.name), input: (b.input ?? {}) as Record<string, unknown>, at, end: null, cwd: typeof o.cwd === "string" && o.cwd.startsWith("/") ? o.cwd : null });
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") { const u = uses.get(b.tool_use_id); if (u && u.end === null) u.end = at; }
    }
  }
}
const EVENT_SLACK_MS = 1000;
const events = [...new Set([...uses.values()].flatMap((u) => [u.at, ...(u.end === null ? [] : [u.end])]).filter(Number.isFinite))].sort((x, y) => x - y);
const prevEvent = (t: number): number => events.findLast((x) => x < t) ?? -Infinity;
const WRITERS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
const reviewedAll = JSON.parse(readFileSync(path.join(outDir, "reviewed.json"), "utf8")) as Record<string, Record<string, { owner: string; why: string }>>;
const reviewed = reviewedAll[name] ?? {};
const golden: Record<string, { owner: string; from: "transcript" | "reviewed"; why?: string }> = {};
const ambiguous: string[] = [];
const scriptsBy = (agent: string, before: number) => (n: string): string[] =>
  [...uses.values()].filter((u) => u.agent === agent && u.at < before && u.tool === "Write" && typeof u.input.file_path === "string" && path.basename(u.input.file_path as string) === n && typeof u.input.content === "string").map((u) => u.input.content as string);
const firstStep = Math.min(...fileStates.map((s) => s.step_id));
for (const s of fileStates) {
  // the baseline (every file copied at the task's first event) is not a change (runs.ts)
  if (s.prev_sha256 === null && s.credited_json === "[]" && s.step_id === firstStep) continue;
  const T = Date.parse(s.ts ?? "");
  const gone = s.kept === "gone";
  // writers: calls of a tool that can write whose run (tool_use to tool_result, then the first sweep after it) holds the sweep; a background Bash runs on
  // the write happened after the sweep before this one: every call start and result in the transcripts is a sweep (a Pre or a Post)
  const before = prevEvent(T - EVENT_SLACK_MS);
  const running = [...uses.values()].filter((u) => {
    if (!WRITERS.has(u.tool) || !(u.at <= T)) return false;
    const end = u.end === null || u.input.run_in_background === true ? Infinity : u.end;
    return end + EVENT_SLACK_MS >= before;
  });
  // more than one agent running: those whose input shows a write of the file (or names it, or its folder) decide
  const base = path.basename(s.file_path);
  const dirName = path.basename(path.dirname(s.file_path));
  const signals = (u: Use): boolean => {
    const call = { tool: u.tool, command: typeof u.input.command === "string" ? u.input.command : null, input: u.input };
    if ((gone ? callDeletesFile : callWritesFile)(call, s.file_path, scriptsBy(u.agent, u.at))) return true;
    const text = JSON.stringify(u.input);
    return text.includes(base) || text.includes(`${dirName}/`) || text.includes(`/${dirName}`);
  };
  let writers = running;
  if (new Set(writers.map((w) => w.agent)).size > 1) writers = running.filter(signals);
  const owners = [...new Set(writers.map((w) => w.agent))];
  const r = reviewed[String(s.id)];
  if (r) golden[s.id] = { owner: r.owner, from: "reviewed", why: r.why };
  else if (owners.length === 1) golden[s.id] = { owner: owners[0]!, from: "transcript" };
  else ambiguous.push(`${s.id} ${s.phase} ${s.ts} ${path.relative(folder, s.file_path)} running=[${running.map((w) => `${w.agent.slice(0, 8)}:${w.tool}:${w.id.slice(-8)}`).join(",")}] credited=${s.credited_json}`);
}
if (ambiguous.length > 0) {
  console.error(`${ambiguous.length} changes need a reviewed owner in test/fixtures/attribution/reviewed.json under "${name}":`);
  for (const a of ambiguous) console.error("  " + a);
  if (!process.argv.includes("--partial")) process.exit(1);
}

// ---- Per Bash call, the shell's working directory (the transcript's cwd at the tool_use) and what the write hooks logged ----
// The live adapter records `hook` on a tagged call's op; an older ledger has none, so it is rebuilt from the write logs when they are still there
// (they are kept three days). `covered`: the registered roots hold the task folder, so a write by a Python or Node child inside it is logged.
const logDir = arg("writes", path.join(path.dirname(ledgerPath), "attribution"));
const hookRecords = new Map<string, { wrote: number; spawned: boolean; starts: Array<{ path: string; pid: number; ppid?: number }> }>();
let logsRead = false;
try {
  for (const n of readdirSync(logDir).filter((x) => /^writes-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x))) {
    logsRead = true;
    for (const line of readFileSync(path.join(logDir, n), "utf8").split("\n")) {
      let r: { call?: unknown; op?: unknown; path?: unknown; pid?: unknown; ppid?: unknown };
      try { r = JSON.parse(line); } catch { continue; }
      if (typeof r.call !== "string" || !callIds.has(r.call)) continue;
      const h = hookRecords.get(r.call) ?? { wrote: 0, spawned: false, starts: [] };
      if (r.op === "spawn") h.spawned = true;
      else if (r.op === "start") { if (typeof r.path === "string" && typeof r.pid === "number" && !h.starts.some((x) => x.pid === r.pid)) h.starts.push({ path: r.path, pid: r.pid, ...(typeof r.ppid === "number" ? { ppid: r.ppid } : {}) }); }
      else if (typeof r.path === "string" && (r.path === folder || r.path.startsWith(folder + "/"))) h.wrote++;
      hookRecords.set(r.call, h);
    }
  }
} catch { /* no logs */ }
let roots: string[] = [];
try { roots = (JSON.parse(readFileSync(path.join(logDir, "roots.json"), "utf8")) as unknown[]).filter((r): r is string => typeof r === "string"); } catch { /* none */ }
const covered = roots.some((r) => folder === r || folder.startsWith(r.replace(/\/+$/, "") + "/"));
for (const op of ops) {
  const a = JSON.parse(op.args_json ?? "{}") as Record<string, unknown>;
  if (op.tool !== "Bash" || typeof a.tool_use_id !== "string") continue;
  const cwd = uses.get(a.tool_use_id)?.cwd;
  if (cwd) a.cwd = cwd;
  // A scrubbed command is kept for the replay's write-scope analysis only when the analysis of what ran says the same
  const orig = originals.get(a.tool_use_id);
  if (orig !== undefined && JSON.stringify(writeScope(orig, cwd ?? null)) !== JSON.stringify(writeScope(op.intent ?? "", cwd ?? null))) a.scrubbed = true;
  if (a.tagged === true && a.hook === undefined && logsRead) a.hook = { ...(hookRecords.get(a.tool_use_id) ?? { wrote: 0, spawned: false, starts: [] }), covered };
  op.args_json = JSON.stringify(a);
}

const fixture = {
  name,
  note: `Built by scripts/attribution-fixture.ts from ledger task ${task} and its transcripts; no file contents, secret-looking commands dropped.`,
  folder,
  host,
  ops,
  fileStates,
  evidence: Object.fromEntries([...evidence].filter(([id]) => callIds.has(id))),
  golden,
};
const text = scrubText(JSON.stringify(fixture));
if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text.replaceAll("user@example.com", "")) || text.includes(HOME)) throw new Error("scrub failed: an email or the home folder is still in the fixture");
writeFileSync(path.join(outDir, `${name}.json`), text + "\n");
console.log(`${name}: ${ops.length} call ops, ${fileStates.length} states, ${Object.keys(golden).length} golden owners, ${Object.keys(fixture.evidence).length} evidence`);
