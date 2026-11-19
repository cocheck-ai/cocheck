// Misbehaving connector: every second diff answer differs (a 50%-flaky answer). Must fail the same-answer check.
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
  return { spec: "cocheck.changes/1", changes };
}

let calls = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line.replace(/\r$/, ""));
  let reply;
  try {
    if (msg.method === "hello") reply = { result: { spec: "cocheck.connector/1", level: 1, methods: ["diff"] } };
    else if (msg.method === "diff") { const r = diff(msg.params.before, msg.params.after); if (calls++ % 2 === 1) r.caveats = ["flaky"]; reply = { result: r }; }
    else reply = { error: { code: "unknown-method", message: String(msg.method) } };
  } catch (err) {
    reply = { error: { code: "bad-product-response", message: String(err.message) } };
  }
  process.stdout.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
});
