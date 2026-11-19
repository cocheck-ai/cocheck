import { rm } from "node:fs/promises";
import { stopWarmConnectors } from "../../src/connector/diff.ts";
import { stopAllConnectors } from "../../src/connector/runner.ts";

/**
 * Removes test homes, folders and connector folders. Every connector process this test process started is stopped first and its exit awaited:
 * a live one keeps its connector folder (its working directory, spec "Launch") open, and Windows refuses to remove an open folder (EBUSY). The
 * short bounded retry only covers a transient lock on Windows (a scanner reading a new file); it cannot hide a live process, which holds the
 * folder until it is stopped (a warm one for a minute).
 */
export async function removeHome(...dirs: string[]): Promise<void> {
  await stopWarmConnectors();
  await stopAllConnectors();
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
