// Test connector (not Office, not shipped): a `.toy` state is JSON `{"pic": "<address>"}`, and the diff answers one image picture per side whose src is
// that address, exactly as written (a data URL, valid or not), plus one change. Level 2. `{"picHex": "<hex>"}` carries the address hex-encoded, so a
// state whose address holds a secret-looking run is not itself a secret-bearing file (the picture is the connector's own output, as an Office export is).
import readline from "node:readline";
import { readFileSync } from "node:fs";

function pic(file) {
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return undefined;
  const state = JSON.parse(text);
  return typeof state.picHex === "string" ? Buffer.from(state.picHex, "hex").toString("utf8") : state.pic;
}

function diff(beforeFile, afterFile) {
  const b = pic(beforeFile), a = pic(afterFile);
  const pictures = [];
  if (typeof b === "string") pictures.push({ id: "before", side: "before", type: "image", label: "Before", src: b });
  if (typeof a === "string") pictures.push({ id: "after", side: "after", type: "image", label: "After", src: a });
  return { spec: "cocheck.changes/1", pictures, changes: [{ id: "c1", mark: "changed", label: "The picture", before: "old", after: "new" }] };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line.replace(/\r$/, ""));
  let reply;
  try {
    if (msg.method === "hello") reply = { result: { spec: "cocheck.connector/1", level: 2, methods: ["diff"] } };
    else if (msg.method === "diff") reply = { result: diff(msg.params.before, msg.params.after) };
    else reply = { error: { code: "unknown-method", message: String(msg.method) } };
  } catch (err) {
    reply = { error: { code: "bad-product-response", message: String(err.message) } };
  }
  process.stdout.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
});
