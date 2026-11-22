// Secret handling for patch text (Codex and Copilot `apply_patch` / `patch`): the whole patch is the new file contents, so it gets the same
// treatment a Write's content gets. A section whose file is a secret path (src/secret-files.ts) or whose lines hold a gitleaks-shaped value
// (src/secret-scan.ts) is withheld; the headers stay, so the timeline still names the files. Bound: the same detector as every other secret
// check (gitleaks default rules plus the secret-path list); a password in free prose with no vendor format is not detected.
import { allProfiles, toolEntryOf } from "./hosts/index.ts";
import { isSecretPath } from "./secret-files.ts";
import { firstSecretRule } from "./secret-scan.ts";

const HEADER = /^\*\*\* (Add File|Update File|Delete File|Move to):[ \t]*(.+?)[ \t]*$/;
const MARKER = /^\*\*\* (Begin Patch|End Patch|End of File)\s*$/;
/** What replaces the body of a withheld section. */
const PATCH_WITHHELD = "[withheld: secret]";
const WHOLE_WITHHELD = "[patch withheld: secret]";

/** True when the text looks like an apply_patch patch. */
const isPatchText = (text: string): boolean => text.includes("*** Begin Patch") || /^\*\*\* (?:Add|Update|Delete) File:/m.test(text);

/** A section's body as the file text it shows: the diff column (+, -, space) dropped from each line, so a value split by a marker still reads whole. */
const bodyText = (lines: string[]): string => lines.map((l) => (l === "" ? l : l.slice(1))).join("\n");

/** True when a patch section (its file path and body lines) must not be stored: a secret path, or a secret in its text. */
function patchSectionIsSecret(file: string, lines: readonly string[]): boolean {
  return isSecretPath(file) || firstSecretRule(bodyText([...lines])) !== undefined || firstSecretRule(lines.join("\n")) !== undefined;
}

interface Section {
  /** Every file the section names: its source, and a `Move to` destination. */
  files: string[];
  /** The section's rows in order: its headers (including `Move to`) and its body lines. */
  headers: string[];
  rows: string[];
  body: string[];
}

/** The patch cut into plain rows (markers, orphan text) and sections; a `Move to` stays in the section it moves. */
function parse(text: string): Array<string | Section> {
  const out: Array<string | Section> = [];
  let cur: Section | undefined;
  for (const row of text.split("\n")) {
    const h = HEADER.exec(row.replace(/\r$/, ""));
    if (h && h[1] === "Move to" && cur !== undefined) {
      cur.files.push(h[2]!);
      cur.headers.push(row);
      cur.rows.push(row);
    } else if (h || MARKER.test(row)) {
      cur = undefined;
      if (h && h[1] !== "Delete File") out.push((cur = { files: [h[2]!], headers: [row], rows: [row], body: [] }));
      else out.push(row);
    } else if (cur !== undefined) {
      cur.rows.push(row);
      cur.body.push(row);
    } else out.push(row);
  }
  return out;
}

/** A section is secret when ANY file it names (source or `Move to` destination) is a secret path, or its text holds a secret. */
const sectionSecret = (s: Section): boolean => s.files.some((f) => isSecretPath(f)) || patchSectionIsSecret("", s.body);

/**
 * The patch with every secret section's body replaced by one withheld line; headers (a `Move to` too), markers, and normal sections are
 * untouched. A secret that survives that (in a header, or text outside any section) withholds the whole patch.
 */
export function scrubPatchText(text: string): string {
  if (text === "" || !isPatchText(text)) return text;
  const out: string[] = [];
  for (const part of parse(text)) {
    if (typeof part === "string") out.push(part);
    else if (sectionSecret(part)) out.push(...part.headers, PATCH_WITHHELD);
    else out.push(...part.rows);
  }
  const result = out.join("\n");
  return firstSecretRule(result) === undefined ? result : WHOLE_WITHHELD;
}

/** True when a replay section was withheld by `scrubPatchText`: its body is the withheld line. */
export const isWithheldSection = (lines: readonly string[]): boolean => lines.some((l) => l === PATCH_WITHHELD) || lines.some((l) => l === WHOLE_WITHHELD);

/** The text of every line in a secret section of the patch (the diff column dropped), for removing echoes of it from error text. */
function withheldLinesOf(text: string): string[] {
  if (text === "" || !isPatchText(text)) return [];
  const out: string[] = [];
  for (const part of parse(text)) if (typeof part !== "string" && sectionSecret(part)) for (const l of part.body) out.push(l.slice(1).trim());
  return out.filter((l) => l.length >= 4);
}

