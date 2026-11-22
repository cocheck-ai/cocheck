// Manifest to profile: `compileManifest` turns a validated harness manifest (src/hosts/manifest.ts) into a HostProfile. The function members of a
// profile are generic code driven by the manifest's data (a path read, a failure rule, a refine rule, a name strip) or a named first-party extra.
import { homedir } from "node:os";
import path from "node:path";
import { applyExtras } from "./extras.ts";
import { argsKey } from "./shared.ts";
import { jsonHookEditor, type JsonInstallBlock } from "./install-block.ts";
import { MATCH_INPUT_MAX } from "./manifest.ts";
import type { FailureRule, HarnessManifest, ManifestArgvTag, PayloadPath } from "./manifest.ts";
import type { EventKind, ExtraFields, FailureRead, HostProfile, PayloadFields } from "./types.ts";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The value at a payload path (`a.b`, `a[0].b`), or undefined when any step is missing. */
export function readPath(root: unknown, p: PayloadPath): unknown {
  let cur: unknown = root;
  for (const m of p.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = m[2] !== undefined ? (Array.isArray(cur) ? cur[Number(m[2])] : undefined) : Object.hasOwn(cur, m[1]!) ? (cur as Record<string, unknown>)[m[1]!] : undefined;
  }
  return cur;
}

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The keys the normalizer reads from a compiled profile's payload (see `HostProfile.readPayload`). */
const FLAT = { eventName: "eventName", session: "session", cwd: "cwd", toolName: "toolName", toolInput: "toolInput", toolResponse: "toolResponse", toolUseId: "toolUseId", agentId: "agentId", agentType: "agentType", transcriptPath: "transcriptPath", lastAssistantMessage: "lastAssistantMessage", prompt: "prompt", parentSession: "parentSession" } as const;

/** Tool arguments as an object: JSON text that holds an object is parsed; anything else passes through. */
function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

/** The text of a list of `{ text }` blocks, joined by a line break; a string is itself; anything else is not text. */
function blocksText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((c) => (isObject(c) && typeof c.text === "string" ? [c.text] : [])).join("\n");
}

function failureFrom(kind: EventKind, p: Record<string, unknown>, rules: HarnessManifest["failure"], capInput: boolean): FailureRead {
  if (kind !== "tool-failure" && kind !== "tool-post") return undefined;
  const rule: FailureRule | undefined = rules?.[kind];
  if (kind === "tool-post" && rule === undefined) return undefined;
  const r = rule ?? {};
  const flagged = r.flags?.some((f) => readPath(p, f) === true) === true;
  let words = r.text?.map((t) => text(readPath(p, t))).find((t) => t !== undefined);
  // tool-post with `nonEmpty`: words at a `text` path mean the call failed.
  const saidFailed = r.nonEmpty === true && words !== undefined && words !== "";
  if ((words === undefined || words === "") && flagged && r.flaggedText !== undefined) {
    const alt = r.flaggedText.map((e) => (typeof e === "string" ? text(readPath(p, e)) : e.blocks === true ? blocksText(readPath(p, e.path)) : text(readPath(p, e.path)))).find((t) => t !== undefined);
    if (alt !== undefined) words = alt;
  }
  const interrupted = r.interrupt !== undefined && readPath(p, r.interrupt) === true;
  const inferred = r.inferred === true ? { inferred: true as const } : {};
  if (kind === "tool-failure") return { raw: words ?? "", interrupted, ...inferred };
  let said: string | undefined;
  let failed = false;
  if (r.exitCode !== undefined) {
    said = text(readPath(p, r.exitCode.from));
    const codes = said === undefined ? [] : [...(capInput ? said.slice(-MATCH_INPUT_MAX) : said).matchAll(new RegExp(r.exitCode.pattern, "g"))];
    const last = codes.length === 0 ? undefined : Number(codes[codes.length - 1]![1]);
    failed = last !== undefined && Number.isFinite(last) && last !== 0;
  }
  return flagged || failed || saidFailed ? { raw: words ?? (failed ? said : undefined) ?? "", interrupted, ...inferred } : undefined;
}

