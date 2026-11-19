// Toy tracker connector, entry "diff", level 1: a product that keeps its own change history (public-kit/spec/README.md, "Diffs for diff-entry connectors").
// CoCheck learns the issue from `matches.subjects` (the template turns the MCP call's input into toy-tracker://issue/<issue_id>) and, after the call,
// asks `diffs` with the call's window: the history entries of that issue whose own time is in since <= time < until.
// The product here is one JSON file of history (a real connector calls the tracker's API). In production the file is TOY_TRACKER_HISTORY, a variable the
// manifest lists in permissions.env. While `cocheck connector test` runs, COCHECK_TEST_SAMPLES names this folder's samples/ folder, and the toy answers
// from samples/history.json, the history the author recorded, never from the live product.
import readline from "node:readline";
import { readFileSync } from "node:fs";
import path from "node:path";

function historyFile() {
  if (process.env.COCHECK_TEST_SAMPLES) return path.join(process.env.COCHECK_TEST_SAMPLES, "history.json");
  if (process.env.TOY_TRACKER_HISTORY) return process.env.TOY_TRACKER_HISTORY;
  throw new Error("no history: set TOY_TRACKER_HISTORY to the history file");
}

/**
 * The changes to one issue in a window. A read this connector could not do (no history, an issue it may not read, an issue it does not know) throws,
 * and the message loop answers it as an error: an empty list would tell CoCheck that nothing changed, and the change would be lost.
 */
function diffs({ subject, since, until }) {
  const id = decodeURIComponent(new URL(subject).pathname.replace(/^\//, ""));
  const history = JSON.parse(readFileSync(historyFile(), "utf8"));
  if ((history.denied ?? []).includes(id)) throw new Error(`no access to issue ${id}`);
  const entries = history.issues?.[id];
  if (!Array.isArray(entries)) throw new Error(`no such issue: ${id}`);
  const from = Date.parse(since), to = Date.parse(until);
  const changes = entries
    .filter((e) => Date.parse(e.time) >= from && Date.parse(e.time) < to)
    .map((e) => ({ id: e.field, mark: "changed", label: e.label, before: e.before, after: e.after }));
  return { spec: "cocheck.changes/1", changes };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line.replace(/\r$/, ""));
  let reply;
  try {
    if (msg.method === "hello") reply = { result: { spec: "cocheck.connector/1", level: 1, methods: ["diffs"] } };
    else if (msg.method === "diffs") reply = { result: diffs(msg.params) };
    else reply = { error: { code: "unknown-method", message: String(msg.method) } };
  } catch (err) {
    reply = { error: { code: "bad-product-response", message: String(err.message) } };
  }
  process.stdout.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
});
