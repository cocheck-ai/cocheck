import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { renderGenericPage, type GenericPart } from "../src/timeline/page.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// The general page. Rendered from synthetic timelines of all three tiers plus a secret-file change (the producers,
// are not needed here), then once through the real review server for the token and the route.

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SECRET_CONTENT = "API_KEY=hunter2-SENTINEL";
const RAW_COMMAND = "rm -rf /SENTINEL_COMMAND";

function stateRef(sha: string) {
  return { sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "Image as stored", ref: null, missing: null } };
}

function change(id: string, file: string, generic: GenericPart | undefined, extra: Partial<Change> = {}): Change {
  return { id, file, kind: "modified", step: 1, before: stateRef(SHA_A), after: stateRef(SHA_B), credit: { calls: ["call1"], joint: false, text: "credited to this call" }, ledgerNote: null, note: { text: "", source: "rule" }, format: null, alsoNamedBy: [], missing: [], ...extra, ...(generic ? { generic } : {}) } as Change;
}

function timeline(changes: Change[], unplaced: Change[] = []): Timeline {
  return {
    schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced, missing: [],
    requests: [{
      id: "r1", index: 1, session: "s", texts: [{ text: "Tidy the files please.", source: "user", label: "what you typed" }], placement: { kind: "recorded", note: "" }, missing: [],
      closing: { text: "All tidied.", source: "agent-claim", label: "the agent's closing message, not checked against the files" },
      runs: [{ id: "run1", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [],
        calls: [{ id: "call1", index: 1, of: 1, host: "claude", tool: "Bash", start: 1_700_000_000_000, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes,
          line: { text: "tidy up", source: "agent-description", label: "the agent's own description of the call" } }] }],
    }],
  } as unknown as Timeline;
}

const TEXT: GenericPart = { tier: "text", label: "Lines changed in a text file", text: { hunks: [{ beforeStart: 1, beforeLines: 2, afterStart: 1, afterLines: 2, lines: [{ op: " ", text: "keep <b>" }, { op: "-", text: "old line" }, { op: "+", text: "new line" }] }], cut: "Only the first 1 hunk is shown." } };
const PICTURE: GenericPart = { tier: "picture", label: "A picture of the file before and after, changed areas boxed", picture: { before: SHA_A, after: SHA_B, width: 200, height: 100, regions: [{ x: 20, y: 10, w: 40, h: 20 }], note: "One area changed." } };
const FINGERPRINT: GenericPart = { tier: "fingerprint", label: "A file CoCheck cannot show inside", fingerprint: { before: null, after: { sha: SHA_B, size: 42 }, kind: "binary file", note: "Only its size and fingerprint are known." } };
const SECRET: GenericPart = { tier: "fingerprint", label: "SECRET-LABEL-MUST-NOT-SHOW", secret: true, fingerprint: { before: { sha: SHA_A, size: 1 }, after: { sha: SHA_B, size: 2 }, kind: "secret", note: SECRET_CONTENT } };

