// `cocheck connector list` (per file type: the connectors claiming it, which one is enabled, and where CoCheck's own tiers take it with none)
// and `cocheck connector enable|disable <id> <type>`, the only writers of `<home>/connector-types.json` (connector/enabled-types.ts).
import path from "node:path";
import { knownConnectors } from "./connector/builtins.ts";
import { coreDraws, ENABLED_TYPES_FILE, readEnabledTypes, stateOf, typeKey, typeStates, type Claimant, type TypeState } from "./connector/enabled-types.ts";
import { writeFileAtomicSync } from "./home-perms.ts";

interface TypesCliResult { exitCode: 0 | 1; stdout: string; stderr: string }

/** Every known connector (available built-ins, then installed ones whose id no built-in has) as a claimant of its manifest's types. */
export const claimantsOf = (home: string | undefined): Claimant[] =>
  knownConnectors(home).map((m) => ({ id: m.manifest.id, builtin: m.builtin === true, types: [...new Set((m.manifest.matches.extensions ?? []).map(typeKey).filter((t) => t !== ""))] }));

const coreWord = (type: string): string => (coreDraws(type) ? "CoCheck reads it itself" : "CoCheck's generic tiers (text, picture or fingerprint)");
const line = (s: TypeState): string =>
  `${s.type}: claimed by ${s.claimants.map((c) => (c.builtin ? `${c.id} (built-in)` : c.id)).join(", ")}; enabled: ${s.enabled ?? "none"} (${s.by === "setting" ? "set by you" : "default"}); with none enabled: ${coreWord(s.type)}`;

export function runConnectorList(argv: string[], run: { home: string }): TypesCliResult {
  if (argv.length > 0) return { exitCode: 1, stdout: "", stderr: "usage: cocheck connector list\n" };
  const setting = readEnabledTypes(run.home);
  const states = typeStates(claimantsOf(run.home), setting);
  const out = [...(setting.warning !== undefined ? [setting.warning] : []), ...(states.length === 0 ? ["No connector claims a file type."] : states.map(line))];
  return { exitCode: 0, stdout: `${out.join("\n")}\n`, stderr: "" };
}

/** `enable <id> <type>` makes `id` the one connector enabled for the type; `disable <id> <type>` leaves the type with none when `id` is the enabled one. */
export function runConnectorSwitch(argv: string[], run: { home: string }): TypesCliResult {
  const [verb, id, raw] = argv;
  const usage: TypesCliResult = { exitCode: 1, stdout: "", stderr: "usage: cocheck connector enable|disable <id> <file ending>\n" };
  if ((verb !== "enable" && verb !== "disable") || id === undefined || raw === undefined || argv.length !== 3) return usage;
  const claimants = claimantsOf(run.home);
  const who = claimants.find((c) => c.id === id);
  if (who === undefined) return { exitCode: 1, stdout: "", stderr: `no connector "${id}" is known\n` };
  const asked = typeKey(raw);
  const type = who.types.includes(asked) ? asked : who.types.includes(`.${asked}`) ? `.${asked}` : undefined;
  if (type === undefined) return { exitCode: 1, stdout: "", stderr: `"${id}" does not claim ${raw}; it claims ${who.types.join(", ") || "no file type"}\n` };
  const setting = readEnabledTypes(run.home);
  const file = path.join(run.home, ENABLED_TYPES_FILE);
  if (setting.warning !== undefined) return { exitCode: 1, stdout: "", stderr: `${setting.warning}\nNothing was changed: fix or move ${file} first.\n` };
  const was = stateOf(type, claimants, setting).enabled;
  if (verb === "disable" && was !== id) return { exitCode: 0, stdout: `"${id}" is not enabled for ${type}; nothing changed.\n`, stderr: "" };
  const next = verb === "enable" ? id : null;
  writeFileAtomicSync(file, `${JSON.stringify({ types: { ...setting.types, [type]: next } }, null, 2)}\n`);
  return { exitCode: 0, stdout: verb === "enable" ? `"${id}" is enabled for ${type}${was !== undefined && was !== id ? ` (was "${was}")` : ""}.\n` : `"${id}" is disabled for ${type}; with no connector enabled, ${coreWord(type)} takes it.\n`, stderr: "" };
}
