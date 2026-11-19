#!/usr/bin/env node
// Runs one tiny scripted session on a host (Claude Code, Codex or Copilot CLI) with hooks that log each event's raw stdin,
// so a new host version's payload shapes can be compared with what the adapter expects.
// Usage: node scripts/probe-host.ts <claude|codex|copilot> --out <dir> [--bin <path>] [--auth <auth.json>]
// Env: COCHECK_PROBE_BIN and COCHECK_PROBE_AUTH are the same as --bin and --auth.
// Writes <out>/<host>-<version>/payloads.jsonl (one {event, ts, stdin} line per hook call) and sessions/<session files>.
// Sweeps its own cocheck-probe-XXXXXX scratch dirs older than an hour at start; SIGINT/SIGTERM remove the live scratch dir before exit.
// Writes only under <out> and a scratch dir it removes at exit. The only read of the user's real config is the auth.json copy (codex).
// Refuses an <out> inside ~/.codex, ~/.claude or ~/.copilot.
// copilot (the recipe in platforms/copilot-cli/guide.md): a scratch git repo with .github/hooks/log.json, COPILOT_HOME in the scratch dir (the real ~/.copilot is never read
// or written), COPILOT_ALLOW_ALL=true (trusts the scratch folder so its hooks load), `--no-auto-update --no-remote`. No auth file is copied: the login is the CLI's own.
// Every file written to <out> is scrubbed: emails become user@example.com, the home path (and its realpath) becomes /Users/<user>.
// If a token-shaped string (sk-, ghp_, gho_, JWT, Bearer <value>, private-key header) is still there, the run fails and <out>/<host>-<version>/ is removed.
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export type Host = "claude" | "codex" | "copilot";
export interface ProbeOptions {
  host: Host;
  out: string;
  bin?: string;
  authSrc?: string;
  /** Home directory the real-home guard protects; tests point it at a temp dir. */
  realHome?: string;
  /** Directory holding the scratch dirs and swept at start; defaults to the OS tmpdir. Tests point it at a temp dir. */
  tmpRoot?: string;
}

const PROMPT =
  "Before each shell command, write one sentence saying what you are about to do. " +
  "Step 1: run cat data.csv. Step 2: write totals.csv containing column sums (header a,b,c) using a shell command.";
const CSV = "a,b,c\n1,2,3\n4,5,6\n7,8,9\n";
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"];
const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "SubagentStop", "Notification", "Stop", "SessionEnd"];
const COPILOT_EVENTS = ["sessionStart", "userPromptSubmitted", "preToolUse", "postToolUse", "postToolUseFailure", "agentStop", "subagentStart", "subagentStop", "sessionEnd", "errorOccurred"];
const LOG_HOOK = `import { appendFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  appendFileSync(process.argv[3], JSON.stringify({ event: process.argv[2], ts: Date.now() / 1000, stdin: input }) + "\\n");
});
`;

/** Resolves symlinks of the deepest existing ancestor, so a link into ~/.codex cannot slip past the guard. */
async function resolveThroughLinks(p: string): Promise<string> {
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    rest.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(await realpath(cur), ...rest);
}

async function assertOutAllowed(out: string, realHome: string): Promise<string> {
  const resolved = await resolveThroughLinks(out);
  for (const home of new Set([path.resolve(realHome), await resolveThroughLinks(realHome)])) {
    for (const dot of [".codex", ".claude", ".copilot"]) {
      const forbidden = path.join(home, dot);
      if (resolved === forbidden || resolved.startsWith(forbidden + path.sep)) {
        throw new Error(`refusing to write inside ${forbidden}: ${out}`);
      }
    }
  }
  return resolved;
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return undefined;
}

async function findBinary(host: Host, realHome: string): Promise<string> {
  const found = onPath(host);
  if (found) return found;
  if (host === "codex") {
    const pkgs = path.join(realHome, ".codex", "packages");
    for (const pkg of existsSync(pkgs) ? await readdir(pkgs) : []) {
      const releases = path.join(pkgs, pkg, "releases");
      for (const rel of existsSync(releases) ? await readdir(releases) : []) {
        const cand = path.join(releases, rel, "CodexCLI.app", "Contents", "MacOS", "codex");
        if (existsSync(cand)) return cand;
      }
    }
  }
  throw new Error(`no ${host} binary found (PATH${host === "codex" ? " or ~/.codex/packages" : ""}); pass --bin`);
}

