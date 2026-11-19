// Validates platforms/*/capabilities.json against platforms/SCHEMA.md and generates platforms/matrix.md.
// `node scripts/platforms-check.ts` exits 1 when a file is invalid or the matrix is stale; `--write` regenerates the matrix.
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOP_KEYS = [
  "schema", "platform", "name", "vendor", "surfaces", "checked_on", "versions_seen", "cocheck_relevance",
  "install", "processes_and_paths", "auth", "hooks", "other_observation_channels", "call_ids", "narration_sources",
  "session_files", "helpers_or_subagents", "limits_and_timeouts", "update_channel", "open_questions",
];
const HOOK_KEYS = [
  "available", "config", "trust_or_approval", "events", "missing_events",
  "absent_events", "config_paths", "surfaces", "skill_and_plugin_paths", "sandbox_and_network",
];
/** The hook-event list a platform's host profile may be checked against: these carry the full hook register. */
export const REGISTER_HOSTS = ["claude-code", "codex", "copilot-cli", "copilot-vscode"];
const SCOPES = ["user", "repo", "managed", "plugin", "skill", "agent"];
/** Sources a `confirmed` hook fact may rest on: an official vendor page, a recorded probe, captured binary output, or (kind `observed`) a file read on this Mac. */
const OFFICIAL = /^https:\/\/(code\.claude\.com|docs\.anthropic\.com|learn\.chatgpt\.com|developers\.openai\.com|docs\.github\.com|code\.visualstudio\.com)\/|^https:\/\/(github\.com|api\.github\.com\/repos|raw\.githubusercontent\.com)\/(anthropics|openai|github|microsoft)\//;
const confirmable = (source: string, kind?: string): boolean => OFFICIAL.test(source) || source.startsWith("probe:") || source.startsWith("binary:") || (kind === "observed" && source.startsWith("local:"));
const FACT_LISTS = [
  "install", "processes_and_paths", "auth", "other_observation_channels", "call_ids", "session_files",
  "helpers_or_subagents", "limits_and_timeouts", "update_channel",
];
const KINDS = ["documented", "observed"];
const STATUSES = ["confirmed", "unverified", "contradicted"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Json = any;
type Status = "confirmed" | "unverified" | "contradicted";

export interface Platform {
  key: string;
  data: Json;
}

/** One cross-platform finding in `platforms/discrepancies.json`: a fact the platforms disagree on or a gap CoCheck has to design around. */
export interface Discrepancy {
  id: string;
  title: string;
  platforms: string[];
  detail: string;
  fact: Json;
}

export interface CheckResult {
  errors: string[];
  stale: boolean;
}

const isObject = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);

function checkFact(fact: Json, where: string, errors: string[]): void {
  if (!isObject(fact)) {
    errors.push(`${where}: fact must be an object`);
    return;
  }
  if (typeof fact.claim !== "string" || fact.claim === "") errors.push(`${where}: missing claim`);
  if (!KINDS.includes(fact.kind)) errors.push(`${where}: kind must be one of ${KINDS.join("|")}`);
  if (typeof fact.source !== "string" || fact.source === "") errors.push(`${where}: missing source`);
  if (typeof fact.date !== "string" || !DATE.test(fact.date)) errors.push(`${where}: date must be YYYY-MM-DD`);
  if (!("verified_on" in fact)) errors.push(`${where}: missing verified_on`);
  else if (fact.verified_on !== null && typeof fact.verified_on !== "string") errors.push(`${where}: verified_on must be a string or null`);
  if (!STATUSES.includes(fact.status)) errors.push(`${where}: status must be one of ${STATUSES.join("|")}`);
}

function checkFactList(list: Json, where: string, errors: string[]): void {
  if (!Array.isArray(list)) {
    errors.push(`${where}: must be a list`);
    return;
  }
  list.forEach((f, i) => checkFact(f, `${where}[${i}]`, errors));
}

