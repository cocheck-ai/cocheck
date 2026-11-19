// The display invariant, as one reusable check for any page work (it lives in scripts/lib so node's test
// collection, which takes every .ts file under test/, does not run it as a test).
//
// Visible text is the rendered HTML's text content without <script>, <style>, the captured request block and the
// bodies of the raw-text <details class="raw"> controls (src/display.ts `detailsHtml`, the only way a command, tool id,
// full path or hash reaches the page). A <summary> IS visible. Row groups that merely collapse (they hold the rows
// and their reasons) are not raw controls, so their contents stay under the check: stricter than "every <details>".
import type { Ledger } from "../../src/ledger.ts";
import { opReason } from "../../src/reason.ts";
import type { PageRow, ReviewModel } from "../../test/helpers/legacy-review-model.ts";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ldquo: "“", rdquo: "”" };

function decode(text: string): string {
  return text.replace(/&(#\d+|[a-z]+);/gi, (m, e: string) => (e.startsWith("#") ? String.fromCharCode(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)));
}

/** The text nodes a reader sees, in order, with raw-control bodies, scripts, styles and the request block removed. */
export function visibleTextNodes(html: string, options: { includeRequest?: boolean } = {}): string[] {
  let src = html.replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<style\b[\s\S]*?<\/style>/g, "");
  if (options.includeRequest !== true) src = src.replace(/<div class="request"[^>]*>(?:<div[^>]*>[^<]*<\/div>)*<\/div>/g, "");
  const out: string[] = [];
  const raw: Array<{ inSummary: boolean; body: boolean }> = []; // open <details class="raw"> elements
  const tag = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  const other: string[] = []; // every open <details>, so a plain one closes the right element
  for (let m = tag.exec(src); m !== null; m = tag.exec(src)) {
    if (m[4] !== undefined) {
      const hidden = raw.some((r) => r.body) || (raw.length > 0 && !raw[raw.length - 1]!.inSummary);
      const t = decode(m[4]).trim();
      if (!hidden && t !== "") out.push(t);
      continue;
    }
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (name === "details") {
      if (!closing) {
        const isRaw = /class="[^"]*\braw\b/.test(m[3]!);
        other.push(isRaw ? "raw" : "plain");
        if (isRaw) raw.push({ inSummary: false, body: false });
      } else if (other.pop() === "raw") raw.pop();
    } else if (name === "summary" && raw.length > 0 && other[other.length - 1] === "raw") {
      const top = raw[raw.length - 1]!;
      if (!closing) top.inSummary = true;
      else {
        top.inSummary = false;
        top.body = true;
      }
    }
  }
  return out;
}

export const COMMAND_RUN = 24;
const norm = (t: string): string => t.replace(/\s+/g, " ").trim();

/** Every command recorded for `taskId`: the command part of each hook op's intent (never the description). */
export function taskCommands(ledger: Ledger, taskId: number): string[] {
  const out = new Set<string>();
  const last = ledger.roundsForTask(taskId).at(-1)?.lastOpId ?? 0;
  for (const op of ledger.okOpsForTask(taskId, 0, last)) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(op.argsJson) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (args.hookAdapter !== 1 || typeof args.tool_use_id !== "string") continue;
    const c = opReason({ tool: op.tool, intent: op.intent, callId: args.tool_use_id, ...(typeof args.description === "string" ? { description: args.description } : {}) }, "").command;
    if (c !== null) out.add(c);
  }
  return [...out];
}

/**
 * What is wrong with the visible text of `html`; empty when the page passes. `commands` are the task's recorded commands.
 * `allow` lists the cell-sourced texts (`cellSourced`): sheet names, file names, cell places and values, which may hold
 * anything and may repeat a command (a script that writes a value is also in the command).
 */
export function pageViolations(html: string, commands: readonly string[] = [], options: { includeRequest?: boolean; allow?: readonly string[] } = {}): string[] {
  const found: string[] = [];
  const cmds = commands.map(norm).filter((c) => c.length >= COMMAND_RUN);
  const rules: Array<[string, RegExp]> = [
    ["&&", /&&/],
    ["||", /\|\|/],
    ["<<", /<</],
    ["$(", /\$\(/],
    ["${", /\$\{/],
    ["$ and a letter", /\$[A-Za-z]/],
    ["backtick", /`/],
    [" | ", / \| /],
    ["path token starting with / or ~/", /(^|\s)(\/|~\/)\S/],
    ["Windows drive path", /(^|[^A-Za-z])[A-Za-z]:[\\/]/],
    ["__ (tool id)", /__/],
  ];
  for (const raw of visibleTextNodes(html, options)) {
    // Cell values, cell places, sheet names and file names are allowed sources and may hold anything (a path the agent
    // logged in a cell, a label a script wrote): they are removed from the node before any rule runs.
    let node = raw;
    for (const a of options.allow ?? []) if (a !== "") node = node.split(a).join(" ");
    for (const [name, re] of rules) if (re.test(node)) found.push(`${name}: ${raw.slice(0, 120)}`);
    const n = norm(node);
    runs: for (let i = 0; i + COMMAND_RUN <= n.length; i++) {
      const piece = n.slice(i, i + COMMAND_RUN);
      for (const c of cmds) {
        if (c.includes(piece)) {
          found.push(`24-character run of a command: ${piece}`);
          break runs;
        }
      }
    }
  }
  return found;
}

/**
 * The texts a page may show that can legitimately repeat a command: file names, sheet names, and each row's cell place,
 * before and after values and CoCheck-written description (a script that writes a cell value is also in the command).
 * Reasons and intents are never in this list.
 */
export function cellSourced(model: ReviewModel): string[] {
  const out = new Set<string>();
  const row = (r: PageRow): void => {
    for (const t of [r.place, r.before, r.after, r.description]) if (t !== "") out.add(t);
    // a description often embeds the values as `"text"`; the quoted value is a cell value too
    for (const m of r.description.matchAll(/"([^"]+)"/g)) out.add(m[1]!);
  };
  for (const f of model.files) {
    out.add(f.name);
    for (const g of f.sheets) {
      out.add(g.sheet);
      for (const r of [...g.rows, ...g.derived, ...g.flagged.flatMap((x) => [...x.rows, ...x.derived])]) row(r);
    }
    for (const r of f.lowPriority) row(r);
  }
  // The base names of paths the outside list shows (a worked-in folder's name can run long and a command names it too).
  for (const h of model.hookRounds) for (const x of [...h.outside, ...h.workedIn]) if (x.name !== "") out.add(x.name);
  return [...out].sort((a, b) => b.length - a.length);
}
