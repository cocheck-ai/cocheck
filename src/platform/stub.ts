import { PlatformNotBuiltError, type Platform } from "./types.ts";

/** A platform whose every member throws `PlatformNotBuiltError`: no OS without an implementation silently uses Mac behaviour. */
export function notBuilt(name: NodeJS.Platform): Platform {
  const member = (path: string): ((...args: unknown[]) => never) => () => {
    throw new PlatformNotBuiltError(name, path);
  };
  const group = <T extends object>(prefix: string, keys: readonly string[]): T => Object.fromEntries(keys.map((k) => [k, member(`${prefix}.${k}`)])) as T;
  // Plain values (flags, modes) read as undefined-safe falsy data, so the stub reports nothing available and throws on any call.
  return {
    name,
    paths: { ...group<Platform["paths"]>("paths", ["userHome", "tmpDir", "isAbs", "toPosix"]), caseSensitive: false, foldsCase: false },
    openUrl: member("openUrl"),
    openFile: member("openFile") as Platform["openFile"],
    process: group("process", ["alive", "terminate", "commandLine", "spawnDetached"]),
    secretStore: group("secretStore", ["get", "create", "set", "delete", "location"]),
    hookCommand: group("hookCommand", ["build", "parse", "isMarked"]),
    fsSecurity: { ...group<Platform["fsSecurity"]>("fsSecurity", ["ownerOnly"]), fileMode: 0, dirMode: 0 },
    office: { liveExcel: false, render: false, thumbnails: false },
    shellDialect: { kind: "posix", shell: "" },
  };
}
