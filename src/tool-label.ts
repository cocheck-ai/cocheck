/**
 * A safe label for any tool call, taken from its input by an allowlist of field names that NAME things (a skill, a
 * query, a pattern, a path, a URL, a helper agent's type), never content. Host-neutral: Claude Code and Codex payloads go
 * through the same function. The table below is the whole policy: a new tool is one row. Content fields (content, old_string,
 * new_string, edits, body, file bodies, patches) are not in any row, so they are never read. The exceptions are a SendMessage's
 * text (kept as `words`: masked like any free text, secret-checked, and cut at WORDS_CAP) and a helper agent's prompt, its brief
 * (kept as `brief`: the same checks, cut at BRIEF_CAP with the head and the ending both kept).
 * A tool with no row, and every MCP connector tool, records its input field NAMES only, never values. A value that looks like a secret is dropped and the
 * field is listed in `dropped`. This code never throws: a missing or odd input yields an empty label.
 */

import { createHash } from "node:crypto";
import { firstSecretRule } from "./secret-scan.ts";

type LabelKind = "text" | "path" | "paths" | "url" | "words" | "brief";

/** The label fields each tool may record, by field name. Tool names match case-insensitively. */
const TOOL_LABEL_TABLE: Readonly<Record<string, Readonly<Record<string, LabelKind>>>> = {
  bash: { command: "text", description: "text" },
  read: { file_path: "path" },
  edit: { file_path: "path" },
  multiedit: { file_path: "path" },
  write: { file_path: "path" },
  notebookedit: { notebook_path: "path" },
  glob: { pattern: "text", path: "path" },
  grep: { pattern: "text", path: "path", glob: "text" },
  skill: { skill: "text", name: "text" },
  toolsearch: { query: "text" },
  websearch: { query: "text" },
  webfetch: { url: "url" },
  // The brief a main agent gave a helper is the work's own record (what it asked for), so the prompt is read, masked and cut with its ending kept.
  task: { subagent_type: "text", description: "text", prompt: "brief" },
  agent: { subagent_type: "text", description: "text", prompt: "brief" },
  // Codex's spawn_agent (by its own name; the Codex profile takes the namespace off): the helper's name, type and brief.
  spawn_agent: { task_name: "text", agent_type: "text", message: "brief" },
  // A message between Claude and a helper is the work's own record (who asked whom for what), so its text is read, masked and cut longer.
  sendmessage: { to: "text", summary: "text", message: "words", content: "words" },
};

/**
 * An MCP tool (`mcp__server__tool`, a connector) has no row of its own. It records its input field NAMES only
 * (`inputFields`), never values, because a connector's name, query, title or pattern can hold an email address or a page title.
 * Only these path and url fields are also read, through the same path masking and URL stripping as any other tool.
 */
const MCP_LABEL_FIELDS: Readonly<Record<string, LabelKind>> = {
  file_path: "path",
  path: "path",
  paths: "paths",
  notebook_path: "path",
  url: "url",
};

const LABEL_CAP = 200;
/** The longest a `words` field is kept (a message between agents). Over it, head and tail stay and the middle is replaced by a marker (was 1500, a mid-sentence cut). */
const WORDS_CAP = 6000;
/** The longest a `brief` field is kept (a helper's prompt). Over it, the first and last parts stay and the middle is replaced by a marker. */
const BRIEF_CAP = 6000;
const MAX_PATHS = 10;
const MAX_FIELD_NAMES = 30;

export interface ToolLabel {
  /** The allowlisted fields found in the input, each string cut to 200 characters (`paths` is a list of at most 10). */
  fields: Record<string, string | string[]>;
  /** Allowlisted fields whose value was not recorded, with the reason in words. */
  dropped?: Record<string, string>;
  /**
   * For each dropped helper field (words, brief), what lets the person's own page bring it back from the host's transcript and nothing
   * of the text: the rule family, the sha256 of the raw text, and (added by the hook) where the host recorded the call. Never the text itself.
   */
  withheld?: Record<string, WithheldRecord>;
  /** A tool with no row, or an MCP connector: the names of its input fields, never values. */
  inputFields?: string[];
}

