// Toy notes connector, level 3: the level-1 change list plus one text picture per side and a box (a line range) on each change (public-kit/spec/v1.md).
// A text picture shows its side's state file, so a box says which lines of that file the change sits on. Declares `level: 3` in hello.
import readline from "node:readline";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readState(file) {
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return { text, notes: new Map() };
  const state = JSON.parse(text);
  if (!state || !Array.isArray(state.notes)) throw new Error(`not a notes state: ${file}`);
  return { text, notes: new Map(state.notes.map((n) => [n.id, n.text])) };
}

/** The lines of a note in the state file: from the line with its id to the line with its text (1-based). */
function linesOf(text, id) {
  const lines = text.split(/\r\n|\n|\r/);
  const at = lines.findIndex((l) => l.includes(`"id": ${JSON.stringify(id)}`));
  if (at < 0) return undefined;
  let to = at;
  for (let i = at; i < Math.min(lines.length, at + 3); i++) if (lines[i].includes('"text":')) to = i;
  return { from: at + 1, to: to + 1 };
}

function diff(beforeFile, afterFile) {
  const b = readState(beforeFile);
  const a = readState(afterFile);
  const changes = [];
  const box = (side, state, id) => {
    const lines = linesOf(state.text, id);
    return lines === undefined ? [] : [{ picture: side, lines }];
  };
  for (const [id, text] of a.notes) {
    if (!b.notes.has(id)) changes.push({ id, mark: "added", label: `Note ${id}`, after: text, boxes: box("after", a, id) });
    else if (b.notes.get(id) !== text) changes.push({ id, mark: "changed", label: `Note ${id}`, before: b.notes.get(id), after: text, boxes: [...box("before", b, id), ...box("after", a, id)] });
  }
  for (const [id, text] of b.notes) if (!a.notes.has(id)) changes.push({ id, mark: "removed", label: `Note ${id}`, before: text, boxes: box("before", b, id) });
  return {
    spec: "cocheck.changes/1",
    pictures: [
      { id: "before", side: "before", type: "text", label: "Before" },
      { id: "after", side: "after", type: "text", label: "After" },
    ],
    changes,
  };
}

/**
 * The state of a subject such as toy-level-3:///path/to/notes.json (the toy product keeps its notes in one file): the file's text, or null only when
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
    if (msg.method === "hello") reply = { result: { spec: "cocheck.connector/1", level: 3, methods: ["snapshot", "diff"] } };
    else if (msg.method === "snapshot") reply = { result: { subject: msg.params.subject, state: snapshot(msg.params.subject) } };
    else if (msg.method === "diff") reply = { result: diff(msg.params.before, msg.params.after) };
    else reply = { error: { code: "unknown-method", message: String(msg.method) } };
  } catch (err) {
    reply = { error: { code: "bad-product-response", message: String(err.message) } };
  }
  process.stdout.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
});
