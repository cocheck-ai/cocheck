import { afterEach, describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import { sceneOfBody } from "./helpers/v1-served.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { zipSync } from "fflate";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { rendererFor, registeredExtensions } from "../src/timeline/render/registry.ts";
import { fallbackRenderer } from "../src/timeline/render/fallback.ts";
import type { GenericPart } from "../src/timeline/page.ts";
import type { ChangeInfo } from "../src/timeline/render/types.ts";

// The renderer registry and the fallback, then the view route through the real review server.
// Workbooks are built in memory (fflate); nothing here opens Excel or Quick Look.

const MTIME = new Date(2020, 0, 1);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

interface SheetSpec {
  name: string;
  /** Raw <row> xml. */
  rows: string;
  state?: string;
  extra?: string;
  /** Raw xml after <sheetData> (merges). */
  after?: string;
}

function workbook(sheets: SheetSpec[], extraParts: Record<string, string> = {}, styles?: string): Buffer {
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": enc(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = enc(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${s.extra ?? ""}<sheetData>${s.rows}</sheetData>${s.after ?? ""}</worksheet>`);
  });
  if (styles) files["xl/styles.xml"] = enc(styles);
  for (const [k, v] of Object.entries(extraParts)) files[k] = enc(v);
  return Buffer.from(zipSync(files, { mtime: MTIME }));
}

const str = (ref: string, text: string): string => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const num = (ref: string, v: number): string => `<c r="${ref}"><v>${v}</v></c>`;
const row = (r: number, ...cells: string[]): string => `<row r="${r}">${cells.join("")}</row>`;

/** Ten rows of "Item n" / value, with the value of `changed` rows replaced. */
function tenRows(overrides: Record<number, string> = {}): string {
  return Array.from({ length: 10 }, (_, i) => i + 1).map((r) => row(r, str(`A${r}`, `Item ${r}`), overrides[r] ?? num(`B${r}`, r * 10))).join("");
}

const info = (extra: Partial<ChangeInfo> = {}): ChangeInfo => ({ id: "c7", file: "model.xlsx", kind: "modified", ...extra });

describe("registry", () => {
  it("keys renderers by extension and falls back for anything else", () => {
    assert.ok(!registeredExtensions().includes(".xlsx"));
    assert.equal(rendererFor("a/b/Model.XLSX"), fallbackRenderer); // core has no Office renderer
    assert.equal(rendererFor("noext"), fallbackRenderer);
  });

  it("gives Word and slides no renderer of their own (the fallback card; the picture tier draws no claimed state)", () => {
    for (const f of ["notes.docx", "deck.PPTX", "deck.pptx"]) assert.equal(rendererFor(f), fallbackRenderer);
    assert.ok(!registeredExtensions().includes(".docx"));
    assert.ok(!registeredExtensions().includes(".pptx"));
  });
});


