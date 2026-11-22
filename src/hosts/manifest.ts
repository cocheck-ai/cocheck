// The harness manifest, `cocheck-harness.json` (schema "cocheck-harness/1"): everything CoCheck needs to know about an agent harness that is
// data (names, paths in the payload, tables, rules), in one JSON file. `compileManifest` (src/hosts/compile.ts) turns it into a HostProfile.
// A manifest holds no code. Behaviour that is not data is first-party code a manifest opts into by name (`extras`, src/hosts/extras.ts).
// The full field reference is "Harness manifest (v1)" in docs/hooks.md.
import { validateInstallBlock, type JsonInstallBlock } from "./install-block.ts";
import { knownExtra, outsiderSafeExtra } from "./extras.ts";
import type { EventKind, HostCapabilities, NarrationSource, PayloadFingerprint, PerActionEvents } from "./types.ts";
import type { ToolClass, ToolEntry, ToolTable } from "./tool-classes.ts";

export const MANIFEST_SCHEMA = "cocheck-harness/1";
export const MANIFEST_FILE = "cocheck-harness.json";

/** A place in the payload: `a.b`, `a[0].b`, `workspace_roots[0]`. */
export type PayloadPath = string;

/** What a failed call looks like in a payload. Which kind a rule is for is its key in `HarnessManifest.failure`. */
export interface FailureRule {
  /** tool-post: the call failed when any of these paths holds `true`. */
  flags?: PayloadPath[];
  /** The failure's own words: the first of these paths that holds text. */
  text?: PayloadPath[];
  /** tool-post: the call failed when `text` gives words that are not empty (a host whose Post carries an error field that is empty on success). */
  nonEmpty?: true;
  /** Where the words are when `text` gave none (or empty text) and a `flags` path holds `true`: the first entry that reads as text. An entry with `blocks` may also be a list of `{ "text": ... }` blocks, whose texts are joined by a line break. */
  flaggedText?: Array<PayloadPath | { path: PayloadPath; blocks?: true }>;
  /** `true` at this path marks the call as interrupted. */
  interrupt?: PayloadPath;
  /** tool-post: the failure is a nonzero exit code that the text at `from` states; `pattern` has one group holding the code, and the last match wins. */
  exitCode?: { from: PayloadPath; pattern: string };
  /** The failure was read from output text, not sent by the host: a guess, never proof that other calls succeeded. */
  inferred?: true;
}

/** Changes an event's kind from the one its name maps to; every given condition must hold. */
export interface RefineRule {
  kinds: EventKind[];
  becomes: EventKind;
  /** Holds when the text at this path is not empty. */
  whenPresent?: PayloadPath;
  /** Holds when the trimmed text at `path` matches `pattern` (a regular expression). */
  whenMatches?: { path: PayloadPath; pattern: string };
}

export interface ManifestFields {
  /** Required: the session id. */
  session: PayloadPath;
  eventName?: PayloadPath;
  cwd?: PayloadPath;
  toolName?: PayloadPath;
  toolInput?: PayloadPath;
  toolResponse?: PayloadPath;
  agentId?: PayloadPath;
  agentType?: PayloadPath;
  transcriptPath?: PayloadPath;
  lastAssistantMessage?: PayloadPath;
  prompt?: PayloadPath;
  /** A helper's events carry the main session's id here. */
  parentSession?: PayloadPath;
  /** The per-call reason the host's tool input carries: a key of the tool input. */
  callReason?: string;
}

export interface ManifestArgvTag {
  tool: string;
  /** The Pre hook's stdout for a rewritten call: JSON with the string "{event}" and the string "{input}" (the whole rewritten input) where they go. */
  preOutput: unknown;
  envFileVar: string;
  shellEnv: string;
  sessionStartEvent: string;
}

