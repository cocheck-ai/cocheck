// A generic editor for a host's JSON hook config, driven by a declarative install block (data only). Claude Code and Copilot are two blocks;
// a host whose config is not JSON (Codex's TOML) keeps its own editor.
import path from "node:path";
import { platform, type Platform } from "../platform/index.ts";
import type { HostProfile } from "./types.ts";

/** Declarative description of a JSON hook config that CoCheck edits. Data only: no functions. */
export interface JsonInstallBlock {
  format: "json";
  /** Config file path template. Tokens: {home} (user home), {env:NAME} (env var, required), {env:NAME|fallback-template} (env var or fallback), {project} (the task folder: a workspace-scoped hook file). Forward slashes; joined with the platform separator. */
  path: string;
  /** "merge": edit the user's file, keeping everything else. "owned": the whole file is CoCheck's (uninstall deletes it when it carries the marker). */
  mode: "merge" | "owned";
  /** Top-level key holding the hooks object (Claude: "hooks"; Copilot: "hooks"). */
  rootKey: string;
  /** Extra top-level keys written in an owned or newly created file, e.g. {"version": 1}. */
  envelope?: Record<string, unknown>;
  /** Event names CoCheck installs. */
  events: string[];
  /** Entry written per event. String values may use {command} (the hook command for this event), {event} (the event name). */
  entryTemplate: unknown;
  /** Added: per-event entries for a host whose config takes a different entry shape for some events (grouped for some, flat for others). An event listed here uses its own template; every other event uses `entryTemplate`. */
  entryTemplates?: Record<string, unknown>;
  /** Events whose entry carries a matcher field and its value. Omitted: entryTemplate as is. */
  matcherEvents?: Record<string, string>;
  /** The hook command names its event as an argument (Copilot `--event <name>`). */
  eventInCommand?: boolean;
  /** Events whose hook must exit 0 even when CoCheck fails (fail-open). */
  failOpenEvents?: string[];
  /** Key holding the Windows variant of the command inside the entry, when the host wants one (Copilot "powershell" beside "bash"). */
  windowsCommandKey?: string;
  /** Added: events that are written on install and removed on uninstall but never reported by `missingEvents` (they record nothing). */
  extraEvents?: string[];
  /** Added: an entry is CoCheck's when its command parses (through the platform's hook command parser) as a command for this host. Absent: any command that carries CoCheck's marker. */
  managedHost?: string;
}

const fail = (where: string, field: string, want: string): never => {
  throw new Error(`${where}.${field}: expected ${want}`);
};
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, where: string, field: string): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail(where, field, "an array of strings");
  return v as string[];
};

/** The tokens a config path template may use: {home}, {project}, {env:NAME} and {env:NAME|fallback} (the fallback a template itself). */
export function pathTemplateProblem(template: string): string | undefined {
  for (let i = 0; i < template.length; i++) {
    if (template[i] === "}") return `unmatched "}" in ${template}`;
    if (template[i] !== "{") continue;
    let depth = 1;
    let j = i + 1;
    for (; j < template.length && depth > 0; j++) depth += template[j] === "{" ? 1 : template[j] === "}" ? -1 : 0;
    if (depth !== 0) return `unclosed "{" in ${template}`;
    const token = template.slice(i + 1, j - 1);
    i = j - 1;
    if (token === "home" || token === "project") continue;
    if (token.startsWith("env:")) {
      const body = token.slice(4);
      const bar = body.indexOf("|");
      const name = bar < 0 ? body : body.slice(0, bar);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `{env:${name}} does not name an environment variable`;
      if (bar >= 0) {
        const inner = pathTemplateProblem(body.slice(bar + 1));
        if (inner !== undefined) return inner;
      }
      continue;
    }
    return `token {${token}} is not available for a config file (use {home}, {project}, {env:NAME} or {env:NAME|fallback})`;
  }
  return undefined;
}