function checkRegisterLists(hooks: Json, label: string, errors: string[]): void {
  for (const k of ["surfaces", "config_paths"]) {
    if (!Array.isArray(hooks[k])) continue;
    hooks[k].forEach((f: Json, i: number) => {
      const w = `${label}: hooks.${k}[${i}]`;
      const v = isObject(f) ? f.value : undefined;
      if (!isObject(v)) return errors.push(`${w}: value must be an object`);
      if (k === "config_paths") {
        if (!SCOPES.includes(v.scope)) errors.push(`${w}: value.scope must be one of ${SCOPES.join("|")}`);
        if (typeof v.path !== "string" || v.path === "") errors.push(`${w}: value.path must be a string`);
      } else {
        if (typeof v.surface !== "string" || v.surface === "") errors.push(`${w}: value.surface must be a string`);
        if (![true, false, "unknown"].includes(v.runs_hooks)) errors.push(`${w}: value.runs_hooks must be true|false|"unknown"`);
      }
    });
  }
  if (Array.isArray(hooks.absent_events)) {
    hooks.absent_events.forEach((f: Json, i: number) => {
      if (!isObject(f) || !Array.isArray(f.value) || !f.value.every((x: unknown) => typeof x === "string")) errors.push(`${label}: hooks.absent_events[${i}]: value must be a list of event names`);
    });
  }
}

/** A hook fact may say `confirmed` only on an official page, a probe record or binary output; anything else is at best `unverified`. */
function checkConfirmedSources(hooks: Json, label: string, errors: string[]): void {
  const facts: [string, Json][] = [["available", hooks.available]];
  for (const k of ["config", "trust_or_approval", "missing_events", "absent_events", "config_paths", "surfaces", "skill_and_plugin_paths", "sandbox_and_network"]) {
    (hooks[k] ?? []).forEach((f: Json, i: number) => facts.push([`${k}[${i}]`, f]));
  }
  (hooks.events ?? []).forEach((e: Json, i: number) => facts.push([`events[${i}] (${e?.name})`, e?.fact]));
  for (const [where, f] of facts) {
    if (isObject(f) && f.status === "confirmed" && typeof f.source === "string" && !confirmable(f.source, f.kind)) {
      errors.push(`${label}: hooks.${where}: status confirmed needs an official source URL, a probe:/binary: record, or an observed local: file, not "${f.source}"`);
    }
  }
}

