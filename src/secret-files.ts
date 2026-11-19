import path from "node:path";

/**
 * Files that look like they hold a secret: matched on the file's base name at any depth. A secret file is shown as "changed" only;
 * its contents are never read into a timeline, a page or a picture.
 */
const SECRET_NAMES: RegExp[] = [
  /\.env$/i,
  /^\.env\..+$/i,
  /\.pem$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /\.token$/i,
  /^service-account.*\.json$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^credentials/i,
  /^secrets\./i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
];

export function isSecretPath(relPath: string): boolean {
  const name = path.posix.basename(relPath.replace(/\\/g, "/"));
  return SECRET_NAMES.some((re) => re.test(name));
}

/** The line a changed secret file carries, followed by its path relative to the watched folder. */
export const SECRET_LINE = "A secret file was changed: ";

/** The one sentence for a changed secret file: its path, never its contents. */
export function secretLine(relPath: string): string {
  return `${SECRET_LINE}${relPath}`;
}
