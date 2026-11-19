// outsider parity over the inventory's answer-4 set. An outsider-shaped connector (built only from the kit's published helpers and its own
// files, installed under a data folder) is run the way CoCheck runs any installed connector, and each private ability of a built-in is either shown
// reachable here or pinned as a remaining privilege, so a verdict cannot drift from the code. The report lists each item with file:line.
// Guards against: calling a privilege "reachable" when an outsider cannot use it. Every "reachable" test below uses only the toy's own files and
// the kit; every privilege test pins the exact place the built-in gets it and fails if an outsider got it too.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { PRODUCTION_BUILTIN_CONNECTORS, builtinClaims, connectorArgv, connectorById, knownConnectors, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { connectorClaimsFor } from "../src/connector/installed-match.ts";
import { readInstalledManifests } from "../src/connector/installed-manifests.ts";
import { startConnector, type ConnectorHandle } from "../src/connector/runner.ts";
import { runConnectorSwitch } from "../src/connector-types-cli.ts";
import { SOURCE_EXT, importsOf } from "./helpers/import-edges.ts";
await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const VT = (globalThis as any).CoCheckViewTable;

const ROOT = path.resolve(import.meta.dirname, "..");
const scratch = (tag: string): string => mkdtempSync(path.join(tmpdir(), `${tag}-`));
const handles: ConnectorHandle[] = [];
after(async () => { for (const h of handles) await h.stop(); });
afterEach(() => { setBuiltinConnectorsForTest(undefined); delete process.env.COCHECK_TEST_G4_LISTED; delete process.env.COCHECK_TEST_G4_UNLISTED; });

// A 1x1 red RGBA PNG (valid zlib stream), the picture the toy decodes with the kit's decoder.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** The toy's own two files: a manifest and a connector.mjs that imports its own sibling file and loads the kit helpers by COCHECK_HELPERS_DIR. */
function writeToy(home: string, id: string, extensions: string[]): string {
  const dir = path.join(home, "connectors", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id, version: "0.0.1", entry: "state", matches: { extensions }, run: ["node", "connector.mjs"], credentials: [], platforms: ["darwin", "win32", "linux"], permissions: { env: ["COCHECK_TEST_G4_LISTED"] } }));
  writeFileSync(path.join(dir, "own-program.mjs"), "export const ownProgram = 'found beside the manifest';\n");
  writeFileSync(path.join(dir, "connector.mjs"), `
import readline from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
const load = (m) => import(pathToFileURL(path.join(process.env.COCHECK_HELPERS_DIR, m)).href);
const { decodePng } = await load("png.mjs");
const { CHANGES_SPEC } = await load("spec.mjs");
const pdf = await load("pdf.mjs");
const { ownProgram } = await import(new URL("./own-program.mjs", import.meta.url).href);
const px = decodePng(Buffer.from(${JSON.stringify(PNG_1X1)}, "base64"));
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  process.stdout.write(JSON.stringify({ id: m.id, result: { spec: "cocheck.connector/1", level: 1, methods: ["diff"],
    probe: { ownProgram, spec: CHANGES_SPEC, png: px ? [px.width, px.height] : null, pdfRenderIsFunction: typeof pdf.renderPdfPage === "function",
      listed: process.env.COCHECK_TEST_G4_LISTED ?? null, unlisted: process.env.COCHECK_TEST_G4_UNLISTED ?? null, execPath: process.execPath } } }) + "\\n");
});
`);
  return dir;
}