describe("fallback renderer", () => {
  const SHA_A = "a".repeat(64);
  const SHA_B = "b".repeat(64);
  it("wraps the image as pages with pixel boxes and the browser label", async () => {
    const generic: GenericPart = { tier: "picture", label: "x", picture: { before: SHA_A, after: SHA_B, width: 200, height: 100, regions: [{ x: 20, y: 10, w: 40, h: 20 }] } };
    const v = await fallbackRenderer.view(null, null, info({ file: "deck.pptx", generic }));
    assert.equal(v.kind, "pages");
    assert.equal(v.engine, "your browser, from the stored file");
    assert.deepEqual(v.before.map((p) => p.picture?.sha), [SHA_A]);
    assert.deepEqual(v.after.map((p) => p.picture?.sha), [SHA_B]);
    assert.deepEqual(v.boxes.map((b) => [b.side, b.confidence, b.rect]), [["before", "pixel", { x: 20, y: 10, w: 40, h: 20 }], ["after", "pixel", { x: 20, y: 10, w: 40, h: 20 }]]);
    assert.ok(!v.caveats.some((c) => /first page|Quick Look/.test(c)));
  });

  it("a picture with no differing region says so and boxes nothing", async () => {
    const generic: GenericPart = { tier: "picture", label: "x", picture: { before: SHA_A, after: SHA_B, width: 200, height: 100, regions: [], note: "The change isn't visible in this preview" } };
    const v = await fallbackRenderer.view(null, null, info({ generic }));
    assert.deepEqual(v.boxes, []);
    assert.ok(v.caveats.some((c) => /isn't visible/.test(c)));
  });

  it("no picture is a card", async () => {
    const v = await fallbackRenderer.view(null, null, info({ generic: { tier: "fingerprint", label: "f", fingerprint: { before: null, after: { sha: SHA_B, size: 3 }, kind: "binary file", note: "n" } } }));
    assert.equal(v.kind, "card");
    assert.deepEqual([v.before, v.after, v.boxes], [[], [], []]);
    assert.ok(v.caveats.length > 0);
    const none = await fallbackRenderer.view(null, null, info());
    assert.equal(none.kind, "card");
  });
});

// ---- the route ----

const TOKEN = "t".repeat(40);
const CLIENT = "claude:/work";
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function routeSetup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-view-home-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => null, quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const get = (p: string, opts: { token?: string | null; host?: string; headers?: Record<string, string>; method?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    const url = token === null ? p : `${p}${p.includes("?") ? "&" : "?"}t=${token}`;
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: url, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
  };
  let seq = 0;
  const task = async (name: string, a: Buffer, b: Buffer, opts: { storeAfter?: boolean; secretCopyOfAfter?: string } = {}): Promise<number> => {
    const id = ledger.openTask(CLIENT);
    const states = await ensureStoreDir(home, id);
    await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
    await writeSealed(path.join(states, sha(a)), a);
    if (opts.storeAfter !== false) await writeSealed(path.join(states, sha(b)), b);
    const file = `/work/${name}`;
    const callId = `toolu_${id}`;
    ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: [file], description: "edit", narration: { source: "none", text: "none" } } });
    ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Edit."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
    ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: file, sha256: sha(a), prevSha256: null, size: a.length, kept: "whole", note: "" }] });
    ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: file, sha256: sha(b), prevSha256: sha(a), size: b.length, kept: "whole", note: "" }] });
    // A second file, secret by name, whose bytes are the after bytes: the same bytes under a plain name must read as secret.
    if (opts.secretCopyOfAfter) ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [{ filePath: `/work/${opts.secretCopyOfAfter}`, sha256: sha(b), prevSha256: null, size: b.length, kept: "whole", note: "" }] });
    return id;
  };
  return { home, port, ledger, get, task };
}

