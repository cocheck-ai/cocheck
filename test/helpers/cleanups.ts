/**
 * Runs a test's cleanups last in, first out, and every one of them even when one throws (the first error is rethrown after all have run).
 * A rig's home is pushed before the server that opens its ledger, so last in, first out closes the server and its ledger before the home goes:
 * Windows refuses to remove an open file (EBUSY). And a cleanup that throws must not skip a later server close, or that listening server keeps
 * the test file's process alive until the CI job cap ends the run.
 */
export async function runCleanups(list: Array<() => unknown>): Promise<void> {
  let first: unknown;
  let failed = false;
  for (const c of list.splice(0).reverse()) {
    try {
      await c();
    } catch (error) {
      if (!failed) first = error;
      failed = true;
    }
  }
  if (failed) throw first;
}
