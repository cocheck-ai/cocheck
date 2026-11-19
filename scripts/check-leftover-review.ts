#!/usr/bin/env node
// Lists review processes whose COCHECK_HOME is under the OS temp dir; exits 1 if any. Runs after the suite
// (`npm run test:check-leftovers`). Read-only: it never stops anything.
import { tempReviewProcesses } from "./lib/review-procs.ts";

const left = tempReviewProcesses();
for (const p of left) console.log(`leftover review process pid=${p.pid} COCHECK_HOME=${p.home}`);
console.log(left.length === 0 ? "no leftover review processes under the temp dir" : `${left.length} leftover review process(es)`);
process.exit(left.length === 0 ? 0 : 1);
