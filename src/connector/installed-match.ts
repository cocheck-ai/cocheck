// Whether an installed connector handles an MCP call. Answered by `mcpConnectorMatches` from the installed manifests: reads `<home>/connectors/<id>/cocheck-connector.json`; a manifest that does not
// parse or does not pass `checkManifest` matches nothing. Never throws: unknown is "no connector", which keeps the call on the write rail.
import path from "node:path";
import { connectorById } from "./builtins.ts";
import { readEnabledTypes, typeKey, typeStates, type Claimant } from "./enabled-types.ts";
import { readInstalledManifests, type InstalledManifest } from "./installed-manifests.ts";
import { MANIFEST_SPEC } from "./schema.ts";

// ---- one winner -------------------------------------------------------------------------------------------------------------------------------------
// When two installed connectors match the same call or subject, exactly one wins. The order, by what the manifest matched on:
//   1 matches.mcpTools, 2 matches.subjects (a template for the tool), 3 matches.mcpServers, 4 matches.schemes, 5 matches.extensions (longest suffix);
// within one rank the first folder by name (readInstalledManifests lists folders sorted). The order is stated here once and printed in the overlap warning.

export const WINNER_ORDER = "mcpTools, then subject template, then mcpServers, then schemes, then extensions by longest suffix, then first folder by name";
type Via = "mcpTools" | "subjects" | "mcpServers" | "schemes" | "extensions";
const RANK: Record<Via, number> = { mcpTools: 0, subjects: 1, mcpServers: 2, schemes: 3, extensions: 4 };
interface Claim { id: string; dir: string; via: Via; /** Extension length (longer is stronger); 0 for the rest. */ len: number }
type M = InstalledManifest["manifest"];

