#!/usr/bin/env node
// Copies the connector files tsc does not emit into dist, next to the modules that load them: the Windows Office host script
// src/office/connector/office-win.ps1 -> dist/office/connector/office-win.ps1 (office-win.ts HOST_SCRIPT looks beside itself).
// Called by `npm run build`; `--dist=<dir>` copies into another dist (a test's temp build).
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(fileURLToPath(import.meta.url), "..", "..");
const dist = process.argv.find((a) => a.startsWith("--dist="))?.slice("--dist=".length) ?? path.join(root, "dist");
for (const rel of [path.join("office", "connector", "office-win.ps1")]) {
  mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
  cpSync(path.join(root, "src", rel), path.join(dist, rel));
}
