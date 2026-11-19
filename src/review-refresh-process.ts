#!/usr/bin/env node
// Detached child of a hook event (see review-refresh.ts): replaces an outdated review server with this install's build, then exits.
// ensureReviewProcess does the real work (build compare, /shutdown, spawn) and logs the replacement in review.log.
import { resolveCoCheckHome } from "./ledger.ts";
import { releaseRefreshLock } from "./review-refresh.ts";
import { ensureReviewProcess } from "./review-server.ts";

const home = resolveCoCheckHome();
try {
  await ensureReviewProcess(home);
} catch (error) {
  console.error("cocheck review-refresh:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  releaseRefreshLock(home);
}
