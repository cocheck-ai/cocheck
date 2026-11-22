// GitHub Copilot's first-party code that is not data: the reader of a session's events.jsonl (the words before a call, the closing message, where the file is).
// The rest of the host is the manifest, harnesses/copilot/cocheck-harness.json. Facts (platforms/copilot-cli/, platforms/copilot-vscode/): the hook stdin
// carries no call id, but the session's events.jsonl lists each tool request with its id, name and arguments, and a commentary `assistant.message` holds the words before the call.
import { homedir } from "node:os";
import path from "node:path";
import { CLOSING_MAX, NARRATION_MAX, cut, remember, type NarrationCursor } from "../narration.ts";
import { argsKey } from "./shared.ts";

export { argsKey };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_LINE = /"type"\s*:\s*"(?:assistant|user)\.message"/;

/** One line of a session's events.jsonl. Only assistant and user messages are parsed. */
export function copilotLine(cur: NarrationCursor, line: string): void {
  if (!MESSAGE_LINE.test(line)) return;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  const data = d?.data;
  if (data === null || typeof data !== "object") return;
  if (d.type === "user.message") {
    // A user.message with a `source` (a helper's task prompt, "agent-<session>") is not a new turn of the main line.
    if (typeof data.source !== "string") cur.closing = undefined;
    return;
  }
  if (d.type !== "assistant.message") return;
  const content = typeof data.content === "string" ? data.content : "";
  if (data.phase === "final_answer") {
    // A helper's final answer (it names the task call that launched it) lands in the same file; the closing is the main agent's.
    if (typeof data.parentToolCallId === "string" && data.parentToolCallId !== "") return;
    if (content.trim() !== "") cur.closing = cut(content, CLOSING_MAX);
    return;
  }
  if (data.phase !== "commentary" || !Array.isArray(data.toolRequests)) return;
  const text = cut(content, NARRATION_MAX);
  for (const req of data.toolRequests) {
    if (req === null || typeof req !== "object" || typeof req.toolCallId !== "string" || typeof req.name !== "string") continue;
    const reason = typeof req.intentionSummary === "string" && req.intentionSummary.trim() !== "" ? cut(req.intentionSummary, NARRATION_MAX) : undefined;
    const held = cur.byId[req.toolCallId];
    remember(cur, req.toolCallId, {
      text,
      ...(reason === undefined ? {} : { reason }),
      call: { name: req.name, argsKey: argsKey(parseArgs(req.arguments)) },
      // A line read again (the file was rotated) must not free a request a Pre already claimed.
      ...(held !== undefined && "taken" in held && held.taken === true ? { taken: true as const } : {}),
    });
  }
}

/** Tool arguments as an object: JSON text that holds an object is parsed; anything else passes through. */
function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    // A JSON-encoded string (a patch sent as text inside quotes) is the text itself; any other scalar stays as sent.
    return parsed !== null && typeof parsed === "object" ? parsed : typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

/** `<root>/<session>/events.jsonl`; `root` defaults to `$COPILOT_HOME/session-state`. Only a full uuid names a session folder. */
export function locateEvents(session: string, _now: number, root?: string): string | undefined {
  if (!UUID.test(session)) return undefined;
  if (root === undefined && !process.env.COPILOT_HOME && process.env.NODE_TEST_CONTEXT) {
    throw new Error("COPILOT_HOME is unset under the test runner; refusing to fall back to the real ~/.copilot/session-state");
  }
  const base = root ?? path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "session-state");
  return path.join(base, session, "events.jsonl");
}
