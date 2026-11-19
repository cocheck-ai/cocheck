// the general helpers are published in the kit (public-kit/helpers/, plain .mjs plus .d.mts), core uses those same files,
// and every connector process CoCheck starts is told where they are (COCHECK_HELPERS_DIR).
// Guards against drift: a second copy inside src/ that outsiders never get. Core's exports must be the kit's own objects (identity, not equality),
// and every kit module's runtime exports must match its .d.mts. Guards against a path that resolves only in the checkout: the runner's folder is
// derived from the running module, and test/homebrew-installed-layout.slow.test.ts runs the toy below from a scratch install.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { runConnectorTest } from "../src/connector-test-cli.ts";
import { HELPERS_DIR, startConnector, type ConnectorHandle } from "../src/connector/runner.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const KIT_HELPERS = path.join(ROOT, "public-kit", "helpers");
const TOY = path.join(ROOT, "public-kit", "examples", "toy-helpers");
const STATES = path.join(ROOT, "public-kit", "toy-product", "states");
const kit = (name: string) => import(pathToFileURL(path.join(KIT_HELPERS, name)).href) as Promise<Record<string, unknown>>;

/** Names a .d.mts declares as exports (`export declare const|function|class`, `export interface|type`), split into values and types. */
function declared(dts: string): { values: string[]; types: string[] } {
  const values = [...dts.matchAll(/^export\s+declare\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!);
  const types = [...dts.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!);
  return { values: [...new Set(values)].sort(), types };
}

describe("K1 the published helpers are one source", () => {
  it("public-kit/helpers holds the PNG decoder, the PDF page rasterizer and the spec constant, each as .mjs with a matching .d.mts", async () => {
    const files = readdirSync(KIT_HELPERS);
    for (const m of ["png.mjs", "pdf.mjs", "spec.mjs"]) assert.ok(files.includes(m), `missing ${m}`);
    for (const m of files.filter((f) => f.endsWith(".mjs"))) {
      const dts = m.replace(/\.mjs$/, ".d.mts");
      assert.ok(files.includes(dts), `${m} has no ${dts}`);
      const runtime = Object.keys(await kit(m)).sort();
      assert.deepEqual(runtime, declared(readFileSync(path.join(KIT_HELPERS, dts), "utf8")).values, `${m} and ${dts} name different exports`);
    }
  });

  it("core's PNG decoder is the kit's: the same function objects, not a copy", async () => {
    const core = await import("../src/connector/png-pixels.ts");
    const png = await kit("png.mjs");
    for (const name of ["decodePng", "sameRegion", "sameRegionAt", "MAX_PIXEL_BYTES"]) assert.equal((core as Record<string, unknown>)[name], png[name], name);
    assert.equal(typeof png.decodePng, "function");
  });

  it("core's spec constant and the kit's spec constant come from one file (no second literal in changes-v1.ts)", async () => {
    const core = await import("../src/connector/changes-v1.ts");
    assert.equal(core.CHANGES_SPEC, (await kit("spec.mjs")).CHANGES_SPEC);
    assert.equal(core.CHANGES_SPEC, "cocheck.changes/1");
    assert.doesNotMatch(readFileSync(path.join(ROOT, "src", "connector", "changes-v1.ts"), "utf8"), /"cocheck\.changes\/1"/);
  });

  it("core's PDF drawing calls the kit's rasterizer, and the Windows backend core uses is the kit's", async () => {
    const pdf = await kit("pdf.mjs");
    const helperSrc = readFileSync(path.join(ROOT, "src", "timeline", "render", "pdf-helper.ts"), "utf8");
    assert.match(helperSrc, /from "\.\.\/\.\.\/\.\.\/public-kit\/helpers\/pdf\.mjs"/);
    const win = await import("../src/platform/win32-docrender.ts");
    assert.equal(win.pdfScriptForTest, pdf.WINDOWS_PDF_SCRIPT);
    assert.doesNotMatch(readFileSync(path.join(ROOT, "src", "platform", "win32-docrender.ts"), "utf8"), /Windows\.Data\.Pdf\.PdfDocument/, "a second copy of the Windows script");
  });

  it("the kit's rasterizer draws a page through a given OS backend, and through the Mac helper program it is pointed at", async () => {
    const { renderPdfPage } = (await kit("pdf.mjs")) as { renderPdfPage: (b: Buffer, n: number, o?: object) => Promise<Buffer | null> };
    const seen: Array<{ n: number; bytes: string }> = [];
    const windows = {
      available: () => true, textRuns: false, pdfjs: false, engine: "fake",
      pages: async () => "failed" as const,
      png: async (file: string, n: number, out: string) => { seen.push({ n, bytes: readFileSync(file, "utf8") }); writeFileSync(out, "PNG-BYTES"); return "ok" as const; },
    };
    assert.equal(String(await renderPdfPage(Buffer.from("%PDF-fake"), 2, { windows })), "PNG-BYTES");
    assert.deepEqual(seen, [{ n: 2, bytes: "%PDF-fake" }]);
    if (process.platform === "win32") return; // the fake helper below is a POSIX shell script
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-pdfpages-"));
    const fake = path.join(dir, "pdfpages");
    writeFileSync(fake, '#!/bin/sh\n[ "$2" = "--png" ] && [ "$3" = "3" ] && printf "PAGE3" > "$4"\n');
    chmodSync(fake, 0o755);
    assert.equal(String(await renderPdfPage(Buffer.from("%PDF-fake"), 3, { windows: null, pdfpages: fake })), "PAGE3");
    assert.equal(await renderPdfPage(Buffer.from("%PDF-fake"), 1, { windows: null, pdfpages: path.join(dir, "missing") }), null);
  });
});

describe("K1 the npm package (and so the Windows tarball, `npm pack`) carries the helpers", () => {
  it("npm pack lists every file in public-kit/helpers", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8", timeout: 120_000, shell: process.platform === "win32" });
    assert.equal(r.status, 0, r.stderr);
    const files = new Set((JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path));
    for (const f of readdirSync(KIT_HELPERS)) assert.ok(files.has(`public-kit/helpers/${f}`), `npm pack leaves out public-kit/helpers/${f}`);
  });

  it("the spec documents COCHECK_HELPERS_DIR in its own Helpers section, naming each module", () => {
    const spec = readFileSync(path.join(ROOT, "public-kit", "spec", "v1.md"), "utf8");
    const at = spec.indexOf("\n## Helpers\n");
    assert.ok(at > 0, "no ## Helpers section");
    const section = spec.slice(at, spec.indexOf("\n## ", at + 5));
    assert.match(section, /COCHECK_HELPERS_DIR/);
    for (const m of readdirSync(KIT_HELPERS).filter((f) => f.endsWith(".mjs"))) assert.match(section, new RegExp(`\`${m.replace(".", "\\.")}\``), m);
  });
});