export interface ManifestInstall extends Partial<JsonInstallBlock> {
  skillRoot: string;
  hostFlag: string;
  projectDirEnv?: string;
  folderFromPayloadCwd?: boolean;
  promptContext?: false;
  ownsFile?: true;
  inBothAlias?: true;
  reusesRecord?: true;
  timingLabel?: string;
  afterInstall?: string;
  /** A note printed after install; "{launcherDir}" and "{home}" are filled in. */
  notes?: string;
  /** The payload a hook check sends, in the host's own shape; "{folder}" in a string is the task folder. */
  checkPayload: { payload: Record<string, unknown>; event?: string };
  /** A first-party editor extra for a config that is not JSON; then the JSON block's own keys are left out and `events` lists the hook events. */
  editorExtra?: string;
  /** With `editorExtra`: the hook events CoCheck installs. */
  events?: string[];
}

export interface HarnessManifest {
  schema: typeof MANIFEST_SCHEMA;
  // identity
  key: string;
  displayName: string;
  fullName?: string;
  chip: string;
  testedVersions?: string[];
  // events
  /** The host's event names mapped to CoCheck's kinds. */
  events: Record<string, EventKind>;
  /** Where the event name comes from: a payload path, or the `--event` argument of the hook command. */
  eventFrom: { payload: PayloadPath } | { arg: "--event" };
  unverifiedEvents?: string[];
  // call fields
  fields: ManifestFields;
  /** "json-text": the tool input arrives as JSON text. Default "object". */
  toolInputEncoding?: "object" | "json-text";
  /** The call id: a payload path, or made up per session when the host sends none. Omitted: no id. */
  callId?: { payload?: PayloadPath; synthesized?: true };
  /** Host fields the record keeps but CoCheck does not act on. */
  extraFields?: { turnId?: PayloadPath; permissionMode?: PayloadPath; model?: PayloadPath; stopHookActive?: PayloadPath };
  failure?: { "tool-failure"?: FailureRule; "tool-post"?: FailureRule };
  refine?: RefineRule[];
  /** A tool name that carries a prefix: the prefix (a regular expression matched at the start of the name) is taken off. */
  toolNameStrip?: { prefix: string };
  toolClasses: ToolTable;
  narration?: { sources?: NarrationSource[]; closingWaitMs?: number };
  /** Where the host's session file is, from the session id alone. `defaultRoot` and `file` are path templates ({home}, {env:NAME|fallback}; `file` also {root} and {session}). */
  sessionFile?: { bySessionId?: boolean; defaultRoot?: string; file?: string };
  capabilities?: Partial<HostCapabilities>;
  foreignHookFingerprint?: PayloadFingerprint;
  readsConfigsOf?: string[];
  argvTag?: ManifestArgvTag;
  sessionEnv?: string;
  perAction?: PerActionEvents;
  hostOwnedFiles?: string[];
  hostOwnedWhat?: string;
  install?: ManifestInstall;
  /** First-party code this manifest opts into, by name (src/hosts/extras.ts). */
  extras?: string[];
  shape?: Record<string, string[]>;
}

const KINDS: Record<EventKind, true> = { "tool-pre": true, "tool-post": true, "tool-failure": true, stop: true, "subagent-stop": true, prompt: true, "file-edit": true, "shell-pre": true, "shell-post": true, "session-start": true, "session-end": true, other: true };
const CLASSES: Record<ToolClass, true> = { write: true, edit: true, "notebook-edit": true, patch: true, shell: true, launcher: true, wait: true, read: true, "read-only": true, "never-credited": true };
const CAPS: Record<keyof HostCapabilities, true> = { failureEvent: true, argvTag: true, helperSessions: true, launchKey: true, readsForeignHooks: true };
const PATH = /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*|\[\d+\])*$/;
export const KEY = /^[a-z][a-z0-9-]{0,31}$/;
/** Install members that are the manifest's own; the rest of `install` is the JSON install block. */
export const INSTALL_OWN = ["skillRoot", "hostFlag", "projectDirEnv", "folderFromPayloadCwd", "promptContext", "ownsFile", "inBothAlias", "reusesRecord", "timingLabel", "afterInstall", "checkPayload", "editorExtra", "notes"] as const;
const TOP = ["schema", "key", "displayName", "fullName", "chip", "testedVersions", "events", "eventFrom", "unverifiedEvents", "fields", "toolInputEncoding", "callId", "extraFields", "failure", "refine", "toolNameStrip", "toolClasses", "narration", "sessionFile", "capabilities", "foreignHookFingerprint", "readsConfigsOf", "argvTag", "sessionEnv", "perAction", "hostOwnedFiles", "hostOwnedWhat", "install", "extras", "shape"];