/** Every string leaf of a value, JSON-looking strings opened one level (a host that sends its tool arguments as a JSON string). */
function leaves(v: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof v === "string") {
    out.push(v);
    if (depth < 3 && /^\s*[{["]/.test(v)) {
      try {
        leaves(JSON.parse(v), out, depth + 1);
      } catch {
        // not JSON: the string is a leaf
      }
    }
  } else if (v !== null && typeof v === "object" && depth < 6) for (const x of Object.values(v as Record<string, unknown>)) leaves(x, out, depth + 1);
  return out;
}

/** The tools that carry a patch (class `patch` in the host's table), by name, in any namespaced form. With no host the built-in tables are read together. */
export const isPatchTool = (tool: unknown, host?: string | null): boolean => typeof tool === "string" && toolEntryOf(host, tool.slice(tool.search(/[^.:/]*$/)), true)?.class === "patch";
/** The input fields of a patch tool that hold the patch text. Anything else in an input (and every other tool's input) is left to the secret-content filter. */
const PATCH_FIELDS = ["input", "patch", "command", "diff"];

/**
 * A patch tool's input with its patch text scrubbed (the input itself when it is the text, else the patch-carrying fields); the one form the
 * adapter reads. Any other tool's input passes through untouched, so a Write whose content merely holds a patch block is not altered.
 */
export function scrubToolInput(tool: unknown, v: unknown, host?: string | null): unknown {
  if (!isPatchTool(tool, host)) return v;
  if (typeof v === "string") return scrubPatchText(v);
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, PATCH_FIELDS.includes(k) && typeof x === "string" ? scrubPatchText(x) : x]));
}

/**
 * The payload fields that carry a call's outcome, from the host adapters: `error` (Claude Code and Codex failure events, Copilot
 * postToolUseFailure), `tool_response` (Claude Code and Codex: a string, or an object such as `{is_error, content}`), `toolResult`
 * (Copilot: `{textResultForLlm, ...}`). Every string inside one is scrubbed, so a sibling text field is covered too.
 */
const RESPONSE_FIELDS = ["error", "tool_response", "toolResult"];

function scrubTextDeep(v: unknown, tool: unknown, input: unknown, depth = 0, host?: string | null): unknown {
  if (typeof v === "string") return scrubFailureText(v, tool, input, host);
  if (Array.isArray(v) && depth < 6) return v.map((x) => scrubTextDeep(x, tool, input, depth + 1, host));
  if (v !== null && typeof v === "object" && depth < 6) return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubTextDeep(x, tool, input, depth + 1, host)]));
  return v;
}

/**
 * The hook payload bytes with the patch scrubbed: the one form that is ever persisted or passed on (Copilot held spool, replays; the hook journal keeps no body).
 * Every host's tool-input field is read (a JSON-string `toolArgs` is opened and written back as a string). The same bytes when nothing changes;
 * unparseable bytes pass through (nothing in them is read as a patch). The response fields lose echoes of the withheld lines.
 * Declared limit: only a patch TOOL's patch fields are read. A patch routed through a shell (`apply_patch <<EOF` in a Bash or `shell` command)
 * is not scrubbed here; like any shell command it falls to the adapter's `#redact` and secret-line handling, as on main.
 */
export function scrubPayloadBytes(bytes: Buffer): Buffer {
  let obj: Record<string, unknown>;
  try {
    const v = JSON.parse(bytes.toString("utf8"));
    if (v === null || typeof v !== "object" || Array.isArray(v)) return bytes;
    obj = v as Record<string, unknown>;
  } catch {
    return bytes;
  }
  let changed = false;
  for (const f of allProfiles().map((p) => p.fields)) {
    const tool = obj[f.toolName];
    const raw = obj[f.toolInput];
    if (raw === undefined || !isPatchTool(tool)) continue;
    let parsed: unknown = raw;
    let wasString = false;
    if (typeof raw === "string") {
      try {
        const j = JSON.parse(raw);
        if (j !== null && (typeof j === "object" || typeof j === "string")) {
          parsed = j;
          wasString = true;
        }
      } catch {
        // a plain patch string
      }
    }
    const out = scrubToolInput(tool, parsed);
    if (JSON.stringify(out) !== JSON.stringify(parsed)) {
      obj[f.toolInput] = wasString ? JSON.stringify(out) : out;
      changed = true;
    }
    // Every response field a host reads (see RESPONSE_FIELDS), whatever its shape: a failed patch's response echoes the hunk lines.
    for (const k of RESPONSE_FIELDS) {
      if (obj[k] === undefined) continue;
      const before = JSON.stringify(obj[k]);
      obj[k] = scrubTextDeep(obj[k], tool, parsed);
      if (JSON.stringify(obj[k]) !== before) changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(obj)) : bytes;
}

/** Error text with each line that echoes a withheld patch line replaced, and any patch text in it scrubbed. */
export function scrubFailureText(text: string, tool: unknown, input: unknown, host?: string | null): string {
  if (!isPatchTool(tool, host)) return text;
  const secret = leaves(input).flatMap(withheldLinesOf);
  const lines = scrubPatchText(text).split("\n");
  return lines.map((l) => (secret.some((s) => l.includes(s)) ? PATCH_WITHHELD : l)).join("\n");
}