function templateFill(tpl: string, env: NodeJS.ProcessEnv, vars: Record<string, string>, usedEnv?: { value: boolean }): string {
  let out = "";
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i] !== "{") {
      out += tpl[i];
      continue;
    }
    let depth = 1;
    let j = i + 1;
    while (j < tpl.length && depth > 0) (depth += tpl[j] === "{" ? 1 : tpl[j] === "}" ? -1 : 0), j++;
    const token = tpl.slice(i + 1, j - 1);
    if (token === "home") out += homedir();
    else if (token.startsWith("env:")) {
      const [name, ...fallback] = token.slice(4).split("|");
      if (env[name!]) {
        out += env[name!];
        if (usedEnv) usedEnv.value = true;
      } else if (fallback.length > 0) out += templateFill(fallback.join("|"), env, vars);
      else throw new Error(`the environment variable ${name} is not set`);
    } else if (token in vars) out += vars[token];
    else throw new Error(`unknown token {${token}} in ${tpl}`);
    i = j - 1;
  }
  return out;
}

const deepFolder = (v: unknown, folder: string): unknown =>
  typeof v === "string" ? v.split("{folder}").join(folder) : Array.isArray(v) ? v.map((x) => deepFolder(x, folder)) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepFolder(x, folder)])) : v;

const deepSlots = (v: unknown, vars: Record<string, unknown>): unknown =>
  typeof v === "string" ? (v.startsWith("{") && v.endsWith("}") && v.slice(1, -1) in vars ? vars[v.slice(1, -1)] : v) : Array.isArray(v) ? v.map((x) => deepSlots(x, vars)) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepSlots(x, vars)])) : v;

function argvTagFrom(a: ManifestArgvTag): NonNullable<HostProfile["argvTag"]> {
  return { tool: a.tool, envFileVar: a.envFileVar, shellEnv: a.shellEnv, sessionStartEvent: a.sessionStartEvent, preOutput: (eventName, updatedInput) => JSON.stringify(deepSlots(a.preOutput, { event: eventName, input: updatedInput })) + "\n" };
}

const INSTALL_OWN = new Set(["skillRoot", "hostFlag", "projectDirEnv", "folderFromPayloadCwd", "promptContext", "ownsFile", "inBothAlias", "reusesRecord", "timingLabel", "afterInstall", "checkPayload", "editorExtra", "notes"]);

