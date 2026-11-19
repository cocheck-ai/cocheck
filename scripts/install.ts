#!/usr/bin/env node
// `node scripts/install.ts --home <dir> [--folder <dir>]` installs CoCheck's hooks at the user level; `--uninstall` removes them. See src/install.ts and docs/install.md.
import { runInstall } from "../src/install.ts";

const result = await runInstall({ argv: process.argv, env: process.env, cwd: process.cwd() });
if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exit(result.exitCode);
