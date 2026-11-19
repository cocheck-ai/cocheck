// Toy notes connector that uses a published helper: the level-1 notes toy, with its spec constant loaded from the folder CoCheck names in
// COCHECK_HELPERS_DIR (public-kit/spec/v1.md, "Helpers"). It loads the helper the way any outside connector would, by path at run time, and
// refuses to start without the variable, so a run that passes shows the helper was found where CoCheck said it is.
import readline from "node:readline";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const helpers = process.env.COCHECK_HELPERS_DIR;
if (!helpers) {
  process.stderr.write("COCHECK_HELPERS_DIR is not set: this connector runs under CoCheck, which sets it\n");
  process.exit(1);
}
const { CHANGES_SPEC } = await import(pathToFileURL(path.join(helpers, "spec.mjs")).href);

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
  return { spec: CHANGES_SPEC, changes };
}

/**
 * The state of a subject such as toy-helpers:///path/to/notes.json (the toy product keeps its notes in one file): the file's text, or null only when
 * the file positively does not exist (its folder is there and readable, the file is not in it). A read this connector could not do (no file named,
 * a folder that is not there, any other read error) throws, and the message loop answers it as an error: null would tell CoCheck the file is new.
 */
function snapshot(subject) {
  // The subject is a file URL under this connector's scheme. Swap the scheme back to file: and let Node make the path: it decodes %20 and gives
  // C:\Users\... on Windows, where the URL's .pathname would be /C:/Users/... and not a path at all.
  const file = fileURLToPath(subject.replace(/^[a-z][a-z0-9+.-]*:/i, "file:"));
  if (/[\\/]$/.test(file)) throw new Error(`not a notes file: ${subject}`);
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const dir = path.dirname(file);
    if (!statSync(dir).isDirectory()) throw new Error(`not a folder: ${dir}`); // statSync throws when the folder is not there
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
