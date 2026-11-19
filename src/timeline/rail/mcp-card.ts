// the card an MCP call with no connector draws, "What <server> told the agent". It is built only from the call's kept values (tool_input and
// tool_response, sealed and secret-scrubbed in the task's store), re-scrubbed here, and reduced to plain strings. The page draws strings and nothing else:
// no object, no array and no JSON text from the reply ever leaves this module (a reply that is JSON is parsed and flattened to "field: value" lines).
import path from "node:path";
import { readSealed } from "../../seal.ts";
import { callsDirOf, scrubDeep, type KeptCall } from "../../connector/frozen.ts";
import { redactSecrets } from "../../secret-scan.ts";
import { isReadOnlyMcpTool } from "../../credit-guard.ts";

/** The fixed wording of the card. Every other string on the card comes from the kept values. */
export const MCP_WORDS = {
  asked: (tool: string): string => `The agent called ${tool}`,
  title: (server: string): string => `What ${server} told the agent`,
  confirmed: "The reply only confirmed it",
  failed: (reason: string): string => `Attempted, failed: ${reason}`,
  noReason: "no reason was given",
  agentDid: "The agent did this",
  maybeOthers: "May include someone else's edits",
  lastSeen: "As the agent last saw it",
  noInput: "No input was kept for this call.",
  noReply: "No reply was kept for this call.",
  empty: "(empty)",
  deep: "(more detail, not shown)",
  cutReply: (n: number): string => `Cut at ${n} characters: the reply is longer than this.`,
  cutKept: (bytes: number): string => `Cut: CoCheck keeps the first 64 KiB of a reply, and this one was ${bytes} bytes.`,
  cutObject: "Cut: the rest of the reply was not kept.",
  part: (type: string): string => `(${type} content, not shown)`,
} as const;

/** The card's text is cut at this many characters, per part (the call's input, its reply, the earlier read's reply). */
export const MCP_CARD_CHARS = 1500;
/** Nested values are flattened to this depth: top-level fields are depth 0, their children 1, theirs 2. Deeper is replaced by MCP_WORDS.deep. */
export const MCP_FLATTEN_DEPTH = 2;

export interface McpCardPart { lines: string[]; cut?: string }
export interface McpCard {
  title: string;
  /** "The agent did this" or "May include someone else's edits"; absent when the call failed (nothing was done to credit). */
  credit?: string;
  intent: { head: string; lines: string[]; cut?: string };
  reply: { lines: string[]; cut?: string; /** The reply adds nothing beyond ids, status words and echoes of the input (see isThin). */ confirmed?: string; /** "Attempted, failed: <reason>". */ failed?: string; /** No reply was kept. */ none?: string };
  /** The earlier read's reply, when the agent read the same item earlier in the task. */
  lastSeen?: { head: string; lines: string[]; cut?: string };
}

export interface Line { name: string; value: string }

const spoken = (n: string): string => n.replace(/_/g, " ");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Text the page may show: secret-scrubbed again, one line, bounded. */
const plain = (s: string, max = Number.MAX_SAFE_INTEGER): string => {
  const t = redactSecrets(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
};

const LOOSE = /"([^"\\]{1,60})"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)/g;

/** A string that is JSON (an object or a list) becomes its parsed value; one that only starts like JSON (a reply cut at the store's cap) gives the string fields it still holds. */
function structured(s: string): { value: unknown } | { loose: Line[] } | undefined {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    const v = JSON.parse(t) as unknown;
    if (typeof v === "object" && v !== null) return { value: v };
    return undefined;
  } catch {
    const loose: Line[] = [];
    for (const m of t.matchAll(LOOSE)) {
      let v = m[2]!;
      try { v = String(JSON.parse(v)); } catch { /* keep the text */ }
      loose.push({ name: m[1]!, value: v });
    }
    return { loose };
  }
}

/** A tool reply in the MCP envelope ({content: [{type, text}...]}) is its parts: the text parts are the reply's words. */
function unwrap(root: unknown): unknown {
  if (isObj(root) && Array.isArray(root.content) && root.content.length > 0 && root.content.every((p) => isObj(p) && typeof p.type === "string")) {
    const rest = Object.fromEntries(Object.entries(root).filter(([k]) => k !== "content" && k !== "_meta" && k !== "structuredContent"));
    const parts = (root.content as Array<Record<string, unknown>>).map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : MCP_WORDS.part(String(p.type))));
    return Object.keys(rest).length === 0 ? parts : [...parts, rest];
  }
  return root;
}