/** The whole ledger record of a withheld field. `locator`: the host's transcript file and the call's tool_use id; absent when the hook had none. */
export interface WithheldRecord {
  family: string;
  sha256: string;
  locator?: { file: string; id: string };
}

interface LabelHooks {
  /** Free text (command, description, query, pattern) with outside-folder paths masked when outside watching is off. */
  text: (s: string) => string;
  /** One path with the same masking. */
  path: (s: string) => string;
}

/**
 * True when the text holds a value shaped like a secret. The detector is gitleaks' default ruleset (MIT, pinned in vendor/gitleaks/VERSION, generated into src/secret-rules.generated.ts by
 * scripts/gen-secret-rules.ts), run by src/secret-scan.ts. No rule is hand-written. A flagged helper field is withheld whole, never in part.
 * Bound, by design: a password in free prose with no vendor format (`password: hunter22`) is not detected. See docs/security.md.
 */
export function looksSecret(s: string): boolean {
  return firstSecretRule(s) !== undefined;
}

/** The rule family a secret-looking text falls in, for the ledger record only (a coarse label, never a match or a position). */
const FAMILIES: Array<[string, RegExp]> = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["auth-header", /\bBearer\s|\bBasic\s|\beyJ[A-Za-z0-9_-]{10,}\./i],
  ["url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:[^\s/@]+@/i],
  ["command-credentials", /\b(?:curl|mysql(?:dump|admin)?|sshpass)\b|\blogin\s+\S+\s+password\b|\bmachine\s+\S+\s+password\b/i],
  ["vendor-token", /\b(?:sk|pk|rk)[-_]|\b(?:gh[pousr]|xox[a-z]|xapp|AKIA|AIza|SG\.)/],
  ["name-assignment", /(?:key|secret|token|password|passwd|pwd|passphrase|credentials?|pass|pw)\W{0,4}[=:]/i],
  ["hex-string", /\b[0-9a-f]{32,}\b/i],
];
function secretFamily(s: string): string {
  for (const [name, re] of FAMILIES) if (re.test(s)) return name;
  return "other";
}

/** What a page says in place of a brief the host keeps encrypted (Codex's spawn_agent `message`): nothing of the token is shown. */
export const ENCRYPTED_BRIEF_NOTE = "encrypted by the host, not recorded";

/**
 * True when a value is an encrypted token, never text an agent wrote: Codex's own shape (`{type:"encrypted_content", ...}`), a Fernet token
 * (the `gAAAAA` prefix, then base64url with no spaces, 60+ characters), or any other unbroken base64url run of 120+ characters. A sentence that
 * merely contains a long token-like word has spaces, so it is not one. Bound: a plain brief that is one unbroken 120+ character base64url
 * word with no spaces is read as encrypted (a paragraph, a path or a URL always has a space, slash or dot).
 */
export function isEncryptedToken(v: unknown): boolean {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return /^encrypted/i.test(String((v as Record<string, unknown>).type ?? ""));
  if (typeof v !== "string") return false;
  const t = v.trim();
  return /^gAAAAA[A-Za-z0-9_-]{54,}={0,2}$/.test(t) || /^[A-Za-z0-9_-]{120,}={0,2}$/.test(t);
}

/** What replaces the middle of a message or brief over its cap. */
const MIDDLE_CUT = "[middle cut]";

/** Keeps the head and the tail of a long text, the middle replaced by a marker on its own line; total length at most `max`. */
function cutMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const mark = `\n${MIDDLE_CUT}\n`;
  const head = Math.floor((max - mark.length) / 2);
  return `${s.slice(0, head)}${mark}${s.slice(s.length - (max - mark.length - head))}`;
}

