import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { afterEach, describe, it } from "node:test";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { memoryKeyProvider, sha256Hex, setKeyProvider } from "../src/seal.ts";
import { redactSecrets } from "../src/secret-scan.ts";
import { freezeChanges, pngSize, readFrozen, readPicture } from "../src/connector/frozen.ts";
import { inflateSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeRig, type Rig } from "./hook-corpus.ts";
import { drawn } from "./helpers/made-page.ts";
import { runCleanups } from "./helpers/cleanups.ts";
import { workbookClaims } from "./helpers/claims.ts";

// Plan step 1 (office pictures, 2026-11-10), general to every connector: an `image` picture's PNG data URL is lifted at freeze into the task's sealed
// picture store, named by its sha256, and the frozen document's src becomes `cpic/<sha>`; the review route serves those exact bytes as image/png and the
// page draws an <img>. The connector here is a non-Office test connector for a `.toy` ending (test/fixtures/connector-toy-image).
const CONNECTOR = path.join(import.meta.dirname, "fixtures", "connector-toy-image");
const TOKEN = "t".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await runCleanups(cleanups); setKeyProvider(null); });

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0);
  return Buffer.concat([len, tb, crc]);
}
/** A valid 2x2 RGBA PNG; `extra` is an ancillary chunk placed right after IHDR (offset 41, so its body starts at 41 + `pad`). */
function png(rgb: [number, number, number], extra?: Buffer): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.from([0, ...rgb, 255, ...rgb, 255]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...(extra === undefined ? [] : [chunk("prVt", extra)]), chunk("IDAT", deflateSync(Buffer.concat([row, row]))), chunk("IEND", Buffer.alloc(0))]);
}
const dataUrl = (b: Buffer): string => `data:image/png;base64,${b.toString("base64")}`;
/**
 * A PNG whose base64 carries an AWS-style key inside its pixels (kept chunks only, so stripping leaves it whole): a 6x1 RGBA image in one stored
 * (level 0) deflate block, so IDAT's body (byte 41) is zlib header (2), block header (5), filter byte (1), then the pixels from byte 49; two pad
 * bytes put the planted run at byte 51 (a multiple of 3), so its base64 text appears verbatim.
 */
