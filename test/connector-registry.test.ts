import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinEntries, createRegistry, type RegistryEntry } from "../src/connector/registry.ts";
import { rendererFor, registeredExtensions } from "../src/timeline/render/registry.ts";
import { defaultLayers } from "../src/timeline/load.ts";
import { fallbackRenderer } from "../src/timeline/render/fallback.ts";
import { pdfRenderer } from "../src/timeline/render/pdf.ts";
import { textRenderer } from "../src/timeline/render/text.ts";
import type { FormatRenderer } from "../src/timeline/render/types.ts";

// One registry behind defaultLayers() and the renderer table. Nothing here starts a helper or opens an app.

const gates = (pdf: boolean) => ({ pdf: () => pdf });
// Today's table, written out: .pdf with the helper. No Office file has a renderer of its own.
const OFFICE = [".xlsx", ".xlsm", ".docx", ".pptx"];
const expectedFor = (pdf: boolean): Array<[string, FormatRenderer]> => [
  ...(pdf ? pdfRenderer.extensions.map((e) => [e, pdfRenderer] as [string, FormatRenderer]) : []),
];
const scratch = () => mkdtempSync(path.join(tmpdir(), "cocheck-registry-"));
const manifest = (id: string, matches: object) => ({ spec: "cocheck.connector/1", id, version: "0.0.1", entry: "state", matches, run: ["node", "c.mjs"], credentials: [], platforms: ["darwin"] });
function install(home: string, dir: string, body: string): string {
  const d = path.join(home, "connectors", dir);
  mkdirSync(d, { recursive: true });
  const f = path.join(d, "cocheck-connector.json");
  writeFileSync(f, body);
  return f;
}
async function stderrOf(fn: () => void): Promise<string[]> {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => (lines.push(String(s)), true);
  try { fn(); } finally { process.stderr.write = orig; }
  return lines;
}

describe("built-in extension table (byte-for-byte today's)", () => {
  for (const pdf of [false, true]) {
    it(`pdf helper ${pdf ? "on" : "off"}`, () => {
      const reg = createRegistry({ builtins: builtinEntries(gates(pdf)) });
      const expected = expectedFor(pdf);
      assert.deepEqual(reg.registeredExtensions(), expected.map(([e]) => e));
      for (const [ext, r] of expected) assert.equal(reg.rendererFor(`/x/File${ext.toUpperCase()}`), r, ext);
      // Every extension a gated renderer owns falls back when its gate is off.
      for (const ext of [...pdfRenderer.extensions, ...OFFICE, ".zzz", ""]) {
        // Core has no Office renderer at all; an Office ending is the fallback card (its picture tier draws no claimed state)
        if (!expected.some(([e]) => e === ext)) assert.equal(reg.rendererFor(`/x/a${ext}`), fallbackRenderer, ext);
      }
      assert.equal(reg.rendererFor("/x/a.zzz", { tier: "text" } as never), textRenderer);
    });
  }
  it("the render registry functions are the live-gate registry's answers", () => {
    const live = createRegistry();
    assert.deepEqual(registeredExtensions(), live.registeredExtensions());
    for (const e of [".xlsx", ".pdf", ".docx", ".pptx", ".txt", ".png"]) assert.equal(rendererFor(`a${e}`), live.rendererFor(`a${e}`));
  });
  it("defaultLayers is the generic files layer only (core reads no Office file)", () => {
    assert.deepEqual(defaultLayers().map((l) => l.name), ["files"]);
    assert.deepEqual(createRegistry().layers().map((l) => l.constructor.name), defaultLayers().map((l) => l.constructor.name));
  });
  it("pdf and Quick Look are separate entries, each gated; there is no office entry", () => {
    const ids = builtinEntries().map((e) => e.id);
    for (const id of ["pdf"]) assert.ok(ids.includes(id), id);
    assert.ok(!ids.includes("office"));
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ["pdf"]) assert.equal(typeof builtinEntries().find((e) => e.id === id)!.available, "function");
  });
});