function detectVersion(bin: string): string {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  const m = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(`${r.stdout}\n${r.stderr}`);
  if (!m) throw new Error(`cannot read a version from "${bin} --version": ${(r.stdout + r.stderr).trim().slice(0, 200)}`);
  // "GitHub Copilot CLI 1.0.93." ends its sentence with a dot.
  return m[1].replace(/\.+$/, "");
}

async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}

const SCRATCH_PREFIX = "cocheck-probe-";
// mkdtemp appends exactly six [A-Za-z0-9] characters. The tests' "cocheck-probe-test-" dirs contain a dash after the prefix, so they never match.
const SCRATCH_NAME = /^cocheck-probe-[A-Za-z0-9]{6}$/;
const STALE_MS = 3600_000;

/** Removes leftover scratch dirs (real directories named like mkdtemp output of the probe prefix, older than an hour) from root. Nothing else. */
export async function sweepStaleScratch(root: string, now = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!SCRATCH_NAME.test(name)) continue;
    const full = path.join(root, name);
    try {
      const st = await lstat(full);
      if (!st.isDirectory() || now - st.mtimeMs < STALE_MS) continue;
      await rm(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      // gone already, or not ours to touch: leave it
    }
  }
  return removed;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TOKEN_SHAPES: Array<[string, RegExp]> = [
  ["sk- key", /sk-[A-Za-z0-9_-]{16,}/],
  ["ghp_ token", /ghp_[A-Za-z0-9]{16,}/],
  ["gho_ token", /gho_[A-Za-z0-9]{16,}/],
  ["JWT", /eyJ[A-Za-z0-9_-]{8,}/],
  ["Bearer value", /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/],
  ["private key header", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Replaces emails and the home path (as given and as its realpath, longest first). */
export function scrubText(text: string, homes: string[]): string {
  let out = text;
  for (const h of [...new Set(homes)].filter((x) => x.length > 1).sort((a, b) => b.length - a.length)) out = out.split(h).join("/Users/<user>");
  return out.replace(EMAIL, "user@example.com");
}

/** Names of the token shapes found in text. */
export function findTokenShapes(text: string): string[] {
  return TOKEN_SHAPES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

async function writeScrubbed(src: string, dst: string, homes: string[]): Promise<string[]> {
  const clean = scrubText(await readFile(src, "utf8"), homes);
  await writeFile(dst, clean);
  return findTokenShapes(clean);
}

function runHost(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; onChild: (c: ReturnType<typeof spawn>) => void }): Promise<{ status: number | null; error?: Error; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "ignore", "pipe"], timeout: 600_000 });
    opts.onChild(child);
    let stderr = "";
    child.stderr?.on("data", (c) => (stderr = (stderr + c).slice(-2000)));
    child.on("error", (error) => resolve({ status: null, error, stderr }));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

