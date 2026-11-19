import { isSecretPath, SECRET_LINE } from "./secret-files.ts";

/** SHA-256 of no bytes. An empty secret-named file holds nothing to protect, so it never makes every empty file a secret. */
export const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * A secret is its bytes, not only its name. The hashes of every secret-named file seen in a task, before or after
 * any change: a state of any other file with one of these hashes holds secret bytes (a rename or a copy of a secret), and is
 * treated exactly like a secret-named file. Derived from the task's recorded states, so the loader, the timeline and the preview
 * route reach the same set the hook does without a second store. A state of any name whose recorded note is the secret line
 * (`SECRET_LINE`, written by the hook when the bytes themselves hold a secret) adds its own hash too.
 */
export function secretShasOf(states: Iterable<{ path: string; sha: string; prev: string | null; note?: string | null }>, isSecret: (path: string) => boolean = isSecretPath): Set<string> {
  const out = new Set<string>();
  for (const s of states) {
    if (!isSecret(s.path)) {
      // The hook found the secret in the bytes (a value a gitleaks rule finds, or a secret file's hash) and recorded the state with the
      // secret line: those bytes are a secret's under any name. Only the state's own bytes: the version before it may hold none.
      if (typeof s.note === "string" && s.note.startsWith(SECRET_LINE) && s.sha && s.sha !== EMPTY_SHA) out.add(s.sha);
      continue;
    }
    if (s.sha && s.sha !== EMPTY_SHA) out.add(s.sha);
    if (s.prev && s.prev !== EMPTY_SHA) out.add(s.prev);
  }
  return out;
}
