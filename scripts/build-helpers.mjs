#!/usr/bin/env node
// Builds the native helpers (pdfpages, the Mac's PDF page drawer, with swiftc into dist/helpers/; cocheck-screen with clang into dist/office/connector/helpers/).
// Called at the end of `npm run build`. No network.
// pdfpages is built once per architecture (arm64 and x86_64) with a minimum macOS of 13 and joined with lipo, so one file runs on
// Intel and Apple Silicon Macs from macOS 13 on. If one architecture fails, the other is kept and the build says so.
// A missing swiftc or a failed compile is a warning, never a failed build: the renderer that needs the helper is simply absent
// and its files fall back (src/timeline/render/registry.ts checks for the binary).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(fileURLToPath(import.meta.url), "..", "..");
// `--dist=<dir>` builds into another dist (a test's temp build); a bare directory argument puts every helper in that one directory.
const distArg = process.argv.find((a) => a.startsWith("--dist="))?.slice("--dist=".length);
const dirArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dist = distArg ?? path.join(root, "dist");
const outDir = dirArg ?? path.join(dist, "helpers");
const out = path.join(outDir, "pdfpages");
const MIN_MACOS = "13.0";
const ARCHS = ["arm64", "x86_64"];

if (process.platform !== "darwin") {
  console.warn("build-helpers: not macOS, skipping pdfpages (PDFs will use the fallback renderer).");
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });
const cache = mkdtempSync(path.join(tmpdir(), "cocheck-swift-"));
const describe = (run) => (run.error ? `unavailable (${run.error.message})` : `failed (exit ${run.status})`);
// cocheck-screen (the print route's window list and launch proof): Office connector code, so its source is src/office/connector/native/cocheck-screen.m
// and it is built into dist/office/connector/helpers/, where src/office/connector/screen-macos.ts looks (a bare directory argument still takes it too).
// Objective-C, built per architecture with clang and joined with lipo, like pdfpages. A failed build
// is a warning: the connector finds no helper, so a prompt on Office's open is not read as one and the launch proof uses whole seconds. Ad hoc signature from the linker only.
function buildScreen() {
  const screenDir = dirArg ?? path.join(dist, "office", "connector", "helpers");
  mkdirSync(screenDir, { recursive: true });
  const screenOut = path.join(screenDir, "cocheck-screen");
  const parts = [];
  for (const arch of ARCHS) {
    const file = path.join(cache, `cocheck-screen-${arch}`);
    const run = spawnSync("clang", ["-fobjc-arc", "-O2", "-arch", arch, `-mmacosx-version-min=${MIN_MACOS}`, "-framework", "Foundation", "-framework", "CoreGraphics", path.join(root, "src", "office", "connector", "native", "cocheck-screen.m"), "-o", file], {
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 300_000,
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: cache },
    });
    if (run.error || run.status !== 0 || !existsSync(file)) console.warn(`build-helpers: clang ${describe(run)} for ${arch}; cocheck-screen will not run on ${arch}.`);
    else parts.push(file);
  }
  rmSync(screenOut, { force: true });
  if (parts.length === 0) console.warn("build-helpers: cocheck-screen not built, so a prompt on Office's open is not read as one and the launch proof uses whole seconds.");
  else if (parts.length === 1) {
    copyFileSync(parts[0], screenOut);
    console.warn(`build-helpers: cocheck-screen built for ${path.basename(parts[0]).replace("cocheck-screen-", "")} only.`);
  } else {
    const join = spawnSync("lipo", ["-create", ...parts, "-output", screenOut], { stdio: ["ignore", "inherit", "inherit"] });
    if (join.error || join.status !== 0) {
      console.warn(`build-helpers: lipo ${describe(join)}; keeping the ${path.basename(parts[0]).replace("cocheck-screen-", "")} build only.`);
      copyFileSync(parts[0], screenOut);
    }
  }
}
try {
  const built = [];
  for (const arch of ARCHS) {
    const file = path.join(cache, `pdfpages-${arch}`);
    const run = spawnSync("swiftc", ["-O", "-target", `${arch}-apple-macos${MIN_MACOS}`, path.join(root, "native", "pdfpages.swift"), "-o", file], {
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 300_000,
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: cache },
    });
    if (run.error || run.status !== 0 || !existsSync(file)) console.warn(`build-helpers: swiftc ${describe(run)} for ${arch}; pdfpages will not run on ${arch}.`);
    else built.push(file);
  }
  rmSync(out, { force: true });
  if (built.length === 0) {
    console.warn("build-helpers: pdfpages not built, PDFs will use the fallback renderer.");
  } else if (built.length === 1) {
    copyFileSync(built[0], out);
    console.warn(`build-helpers: pdfpages built for ${path.basename(built[0]).replace("pdfpages-", "")} only.`);
  } else {
    const join = spawnSync("lipo", ["-create", ...built, "-output", out], { stdio: ["ignore", "inherit", "inherit"] });
    if (join.error || join.status !== 0) {
      console.warn(`build-helpers: lipo ${describe(join)}; keeping the ${path.basename(built[0]).replace("pdfpages-", "")} build only.`);
      copyFileSync(built[0], out);
    }
  }
  buildScreen();
} finally {
  rmSync(cache, { recursive: true, force: true });
}
