import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { platform, platformFor, type Platform } from "../src/platform/index.ts";
import { profileOf } from "../src/hosts/index.ts";
const claude = profileOf("claude");
const copilot = profileOf("copilot");
import { jsonHookEditor, validateInstallBlock, type JsonInstallBlock } from "../src/hosts/install-block.ts";
import { SHARED_EVENT_KINDS } from "../src/hosts/types.ts";

// The editors the hosts had before the install block existed, kept here as they were. The generic editor must give the same bytes and the same
// errors for every starting file, on both platform variants.
type Json = Record<string, any>;
class SettingsRefusal extends Error {}
function oldParseSettings(text: string, file: string): Json {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SettingsRefusal(`${file} is not valid JSON; nothing was changed`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SettingsRefusal(`${file} is not a JSON object; nothing was changed`);
  const hooks = (value as Json).hooks;
  if (hooks !== undefined) {
    if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) throw new SettingsRefusal(`${file}: "hooks" is not an object; nothing was changed`);
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) throw new SettingsRefusal(`${file}: hooks.${event} is not an array; nothing was changed`);
    }
  }
  return value as Json;
}
const WITH_MATCHER = new Set<string>(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const isManaged = (hook: any, plat: Platform) => typeof hook?.command === "string" && plat.hookCommand.parse(hook.command)?.host === "claude";
function removeManaged(settings: Json, plat: Platform): boolean {
  const hooks = settings.hooks;
  if (hooks === undefined) return false;
  let removed = false;
  for (const event of Object.keys(hooks)) {
    const kept: any[] = [];
    let touched = false;
    for (const group of hooks[event]) {
      if (!Array.isArray(group?.hooks) || !group.hooks.some((h: any) => isManaged(h, plat))) {
        kept.push(group);
        continue;
      }
      removed = touched = true;
      const rest = group.hooks.filter((h: any) => !isManaged(h, plat));
      if (rest.length > 0) kept.push({ ...group, hooks: rest });
    }
    if (touched) {
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
  }
  if (removed && Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}
function addManaged(settings: Json, command: string): void {
  settings.hooks ??= {};
  for (const event of [...Object.keys(SHARED_EVENT_KINDS), "SessionStart"]) {
    const group: Json = WITH_MATCHER.has(event) ? { matcher: "*" } : {};
    group.hooks = [{ type: "command", command }];
    (settings.hooks[event] ??= []).push(group);
  }
}
const claudeText = (settings: Json) => JSON.stringify(settings, null, 2) + "\n";
const hasManaged = (settings: Json, event: string, plat: Platform) => Array.isArray(settings.hooks?.[event]) && settings.hooks[event].some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isManaged(h, plat)));
const OLD_CLAUDE = {
  configFile: (env: NodeJS.ProcessEnv, userHome: string) => path.join(env.CLAUDE_CONFIG_DIR || path.join(userHome, ".claude"), "settings.json"),
  addHooks(text: string, file: string, spec: any, plat: Platform) {
    const settings = oldParseSettings(text, file);
    removeManaged(settings, plat);
    addManaged(settings, spec === undefined ? "" : plat.hookCommand.build(spec));
    return claudeText(settings);
  },
  removeHooks(text: string, file: string, plat: Platform) {
    const settings = oldParseSettings(text, file);
    const changed = removeManaged(settings, plat);
    return { text: changed ? claudeText(settings) : text, changed };
  },
  missingEvents(text: string, file: string, plat: Platform) {
    const settings = oldParseSettings(text, file);
    return Object.keys(SHARED_EVENT_KINDS).filter((e) => !hasManaged(settings, e, plat));
  },
};

const copilotEvents = ["userPromptSubmitted", "preToolUse", "postToolUse", "postToolUseFailure", "agentStop", "subagentStop"];
const failOpen = (event: string) => (event === "preToolUse" ? " || true" : "");
function parseCop(text: string): any {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
const entryIsOurs = (e: any, plat: Platform): boolean => [e?.bash, e?.powershell].some((c) => typeof c === "string" && (plat.hookCommand.isMarked(c) || platform().hookCommand.isMarked(c)));
const eventsWithOurs = (text: string, plat: Platform): string[] => {
  const hooks = parseCop(text)?.hooks;
  if (hooks === undefined || hooks === null || typeof hooks !== "object") return [];
  return Object.entries(hooks).filter(([, list]) => Array.isArray(list) && list.some((e) => entryIsOurs(e, plat))).map(([event]) => event);
};
const OLD_COPILOT = {
  configFile: (env: NodeJS.ProcessEnv, userHome: string) => path.join(env.COPILOT_HOME || path.join(userHome, ".copilot"), "hooks", "cocheck.json"),
  addHooks(_text: string, _file: string, spec: any, plat: Platform) {
    const command = spec === undefined ? "" : plat.hookCommand.build(spec);
    const hooks: Record<string, unknown[]> = {};
    const windows = plat.shellDialect.kind === "cmd";
    for (const event of copilotEvents) {
      const line = `${command} --event ${event}${windows ? (event === "preToolUse" ? "; exit 0" : "") : failOpen(event)}`;
      hooks[event] = [windows ? { type: "command", powershell: line, timeoutSec: 30 } : { type: "command", bash: line, timeoutSec: 30 }];
    }
    return JSON.stringify({ version: 1, hooks }, null, 2) + "\n";
  },
  removeHooks: (text: string, _file: string, plat: Platform) => (eventsWithOurs(text, plat).length > 0 ? { text: "", changed: true } : { text, changed: false }),
  missingEvents(text: string, _file: string, plat: Platform) {
    const have = new Set(eventsWithOurs(text, plat));
    return copilotEvents.filter((e) => !have.has(e));
  },
};

const outcome = (f: () => unknown): unknown => {
  try {
    return { ok: f() };
  } catch (e) {
    return { threw: (e as Error).message };
  }
};

const PLATS: Array<[string, Platform]> = [["macOS", platformFor("darwin")], ["Windows", platformFor("win32")]];
const spec = (plat: Platform) => ({ dataHome: plat.name === "win32" ? "C:\\Data" : "/data/home", launcher: plat.name === "win32" ? "C:\\cc\\cocheck-hook.cmd" : "/cc/cocheck-hook", hookPath: plat.name === "win32" ? "C:\\cc\\hook.js" : "/cc/hook.js", host: "claude" });

/** The user's own hook, one that only mentions the marker text, an older CoCheck entry, and a CoCheck entry for the host. */
function claudeFiles(plat: Platform): Record<string, string> {
  const ours = plat.hookCommand.build(spec(plat));
  const oldOurs = plat.hookCommand.build({ ...spec(plat), launcher: spec(plat).launcher + ".old" });
  return {
    none: "",
    emptyObject: "{}",
    whitespaceOnly: "  \n",
    userHooksAndKeys: JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-lint" }] }], Notification: [{ hooks: [{ type: "command", command: "notify" }] }] }, env: { A: "1" } }, null, 2) + "\n",
    olderCoCheckEntry: JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: oldOurs }] }], Stop: [{ hooks: [{ type: "command", command: ours }] }] } }, null, 2) + "\n",
    someEventsOnly: JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: ours }] }], PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: ours }] }] } }, null, 2) + "\n",
    sharedGroupWithUser: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }, { type: "command", command: ours }] }] } }, null, 2) + "\n",
    markerTextInUsersOwnCommand: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo COCHECK_MANAGED=1" }] }] } }, null, 2) + "\n",
    otherHostEntryAndSuffixedOurs: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: plat.hookCommand.build({ ...spec(plat), host: "codex" }) }, { type: "command", command: ours + " --extra" }] }] } }, null, 2) + "\n",
    emptyUserGroupsKept: JSON.stringify({ hooks: { Stop: [], PreToolUse: [{ hooks: [] }] } }) + "\n",
    tabsAndOddFormatting: '{\n\t"b":1,\t"hooks":{"Stop":[{"hooks":[{"type":"command","command":"mine"}]}]}  }\n\n',
    compactOneLine: '{"hooks":{}}',
    notJson: "this is { not json",
    jsonArrayRoot: "[1, 2]",
    jsonNullRoot: "null",
    hooksNotObject: '{"hooks": []}',
    eventNotArray: '{"hooks": {"Stop": {}}}',
  };
}
function copilotFiles(plat: Platform): Record<string, string> {
  const ours = plat.hookCommand.build(spec(plat));
  const mk = (key: string, cmd: string) => JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", [key]: cmd + " --event preToolUse || true", timeoutSec: 30 }], agentStop: [{ type: "command", [key]: cmd + " --event agentStop", timeoutSec: 30 }] } }, null, 2) + "\n";
  return {
    none: "",
    emptyObject: "{}",
    ownedBash: mk("bash", ours),
    ownedPowershell: mk("powershell", ours),
    someEventsOnly: JSON.stringify({ version: 1, hooks: { postToolUse: [{ type: "command", bash: ours + " --event postToolUse" }] } }),
    notOurs: JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", bash: "my-own-hook" }] } }, null, 2) + "\n",
    markerTextOnlyInUsersFile: JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", bash: "echo COCHECK_MANAGED=1" }] } }),
    oddFormatting: "{\t\"hooks\":{\"agentStop\":[{\"bash\":\"" + ours.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + " --event agentStop\"}]}}\n\n",
    notJson: "nope {",
    jsonArrayRoot: "[]",
    hooksIsArray: '{"hooks": []}',
    hooksIsNull: '{"hooks": null}',
    nullEntries: '{"hooks": {"preToolUse": [null, 3]}}',
  };
}

