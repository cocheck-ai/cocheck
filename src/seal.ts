import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCoCheckHome } from "./ledger.ts";
import { platform } from "./platform/index.ts";
import { SecretStoreError } from "./platform/types.ts";
import type { FormatLayer, SnapshotMode } from "./formats/layer.ts";

/**
 * Encryption at rest for the file copies in the store.
 *
 * A sealed file is `MAGIC (8) | version (1) | iv (12) | ciphertext | GCM tag (16)`; the first nine bytes are also the
 * authenticated data, so a flipped byte anywhere, a truncation, or the wrong key fails authentication and throws. The key is
 * 32 random bytes per CoCheck home, kept in the macOS Keychain (`security`); Node's crypto does the rest. Names do not change:
 * a copy is still named by the sha-256 of its plaintext (hash first, then seal).
 *
 * Every reader goes through `readSealed` / `withPlainPaths`, every writer through `writeSealed`.
 * A key that cannot be had raises `KeyMissingError` (code KEY_MISSING), which is not "the state is gone": catch-all readers rethrow it.
 */

const SEAL_MAGIC = Buffer.from("COCHECK\0");
const SEAL_VERSION = 1;
const HEADER_LEN = SEAL_MAGIC.length + 1;
const IV_LEN = 12;
const TAG_LEN = 16;
/** Bytes a sealed file adds to its plaintext. */
const SEAL_OVERHEAD = HEADER_LEN + IV_LEN + TAG_LEN;

export const KEY_MISSING = "KEY_MISSING";

export class KeyMissingError extends Error {
  readonly code = KEY_MISSING;
  constructor(detail: string) {
    super(`${KEY_MISSING}: the key that encrypts CoCheck's stored file copies is not available (${detail}). Nothing was read or written in plaintext.`);
    this.name = "KeyMissingError";
  }
}

/** A sealed file that fails authentication (tampered, truncated, or sealed under another key) or a stored file that is not sealed at all. */
export class SealError extends Error {
  readonly code: "SEAL_AUTH" | "NOT_SEALED";
  constructor(code: "SEAL_AUTH" | "NOT_SEALED", detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SealError";
    this.code = code;
  }
}

export const isKeyMissing = (error: unknown): error is KeyMissingError => error instanceof KeyMissingError || (error as { code?: unknown } | null)?.code === KEY_MISSING;

/** Where the key lives. `get` returns null when there is no key yet; `create` (optional) makes one. Both may throw `KeyMissingError`. */
export interface KeyProvider {
  get(home: string): Buffer | null;
  create?(home: string): Buffer;
}

export const KEYCHAIN_SERVICE = "cocheck-store-key";
/** The home's realpath (its nearest existing ancestor's, when the home is not there yet), so a symlinked path finds the same key. */
function realHome(home: string): string {
  let rest = "";
  let dir = path.resolve(home);
  for (;;) {
    try {
      return path.join(realpathSync(dir), rest);
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return path.resolve(home);
      rest = path.join(path.basename(dir), rest);
      dir = up;
    }
  }
}
const keychainAccount = (home: string): string => createHash("sha256").update(realHome(home)).digest("hex").slice(0, 32);

/**
 * The real provider: the login Keychain through the system `security` tool. Under the test runner it refuses unless
 * COCHECK_SECURITY_BIN names a stand-in, so no test can reach the real Keychain by accident.
 */
export const keychainProvider: KeyProvider = {
  get(home) {
    try {
      return platform().secretStore.get(KEYCHAIN_SERVICE, keychainAccount(home));
    } catch (error) {
      if (error instanceof SecretStoreError) throw new KeyMissingError(error.message);
      throw error;
    }
  },
  create(home) {
    const key = randomBytes(32);
    try {
      platform().secretStore.create(KEYCHAIN_SERVICE, keychainAccount(home), key);
    } catch (error) {
      if (!(error instanceof SecretStoreError)) throw error;
      // A second process may have created it first: use theirs.
      const existing = keychainProvider.get(home);
      if (existing) return existing;
      throw new KeyMissingError(error.message);
    }
    return key;
  },
};

let provider: KeyProvider = keychainProvider;
const keys = new Map<string, Buffer>();

