// Fixture: a diff answer in the older change-list shape (kind, anchors, confidence), which CoCheck refuses.
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const result = msg.method === "hello"
    ? { spec: "cocheck.connector/1", methods: ["diff"] }
    : { subject: "x", caveats: [], changes: [{ kind: "edit", anchors: [{ entity: "n1" }], confidence: "exact", before: { type: "text", value: "a" }, after: { type: "text", value: "b" } }] };
  process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\n");
});
