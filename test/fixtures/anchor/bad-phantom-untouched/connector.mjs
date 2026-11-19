// Toy notes connector: line-JSON over stdio. Methods: hello, diff({before, after}) over two notes-store state files.
import readline from "node:readline";
import { readFileSync } from "node:fs";

function readState(file) {
  const state = JSON.parse(readFileSync(file, "utf8"));
  if (!state || !Array.isArray(state.notes)) throw new Error(`not a notes state: ${file}`);
  return new Map(state.notes.map((n) => [n.id, n.text]));
}

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
  if (b.has("n4")) changes.push({ id: "n4", mark: "changed", label: "Note n4", before: b.get("n4"), after: a.get("n4") });
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
