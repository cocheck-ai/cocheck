import { posixOnly } from "./helpers/platform.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPathKit } from "../src/paths.ts";
import { platformFor } from "../src/platform/index.ts";
import { deliveryRefusal, isDeliveryPath, removeDeliveryCopies, withDeliveryCopies } from "../src/region-delivery.ts";
import type { RegionRef } from "../src/timeline/rail/regions.ts";
import { regionLines } from "../src/timeline/rail/send-back.ts";
import { regionsDirOf } from "../src/states.ts";

// The delivery copy of a region picture. Guard: a copy is never deleted before its task expires, and removal never takes
// the folder or another task's copy.

const win = createPathKit(platformFor("win32"));
const mac = createPathKit(platformFor("darwin"));
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));

function fixture(taskId = 1, id = 5) {
  const home = tmp("home-");
  const folder = tmp("folder-");
  mkdirSync(regionsDirOf(home, taskId), { recursive: true });
  const src = path.join(regionsDirOf(home, taskId), `${id}.png`);
  writeFileSync(src, "PNGBYTES");
  const ref: RegionRef = { id, stop: null, where: "page 1", lines: [], picture: src };
  return { home, folder, src, ref };
}

describe("path decisions on Windows forms (win32 kit, runs on any OS)", () => {
  it("the delivery folder and anything in it is recognised, a sibling is not", () => {
    assert.ok(isDeliveryPath("C:\\work\\proj", "C:\\work\\proj\\.cocheck\\regions\\a.png", win));
    assert.ok(isDeliveryPath("C:\\work\\proj\\", "c:/work/proj/.cocheck", win));
    assert.ok(!isDeliveryPath("C:\\work\\proj", "C:\\work\\proj\\.cocheck2\\a.png", win));
    assert.ok(!isDeliveryPath("C:\\work\\proj", "C:\\work\\proj\\src\\.cocheck\\a.png", win));
    assert.ok(!isDeliveryPath("C:\\work\\proj", "C:\\work\\proj\\..\\x\\.cocheck\\a.png", win));
    assert.ok(isDeliveryPath("/work/p", "/work/p/.cocheck/regions/a.png", mac));
  });
  it("a delivery folder at or inside the CoCheck home is refused", () => {
    const home = "C:\\Users\\me\\.cocheck";
    assert.equal(deliveryRefusal("C:\\Users\\me\\.cocheck\\.cocheck", home, win), "inside the CoCheck home");
    assert.equal(deliveryRefusal("c:\\users\\me\\.COCHECK", home, win), "inside the CoCheck home");
    assert.equal(deliveryRefusal("C:\\Users\\me\\proj\\.cocheck", home, win), null);
    assert.equal(deliveryRefusal("C:\\Users\\me\\.cocheck2\\.cocheck", home, win), null);
  });
});

