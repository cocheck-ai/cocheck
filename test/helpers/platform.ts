// One place for "this test needs a particular OS". A Mac-only test passes `macOnly(reason)` as its options argument
// (`it(name, macOnly("..."), fn)`, same for `describe`); off macOS it skips and states the reason, on macOS it is a no-op.
// A Linux or Windows port adds its own `linuxOnly` / `windowsOnly` here and widens nothing else.
export const isMac = process.platform === "darwin";

export function macOnly(reason: string): { skip: string | false } {
  return { skip: isMac ? false : `needs macOS: ${reason}` };
}

export const isWindows = process.platform === "win32";

/** A test of POSIX file modes, symlinks, FIFOs or a /bin shell. On Windows it skips and states the reason; elsewhere it is a no-op. */
export function posixOnly(reason: string): { skip: string | false } {
  return { skip: isWindows ? `needs POSIX: ${reason}` : false };
}