describe("must not: installed connectors and helpers never redraw a built-in file", () => {
  it("an installed connector claiming .xlsx and .pdf takes their view away (a card, never a core view); the unclaimed ones, the layers and the extension table stay", () => {
    const home = scratch();
    install(home, "greedy", JSON.stringify(manifest("greedy", { extensions: [".xlsx", ".pdf", ".docx", ".notes.json"] })));
    const plain = createRegistry({ builtins: builtinEntries(gates(true)) });
    const withInstalled = createRegistry({ home, builtins: builtinEntries(gates(true)) });
    assert.deepEqual(withInstalled.registeredExtensions(), plain.registeredExtensions());
    // A file a known connector claims is drawn by no core renderer (the card); what it does not claim keeps its renderer
    for (const e of [".xlsx", ".pdf", ".docx", ".notes.json"]) assert.equal(withInstalled.rendererFor(`a${e}`).name, "connector-claimed", e);
    for (const e of [".pptx", ".txt"]) assert.equal(withInstalled.rendererFor(`a${e}`), plain.rendererFor(`a${e}`), e);
    assert.equal(withInstalled.layers().length, plain.layers().length);
    assert.deepEqual(withInstalled.forSubject("/x/toy.notes.json"), { source: "installed", id: "greedy", manifest: manifest("greedy", { extensions: [".xlsx", ".pdf", ".docx", ".notes.json"] }) });
  });
  it("a missing helper only moves its own extensions to the fallback, never xlsx", () => {
    const off = createRegistry({ builtins: builtinEntries(gates(false)) });
    assert.equal(off.rendererFor("a.xlsx"), fallbackRenderer);
    assert.equal(off.rendererFor("a.pdf"), fallbackRenderer);
  });
  it("an installed connector that matches is not ignored by forSubject (extension and scheme)", () => {
    const home = scratch();
    install(home, "toy-notes", JSON.stringify(manifest("toy-notes", { extensions: [".notes.json"] })));
    install(home, "web", JSON.stringify(manifest("web", { schemes: ["acme"] })));
    const reg = createRegistry({ home });
    assert.equal(reg.forSubject("/a/b.NOTES.json").id, "toy-notes");
    assert.equal(reg.forSubject("acme://x/y").id, "web");
    assert.equal(reg.forSubject("ACME://x/y").source, "installed");
  });
});

describe("lookup order and fallback", () => {
  const plugin = (id: string, extra: Partial<RegistryEntry> = {}): RegistryEntry => ({ id, ...extra });
  it("plugins beat installed beat built-ins beat fallback", () => {
    const home = scratch();
    install(home, "inst", JSON.stringify(manifest("inst", { extensions: [".xlsx", ".foo"] })));
    const reg = createRegistry({ home, plugins: [plugin("plug", { extensions: [".foo"] })] });
    assert.equal(reg.forSubject("a.foo").source, "plugin");
    assert.equal(reg.forSubject("a.xlsx").source, "installed");
    assert.equal(createRegistry({ builtins: builtinEntries(gates(true)) }).forSubject("a.pdf").source, "builtin");
    assert.deepEqual(createRegistry().forSubject("a.unknown"), { source: "fallback", id: "fallback" });
  });
  it("a plugin renderer wins rendererFor by id handover; an unavailable plugin is skipped", () => {
    const mine: FormatRenderer = { name: "mine", extensions: [".pdf"], view: () => { throw new Error("no"); } };
    assert.equal(createRegistry({ plugins: [plugin("p", { extensions: [".pdf"], renderer: mine })] }).rendererFor("a.pdf"), mine);
    assert.notEqual(createRegistry({ plugins: [plugin("p", { extensions: [".pdf"], renderer: mine, available: () => false })] }).rendererFor("a.pdf"), mine);
    assert.equal(createRegistry({ plugins: [plugin("p", { extensions: [".pdf"], available: () => false })] }).forSubject("a.pdf").source !== "plugin", true);
  });
  it("a URI subject with no scheme match is the fallback, even if its path looks like a built-in", () => {
    assert.deepEqual(createRegistry().forSubject("https://example.com/report.xlsx"), { source: "fallback", id: "fallback" });
  });
  it("a plugin layer comes before the built-in layers", () => {
    const made = { tag: "plugin-layer" } as never;
    const reg = createRegistry({ plugins: [plugin("p", { layer: () => made })] });
    assert.equal(reg.layers().length, 2); // the plugin and the generic files layer
    assert.equal(reg.layers()[0], made);
  });
});

describe("bad installed manifests are skipped, never thrown", () => {
  it("invalid JSON, failed checkManifest and an unreadable path each give one stderr line naming the path", async () => {
    const home = scratch();
    const bad1 = install(home, "badjson", "{ not json");
    const bad2 = install(home, "badshape", JSON.stringify({ spec: "cocheck.connector/1", id: "x" }));
    const unreadable = path.join(home, "connectors", "dirmanifest", "cocheck-connector.json");
    mkdirSync(unreadable, { recursive: true }); // a directory where the file should be: readFileSync throws EISDIR
    install(home, "good", JSON.stringify(manifest("good", { extensions: [".good"] })));
    const reg = createRegistry({ home });
    let got: ReturnType<typeof reg.forSubject> | undefined;
    const lines = await stderrOf(() => { got = reg.forSubject("a.good"); reg.forSubject("b.good"); });
    assert.equal(got!.id, "good");
    assert.equal(lines.length, 3);
    for (const p of [bad1, bad2, unreadable]) assert.equal(lines.filter((l) => l.includes(p)).length, 1, p);
    for (const l of lines) assert.equal(l.trimEnd().split("\n").length, 1);
  });
  it("a missing connectors folder or a missing home is silent", async () => {
    const lines = await stderrOf(() => { createRegistry({ home: scratch() }).forSubject("a.x"); createRegistry().forSubject("a.x"); });
    assert.deepEqual(lines, []);
  });
});
