import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONNECTOR_SERVICE_PREFIX, SecretStoreError, type Platform } from "./platform/types.ts";

/**
 * `cocheck connector auth <id> --name <credential> [--delete]`: stores or removes one connector credential in the OS secret store.
 * The value is read from stdin only (no echo on a terminal), never from argv, and is never printed. The item is
 * service "cocheck-connector:<id>", account "<credential>"; the runner reads it with `secretStore.get`.
 */

interface AuthResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

export interface AuthRun {
  /** The CoCheck home; connectors live in `<home>/connectors/<id>/cocheck-connector.json`. */
  home: string;
  store: Platform["secretStore"];
  /** Reads the value: all of stdin, or a hidden prompt on a terminal. Called only when a value is needed. */
  readValue(): Promise<string>;
}

const fail = (message: string): AuthResult => ({ exitCode: 1, stdout: "", stderr: `${message}\n` });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function declaredNames(manifestFile: string): string[] | string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    return "its cocheck-connector.json cannot be read";
  }
  const list = (manifest as { credentials?: unknown } | null)?.credentials;
  if (!Array.isArray(list)) return [];
  return list.map((c) => (typeof c === "string" ? c : (c as { name?: unknown } | null)?.name)).filter((n): n is string => typeof n === "string");
}

export async function runConnectorAuth(argv: string[], run: AuthRun): Promise<AuthResult> {
  const usage = "usage: cocheck connector auth <id> --name <credential> [--delete]  (the value is read from stdin)";
  let id: string | undefined;
  let name: string | undefined;
  let remove = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--name") name = argv[++i];
    else if (a === "--delete") remove = true;
    else if (!a.startsWith("-") && id === undefined) id = a;
    else return fail(usage); // any other word could be a value on the command line: refused, and never echoed
  }
  if (id === undefined || name === undefined || name === "") return fail(usage);
  if (!ID.test(id)) return fail(`"${id}" is not a connector id`);
  const manifestFile = path.join(run.home, "connectors", id, "cocheck-connector.json");
  if (!existsSync(manifestFile)) return fail(`no connector "${id}" is installed (no ${manifestFile})`);
  const names = declaredNames(manifestFile);
  if (typeof names === "string") return fail(`connector "${id}": ${names}`);
  if (!names.includes(name)) return fail(`connector "${id}" does not declare a credential named "${name}"`);
  const service = CONNECTOR_SERVICE_PREFIX + id;
  try {
    if (remove) {
      return { exitCode: 0, stdout: run.store.delete(service, name) ? `Removed credential "${name}" for connector "${id}".\n` : `No credential "${name}" was stored for connector "${id}".\n`, stderr: "" };
    }
    const value = await run.readValue();
    if (value === "") return fail("nothing was read from stdin, so nothing was stored");
    run.store.set(service, name, Buffer.from(value, "utf8"));
    return { exitCode: 0, stdout: `Stored credential "${name}" for connector "${id}".\n`, stderr: "" };
  } catch (error) {
    if (error instanceof SecretStoreError) return fail(error.message.split("\n")[0]!);
    return fail(`could not ${remove ? "remove" : "store"} the credential: ${(error as Error).message.split("\n")[0]}`);
  }
}

/** Reads the value from the real stdin. On a terminal: a prompt on stderr and no echo. Otherwise all of stdin, minus one trailing newline. */
export function readStdinValue(stdin: NodeJS.ReadStream = process.stdin, stderr: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (stdin.isTTY) {
    return new Promise((resolve, reject) => {
      stderr.write("Credential value (hidden): ");
      let text = "";
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const done = (end: () => void) => {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        stderr.write("\n");
        end();
      };
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(() => resolve(text));
          if (ch === "\u0003") return done(() => reject(new Error("cancelled")));
          if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
          else text += ch;
        }
      };
      stdin.on("data", onData);
    });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stdin.on("data", (c: Buffer | string) => chunks.push(Buffer.from(c)));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "")));
    stdin.on("error", reject);
  });
}