/** Checks an install block read from a manifest; throws an Error that names the offending field. */
export function validateInstallBlock(v: unknown, where: string): JsonInstallBlock {
  if (!isObj(v)) throw new Error(`${where}: expected an object`);
  if (v.format !== "json") fail(where, "format", `"json"`);
  if (typeof v.path !== "string" || v.path === "") fail(where, "path", "a string");
  const pathProblem = pathTemplateProblem(v.path as string);
  if (pathProblem !== undefined) throw new Error(`${where}.path: ${pathProblem}`);
  if (v.mode !== "merge" && v.mode !== "owned") fail(where, "mode", `"merge" or "owned"`);
  if (typeof v.rootKey !== "string" || v.rootKey === "") fail(where, "rootKey", "a string");
  if (v.envelope !== undefined && !isObj(v.envelope)) fail(where, "envelope", "an object");
  const events = strings(v.events, where, "events");
  if (events.length === 0) fail(where, "events", "at least one event");
  if (!isObj(v.entryTemplate)) fail(where, "entryTemplate", "an object");
  if (!JSON.stringify(v.entryTemplate).includes("{command}")) fail(where, "entryTemplate", "an object that uses {command}");
  if (v.entryTemplates !== undefined) {
    if (!isObj(v.entryTemplates)) fail(where, "entryTemplates", "an object of event name to entry");
    const written = new Set([...events, ...(Array.isArray(v.extraEvents) ? (v.extraEvents as unknown[]) : [])]);
    for (const [event, tpl] of Object.entries(v.entryTemplates as Record<string, unknown>)) {
      if (!written.has(event)) fail(where, `entryTemplates.${event}`, "an event listed in events or extraEvents");
      if (!isObj(tpl)) fail(where, `entryTemplates.${event}`, "an object");
      if (!JSON.stringify(tpl).includes("{command}")) fail(where, `entryTemplates.${event}`, "an object that uses {command}");
    }
  }
  if (v.matcherEvents !== undefined) {
    if (!isObj(v.matcherEvents) || !Object.values(v.matcherEvents).every((m) => typeof m === "string")) fail(where, "matcherEvents", "an object of strings");
  }
  if (v.eventInCommand !== undefined && typeof v.eventInCommand !== "boolean") fail(where, "eventInCommand", "a boolean");
  if (v.failOpenEvents !== undefined) strings(v.failOpenEvents, where, "failOpenEvents");
  if (v.windowsCommandKey !== undefined && (typeof v.windowsCommandKey !== "string" || v.windowsCommandKey === "")) fail(where, "windowsCommandKey", "a string");
  if (v.extraEvents !== undefined) strings(v.extraEvents, where, "extraEvents");
  if (v.managedHost !== undefined && typeof v.managedHost !== "string") fail(where, "managedHost", "a string");
  return v as unknown as JsonInstallBlock;
}

/** The text a settings file is refused with: the file is left as it was. */
class ConfigRefusal extends Error {}

type Json = Record<string, any>;

/** Resolves a path template. `{env:NAME|fallback}` may nest tokens in the fallback; an empty variable counts as unset. `project`: the task folder, for {project}. */
function resolvePath(template: string, env: NodeJS.ProcessEnv, userHome: string, project: string | undefined): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== "{") {
      out += template[i];
      continue;
    }
    let depth = 1;
    let j = i + 1;
    for (; j < template.length && depth > 0; j++) depth += template[j] === "{" ? 1 : template[j] === "}" ? -1 : 0;
    if (depth !== 0) throw new Error(`install.path: unclosed "{" in ${template}`);
    const token = template.slice(i + 1, j - 1);
    i = j - 1;
    if (token === "home") out += userHome;
    else if (token === "project") {
      if (project === undefined || project === "") throw new Error(`install.path: {project} needs the task folder (give --folder, or run from the folder)`);
      out += project;
    } else if (token.startsWith("env:")) {
      const body = token.slice(4);
      const bar = body.indexOf("|");
      const name = bar < 0 ? body : body.slice(0, bar);
      const value = env[name];
      if (value) out += value;
      else if (bar >= 0) out += resolvePath(body.slice(bar + 1), env, userHome, project);
      else throw new Error(`install.path: environment variable ${name} is not set`);
    } else throw new Error(`install.path: token {${token}} is not available for a config file`);
  }
  return out;
}