type Editor = { configFile: Function; addHooks: Function; removeHooks: Function; missingEvents: Function };
function compare(label: string, oldEd: any, newEd: Editor, files: (p: Platform) => Record<string, string>) {
  for (const [pname, plat] of PLATS) {
    for (const [fname, text] of Object.entries(files(plat))) {
      const file = path.join("/home/u/cfg", "settings.json");
      const s = spec(plat);
      it(`${label} ${pname}: ${fname}`, () => {
        assert.deepEqual(outcome(() => newEd.addHooks(text, file, s, plat)), outcome(() => oldEd.addHooks(text, file, s, plat)), "add");
        assert.deepEqual(outcome(() => newEd.addHooks(text, file, undefined, plat)), outcome(() => oldEd.addHooks(text, file, undefined, plat)), "dry run");
        assert.deepEqual(outcome(() => newEd.removeHooks(text, file, plat)), outcome(() => oldEd.removeHooks(text, file, plat)), "remove");
        assert.deepEqual(outcome(() => newEd.missingEvents(text, file, plat)), outcome(() => oldEd.missingEvents(text, file, plat)), "missing");
        // The result of an add is itself a starting file: reinstall, uninstall and status on it must agree too.
        const added = outcome(() => oldEd.addHooks(text, file, s, plat)) as { ok?: string };
        if (added.ok !== undefined) {
          assert.deepEqual(outcome(() => newEd.addHooks(added.ok, file, s, plat)), outcome(() => oldEd.addHooks(added.ok, file, s, plat)), "re-add");
          assert.deepEqual(outcome(() => newEd.removeHooks(added.ok, file, plat)), outcome(() => oldEd.removeHooks(added.ok, file, plat)), "remove after add");
          assert.deepEqual(outcome(() => newEd.missingEvents(added.ok, file, plat)), outcome(() => oldEd.missingEvents(added.ok, file, plat)), "missing after add");
        }
      });
    }
  }
}