const SECRETISH = "////AKIAZ2Z3Z4Z5Z6Z7QRST////";
const secretPng = (): Buffer => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(6, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.concat([Buffer.from([0, 0x6b, 0x6b]), Buffer.from(SECRETISH, "base64"), Buffer.from([255])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
};

async function session(before: unknown, after: unknown, hexAfter = false) {
  setKeyProvider(memoryKeyProvider());
  const r: Rig = await makeRig();
  cleanups.push(() => r.cleanup());
  await mkdir(path.join(r.home, "connectors"), { recursive: true });
  await cp(CONNECTOR, path.join(r.home, "connectors", "toy-image"), { recursive: true });
  const file = path.join(r.folder, "picture.toy");
  await writeFile(file, JSON.stringify({ pic: before }));
  let clock = 1_700_000_000_000;
  const opts = { host: "claude" as const, home: r.home, claimed: workbookClaims, folder: r.folder, now: () => (clock += 1000) };
  const base = { session_id: "cpic-session", cwd: r.folder, transcript_path: "/x/t.jsonl", permission_mode: "default" };
  const call = (event: string, extra: Record<string, unknown> = {}) => ({ ...base, hook_event_name: event, tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "python3 edit.py", description: "edit" }, ...extra });
  const send = (p: Record<string, unknown>) => handleHook(p as unknown as HookPayload, opts);
  await send({ ...base, hook_event_name: "UserPromptSubmit", prompt: "edit the picture" });
  await send(call("PreToolUse"));
  await writeFile(file, JSON.stringify(hexAfter ? { picHex: Buffer.from(String(after), "utf8").toString("hex") } : { pic: after }));
  await send(call("PostToolUse", { tool_response: { stdout: "ok" } }));
  const ledger = openLedger(r.home);
  const { server, port } = await startReviewServer(ledger, TOKEN, r.home, 0, undefined, { previewRenderer: async () => null, quickLook: false });
  cleanups.push(async () => { await new Promise<void>((res) => server.close(() => res())); ledger.close(); });
  const get = (p: string, token = TOKEN): Promise<{ status: number; type: string; body: Buffer }> => new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: `${p}?t=${token}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
  const task = ledger.allTaskIds()[0]!;
  /** The served document of the one change, asked again until the review process froze it. */
  const served = async (): Promise<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const until = Date.now() + 15_000;
    for (;;) {
      const timeline = JSON.parse((await get(`/timeline/${task}`)).body.toString("utf8")) as { unplaced: Array<{ id: string }>; requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string }> }> }> }> };
      const all = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((x) => x.calls.flatMap((c) => c.changes)))];
      assert.equal(all.length, 1);
      const view = await get(`/timeline/${task}/view/${encodeURIComponent(all[0]!.id)}`);
      assert.equal(view.status, 200, view.body.toString("utf8"));
      const doc = JSON.parse(view.body.toString("utf8"));
      if (doc.pending !== true || Date.now() > until) return doc;
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  /** The frozen document of the task's one captured connector row, and its sealed bytes as text. */
  const frozen = async (): Promise<{ doc: Record<string, any>; text: string }> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const row = ledger.fileStatesForTask(task).find((x) => x.connector != null && x.changesSha256);
    assert.ok(row, "the connector row is frozen");
    const doc = (await readFrozen(r.home, task, row!.changesSha256!)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    return { doc, text: JSON.stringify(doc) };
  };
  return { r, ledger, get, task, served, frozen };
}

describe("a connector's image picture is lifted at freeze, served by CoCheck, drawn as <img>", () => {
  it("(a)(b)(c) the frozen doc holds cpic/<sha> and no data URL; the route answers the exact PNG as image/png; the page draws an <img> on it", async () => {
    const before = png([255, 0, 0]), after = png([0, 255, 0]);
    const s = await session(dataUrl(before), dataUrl(after));
    const doc = await s.served();
    const fr = await s.frozen();
    assert.ok(!fr.text.includes("data:"), "no data URL is kept in the frozen document");
    const srcs = Object.fromEntries((fr.doc.pictures as Array<{ side: string; src: string; width: number; height: number }>).map((p) => [p.side, p]));
    assert.equal(srcs.before!.src, `cpic/${sha256Hex(before)}`);
    assert.equal(srcs.after!.src, `cpic/${sha256Hex(after)}`);
    assert.equal(srcs.after!.width, 2, "a missing size is read from the PNG header");
    assert.equal(srcs.after!.height, 2);
    assert.deepEqual(doc.pictures.map((p: { src: string }) => p.src), [srcs.before!.src, srcs.after!.src], "served as frozen");

    for (const [side, bytes] of [["before", before], ["after", after]] as const) {
      const got = await s.get(`/timeline/${s.task}/cpic/${sha256Hex(bytes)}`);
      assert.equal(got.status, 200);
      assert.equal(got.type, "image/png");
      assert.ok(got.body.equals(bytes), `${side}: the exact bytes`);
    }
    // Scoped like the other picture routes: the token, the task, and a picture this task's own frozen documents name.
    assert.equal((await s.get(`/timeline/${s.task}/cpic/${sha256Hex(after)}`, "x".repeat(40))).status, 403);
    assert.equal((await s.get(`/timeline/${s.task + 1}/cpic/${sha256Hex(after)}`)).status, 404);
    assert.equal((await s.get(`/timeline/${s.task}/cpic/${"0".repeat(64)}`)).status, 404);
    assert.equal((await s.get(`/timeline/${s.task}/cpic/${sha256Hex(after).toUpperCase()}`)).status, 404);

    const page = await drawn(doc);
    const imgs = page.all.filter((n) => n.tag === "img" && /\/cpic\//.test(n.attrs.src ?? ""));
    assert.deepEqual(imgs.map((n) => /\/cpic\/([0-9a-f]{64})/.exec(n.attrs.src!)![1]).sort(), [sha256Hex(before), sha256Hex(after)].sort(), "one <img> per side, on the cpic route");
    assert.ok(imgs.every((n) => n.attrs.width === "2" && n.attrs.height === "2"));
  });

  it("(d) a PNG whose base64 holds a secret-looking run is kept byte for byte (the redactor would have cut it)", async () => {
    const bytes = secretPng();
    const url = dataUrl(bytes);
    assert.ok(url.includes(SECRETISH), "the planted run is in the data URL");
    assert.notEqual(redactSecrets(url), url, "the redactor does match it, so an exemption is what keeps it whole");
    const s = await session(dataUrl(png([1, 2, 3])), url, true);
    await s.served();
    const fr = await s.frozen();
    const after = (fr.doc.pictures as Array<{ side: string; src: string }>).find((p) => p.side === "after")!;
    assert.equal(after.src, `cpic/${sha256Hex(bytes)}`);
    const got = await s.get(`/timeline/${s.task}/cpic/${sha256Hex(bytes)}`);
    assert.equal(got.status, 200);
    assert.ok(got.body.equals(bytes), "served unchanged");
  });

  it("(e) a non-PNG data URL is never stored or shown: its src is dropped and a caveat says so", async () => {
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const s = await session(`data:image/png;base64,${gif.toString("base64")}`, `data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")}`);
    const doc = await s.served();
    const fr = await s.frozen();
    assert.ok(!fr.text.includes("data:"));
    for (const p of fr.doc.pictures as Array<{ src?: string }>) assert.equal(p.src, undefined);
    assert.ok((fr.doc.caveats as string[]).filter((c) => /not a PNG/.test(c)).length === 2, JSON.stringify(fr.doc.caveats));
    let stored: string[] = [];
    try { stored = await readdir(path.join(s.r.home, "tasks", String(s.task), "pictures")); } catch { /* none */ }
    assert.deepEqual(stored, [], "nothing is stored");
    assert.equal((await s.get(`/timeline/${s.task}/cpic/${sha256Hex(gif)}`)).status, 404);
    const page = await drawn(doc);
    assert.equal(page.all.filter((n) => n.tag === "img").length, 0, "no picture is drawn");
  });

  it("a connector that writes a cpic/<sha> src itself is not trusted: the src is dropped", async () => {
    const real = png([9, 9, 9]);
    const s = await session(dataUrl(real), `cpic/${sha256Hex(real)}`);
    await s.served();
    const fr = await s.frozen();
    const after = (fr.doc.pictures as Array<{ side: string; src?: string }>).find((p) => p.side === "after")!;
    assert.equal(after.src, undefined);
  });
});