const substitute = (v: unknown, command: string, event: string): unknown => {
  if (typeof v === "string") return v.split("{command}").join(command).split("{event}").join(event);
  if (Array.isArray(v)) return v.map((x) => substitute(x, command, event));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, command, event)]));
  return v;
};

/** The keys of a template object that hold the command, wherever they sit in the entry. */
function commandKeysOf(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => commandKeysOf(x, out));
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" && x.includes("{command}")) out.add(k);
      else commandKeysOf(x, out);
    }
  }
  return out;
}

/** The editor for a JSON hook config described by `block`: the same members a host profile's `install` has. */
export function jsonHookEditor(block: JsonInstallBlock): Pick<NonNullable<HostProfile["install"]>, "configFile" | "addHooks" | "removeHooks" | "missingEvents"> {
  const root = block.rootKey;
  const template = block.entryTemplate as Json;
  const perEvent = (block.entryTemplates ?? {}) as Record<string, Json>;
  /** The entry template of an event: its own from `entryTemplates`, else `entryTemplate`. */
  const templateOf = (event: string): Json => (Object.hasOwn(perEvent, event) ? perEvent[event]! : template);
  const commandKeys = new Set<string>();
  for (const t of [template, ...Object.values(perEvent)]) commandKeysOf(t, commandKeys);
  if (block.windowsCommandKey !== undefined) commandKeys.add(block.windowsCommandKey);
  // A merge-mode entry that nests its commands under an array key (a group of hooks) is removed command by command. Each event's own
  // template decides; an event CoCheck no longer writes is read by `entryTemplate`.
  const nestKeyOf = (event: string): string | undefined => {
    const t = templateOf(event);
    return Object.keys(t).find((k) => Array.isArray(t[k]));
  };
  const writeEvents = [...block.events, ...(block.extraEvents ?? [])];

  const isOurs = (cmd: unknown, plat: Platform): boolean => {
    if (typeof cmd !== "string") return false;
    if (block.managedHost !== undefined) return plat.hookCommand.parse(cmd)?.host === block.managedHost;
    return plat.hookCommand.isMarked(cmd) || platform().hookCommand.isMarked(cmd);
  };
  const flatEntryIsOurs = (e: any, plat: Platform): boolean => [...commandKeys].some((k) => isOurs(e?.[k], plat));
  const groupHasOurs = (g: any, nestKey: string | undefined, plat: Platform): boolean => nestKey !== undefined && Array.isArray(g?.[nestKey]) && g[nestKey].some((h: any) => [...commandKeys].some((k) => isOurs(h?.[k], plat)));
  const nestedIsOurs = (h: any, plat: Platform): boolean => [...commandKeys].some((k) => isOurs(h?.[k], plat));

  const entryFor = (event: string, base: string, plat: Platform): unknown => {
    const windows = plat.shellDialect.kind === "cmd";
    let command = base;
    if (block.eventInCommand) command += ` --event ${event}`;
    if (block.failOpenEvents?.includes(event)) command += windows ? "; exit 0" : " || true";
    let tpl: Json = templateOf(event);
    if (windows && block.windowsCommandKey !== undefined) {
      tpl = Object.fromEntries(Object.entries(tpl).map(([k, v]) => [v === "{command}" ? block.windowsCommandKey! : k, v]));
    }
    const entry = substitute(tpl, command, event) as Json;
    const matcher = block.matcherEvents?.[event];
    return matcher === undefined ? entry : { matcher, ...entry };
  };

  /** Strict read of a merge-mode file: an empty file is an empty object; anything else that is not a settings object with sane hooks is refused untouched. */
  const parseMerge = (text: string, file: string): Json => {
    if (text.trim() === "") return {};
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ConfigRefusal(`${file} is not valid JSON; nothing was changed`);
    }
    if (!isObj(value)) throw new ConfigRefusal(`${file} is not a JSON object; nothing was changed`);
    const hooks = value[root];
    if (hooks !== undefined) {
      if (!isObj(hooks)) throw new ConfigRefusal(`${file}: "${root}" is not an object; nothing was changed`);
      for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) throw new ConfigRefusal(`${file}: ${root}.${event} is not an array; nothing was changed`);
      }
    }
    return value;
  };

  /** Lenient read of an owned file: anything that is not a JSON object has no entries of ours. */
  const parseOwned = (text: string): Json | undefined => {
    try {
      const v = JSON.parse(text);
      return isObj(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };

  const ownedEvents = (text: string, plat: Platform): string[] => {
    const hooks = parseOwned(text)?.[root];
    if (hooks === undefined || hooks === null || typeof hooks !== "object") return [];
    return Object.entries(hooks).filter(([, list]) => Array.isArray(list) && list.some((e) => flatEntryIsOurs(e, plat))).map(([event]) => event);
  };

  /** Removes every CoCheck entry. Groups, events and the root key that this empties are dropped; ones the user left empty are not touched. */
  const removeManaged = (settings: Json, plat: Platform): boolean => {
    const hooks = settings[root];
    if (hooks === undefined) return false;
    let removed = false;
    for (const event of Object.keys(hooks)) {
      const kept: any[] = [];
      let touched = false;
      const nestKey = nestKeyOf(event);
      for (const group of hooks[event]) {
        if (nestKey === undefined) {
          if (flatEntryIsOurs(group, plat)) removed = touched = true;
          else kept.push(group);
          continue;
        }
        if (!groupHasOurs(group, nestKey, plat)) {
          kept.push(group);
          continue;
        }
        removed = touched = true;
        const rest = group[nestKey].filter((h: any) => !nestedIsOurs(h, plat));
        if (rest.length > 0) kept.push({ ...group, [nestKey]: rest });
      }
      if (touched) {
        if (kept.length === 0) delete hooks[event];
        else hooks[event] = kept;
      }
    }
    if (removed && Object.keys(hooks).length === 0) delete settings[root];
    return removed;
  };

  const hasManaged = (settings: Json, event: string, plat: Platform): boolean =>
    Array.isArray(settings[root]?.[event]) && settings[root][event].some((g: any) => {
      const nestKey = nestKeyOf(event);
      return nestKey === undefined ? flatEntryIsOurs(g, plat) : groupHasOurs(g, nestKey, plat);
    });

  const text = (v: Json) => JSON.stringify(v, null, 2) + "\n";

  return {
    configFile: (env, userHome, project) => path.join(resolvePath(block.path, env, userHome, project)),
    addHooks: (current, file, spec, plat = platform()) => {
      const base = spec === undefined ? "" : plat.hookCommand.build(spec);
      if (block.mode === "owned") {
        const hooks: Record<string, unknown[]> = {};
        for (const event of writeEvents) hooks[event] = [entryFor(event, base, plat)];
        return text({ ...(block.envelope ?? {}), [root]: hooks });
      }
      const isNew = current.trim() === "";
      const settings = parseMerge(current, file);
      // A new (or empty) file gets the envelope; an existing file keeps its own keys and gets none added.
      if (isNew) for (const [k, v] of Object.entries(block.envelope ?? {})) settings[k] ??= v;
      removeManaged(settings, plat);
      settings[root] ??= {};
      for (const event of writeEvents) (settings[root][event] ??= []).push(entryFor(event, base, plat));
      return text(settings);
    },
    removeHooks: (current, file, plat = platform()) => {
      if (block.mode === "owned") return ownedEvents(current, plat).length > 0 ? { text: "", changed: true } : { text: current, changed: false };
      const settings = parseMerge(current, file);
      const changed = removeManaged(settings, plat);
      return { text: changed ? text(settings) : current, changed };
    },
    missingEvents: (current, file, plat = platform()) => {
      if (block.mode === "owned") {
        const have = new Set(ownedEvents(current, plat));
        return block.events.filter((e) => !have.has(e));
      }
      const settings = parseMerge(current, file);
      return block.events.filter((e) => !hasManaged(settings, e, plat));
    },
  };
}
