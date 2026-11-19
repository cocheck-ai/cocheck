import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DELIVERY_FOLDER } from "./formats/files/scan.ts";
import { pathKit, type PathKit } from "./paths.ts";
import { regionsDirOf } from "./states.ts";
import type { RegionRef } from "./timeline/rail/regions.ts";

/**
 * A picture region the agent can open. The home copy (`<home>/tasks/<task>/regions/<id>.png`) stays the source of truth; each picture a
 * send-back names also gets a copy at `<task folder>/.cocheck/regions/<unguessable>.png`, inside the folder an agent is usually permitted to read.
 * The copies are listed in `<home>/tasks/<task>/regions/delivered.json` so the expiry sweep deletes each one by name (never the folder: several
 * tasks may share it).
 */
const DELIVERED_LIST = "delivered.json";

/** Whether `p` is the delivery folder of `folder` or inside it. */
export function isDeliveryPath(folder: string, p: string, kit: PathKit = pathKit()): boolean {
  const root = kit.canon(kit.trimEnd(folder)).replace(/\/+$/, "") + "/" + DELIVERY_FOLDER;
  return kit.same(p, root) || kit.inside(root, p);
}

/** Whether `p` is the CoCheck data home or inside it: CoCheck's own, never a user change. */
export function isHomePath(home: string, p: string, kit: PathKit = pathKit()): boolean {
  const root = kit.canon(kit.trimEnd(home)).replace(/\/+$/, "");
  return kit.same(p, root) || kit.inside(root, p);
}

/** Why a delivery folder at `deliveryDir` must not be used (it is, or sits inside, the CoCheck home), or null. Both paths already resolved. */
export function deliveryRefusal(deliveryDir: string, home: string, kit: PathKit = pathKit()): string | null {
  return kit.same(deliveryDir, home) || kit.inside(home, deliveryDir) ? "inside the CoCheck home" : null;
}

type Listed = Record<string, string>;

function readList(home: string, taskId: number): Listed {
  try {
    const v = JSON.parse(readFileSync(path.join(regionsDirOf(home, taskId), DELIVERED_LIST), "utf8")) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, f]) => typeof f === "string")) as Listed;
  } catch {
    return {};
  }
}

function writeList(home: string, taskId: number, list: Listed): void {
  writeFileSync(path.join(regionsDirOf(home, taskId), DELIVERED_LIST), JSON.stringify(list), { mode: 0o600 });
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function inGitRepo(folder: string): boolean {
  for (let dir = path.resolve(folder); ; ) {
    if (existsSync(path.join(dir, ".git"))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/** The folder `<task folder>/.cocheck/regions`, made owner-only, or null when it may not be used. */
function deliveryDirOf(home: string, folder: string): string | null {
  try {
    const top = path.join(folder, DELIVERY_FOLDER);
    const sub = path.join(top, "regions");
    if (isLink(top) || isLink(sub)) return null;
    const realFolder = realpathSync(folder);
    const realHome = realpathSync(home);
    if (deliveryRefusal(path.join(realFolder, DELIVERY_FOLDER), realHome) !== null) return null;
    mkdirSync(sub, { recursive: true, mode: 0o700 });
    chmodSync(top, 0o700);
    chmodSync(sub, 0o700);
    if (isLink(top) || isLink(sub)) return null;
    // Only inside a git repository: a `.gitignore` of `*` keeps the folder (and the file itself) out of the person's commits.
    if (inGitRepo(folder) && !existsSync(path.join(top, ".gitignore"))) writeFileSync(path.join(top, ".gitignore"), "*\n", { mode: 0o600 });
    return sub;
  } catch {
    return null;
  }
}

/**
 * Gives each picture region of `refs` a delivery copy and returns the refs with `picture` set to the copy's path. A region whose copy cannot be made
 * (no usable folder, refused folder, any failure) keeps its home path; a region with no picture is unchanged.
 */
export function withDeliveryCopies(home: string, taskId: number, folder: string | null, refs: readonly RegionRef[]): RegionRef[] {
  if (folder === null || !refs.some((r) => r.picture !== null)) return [...refs];
  const dir = deliveryDirOf(home, folder);
  if (dir === null) return [...refs];
  const list = readList(home, taskId);
  let changed = false;
  const out = refs.map((r) => {
    if (r.picture === null) return r;
    try {
      const bytes = readFileSync(r.picture);
      const known = list[String(r.id)];
      let target = known !== undefined && path.dirname(known) === dir ? known : undefined;
      if (target !== undefined && !isLink(target) && existsSync(target) && readFileSync(target).equals(bytes)) return { ...r, picture: target };
      target ??= path.join(dir, `${randomBytes(16).toString("hex")}.png`);
      if (isLink(target)) return r;
      writeFileSync(target, bytes, { mode: 0o600 });
      chmodSync(target, 0o600);
      if (!readFileSync(target).equals(bytes)) return r;
      list[String(r.id)] = target;
      changed = true;
      return { ...r, picture: target };
    } catch {
      return r;
    }
  });
  if (changed) {
    try {
      writeList(home, taskId, list);
    } catch {
      // a copy that is not listed would outlive the task: remove the ones just made
      for (const r of out) if (r.picture !== null && list[String(r.id)] === r.picture) rmSync(r.picture, { force: true });
      return [...refs];
    }
  }
  return out;
}

/** Deletes each delivery copy of the task, file by file, never the folder. Called in the sweep that removes the home copy, before it. */
export function removeDeliveryCopies(home: string, taskId: number): void {
  const list = readList(home, taskId);
  for (const file of Object.values(list)) {
    try {
      if (!file.endsWith(".png")) continue;
      rmSync(file, { force: true });
    } catch {
      // gone, or not ours to remove: the sweep runs again
    }
  }
}