const cap = (s: string): string => (s.length > LABEL_CAP ? `${s.slice(0, LABEL_CAP - 1)}…` : s);

/** Scheme, host and path only: no credentials, query string or fragment. Undefined when it is not a URL. */
function urlLabel(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if (u.host === "") return undefined;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return undefined;
  }
}

const SECRET_NOTE = "secret-looking value, not recorded";

function one(kind: LabelKind, value: unknown, hooks: LabelHooks): { ok: string } | { drop: string; withheld?: WithheldRecord } {
  // A host's encrypted brief or message is not the agent's words: nothing of it is recorded, and the page says so.
  if ((kind === "brief" || kind === "words") && isEncryptedToken(value)) return { drop: ENCRYPTED_BRIEF_NOTE };
  if (typeof value !== "string") return { drop: "not a string" };
  let s: string;
  if (kind === "url") {
    const u = urlLabel(value);
    if (u === undefined) return { drop: "not a URL, not recorded" };
    s = u;
  } else s = kind === "text" || kind === "words" || kind === "brief" ? hooks.text(value) : hooks.path(value);
  if (looksSecret(s)) {
    // A helper's message or brief (the two kinds withheld whole) leaves a way back (the hash of the raw text and its family); a command, query, path or URL has none.
    const free = kind === "words" || kind === "brief";
    return free ? { drop: SECRET_NOTE, withheld: { family: secretFamily(s), sha256: createHash("sha256").update(value).digest("hex") } } : { drop: SECRET_NOTE };
  }
  if (kind === "brief") return { ok: cutMiddle(s, BRIEF_CAP) };
  return { ok: kind === "words" ? cutMiddle(s, WORDS_CAP) : cap(s) };
}

/** A connector call: `mcp__server__tool` that has no row of its own. Its input values are never stored, but path and url fields. */
export function isMcpTool(toolName: string | undefined): boolean {
  const name = (toolName ?? "").toLowerCase();
  return !Object.hasOwn(TOOL_LABEL_TABLE, name) && name.startsWith("mcp__");
}

/** The label for one call. Never throws. */
export function toolLabel(toolName: string | undefined, input: unknown, hooks: LabelHooks): ToolLabel {
  const out: ToolLabel = { fields: {} };
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return out;
    const obj = input as Record<string, unknown>;
    const name = (toolName ?? "").toLowerCase();
    const isMcp = isMcpTool(toolName);
    const row = Object.hasOwn(TOOL_LABEL_TABLE, name) ? TOOL_LABEL_TABLE[name] : isMcp ? MCP_LABEL_FIELDS : undefined;
    const fieldNames = () => Object.keys(obj).slice(0, MAX_FIELD_NAMES).map((k) => (looksSecret(k) ? "[secret-looking name]" : cap(k)));
    if (row === undefined) {
      out.inputFields = fieldNames();
      return out;
    }
    if (isMcp) out.inputFields = fieldNames();
    const dropped: Record<string, string> = {};
    for (const [field, kind] of Object.entries(row)) {
      if (!Object.hasOwn(obj, field)) continue;
      const value = obj[field];
      if (value === undefined || value === null || value === "") continue;
      if (kind === "paths") {
        const list = Array.isArray(value) ? value.slice(0, MAX_PATHS) : [value];
        const kept: string[] = [];
        for (const item of list) {
          const r = one("path", item, hooks);
          if ("ok" in r) kept.push(r.ok);
          else dropped[field] = r.drop;
        }
        if (kept.length > 0) out.fields[field] = kept;
        continue;
      }
      const r = one(kind, value, hooks);
      if ("ok" in r) out.fields[field] = r.ok;
      else {
        dropped[field] = r.drop;
        if (r.withheld !== undefined) (out.withheld ??= {})[field] = r.withheld;
      }
    }
    if (Object.keys(dropped).length > 0) out.dropped = dropped;
    return out;
  } catch {
    return { fields: {} };
  }
}
