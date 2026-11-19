// The Windows twin of scripts/hook-launch.sh. The host runs `node hook-launch.mjs COCHECK_MANAGED=1 --home <dir> [--node <path>] <hook.js> [hook args]`
// with the payload on stdin, so no /bin/sh is needed; cmd and PowerShell both start `node` and read the double-quoted paths the same way.
// Same contract as the shell launcher: stdin, stdout and the exit status pass through; stderr is captured and re-emitted. On a non-zero exit it
// writes the reason to <home>/not-recording.txt (the same wording), and the next hook that exits 0 deletes the file.
// Bound: "Node was not found" is not handled here. This file runs under Node, so when the host cannot start `node` nothing of CoCheck runs
// and nothing can be written; `cocheck status` shows that case as a stale last-recorded time instead.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const env = { ...process.env };
let home = env.COCHECK_HOME ?? "";
let pinned = env.COCHECK_NODE ?? "";
for (;;) {
  const a = args[0];
  if (a === "COCHECK_MANAGED=1") env.COCHECK_MANAGED = "1";
  else if (a === "--home" && args.length > 1) {
    home = args[1];
    args.shift();
  } else if (a === "--node" && args.length > 1) {
    pinned = args[1];
    args.shift();
  } else break;
  args.shift();
}
env.COCHECK_HOME = home;
if (pinned !== "") env.COCHECK_NODE = pinned;
const note = home === "" ? "" : path.join(home, "not-recording.txt");

function record(text) {
  if (note === "") return;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(note, `${new Date().toISOString().replace(/\.\d+Z$/, "Z")}\n${text}\n`);
  } catch {
    // best effort, like the shell launcher
  }
}

const hook = args.shift();
if (hook === undefined) {
  process.stderr.write("usage: hook-launch.mjs [COCHECK_MANAGED=1] [--home <dir>] [--node <path>] <hook.js> [hook args]\n");
  process.exit(1);
}
const node = pinned !== "" && existsSync(pinned) ? pinned : process.execPath;
const r = spawnSync(node, [hook, ...args], { env, stdio: ["inherit", "inherit", "pipe"], encoding: "utf8" });
const err = r.stderr ?? "";
const status = r.status ?? 1;
if (r.error !== undefined || status !== 0) {
  const why = r.error !== undefined ? `could not start the hook: ${r.error.message}` : "";
  const version = spawnSync(node, ["--version"], { encoding: "utf8" }).stdout?.trim();
  record(`The hook exited ${status} under Node ${version || "unknown"} (CoCheck needs 22.18 or newer): ${why || err.slice(-400)}`);
  if (err !== "") process.stderr.write(err.endsWith("\n") ? err : `${err}\n`);
  process.exit(status);
}
if (note !== "") rmSync(note, { force: true });
if (err !== "") process.stderr.write(err.endsWith("\n") ? err : `${err}\n`);
