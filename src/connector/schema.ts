// Hand-written checks for the connector manifest (`cocheck-connector.json`) and the answers to `export` and `snapshot` calls (the `diff` answer is
// checked by changes-v1.ts). No JSON Schema library. The one closed set is the entry; everything else is open, so an extra vendor field is accepted.

export interface Problem {
  /** "cocheck-connector.json" for the manifest, "<answer>" for a diff answer (the validator rewrites it to the run script). */
  file: string;
  /** JSON path inside the document, e.g. "changes[0].anchors". */
  field: string;
  expected: string;
  found: string;
  /** One sentence the contributor can act on. */
  fix: string;
}

export const MANIFEST_FILE = "cocheck-connector.json";
export const ANSWER_FILE = "<answer>";
export const MANIFEST_SPEC = "cocheck.connector/1";
/** The method an export-entry connector answers (a constant: the name is defined in public-kit/spec/v1.md). */
export const EXPORT_METHOD = "export";
export const ENTRIES = ["state", "diff", "both", "export"] as const;

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const quote = (list: readonly string[]) => list.map((s) => `"${s}"`).join(", ");

function describe(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 37)}...` : v);
  if (Array.isArray(v)) return v.length === 0 ? "an empty list" : "a list";
  if (isObj(v)) return "an object";
  return String(v);
}

export class Collector {
  readonly problems: Problem[] = [];
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  add(field: string, expected: string, found: unknown, fix: string): void {
    this.problems.push({ file: this.file, field, expected, found: describe(found), fix });
  }
}

function checkArgv(c: Collector, field: string, v: unknown): void {
  const fix = `Write ${field} as a list of strings such as ["node", "connector.mjs"], with the program first and each argument as its own item.`;
  if (!Array.isArray(v) || v.length === 0) return c.add(field, "a non-empty list of strings (program, then arguments)", v, fix);
  v.forEach((a, i) => {
    if (typeof a !== "string" || (i === 0 && a === "")) c.add(`${field}[${i}]`, "a string", a, fix);
  });
}

function checkStringList(c: Collector, field: string, v: unknown): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) c.add(field, "a list of strings", v, `Write ${field} as a list of strings.`);
}

const TEMPLATE_RE = /^(?:[^{}]|\{\w+(?::hex)?\})+$/;

function checkSubjects(c: Collector, v: unknown): void {
  if (v === undefined) return;
  const fix = "Write matches.subjects as { \"<full MCP tool name>\": \"<template>\" }, a template being text with {field} or {field:hex} parts such as \"notion://page/{page_id:hex}\".";
  if (!isObj(v)) return c.add("matches.subjects", "an object from MCP tool name to template", v, fix);
  for (const [tool, t] of Object.entries(v)) {
    if (tool === "") c.add("matches.subjects", "non-empty tool names", "an empty key", fix);
    if (typeof t !== "string" || !TEMPLATE_RE.test(t)) c.add(`matches.subjects.${tool}`, "a template: text with {field} or {field:hex} parts (field = word characters)", t, fix);
  }
}

/** A `matches.calls` template: text with {path} or {path:hex} parts, a path being word parts joined by dots (`{issue.id}`). */
export const CALL_TEMPLATE_RE = /^(?:[^{}]|\{\w+(?:\.\w+)*(?::hex)?\})+$/;

/** `matches.calls`, one creation subject read from each named tool's answer. Anything this version does not build is a problem saying so. */
function checkCalls(c: Collector, v: unknown, subjects: unknown): void {
  if (v === undefined) return;
  const fix = "Write matches.calls as { \"<full MCP tool name>\": { \"subjects\": [{ \"from\": \"response\", \"template\": \"<template>\", \"created\": true }] } }.";
  if (!isObj(v)) return c.add("matches.calls", "an object from MCP tool name to { subjects }", v, fix);
  for (const [tool, entry] of Object.entries(v)) {
    const at = `matches.calls.${tool}`;
    if (tool === "") c.add("matches.calls", "non-empty tool names", "an empty key", fix);
    if (isObj(subjects) && Object.hasOwn(subjects, tool)) c.add(at, "a tool not also named in matches.subjects", tool, "Naming one tool in both matches.subjects and matches.calls is not supported yet; keep it in one of them.");
    if (!isObj(entry)) { c.add(at, "an object with a subjects list", entry, fix); continue; }
    const list = entry.subjects;
    if (!Array.isArray(list) || list.length !== 1) { c.add(`${at}.subjects`, "a list of exactly one subject", list, "Name exactly one subject per tool; more than one item per call is not supported yet."); continue; }
    const s = list[0];
    if (!isObj(s)) { c.add(`${at}.subjects[0]`, "an object", s, fix); continue; }
    if (s.from !== "response") c.add(`${at}.subjects[0].from`, "\"response\"", s.from, "Only \"from\": \"response\" is supported yet: the subject is read from the tool's answer.");
    if (s.created !== true) c.add(`${at}.subjects[0].created`, "true", s.created, "Only tools that create an item (\"created\": true) are supported yet.");
    if (typeof s.template !== "string" || !CALL_TEMPLATE_RE.test(s.template)) c.add(`${at}.subjects[0].template`, "a template: text with {path} or {path:hex} parts (path = word parts joined by dots, no [])", s.template, "Write the template as text with {path} parts such as \"linear://issue/{issue.id}\".");
  }
}

export function checkManifest(json: unknown): Problem[] {
  const c = new Collector(MANIFEST_FILE);
  if (!isObj(json)) {
    c.add("", "a JSON object", json, "Make the whole file one JSON object with spec, id, version, entry, matches and run.");
    return c.problems;
  }
  if (json.spec !== MANIFEST_SPEC) c.add("spec", `"${MANIFEST_SPEC}"`, json.spec, `Set spec to "${MANIFEST_SPEC}".`);
  if (!isStr(json.id)) c.add("id", "a non-empty string", json.id, "Give the connector a short unique id such as \"toy-notes\".");
  if (!isStr(json.version)) c.add("version", "a non-empty version string", json.version, "Set version to your own release number such as \"0.1.0\".");
  if (!(ENTRIES as readonly unknown[]).includes(json.entry)) c.add("entry", `one of ${quote(ENTRIES)}`, json.entry, `Set entry to ${quote(ENTRIES)} depending on whether you snapshot state, report diffs, or both.`);
  if (!isObj(json.matches)) c.add("matches", "an object naming what the connector handles (extensions, schemes, MCP servers and write tools)", json.matches, "Add a matches object such as { \"extensions\": [\".notes.json\"] }.");
  else {
    const keys = ["extensions", "schemes", "mcpServers", "mcpTools"];
    for (const k of keys) checkStringList(c, `matches.${k}`, (json.matches as Obj)[k]);
    checkSubjects(c, (json.matches as Obj).subjects);
    checkCalls(c, (json.matches as Obj).calls, (json.matches as Obj).subjects);
    const names = keys.some((k) => { const l = (json.matches as Obj)[k]; return Array.isArray(l) && l.length > 0 && l.every(isStr); });
    if (!names) c.add("matches", "at least one non-empty list of extensions, schemes, mcpServers or mcpTools", json.matches, "Name something to handle, such as { \"extensions\": [\".notes.json\"] }.");
  }

  const run = json.run;
  if (isObj(run)) {
    const keys = Object.keys(run);
    if (keys.length === 0) c.add("run", "an argv list or a map from platform to argv list", run, "Add at least one platform entry to run, or use one argv list for every platform.");
    for (const k of keys) checkArgv(c, `run.${k}`, run[k]);
  } else checkArgv(c, "run", run);

  if (json.credentials !== undefined) {
    if (!Array.isArray(json.credentials)) c.add("credentials", "a list of { name } objects", json.credentials, "Write credentials as a list such as [{ \"name\": \"api-key\" }], or an empty list.");
    else json.credentials.forEach((cr, i) => {
      if (!isObj(cr) || !isStr(cr.name)) c.add(`credentials[${i}].name`, "a non-empty string", isObj(cr) ? cr.name : cr, "Give each credential a name the user will recognise.");
    });
  }
  checkStringList(c, "platforms", json.platforms);
  if (json.requires !== undefined) {
    if (!isObj(json.requires)) c.add("requires", "an object listing apps, binaries and runtimes", json.requires, "Write requires as an object such as { \"binaries\": [\"git\"] }.");
    else for (const k of ["apps", "binaries", "runtimes"]) if (json.requires[k] !== undefined && !Array.isArray(json.requires[k])) c.add(`requires.${k}`, "a list", json.requires[k], `Write requires.${k} as a list.`);
  }
  if (isObj(json.requires) && json.requires.session !== undefined && json.requires.session !== "desktop") c.add("requires.session", "\"desktop\"", json.requires.session, "Write requires.session as \"desktop\" (needs a logged-in desktop session), or leave it out.");
  checkManifestExtras(c, json);
  return c.problems;
}

/** Default for the optional `beforeReadMs`: how long CoCheck waits for a connector to read the "before" state. */
export const DEFAULT_BEFORE_READ_MS = 1500;
export const MAX_BEFORE_READ_MS = 3000;
/** The before-read budget of a manifest that already passed checkManifest. */
export function beforeReadMsOf(manifest: unknown): number {
  const json: Obj = isObj(manifest) ? manifest : {};
  const ms = json.beforeReadMs;
  return typeof ms === "number" && Number.isInteger(ms) && ms >= 0 && ms <= MAX_BEFORE_READ_MS ? ms : DEFAULT_BEFORE_READ_MS;
}

/** The diff (or export) call timeout when a manifest sets no `diffMs`: the production capture timeout. */
export const DEFAULT_DIFF_MS = 10_000;
export const MAX_DIFF_MS = 60_000;
/** The `diffMs` of a manifest that already passed checkManifest, or undefined when it sets none (the caller's own default then applies). */
export function diffMsOf(manifest: unknown): number | undefined {
  const ms = isObj(manifest) ? manifest.diffMs : undefined;
  return typeof ms === "number" && Number.isInteger(ms) && ms >= 1 && ms <= MAX_DIFF_MS ? ms : undefined;
}

/** The variable names a manifest that passed checkManifest lists in `permissions.env` (these, and a fixed base, are the only variables a connector is started with). */
export function permittedEnvOf(manifest: unknown): string[] {
  const json: Obj = isObj(manifest) ? manifest : {};
  const v = json.permissions;
  const env = isObj(v) ? v.env : undefined;
  return Array.isArray(env) ? env.filter((n): n is string => typeof n === "string" && n !== "") : [];
}

// The v1 manifest additions. They are read with dotted access so that test/connector-spec-doc.test.ts, which reads `json.<name>` and `v.<name>` out of
// this file, requires public-kit/spec/README.md to name each one.
function checkManifestExtras(c: Collector, json: Obj): void {
  const ms = json.beforeReadMs;
  if (ms !== undefined && !(typeof ms === "number" && Number.isInteger(ms) && ms >= 0 && ms <= MAX_BEFORE_READ_MS)) {
    c.add("beforeReadMs", `a whole number of milliseconds, 0 to ${MAX_BEFORE_READ_MS}`, ms, `Set beforeReadMs to a whole number from 0 to ${MAX_BEFORE_READ_MS}, or leave it out for ${DEFAULT_BEFORE_READ_MS}.`);
  }
  const dms = json.diffMs;
  if (dms !== undefined && !(typeof dms === "number" && Number.isInteger(dms) && dms >= 1 && dms <= MAX_DIFF_MS)) {
    c.add("diffMs", `a whole number of milliseconds, 1 to ${MAX_DIFF_MS}`, dms, `Set diffMs to a whole number from 1 to ${MAX_DIFF_MS}, or leave it out for ${DEFAULT_DIFF_MS}.`);
  }
  // openInProduct and permissions.network/files are not part of v1: nothing enforces or draws them. A manifest that still says so is refused, so nobody believes they hold.
  if (json.openInProduct !== undefined) c.add("openInProduct", "no such field in v1 (CoCheck draws no link into the product)", "openInProduct", "Remove openInProduct from the manifest.");
  const perms = json.permissions;
  if (perms !== undefined) {
    if (!isObj(perms)) c.add("permissions", "an object with an optional env list", perms, "Write permissions as { \"env\": [\"API_BASE\"] }, or leave it out.");
    else {
      for (const k of ["network", "files"]) if (perms[k] !== undefined) c.add(`permissions.${k}`, "no such field in v1 (CoCheck does not restrict or grant it)", k, `Remove permissions.${k}: CoCheck does not enforce it. Only permissions.env (the variable names the connector may read) is part of v1.`);
      const val = perms.env;
      if (val !== undefined && !(Array.isArray(val) && val.every((s) => typeof s === "string"))) c.add("permissions.env", "a list of strings", val, "Write permissions.env as a list of variable names, or leave it out.");
    }
  }
}

/**
 * The answer to an `export({subject})` call (entry "export"): `{ text: string | null }`, the item's content as plain text; null means the item does not exist.
 * CoCheck stores the text of each side and its own text renderer draws the difference. The field is read with brackets (see checkManifestExtras).
 */
export function checkExportAnswer(json: unknown): Problem[] {
  const c = new Collector(ANSWER_FILE);
  if (!isObj(json)) {
    c.add("", "an object with a text", json, "Answer with an object such as { \"text\": \"...\" }.");
    return c.problems;
  }
  const text = json["text"];
  if (text !== null && typeof text !== "string") c.add("text", "a string (the item as plain text) or null when the item does not exist", text, "Put the item's content as plain text in text, or null when the item does not exist.");
  return c.problems;
}

/**
 * The answer to a `snapshot({subject})` call: `{ subject: string, state: string | null }`. `state` is the full current state as UTF-8 text; null means the
 * entity does not exist. Anything else (a missing subject, a number, an object as state) is a problem.
 */
export function checkSnapshotAnswer(json: unknown): Problem[] {
  const c = new Collector(ANSWER_FILE);
  if (!isObj(json)) {
    c.add("", "an object with a subject and a state", json, "Answer with an object such as { \"subject\": \"notion://page/abc\", \"state\": \"...\" }.");
    return c.problems;
  }
  if (!isStr(json.subject)) c.add("subject", "a non-empty string", json.subject, "Echo the subject you were asked about in subject.");
  if (json.state !== null && typeof json.state !== "string") c.add("state", "a string (the full state as text) or null when the entity does not exist", json.state, "Put the full current state as text in state, or null when the entity does not exist.");
  return c.problems;
}