/** The value as "field: value" lines, nested values flattened to MCP_FLATTEN_DEPTH. No object, array or JSON text is ever a line's value. */
export function flatten(root: unknown): Line[] {
  const out: Line[] = [];
  const name = (parent: string, k: string): string => (parent === "" ? plain(k, 60) : `${parent}.${plain(k, 60)}`);
  const walk = (x: unknown, at: string, depth: number): void => {
    if (typeof x === "string") {
      const s = structured(x);
      if (s === undefined) { out.push({ name: at, value: x }); return; }
      if ("loose" in s) {
        s.loose.forEach((l) => out.push({ name: name(at, l.name), value: l.value }));
        out.push({ name: "", value: MCP_WORDS.cutObject });
        return;
      }
      walk(s.value, at, depth);
      return;
    }
    if (x === null || x === undefined) { out.push({ name: at, value: MCP_WORDS.empty }); return; }
    if (typeof x !== "object") { out.push({ name: at, value: String(x) }); return; }
    if (depth >= MCP_FLATTEN_DEPTH) { out.push({ name: at, value: MCP_WORDS.deep }); return; }
    if (Array.isArray(x)) {
      if (x.length === 0) { out.push({ name: at, value: MCP_WORDS.empty }); return; }
      if (x.every((e) => (e === null || typeof e !== "object") && !(typeof e === "string" && structured(e) !== undefined))) {
        out.push({ name: at, value: x.map((e) => String(e ?? MCP_WORDS.empty)).join(", ") });
        return;
      }
      x.forEach((e, i) => walk(e, at === "" ? "" : `${at} ${i + 1}`, depth + (at === "" ? 0 : 1)));
      return;
    }
    const keys = Object.keys(x);
    if (keys.length === 0) { out.push({ name: at, value: MCP_WORDS.empty }); return; }
    keys.forEach((k) => walk((x as Record<string, unknown>)[k], name(at, k), depth + 1));
  };
  walk(root, "", -1);
  return out;
}

const render = (lines: Line[]): string[] => lines.flatMap((l) => {
  const rows = l.value.split("\n").map((r) => plain(r)).filter((r) => r !== "");
  if (rows.length === 0) return l.name === "" ? [] : [`${l.name}: ${MCP_WORDS.empty}`];
  return rows.map((r, i) => (i === 0 && l.name !== "" ? `${l.name}: ${r}` : r));
});

/** Cuts the lines at `max` characters; the cut is said on the part. */
function bound(lines: string[], max: number, keptBytes?: number): McpCardPart {
  const out: string[] = [];
  let used = 0, cut: string | undefined;
  for (const l of lines) {
    if (used + l.length > max) {
      const room = max - used;
      if (room > 1) out.push(`${l.slice(0, room - 1)}\u2026`);
      cut = MCP_WORDS.cutReply(max);
      break;
    }
    out.push(l); used += l.length;
  }
  if (keptBytes !== undefined) cut = cut === undefined ? MCP_WORDS.cutKept(keptBytes) : `${cut} ${MCP_WORDS.cutKept(keptBytes)}`;
  return { lines: out, ...(cut === undefined ? {} : { cut }) };
}

/** An input or reply as the lines the page draws, after the secret scrub. */
function partOf(value: unknown, keptBytes?: number): McpCardPart & { raw: Line[] } {
  const raw = flatten(unwrap(scrubDeep(value)));
  return { ...bound(render(raw), MCP_CARD_CHARS, keptBytes), raw };
}

// ---- thin replies ----

const STATUS_NAMES = new Set(["ok", "success", "status", "result", "done", "succeeded"]);
/** Confirmation words: what a one-line "it worked" sentence is made of. */
const CONFIRM = new Set(["ok", "okay", "success", "successful", "successfully", "done", "completed", "added", "removed", "created", "updated", "deleted", "applied", "modified", "changed", "committed", "pushed", "merged", "saved", "sent", "set", "label", "labels", "message", "messages", "file", "files", "insertion", "insertions", "deletion", "deletions", "to", "from", "the", "and", "on", "in", "for", "with", "a", "an", "of", "was", "were", "is", "has", "been", "have", "thread", "threads"]);

