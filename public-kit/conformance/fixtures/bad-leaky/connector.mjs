// Failing fixture for C17: the toy notes connector with state that leaks between diffs. After its first diff it compares each after state
// with the last after state it read, not with the before state it was given, so one process answers a second, different pair wrongly.
import readline from "node:readline";
import { readFileSync } from "node:fs";

function readState(file) {
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return new Map(); // a side that does not exist is an empty file
  const state = JSON.parse(text);
  if (!state || !Array.isArray(state.notes)) throw new Error(`not a notes state: ${file}`);
  return new Map(state.notes.map((n) => [n.id, n.text]));
}

let last;
function diff(before, after) {
  const b = last ?? readState(before);
  const a = readState(after);
  last = a;
  const changes = [];
  for (const [id, text] of a) {
    if (!b.has(id)) changes.push({ id, mark: "added", label: `Note ${id}`, after: text });
    else if (b.get(id) !== text) changes.push({ id, mark: "changed", label: `Note ${id}`, before: b.get(id), after: text });
  }
  for (const [id, text] of b) {
    if (!a.has(id)) changes.push({ id, mark: "removed", label: `Note ${id}`, before: text });
  }
  return { spec: "cocheck.changes/1", changes };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line.replace(/\r$/, ""));
  let reply;
  try {
    if (msg.method === "hello") reply = { result: { spec: "cocheck.connector/1", level: 1, methods: ["diff"] } };
    else if (msg.method === "diff") reply = { result: diff(msg.params.before, msg.params.after) };
    else reply = { error: { code: "unknown-method", message: String(msg.method) } };
  } catch (err) {
    reply = { error: { code: "bad-product-response", message: String(err.message) } };
  }
  process.stdout.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
});
