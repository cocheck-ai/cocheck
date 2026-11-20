// One registry behind defaultLayers() and the renderer table. Lookup order: plugins, installed connectors, built-ins, fallback.
// Built-ins are plain RegistryEntry values, so a plugin can replace one by id. An installed connector (<home>/connectors/<id>/cocheck-connector.json) is only ever reported by forSubject:
// it has no renderer or layer of its own. A file whose ending any known manifest claims is drawn by no core renderer (rendererFor answers
// the claimed card), so an installed manifest does take a claimed type's view away; layers() and the extension table are unchanged by it.
// forSubject decides only for URI subjects; the rail never calls it, and tells a connector row from a file row by the ledger's `connector` column.
import path from "node:path";
import { createFilesLayer } from "../formats/files/layer.ts";
import type { FormatLayer } from "../formats/layer.ts";
import { claimedRenderer } from "../timeline/render/claimed.ts";
import { fallbackRenderer } from "../timeline/render/fallback.ts";
import { pdfRenderer } from "../timeline/render/pdf.ts";
import { pdfHelperAvailable } from "../timeline/render/pdf-helper.ts";
import { textRenderer } from "../timeline/render/text.ts";
import type { ChangeInfo, FormatRenderer } from "../timeline/render/types.ts";
import { readInstalledManifests, type InstalledManifest } from "./installed-manifests.ts";
import { connectorForSubject } from "./installed-match.ts";
import { claimedFile } from "./claimed-state.ts";

export interface RegistryEntry {
  id: string;
  /** Lower-case, with the dot: ".csv". */
  extensions?: string[];
  schemes?: string[];
  /** Builds a fresh layer each call (a layer holds per-load state). */
  layer?: () => FormatLayer;
  renderer?: FormatRenderer;
  /** Absent means always available; false hides the entry from every lookup. */
  available?: () => boolean;
}

export interface Resolved {
  source: "plugin" | "installed" | "builtin" | "fallback";
  id: string;
  manifest?: unknown;
}

/** The generic files layer that lists a file as one whole-file row only, for a state a connector reads (never its lines, whatever its bytes are). */
export const wholeFileLayer = (): FormatLayer => createFilesLayer({ generic: true, wholeOnly: true });

interface Registry {
  layers(): FormatLayer[];
  rendererFor(file: string, generic?: ChangeInfo["generic"]): FormatRenderer;
  forSubject(subject: string): Resolved;
  registeredExtensions(): string[];
}

/** The built-ins. Core's only layer is the generic files layer (text, csv, a whole-file row); a format a connector claims is that connector's to read. */
interface Gates {
  pdf: () => boolean;
}
const LIVE_GATES: Gates = { pdf: pdfHelperAvailable };

export const builtinEntries = (gates: Gates = LIVE_GATES): RegistryEntry[] => [
  { id: "files", layer: () => createFilesLayer({ generic: true }) },
  { id: "pdf", extensions: pdfRenderer.extensions, renderer: pdfRenderer, available: gates.pdf },
];

const on = (e: RegistryEntry): boolean => e.available === undefined || e.available();
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const bareScheme = (s: string): string => s.toLowerCase().replace(/:?\/*$/, "");

/** Longest extension of `exts` that ends `name` (multi-dot extensions like ".notes.json" count). */
const endsWithExt = (name: string, exts: readonly string[] | undefined): number => {
  const n = name.toLowerCase();
  return (exts ?? []).reduce((best, e) => (e.length > 0 && n.endsWith(e.toLowerCase()) && e.length > best ? e.length : best), 0);
};

function readRaw(home: string | undefined): InstalledManifest[] {
  return readInstalledManifests(home, {
    onFolderError: (root, why) => process.stderr.write(`cocheck: cannot read connectors folder ${root}: ${why}\n`),
    onSkip: (file, why) => process.stderr.write(`cocheck: skipping connector manifest ${file}: ${why}\n`),
  });
}

/** `builtins` is for tests that turn the helper gates on and off; production passes nothing. */
export function createRegistry(opts: { home?: string; plugins?: RegistryEntry[]; builtins?: RegistryEntry[] } = {}): Registry {
  const plugins = opts.plugins ?? [];
  const BUILTIN_ENTRIES = opts.builtins ?? builtinEntries();
  let installed: InstalledManifest[] | undefined;
  const installedList = (): InstalledManifest[] => (installed ??= readRaw(opts.home));

  /** Built-in renderers by extension, last entry wins. */
  const builtinTable = (): Map<string, FormatRenderer> =>
    new Map(BUILTIN_ENTRIES.filter((e) => e.renderer !== undefined && on(e)).flatMap((e) => (e.extensions ?? []).map((x) => [x, e.renderer!] as const)));

  return {
    layers: () => [...plugins, ...BUILTIN_ENTRIES].filter((e) => e.layer !== undefined && on(e)).map((e) => e.layer!()),
    registeredExtensions: () => [...new Set([...plugins.filter((e) => e.renderer !== undefined && on(e)).flatMap((e) => e.extensions ?? []), ...builtinTable().keys()])],
    rendererFor(file, generic) {
      const fromPlugin = plugins.filter((e) => e.renderer !== undefined && on(e)).map((e) => ({ e, len: endsWithExt(file, e.extensions) })).filter((m) => m.len > 0).sort((a, b) => b.len - a.len)[0];
      if (fromPlugin !== undefined) return fromPlugin.e.renderer!;
      // No view of any kind for a state a connector reads. The loader marks a generic `claimed` for a row with a connector or bytes shared with a
      // claimed state; a claimed ending is read here, at view time, from the known manifests. Before the built-in table, so a claimed .pdf is a card too.
      if (generic?.claimed === true || claimedFile(opts.home)(file)) return claimedRenderer;
      return builtinTable().get(path.extname(file).toLowerCase()) ?? (generic?.tier === "text" ? textRenderer : fallbackRenderer);
    },
    forSubject(subject) {
      const scheme = SCHEME.exec(subject)?.[1];
      const hit = <T extends { extensions?: string[]; schemes?: string[] }>(list: T[]): T | undefined => {
        if (scheme !== undefined) return list.find((x) => (x.schemes ?? []).map(bareScheme).includes(scheme.toLowerCase()));
        return list.map((x) => ({ x, len: endsWithExt(subject, x.extensions) })).filter((m) => m.len > 0).sort((a, b) => b.len - a.len)[0]?.x;
      };
      const p = hit(plugins.filter(on));
      if (p !== undefined) return { source: "plugin", id: p.id };
      // One winner among installed connectors (installed-match.ts: subject template, then schemes, then extensions by longest suffix, then first folder).
      const i = connectorForSubject(installedList(), subject);
      if (i !== undefined) return { source: "installed", id: i.manifest.id, manifest: i.manifest };
      const b = hit(BUILTIN_ENTRIES.filter(on));
      if (b !== undefined) return { source: "builtin", id: b.id };
      return { source: "fallback", id: "fallback" };
    },
  };
}
