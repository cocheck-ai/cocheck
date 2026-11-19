// A client process for the lifecycle tests: starts a WinHost on the fake host, says hello, prints the host pid, then either
// exits at once with the program's exit hook installed ("exit") or waits to be killed ("wait"). argv: <mode> <fake host mode> [marker].
import { fileURLToPath } from "node:url";
import { WinHost } from "../../../src/office/connector/office-win.ts";
import { closeDriverOnExit } from "../../../src/office/connector/program.ts";

const [mode, hostMode, marker] = process.argv.slice(2);
const host = new WinHost({ command: { command: process.execPath, args: [fileURLToPath(new URL("./fake-host.mjs", import.meta.url)), hostMode, ...(marker ? [marker] : [])] } });
closeDriverOnExit({ closeSync: () => host.closeSync() });
const hello = await host.hello(5_000);
process.stdout.write(`${JSON.stringify({ pid: host.pid, hello })}\n`);
if (mode === "exit") process.exit(0);
setInterval(() => undefined, 1_000);
