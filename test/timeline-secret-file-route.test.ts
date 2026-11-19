import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
type PreviewRenderer = (file: string, outDir: string) => Promise<string | null>; // legacy seam, ignored
import type { Timeline } from "../src/timeline/timeline.ts";

// A secret file through the real server path (no injected flag). Nothing is rendered; the route serves stored bytes.

const TOKEN = "t".repeat(40);
const CLIENT = "claude:/work";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-secret-home-"));
  const ledger: Ledger = openLedger(home);
  const renders: string[] = [];
  const previewRenderer: PreviewRenderer = async (file, outDir) => {
    renders.push(file);
    const out = path.join(outDir, `${path.basename(file)}.png`);
    await writeFile(out, "PNG-BYTES");
    return out;
  };
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer, quickLook: true });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const get = (p: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
  return { home, ledger, renders, get };
}

describe("a secret file through the real timeline route", () => {
  it("is a secret fingerprint, never rendered or cached, and its states answer 404", async () => {
    const s = await setup();
    const id = s.ledger.openTask(CLIENT);
    const states = await ensureStoreDir(s.home, id);
    await writeFile(path.join(s.home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
    const files = ["/work/.env", "/work/a/b/.env", "/work/certs/server.pem"];
    const shas: string[] = [];
    let seq = 0;
    for (const f of files) {
      for (const text of [`KEY=old-${f}`, `KEY=new-${f}`]) await writeFile(path.join(states, sha(text)), text);
      const [t0, t1] = [`KEY=old-${f}`, `KEY=new-${f}`];
      shas.push(sha(t0), sha(t1));
      s.ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [], credited: [], files: [{ filePath: f, sha256: sha(t0), prevSha256: null, size: t0.length, kept: "whole", note: "" }] });
      s.ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [], credited: [], files: [{ filePath: f, sha256: sha(t1), prevSha256: sha(t0), size: t1.length, kept: "whole", note: "" }] });
    }
    const res = await s.get(`/timeline/${id}`);
    assert.equal(res.status, 200);
    const t = JSON.parse(res.body) as Timeline;
    const changes = JSON.stringify(t).includes("generic") ? collect(t) : [];
    assert.ok(changes.length >= 5, JSON.stringify(changes.map((c) => [c.file, c.generic.tier])));
    for (const c of changes) {
      assert.equal(c.generic.tier, "fingerprint", c.file);
      assert.equal(c.generic.secret, true, c.file);
      assert.equal(c.generic.label, `A secret file was changed: ${c.file}`);
    }
    assert.deepEqual([...new Set(changes.map((c) => c.file))].sort(), [".env", "a/b/.env", "certs/server.pem"]);
    const refs = previewRefs(t);
    assert.ok(refs.length >= 5, "the state refs were found");
    assert.deepEqual(refs.filter((r) => r !== null), [], "a secret state carries a preview link");
    assert.ok(!res.body.includes("KEY=new"), "contents leaked into the timeline");
    assert.deepEqual(s.renders, [], "a secret file was handed to the renderer");
    const previews = path.join(s.home, "tasks", String(id), "previews");
    assert.deepEqual(existsSync(previews) ? await readdir(previews) : [], []);
    for (const h of shas) {
      assert.equal((await s.get(`/timeline/${id}/preview/${h}`)).status, 404);
    }
    assert.deepEqual(s.renders, []);
    assert.deepEqual(existsSync(previews) ? await readdir(previews) : [], []);
  });
});

interface Found { file: string; generic: { tier: string; secret?: true; label: string } }
function collect(t: Timeline): Found[] {
  const out: Found[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.file === "string" && typeof o.generic === "object" && o.generic !== null) out.push(o as unknown as Found);
      Object.values(o).forEach(walk);
    }
  };
  walk(t);
  return out;
}

function previewRefs(t: Timeline): Array<string | null> {
  const out: Array<string | null> = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.sha256 === "string" && typeof o.preview === "object" && o.preview !== null) out.push((o.preview as { ref: string | null }).ref);
      Object.values(o).forEach(walk);
    }
  };
  walk(t);
  return out;
}