/** Installs a key provider (tests inject one; `null` restores the Keychain) and forgets cached keys. */
export function setKeyProvider(next: KeyProvider | null): void {
  provider = next ?? keychainProvider;
  keys.clear();
}

/** A provider that holds one fixed key in memory. */
export function memoryKeyProvider(key: Buffer = randomBytes(32)): KeyProvider {
  return { get: () => key, create: () => key };
}

function keyFor(create: boolean, home: string = resolveCoCheckHome()): Buffer {
  const cached = keys.get(home);
  if (cached) return cached;
  let key = provider.get(home);
  if (key === null) {
    if (!create || !provider.create) throw new KeyMissingError("no key exists for this CoCheck home");
    // A key is generated only for a store that holds nothing sealed yet. Encrypted files with no key are a lost key, never a reason to start over.
    if (holdsSealedFiles(home)) throw new KeyMissingError("this store holds encrypted files but its key is not there; a new key would not open them");
    key = provider.create(home);
  }
  if (key.length !== 32) throw new KeyMissingError("the key is not 32 bytes");
  keys.set(home, key);
  return key;
}

export function sealBytes(plain: Uint8Array, home?: string): Buffer {
  const key = keyFor(true, home);
  const iv = randomBytes(IV_LEN);
  const header = Buffer.concat([SEAL_MAGIC, Buffer.from([SEAL_VERSION])]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  return Buffer.concat([header, iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export const hasSealHeader = (bytes: Uint8Array): boolean => bytes.length >= HEADER_LEN && Buffer.from(bytes.buffer, bytes.byteOffset, HEADER_LEN).equals(Buffer.concat([SEAL_MAGIC, Buffer.from([SEAL_VERSION])]));

export function openBytes(sealed: Buffer, what = "a stored copy", home?: string): Buffer {
  if (!hasSealHeader(sealed)) throw new SealError("NOT_SEALED", `${what} is not encrypted (no CoCheck header); it is not read as plaintext`);
  if (sealed.length < SEAL_OVERHEAD) throw new SealError("SEAL_AUTH", `${what} is truncated`);
  const key = keyFor(false, home);
  const header = sealed.subarray(0, HEADER_LEN);
  const iv = sealed.subarray(HEADER_LEN, HEADER_LEN + IV_LEN);
  const tag = sealed.subarray(sealed.length - TAG_LEN);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed.subarray(HEADER_LEN + IV_LEN, sealed.length - TAG_LEN)), decipher.final()]);
  } catch {
    throw new SealError("SEAL_AUTH", `${what} failed authentication (changed, truncated, or sealed under another key)`);
  }
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export async function readSealed(file: string): Promise<Buffer> {
  return openBytes(await readFile(file), file, homeOfStorePath(file));
}

/** SHA-256 of the plaintext inside a sealed file. */
export async function sha256OfSealed(file: string): Promise<string> {
  return sha256Hex(await readSealed(file));
}

let tmpN = 0;

/**
 * Seals `plain` into `dest` (owner-only), through a temp file in the same folder and a rename. The key is resolved first, so a
 * missing key writes nothing and leaves no temp file behind.
 */
export async function writeSealed(dest: string, plain: Uint8Array | string): Promise<void> {
  const sealed = sealBytes(typeof plain === "string" ? Buffer.from(plain) : plain, homeOfStorePath(dest));
  await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.tmp-seal-${process.pid}-${++tmpN}`;
  try {
    await writeFile(tmp, sealed, { mode: 0o600, flag: "wx" });
    await rename(tmp, dest);
    await chmod(dest, 0o600).catch(() => {});
    ensureNoIndexMarker(homeOfStorePath(dest));
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** True when the file starts with the CoCheck header (it may still fail authentication). */
function startsSealed(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(HEADER_LEN);
    const n = readSync(fd, head, 0, HEADER_LEN, 0);
    return n === HEADER_LEN && hasSealHeader(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The plaintext size of a sealed file on disk (from its size alone, without decrypting). */
export const plainSizeOf = (sealedSize: number): number => Math.max(0, sealedSize - SEAL_OVERHEAD);

/**
 * Runs `use` with plaintext copies of the sealed files `paths` (null passes through), each in a private temp folder (0700, files 0600)
 * under its original name, so a layer that picks its reader by extension still can. The folder is removed when `use` ends, either way.
 */
export async function withPlainPaths<T>(paths: Array<string | null>, use: (plain: Array<string | null>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-plain-"));
  try {
    await chmod(dir, 0o700);
    const out: Array<string | null> = [];
    for (const [i, p] of paths.entries()) {
      if (p === null) {
        out.push(null);
        continue;
      }
      const slot = path.join(dir, String(i));
      await mkdir(slot, { mode: 0o700 });
      const target = path.join(slot, path.basename(p));
      await writeFile(target, await readSealed(p), { mode: 0o600 });
      out.push(target);
    }
    return await use(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `layer` with its copy-touching methods routed through the seal: `snapshot` writes ciphertext (the layer's own copy goes to a
 * private temp folder first, so plaintext never lands in the store), and `diff`, `restate` and `summarizeNew`
 * read plaintext copies that exist only for the call. Everything else is the layer's own.
 */
export function sealLayer(layer: FormatLayer): FormatLayer {
  // Not a spread: a layer may carry its methods on a prototype, and wrapping must keep them.
  const out: FormatLayer = Object.create(layer);
  const set = <K extends keyof FormatLayer>(name: K, value: FormatLayer[K]): void => void Object.defineProperty(out, name, { value, writable: true, configurable: true, enumerable: true });
  set("snapshot", async (source: string, dest: string): Promise<SnapshotMode> => {
    keyFor(true, homeOfStorePath(dest)); // a missing key stops here, before the layer copies anything
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-snap-"));
    try {
      await chmod(dir, 0o700);
      const staging = path.join(dir, path.basename(dest));
      const mode = await layer.snapshot(source, staging);
      if (mode !== "missing" && existsSync(staging)) await writeSealed(dest, await readFile(staging));
      return mode;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  set("diff", (before, after) => withPlainPaths([before, after], ([b, a]) => layer.diff(b, a!)));
  set("restate", (snapshotPath, row) => withPlainPaths([snapshotPath], ([p]) => layer.restate(p, row)));
  if (layer.summarizeNew) {
    const inner = layer.summarizeNew.bind(layer);
    set("summarizeNew", (after) => withPlainPaths([after], ([a]) => inner(a!)));
  }
  return out;
}

const COPY_SKIP = /(^|\/)(folder\.json|previews)(\/|$)/;

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

/** The files that hold copies of user files under a home: `tasks/<id>/round-*` and `tasks/<id>/states`, plus the hook folders' own copies. */
function copyFilesUnder(home: string): string[] {
  const roots = [path.join(home, "tasks"), path.join(home, "hooks")];
  const out: string[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const rel = path.relative(home, file);
      if (COPY_SKIP.test(rel)) continue;
      const parts = rel.split(path.sep);
      const inTasks = parts[0] === "tasks" && (parts[2]?.startsWith("round-") || parts[2] === "states" || parts[2] === "resolve");
      const inHooks = parts[0] === "hooks" && parts.includes("copies");
      if (inTasks || inHooks) out.push(file);
    }
  }
  return out;
}

/** True when the home already holds a sealed copy. */
function holdsSealedFiles(home: string): boolean {
  return copyFilesUnder(home).some((f) => startsSealed(f));
}

/** The file that tells Spotlight to skip the store. `tmutil addexclusion` (Time Machine) is a documented manual step: see docs/security.md. */
export const NO_INDEX_MARKER = ".metadata_never_index";

/** The CoCheck home a store path lives under: the folder above the nearest `tasks`, `hooks` or `connector-states` segment, else the configured home. */
function homeOfStorePath(file: string): string {
  const parts = path.resolve(file).split(path.sep);
  for (let i = parts.length - 2; i > 0; i--) {
    if (parts[i] === "tasks" || parts[i] === "hooks" || parts[i] === "connector-states") return parts.slice(0, i).join(path.sep) || path.sep;
  }
  return resolveCoCheckHome();
}

/** Creates the Spotlight exclusion marker in `home`. Idempotent. */
function ensureNoIndexMarker(home: string): void {
  const marker = path.join(home, NO_INDEX_MARKER);
  if (existsSync(marker)) return;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(marker, "", { mode: 0o600 });
}