/** The profile a validated manifest describes. `source` "outsider" marks a profile loaded from the user's folder (its events never prove more than "inferred"). */
export function compileManifest(m: HarnessManifest, source: "built-in" | "outsider"): HostProfile {
  const f = m.fields;
  const callIdPath = m.callId !== undefined && "payload" in m.callId ? m.callId.payload : undefined;
  const slots: Array<[string, PayloadPath | undefined]> = [
    [FLAT.session, f.session],
    [FLAT.cwd, f.cwd],
    [FLAT.toolName, f.toolName],
    [FLAT.toolInput, f.toolInput],
    [FLAT.toolResponse, f.toolResponse],
    [FLAT.toolUseId, callIdPath],
    [FLAT.agentId, f.agentId],
    [FLAT.agentType, f.agentType],
    [FLAT.transcriptPath, f.transcriptPath],
    [FLAT.lastAssistantMessage, f.lastAssistantMessage],
    [FLAT.prompt, f.prompt],
    [FLAT.parentSession, f.parentSession],
    [FLAT.eventName, "payload" in m.eventFrom ? m.eventFrom.payload : undefined],
  ];
  // A manifest whose paths are all top-level keys needs no payload reading: the fields name the payload's own keys, so code that reads a raw payload by key (the helper linker, the patch scrub) sees them.
  const plain = slots.every(([, p]) => p === undefined || /^[A-Za-z_][\w-]*$/.test(p));
  const fields: PayloadFields = { ...FLAT, ...(plain ? Object.fromEntries(slots.filter(([, p]) => p !== undefined)) : {}), ...(f.callReason === undefined ? {} : { callReason: f.callReason }) };
  if (f.toolResponse === undefined) delete (fields as { toolResponse?: string }).toolResponse;
  if (f.parentSession === undefined) delete (fields as { parentSession?: string }).parentSession;

  const extraPaths = m.extraFields ?? {};
  const refine = m.refine ?? [];
  const strip = m.toolNameStrip === undefined ? undefined : new RegExp(`^(?:${m.toolNameStrip.prefix})`);
  const failure = m.failure;
  const sf = m.sessionFile;
  const inst = m.install;
  const block = inst === undefined || inst.editorExtra !== undefined ? undefined : (Object.fromEntries(Object.entries(inst).filter(([k]) => !INSTALL_OWN.has(k))) as unknown as JsonInstallBlock);

  const base: HostProfile = {
    key: m.key,
    displayName: m.displayName,
    ...(m.fullName === undefined ? {} : { fullName: m.fullName }),
    chip: m.chip,
    testedVersions: m.testedVersions ?? [],
    ...(source === "outsider" ? { trust: "outsider" as const } : {}),
    ...(m.sessionEnv === undefined ? {} : { sessionEnv: m.sessionEnv }),
    ...(m.argvTag === undefined ? {} : { argvTag: argvTagFrom(m.argvTag) }),
    ...(m.foreignHookFingerprint === undefined ? {} : { foreignHookFingerprint: m.foreignHookFingerprint }),
    ...(m.readsConfigsOf === undefined ? {} : { readsConfigsOf: m.readsConfigsOf }),
    ...(m.perAction === undefined ? {} : { perAction: m.perAction }),
    eventKinds: m.events,
    ...("arg" in m.eventFrom ? { eventFromArg: true as const } : {}),
    ...(m.unverifiedEvents === undefined ? {} : { unverifiedEvents: m.unverifiedEvents }),
    capabilities: { failureEvent: false, argvTag: false, helperSessions: false, launchKey: false, readsForeignHooks: false, ...m.capabilities },
    fields,
    ...(plain && !("arg" in m.eventFrom)
      ? {}
      : {
          readPayload: (raw: unknown, eventArg?: string) => {
            if (!isObject(raw)) return raw as unknown as Record<string, unknown>;
            const out: Record<string, unknown> = { ...raw };
            for (const [flat, p] of slots) out[flat] = p === undefined ? undefined : readPath(raw, p);
            if ("arg" in m.eventFrom) out[FLAT.eventName] = eventArg;
            return out;
          },
        }),
    failureOf: (kind, p) => failureFrom(kind, p, failure, source === "outsider"),
    extraOf: (p) => {
      const out: ExtraFields = {};
      for (const k of ["turnId", "permissionMode", "model"] as const) {
        const v = extraPaths[k] === undefined ? undefined : readPath(p, extraPaths[k]!);
        if (typeof v === "string") out[k] = v;
      }
      const hook = extraPaths.stopHookActive === undefined ? undefined : readPath(p, extraPaths.stopHookActive);
      if (typeof hook === "boolean") out.stopHookActive = hook;
      return out;
    },
    ...(refine.length === 0
      ? {}
      : {
          refineKind: (kind: EventKind, p: Record<string, unknown>): EventKind => {
            for (const r of refine) {
              if (!r.kinds.includes(kind)) continue;
              if (r.whenPresent !== undefined) {
                const v = readPath(p, r.whenPresent);
                if (typeof v !== "string" || v === "") continue;
              }
              if (r.whenMatches !== undefined) {
                const v = readPath(p, r.whenMatches.path);
                if (typeof v !== "string" || !new RegExp(r.whenMatches.pattern).test(source === "outsider" ? v.trim().slice(0, MATCH_INPUT_MAX) : v.trim())) continue;
              }
              return r.becomes;
            }
            return kind;
          },
        }),
    ...(m.toolInputEncoding === "json-text" ? { parseToolInput: parseJsonText } : {}),
    ...(strip === undefined
      ? {}
      : {
          toolName: (reported: string) => {
            const own = source === "outsider" ? reported.slice(0, MATCH_INPUT_MAX).replace(strip, "") + reported.slice(MATCH_INPUT_MAX) : reported.replace(strip, "");
            return own === "" ? reported : own;
          },
        }),
    toolClasses: m.toolClasses,
    ...(m.callId?.synthesized === true ? { calls: { argsKey, syntheticId: (session: string, n: number) => `${m.key}-${session}-${n}` } } : {}),
    narration: { sources: m.narration?.sources ?? [], foldLine: () => {}, closing: (cur) => cur?.closing ?? "", ...(m.narration?.closingWaitMs === undefined ? {} : { closingWaitMs: m.narration.closingWaitMs }) },
    sessionFile: {
      bySessionId: sf?.bySessionId === true,
      locate: (session, _now, root) => {
        if (sf?.file === undefined || !/^[A-Za-z0-9._-]+$/.test(session)) return undefined;
        const used = { value: false };
        let folder = root;
        if (folder === undefined) {
          if (sf.defaultRoot === undefined) return undefined;
          folder = templateFill(sf.defaultRoot, process.env, {}, used);
          // Under the test runner the host's real folder is never read: the default root must come from an environment variable the test set.
          if (!used.value && process.env.NODE_TEST_CONTEXT) throw new Error(`the session folder of ${m.key} would fall back to the real home under the test runner; refusing`);
        }
        return path.normalize(templateFill(sf.file, process.env, { root: folder, session }));
      },
    },
    ...(m.hostOwnedFiles === undefined ? {} : { hostOwnedFiles: m.hostOwnedFiles }),
    ...(m.hostOwnedWhat === undefined ? {} : { hostOwnedWhat: m.hostOwnedWhat }),
    ...(inst === undefined
      ? {}
      : {
          install: {
            skillRoot: path.join(...inst.skillRoot.split("/")),
            hostFlag: inst.hostFlag,
            ...(inst.projectDirEnv === undefined ? {} : { projectDirEnv: inst.projectDirEnv }),
            ...(inst.folderFromPayloadCwd === undefined ? {} : { folderFromPayloadCwd: inst.folderFromPayloadCwd }),
            ...(inst.promptContext === undefined ? {} : { promptContext: inst.promptContext }),
            ...(inst.ownsFile === undefined ? {} : { ownsFile: inst.ownsFile }),
            ...(inst.inBothAlias === undefined ? {} : { inBothAlias: inst.inBothAlias }),
            ...(inst.reusesRecord === undefined ? {} : { reusesRecord: inst.reusesRecord }),
            ...(inst.timingLabel === undefined ? {} : { timingLabel: inst.timingLabel }),
            ...(inst.afterInstall === undefined ? {} : { afterInstall: inst.afterInstall }),
            ...(inst.notes === undefined ? {} : { notes: ({ launcherDir, home }: { launcherDir: string; home: string }) => inst.notes!.split("{launcherDir}").join(launcherDir).split("{home}").join(home) }),
            events: block?.events ?? inst.events ?? [],
            checkPayload: (folder: string) => deepFolder(inst.checkPayload, folder) as { payload: Record<string, unknown>; event?: string },
            ...(block === undefined ? {} : jsonHookEditor(block)),
          } as NonNullable<HostProfile["install"]>,
        }),
    shape: m.shape ?? {},
  };
  const names = [...new Set([...(m.extras ?? []), ...(inst?.editorExtra === undefined ? [] : [inst.editorExtra])])];
  const templates = [m.install?.path, m.sessionFile?.defaultRoot, m.sessionFile?.file].filter((t): t is string => typeof t === "string");
  const homeEnv = [...new Set(templates.flatMap((t) => [...t.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1]!)))];
  const out = applyExtras(homeEnv.length === 0 ? base : { ...base, homeEnv }, names);
  const i = out.install;
  if (i !== undefined && (i.configFile === undefined || i.addHooks === undefined || i.removeHooks === undefined || i.missingEvents === undefined)) {
    throw new Error(`${m.key}/cocheck-harness.json: install: no editor (give the JSON install block, or name an editor extra)`);
  }
  return out;
}
