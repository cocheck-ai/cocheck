import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * `cocheck connector create <dir> --id <id>`: copies the kit's starter connector into a new folder and fills the id into its manifest.
 * Structural rule: it writes only into a missing or empty directory, and every check runs before the first write.
 */

interface CreateResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

const TEMPLATE = path.resolve(import.meta.dirname, "../public-kit/scaffold/template");
// Same id rule `cocheck connector auth` applies, so a created connector can always be given credentials.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MANIFEST = "cocheck-connector.json";

const fail = (message: string): CreateResult => ({ exitCode: 1, stdout: "", stderr: `${message}\n` });

export function runConnectorCreate(argv: string[], opts: { template?: string } = {}): CreateResult {
  const template = opts.template ?? TEMPLATE;
  let dir: string | undefined;
  let id: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--id") {
      id = argv[++i];
      if (id === undefined) return fail("--id needs a value");
    } else if (a.startsWith("--")) return fail(`unknown option ${a}`);
    else if (dir === undefined) dir = a;
    else return fail("usage: cocheck connector create <dir> --id <id>");
  }
  if (dir === undefined || id === undefined) return fail("usage: cocheck connector create <dir> --id <id>");
  if (!ID.test(id)) return fail(`"${id}" is not a valid id: start with a letter or digit, then use only letters, digits, ".", "_" and "-".`);

  const target = path.resolve(dir);
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) return fail(`${dir} exists and is not a folder. Nothing was written.`);
    if (readdirSync(target).length > 0) return fail(`${dir} already has files in it. Nothing was written. Pick a new folder, or an empty one.`);
  }

  // An install that shipped without the kit has no starter; say so plainly instead of a raw ENOENT, before any write.
  if (!existsSync(template) || !statSync(template).isDirectory()) return fail(`The connector starter folder ${template} is missing from this CoCheck install, so nothing was written.`);

  // Read the whole template before the first write, so a broken template writes nothing either.
  const files = readdirSync(template).map((name) => ({ name, body: readFileSync(path.join(template, name), "utf8") }));
  const manifest = files.find((f) => f.name === MANIFEST);
  if (!manifest) return fail(`the starter is missing ${MANIFEST}. Nothing was written.`);
  manifest.body = JSON.stringify({ ...JSON.parse(manifest.body), id }, null, 2) + "\n";

  mkdirSync(target, { recursive: true });
  for (const f of files) writeFileSync(path.join(target, f.name), f.body);
  const quoted = /\s/.test(dir) ? JSON.stringify(dir) : dir;
  return {
    exitCode: 0,
    stdout: `Created connector "${id}" in ${dir}.\nNext:\n  1. Edit ${path.join(quoted, "connector.mjs")} where it says REPLACE.\n  2. cocheck connector test ${quoted}\n`,
    stderr: "",
  };
}
