// Child for the two-process lock test. Commands on stdin: "try", "beat", "release", "exit".
import { OfficeOwner } from "../../src/office/connector/shared/owner.ts";

const [path, staleMs] = [process.argv[2]!, Number(process.argv[3] ?? 60)];
const owner = new OfficeOwner({ path, staleMs, heartbeatMs: 15 });
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c: string) => {
  buf += c;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const cmd = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (cmd === "try") console.log(owner.tryBecomeOwner() ? "owner" : "follower");
    else if (cmd === "release") { owner.release(); console.log("released"); }
    else if (cmd === "exit") process.exit(0);
  }
});
console.log("ready");