describe("K1 every connector process is told where the helpers are", () => {
  const handles: ConnectorHandle[] = [];
  after(async () => { for (const h of handles) await h.stop(); });

  it("the runner sets COCHECK_HELPERS_DIR to the kit's helpers folder, found from the running module (src/ or dist/), and it exists", async () => {
    assert.equal(HELPERS_DIR, KIT_HELPERS);
    assert.ok(existsSync(path.join(HELPERS_DIR, "png.mjs")));
    const dir = mkdtempSync(path.join(tmpdir(), "cocheck-env-"));
    writeFileSync(path.join(dir, "c.mjs"), 'import readline from "node:readline";\nreadline.createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.connector/1", level: 1, methods: ["diff"], helpers: process.env.COCHECK_HELPERS_DIR ?? null } }) + "\\n"); });\n');
    const h = await startConnector({ dir, run: [process.execPath, "c.mjs"], id: `env-${process.pid}` });
    handles.push(h);
    assert.equal(h.hello.helpers, KIT_HELPERS);
  });
});

describe("K3 the kit's toy connector loads a helper through COCHECK_HELPERS_DIR, run by CoCheck's engine", () => {
  it("`cocheck connector test` on public-kit/examples/toy-helpers passes", async () => {
    const r = await runConnectorTest([TOY, "--states", STATES]);
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^passed$/m);
  });

  it("the toy really depends on the helper: started without it, or pointed at a folder without spec.mjs, it does not start", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "cocheck-empty-"));
    await assert.rejects(startConnector({ dir: TOY, run: [process.execPath, "connector.mjs"], id: `empty-${process.pid}`, env: { COCHECK_HELPERS_DIR: empty }, helloTimeoutMs: 10_000 }));
    await assert.rejects(startConnector({ dir: TOY, run: [process.execPath, "connector.mjs"], id: `unset-${process.pid}`, env: { COCHECK_HELPERS_DIR: "" }, helloTimeoutMs: 10_000 }));
  });
});
