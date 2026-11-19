// Run as a child of the status command: `node codex-trust-probe.ts <codex bin> <codex home>`. Starts `codex app-server`, keeps its stdin
// open until the hooks/list reply (id 2) or the deadline, prints the reply's `result` as one JSON line, then ends the app-server for good.
// `codex app-server` exits when its stdin closes, so closing stdin early (spawnSync) loses the answer.
import { spawn } from "node:child_process";
import path from "node:path";
import { codexSpawnPlan } from "./codex-bin.ts";
import { endChild } from "../platform/index.ts";

const [bin, home] = process.argv.slice(2);
const DEADLINE_MS = Number(process.env.COCHECK_CODEX_PROBE_MS) || 8000;
const plan = codexSpawnPlan(bin);
const child = spawn(plan.command, ["app-server"], { shell: plan.shell, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CODEX_HOME: home } });
let buf = "";
let done = false;
const finish = (result: unknown): void => {
  if (done) return;
  done = true;
  if (result !== undefined) process.stdout.write(JSON.stringify(result) + "\n");
  child.stdin.end();
  // On Windows the app-server runs under cmd.exe (a .cmd shim): its whole tree is ended, not the shell alone.
  endChild(child, "SIGTERM");
  setTimeout(() => endChild(child, "SIGKILL"), 1000).unref();
  child.once("exit", () => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
child.on("error", () => finish(undefined));
child.stdin.on("error", () => {});
child.stdout.on("data", (d: Buffer) => {
  buf += d.toString("utf8");
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      if (m?.id === 2 && m.result !== undefined) return finish(m.result);
    } catch {
      // not a JSON-RPC line
    }
  }
});
child.on("exit", () => finish(undefined));
setTimeout(() => finish(undefined), DEADLINE_MS).unref();
const lines = [
  { id: 1, method: "initialize", params: { clientInfo: { name: "cocheck", title: "CoCheck", version: "0" } } },
  { method: "initialized" },
  { id: 2, method: "hooks/list", params: { cwds: [path.dirname(home)] } },
];
child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
