// Subject templates of installed connectors: `matches.subjects` maps a full MCP tool name to a template such as
// "notion://page/{page_id:hex}". The hook learns the subject of a tool call from these, never from connector knowledge in core.
// `{field}` is the input field's text; `{field:hex}` is its lower-case hex digits only. Only manifests with zero problems count.
import { readInstalledManifests } from "./installed-manifests.ts";
import { beforeReadMsOf } from "./schema.ts";
import { isUriSubject } from "./subject.ts";

/** Tool name to template, from every valid installed manifest. Never throws: a connector problem yields no template. */
export function loadSubjectTemplates(home: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { manifest } of readInstalledManifests(home)) {
    for (const [tool, template] of Object.entries(manifest.matches.subjects ?? {})) if (!out.has(tool)) out.set(tool, template);
  }
  return out;
}

/** The URI subject a template names for a tool input, or undefined when a field is missing or the result is not a URI. */
export function renderSubject(template: string, input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  let missing = false;
  const text = template.replace(/\{(\w+)(?::hex)?\}/g, (whole, field: string) => {
    const v = (input as Record<string, unknown>)[field];
    if (typeof v !== "string" && typeof v !== "number") { missing = true; return ""; }
    const text = whole.endsWith(":hex}") ? String(v).toLowerCase().replace(/[^0-9a-f]/g, "") : String(v);
    if (text === "") missing = true;
    return text;
  });
  return missing || !isUriSubject(text) ? undefined : text;
}

/** How long the hook waits for the before-read of this tool's subject: the matching manifest's beforeReadMs (default 1500, cap 3000). The first manifest naming the tool wins, as in `loadSubjectTemplates`. */
export function beforeReadMsFor(home: string, tool: string): number {
  for (const { manifest } of readInstalledManifests(home)) if (Object.hasOwn(manifest.matches.subjects ?? {}, tool)) return beforeReadMsOf(manifest);
  return beforeReadMsOf(undefined);
}

// ---- a creation subject read from the tool's answer (`matches.calls`) ----------------------------------------------------------------------------

/** The largest answer a creation subject is read from; a bigger answer is a gap. */
export const MAX_CALL_ANSWER_BYTES = 1024 * 1024;

/** Tool name to its one creation template, from every valid installed manifest (the first manifest naming a tool wins). Never throws. */
export function loadCallTemplates(home: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const { manifest } of readInstalledManifests(home)) {
      for (const [tool, entry] of Object.entries(manifest.matches.calls ?? {})) {
        const template = entry.subjects[0]?.template;
        if (template !== undefined && !out.has(tool)) out.set(tool, template);
      }
    }
  } catch {
    // no templates
  }
  return out;
}

const plainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const jsonObject = (text: unknown): Record<string, unknown> | undefined => {
  if (typeof text !== "string") return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return plainObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

/** True when the answer is marked as an error (`isError: true`); such a call yields no subject and no row. */
export const answerIsError = (answer: unknown): boolean => plainObject(answer) && answer.isError === true;

/**
 * The object a tool's answer names its item in, by payload shape and in this order: a `structuredContent` object; else exactly one text block
 * (in a `content` list, or the answer itself being the list) that parses as a JSON object; else the answer as a string that parses as a JSON object.
 * Undefined otherwise, and for an answer marked `isError`.
 */
export function answerObjectOf(answer: unknown): Record<string, unknown> | undefined {
  if (answerIsError(answer)) return undefined;
  if (plainObject(answer) && plainObject(answer.structuredContent)) return answer.structuredContent;
  const blocks = Array.isArray(answer) ? answer : plainObject(answer) && Array.isArray(answer.content) ? answer.content : undefined;
  if (blocks !== undefined) {
    const texts = blocks.filter((b) => plainObject(b) && b.type === "text");
    return texts.length === 1 ? jsonObject((texts[0] as { text?: unknown }).text) : undefined;
  }
  return jsonObject(answer);
}

/** The URI subject a `matches.calls` template names in a tool's answer, or undefined when the answer has no object, a path is missing or empty, or the result is not a URI. */
export function renderCallSubject(template: string, answer: unknown): string | undefined {
  const obj = answerObjectOf(answer);
  if (obj === undefined) return undefined;
  let missing = false;
  const text = template.replace(/\{(\w+(?:\.\w+)*)(?::hex)?\}/g, (whole, p: string) => {
    let v: unknown = obj;
    for (const part of p.split(".")) v = plainObject(v) && Object.hasOwn(v, part) ? v[part] : undefined;
    if (typeof v !== "string" && typeof v !== "number") { missing = true; return ""; }
    const out = whole.endsWith(":hex}") ? String(v).toLowerCase().replace(/[^0-9a-f]/g, "") : String(v);
    if (out === "") missing = true;
    return out;
  });
  return missing || !isUriSubject(text) ? undefined : text;
}
