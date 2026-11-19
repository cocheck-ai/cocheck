// The PDF helper (native/pdfpages.swift) built once and cached. Four platform test files used to run scripts/build-helpers.mjs
// each (23 s of swiftc apiece for the same binary). Now `ensurePdfHelper` returns the path of a cached build keyed on a hash of the
// Swift source, build-helpers.mjs and the `swiftc --version` text: a hit costs one `swiftc --version`; a miss builds through
// build-helpers.mjs into a temp dir and renames it into place (atomic, so two cold processes cannot corrupt the entry).
// The cache lives in `<repo>/.cocheck/helper-cache/` (git-ignored; never the user's real CoCheck home).
// scripts/run-tests.ts calls this once and hands the path to every test through COCHECK_PDF_HELPER; a test file run alone calls it itself.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(fileURLToPath(import.meta.url), "..", "..", "..");

export interface EnsureOptions {
  /** Where log lines go; default stderr. */
  log?: (line: string) => void;
  /** Overrides the cache folder (tests). */
  cacheRoot?: string;
}

/** Path of the cached pdfpages binary, building it when absent; null when this is not macOS or the build failed. Never throws. */
export function ensurePdfHelper(opts: EnsureOptions = {}): string | null {
  const log = opts.log ?? ((l: string) => console.error(l));
  if (process.platform !== "darwin") return null;
  const ver = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (ver.error || ver.status !== 0) {
    log(`pdf-helper: swiftc unavailable; no helper built`);
    return null;
  }
  const key = createHash("sha256")
    .update(readFileSync(path.join(root, "native", "pdfpages.swift")))
    .update("\0")
    .update(readFileSync(path.join(root, "scripts", "build-helpers.mjs")))
    .update("\0")
    .update(`${ver.stdout}${ver.stderr}`)
    .digest("hex")
    .slice(0, 16);
  const base = opts.cacheRoot ?? path.join(root, ".cocheck", "helper-cache");
  const dir = path.join(base, key);
  const bin = path.join(dir, "pdfpages");
  if (existsSync(bin)) {
    log(`pdf-helper: cache hit ${key}; swiftc builds this run: 0`);
    return bin;
  }
  log(`pdf-helper: cache miss ${key}; swiftc builds this run: 1`);
  mkdirSync(base, { recursive: true });
  const tmp = mkdtempSync(path.join(base, `.build-${key}-`));
  try {
    const built = spawnSync(process.execPath, [path.join(root, "scripts", "build-helpers.mjs"), tmp], { encoding: "utf8" });
    if (built.status !== 0 || !existsSync(path.join(tmp, "pdfpages"))) {
      log(`pdf-helper: build failed (${built.status}) ${built.stderr.trim()}`);
      return null;
    }
    try {
      renameSync(tmp, dir);
    } catch {
      // another process renamed first; its entry is identical
      if (!existsSync(bin)) return null;
    }
    return bin;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** For a test's before(): the path run-tests.ts already set, else the cached build. Sets nothing; returns null when unavailable. */
export function pdfHelperForTest(): string | null {
  const given = process.env.COCHECK_PDF_HELPER;
  if (given && existsSync(given)) return given;
  return ensurePdfHelper();
}