describe("generic JSON hook editor matches the editors it replaced", () => {
  // Dangerous direction 1 (a user's own hooks or formatting rewritten): userHooksAndKeys, sharedGroupWithUser, emptyUserGroupsKept, tabsAndOddFormatting,
  // markerTextInUsersOwnCommand, notJson, jsonArrayRoot, hooksNotObject, eventNotArray (refused untouched) and, for Copilot, notOurs.
  // Dangerous direction 2 (a CoCheck entry left behind, or a foreign one removed): olderCoCheckEntry, someEventsOnly, sharedGroupWithUser, ownedBash, ownedPowershell,
  // markerTextInUsersOwnCommand and markerTextOnlyInUsersFile (the marker text alone is not ours).
  compare("claude", OLD_CLAUDE, claude.install!, claudeFiles);
  compare("copilot", OLD_COPILOT, copilot.install!, copilotFiles);

  it("config file paths match for set, unset and empty environment variables", () => {
    for (const env of [{}, { CLAUDE_CONFIG_DIR: "/x/cfg" }, { CLAUDE_CONFIG_DIR: "" }, { CLAUDE_CONFIG_DIR: "/x/cfg/" }]) assert.equal(claude.install!.configFile(env, "/home/u"), OLD_CLAUDE.configFile(env, "/home/u"));
    for (const env of [{}, { COPILOT_HOME: "/x/cp" }, { COPILOT_HOME: "" }]) assert.equal(copilot.install!.configFile(env, "/home/u"), OLD_COPILOT.configFile(env, "/home/u"));
  });

  it("the profiles carry the generic editor's members", () => {
    assert.deepEqual(claude.install!.events, Object.keys(SHARED_EVENT_KINDS));
    assert.deepEqual(copilot.install!.events, copilotEvents);
  });
});

