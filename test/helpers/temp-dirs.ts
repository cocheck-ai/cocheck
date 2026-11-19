// Temp folders a test helper makes for a whole test file: removed when the test process exits, so a run does not leave them in the OS
// temp folder (tens of thousands of office-fake-stage-, office-lock- and cocheck-migration-home- folders had piled up on a dev Mac).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const made: string[] = [];

function removeAll(): void {
  for (const d of made.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // a folder another process still holds (Windows) is left for the run's temp folder cleanup
    }
  }
}

/** A new folder `<os temp>/<prefix>XXXXXX`, removed when this process exits. */
export function tempDirRemovedAtExit(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  if (made.push(dir) === 1) process.once("exit", removeAll);
  return dir;
}