describe("G4: what an outsider-shaped connector reaches", () => {
  it("built only from its own files and the kit, started the way core starts an installed connector: it finds its own program, decodes a PNG, reads CHANGES_SPEC, loads the pdf helper, gets a listed COCHECK_TEST_* variable and not an unlisted one", async () => {
    const home = scratch("toy");
    writeToy(home, "outsider-g4", [".g4probe"]);
    process.env.COCHECK_TEST_G4_LISTED = "yes";
    process.env.COCHECK_TEST_G4_UNLISTED = "leak";
    const installed = connectorById(home, "outsider-g4");
    assert.ok(installed, "the installed toy is found");
    assert.notEqual(installed.builtin, true);
    const h = await startConnector({ dir: path.dirname(installed.file), run: connectorArgv(installed), id: `${process.pid}`, envNames: ["COCHECK_TEST_G4_LISTED"] });
    handles.push(h);
    const probe = h.hello.probe as Record<string, unknown>;
    assert.equal(probe.ownProgram, "found beside the manifest");
    assert.equal(probe.spec, "cocheck.changes/1");
    assert.deepEqual(probe.png, [1, 1]);
    assert.equal(probe.pdfRenderIsFunction, true);
    assert.equal(probe.listed, "yes", "permissions.env is how COCHECK_TEST_* reaches any connector");
    assert.equal(probe.unlisted, null, "an unlisted COCHECK_TEST_* variable does not");
  });

  it("the shipped built-ins use no other way to get COCHECK_TEST_* than permissions.env", () => {
    for (const b of PRODUCTION_BUILTIN_CONNECTORS) {
      const m = JSON.parse(readFileSync(path.join(b.dir, "cocheck-connector.json"), "utf8")) as { permissions?: { env?: string[] } };
      assert.ok(Array.isArray(m.permissions?.env), b.id);
    }
  });

  it("REACHABLE `node`: an installed connector's bare `node` runs as process.execPath, an absolute node path is kept, and so is any other program", () => {
    const home = scratch("node");
    writeToy(home, "outsider-g4", [".g4probe"]);
    const installed = connectorById(home, "outsider-g4")!;
    assert.equal(connectorArgv(installed)[0], process.execPath);
    assert.equal(connectorArgv({ ...installed, builtin: true as const })[0], process.execPath);
    const withRun = (run: string[]) => ({ ...installed, manifest: { ...installed.manifest, run } }) as typeof installed;
    assert.deepEqual(connectorArgv(withRun(["/opt/x/node", "c.mjs"])), ["/opt/x/node", "c.mjs"]);
    assert.deepEqual(connectorArgv(withRun(["python3", "node"])), ["python3", "node"]);
    assert.deepEqual(connectorArgv(withRun(["./node", "c.mjs"])), ["./node", "c.mjs"]);
  });

  it("PRIVILEGE id shadowing: an installed folder reusing a built-in's id is never used or listed; the built-in answers for that id (builtins.ts:69-74, installed-match.ts)", () => {
    setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
    const home = scratch("shadow");
    writeToy(home, "microsoft-excel", [".g4probe"]);
    const byId = connectorById(home, "microsoft-excel")!;
    assert.equal(byId.builtin, true);
    assert.equal(knownConnectors(home).filter((m) => m.manifest.id === "microsoft-excel").length, 1);
    assert.equal(connectorClaimsFor(home, builtinClaims())("x.g4probe"), undefined, "the shadowed copy claims nothing, even a type no built-in holds");
    assert.equal(readInstalledManifests(home).length, 1, "it is read as installed, then dropped by id");
  });

  it("REACHABLE reserved endings are gone: an installed toy claiming .xlsx, .docx or .pdf starts disabled, and the user's enabled setting gives it the type (claims plus enabled-per-type, P7)", () => {
    setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
    const home = scratch("claims");
    writeToy(home, "outsider-g4", [".xlsx", ".docx", ".pdf", ".g4probe"]);
    const claim = () => connectorClaimsFor(home, builtinClaims());
    assert.equal(claim()("a.g4probe"), "outsider-g4", "a type nobody serves goes to the toy");
    assert.equal(claim()("a.xlsx"), "microsoft-excel", "default: the built-in keeps a type it holds");
    assert.equal(claim()("a.docx"), "microsoft-word");
    assert.equal(claim()("a.pdf"), undefined, "core draws pdf; an installed claim never silently takes it");
    for (const t of [".xlsx", ".docx", ".pdf"]) assert.equal(runConnectorSwitch(["enable", "outsider-g4", t], { home }).exitCode, 0, t);
    for (const f of ["a.xlsx", "a.docx", "a.pdf"]) assert.equal(claim()(f), "outsider-g4", f);
    const src = readFileSync(path.join(ROOT, "src", "connector", "installed-match.ts"), "utf8");
    assert.doesNotMatch(src, /RESERVED|reserved/, "no reserved-endings list left in the matcher");
  });

  it("REACHABLE the page treats an installed connector's answer like a built-in's: same source stamp, same Drawn by from renderedBy, private hints read only when CoCheck drew the document", () => {
    const pics = [{ id: "p", side: "after", type: "image", renderedBy: { tool: "Toy Renderer 1", version: "1", os: "darwin" } }];
    for (const name of ["microsoft-excel", "outsider-g4"]) {
      assert.equal(VT.sourceLine({ by: "connector", name, level: 3 }, pics), "Drawn by Toy Renderer 1", name);
      assert.equal(VT.sourceLine({ by: "connector", name, level: 1 }, []), `Change list from ${name}`);
    }
    // No code under connectors/ or src/office/connector/ can stamp by "cocheck": the stamp is CoCheck's, from connector rows (diff.ts, row-doc.ts, load.ts, after-snapshot.ts).
    const bad: string[] = [];
    const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (SOURCE_EXT.test(e.name) && /by:\s*["']cocheck["']/.test(readFileSync(f, "utf8"))) bad.push(path.relative(ROOT, f)); } };
    walk(path.join(ROOT, "connectors")); walk(path.join(ROOT, "src", "office", "connector"));
    assert.deepEqual(bad, []);
  });
});

describe("G4: direct core imports, each exception, against the kit", () => {
  // Read the same way test/end-state-imports.test.ts reads them: every core module a connector module imports, beyond the file lock and the kit.
  const targets = (): string[] => {
    const out = new Set<string>();
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (SOURCE_EXT.test(e.name) && !e.name.endsWith(".d.ts")) {
          const rel = path.relative(ROOT, f).split(path.sep).join("/");
          for (const t of importsOf(rel, readFileSync(f, "utf8"), (r) => { try { return readFileSync(path.join(ROOT, r)) !== undefined; } catch { return false; } })) if (t.startsWith("src/") && !t.startsWith("src/office/connector/") && t !== "src/file-lock.ts") out.add(t);
        }
      }
    };
    walk(path.join(ROOT, "src", "office", "connector"));
    return [...out].sort();
  };

  it("the remaining connector-to-core imports are exactly the six G4 verdicts below; a new or removed one fails here until its verdict is written", () => {
    assert.deepEqual(targets(), ["src/formats/files/align.ts", "src/formats/files/layer.ts", "src/formats/files/scan.ts", "src/formats/layer.ts", "src/paths.ts", "src/platform/index.ts"]);
  });

  // PDFs are no privilege any more: the connector reads text, finds paragraphs and crops pages with the published pdf.js reader (pdf-text.mjs, with its
  // page model pdf-text-layout.mjs) and draws pages with pdf.mjs, the same files an outsider loads; core's pdf-helper.ts wraps those same helpers.
  it("each is a privilege only in the sense of unpublished code: none is a kit helper, and the kit publishes exactly png, pdf (drawing), pdf-text (the reader) and spec", () => {
    assert.deepEqual(readdirSync(path.join(ROOT, "public-kit", "helpers")).filter((f) => f.endsWith(".mjs")).sort(), ["pdf-text-layout.mjs", "pdf-text.mjs", "pdf.mjs", "png.mjs", "spec.mjs"]);
    const text = readFileSync(path.join(ROOT, "public-kit", "helpers", "pdf-text.mjs"), "utf8");
    for (const name of ["readPdfText", "cropPdfPage", "findPdfParagraphs"]) assert.match(text, new RegExp(`export (?:async )?function ${name}`), `${name} is published`);
    const connector = readdirSync(path.join(ROOT, "src", "office", "connector"), { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    for (const f of connector) assert.doesNotMatch(readFileSync(path.join(ROOT, "src", "office", "connector", f), "utf8"), /timeline\/render\/pdf-helper/, `${f} reads PDFs through core`);
  });

  it("the change-list shape (formats/layer.ts's role) is public: a toy's document passes CoCheck's own check with no core import", async () => {
    const { checkChanges } = await import("../src/connector/changes-v1.ts");
    assert.deepEqual(checkChanges({ spec: "cocheck.changes/1", changes: [{ id: "n1", mark: "changed", label: "Note n1", before: "a", after: "b" }] }, 1), []);
  });

  it("PRIVILEGE the macOS screen program: SCREEN_HELPER is a binary only CoCheck's tree ships, and no kit helper names it (screen-macos.ts:17)", () => {
    const src = readFileSync(path.join(ROOT, "src", "office", "connector", "screen-macos.ts"), "utf8");
    assert.match(src, /export const SCREEN_HELPER = fileURLToPath\(new URL\("\.\.\/\.\.\/\.\.\/dist\/office\/connector\/helpers\/cocheck-screen"/);
    for (const f of readdirSync(path.join(ROOT, "public-kit", "helpers"))) assert.doesNotMatch(readFileSync(path.join(ROOT, "public-kit", "helpers", f), "utf8"), /cocheck-screen|SCREEN_HELPER/, f);
  });
});