/** Entries of `events` and `narration_sources` are objects wrapping a `fact`; the schema lets a source also be a bare FACT. */
export function validateCapabilities(data: Json, label: string): string[] {
  const errors: string[] = [];
  const err = (m: string) => errors.push(`${label}: ${m}`);
  if (!isObject(data)) return [`${label}: top level must be an object`];
  for (const k of Object.keys(data)) if (!TOP_KEYS.includes(k)) err(`unknown top-level key "${k}"`);
  for (const k of TOP_KEYS) if (!(k in data)) err(`missing top-level key "${k}"`);
  if (data.schema !== 1) err("schema must be 1");
  for (const k of ["platform", "name", "vendor", "cocheck_relevance"]) {
    if (typeof data[k] !== "string" || data[k] === "") err(`${k} must be a non-empty string`);
  }
  if (typeof data.checked_on !== "string" || !DATE.test(data.checked_on)) err("checked_on must be YYYY-MM-DD");
  if (!Array.isArray(data.surfaces)) err("surfaces must be a list");
  if (!Array.isArray(data.open_questions)) err("open_questions must be a list");
  if (Array.isArray(data.versions_seen)) {
    data.versions_seen.forEach((v: Json, i: number) => {
      if (!isObject(v) || typeof v.version !== "string" || typeof v.where !== "string" || !DATE.test(v.date ?? "")) {
        err(`versions_seen[${i}]: needs version, where, date YYYY-MM-DD`);
      }
    });
  } else err("versions_seen must be a list");

  for (const k of FACT_LISTS) if (k in data) checkFactList(data[k], `${label}: ${k}`, errors);

  const hooks = data.hooks;
  if (!isObject(hooks)) err("hooks must be an object");
  else {
    for (const k of Object.keys(hooks)) if (!HOOK_KEYS.includes(k)) err(`unknown hooks key "${k}"`);
    for (const k of HOOK_KEYS) if (!(k in hooks)) err(`missing hooks key "${k}"`);
    if ("available" in hooks) checkFact(hooks.available, `${label}: hooks.available`, errors);
    for (const k of ["config", "trust_or_approval", "missing_events", "absent_events", "config_paths", "surfaces", "skill_and_plugin_paths", "sandbox_and_network"]) {
      if (k in hooks) checkFactList(hooks[k], `${label}: hooks.${k}`, errors);
    }
    const register = REGISTER_HOSTS.includes(data.platform);
    if (register) checkRegisterLists(hooks, label, errors);
    if (Array.isArray(hooks.events)) {
      hooks.events.forEach((e: Json, i: number) => {
        const w = `${label}: hooks.events[${i}]`;
        if (!isObject(e)) return errors.push(`${w}: must be an object`);
        if (typeof e.name !== "string" || e.name === "") errors.push(`${w}: missing name`);
        if (typeof e.when !== "string") errors.push(`${w}: missing when`);
        if (typeof e.can_block !== "boolean" && !(register && e.can_block === null)) errors.push(`${w}: can_block must be boolean${register ? " or null (not documented)" : ""}`);
        if (!Array.isArray(e.payload_fields)) errors.push(`${w}: payload_fields must be a list`);
        checkFact(e.fact, `${w}.fact`, errors);
        for (const k of ["unverified_fields", "absent_fields", "aliases"]) {
          if (k in e && !(Array.isArray(e[k]) && e[k].every((x: unknown) => typeof x === "string"))) errors.push(`${w}: ${k} must be a list of strings`);
        }
        if ("matcher" in e && e.matcher !== null && typeof e.matcher !== "string") errors.push(`${w}: matcher must be a string or null`);
        if (register) {
          if (typeof e.can_rewrite !== "boolean" && e.can_rewrite !== null) errors.push(`${w}: can_rewrite must be boolean or null (not documented)`);
          if (!("can_rewrite" in e)) errors.push(`${w}: missing can_rewrite`);
          if (!("timeout_sec" in e) || (e.timeout_sec !== null && typeof e.timeout_sec !== "number")) errors.push(`${w}: timeout_sec must be a number or null (host default)`);
          if (!("matcher" in e)) errors.push(`${w}: missing matcher (a string, or null when the event takes none)`);
        }
      });
    } else if ("events" in hooks) err("hooks.events must be a list");
  }

  if (REGISTER_HOSTS.includes(data.platform) && isObject(hooks)) checkConfirmedSources(hooks, label, errors);

  if (Array.isArray(data.narration_sources)) {
    data.narration_sources.forEach((s: Json, i: number) => {
      const w = `${label}: narration_sources[${i}]`;
      if (isObject(s) && "fact" in s) {
        if (typeof s.name !== "string" || s.name === "") errors.push(`${w}: missing name`);
        if (typeof s.path !== "string") errors.push(`${w}: missing path`);
        if (!["pre", "post"].includes(s.readable_at)) errors.push(`${w}: readable_at must be pre|post`);
        if (typeof s.default_on !== "boolean") errors.push(`${w}: default_on must be boolean`);
        checkFact(s.fact, `${w}.fact`, errors);
      } else checkFact(s, w, errors);
    });
  } else if ("narration_sources" in data) err("narration_sources must be a list");
  return errors;
}

/** Top-level repo folders a relative `local:` source may name; any other `local:` text is a machine path or a description and is not checked. */
const REPO_DIRS = ["src", "docs", "scripts", "test", "platforms"];

/** Every `probe:` or `local:` path a source string cites that must exist in the repo; `probe:` paths always, `local:` paths only when repo-relative or under /tmp. */
export function citedRepoPaths(source: string): { kind: "probe" | "local"; path: string }[] {
  const out: { kind: "probe" | "local"; path: string }[] = [];
  for (const m of source.matchAll(/\b(probe|local):(\S+)/g)) {
    const p = m[2].replace(/[;,]+$/, "");
    const kind = m[1] as "probe" | "local";
    const checked = kind === "probe" || /^\/(private\/)?(tmp|var)\//.test(p) || /^\.\.?\//.test(p) || REPO_DIRS.includes(p.split("/")[0]);
    if (checked) out.push({ kind, path: p });
  }
  return out;
}

