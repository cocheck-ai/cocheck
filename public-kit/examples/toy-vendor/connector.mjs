// Toy vendor connector, level 1: a product the agent reaches through an MCP server, not through a file (public-kit/GUIDE.md, "A product reached through MCP").
// CoCheck learns the item from `matches.subjects` (the template turns the MCP call's input into toy-vendor://note/<note_id>), asks `snapshot` of that URI before and
// after the call, and asks `diff` of the two states it sealed. The product here is a folder of JSON files, one per note (a real connector calls the vendor's API).
// While `cocheck connector test` runs, COCHECK_TEST_STATES names the states folder; the toy answers snapshot from <note_id>.json in it. In production the folder
// is TOY_VENDOR_STORE, a variable the manifest lists in permissions.env.
import readline from "node:readline";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

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
  for (const [id, text] of b) if (!a.has(id)) changes.push({ id, mark: "removed", label: `Note ${id}`, before: text });
  return { spec: "cocheck.changes/1", changes };
}

/**
 * The state of toy-vendor://note/<note_id>: the note file's text, or null only when the note positively does not exist (the store is readable and
 * the note's file is not in it). A read this connector could not do (no store set, a store folder that is not there, an unusable id, any other read
 * error) throws, and the message loop answers it as an error: null would tell CoCheck the note is new, and it would show "created" for a note that existed.
 */
function snapshot(subject) {
  const id = decodeURIComponent(new URL(subject).pathname.replace(/^\//, ""));
  const dir = process.env.COCHECK_TEST_STATES ?? process.env.TOY_VENDOR_STORE;
  if (!dir) throw new Error("no store: set TOY_VENDOR_STORE to the notes folder");
  if (!id || id === "." || id === ".." || /[\\/]/.test(id)) throw new Error(`not a note id: ${JSON.stringify(id)}`);
  try {
    return readFileSync(path.join(dir, `${id}.json`), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    if (!statSync(dir).isDirectory()) throw new Error(`the store is not a folder: ${dir}`); // statSync throws when the store is not there
    return null;
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line.replace(/\r$/, ""));
  let reply;
  try {
    if (msg.method === "hello") reply = { result: { spec: "cocheck.connector/1", level: 1, methods: ["snapshot", "diff"] } };
    else if (msg.method === "snapshot") reply = { result: { subject: msg.params.subject, state: snapshot(msg.params.subject) } };
    else if (msg.method === "diff") reply = { result: diff(msg.params.before, msg.params.after) };
    else reply = { error: { code: "unknown-method", message: String(msg.method) } };
  } catch (err) {
    reply = { error: { code: "bad-product-response", message: String(err.message) } };
  }
  process.stdout.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
});