export async function runProbe(opts: ProbeOptions): Promise<{ dir: string; version: string }> {
  const realHome = opts.realHome ?? homedir();
  const out = await assertOutAllowed(opts.out, realHome);
  const bin = opts.bin ?? process.env.COCHECK_PROBE_BIN ?? (await findBinary(opts.host, realHome));
  const version = detectVersion(bin);
  const root = opts.tmpRoot ?? tmpdir();
  await sweepStaleScratch(root);
  const scratch = await mkdtemp(path.join(root, SCRATCH_PREFIX));
  let child: ReturnType<typeof spawn> | undefined;
  const onSignal = (sig: NodeJS.Signals) => {
    child?.kill("SIGTERM");
    rmSync(scratch, { recursive: true, force: true });
    process.exit(128 + (sig === "SIGINT" ? 2 : 15));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const work = path.join(scratch, "work");
  const payloads = path.join(scratch, "payloads.jsonl");
  const hookScript = path.join(scratch, "log-hook.mjs");
  const dir = path.join(out, `${opts.host}-${version}`);
  let failure: Error | undefined;
  try {
    await mkdir(work);
    await writeFile(path.join(work, "data.csv"), CSV);
    await writeFile(hookScript, LOG_HOOK);
    const hookCmd = (event: string) => `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)} ${event} ${JSON.stringify(payloads)}`;
    let args: string[];
    const env: NodeJS.ProcessEnv = { ...process.env };
    const sessionFiles: string[] = [];
    if (opts.host === "codex") {
      const home = path.join(scratch, "home");
      await mkdir(home);
      const authSrc = opts.authSrc ?? process.env.COCHECK_PROBE_AUTH ?? path.join(realHome, ".codex", "auth.json");
      const authDst = path.join(home, "auth.json");
      await copyFile(authSrc, authDst);
      await chmod(authDst, 0o600);
      const toml = ["[features]", "hooks = true", ""];
      for (const ev of CODEX_EVENTS) toml.push(`[[hooks.${ev}]]`, `[[hooks.${ev}.hooks]]`, 'type = "command"', `command = ${JSON.stringify(hookCmd(ev))}`, "");
      await writeFile(path.join(home, "config.toml"), toml.join("\n"));
      env.CODEX_HOME = home;
      args = ["--dangerously-bypass-hook-trust", "exec", "--skip-git-repo-check", "-C", work, "--sandbox", "workspace-write", PROMPT];
    } else if (opts.host === "copilot") {
      const home = path.join(scratch, "home");
      await mkdir(home);
      const hooks: Record<string, unknown[]> = {};
      for (const ev of COPILOT_EVENTS) hooks[ev] = [{ type: "command", bash: hookCmd(ev) }];
      await mkdir(path.join(work, ".github", "hooks"), { recursive: true });
      await writeFile(path.join(work, ".github", "hooks", "log.json"), JSON.stringify({ version: 1, hooks }, null, 2));
      const git = spawnSync("git", ["init", "-q"], { cwd: work, encoding: "utf8" });
      if (git.status !== 0) throw new Error(`git init failed in the scratch folder: ${(git.stderr || git.error?.message || "").trim()}`);
      env.COPILOT_HOME = home;
      env.COPILOT_ALLOW_ALL = "true";
      args = ["-p", PROMPT, "--no-auto-update", "--no-remote"];
    } else {
      const settings = path.join(scratch, "settings.json");
      const hooks: Record<string, unknown> = {};
      for (const ev of CLAUDE_EVENTS) hooks[ev] = [{ hooks: [{ type: "command", command: hookCmd(ev) }] }];
      await writeFile(settings, JSON.stringify({ hooks }));
      args = ["-p", PROMPT, "--setting-sources", "", "--settings", settings, "--permission-mode", "bypassPermissions"];
    }
    const r = await runHost(bin, args, { cwd: work, env, onChild: (c) => (child = c) });
    if (r.error || r.status !== 0) failure = new Error(`${opts.host} run failed (exit ${r.status}): ${r.error?.message ?? ""} ${r.stderr.slice(-500)}`);
    // Session files: codex writes them under the scratch home, copilot keeps session-state/<id>/events.jsonl there; claude names its transcript in each payload.
    if (opts.host === "copilot") sessionFiles.push(...(await listFiles(path.join(scratch, "home", "session-state"))).filter((f) => f.endsWith("events.jsonl")));
    if (opts.host === "codex") sessionFiles.push(...(await listFiles(path.join(scratch, "home", "sessions"))));
    if (existsSync(payloads)) {
      const seen = new Set<string>();
      for (const line of (await readFile(payloads, "utf8")).split("\n").filter(Boolean)) {
        try {
          const tp = JSON.parse(JSON.parse(line).stdin)?.transcript_path;
          if (typeof tp === "string" && existsSync(tp) && !seen.has(tp)) {
            seen.add(tp);
            if (opts.host === "claude") sessionFiles.push(tp);
          }
        } catch {
          // a payload that is not JSON stays in payloads.jsonl as it came
        }
      }
    }
    const homes = [realHome, await resolveThroughLinks(realHome), homedir(), await resolveThroughLinks(homedir())];
    const shapes = new Set<string>();
    try {
      await mkdir(path.join(dir, "sessions"), { recursive: true });
      if (existsSync(payloads)) for (const s of await writeScrubbed(payloads, path.join(dir, "payloads.jsonl"), homes)) shapes.add(s);
      for (const f of sessionFiles) for (const s of await writeScrubbed(f, path.join(dir, "sessions", opts.host === "copilot" ? `${path.basename(path.dirname(f))}-${path.basename(f)}` : path.basename(f)), homes)) shapes.add(s);
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    if (shapes.size) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(`token-shaped string left after scrubbing (${[...shapes].join(", ")}); removed ${dir}`);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await rm(scratch, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return { dir, version };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const host = argv[0];
  const out = flag("--out");
  if ((host !== "claude" && host !== "codex" && host !== "copilot") || !out) {
    console.error("usage: probe-host.ts <claude|codex|copilot> --out <dir> [--bin <path>] [--auth <auth.json>]");
    process.exit(2);
  }
  runProbe({ host, out, bin: flag("--bin"), authSrc: flag("--auth") })
    .then((r) => console.log(`wrote ${r.dir}`))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
