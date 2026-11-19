// Writes a large before/after pair for case C13: node generate-large.mjs <count> <outDir>
// Files: large.before.json, large.after.json. Every 10th note is edited, so the pair holds exactly count/10 edits.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const count = Number(process.argv[2]);
const out = process.argv[3];
if (!Number.isInteger(count) || count < 10 || !out) {
  process.stderr.write("usage: node generate-large.mjs <count >= 10> <outDir>\n");
  process.exit(2);
}
const notes = (edited) => Array.from({ length: count }, (_, i) => ({ id: `n${i}`, text: edited && i % 10 === 0 ? `note ${i} edited` : `note ${i}` }));
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "large.before.json"), JSON.stringify({ notes: notes(false) }));
writeFileSync(path.join(out, "large.after.json"), JSON.stringify({ notes: notes(true) }));
