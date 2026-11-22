// `cocheck harness create <key> [--dir <path>]`: copies the kit's starter harness folder to <dir>/<key>/ and fills the key in.
// Structural rule: it writes only a new folder <dir>/<key>; an existing path of that name is refused, and every check runs before the first write.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { allProfiles } from "../hosts/index.ts";
import { RESERVED_KEYS } from "../hosts/harnesses.ts";
import { KEY, MANIFEST_FILE, validateManifest } from "../hosts/manifest.ts";
import type { HarnessIo } from "./index.ts";

const SCAFFOLD = path.resolve(import.meta.dirname, "../../public-kit/harness/scaffold");
const PLACEHOLDER = "myagent";
export const CREATE_USAGE = "usage: cocheck harness create <key> [--dir <path>]";

export function runHarnessCreate(argv: string[], io: HarnessIo, opts: { scaffold?: string } = {}): number {
  const scaffold = opts.scaffold ?? SCAFFOLD;
  const fail = (m: string): number => (io.err(m), 1);
  let key: string | undefined;
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dir") {
      dir = argv[++i];
      if (dir === undefined) return fail("--dir needs a value");
    } else if (a.startsWith("--")) return fail(`unknown option ${a}`);
    else if (key === undefined) key = a;
    else return fail(CREATE_USAGE);
  }
  if (key === undefined) return fail(CREATE_USAGE);
  if (!KEY.test(key)) return fail(`"${key}" is not a valid key: lowercase letters, digits and dashes, starting with a letter, at most 32.`);
  if (RESERVED_KEYS.includes(key) || allProfiles().some((p) => p.key === key)) return fail(`"${key}" is already a host in CoCheck; pick another key.`);
  const parent = path.resolve(io.cwd ?? process.cwd(), dir ?? ".");
  const target = path.join(parent, key);
  if (existsSync(target)) return fail(`${target} already exists. Nothing was written. Pick another key or --dir.`);
  if (!existsSync(scaffold) || !statSync(scaffold).isDirectory()) return fail(`The harness starter folder ${scaffold} is missing from this CoCheck install, so nothing was written.`);

  // Read the whole starter and check the result before the first write.
  const files: Array<{ rel: string; body: string }> = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(path.join(scaffold, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.name !== ".gitkeep") files.push({ rel: r, body: readFileSync(path.join(scaffold, r), "utf8").split(PLACEHOLDER).join(key).split(PLACEHOLDER.toUpperCase()).join(key.toUpperCase().replace(/-/g, "_")) });
    }
  };
  walk("");
  const manifest = files.find((f) => f.rel === MANIFEST_FILE);
  if (!manifest) return fail(`the starter is missing ${MANIFEST_FILE}. Nothing was written.`);
  try {
    validateManifest(JSON.parse(manifest.body), `${key}/${MANIFEST_FILE}`, { outsider: true });
  } catch (error) {
    return fail(`the starter does not validate: ${error instanceof Error ? error.message : String(error)}. Nothing was written.`);
  }

  mkdirSync(path.join(target, "recordings"), { recursive: true });
  for (const f of files) {
    mkdirSync(path.dirname(path.join(target, f.rel)), { recursive: true });
    writeFileSync(path.join(target, f.rel), f.body);
  }
  const q = (p: string) => (/\s/.test(p) ? JSON.stringify(p) : p);
  io.out(
    `Created harness "${key}" in ${target}.\nNext:\n` +
      `  1. cocheck harness record ${key} --manifest ${q(path.join(target, MANIFEST_FILE))} --out ${q(path.join(target, "recordings"))} -- <your harness command>\n` +
      `  2. Edit ${q(path.join(target, MANIFEST_FILE))} until the recordings read right (README.md there explains each part).\n` +
      `  3. cocheck harness test --cases <cases folder> --manifest ${q(path.join(target, MANIFEST_FILE))}\n` +
      `To try it: copy the folder to <CoCheck data home>/harnesses/${key}/ (or into the folder $COCHECK_HARNESS_DIR names), then run cocheck status.\n` +
      `To ship it with CoCheck: open a pull request that adds it under harnesses/${key}/ (data only, no code).`,
  );
  return 0;
}
