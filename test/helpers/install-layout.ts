/**
 * Core imports the published helpers statically (`../../public-kit/helpers/*.mjs` from src/ and dist/), so a scratch layout that
 * holds src/ or dist/ needs public-kit/ beside it, as every real install has it (the Homebrew formula's libexec, the npm and Windows tarballs, a
 * checkout). Copies the repo's public-kit into `root` the way the installs do: a real folder, not a link.
 */
import { cpSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");

/** Copies the repo's public-kit to `<root>/public-kit`, the sibling of the layout's src/ or dist/. Returns that path. */
export function placeKit(root: string): string {
  const to = path.join(root, "public-kit");
  cpSync(path.join(REPO, "public-kit"), to, { recursive: true });
  return to;
}
