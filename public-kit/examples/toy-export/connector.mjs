// Toy notes connector, export mode: answers export({subject}) with { text }, the item as plain text (public-kit/spec/v1.md). It does not diff:
// CoCheck stores the text of each side and draws the difference with its own text renderer. Here the subject is the path of a notes state file.
import readline from "node:readline";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function exportText(file) {
  // A toy-export:///... subject is a file URL under this connector's scheme: fileURLToPath makes it a path on every system (C:\... on Windows).
  const text = readFileSync(file.startsWith("toy-export:") ? fileURLToPath(file.replace(/^toy-export:/, "file:")) : file, "utf8");
  if (text.trim() === "") return "";
  const state = JSON.parse(text);
  if (!state || !Array.isArray(state.notes)) throw new Error(`not a notes state: ${file}`);
  return state.notes.map((n) => `${n.id}: ${n.text}`).join("\n") + "\n";
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line.replace(/\r$/, ""));
  let reply;
  try {
    if (msg.method === "hello") reply = { result: { spec: "cocheck.connector/1", methods: ["export"] } };
    else if (msg.method === "export") reply = { result: { text: exportText(msg.params.subject) } };
    else reply = { error: { code: "unknown-method", message: String(msg.method) } };
  } catch (err) {
    reply = { error: { code: "bad-product-response", message: String(err.message) } };
  }
  process.stdout.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
});