const byWinner = (a: Claim, b: Claim): number => RANK[a.via] - RANK[b.via] || b.len - a.len || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0);
const FULL_TOOL = /^mcp__(.+?)__(.+)$/;
const bareScheme = (s: string): string => s.toLowerCase().replace(/:?\/*$/, "");
const schemeOf = (s: string): string | undefined => /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1]?.toLowerCase();
const matchesOf = (m: InstalledManifest): M["matches"] => m.manifest.matches;
/** The templates of `matches.calls` (a creation subject is a subject template too). */
const callTemplatesOf = (m: M["matches"]): string[] => Object.values(m.calls ?? {}).flatMap((e) => e.subjects.map((s) => s.template));

/** Every installed connector that matches an MCP call, strongest first. A claim is the first way that connector matches (its best rank). */
function mcpClaimsFor(installed: readonly InstalledManifest[], server: string, tool: string): Claim[] {
  const out: Claim[] = [];
  for (const i of installed) {
    const m = matchesOf(i);
    const via: Via | undefined = m.mcpTools?.includes(tool) === true || m.mcpTools?.includes(`mcp__${server}__${tool}`) === true ? "mcpTools"
      : Object.hasOwn(m.subjects ?? {}, `mcp__${server}__${tool}`) || Object.hasOwn(m.subjects ?? {}, tool) || Object.hasOwn(m.calls ?? {}, `mcp__${server}__${tool}`) || Object.hasOwn(m.calls ?? {}, tool) ? "subjects"
      : m.mcpServers?.includes(server) === true ? "mcpServers" : undefined;
    if (via !== undefined) out.push({ id: i.manifest.id, dir: i.dir, via, len: 0 });
  }
  return out.sort(byWinner);
}

/** Every installed connector that matches a subject (a connector URI, or a file path by extension), strongest first. */
function subjectClaimsFor(installed: readonly InstalledManifest[], subject: string): Claim[] {
  const out: Claim[] = [];
  const scheme = schemeOf(subject);
  const name = path.basename(subject).toLowerCase();
  for (const i of installed) {
    const m = matchesOf(i);
    if (scheme !== undefined) {
      if ([...Object.values(m.subjects ?? {}), ...callTemplatesOf(m)].some((t) => schemeOf(t) === scheme)) out.push({ id: i.manifest.id, dir: i.dir, via: "subjects", len: 0 });
      else if ((m.schemes ?? []).some((s) => bareScheme(s) === scheme)) out.push({ id: i.manifest.id, dir: i.dir, via: "schemes", len: 0 });
    } else {
      const len = Math.max(0, ...(m.extensions ?? []).map((e) => endsWithLen(name, e)));
      if (len > 0) out.push({ id: i.manifest.id, dir: i.dir, via: "extensions", len });
    }
  }
  return out.sort(byWinner);
}

/** The server and tool of a full MCP tool name (`mcp__notion__update_page`); a name that is not in that form is a bare tool with no server. */
const callOfTool = (tool: string): { server: string; tool: string } => {
  const full = FULL_TOOL.exec(tool);
  return full !== null ? { server: full[1]!, tool: full[2]! } : { server: "", tool };
};

/**
 * THE decision of which installed connector wins, for the hook and snapshot path, the page and the overlap warning alike. A call (server and tool,
 * which the hook knows from the full MCP tool name) ranks by what each manifest matched on for that call (mcpTools, subject template, mcpServers); a call no connector claims, and a
 * subject with no call, rank by the subject (subject template, schemes, extensions). With one matching connector every path picks it.
 */
export function winnerFor(installed: readonly InstalledManifest[], target: { subject?: string; call?: { server: string; tool: string } }): Claim | undefined {
  if (target.call !== undefined) {
    const win = mcpClaimsFor(installed, target.call.server, target.call.tool)[0];
    if (win !== undefined) return win;
  }
  return target.subject === undefined ? undefined : subjectClaimsFor(installed, target.subject)[0];
}

/** The one connector that handles `subject` (reached by the call `tool`, when the caller knows it), or undefined. */
export const connectorForSubject = (installed: readonly InstalledManifest[], subject: string, tool?: string): InstalledManifest | undefined => {
  const win = winnerFor(installed, tool === undefined ? { subject } : { subject, call: callOfTool(tool) });
  return win === undefined ? undefined : installed.find((i) => i.dir === win.dir);
};

/** The id of the one connector that handles an MCP call, or undefined. */

/** True when an installed, valid manifest handles the call: it names `server` in matches.mcpServers, the tool (its own name or the full `mcp__server__tool`) in matches.mcpTools, or the tool in matches.subjects. */
export function mcpConnectorMatches(home: string, server: string, tool: string): boolean {
  return mcpClaimsFor(readInstalledManifests(home), server, tool).length > 0;
}

export interface Overlap {
  /** What both claim, such as `mcp__notion__update_page`, `server notion`, `scheme notion` or `extension .notes.json`. */
  key: string;
  winner: string;
  losers: string[];
}

/**
 * Every place two or more installed connectors claim the same call or subject, with the one that wins and the ones that lose. Each connector is named once per overlap.
 * Deterministic: overlaps are sorted by key. A connector that wins one overlap can lose another.
 */
export function overlapsOf(installed: readonly InstalledManifest[]): Overlap[] {
  const out = new Map<string, Overlap>();
  const note = (key: string, claims: Claim[]): void => {
    const ids = [...new Set(claims.map((c) => c.id))];
    if (ids.length > 1) out.set(key, { key, winner: ids[0]!, losers: ids.slice(1) });
  };
  // calls: every full tool name any manifest names, and every bare tool name
  const tools = new Set<string>();
  for (const i of installed) for (const t of [...(matchesOf(i).mcpTools ?? []), ...Object.keys(matchesOf(i).subjects ?? {}), ...Object.keys(matchesOf(i).calls ?? {})]) tools.add(t);
  for (const t of tools) {
    const c = callOfTool(t);
    note(t, mcpClaimsFor(installed, c.server, c.tool));
  }
  const servers = new Set<string>(installed.flatMap((i) => matchesOf(i).mcpServers ?? []));
  for (const s of servers) note(`server ${s}`, installed.filter((i) => matchesOf(i).mcpServers?.includes(s) === true).map((i) => ({ id: i.manifest.id, dir: i.dir, via: "mcpServers" as const, len: 0 })).sort(byWinner));
  const schemes = new Set<string>(installed.flatMap((i) => (matchesOf(i).schemes ?? []).map(bareScheme)));
  for (const s of schemes) note(`scheme ${s}`, subjectClaimsFor(installed, `${s}://x`));
  const exts = new Set<string>(installed.flatMap((i) => (matchesOf(i).extensions ?? []).map((e) => e.toLowerCase()).filter((e) => e !== "")));
  for (const e of exts) note(`extension ${e}`, subjectClaimsFor(installed, `x${e}`));
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** One warning line for an overlap, as `cocheck connector doctor` and `cocheck connector test` print it. */
export const overlapWarning = (o: Overlap): string => `warning: ${o.key} is claimed by more than one connector: "${o.winner}" wins; not used for it: ${o.losers.map((l) => `"${l}"`).join(", ")} (order: ${WINNER_ORDER})`;

/** The matcher `buildRailModel` takes, for one CoCheck home. */
export const connectorMatcherFor = (home: string) => (server: string, tool: string): boolean => mcpConnectorMatches(home, server, tool);

const endsWithLen = (name: string, ext: string): number => (ext.length > 0 && name.endsWith(ext.toLowerCase()) ? ext.length : 0);

/**
 * The connector id a changed file is given, or undefined (CoCheck's own tiers take the file). Every connector claims file types by
 * its manifest's `matches.extensions`; per type, exactly one connector is enabled (connector/enabled-types.ts: the user's setting file, else
 * CoCheck's default rule). Among the types the file name ends in that have an enabled connector, the longest wins (".notes.json" over ".json").
 * Built-ins come from `builtins`, passed by CoCheck's own code; every manifest read from the home is an installed connector whatever it says about
 * itself, and an installed folder reusing a built-in's id is never that connector. Reads the manifests and the setting file once per call (the hook
 * calls this once per ledger write); never throws.
 */
export function connectorClaimsFor(home: string | undefined, builtins: ReadonlyArray<{ id: string; extensions: readonly string[] }> = []): (file: string) => string | undefined {
  const types = (exts: readonly string[]): string[] => [...new Set(exts.map(typeKey).filter((t) => t !== ""))];
  const claimants: Claimant[] = [
    ...builtins.map((b) => ({ id: b.id, builtin: true, types: types(b.extensions) })),
    ...readInstalledManifests(home).filter(({ manifest }) => !builtins.some((b) => b.id === manifest.id)).map(({ manifest }) => ({ id: manifest.id, builtin: false, types: types(manifest.matches.extensions ?? []) })),
  ];
  if (claimants.length === 0) return () => undefined;
  const enabled = typeStates(claimants, readEnabledTypes(home)).filter((s) => s.enabled !== undefined).map((s) => ({ type: s.type, id: s.enabled! }));
  return (file) => {
    const name = path.basename(file).toLowerCase();
    let best: { id: string; len: number } | undefined;
    for (const e of enabled) {
      const len = endsWithLen(name, e.type);
      if (len > (best?.len ?? 0)) best = { id: e.id, len };
    }
    return best?.id;
  };
}

/** The identity the hook records on a claimed file row (version and spec from the built-in or installed manifest; nothing is started), or undefined when the connector is neither or reads no file (entry diff). Never throws. */
export function fileConnectorIdentity(home: string, connector: string): { connectorVersion: string; connectorSpec: string } | undefined {
  try {
    const installed = connectorById(home, connector);
    if (installed === undefined) return undefined;
    const m = installed.manifest as unknown as { version?: unknown; spec?: unknown; entry?: string };
    if (m.entry === "diff") return undefined;
    return { connectorVersion: String(m.version ?? ""), connectorSpec: String(m.spec ?? MANIFEST_SPEC) };
  } catch {
    return undefined;
  }
}
