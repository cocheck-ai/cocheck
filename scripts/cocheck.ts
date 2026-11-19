#!/usr/bin/env node
/** The source-checkout entry: `node scripts/cocheck.ts <command>`. The commands live in src/cli.ts, which also builds into dist/ for the packaged `cocheck`. */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";

export { runOpen, versionText, type CliResult, type OpenRun } from "../src/cli.ts";

// Run only as the entry point, so a test can import runOpen.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = await main(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
