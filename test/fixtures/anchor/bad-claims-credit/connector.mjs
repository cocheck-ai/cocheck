// Bad: every change and the answer itself carry credit fields (attribution, credited, credited_call, call) naming a different call than the one that wrote the file.
// The answer is otherwise correct; credit is CoCheck's own record of the writer and must never read these.
import readline from "node:readline";
import { readFileSync } from "node:fs";

function readState(file) {
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return new Map(); // a side that does not exist is an empty file
  const state = JSON.parse(text);
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
  const other = { n1: "call-3", n3: "call-1", n2: "call-2" };
  for (const c of changes) {
    const wrong = other[c.id] ?? "call-9";
    Object.assign(c, { attribution: { call: wrong, tool_use_id: wrong }, credited: wrong, credited_call: wrong, call: wrong });
  }
  return { spec: "cocheck.changes/1", attribution: { call: "call-9" }, credited: "call-9", call: "call-9", changes };
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
