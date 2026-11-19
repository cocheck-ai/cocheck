import readline from "node:readline";
import { readFileSync } from "node:fs";
// state -> ordered array of {id, pos, text}
function readState(file) {
  const raw = readFileSync(file, "utf8");
  if (raw.trim() === "") return [];
  const nb = JSON.parse(raw);
  if (!nb || !Array.isArray(nb.cells)) throw new Error("not a notebook: no cells");
  const seen = new Set();
  return nb.cells.map((c, i) => {
    let id = typeof c.id === "string" && c.id ? c.id : `cell-${i + 1}`;
    while (seen.has(id)) id += "'";
    seen.add(id);
    const parts = [`[${c.cell_type}] ` + [].concat(c.source ?? []).join("")];
    for (const o of c.outputs ?? []) {
      const t = o.text ?? o.data?.["text/plain"];
      if (t !== undefined) parts.push("[output] " + [].concat(t).join(""));
    }
    return { id, pos: i + 1, text: parts.join("\n") };
  });
}
function lcs(a, b) { // returns Set of ids in a longest common subsequence
  const n = a.length, m = b.length, t = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const keep = new Set(); let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { keep.add(a[i]); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) i++; else j++;
  }
  return keep;
}
function diff(bf, af) {
  const b = readState(bf), a = readState(af), changes = [];
  const bm = new Map(b.map((c) => [c.id, c])), am = new Map(a.map((c) => [c.id, c]));
  const common = (x, other) => x.filter((c) => other.has(c.id)).map((c) => c.id);
  const stay = lcs(common(b, am), common(a, bm));
  for (const c of a) {
    const o = bm.get(c.id);
    if (!o) { changes.push({ id: c.id, mark: "added", label: `Cell ${c.pos}`, after: c.text }); continue; }
    const moved = !stay.has(c.id), edited = o.text !== c.text;
    const where = moved ? `Cell ${c.pos} (moved from ${o.pos})` : `Cell ${c.pos}`;
    if (edited) changes.push({ id: c.id, mark: "changed", label: where, before: o.text, after: c.text });
    else if (moved) changes.push({ id: c.id, mark: "moved", label: where, before: `position ${o.pos}`, after: `position ${c.pos}` });
  }
  for (const c of b) if (!am.has(c.id)) changes.push({ id: c.id, mark: "removed", label: `Cell ${c.pos}`, before: c.text });
  return { spec: "cocheck.changes/1", level: 1, changes };
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
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