/**
 * Directory listings read during one check, keyed by path (undefined: not a readable directory). Built per loadPlatforms call, never kept
 * across calls: a caller may edit or delete files between two checks. Without it every cited path re-read every folder above it, and a
 * scratch copy's repo root is the OS temp folder, which can hold a hundred thousand entries.
 */
export type ListingCache = Map<string, Promise<Set<string> | undefined>>;

function listing(dir: string, cache: ListingCache): Promise<Set<string> | undefined> {
  let got = cache.get(dir);
  if (got === undefined) {
    got = readdir(dir).then((names) => new Set(names), () => undefined);
    cache.set(dir, got);
  }
  return got;
}

/** True when `file` lies inside `repoRoot` and every segment matches an on-disk name case-exactly, so a pass on macOS also passes on Linux. */
async function existsExactInRepo(repoRoot: string, file: string, cache: ListingCache): Promise<boolean> {
  const rel = path.relative(repoRoot, path.resolve(file));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  let dir = repoRoot;
  for (const seg of rel.split(path.sep)) {
    if (!(await listing(dir, cache))?.has(seg)) return false;
    dir = path.join(dir, seg);
  }
  return true;
}

/** Sources are repo-relative: a `probe:` path resolves against the platform folder (where `versions/` lives), then the repo root; absolute paths outside the repo never count. */
async function checkSourcePaths(data: Json, label: string, bases: string[], repoRoot: string, cache: ListingCache): Promise<string[]> {
  const errors: string[] = [];
  const walk = async (o: Json, where: string): Promise<void> => {
    if (Array.isArray(o)) return void (await Promise.all(o.map((v, i) => walk(v, `${where}[${i}]`))));
    if (!isObject(o)) return;
    if (typeof o.source === "string") {
      for (const c of citedRepoPaths(o.source)) {
        const found = path.isAbsolute(c.path)
          ? await existsExactInRepo(repoRoot, c.path, cache)
          : (await Promise.all([...bases, repoRoot].map((b) => existsExactInRepo(repoRoot, path.join(b, c.path), cache)))).some(Boolean);
        if (!found) errors.push(`${label}: ${where}: ${c.kind}: source path not found in the repo: ${c.path}`);
      }
    }
    for (const [k, v] of Object.entries(o)) if (k !== "source") await walk(v, where === "" ? k : `${where}.${k}`);
  };
  await walk(data, "");
  return errors;
}

export async function loadPlatforms(dir: string, cache: ListingCache = new Map()): Promise<{ platforms: Platform[]; errors: string[] }> {
  const platforms: Platform[] = [];
  const errors: string[] = [];
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const key of entries) {
    const file = path.join(dir, key, "capabilities.json");
    let data: Json;
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      errors.push(`${key}: cannot read capabilities.json (${(e as Error).message})`);
      continue;
    }
    errors.push(...validateCapabilities(data, key));
    errors.push(...(await checkSourcePaths(data, key, [path.join(dir, key)], path.dirname(dir), cache)));
    if (isObject(data) && data.platform !== key) errors.push(`${key}: platform "${data.platform}" does not match folder name`);
    platforms.push({ key, data });
  }
  return { platforms, errors };
}

export function validateDiscrepancies(data: Json, platformKeys: string[]): string[] {
  const errors: string[] = [];
  if (!isObject(data) || data.schema !== 1 || !Array.isArray(data.items)) return ["discrepancies: must be {schema:1, items:[...]}"];
  const seen = new Set<string>();
  data.items.forEach((d: Json, i: number) => {
    const w = `discrepancies: items[${i}]`;
    if (!isObject(d)) return errors.push(`${w}: must be an object`);
    if (typeof d.id !== "string" || d.id === "") errors.push(`${w}: missing id`);
    else if (seen.has(d.id)) errors.push(`${w}: duplicate id ${d.id}`);
    else seen.add(d.id);
    for (const k of ["title", "detail"]) if (typeof d[k] !== "string" || d[k] === "") errors.push(`${w}: missing ${k}`);
    if (!Array.isArray(d.platforms) || d.platforms.length === 0) errors.push(`${w}: platforms must be a non-empty list`);
    else for (const p of d.platforms) if (!platformKeys.includes(p)) errors.push(`${w}: unknown platform "${p}"`);
    checkFact(d.fact, `${w}.fact`, errors);
    if (isObject(d.fact) && d.fact.status === "confirmed" && typeof d.fact.source === "string" && !confirmable(d.fact.source, d.fact.kind)) {
      errors.push(`${w}.fact: status confirmed needs an official source URL, a probe: or a binary: record`);
    }
  });
  return errors;
}