describe("a lifted PNG keeps only the chunks that draw it (text chunks bypass the secret redactor)", () => {
  const SECRET = "ghp_Zx8Kq2Lm9Nw4Rt7Yp1Vb6Cd3Fg5Hj0As2De4";
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunksOf = (b: Buffer): Array<{ type: string; data: Buffer }> => {
    const out: Array<{ type: string; data: Buffer }> = [];
    for (let at = 8; at < b.length;) { const len = b.readUInt32BE(at); out.push({ type: b.toString("latin1", at + 4, at + 8), data: b.subarray(at + 8, at + 8 + len) }); at += 12 + len; }
    return out;
  };
  /** Freezes one answer whose after picture is `bytes`; returns the frozen doc, the served picture and its address. */
  async function freezeOne(bytes: Buffer, text = "x"): Promise<{ doc: Record<string, any>; sha: string; served: Buffer }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    setKeyProvider(memoryKeyProvider());
    const home = mkdtempSync(path.join(tmpdir(), "cpic-strip-"));
    const r = await freezeChanges(home, 7, { spec: "cocheck.changes/1", changes: [{ id: "c1", mark: "changed", label: "x", text }], pictures: [{ id: "p", side: "after", type: "image", src: dataUrl(bytes), label: "p" }], caveats: [] });
    const doc = (await readFrozen(home, 7, r.sha256)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const sha = /^cpic\/([0-9a-f]{64})$/.exec(doc.pictures[0].src)![1]!;
    const served = await readPicture(home, 7, sha);
    assert.ok(served, "the picture is stored");
    return { doc, sha, served: served! };
  }

  it("a token in a tEXt chunk is not in the served bytes (nor in zTXt, iTXt, eXIf or an unknown ancillary chunk); the address is of the served bytes", async () => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
    const kept = [chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, 0]))), chunk("IEND", Buffer.alloc(0))];
    const bytes = Buffer.concat([SIG, kept[0]!, chunk("tEXt", Buffer.from("Comment\0" + SECRET, "latin1")), chunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0", "latin1"), deflateSync(Buffer.from(SECRET))])),
      chunk("iTXt", Buffer.from("Comment\0\0\0\0\0" + SECRET, "utf8")), chunk("eXIf", Buffer.from("MM\0*" + SECRET, "latin1")), chunk("prVt", Buffer.from(SECRET, "latin1")), kept[1]!, kept[2]!]);
    const { doc, sha, served } = await freezeOne(bytes, SECRET);
    assert.ok(!JSON.stringify(doc).includes(SECRET), "the change text is scrubbed");
    assert.ok(!served.includes(Buffer.from(SECRET, "latin1")), "the served picture does not hold the token");
    assert.ok(served.equals(Buffer.concat([SIG, ...kept])), "only IHDR, IDAT and IEND are left, byte for byte");
    assert.equal(sha, sha256Hex(served), "the address is the sha256 of the stored bytes");
  });

  it("a stripped picture still validates and decodes to the same pixels; PLTE and tRNS of a palette image are kept", async () => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 3;
    const raw = Buffer.from([0, 0, 1]);
    const plte = chunk("PLTE", Buffer.from([255, 0, 0, 0, 0, 255])), trns = chunk("tRNS", Buffer.from([255, 128]));
    const idat = deflateSync(raw);
    const bytes = Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("tIME", Buffer.alloc(7)), plte, trns, chunk("tEXt", Buffer.from("Author\0me", "latin1")), chunk("IDAT", idat.subarray(0, 4)), chunk("IDAT", idat.subarray(4)), chunk("IEND", Buffer.alloc(0))]);
    const { doc, served } = await freezeOne(bytes);
    assert.deepEqual(pngSize(served), { width: 2, height: 1 });
    assert.deepEqual(chunksOf(served).map((c) => c.type), ["IHDR", "PLTE", "tRNS", "IDAT", "IDAT", "IEND"]);
    assert.ok(inflateSync(Buffer.concat(chunksOf(served).filter((c) => c.type === "IDAT").map((c) => c.data))).equals(raw), "the pixels are unchanged");
    for (const c of chunksOf(served)) {
      const at = served.indexOf(Buffer.concat([Buffer.from(c.type, "latin1"), c.data]));
      assert.equal(served.readUInt32BE(at + 4 + c.data.length), crc32(Buffer.concat([Buffer.from(c.type, "latin1"), c.data])) >>> 0, `${c.type}: its CRC still holds`);
    }
    assert.equal(doc.pictures[0].width, 2);
  });

  it("a PNG with only the chunks that draw it is stored byte-identical", async () => {
    const bytes = png([10, 20, 30]);
    const { sha, served } = await freezeOne(bytes);
    assert.ok(served.equals(bytes));
    assert.equal(sha, sha256Hex(bytes));
  });
});
