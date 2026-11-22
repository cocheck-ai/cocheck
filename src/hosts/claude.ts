// Claude Code's first-party extras (harnesses/claude/cocheck-harness.json names them): reading the transcript (the words before a call and the closing
// message, the calls it holds, a withheld input field) and finding a helper's own files. Everything that is data lives in the manifest.
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import readline from "node:readline";
import path from "node:path";
import { CLOSING_MAX, NARRATION_MAX, joined, remember, type NarrationCursor } from "../narration.ts";
import type { HostProfile } from "./types.ts";

const ASSISTANT_LINE = /"type"\s*:\s*"assistant"/;
const USER_LINE = /"type"\s*:\s*"user"/;

/** One line of a Claude Code transcript. Only assistant lines are parsed. */
export function claudeLine(cur: NarrationCursor, line: string): void {
  if (!ASSISTANT_LINE.test(line)) {
    // A user line that is not a tool result starts a new turn: text before it was the last turn's closing words.
    if (USER_LINE.test(line) && !line.includes('"tool_result"')) {
      cur.pending = [];
      cur.msg = undefined;
    }
    return;
  }
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  if (d === null || typeof d !== "object" || d.type !== "assistant" || (d.isSidechain === true && cur.agent !== true)) return;
  const content = d.message?.content;
  if (!Array.isArray(content)) return;
  const msgId = typeof d.message?.id === "string" ? d.message.id : undefined;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.trim() !== "") cur.pending.push(block.text);
    } else if (block.type === "tool_use" && typeof block.id === "string") {
      const same = cur.msg;
      if (msgId !== undefined && same !== undefined && same.id === msgId) {
        // A parallel call: the first call of the message holds the words, this one points to it.
        if (same.first !== null) remember(cur, block.id, { sameAs: same.first });
        continue;
      }
      const text = joined(cur.pending, NARRATION_MAX);
      cur.pending = [];
      if (text !== "") remember(cur, block.id, { text });
      cur.msg = msgId === undefined ? undefined : { id: msgId, first: text === "" ? null : block.id };
    }
  }
}

/** SessionStart sets the attribution write hooks' environment for the session's Bash calls (CLAUDE_ENV_FILE); it records nothing. Also the manifest's `install.extraEvents`. */
export const CLAUDE_EXTRA_EVENTS: readonly string[] = ["SessionStart"];

/** The longest transcript line read when looking for one call (a whole brief sits in one line). */
const REVEAL_LINE_MAX = 8 * 1024 * 1024;

/**
 * The raw string `field` of the input of the tool_use block `toolUseId` in a Claude Code transcript (JSON lines); undefined when the
 * block or field is not there. Read only, line by line; the caller has already checked the file is a regular file under the profile root.
 */
export async function claudeFieldText(file: string, toolUseId: string, field: string): Promise<string | undefined> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > REVEAL_LINE_MAX || !line.includes(toolUseId) || !line.includes('"tool_use"')) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const content = rec?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "tool_use" && b.id === toolUseId) {
          const v = b.input?.[field];
          return typeof v === "string" ? v : undefined;
        }
      }
    }
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Where a Claude Code session keeps its helpers' own records, beside the session file. */
export const CLAUDE_HELPERS: NonNullable<HostProfile["helpers"]> = {
  dirOf: (sessionFile, session) => path.join(path.dirname(sessionFile), session, "subagents"),
  transcriptFile: (agentId) => `agent-${agentId}.jsonl`,
  metaFile: (agentId) => `agent-${agentId}.meta.json`,
  idOfTranscript: (name) => name.slice("agent-".length, -".jsonl".length),
  idOfMeta: (name) => name.slice("agent-".length, -".meta.json".length),
  transcriptName: /^agent-.+\.jsonl$/,
  metaName: /^agent-.+\.meta\.json$/,
  folderName: "subagents",
  // Under the node test runner the `~/.claude` default is refused, so a test cannot read the real transcripts.
  projectsRoot: () => {
    if (!process.env.CLAUDE_CONFIG_DIR && process.env.NODE_TEST_CONTEXT) {
      throw new Error("CLAUDE_CONFIG_DIR is unset under the test runner; refusing to fall back to the real ~/.claude/projects");
    }
    return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects");
  },
};

/** The closing words a Claude Code cursor holds. */
export const claudeClosing = (cur: NarrationCursor | undefined): string => joined(cur?.pending ?? [], CLOSING_MAX);
