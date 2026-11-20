// Fixture: a level-1 connector for the warm-process tests. Every start appends its pid to spawns.log in its folder, so a test counts spawns.
// The after state's text picks what the diff does: HANG never answers; DIE exits before answering; DIE-ONCE does that only in the first process
// (a marker file in its folder says it happened). A file named epipe in its folder makes every process close its input right after hello and stay up,
// so the next request CoCheck writes fails with EPIPE; epipe-once does that only in the first process. That mode reads hello with plain
// synchronous reads and never opens process.stdin: closing fd 0 under a live libuv watcher aborts Node (SIGABRT) on some macOS builds. Otherwise it answers one `changed`
// change whose label is the after text, from its two inputs only. The hello of a process that started after the marker says nothingChanged.
// With IGNORE_EOF set in its folder (a file named ignore-eof), it keeps running after its input closes, like a connector that never checks.
// A hello that carries a credential named token makes every label end in " key:" and the first 8 hex of the token's sha256 (never the
// value). SLOW answers after 1.5 s; with a file named ignore-term in its folder the process ignores SIGTERM, so its late answer is really written, and
// it appends "late <pid>" to late.log once that answer is out.
import readline from "node:readline";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, readFileSync, readSync, writeFileSync } from "node:fs";

appendFileSync("spawns.log", `${process.pid}\n`);
const second = existsSync("once.marker");
if (existsSync("ignore-eof")) setInterval(() => {}, 1 << 30);
if (existsSync("ignore-term")) process.on("SIGTERM", () => {});
let key = "";
const once = (word) => { if (existsSync("once.marker")) return false; writeFileSync("once.marker", word); return true; };

const helloAnswer = (id) => JSON.stringify({ id, result: { spec: "cocheck.connector/1", methods: ["diff"], level: 1, ...(second ? { nothingChanged: true } : {}) } }) + "\n";

if (existsSync("epipe") || (existsSync("epipe-once") && once("EPIPE"))) {
  // Read the hello line straight from fd 0, close fd 0, and only then answer, so CoCheck's next request cannot already be sitting in the pipe.
  let got = "";
  const buf = Buffer.alloc(4096);
  while (!got.includes("\n")) {
    let n;
    try { n = readSync(0, buf, 0, buf.length, null); } catch (e) { if (e.code === "EAGAIN") continue; throw e; }
    if (n === 0) process.exit(0);
    got += buf.toString("utf8", 0, n);
  }
  closeSync(0);
  process.stdout.write(helloAnswer(JSON.parse(got.slice(0, got.indexOf("\n"))).id));
  setTimeout(() => {}, 30_000);
} else {
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "hello") {
    const token = msg.params?.credentials?.token;
    if (typeof token === "string") key = ` key:${createHash("sha256").update(token).digest("hex").slice(0, 8)}`;
    process.stdout.write(helloAnswer(msg.id));
    return;
  }
  const before = readFileSync(msg.params.before, "utf8").trim();
  const after = readFileSync(msg.params.after, "utf8").trim();
  if (after === "HANG") return;
  if (after === "SLOW") {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { spec: "cocheck.changes/1", changes: [{ id: "k1", mark: "changed", label: "SLOW" + key, before, after }] } }) + "\n", () => appendFileSync("late.log", `late ${process.pid}\n`));
    }, 1500);
    return;
  }
  if (after === "DIE" || (after === "DIE-ONCE" && once(after))) process.exit(3);
  const changes = before === after ? [] : [{ id: "k1", mark: "changed", label: after + key, before, after }];
  process.stdout.write(JSON.stringify({ id: msg.id, result: { spec: "cocheck.changes/1", changes } }) + "\n");
});
}
