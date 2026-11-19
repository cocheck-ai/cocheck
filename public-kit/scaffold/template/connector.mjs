// Starter connector: line-JSON over stdio. It answers two methods, hello and diff({before, after}), where before and
// after are paths to two state files. It declares level 1 in hello and answers a cocheck.changes/1 change list in words
// (../../spec/v1.md): each change says where it is (label), what kind it is (mark) and what it was and is (before, after).
// Runs on plain Node with no dependencies.
// Two places are yours to change, both marked "REPLACE" below: how a state file is read, and how a change is described.
import readline from "node:readline";
import { readFileSync } from "node:fs";

// REPLACE 1 - reading. Turn one state file into a Map of entity id -> text. This starter reads { "notes": [{ "id", "text" }] },
// the shape of the kit's toy states. Read your own product's file format here.
function readState(file) {
  const text = readFileSync(file, "utf8");
  // An empty file is a state that did not exist (a create has an empty before, a delete an empty after): no entities, not an error.
  if (text.trim() === "") return new Map();
  const state = JSON.parse(text);
  if (!state || !Array.isArray(state.notes)) throw new Error(`not a state file this connector can read: ${file}`);
  return new Map(state.notes.map((n) => [n.id, n.text]));
}

// REPLACE 2 - change mapping. Compare the two Maps and describe each difference as a change. A change has an id (unique in the
// answer), a mark (added, removed, changed, moved or described), a label (where it is, in words) and the before and after words
// (leave out the side that does not exist). The same two states must always give the same document.
function diff(before, after) {
  const b = readState(before);
  const a = readState(after);
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

// Below this line: the line-JSON loop. You should not need to change it.
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
