// Fixture: answers hello, then never answers diff (a connector that hangs).
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "hello") process.stdout.write(JSON.stringify({ id: msg.id, result: { spec: "cocheck.connector/1", level: 1, methods: ["diff"] } }) + "\n");
});