describe("install block validation and path templates", () => {
  const good: JsonInstallBlock = { format: "json", path: "{home}/.x/hooks.json", mode: "owned", rootKey: "hooks", events: ["a"], entryTemplate: { command: "{command}" } };
  it("accepts a minimal block and names the field of a bad one", () => {
    assert.deepEqual(validateInstallBlock(good, "install"), good);
    assert.throws(() => validateInstallBlock({ ...good, path: 3 }, "install"), /install\.path: expected a string/);
    assert.throws(() => validateInstallBlock({ ...good, mode: "x" }, "install"), /install\.mode/);
    assert.throws(() => validateInstallBlock({ ...good, events: "a" }, "install"), /install\.events: expected an array of strings/);
    assert.throws(() => validateInstallBlock({ ...good, entryTemplate: { a: 1 } }, "install"), /install\.entryTemplate/);
    assert.throws(() => validateInstallBlock({ ...good, matcherEvents: { a: 1 } }, "install"), /install\.matcherEvents/);
    assert.throws(() => validateInstallBlock(null, "install"), /install: expected an object/);
  });
  it("resolves {home}, {env:NAME} and {env:NAME|fallback}", () => {
    const at = (p: string, env: NodeJS.ProcessEnv) => jsonHookEditor({ ...good, path: p }).configFile(env, "/h");
    assert.equal(at("{home}/a.json", {}), path.join("/h", "a.json"));
    assert.equal(at("{env:X}/a.json", { X: "/x" }), path.join("/x", "a.json"));
    assert.throws(() => at("{env:X}/a.json", {}), /install\.path: environment variable X is not set/);
    assert.equal(at("{env:X|{home}/.d}/a.json", {}), path.join("/h", ".d", "a.json"));
    assert.equal(at("{env:X|{home}/.d}/a.json", { X: "/x" }), path.join("/x", "a.json"));
    assert.throws(() => at("{project}/a.json", {}), /install\.path: \{project\} needs the task folder/);
  });
  it("resolves {project} to the task folder, and checks every token when the block is validated", () => {
    const editor = jsonHookEditor({ ...good, path: "{project}/.agent/hooks.json" });
    assert.equal(editor.configFile({}, "/h", "/w/proj"), path.join("/w/proj", ".agent", "hooks.json"));
    assert.equal(jsonHookEditor({ ...good, path: "{env:X|{project}/.d}/a.json" }).configFile({}, "/h", "/p"), path.join("/p", ".d", "a.json"));
    assert.deepEqual(validateInstallBlock({ ...good, path: "{project}/.cursor/hooks.json" }, "install").path, "{project}/.cursor/hooks.json");
    assert.throws(() => validateInstallBlock({ ...good, path: "{workspace}/a.json" }, "install"), /install\.path: token \{workspace\} is not available/);
    assert.throws(() => validateInstallBlock({ ...good, path: "{env:X|{nope}}/a.json" }, "install"), /install\.path: token \{nope\}/);
    assert.throws(() => validateInstallBlock({ ...good, path: "{home/a.json" }, "install"), /install\.path: unclosed/);
  });
  it("entryTemplates: an event with its own template is written, found and removed in its own shape; the rest use entryTemplate", () => {
    const block = {
      format: "json" as const,
      path: "{home}/hooks.json",
      mode: "merge" as const,
      rootKey: "hooks",
      events: ["PreToolUse", "Stop"],
      matcherEvents: { PreToolUse: "*" },
      entryTemplate: { type: "command", command: "{command}" },
      entryTemplates: { PreToolUse: { hooks: [{ type: "command", command: "{command}" }] } },
    };
    assert.deepEqual(validateInstallBlock(block, "install"), block);
    const editor = jsonHookEditor(block);
    const plat = platformFor("darwin");
    const spec = { dataHome: "/d", launcher: "/l/hook-launch.sh", hookPath: "/l/hook.js", host: "x" };
    const mine = { hooks: { Stop: [{ type: "command", command: "echo mine" }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } };
    const text = editor.addHooks(JSON.stringify(mine), "/h/hooks.json", spec, plat);
    const out = JSON.parse(text);
    const ours = out.hooks.PreToolUse.at(-1);
    assert.equal(ours.matcher, "*");
    assert.equal(ours.command, undefined, "a grouped event's entry has no command of its own");
    assert.match(ours.hooks[0].command, /COCHECK_MANAGED=1/);
    const stop = out.hooks.Stop.at(-1);
    assert.match(stop.command, /COCHECK_MANAGED=1/);
    assert.equal(stop.hooks, undefined, "a flat event's entry is not a group");
    assert.deepEqual(editor.missingEvents(text, "/h/hooks.json", plat), []);
    assert.deepEqual(editor.missingEvents(JSON.stringify(mine), "/h/hooks.json", plat), ["PreToolUse", "Stop"]);
    // Installing twice replaces CoCheck's entries; removing leaves exactly the person's own.
    const twice = editor.addHooks(text, "/h/hooks.json", spec, plat);
    assert.equal(JSON.parse(twice).hooks.PreToolUse.length, 2);
    assert.equal(JSON.parse(twice).hooks.Stop.length, 2);
    const removed = editor.removeHooks(twice, "/h/hooks.json", plat);
    assert.equal(removed.changed, true);
    assert.deepEqual(JSON.parse(removed.text), mine);
    assert.throws(() => validateInstallBlock({ ...block, entryTemplates: { Nope: { command: "{command}" } } }, "install"), /install\.entryTemplates\.Nope: expected an event listed in events or extraEvents/);
    assert.throws(() => validateInstallBlock({ ...block, entryTemplates: { Stop: { command: "x" } } }, "install"), /install\.entryTemplates\.Stop: expected an object that uses \{command\}/);
    assert.throws(() => validateInstallBlock({ ...block, entryTemplates: [] }, "install"), /install\.entryTemplates/);
  });
  it("merge mode: a new or empty file gets the envelope; an existing file keeps its own keys and gets none added", () => {
    const editor = jsonHookEditor({ ...good, mode: "merge", envelope: { version: 1 } });
    const spec = undefined;
    for (const current of ["", "  \n"]) assert.equal(JSON.parse(editor.addHooks(current, "/f.json", spec)).version, 1, "a new file carries version 1");
    const existing = JSON.parse(editor.addHooks('{"other": true}\n', "/f.json", spec));
    assert.equal(existing.other, true);
    assert.equal("version" in existing, false, "an existing file's keys are kept and the envelope is not added");
    assert.equal(JSON.parse(editor.addHooks('{"version": 2}\n', "/f.json", spec)).version, 2, "an existing version is never overwritten");
  });
});