describe("withDeliveryCopies", () => {
  it("copies to <folder>/.cocheck/regions/<32 hex>.png owner-only, keeps the home copy, no .gitignore outside a repo", posixOnly("owner-only mode bits (0600/0700)"), () => {
    const f = fixture();
    const [r] = withDeliveryCopies(f.home, 1, f.folder, [f.ref]);
    assert.match(r!.picture!, /\.cocheck[\\/]regions[\\/][0-9a-f]{32}\.png$/);
    assert.equal(readFileSync(r!.picture!, "utf8"), "PNGBYTES");
    assert.equal(statSync(r!.picture!).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(r!.picture!)).mode & 0o777, 0o700);
    assert.ok(existsSync(f.src));
    assert.ok(!existsSync(path.join(f.folder, ".cocheck", ".gitignore")));
    assert.ok(regionLines([r!]).join("\n").includes(`picture ${r!.picture}`));
  });
  it("inside a git repository a .gitignore of * is written inside .cocheck", () => {
    const f = fixture();
    mkdirSync(path.join(f.folder, ".git"));
    withDeliveryCopies(f.home, 1, f.folder, [f.ref]);
    assert.equal(readFileSync(path.join(f.folder, ".cocheck", ".gitignore"), "utf8"), "*\n");
  });
  it("a symlinked .cocheck is refused and nothing is written through it", () => {
    const f = fixture();
    const away = tmp("away-");
    symlinkSync(away, path.join(f.folder, ".cocheck"));
    const [r] = withDeliveryCopies(f.home, 1, f.folder, [f.ref]);
    assert.equal(r!.picture, f.src);
    assert.deepEqual(readdirSync(away), []);
  });
  it("a .cocheck/regions that is a symlink is refused too", () => {
    const f = fixture();
    const away = tmp("away-");
    mkdirSync(path.join(f.folder, ".cocheck"));
    symlinkSync(away, path.join(f.folder, ".cocheck", "regions"));
    assert.equal(withDeliveryCopies(f.home, 1, f.folder, [f.ref])[0]!.picture, f.src);
    assert.deepEqual(readdirSync(away), []);
  });
  it("a task folder that is the CoCheck home or inside it falls back to the home path", () => {
    const f = fixture();
    assert.equal(withDeliveryCopies(f.home, 1, f.home, [f.ref])[0]!.picture, f.src);
    const inside = path.join(f.home, "work");
    mkdirSync(inside);
    assert.equal(withDeliveryCopies(f.home, 1, inside, [f.ref])[0]!.picture, f.src);
    assert.ok(!existsSync(path.join(f.home, ".cocheck")) && !existsSync(path.join(inside, ".cocheck")));
  });
  it("no folder, or a region with no picture, changes nothing", () => {
    const f = fixture();
    assert.equal(withDeliveryCopies(f.home, 1, null, [f.ref])[0]!.picture, f.src);
    const none = { ...f.ref, picture: null };
    assert.deepEqual(withDeliveryCopies(f.home, 1, f.folder, [none]), [none]);
    assert.ok(!existsSync(path.join(f.folder, ".cocheck")));
  });
  it("a second call reuses the copy; an overwritten or missing copy is rewritten from the home copy, never named broken", () => {
    const f = fixture();
    const a = withDeliveryCopies(f.home, 1, f.folder, [f.ref])[0]!.picture!;
    assert.equal(withDeliveryCopies(f.home, 1, f.folder, [f.ref])[0]!.picture, a);
    writeFileSync(a, "TAMPERED");
    const b = withDeliveryCopies(f.home, 1, f.folder, [f.ref])[0]!.picture!;
    assert.equal(readFileSync(b, "utf8"), "PNGBYTES");
    const missing = { ...f.ref, picture: path.join(f.home, "gone.png") };
    assert.equal(withDeliveryCopies(f.home, 1, f.folder, [missing])[0]!.picture, missing.picture); // unreadable source: unchanged, and the prompt's own on-disk check drops it
    assert.ok(!regionLines([missing]).join("").includes("picture "));
  });
});

describe("removeDeliveryCopies", () => {
  afterEach(() => {});
  it("removes this task's copies file by file; the folder and another task's copy stay", () => {
    const shared = tmp("shared-");
    const a = fixture(1, 5);
    const home = a.home;
    mkdirSync(regionsDirOf(home, 2), { recursive: true });
    const src2 = path.join(regionsDirOf(home, 2), "9.png");
    writeFileSync(src2, "OTHER");
    const c1 = withDeliveryCopies(home, 1, shared, [a.ref])[0]!.picture!;
    const c2 = withDeliveryCopies(home, 2, shared, [{ id: 9, stop: null, where: "x", lines: [], picture: src2 }])[0]!.picture!;
    assert.notEqual(c1, c2);
    assert.ok(existsSync(c1) && existsSync(c2));
    // nothing deletes a copy while the task lives: a prompt rebuild keeps it
    withDeliveryCopies(home, 1, shared, [a.ref]);
    assert.ok(existsSync(c1));
    removeDeliveryCopies(home, 1);
    assert.ok(!existsSync(c1));
    assert.ok(existsSync(c2), "another task's copy stays");
    assert.ok(existsSync(path.join(shared, ".cocheck", "regions")), "the folder stays");
    removeDeliveryCopies(home, 1); // twice is fine
  });
});
void chmodSync;