/** The longest pattern a manifest may hold, and the most text a compiled pattern is ever run against (see compile.ts). */
export const PATTERN_MAX = 200;
export const MATCH_INPUT_MAX = 4096;
/** A counted repeat `{n,m}` with `m` up to this is a bounded repeat. */
const BOUNDED_REPEAT_MAX = 4;

/**
 * Why a manifest pattern is refused, or undefined. A structural rule, not a list: too long, a backreference or lookaround, or a group that is repeated
 * and itself holds a repeat or an alternation (`(a+)+`, `(a|a)*`), which is where a regular expression can take exponential time.
 */
export function patternProblem(p: string, trusted = false): string | undefined {
  if (p.length > PATTERN_MAX) return `pattern longer than ${PATTERN_MAX} characters`;
  const stack: Array<{ repeats: boolean; alt: boolean }> = [];
  let unbounded = 0;
  let topAlt = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") {
      if (/[1-9k]/.test(p[i + 1] ?? "")) return "backreference not allowed";
      i++;
    } else if (c === "[") {
      for (i++; i < p.length && p[i] !== "]"; i++) if (p[i] === "\\") i++;
    } else if (c === "(") {
      if (p[i + 1] === "?" && p[i + 2] !== ":") return "lookaround and named groups not allowed";
      stack.push({ repeats: false, alt: false });
    } else if (c === "|") {
      if (stack.length > 0) stack[stack.length - 1]!.alt = true;
      else topAlt = true;
    } else if (c === ")") {
      const g = stack.pop();
      const next = p[i + 1];
      const repeated = next === "*" || next === "+" || next === "{";
      if (g !== undefined && repeated && (g.repeats || g.alt)) return "nested repetition not allowed";
      if (g !== undefined && stack.length > 0 && (repeated || next === "?" || g.repeats)) stack[stack.length - 1]!.repeats = true;
    } else if ((c === "*" || c === "+" || c === "?" || c === "{") && stack.length > 0) {
      stack[stack.length - 1]!.repeats = true;
    }
    if (c === "*" || c === "+") unbounded++;
    else if (c === "{") {
      // A counted repeat is unbounded for this rule when it has no upper bound or one above BOUNDED_REPEAT_MAX.
      const q = /^\{(\d+)(?:(,)(\d*))?\}/.exec(p.slice(i));
      if (q !== null && (Number(q[3] === undefined || q[3] === "" ? (q[2] === undefined ? q[1] : Infinity) : q[3]) > BOUNDED_REPEAT_MAX)) unbounded++;
    }
  }
  // The cost claim: run on at most MATCH_INPUT_MAX characters, a pattern with this many unbounded repeats takes about n^2 steps at worst (n starting
  // places times one scan; a pattern that starts with ^ has one starting place, so a second scan costs n^2 as well). More repeats nest and cost n^3 and up.
  const limit = p.startsWith("^") && !topAlt ? 2 : 1;
  // A manifest that ships with CoCheck is reviewed code and is exempt from this count (its patterns run on whole inputs, as they always did).
  if (!trusted && unbounded > limit) return `too many unbounded repeats (at most ${limit} here; ${limit === 1 ? "start the pattern with ^ for 2" : "a counted repeat with an upper bound of 4 or less does not count"})`;
  return undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Checks a parsed manifest. `label` names the file in every error (`myagent/cocheck-harness.json`). Throws an Error naming the field. */
