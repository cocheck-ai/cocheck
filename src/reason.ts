import { fileBase, gatedReason, UNNAMED_FILE, type Shown } from "./display.ts";

/** The suffix the hook adapter appends to an intent when overlapping calls share the credit for a change. */
const JOINT_SUFFIX = /\s*\[joint attribution: [^\]]*\]\s*$/;
const MAX_REASON = 200;

/** What the review page shows as an op's reason, and the raw command kept behind its "show command" control. */
interface OpReason {
  /** Plain words, safe to show: the host's description, the agent's own intent, or a label naming the tool and file. */
  reason: Shown;
  /** The shell command or tool input behind a hook call; null when the op has none. Never shown as the reason. */
  command: string | null;
}

interface ReasonOp {
  tool: string;
  intent: string;
  /** Set for hook-adapter ops only. */
  callId?: string;
  /** The host-supplied description, when the adapter recorded it (new rows); absent on rows stored as "command - description". */
  description?: string;
  /** The call's narration or its turn's request, recorded by the adapter for a host that has such a source. It is the agent's or the person's own words, so it is not tested for command shape. */
  reasonFallback?: string;
}

const norm = (text: string): string => text.replace(/\s+/g, " ").trim();
/** A run of command text this long, found in a reason, marks the reason as the command. */
export const COMMAND_RUN = 24;

/** Whether `text` shares a run of COMMAND_RUN characters with `command` (both whitespace-normalized). */
function sharesCommandRun(text: string, command: string): boolean {
  const t = norm(text);
  const c = norm(command);
  for (let i = 0; i + COMMAND_RUN <= t.length; i++) if (c.includes(t.slice(i, i + COMMAND_RUN))) return true;
  return false;
}

/**
 * The gate's word test: text that is plainly a person's sentence, not a command. It has no shell operator,
 * variable, redirect or backtick, no path, home reference, Windows drive or tool id, and (for a description
 * recovered from a stored intent) no code punctuation. Against the call's own `command` it is not equal to,
 * contained in or a prefix of the command, does not start with the command's first word, and shares no 24-character
 * run with it.
 */
function readsAsWords(text: string, recovered: boolean, command: string): boolean {
  if (text === "" || /[\n\r\t]/.test(text)) return false;
  if (/&&|\|\||__|[|;$\\`<>]/.test(text)) return false;
  if (/^[/~.-]/.test(text)) return false;
  if (text.split(/\s+/).some((w) => /^(\/|~\/|[A-Za-z]:[\\/])/.test(w))) return false;
  if (recovered) {
    if (/[/=(){}[\]"]/.test(text)) return false;
    if (/(^|\s)-/.test(text)) return false;
    if (text.split(/\s+/).length < 2) return false;
  }
  const t = norm(text).toLowerCase();
  const c = norm(command).toLowerCase();
  if (c !== "") {
    if (c.includes(t)) return false; // equal to, contained in, or a prefix of the command
    if (t.split(" ")[0] === c.split(" ")[0]) return false;
    if (sharesCommandRun(text, command)) return false;
  }
  return true;
}

/** An agent's own reason (a resolution, an intent through CoCheck's tools): shown when it reads as words, else `fallback`. */
export function agentReason(text: string, fallback: Shown): Shown {
  const t = text.trim();
  return readsAsWords(t, false, "") ? gatedReason(clip(t)) : fallback;
}

function clip(text: string): string {
  return text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON - 3)}...`;
}

/** "Bash call on casebook.csv": the tool as words and the file's name, never the command, a path or a tool id. */
function plainLabel(tool: string, filePath: string): Shown {
  const last = tool.split("__").filter(Boolean).pop() ?? tool;
  const name = last.replace(/[_-]+/g, " ").replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim() || "Tool";
  const base = filePath === "" ? "" : fileBase(filePath);
  const file = base === UNNAMED_FILE ? "" : base;
  return file === "" ? gatedReason(`${name} call`) : gatedReason(`${name} call on ${file}`);
}

/**
 * The reason to show for one op that explains a row. A hook op stores "command - description" as its intent: use the
 * recorded description when there is one, else split the stored intent only where the tail reads as words, else fall
 * back to a plain label. The command is never the fallback.
 */
export function opReason(op: ReasonOp, filePath: string): OpReason {
  const label = plainLabel(op.tool, filePath);
  if (op.callId === undefined) return { reason: agentReason(op.intent, label), command: null };
  const full = op.intent.replace(JOINT_SUFFIX, "");
  const shown = (text: string, recovered: boolean, command: string): Shown => {
    const t = text.trim();
    return readsAsWords(t, recovered, command) ? gatedReason(clip(t)) : label;
  };
  if (op.description !== undefined) {
    const desc = op.description.trim();
    const tail = desc === "" ? "" : ` - ${op.description}`;
    const command = tail !== "" && full.endsWith(tail) ? full.slice(0, -tail.length) : full;
    const reason = desc === "" ? fallbackOr(op, label) : shown(desc, false, command);
    return { reason, command: command.trim() === "" || command === op.tool ? null : command };
  }
  const cut = full.lastIndexOf(" - ");
  if (cut > 0) {
    const tail = full.slice(cut + 3).trim();
    const command = full.slice(0, cut);
    if (readsAsWords(tail, true, command)) return { reason: gatedReason(clip(tail)), command };
  }
  return { reason: fallbackOr(op, label), command: full.trim() === "" || full === op.tool ? null : full };
}

/** The recorded narration or request when the call has no reason of its own, else `label`. */
function fallbackOr(op: ReasonOp, label: Shown): Shown {
  const fallback = norm(op.reasonFallback ?? "");
  return fallback === "" ? label : gatedReason(clip(fallback));
}