/** A field whose own name says it holds an id: "id", "..._id", "...Id". */
export const isIdName = (leaf: string): boolean => leaf === "id" || /_id$/.test(leaf) || /[A-Za-z0-9]Id$/.test(leaf);
const leafOf = (name: string): string => name.replace(/ \d+$/, "").split(".").pop() ?? name;
const URL_RE = /^https?:\/\/\S+$/i;
/** One token that is an identifier and not a name: a URL, a letters-and-digits mix (a hash, "Label_2", "a1b2c3d") or a very long run with no space. */
const idToken = (t: string): boolean => URL_RE.test(t) || (!/\s/.test(t) && ((/[A-Za-z]/.test(t) && /\d/.test(t)) || t.length >= 20));
const wordsOf = (s: string): string[] => s.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter((w) => w !== "");

/**
 * Thin reply, structurally: after flattening, every line of the reply is accounted for by the input or is only a confirmation. A line is accounted for when
 *  (a) it is an id: its field's name says id, or its value is one token that is an identifier (URL, letters mixed with digits, 20+ characters);
 *  (b) it echoes the input: its value equals a value the input sent, or contains one of 4+ characters;
 *  (c) it is a status: a field named ok, success, status, result, done or succeeded with a short value;
 *  (d) it is a running sentence (two or more words) whose every word is an id token, a number (a count), a word the input used or a word of the fixed
 *      confirmation list (CONFIRM).
 * A single number under a name is content (an MCP tool reply's before and after), never a count. A reply with no line is not thin: it is empty.
 */
export function isThin(reply: Line[], input: Line[]): boolean {
  if (reply.length === 0) return false;
  const inputValues = input.map((l) => l.value.trim().toLowerCase()).filter((v) => v !== "");
  const inputWords = new Set(input.flatMap((l) => [...wordsOf(l.value), ...wordsOf(l.name)]));
  const accounted = (l: Line): boolean => {
    const v = l.value.trim(), f = v.toLowerCase();
    if (v === "" || v === MCP_WORDS.empty) return true;
    if (l.name !== "" && isIdName(leafOf(l.name))) return true;
    if (idToken(v)) return true;
    if (inputValues.some((iv) => iv === f || (iv.length >= 4 && f.includes(iv)))) return true;
    if (l.name !== "" && STATUS_NAMES.has(leafOf(l.name).toLowerCase()) && v.length <= 40) return true;
    const ws = v.split(/\s+/);
    if (ws.length < 2) return false;
    return ws.every((raw) => {
      const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (w === "") return true;
      const lw = w.toLowerCase();
      return idToken(raw) || idToken(w) || /^\d[\d,.]*$/.test(w) || inputWords.has(lw) || CONFIRM.has(lw);
    });
  };
  return reply.every(accounted);
}

// ---- failed replies ----

/** The plain reason a reply gives for a failure, or undefined when it does not say it failed. */
export function failureOf(response: unknown, outcomeFailed: boolean): string | undefined {
  const r = scrubDeep(response);
  const says = isObj(r) && (r.isError === true || r.is_error === true || (typeof r.error === "string" && r.error !== "") || isObj(r.error));
  if (!outcomeFailed && !says) return undefined;
  const lines = flatten(unwrap(isObj(r) && !Array.isArray(r) ? (r.error !== undefined ? r.error : r) : r)).filter((l) => !(l.name !== "" && /^(isError|is_error)$/.test(l.name)));
  const named = lines.find((l) => /(^|\.)(message|error|reason|detail|description)$/i.test(l.name)) ?? lines.find((l) => l.value.trim() !== "" && l.value !== MCP_WORDS.empty);
  const text = named === undefined ? "" : (named.value.split("\n").find((x) => x.trim() !== "") ?? "");
  return plain(text, 200) || MCP_WORDS.noReason;
}

// ---- the earlier read ----

/** The id-valued fields an input sends: leaf name and value, for every scalar (or list of scalars) a field named like an id holds. */
export function idPairs(input: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (x: unknown, depth: number): void => {
    if (typeof x === "string") { const s = structured(x); if (s !== undefined && "value" in s) walk(s.value, depth); return; }
    if (depth > 6 || typeof x !== "object" || x === null) return;
    if (Array.isArray(x)) { x.forEach((e) => walk(e, depth + 1)); return; }
    for (const [k, v] of Object.entries(x)) {
      if (isIdName(k)) {
        const vs = Array.isArray(v) ? v : [v];
        vs.forEach((e) => { if ((typeof e === "string" && e !== "") || typeof e === "number") out.push([k, String(e)]); });
      } else walk(v, depth + 1);
    }
  };
  walk(input, 0);
  return out;
}