export function validateManifest(v: unknown, label: string, opts: { outsider?: boolean; builtIn?: boolean } = {}): HarnessManifest {
  const bad = (field: string, what: string): never => {
    throw new Error(`${label}: ${field}: ${what}`);
  };
  const obj = (x: unknown, field: string): Record<string, unknown> => (isObject(x) ? x : bad(field, "expected an object"));
  const str = (x: unknown, field: string): string => (typeof x === "string" && x !== "" ? x : bad(field, "expected a non-empty string"));
  const strs = (x: unknown, field: string): string[] => (Array.isArray(x) && x.every((s) => typeof s === "string") ? (x as string[]) : bad(field, "expected a list of strings"));
  const path = (x: unknown, field: string): string => {
    const s = str(x, field);
    return PATH.test(s) ? s : bad(field, `not a payload path: ${JSON.stringify(s)} (write a.b or a[0].b)`);
  };
  const regex = (x: unknown, field: string): string => {
    const s = str(x, field);
    try {
      new RegExp(s);
    } catch {
      bad(field, `not a regular expression: ${JSON.stringify(s)}`);
    }
    const why = patternProblem(s, opts.builtIn === true);
    if (why !== undefined) bad(field, `${why}: ${JSON.stringify(s)}`);
    return s;
  };
  const kind = (x: unknown, field: string): EventKind => (typeof x === "string" && Object.hasOwn(KINDS, x) ? (x as EventKind) : bad(field, `unknown kind ${JSON.stringify(x)}`));
  const only = (o: Record<string, unknown>, allowed: readonly string[], field: string): void => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(field === "" ? k : `${field}.${k}`, "unknown field");
  };
  const bool = (x: unknown, field: string): boolean => (typeof x === "boolean" ? x : bad(field, "expected true or false"));

  const m = obj(v, "(manifest)");
  only(m, TOP, "");
  if (m.schema !== MANIFEST_SCHEMA) bad("schema", `expected ${JSON.stringify(MANIFEST_SCHEMA)}, got ${JSON.stringify(m.schema)}`);
  const key = str(m.key, "key");
  if (!KEY.test(key)) bad("key", `${JSON.stringify(key)} is not a lowercase key (letters, digits and dashes, at most 32)`);
  str(m.displayName, "displayName");
  if (m.fullName !== undefined) str(m.fullName, "fullName");
  str(m.chip, "chip");
  if (m.testedVersions !== undefined) strs(m.testedVersions, "testedVersions");

  const events = obj(m.events, "events");
  if (Object.keys(events).length === 0) bad("events", "expected at least one event");
  for (const [name, k] of Object.entries(events)) kind(k, `events.${name}`);
  const from = obj(m.eventFrom, "eventFrom");
  if ("payload" in from) path(from.payload, "eventFrom.payload");
  else if (from.arg !== "--event") bad("eventFrom", 'expected {"payload": <path>} or {"arg": "--event"}');
  if (m.unverifiedEvents !== undefined) strs(m.unverifiedEvents, "unverifiedEvents");

  const fields = obj(m.fields, "fields");
  only(fields, ["session", "eventName", "cwd", "toolName", "toolInput", "toolResponse", "agentId", "agentType", "transcriptPath", "lastAssistantMessage", "prompt", "parentSession", "callReason"], "fields");
  path(fields.session, "fields.session");
  for (const [k, x] of Object.entries(fields)) if (k !== "session" && k !== "callReason") path(x, `fields.${k}`);
  if (fields.callReason !== undefined) str(fields.callReason, "fields.callReason");
  if (m.toolInputEncoding !== undefined && m.toolInputEncoding !== "object" && m.toolInputEncoding !== "json-text") bad("toolInputEncoding", 'expected "object" or "json-text"');
  if (m.callId !== undefined) {
    const c = obj(m.callId, "callId");
    only(c, ["payload", "synthesized"], "callId");
    if (c.payload !== undefined) path(c.payload, "callId.payload");
    if (c.synthesized !== undefined && c.synthesized !== true) bad("callId.synthesized", "expected true");
    if (c.payload === undefined && c.synthesized === undefined) bad("callId", 'expected {"payload": <path>}, {"synthesized": true} or both (the host\'s id when it sends one, else made up)');
  }
  if (m.extraFields !== undefined) {
    const e = obj(m.extraFields, "extraFields");
    only(e, ["turnId", "permissionMode", "model", "stopHookActive"], "extraFields");
    for (const [k, x] of Object.entries(e)) path(x, `extraFields.${k}`);
  }
  if (m.failure !== undefined) {
    const f = obj(m.failure, "failure");
    only(f, ["tool-failure", "tool-post"], "failure");
    for (const [k, rule] of Object.entries(f)) {
      const r = obj(rule, `failure.${k}`);
      only(r, ["flags", "text", "nonEmpty", "flaggedText", "interrupt", "exitCode", "inferred"], `failure.${k}`);
      for (const list of ["flags", "text"] as const) if (r[list] !== undefined) (Array.isArray(r[list]) ? (r[list] as unknown[]) : bad(`failure.${k}.${list}`, "expected a list of paths")).forEach((p, i) => path(p, `failure.${k}.${list}[${i}]`));
      if (r.flaggedText !== undefined) {
        (Array.isArray(r.flaggedText) ? (r.flaggedText as unknown[]) : bad(`failure.${k}.flaggedText`, "expected a list")).forEach((e, i) => {
          if (typeof e === "string") path(e, `failure.${k}.flaggedText[${i}]`);
          else {
            const o = obj(e, `failure.${k}.flaggedText[${i}]`);
            only(o, ["path", "blocks"], `failure.${k}.flaggedText[${i}]`);
            path(o.path, `failure.${k}.flaggedText[${i}].path`);
            if (o.blocks !== undefined && o.blocks !== true) bad(`failure.${k}.flaggedText[${i}].blocks`, "expected true");
          }
        });
      }
      if (r.interrupt !== undefined) path(r.interrupt, `failure.${k}.interrupt`);
      if (r.exitCode !== undefined) {
        const x = obj(r.exitCode, `failure.${k}.exitCode`);
        path(x.from, `failure.${k}.exitCode.from`);
        regex(x.pattern, `failure.${k}.exitCode.pattern`);
      }
      if (r.inferred !== undefined && r.inferred !== true) bad(`failure.${k}.inferred`, "expected true");
      if (r.nonEmpty !== undefined) {
        if (r.nonEmpty !== true) bad(`failure.${k}.nonEmpty`, "expected true");
        if (k !== "tool-post") bad(`failure.${k}.nonEmpty`, "only a tool-post rule decides whether a call failed (a tool-failure event is a failure already)");
        if (!Array.isArray(r.text) || r.text.length === 0) bad(`failure.${k}.nonEmpty`, "needs text: the paths whose words mean the call failed");
      }
    }
  }
  if (m.refine !== undefined) {
    (Array.isArray(m.refine) ? m.refine : bad("refine", "expected a list")).forEach((rule: unknown, i: number) => {
      const r = obj(rule, `refine[${i}]`);
      only(r, ["kinds", "becomes", "whenPresent", "whenMatches"], `refine[${i}]`);
      (Array.isArray(r.kinds) && r.kinds.length > 0 ? r.kinds : bad(`refine[${i}].kinds`, "expected a list of kinds")).forEach((k: unknown, j: number) => kind(k, `refine[${i}].kinds[${j}]`));
      kind(r.becomes, `refine[${i}].becomes`);
      if (r.whenPresent === undefined && r.whenMatches === undefined) bad(`refine[${i}]`, "needs whenPresent or whenMatches");
      if (r.whenPresent !== undefined) path(r.whenPresent, `refine[${i}].whenPresent`);
      if (r.whenMatches !== undefined) {
        const w = obj(r.whenMatches, `refine[${i}].whenMatches`);
        path(w.path, `refine[${i}].whenMatches.path`);
        regex(w.pattern, `refine[${i}].whenMatches.pattern`);
      }
    });
  }
  if (m.toolNameStrip !== undefined) regex(obj(m.toolNameStrip, "toolNameStrip").prefix, "toolNameStrip.prefix");

  const classes = obj(m.toolClasses, "toolClasses");
  for (const [tool, entry] of Object.entries(classes)) {
    const e = obj(entry, `toolClasses.${tool}`);
    only(e, ["class", "dialect", "waitFlag", "anyCase", "pathFields", "pathChecked", "fileInput", "backgroundFlag", "resumesHelper", "backgroundable"], `toolClasses.${tool}`);
    if (typeof e.class !== "string" || !Object.hasOwn(CLASSES, e.class)) bad(`toolClasses.${tool}.class`, `unknown class ${JSON.stringify(e.class)}`);
    if (e.dialect !== undefined && e.dialect !== "bash" && e.dialect !== "powershell") bad(`toolClasses.${tool}.dialect`, 'expected "bash" or "powershell"');
    if (e.waitFlag !== undefined) str(e.waitFlag, `toolClasses.${tool}.waitFlag`);
    if (e.pathFields !== undefined) strs(e.pathFields, `toolClasses.${tool}.pathFields`);
    for (const flag of ["anyCase", "pathChecked", "fileInput", "backgroundFlag", "resumesHelper", "backgroundable"]) if (e[flag] !== undefined && e[flag] !== true) bad(`toolClasses.${tool}.${flag}`, "expected true");
  }

  if (m.narration !== undefined) {
    const n = obj(m.narration, "narration");
    only(n, ["sources", "closingWaitMs"], "narration");
    if (n.sources !== undefined) {
      (Array.isArray(n.sources) ? n.sources : bad("narration.sources", "expected a list")).forEach((s: unknown, i: number) => {
        const o = obj(s, `narration.sources[${i}]`);
        only(o, ["kind", "readableAt", "reason"], `narration.sources[${i}]`);
        if (o.kind !== "text-before-call" && o.kind !== "commentary-before-call" && o.kind !== "closing-message") bad(`narration.sources[${i}].kind`, `unknown source ${JSON.stringify(o.kind)}`);
        if (o.readableAt !== "pre" && o.readableAt !== "post") bad(`narration.sources[${i}].readableAt`, 'expected "pre" or "post"');
        if (o.reason !== undefined && o.reason !== true) bad(`narration.sources[${i}].reason`, "expected true");
      });
    }
    if (n.closingWaitMs !== undefined && (typeof n.closingWaitMs !== "number" || !(n.closingWaitMs >= 0))) bad("narration.closingWaitMs", "expected a number of ms");
  }
  if (m.sessionFile !== undefined) {
    const s = obj(m.sessionFile, "sessionFile");
    only(s, ["bySessionId", "defaultRoot", "file"], "sessionFile");
    if (s.bySessionId !== undefined) bool(s.bySessionId, "sessionFile.bySessionId");
    if (s.defaultRoot !== undefined) str(s.defaultRoot, "sessionFile.defaultRoot");
    if (s.file !== undefined) str(s.file, "sessionFile.file");
    if (s.bySessionId === true && s.file === undefined) bad("sessionFile.file", "needed when bySessionId is true");
  }
  if (m.capabilities !== undefined) {
    const c = obj(m.capabilities, "capabilities");
    for (const [k, x] of Object.entries(c)) {
      if (!Object.hasOwn(CAPS, k)) bad(`capabilities.${k}`, "unknown capability");
      bool(x, `capabilities.${k}`);
    }
  }
  if (m.foreignHookFingerprint !== undefined) {
    const f = obj(m.foreignHookFingerprint, "foreignHookFingerprint");
    only(f, ["present", "strings", "absent"], "foreignHookFingerprint");
    for (const k of ["present", "strings", "absent"]) strs(f[k], `foreignHookFingerprint.${k}`);
  }
  if (m.readsConfigsOf !== undefined) strs(m.readsConfigsOf, "readsConfigsOf");
  if (m.argvTag !== undefined) {
    const a = obj(m.argvTag, "argvTag");
    only(a, ["tool", "preOutput", "envFileVar", "shellEnv", "sessionStartEvent"], "argvTag");
    for (const k of ["tool", "envFileVar", "shellEnv", "sessionStartEvent"]) str(a[k], `argvTag.${k}`);
    if (a.preOutput === undefined) bad("argvTag.preOutput", "missing");
  }
  if (m.sessionEnv !== undefined) str(m.sessionEnv, "sessionEnv");
  if (m.perAction !== undefined) {
    const p = obj(m.perAction, "perAction");
    only(p, ["fileEditTool", "shellTool", "fields"], "perAction");
    str(p.fileEditTool, "perAction.fileEditTool");
    str(p.shellTool, "perAction.shellTool");
    const f = obj(p.fields, "perAction.fields");
    only(f, ["editPath", "editList", "editContent", "command", "exitCode", "output"], "perAction.fields");
    str(f.editPath, "perAction.fields.editPath");
    str(f.command, "perAction.fields.command");
    for (const k of ["editList", "editContent", "exitCode", "output"]) if (f[k] !== undefined) str(f[k], `perAction.fields.${k}`);
    for (const tool of [p.fileEditTool, p.shellTool] as string[]) if (!Object.hasOwn(classes, tool)) bad("perAction", `the tool ${JSON.stringify(tool)} is not in toolClasses`);
  }
  if (m.hostOwnedFiles !== undefined) strs(m.hostOwnedFiles, "hostOwnedFiles");
  if (m.hostOwnedWhat !== undefined) str(m.hostOwnedWhat, "hostOwnedWhat");
  if (m.install !== undefined) {
    const inst = obj(m.install, "install");
    str(inst.skillRoot, "install.skillRoot");
    str(inst.hostFlag, "install.hostFlag");
    for (const k of ["projectDirEnv", "timingLabel", "afterInstall", "editorExtra", "notes"]) if (inst[k] !== undefined) str(inst[k], `install.${k}`);
    for (const k of ["folderFromPayloadCwd"]) if (inst[k] !== undefined) bool(inst[k], `install.${k}`);
    if (inst.promptContext !== undefined && inst.promptContext !== false) bad("install.promptContext", "expected false");
    for (const k of ["ownsFile", "inBothAlias", "reusesRecord"]) if (inst[k] !== undefined && inst[k] !== true) bad(`install.${k}`, "expected true");
    const check = obj(inst.checkPayload, "install.checkPayload");
    obj(check.payload, "install.checkPayload.payload");
    if (check.event !== undefined) str(check.event, "install.checkPayload.event");
    if (inst.editorExtra !== undefined) {
      if (!knownExtra(inst.editorExtra as string)) bad("install.editorExtra", `unknown extra ${JSON.stringify(inst.editorExtra)}`);
      if (opts.outsider === true && !outsiderSafeExtra(inst.editorExtra as string)) bad("install.editorExtra", `the extra ${JSON.stringify(inst.editorExtra)} is first-party code for built-in manifests; a manifest in your own folder cannot name it`);
      strs(inst.events, "install.events");
    } else {
      const block: Record<string, unknown> = Object.fromEntries(Object.entries(inst).filter(([k]) => !(INSTALL_OWN as readonly string[]).includes(k)));
      try {
        validateInstallBlock(block, "install");
      } catch (error) {
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (m.extras !== undefined) {
    strs(m.extras, "extras").forEach((name, i) => {
      if (!knownExtra(name)) bad(`extras[${i}]`, `unknown extra ${JSON.stringify(name)} (extras are first-party code; see docs/hooks.md)`);
      if (opts.outsider === true && !outsiderSafeExtra(name)) bad(`extras[${i}]`, `the extra ${JSON.stringify(name)} is first-party code for built-in manifests; a manifest in your own folder cannot name it`);
    });
  }
  if (m.shape !== undefined) for (const [k, x] of Object.entries(obj(m.shape, "shape"))) strs(x, `shape.${k}`);
  // A per-action kind needs perAction to read it.
  const perKinds = Object.entries(events).filter(([, k]) => k === "file-edit" || k === "shell-pre" || k === "shell-post");
  if (perKinds.length > 0 && m.perAction === undefined) bad(`events.${perKinds[0]![0]}`, `kind ${JSON.stringify(perKinds[0]![1])} needs "perAction"`);
  return m as unknown as HarnessManifest;
}

/** `ToolEntry` is what a manifest's `toolClasses` values are. */
export type ManifestToolEntry = ToolEntry;