describe("renderGenericPage", () => {
  it("renders the text tier as hunks with the label, escaped, with who, when and why each labelled", () => {
    const html = renderGenericPage(timeline([change("c1", "notes.txt", TEXT)]), "tok");
    assert.match(html, /Lines changed in a text file/);
    assert.match(html, /class="del">- old line/);
    assert.match(html, /class="add">\+ new line/);
    assert.match(html, /keep &lt;b&gt;/);
    assert.match(html, /Only the first 1 hunk is shown/);
    assert.match(html, /Credit: claude call 1 of 1 \(Bash\)/);
    assert.match(html, /Request 1, call 1 of 1, started 2023-11-14/);
    assert.match(html, /The request \(what you typed\)<\/span> <span class="said">Tidy the files please/);
    assert.match(html, /The call \(the agent&#39;s own description of the call\)/);
    assert.match(html, /closing message \(the agent&#39;s closing message, not checked/);
    assert.match(html, /What happened<\/dt><dd>modified/);
  });

  it("renders the picture tier as a labelled pair with the regions boxed", () => {
    const html = renderGenericPage(timeline([change("c1", "deck.pptx", PICTURE)]), "tok");
    assert.match(html, /A picture of the file before and after, changed areas boxed/);
    assert.equal((html.match(/<img /g) ?? []).length, 2);
    assert.match(html, new RegExp(`/timeline/7/preview/${SHA_A}\\?t=tok`));
    assert.match(html, /left:10%;top:10%;width:20%;height:20%/);
    assert.match(html, /One area changed/);
  });

  it("never shows two pictures without the label, even when the record's label is empty", () => {
    const html = renderGenericPage(timeline([change("c1", "deck.pptx", { ...PICTURE, label: "  " })]), "tok");
    assert.equal((html.match(/<img /g) ?? []).length, 2);
    assert.match(html, /class="label">No label was recorded/);
  });

  it("renders a missing side as a plain statement, not a broken image", () => {
    const html = renderGenericPage(timeline([change("c1", "deck.pptx", { ...PICTURE, picture: { ...PICTURE.picture!, before: null } }, { kind: "created" })]), "tok");
    assert.equal((html.match(/<img /g) ?? []).length, 1);
    assert.match(html, /There is no before picture/);
  });

  it("renders the fingerprint tier", () => {
    const html = renderGenericPage(timeline([change("c1", "blob.bin", FINGERPRINT)]), "tok");
    assert.match(html, /A file CoCheck cannot show inside/);
    assert.match(html, /binary file/);
    assert.match(html, /42 bytes/);
    assert.match(html, /Only its size and fingerprint are known/);
  });

  it("shows the name line only for a secret file: no label, hashes, note or format rows", () => {
    const withFormat = { module: "files", rows: [{ location: "line 1", kind: "k", before: SECRET_CONTENT, after: SECRET_CONTENT, text: SECRET_CONTENT }], more: 0 };
    const html = renderGenericPage(timeline([change("c1", ".env", SECRET, { format: withFormat, ledgerNote: SECRET_CONTENT })]), "tok");
    assert.match(html, /A secret file was changed: \.env/);
    for (const banned of [SECRET_CONTENT, "hunter2", "SECRET-LABEL", SHA_A, SHA_B, "<img", 'class="fold"']) assert.ok(!html.includes(banned), `page holds ${banned}`);
  });

  it("folds a format part below as a location, before, after list and keeps the generic card", () => {
    const format = { module: "xlsx", rows: [{ location: "Sheet1!B2", kind: "value", before: "1", after: "2", text: "" }], more: 3 };
    const html = renderGenericPage(timeline([change("c1", "book.xlsx", FINGERPRINT, { format })]), "tok");
    assert.match(html, /<details class="fold"><summary>Details from the xlsx reader/);
    assert.match(html, /<td>Sheet1!B2<\/td><td>1<\/td><td>2<\/td>/);
    assert.match(html, /3 more not listed/);
    assert.match(html, /A file CoCheck cannot show inside/);
  });

  it("says a change under no call was made outside the agents, and a joint change is joint", () => {
    // Who made a change is `change.by`; the "Not from an agent call" wording appears on no surface.
    const outside = { kind: "outside", calls: [], lost: 0, open: 0, expired: false, actor: "Something outside the agents", host: null } as unknown as Change["by"];
    const html = renderGenericPage(timeline([change("c1", "a.txt", TEXT, { credit: { calls: ["call1", "call2"], joint: true, text: "" } })], [change("c2", "b.txt", TEXT, { credit: { calls: [], joint: false, text: "" }, by: outside })]), "tok");
    assert.match(html, /Joint: /);
    assert.match(html, /Made outside the agents: found between agent calls, with no call running\./);
    assert.doesNotMatch(html, /Not from an agent call/);
    assert.match(html, /No request is recorded/);
  });

  it("groups changes by file in order and lists who per file", () => {
    const html = renderGenericPage(timeline([change("c1", "a.txt", TEXT), change("c2", "a.txt", TEXT, { kind: "deleted" }), change("c3", "b.txt", FINGERPRINT)]), "tok");
    assert.equal((html.match(/<details class="file"/g) ?? []).length, 2);
    assert.match(html, /a\.txt - 2 changes - credit/);
    assert.match(html, /b\.txt - 1 change - credit/);
    assert.ok(html.indexOf("Modified: a.txt") < html.indexOf("Deleted: a.txt"));
  });

  it("has no file-type branches: the page code names only the three tiers", async () => {
    const { readFile } = await import("node:fs/promises");
    const code = await readFile(new URL("../src/timeline/page.ts", import.meta.url), "utf8");
    assert.ok(!/\.(xlsx|pptx|docx|png|pdf)\b/.test(code.replace(/\/\*\*[\s\S]*?\*\//, "")), "a file extension is named in the page code");
  });
});

const TOKEN = "t".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("GET /timeline/<task>/page", () => {
  async function boot() {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const ledger = openLedger(home);
    const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => { throw new Error("no render"); }, quickLook: false });
    cleanups.push(async () => {
      await new Promise<void>((r) => (server as Server).close(() => r()));
      ledger.close();
      await rm(home, { recursive: true, force: true });
    });
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    const id = ledger.openTask("claude:/work");
    const states = await ensureStoreDir(home, id);
    await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
    const t = "hello\n";
    await writeFile(path.join(states, sha(t)), t);
    ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit", clientName: "claude:/work", durationMs: 1, resultCode: "OK",
      args: { hookAdapter: 1, tool_use_id: "toolu_1", closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "s", tool_name: "Bash", command: RAW_COMMAND, namedFiles: ["/work/notes.txt"], description: "edit the notes", narration: { source: "none", text: "none" } } });
    ledger.recordStep({ taskId: id, client: "claude:/work", seq: 1, phase: "Post", callsOpen: ["toolu_1"], credited: ["toolu_1"], files: [{ filePath: "/work/notes.txt", sha256: sha(t), prevSha256: null, size: t.length, kept: "whole", note: "" }] });
    const get = (p: string, host?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: p, headers: { host: host ?? `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    return { id, get };
  }

  it("needs the token, and the same host check as the other timeline routes", async () => {
    const { id, get } = await boot();
    assert.equal((await get(`/timeline/${id}/page`)).status, 403);
    assert.equal((await get(`/timeline/${id}/page?t=wrong`)).status, 403);
    assert.equal((await get(`/timeline/${id}/page?t=${TOKEN}`, "evil.example:80")).status, 403);
    assert.equal((await get(`/timeline/9999/page?t=${TOKEN}`)).status, 404);
  });

  it("serves the page with the file, no raw command, a CSP that allows only same-origin pictures, and no network address", async () => {
    const { id, get } = await boot();
    const res = await get(`/timeline/${id}/page?t=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"]!, /^text\/html/);
    assert.match(String(res.headers["content-security-policy"]), /img-src 'self'/);
    assert.ok(!/connect-src|script-src/.test(String(res.headers["content-security-policy"])));
    assert.match(res.body, /notes\.txt/);
    assert.ok(!res.body.includes("SENTINEL_COMMAND"), "the raw command is on the page");
    assert.ok(!/(?:src|href|action)="(?:https?:)?\/\//.test(res.body), "the page points at another origin");
    assert.ok(!/<script/i.test(res.body));
  });
});