export async function loadDiscrepancies(dir: string, platformKeys: string[], cache: ListingCache = new Map()): Promise<{ items: Discrepancy[]; errors: string[] }> {
  let data: Json;
  try {
    data = JSON.parse(await readFile(path.join(dir, "discrepancies.json"), "utf8"));
  } catch (e) {
    return { items: [], errors: [`discrepancies: cannot read discrepancies.json (${(e as Error).message})`] };
  }
  const errors = validateDiscrepancies(data, platformKeys);
  errors.push(...(await checkSourcePaths(data, "discrepancies", [dir, ...platformKeys.map((k) => path.join(dir, k))], path.dirname(dir), cache)));
  return { items: errors.length === 0 ? data.items : [], errors };
}

const norm = (name: string): string => name.toLowerCase();

function factsOf(data: Json): Json[] {
  const out: Json[] = [];
  for (const k of FACT_LISTS) out.push(...(data[k] ?? []));
  const h = data.hooks ?? {};
  out.push(h.available, ...(h.config ?? []), ...(h.trust_or_approval ?? []), ...(h.missing_events ?? []));
  for (const k of ["absent_events", "config_paths", "surfaces", "skill_and_plugin_paths", "sandbox_and_network"]) out.push(...(h[k] ?? []));
  for (const e of h.events ?? []) out.push(e.fact);
  for (const s of data.narration_sources ?? []) out.push(s.fact ?? s);
  return out.filter(Boolean);
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function buildMatrix(platforms: Platform[], discrepancies: Discrepancy[] = []): string {
  const lines: string[] = [
    "# Platform matrix",
    "",
    "Generated by `node scripts/platforms-check.ts --write` from each `platforms/<key>/capabilities.json`. Do not edit by hand.",
    "",
    "## Hook events",
    "",
    "Event names are matched case-insensitively. `available` means the platform lists the event with a confirmed fact. `unverified` means it is listed but the fact is unverified or contradicted. `missing` means the platform lists no such event. The cell shows the platform's own spelling.",
    "",
  ];
  const events = new Map<string, string>();
  for (const p of platforms) for (const e of p.data.hooks.events) if (!events.has(norm(e.name))) events.set(norm(e.name), e.name);
  const sorted = [...events.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  lines.push(`| Event | ${platforms.map((p) => p.key).join(" | ")} |`, `| --- | ${platforms.map(() => "---").join(" | ")} |`);
  for (const [n, display] of sorted) {
    const cells = platforms.map((p) => {
      const hit = p.data.hooks.events.find((e: Json) => norm(e.name) === n);
      if (!hit) return "missing";
      const state = hit.fact.status === "confirmed" ? "available" : "unverified";
      return hit.name === display ? state : `${state} (\`${hit.name}\`)`;
    });
    lines.push(`| ${display} | ${cells.join(" | ")} |`);
  }
  const register = platforms.filter((p) => REGISTER_HOSTS.includes(p.key));
  lines.push("", "## Hook register", "", "One table per host that carries the full register. `blocks` and `rewrites` say whether the hook can stop the step or change its input, output or prompt (`?` means the docs say nothing). `timeout` is the default in seconds (`default` is the host's own default). `status` is the fact status of the event; payload fields beyond the confirmed ones are listed in `capabilities.json` as `unverified_fields`.", "");
  for (const p of register) {
    lines.push(`### ${p.key}`, "", "| Event | Name and casing | blocks | rewrites | timeout | matcher | status |", "| --- | --- | --- | --- | --- | --- | --- |");
    const tri = (v: boolean | null): string => (v === null ? "?" : v ? "yes" : "no");
    for (const e of [...p.data.hooks.events].sort((a: Json, b: Json) => norm(a.name).localeCompare(norm(b.name)))) {
      const names = [e.name, ...(e.aliases ?? [])].map((n: string) => `\`${n}\``).join(" / ");
      lines.push(`| ${cell(e.name)} | ${names} | ${tri(e.can_block)} | ${tri(e.can_rewrite)} | ${e.timeout_sec ?? "default"} | ${cell(e.matcher ?? "none")} | ${e.fact.status} |`);
    }
    lines.push("");
  }
  lines.push("## Surfaces that run hooks", "", "| Platform | Surface | Runs hooks | Status |", "| --- | --- | --- | --- |");
  for (const p of register) for (const f of p.data.hooks.surfaces) lines.push(`| ${p.key} | ${cell(f.value.surface)} | ${f.value.runs_hooks} | ${f.status} |`);
  lines.push("", "## Discrepancies", "", "Read from `platforms/discrepancies.json`. Each entry names the platforms it concerns and the status of the fact behind it.", "");
  for (const d of discrepancies) lines.push(`- ${d.title} (${d.platforms.join(", ")}; ${d.fact.status}, ${d.fact.date}): ${cell(d.detail)} Source: ${d.fact.source}`);
  lines.push("", "## Narration sources", "", "`readable_at` is `pre` when the text can be read before the step runs and `post` when only afterwards.", "");
  lines.push("| Platform | Source | readable_at | Status |", "| --- | --- | --- | --- |");
  for (const p of platforms) {
    const structured = p.data.narration_sources.filter((s: Json) => "fact" in s);
    if (structured.length === 0) lines.push(`| ${p.key} | none recorded | - | - |`);
    for (const s of structured) lines.push(`| ${p.key} | ${cell(s.name)} | ${s.readable_at} | ${s.fact.status} |`);
  }
  lines.push("", "## Per platform", "");
  for (const p of platforms) {
    const counts: Record<Status, number> = { confirmed: 0, unverified: 0, contradicted: 0 };
    for (const f of factsOf(p.data)) counts[f.status as Status]++;
    const versions = p.data.versions_seen.map((v: Json) => v.version).join(", ") || "none";
    lines.push(`- ${p.key} (${p.data.name}): versions seen ${versions}; facts ${counts.confirmed} confirmed, ${counts.unverified} unverified, ${counts.contradicted} contradicted.`);
  }
  return lines.join("\n") + "\n";
}

export async function writeMatrix(dir: string): Promise<void> {
  const cache: ListingCache = new Map();
  const { platforms } = await loadPlatforms(dir, cache);
  const { items } = await loadDiscrepancies(dir, platforms.map((p) => p.key), cache);
  await writeFile(path.join(dir, "matrix.md"), buildMatrix(platforms, items));
}

export async function checkPlatforms(dir: string): Promise<CheckResult> {
  // One listing cache for this check only: the files may change before the next call.
  const cache: ListingCache = new Map();
  const loaded = await loadPlatforms(dir, cache);
  const { platforms } = loaded;
  const disc = await loadDiscrepancies(dir, platforms.map((p) => p.key), cache);
  const errors = [...loaded.errors, ...disc.errors];
  if (errors.length > 0) return { errors, stale: false };
  let current = "";
  try {
    current = await readFile(path.join(dir, "matrix.md"), "utf8");
  } catch {
    // a missing matrix counts as stale
  }
  return { errors, stale: current !== buildMatrix(platforms, disc.items) };
}

async function main(): Promise<void> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "platforms");
  if (process.argv.includes("--write")) {
    const loaded = await loadPlatforms(dir);
    const errors = [...loaded.errors, ...(await loadDiscrepancies(dir, loaded.platforms.map((p) => p.key))).errors];
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    await writeMatrix(dir);
    console.log("platforms/matrix.md written");
    return;
  }
  const { errors, stale } = await checkPlatforms(dir);
  if (errors.length > 0) console.error(errors.join("\n"));
  if (stale) console.error("platforms/matrix.md is stale; run node scripts/platforms-check.ts --write");
  if (errors.length > 0 || stale) process.exit(1);
  console.log("platforms ok");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
