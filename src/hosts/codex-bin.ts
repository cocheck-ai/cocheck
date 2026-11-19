// Which Codex binary to ask: COCHECK_CODEX_BIN, then `codex` on PATH, then the macOS ChatGPT.app bundle. undefined when none exists.
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { platform, type Platform } from "../platform/index.ts";
import { CODEX_BUNDLED_BIN_MACOS } from "./codex-bin-macos.ts";

const runnable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

// Windows: npm puts an extensionless `codex` sh shim beside codex.cmd and codex.ps1. Node cannot spawn the shim, so only .exe and .cmd count there.
const WIN_NAMES = ["codex.exe", "codex.cmd"];

export function resolveCodexBin(env: NodeJS.ProcessEnv, bundled: string = CODEX_BUNDLED_BIN_MACOS, plat: Platform = platform()): string | undefined {
  if (env.COCHECK_CODEX_BIN) return runnable(env.COCHECK_CODEX_BIN) ? env.COCHECK_CODEX_BIN : undefined;
  const names = plat.name === "win32" ? WIN_NAMES : ["codex"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const file = path.join(dir, name);
      if (runnable(file)) return file;
    }
  }
  return runnable(bundled) ? bundled : undefined;
}

/** How to start a resolved Codex binary: a .cmd or .bat file needs a shell (Node refuses to spawn one directly), the path quoted for it. */
export function codexSpawnPlan(bin: string): { command: string; shell: boolean } {
  return /\.(cmd|bat)$/i.test(bin) ? { command: `"${bin}"`, shell: true } : { command: bin, shell: false };
}
