import path from "node:path";
// The scrub a recording goes through before it leaves a scratch folder: emails and the home path are replaced, and a token-shaped string left over fails the run.
// Shared by `cocheck harness record` and scripts/probe-host.ts.
// What a recorded home path becomes: the same text on every machine.
const HOME_PLACEHOLDER = path.posix.join("/", "Users", "<user>");
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TOKEN_SHAPES: Array<[string, RegExp]> = [
  ["sk- key", /sk-[A-Za-z0-9_-]{16,}/],
  ["ghp_ token", /ghp_[A-Za-z0-9]{16,}/],
  ["gho_ token", /gho_[A-Za-z0-9]{16,}/],
  ["JWT", /eyJ[A-Za-z0-9_-]{8,}/],
  ["Bearer value", /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/],
  ["private key header", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Replaces emails and the home path (as given and as its realpath, longest first). */
export function scrubText(text: string, homes: string[]): string {
  let out = text;
  for (const h of [...new Set(homes)].filter((x) => x.length > 1).sort((a, b) => b.length - a.length)) out = out.split(h).join(HOME_PLACEHOLDER);
  return out.replace(EMAIL, "user@example.com");
}

/** Names of the token shapes found in text. */
export function findTokenShapes(text: string): string[] {
  return TOKEN_SHAPES.filter(([, re]) => re.test(text)).map(([name]) => name);
}
