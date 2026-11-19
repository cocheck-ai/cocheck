import { afterEach, describe, it } from "node:test";
import { PRODUCTION_BUILTIN_CONNECTORS, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { writeSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir, storeDirOf } from "../src/states.ts";
import type { Timeline } from "../src/timeline/timeline.ts";

// GET /timeline/<task> on the review server. A real ledger and state store in a temp home, text files for the states (the files layer
// reads them). Image states are served from the store by hash, nothing is rendered.

const TOKEN = "t".repeat(40);
const CLIENT = "claude:/work";
const COMMAND_SENTINEL = "python3 build.py --mode=SENTINEL_CMD_91ab";
const OUTSIDE = "/Users/outsider-SENTINELDIR/hidden";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Setup {
  home: string;
  ledger: Ledger;
  port: number;
  /** A task with one folder file, a call that wrote it, and stored before and after states. */
  task(opts?: { text?: [string, string]; folder?: string; name?: string }): Promise<{ id: number; before: string; after: string }>;
  get(p: string, opts?: { token?: string | null; headers?: Record<string, string>; method?: string; host?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>;
}

async function setup(): Promise<Setup> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-tl-home-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined);
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  let seq = 0;
  return {
    home,
    ledger,
    port,
    async task(opts: { text?: [string, string]; folder?: string; name?: string } = {}) {
      const [t0, t1] = opts.text ?? ["one\nline\n", "one\nline changed\n"];
      const folder = opts.folder ?? "/work";
      const id = ledger.openTask(CLIENT);
      const states = await ensureStoreDir(home, id);
      await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: folder }));
      for (const text of [t0, t1]) await writeSealed(path.join(states, sha(text)), text);
      const file = `${folder}/${opts.name ?? "notes.txt"}`;
      const callId = `toolu_${id}`;
      ledger.recordOp({ taskId: id, tool: "Bash", intent: `${COMMAND_SENTINEL} - edit the notes`, clientName: CLIENT, durationMs: 1, resultCode: "OK",
        args: { hookAdapter: 1, tool_use_id: callId, closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: [file, `${OUTSIDE}/secret.txt`], description: "edit the notes", narration: { source: "none", text: "no narration recorded" }, outsideRefs: [{ path: `${OUTSIDE}/ref.txt` }] } });
      ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK",
        args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Fix the notes."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
      ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [
        { filePath: file, sha256: sha(t0), prevSha256: null, size: t0.length, kept: "whole", note: "" },
      ] });
      ledger.recordStep({ taskId: id, client: CLIENT, seq: ++seq, phase: "Post", callsOpen: [callId], credited: [callId], files: [
        { filePath: file, sha256: sha(t1), prevSha256: sha(t0), size: t1.length, kept: "whole", note: "" },
      ] });
      return { id, before: sha(t0), after: sha(t1) };
    },
    get(p, opts = {}) {
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
    },
  };
}

