#!/usr/bin/env node
// Writes build-info.json ({ "builtAt": <ms> }) into the build output directory (default dist/), once,
// at the end of `npm run build`. The review process orders two installed builds by this stamp, so
// it must say when the code was built, not when a file was last copied or checked out.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2] ?? path.join(fileURLToPath(import.meta.url), "..", "..", "dist");
writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({ builtAt: Date.now() }) + "\n");
