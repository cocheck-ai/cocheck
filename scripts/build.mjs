#!/usr/bin/env node
// `npm run build` (and the `prepack` of `npm pack`), in Node so it runs the same under cmd.exe on Windows as under sh:
// clears dist/, compiles src/ with tsc, copies the rail assets, the attribution hooks and the pdf.js files, builds the native helpers, stamps the build.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(fileURLToPath(import.meta.url), "..", "..");
const dist = path.join(root, "dist");
const run = (command) => {
  const r = spawnSync(command, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

rmSync(dist, { recursive: true, force: true });
run("tsc -p tsconfig.build.json"); // npm puts node_modules/.bin on PATH for scripts
mkdirSync(path.join(dist, "timeline", "rail"), { recursive: true });
cpSync(path.join(root, "src", "timeline", "rail", "assets"), path.join(dist, "timeline", "rail", "assets"), { recursive: true });
// The harness manifests shipped with CoCheck: data at the repo root, read by src/hosts/index.ts from dist/harnesses when it runs from dist/.
cpSync(path.join(root, "harnesses"), path.join(dist, "harnesses"), { recursive: true });
mkdirSync(path.join(dist, "attribution"), { recursive: true });
cpSync(path.join(root, "src", "attribution", "hooks"), path.join(dist, "attribution", "hooks"), { recursive: true });
// pdf.js (text only: the PDF reader on every OS, public-kit/helpers/pdf-text.mjs): just the two legacy build files the reader process loads, and
// the licence; not the 37 MB package with its optional native canvas. pdf-text.mjs finds them at dist/vendor/pdfjs (beside public-kit/).
{
  const from = path.join(root, "node_modules", "pdfjs-dist");
  const to = path.join(dist, "vendor", "pdfjs");
  mkdirSync(to, { recursive: true });
  for (const [src, name] of [[path.join(from, "legacy", "build", "pdf.min.mjs"), "pdf.min.mjs"], [path.join(from, "legacy", "build", "pdf.worker.min.mjs"), "pdf.worker.min.mjs"], [path.join(from, "LICENSE"), "LICENSE"]]) {
    if (!existsSync(src)) {
      console.error(`build: ${src} is missing (run npm ci): the PDF reader would not ship, so no PDF or Office page would get text or boxes`);
      process.exit(1);
    }
    cpSync(src, path.join(to, name));
  }
}
// The connectors shipped with CoCheck (src/connector/builtins.ts finds them at dist/connectors when it runs from dist/). A checkout without the folder ships none.
if (existsSync(path.join(root, "connectors"))) cpSync(path.join(root, "connectors"), path.join(dist, "connectors"), { recursive: true });
// Connector files tsc does not emit (the Windows Office host script, beside office-win.js).
run(`node "${path.join(root, "scripts", "copy-connector-assets.mjs")}"`);
run(`node "${path.join(root, "scripts", "build-helpers.mjs")}"`);
run(`node "${path.join(root, "scripts", "stamp-build.mjs")}"`);