describe("GET /timeline/<task>", () => {
  it("serves the timeline JSON under the schema name, with an ETag, no CORS, and the command nowhere in it", async () => {
    const s = await setup();
    const { id, before, after } = await s.task();
    const res = await s.get(`/timeline/${id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"]!, /^application\/json/);
    assert.match(res.headers.etag!, /^"[0-9a-f]{32}"$/);
    assert.ok(!Object.keys(res.headers).some((h) => h.startsWith("access-control-")), "no CORS");
    const t = JSON.parse(res.body) as Timeline;
    assert.equal(t.schema, "cocheck.timeline/1");
    assert.equal(t.folder, "work");
    const call = t.requests[0]!.runs[0]!.calls[0]!;
    assert.deepEqual([t.requests[0]!.texts[0]!.text, call.line.text, call.line.source, call.files], ["Fix the notes.", "edit the notes", "agent-description", ["notes.txt"]]);
    assert.deepEqual(call.changes.map((c) => [c.kind, c.before?.sha256 ?? null, c.after.sha256]), [["created", null, before], ["modified", before, after]]);
    const second = call.changes[1]!;
    assert.equal(second.format?.module, "files");
    assert.ok(second.format!.rows.length > 0);
    assert.deepEqual([second.after.stored, second.after.preview.ref, second.after.preview.label], [true, null, "Image as stored"]);
    assert.ok(!res.body.includes("SENTINEL_CMD"), "the raw command is in the body");
    assert.ok(!res.body.includes("--mode"), "the raw command is in the body");
    assert.ok(!res.body.includes("SENTINELDIR"), "an outside path is in the body");
  });

  it("answers 304 to its own ETag, and a new op moves the ETag", async () => {
    const s = await setup();
    const { id } = await s.task();
    const first = await s.get(`/timeline/${id}`);
    const again = await s.get(`/timeline/${id}`, { headers: { "if-none-match": first.headers.etag! } });
    assert.equal(again.status, 304);
    assert.equal(again.body, "");
    s.ledger.recordOp({ taskId: id, tool: "hook", intent: "x", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "Stop", host: "claude", session_id: "sess", at: 3000, closing: { source: "agent", text: "Done." } } });
    const moved = await s.get(`/timeline/${id}`, { headers: { "if-none-match": first.headers.etag! } });
    assert.equal(moved.status, 200);
    assert.notEqual(moved.headers.etag, first.headers.etag);
    assert.equal((JSON.parse(moved.body) as Timeline).requests[0]!.closing!.text, "Done.");
  });

  it("refuses a missing or wrong token, a foreign Host, a foreign Origin and any method but GET", async () => {
    const s = await setup();
    const { id } = await s.task();
    assert.equal((await s.get(`/timeline/${id}`, { token: null })).status, 403);
    assert.equal((await s.get(`/timeline/${id}`, { token: "wrong" })).status, 403);
    assert.equal((await s.get(`/timeline/${id}`, { host: "evil.example" })).status, 403);
    assert.equal((await s.get(`/timeline/${id}`, { headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal((await s.get(`/timeline/${id}`, { method: "POST" })).status, 405);
    assert.equal((await s.get(`/timeline/${id}`, { method: "HEAD" })).status, 405);
    assert.equal((await s.get(`/timeline/${id + 5}`)).status, 404);
    assert.equal((await s.get(`/timeline/${id}`, { headers: { origin: `http://127.0.0.1:${s.port}` } })).status, 200);
  });

  it("says an expired task is expired, not blank", async () => {
    const s = await setup();
    const { id } = await s.task();
    s.ledger.recordExpiry(id, new Date(Date.now() - 40 * 24 * 3600 * 1000));
    s.ledger.expireValues(id, new Date());
    const res = await s.get(`/timeline/${id}`);
    assert.equal(res.status, 200);
    const t = JSON.parse(res.body) as Timeline;
    assert.match(t.expired!.text, /expired on/);
    assert.equal(t.requests.length, 0);
    assert.ok(t.missing.includes(t.expired!.text));
    assert.ok(t.unplaced.length >= 1);
    assert.ok(!res.body.includes("Fix the notes"));
  });
});

describe("GET /timeline/<task>/call/<id>/command", () => {
  it("gives one call's raw command to a caller with the token, and only for that task's own call", async () => {
    const s = await setup();
    const a = await s.task();
    const b = await s.task();
    const ok = await s.get(`/timeline/${a.id}/call/toolu_${a.id}/command`);
    assert.equal(ok.status, 200);
    assert.equal((JSON.parse(ok.body) as { command: string }).command, COMMAND_SENTINEL);
    assert.equal((await s.get(`/timeline/${a.id}/call/toolu_${a.id}/command`, { token: null })).status, 403);
    assert.equal((await s.get(`/timeline/${a.id}/call/toolu_${b.id}/command`)).status, 404, "another task's call");
    assert.equal((await s.get(`/timeline/${a.id}/call/nope/command`)).status, 404);
    assert.equal((await s.get(`/timeline/${a.id}/call/%E0%A4%A/command`)).status, 404);
    assert.equal((await s.get(`/timeline/${a.id}/call/toolu_${a.id}/command`, { method: "POST" })).status, 405);
  });

  it("is gone with the values at expiry", async () => {
    const s = await setup();
    const { id } = await s.task();
    s.ledger.recordExpiry(id, new Date(Date.now() - 40 * 24 * 3600 * 1000));
    s.ledger.expireValues(id, new Date());
    const res = await s.get(`/timeline/${id}/call/toolu_${id}/command`);
    assert.equal(res.status, 410);
    assert.ok(!res.body.includes("SENTINEL_CMD"));
  });
});

describe("GET /timeline/<task>/preview/<sha>", () => {
  const PIC = (id: number): { name: string } => ({ name: `pic${id}.png` });
  it("serves the stored bytes by hash with the image type, nosniff and a locked-down CSP, and renders nothing", async () => {
    const s = await setup();
    const { id, after } = await s.task({ name: "pic.png" });
    const res = await s.get(`/timeline/${id}/preview/${after}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "image/png");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.equal(res.body, "one\nline changed\n", "the stored bytes, as they are");
    assert.ok(!existsSync(path.join(s.home, "tasks", String(id), "previews")), "no cache was written");
    const t = JSON.parse((await s.get(`/timeline/${id}`)).body) as Timeline;
    assert.equal(t.requests[0]!.runs[0]!.calls[0]!.changes[1]!.after.preview.ref, `/timeline/${id}/preview/${after}`);
  });

  it("404s a hash from another task, a hash that is no state, and anything that is not a hash", async () => {
    const s = await setup();
    const a = await s.task({ text: ["task a one\n", "task a two\n"], ...PIC(1) });
    const b = await s.task({ text: ["task b one\n", "task b two\n"], ...PIC(2) });
    assert.equal((await s.get(`/timeline/${a.id}/preview/${a.after}`)).status, 200, "its own hash is served");
    assert.equal((await s.get(`/timeline/${a.id}/preview/${b.after}`)).status, 404, "another task's hash");
    assert.equal((await s.get(`/timeline/${a.id}/preview/${b.before}`)).status, 404);
    assert.equal((await s.get(`/timeline/${a.id}/preview/${sha("nothing")}`)).status, 404);
    // Bytes sitting in task a's store that no file state of task a names are not task a's to serve, whatever put them there.
    await writeSealed(path.join(storeDirOf(s.home, a.id), b.after), "task b two\n");
    assert.equal((await s.get(`/timeline/${a.id}/preview/${b.after}`)).status, 404, "stray bytes in the store");
    for (const bad of ["..%2F..%2Fledger.sqlite", "../../ledger.sqlite", "%2Fetc%2Fpasswd", "ABCDEF".repeat(11), "abc"]) {
      assert.equal((await s.get(`/timeline/${a.id}/preview/${bad}`)).status, 404, bad);
    }
    assert.equal((await s.get(`/timeline/${a.id}/preview/${a.after}`, { token: null })).status, 403);
  });

  it("a file that is not an image has no preview route and says so without naming an OS", async () => {
    const s = await setup();
    const { id, after } = await s.task();
    assert.equal((await s.get(`/timeline/${id}/preview/${after}`)).status, 404);
    const t = JSON.parse((await s.get(`/timeline/${id}`)).body) as Timeline;
    const p = t.requests[0]!.runs[0]!.calls[0]!.changes[1]!.after.preview;
    assert.equal(p.ref, null);
    assert.doesNotMatch(p.missing!, /macOS|Quick Look/);
  });

  it("serves no picture for a state whose bytes were deleted", async () => {
    const s = await setup();
    const { id, after } = await s.task({ name: "pic.png" });
    assert.equal((await s.get(`/timeline/${id}/preview/${after}`)).status, 200);
    await rm(path.join(storeDirOf(s.home, id), after));
    s.ledger.recordStateRemovals(id, [{ sha256: after, reason: "30 days after sign-off the stored file states were deleted" }]);
    const res = await s.get(`/timeline/${id}/preview/${after}`);
    assert.equal(res.status, 404);
    assert.match((JSON.parse(res.body) as { missing: string }).missing, /no longer in the store/);
    const t = JSON.parse((await s.get(`/timeline/${id}`)).body) as Timeline;
    const ch = t.requests[0]!.runs[0]!.calls[0]!.changes[1]!;
    assert.deepEqual([ch.after.stored, ch.after.preview.ref], [false, null]);
    assert.match(ch.after.preview.missing!, /30 days after sign-off/);
  });
});

describe("no picture of an Office state", () => {
  const bin = (tag: string): [string, string] => [`PK\u0003\u0004\u0000${tag}-one`, `PK\u0003\u0004\u0000${tag}-two`];
  it("an Office state: /page has no img and /preview is 404, for every ending in either case", async (t) => {
    // the rule is the connectors' claims; the shipped built-ins claim every Office ending (the test bootstrap registers none by default)
    setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
    t.after(() => setBuiltinConnectorsForTest(undefined));
    const s = await setup();
    for (const name of ["a.xlsx", "b.XLSM", "c.docx", "d.PPTX", "e.pptm", "f.ppsx", "g.PPSM"]) {
      const { id, after } = await s.task({ name, text: bin(name) });
      assert.equal((await s.get(`/timeline/${id}/preview/${after}`)).status, 404, name);
      const page = await s.get(`/timeline/${id}/page`);
      assert.equal(page.status, 200, name);
      assert.ok(!/<img\b/i.test(page.body), `${name}: page draws a picture`);
      assert.ok(!page.body.includes("/preview/"), name);
    }
  });
  it("a non-Office binary file has no picture; an image file keeps its picture on /preview and /page", async () => {
    const s = await setup();
    const thing = await s.task({ name: "thing.bin", text: bin("bin") });
    assert.equal((await s.get(`/timeline/${thing.id}/preview/${thing.after}`)).status, 404);
    const { id, after } = await s.task({ name: "thing.png", text: bin("png") });
    assert.equal((await s.get(`/timeline/${id}/preview/${after}`)).status, 200);
    assert.match((await s.get(`/timeline/${id}/page`)).body, /<img [^>]*\/preview\//);
  });
});
