// Built-in connector microsoft-excel: the shared Office program (src/office/connector/program.ts) for Microsoft Excel.
// Finds the program where this folder sits: dist/connectors/<id>/ (shipped), or connectors/<id>/ at the repo root (source first, so a stale dist/ is never run; built dist/ only without src/).
import { existsSync } from "node:fs";
const here = (p) => new URL(p, import.meta.url);
const entry = ["../../office/connector/main.js", "../../src/office/connector/main.ts", "../../dist/office/connector/main.js"].map(here).find((u) => existsSync(u));
if (entry === undefined) {
  process.stderr.write("microsoft-excel: the shared Office program was not found next to this connector\n");
  process.exit(1);
}
const { runOfficeConnector } = await import(entry.href);
await runOfficeConnector("excel");
