// A toy product: notes kept in one JSON file shaped { "notes": [{ "id", "text" }] }.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function load(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { notes: [] };
}

export function save(file, state) {
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

export function create(file, id, text) {
  const state = load(file);
  state.notes.push({ id, text });
  save(file, state);
}

export function edit(file, id, text) {
  const state = load(file);
  const note = state.notes.find((n) => n.id === id);
  if (!note) throw new Error(`no note ${id}`);
  note.text = text;
  save(file, state);
}

export function remove(file, id) {
  const state = load(file);
  state.notes = state.notes.filter((n) => n.id !== id);
  save(file, state);
}
