#!/usr/bin/env node
// A fake of src/office/connector/native/cocheck-screen.m for tests: the same JSON lines (`windows` and `close` only, as the real helper), no windows listed from the system. FAKE_MODE:
// normal | hang (`windows` never answers) | die (exits on `windows`) | garbage (junk lines between answers) | silent (never says ready).
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MODE ?? "normal";
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
process.on("SIGTERM", () => process.exit(0));
const maxIdx = process.argv.indexOf("--max-ms");
if (maxIdx > 0) setTimeout(() => process.exit(0), Number(process.argv[maxIdx + 1]));
if (mode !== "silent") say({ ok: true, ready: true, pid: process.pid });
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const r = JSON.parse(line);
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${r.cmd}\n`);
  const reply = (o) => say({ ...o, ...(r.req !== undefined ? { req: r.req } : {}) });
  if (mode === "garbage") process.stdout.write("not json at all\n[1,2]\n");
  switch (r.cmd) {
    case "windows": if (mode === "die") process.exit(1); if (mode === "hang") return; return reply({ ok: true, windows: [{ id: 5, layer: 0, bounds: { x: 3020, y: 40, w: 1560, h: 940 }, onscreen: false, title: "a.xlsx" }] });
    case "close": reply({ ok: true }); return setTimeout(() => process.exit(0), 20);
    default: return reply({ ok: false, why: "unknown command" });
  }
});
rl.on("close", () => process.exit(0));