export interface EarlierCall { tool: string; failed: boolean; kept: KeptCall }

/**
 * The earlier read of the same item: among `earlier` (the task's calls on the same server before this one, oldest first), the latest that is read-only
 * by credit-guard's one predicate, did not fail, and whose input shares an id-valued field (same name, equal value) with `input`.
 */
export function pickEarlierRead(input: unknown, earlier: EarlierCall[]): EarlierCall | undefined {
  const mine = idPairs(input);
  if (mine.length === 0) return undefined;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const e = earlier[i]!;
    if (e.failed || !isReadOnlyMcpTool(e.tool) || failureOf(e.kept.response, false) !== undefined) continue;
    const theirs = idPairs(e.kept.input);
    if (theirs.some(([k, v]) => mine.some(([mk, mv]) => mk === k && mv === v))) return e;
  }
  return undefined;
}

/** The card. `kept` is null when nothing was kept for the call; `earlier` is the earlier read, when there is one. */
export function mcpCardOf(call: { server: string; tool: string; failed: boolean }, kept: KeptCall | null, earlier?: EarlierCall): McpCard {
  const server = spoken(call.server);
  const head = MCP_WORDS.asked(spoken(call.tool));
  if (kept === null) {
    return call.failed
      ? { title: MCP_WORDS.title(server), intent: { head, lines: [MCP_WORDS.noInput] }, reply: { lines: [], failed: MCP_WORDS.failed(MCP_WORDS.noReason) } }
      : { title: MCP_WORDS.title(server), credit: MCP_WORDS.agentDid, intent: { head, lines: [MCP_WORDS.noInput] }, reply: { lines: [], none: MCP_WORDS.noReply } };
  }
  const input = partOf(kept.input, kept.cut.input);
  const failure = failureOf(kept.response, call.failed);
  const reply = partOf(kept.response, kept.cut.response);
  const card: McpCard = {
    title: MCP_WORDS.title(server),
    intent: { head, lines: input.lines.length === 0 ? [MCP_WORDS.noInput] : input.lines, ...(input.cut === undefined ? {} : { cut: input.cut }) },
    reply: failure !== undefined ? { lines: [], failed: MCP_WORDS.failed(failure) } : reply.lines.length === 0 ? { lines: [], none: MCP_WORDS.noReply } : { lines: reply.lines, ...(reply.cut === undefined ? {} : { cut: reply.cut }), ...(isThin(reply.raw, input.raw) ? { confirmed: MCP_WORDS.confirmed } : {}) },
  };
  if (failure === undefined && earlier !== undefined) {
    const seen = partOf(earlier.kept.response, earlier.kept.cut.response);
    if (seen.lines.length > 0) card.lastSeen = { head: MCP_WORDS.lastSeen, lines: seen.lines, ...(seen.cut === undefined ? {} : { cut: seen.cut }) };
  }
  // Credit: the agent did the call. Where the only "before" is a transcript read (the earlier read), someone else may have edited in between.
  if (failure === undefined) card.credit = card.lastSeen === undefined ? MCP_WORDS.agentDid : MCP_WORDS.maybeOthers;
  return card;
}

/** The name `keepCallValues` seals a call's values under (src/connector/frozen.ts); a test pins that the two agree. */
export const keptNameOf = (callId: string): string => `${callId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "call"}.json`;

/** A call's kept values, read back and scrubbed again; null when none were kept, they are gone or no longer open. */
export async function readKeptCall(home: string, taskId: number, callId: string): Promise<KeptCall | null> {
  try {
    const bytes = await readSealed(path.join(callsDirOf(home, taskId), keptNameOf(callId)));
    const k = JSON.parse(bytes.toString("utf8")) as Partial<KeptCall>;
    if (typeof k !== "object" || k === null || typeof k.tool !== "string") return null;
    return { tool: k.tool, call: String(k.call ?? callId), input: scrubDeep(k.input ?? null), response: scrubDeep(k.response ?? null), cut: isObj(k.cut) ? (k.cut as KeptCall["cut"]) : {} };
  } catch {
    return null;
  }
}