describe("GET /timeline/<task>/view/<change key>", () => {
  it("serves a modified workbook as a card with no grid, no picture and no box", async () => {
    const s = await routeSetup();
    const a = workbook([{ name: "S", rows: tenRows() }]);
    const b = workbook([{ name: "S", rows: tenRows({ 4: num("B4", 7) }) }]);
    const id = await s.task("model.xlsx", a, b);
    const tl = JSON.parse((await s.get(`/timeline/${id}`)).body) as { requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string; kind: string }> }> }> }> };
    const key = tl.requests[0]!.runs[0]!.calls[0]!.changes.find((c) => c.kind === "modified")!.id;
    const res = await s.get(`/timeline/${id}/view/${key}`);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"]!, /^application\/json/);
    assert.ok(!Object.keys(res.headers).some((h) => h.startsWith("access-control-")));
    const doc = JSON.parse(res.body) as { kind: string; pictures: unknown[]; caveats: string[]; changes: Array<{ boxes?: unknown[] }> };
    assert.equal(doc.kind, "card");
    assert.deepEqual(doc.pictures, []);
    assert.ok(doc.caveats.some((c) => c.startsWith("No picture of this file could be made")), JSON.stringify(doc.caveats));
    assert.ok(doc.changes.every((c) => (c.boxes ?? []).length === 0));
  });

  it("refuses a missing or wrong token, a foreign Host, a foreign Origin and any method but GET; unknown key and unknown task are 404", async () => {
    const s = await routeSetup();
    const a = workbook([{ name: "S", rows: tenRows() }]);
    const id = await s.task("model.xlsx", a, workbook([{ name: "S", rows: tenRows({ 4: num("B4", 7) }) }]));
    const p = `/timeline/${id}/view/c1`;
    assert.equal((await s.get(p, { token: null })).status, 403);
    assert.equal((await s.get(p, { token: "x".repeat(40) })).status, 403);
    assert.equal((await s.get(p, { host: "evil.example" })).status, 403);
    assert.equal((await s.get(p, { headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal((await s.get(p, { method: "POST" })).status, 405);
    assert.equal((await s.get(`/timeline/${id}/view/c999999`)).status, 404);
    assert.equal((await s.get(`/timeline/${id}/view/..%2F..%2Fetc`)).status, 404);
    assert.equal((await s.get(`/timeline/99999/view/c1`)).status, 404);
  });

  it("never opens a secret file's bytes: a secret-named workbook is a 404", async () => {
    const s = await routeSetup();
    const a = workbook([{ name: "S", rows: tenRows() }]);
    const id = await s.task("credentials.xlsx", a, workbook([{ name: "S", rows: tenRows({ 4: num("B4", 7) }) }]));
    const tl = JSON.parse((await s.get(`/timeline/${id}`)).body) as { requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string }> }> }> }> };
    for (const c of tl.requests[0]!.runs[0]!.calls[0]!.changes) {
      const res = await s.get(`/timeline/${id}/view/${c.id}`);
      assert.equal(res.status, 404);
      assert.ok(!res.body.includes("Item"));
    }
  });

  it("a change whose after bytes are gone from the store is a card with a caveat, not an error or a guessed box", async () => {
    const s = await routeSetup();
    const a = workbook([{ name: "S", rows: tenRows() }]);
    const id = await s.task("model.xlsx", a, workbook([{ name: "S", rows: tenRows({ 4: num("B4", 7) }) }]), { storeAfter: false });
    const tl = JSON.parse((await s.get(`/timeline/${id}`)).body) as { requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string; kind: string }> }> }> }> };
    const key = tl.requests[0]!.runs[0]!.calls[0]!.changes.find((c) => c.kind === "modified")!.id;
    const res = await s.get(`/timeline/${id}/view/${key}`);
    assert.equal(res.status, 200);
    const v = (await sceneOfBody(res.body)) as { kind: string; boxes: unknown[]; caveats: string[] };
    assert.deepEqual([v.kind, v.boxes.length], ["card", 0]);
    assert.equal(v.caveats[0], "The after state is no longer in the store, so nothing is compared and nothing is boxed.");
    assert.ok(v.caveats.some((c) => /no longer in the store/.test(c)));
  });

  it("a task whose values expired is a 410, and no workbook content comes back", async () => {
    const s = await routeSetup();
    const id = await s.task("model.xlsx", workbook([{ name: "S", rows: tenRows() }]), workbook([{ name: "S", rows: tenRows({ 4: num("B4", 7) }) }]));
    const tl = JSON.parse((await s.get(`/timeline/${id}`)).body) as { requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string; kind: string }> }> }> }> };
    const key = tl.requests[0]!.runs[0]!.calls[0]!.changes.find((c) => c.kind === "modified")!.id;
    assert.equal((await s.get(`/timeline/${id}/view/${key}`)).status, 200, "live before expiry");
    s.ledger.recordExpiry(id, new Date(Date.now() - 40 * 24 * 3600 * 1000));
    s.ledger.expireValues(id, new Date());
    const res = await s.get(`/timeline/${id}/view/${key}`);
    assert.equal(res.status, 410);
    assert.equal((JSON.parse(res.body) as { expired: boolean }).expired, true);
    assert.ok(!res.body.includes("Item"));
  });

  it("a secret is its bytes: a copy of a secret file's bytes under a plain name is a 404", async () => {
    const s = await routeSetup();
    const a = workbook([{ name: "S", rows: tenRows() }]);
    const b = workbook([{ name: "S", rows: tenRows({ 4: num("B4", 7) }) }]);
    const plain = await s.task("model.xlsx", a, b);
    const key = (id: number, tl: { requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string; kind: string }> }> }> }> }): string => tl.requests[0]!.runs[0]!.calls[0]!.changes.find((c) => c.kind === "modified")!.id;
    const tlPlain = JSON.parse((await s.get(`/timeline/${plain}`)).body);
    assert.equal((await s.get(`/timeline/${plain}/view/${key(plain, tlPlain)}`)).status, 200, "without a secret copy the plain file draws");
    const copied = await s.task("model.xlsx", a, b, { secretCopyOfAfter: "credentials.xlsx" });
    const tl = JSON.parse((await s.get(`/timeline/${copied}`)).body);
    const res = await s.get(`/timeline/${copied}/view/${key(copied, tl)}`);
    assert.equal(res.status, 404);
    assert.ok(!res.body.includes("Item"));
  });
});
