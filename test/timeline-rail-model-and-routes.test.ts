import { afterEach, describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
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
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { treeRows } from "../src/timeline/rail/files-model.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// the g-rail review page. The page model on synthetic timelines (including a secret file and a new file), then the routes on a
// scratch home. The browser script is not run here; a real-use check covers it.

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SECRET_CONTENT = "API_KEY=hunter2-SENTINEL";

function ref(sha: string) {
  return { sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "Image as stored", ref: null, missing: null } };
}

function change(id: string, file: string, kind: Change["kind"], generic: Record<string, unknown>, extra: Record<string, unknown> = {}): Change {
  return { id, file, outside: false, at: null, kind, step: 1, before: kind === "created" ? null : ref(SHA_A), after: ref(SHA_B), credit: { calls: ["call1"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: `label of ${id}`, ...generic }, ...extra } as unknown as Change;
}

// an unplaced change here is one found with no call credited or open, at no call's Post: `change.by` says so, as the timeline would.
const OUTSIDE_BY = { kind: "outside", calls: [], lost: 0, open: 0, expired: false, actor: "Something outside the agents", host: null };
const outsideOf = (c: Change): Change => ({ ...c, credit: { calls: [], joint: false, text: "x" }, by: OUTSIDE_BY }) as unknown as Change;

function timeline(changes: Change[], unplaced: Change[] = []): Timeline {
  return {
    schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: unplaced.map(outsideOf), missing: [],
    requests: [{ id: "r1", index: 1, session: "s", texts: [{ text: "Tidy the files.", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
      runs: [{ id: "run1", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [],
        calls: [{ id: "call1", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes, line: { text: "t", source: "agent-description", label: "l" } }] }] }],
  } as unknown as Timeline;
}

describe("buildRailModel", () => {
  // no start stop. The origin is a marker on the rail, not a stop.
  it("makes a stop for the request, then one stop per change, in the lane of who made it; no start stop", () => {
    const m = buildRailModel(timeline([change("c1", "notes.txt", "modified", {})], [change("c2", "stray.txt", "modified", {})]));
    assert.deepEqual(m.stops.map((s) => [s.lane, s.label]), [["you", "Your request"], ["claude", "Changed notes.txt"], ["other", "Changed stray.txt"]]);
    assert.ok(!m.stops.some((s) => s.id === "start" || s.label === "Start"));
    assert.equal(m.stops[0]!.request!.text, "Tidy the files.");
    assert.deepEqual(m.actors.map((a) => a.chip), ["Y", "C", "U"]);
  });

  it("uses the change's own note when it has one, else the generic label", () => {
    const m = buildRailModel(timeline([change("c1", "a.txt", "modified", {}, { note: { text: "Price raised to 5", source: "rule" } }), change("c2", "b.txt", "modified", {})]));
    assert.equal(m.stops[1]!.change!.note, "Price raised to 5");
    assert.equal(m.stops[2]!.change!.note, "label of c2");
  });

  it("reads a note given as a bare string too, and falls back to the label for an empty or malformed one", () => {
    const m = buildRailModel(timeline([change("c1", "a.txt", "modified", {}, { note: "old string" }), change("c2", "b.txt", "modified", {}, { note: { text: "  ", source: "rule" } }), change("c3", "c.txt", "modified", {}, { note: { source: "rule" } })]));
    assert.deepEqual(m.stops.slice(1).map((s) => s.change!.note), ["old string", "label of c2", "label of c3"]);
  });

  it("carries one note per format row that has its own note, and none for a secret file", () => {
    const rows = [{ location: "Sheet1!B39", kind: "value", before: "1", after: "2", text: "t", note: { text: "Rate set to 2", source: "rule" } }, { location: "Sheet1!B40", kind: "value", before: "1", after: "2", text: "t" }];
    const m = buildRailModel(timeline([change("c1", "m.xlsx", "modified", {}, { format: { module: "xlsx", rows, more: 0 } }), change("c2", ".env", "modified", { secret: true }, { format: { module: "xlsx", rows, more: 0 } })]));
    assert.deepEqual(m.stops[1]!.change!.rowNotes, [{ location: "Sheet1!B39", text: "Rate set to 2" }]);
    assert.deepEqual(m.stops[2]!.change!.rowNotes, []);
  });

  it("builds each moment's view URL from its own change key, never another's", () => {
    const m = buildRailModel(timeline([change("c1", "a.txt", "modified", {}), change("c 2", "b.txt", "modified", {})]));
    assert.deepEqual(m.stops.filter((s) => s.change).map((s) => s.change!.viewUrl), ["/timeline/7/view/c1", "/timeline/7/view/c%202"]);
  });

  it("gives a secret file's moment its name line only: no view URL, no label, no tree, no contents", () => {
    const secret = change("c9", ".env", "modified", { secret: true, label: "SECRET-LABEL", fingerprint: { before: null, after: null, kind: "secret", note: SECRET_CONTENT } }, { note: "SECRET-NOTE" });
    const byName = change("c8", "config/.env.production", "created", {});
    const m = buildRailModel(timeline([secret, byName, change("c1", "new.txt", "created", {})]));
    const json = JSON.stringify(m.stops.filter((s) => s.change?.secret));
    assert.equal(m.stops.filter((s) => s.change?.secret).length, 2);
    for (const s of m.stops.filter((x) => x.change?.secret)) {
      const c = s.change!;
      assert.equal(c.viewUrl, null);
      assert.equal(c.treeBefore, null);
      assert.equal(c.treeAfter, null);
      assert.equal(c.newFile, null);
      assert.match(c.secretLine!, /^A secret file was changed: /);
      assert.equal(c.note, "");
    }
    assert.ok(!json.includes("SECRET-LABEL") && !json.includes("SECRET-NOTE") && !json.includes(SECRET_CONTENT), json);
    // a secret file's name does not appear in another moment's tree either
    const tree = JSON.stringify(m.stops.find((s) => s.change?.key === "c1")!.change);
    assert.ok(!tree.includes(".env"), tree);
  });

  it("shows the folder tree before and after for a new file, naming its folder, and says when it left the work folder", () => {
    const m = buildRailModel(timeline([change("c1", "notes.txt", "modified", {}), change("c2", "reports/q3/summary.md", "created", {}), change("c3", "backup.xlsx", "created", {}, { outside: true })]));
    const made = m.stops.find((s) => s.change?.key === "c2")!.change!;
    assert.deepEqual(made.newFile, { name: "summary.md", folder: "q3", outside: false });
    assert.deepEqual(made.treeBefore!.filter((r) => r.gap).length, 1);
    assert.deepEqual(made.treeAfter!.filter((r) => r.target).map((r) => r.name), ["summary.md"]);
    assert.ok(made.treeBefore!.every((r) => !r.target));
    const out = m.stops.find((s) => s.change?.key === "c3")!.change!;
    assert.deepEqual(out.newFile, { name: "backup.xlsx", folder: null, outside: true });
    assert.equal(out.treeAfter, null);
    assert.equal(made.newFile!.outside, false, "an inside nested path is not outside");
    // a file that is not new has no tree
    assert.equal(m.stops.find((s) => s.change?.key === "c1")!.change!.treeAfter, null);
  });

  it("lists a later-created file in no earlier moment's tree", () => {
    const m = buildRailModel(timeline([change("c1", "a/one.md", "created", {}), change("c2", "a/two.md", "created", {})]));
    const first = m.stops.find((s) => s.change?.key === "c1")!.change!;
    assert.ok(!JSON.stringify(first.treeBefore).includes("two.md") && !JSON.stringify(first.treeAfter).includes("two.md"));
  });
});

describe("time order", () => {
  it("merges requests, calls and unplaced changes by their recorded times", () => {
    const tl = timeline([change("c1", "a.txt", "modified", {}), change("c2", "b.txt", "modified", {})], [change("u1", "mid.txt", "modified", {}, { at: 1500 }), change("u2", "early.txt", "modified", {}, { at: 500 })]);
    const call = tl.requests[0]!.runs[0]!.calls[0]!;
    call.start = 1000;
    tl.requests[0]!.at = 900;
    // a second request, submitted after the unplaced change at 1500, with a call at 2000
    const second = JSON.parse(JSON.stringify(tl.requests[0]!));
    second.id = "r2"; second.index = 2; second.at = 1800;
    second.runs[0].calls[0].start = 2000; second.runs[0].calls[0].changes = [change("c3", "c.txt", "modified", {})];
    tl.requests.push(second);
    const m = buildRailModel(tl);
    assert.deepEqual(m.stops.map((s) => s.label), ["Changed early.txt", "Your request", "Changed a.txt", "Changed b.txt", "Changed mid.txt", "Your request", "Changed c.txt"]);
    assert.deepEqual(m.stops.map((s) => s.lane), ["other", "you", "claude", "claude", "other", "you", "claude"]);
  });

  it("keeps the timeline's own order where the record gives no times", () => {
    const m = buildRailModel(timeline([change("c1", "a.txt", "modified", {})], [change("u1", "z.txt", "modified", {})]));
    assert.deepEqual(m.stops.map((s) => s.label), ["Your request", "Changed a.txt", "Changed z.txt"]);
  });
});

describe("treeRows", () => {
  it("opens only the folders on the way to the target and counts the closed ones", () => {
    const rows = treeRows(["x/a.txt", "x/b.txt", "y/z/c.txt"], "y/z/new.txt", "after");
    assert.deepEqual(rows.map((r) => [r.t, r.name, r.depth, r.open ?? null, r.count ?? null]), [["dir", "x", 0, false, 2], ["dir", "y", 0, true, 2], ["dir", "z", 1, true, 2], ["file", "c.txt", 2, null, null], ["file", "new.txt", 2, null, null]]);
  });
});

// ---- the routes, on a scratch home ----

const TOKEN = "t".repeat(40);
const CLIENT = "claude:/work";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function routeSetup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-rail-home-"));
  const ledger = openLedger(home);
  const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => { throw new Error("no render"); }, quickLook: false });
  cleanups.push(async () => {
    await new Promise<void>((r) => (server as Server).close(() => r()));
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const id = ledger.openTask(CLIENT);
  const states = await ensureStoreDir(home, id);
  await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
  const t0 = "one\n", t1 = "two\n";
  for (const text of [t0, t1]) await writeSealed(path.join(states, sha(text)), text);
  ledger.recordOp({ taskId: id, tool: "hook", intent: "user prompt", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, hookEvent: "UserPromptSubmit", host: "claude", session_id: "sess", at: 900, earlier: 0, prompts: ["Fix the notes."], requests: [{ seq: 1, at: 900, firstStep: null }] } });
  ledger.recordOp({ taskId: id, tool: "Bash", intent: "edit", clientName: CLIENT, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: "toolu_1", closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 2, host: "claude", session_id: "sess", tool_name: "Bash", namedFiles: ["/work/notes.txt"], description: "edit the notes", narration: { source: "none", text: "none" }, outsideRefs: [] } });
  ledger.recordStep({ taskId: id, client: CLIENT, seq: 1, phase: "Post", callsOpen: ["toolu_1"], credited: ["toolu_1"], files: [{ filePath: "/work/notes.txt", sha256: sha(t0), prevSha256: null, size: 4, kept: "whole", note: "" }] });
  ledger.recordStep({ taskId: id, client: CLIENT, seq: 2, phase: "Post", callsOpen: ["toolu_1"], credited: ["toolu_1"], files: [{ filePath: "/work/notes.txt", sha256: sha(t1), prevSha256: sha(t0), size: 4, kept: "whole", note: "" }] });
  ledger.recordStep({ taskId: id, client: CLIENT, seq: 3, phase: "Post", callsOpen: ["toolu_1"], credited: ["toolu_1"], files: [{ filePath: "/elsewhere/deep/backup.txt", sha256: sha(t1), prevSha256: null, size: 4, kept: "whole", note: "" }] });
  const get = (p: string, opts: { token?: string | null; host?: string; method?: string } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const token = opts.token === undefined ? TOKEN : opts.token;
      const url = token === null ? p : `${p}${p.includes("?") ? "&" : "?"}t=${token}`;
      const req = http.request({ hostname: "127.0.0.1", port, path: url, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
  return { id, get };
}

describe("the review routes", () => {
  it("serves the shell with a script-src 'self' policy, no inline script, no external reference", async () => {
    const { id, get } = await routeSetup();
    const res = await get(`/timeline/${id}/review`);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"]!, /^text\/html/);
    const csp = String(res.headers["content-security-policy"]);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal((await get(`/timeline/${id}/review/model`)).headers["referrer-policy"], "no-referrer");
    assert.ok(!/script-src[^;]*unsafe/.test(csp), csp);
    assert.ok(!/https?:\/\//.test(res.body), "external reference");
    for (const m of res.body.matchAll(/<script\b([^>]*)>([^<]*)<\/script>/g)) {
      assert.match(m[1]!, /\ssrc="\/timeline-assets\/(review|view-table|files-view)\.js"/);
      assert.equal(m[2], "", "inline script");
    }
    assert.ok(!/\son[a-z]+=/.test(res.body), "inline handler");
  });

  it("carries outside on each file change in the body: an outside path cut to a bare name is outside, an inside nested one is not", async () => {
    const { id, get } = await routeSetup();
    const body = JSON.parse((await get(`/timeline/${id}`)).body) as Timeline;
    const changes = body.requests.flatMap((r) => r.runs.flatMap((x) => x.calls.flatMap((c) => c.changes))).concat(body.unplaced);
    const out = changes.find((c) => c.file === "backup.txt")!;
    assert.equal(out.outside, true);
    assert.ok(!JSON.stringify(body).includes("elsewhere"), "no outside path text");
    assert.deepEqual(changes.filter((c) => c.file === "notes.txt").map((c) => c.outside), [false, false]);
    assert.ok(changes.every((c) => typeof c.at === "number" && Number.isFinite(c.at)), "each change carries the time of its step");
    assert.equal(typeof body.requests[0]!.at === "number" || body.requests[0]!.at === null, true);
  });

  it("serves the model from the real timeline body, one stop per change", async () => {
    const { id, get } = await routeSetup();
    const res = await get(`/timeline/${id}/review/model`);
    assert.equal(res.status, 200);
    const m = JSON.parse(res.body) as ReturnType<typeof buildRailModel>;
    assert.equal(m.task, id);
    assert.deepEqual(m.stops.map((s) => s.lane), ["you", "claude", "claude", "claude"]);
    assert.ok(m.stops[1]!.change!.viewUrl!.startsWith(`/timeline/${id}/view/`));
  });

  it("serves the script, the stylesheet and every listed asset same-origin, and nothing outside its list", async () => {
    const { get } = await routeSetup();
    const js = await get("/timeline-assets/review.js", { token: null });
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"]!, /^text\/javascript/);
    assert.equal((await get("/timeline-assets/review.css", { token: null })).status, 200);
    const { ASSETS } = await import("../src/timeline/rail/page.ts");
    for (const name of Object.keys(ASSETS)) assert.equal((await get(`/timeline-assets/${name}`, { token: null })).status, 200, name);
    assert.equal((await get("/timeline-assets/fonts/atkinson-normal-700.woff2", { token: null })).status, 404, "the retired font is gone, and nothing asks for it");
    for (const bad of ["../review-server.ts", "..%2Freview-server.ts", "page.ts", "fonts/../page.ts", "%00", "constructor", "__proto__"]) {
      assert.equal((await get(`/timeline-assets/${bad}`, { token: null })).status, 404, bad);
    }
  });

  it("refuses a missing token, a wrong host and a wrong method on the review routes", async () => {
    const { id, get } = await routeSetup();
    for (const p of [`/timeline/${id}/review`, `/timeline/${id}/review/model`]) {
      assert.equal((await get(p, { token: null })).status, 403, p);
      assert.equal((await get(p, { token: "x" })).status, 403, p);
      assert.equal((await get(p, { host: "evil.example:80" })).status, 403, p);
      assert.equal((await get(p, { method: "POST" })).status, 405, p);
    }
    assert.equal((await get("/timeline/999999/review")).status, 404);
  });

  it("keeps the no-script page", async () => {
    const { id, get } = await routeSetup();
    const res = await get(`/timeline/${id}/page`);
    assert.equal(res.status, 200);
    assert.ok(!/<script/.test(res.body));
  });
});

describe("a change from outside the agents", () => {
  it("names the lane, the head and the side text for what CoCheck can and cannot know", () => {
    const m = buildRailModel(timeline([change("c1", "a.txt", "modified", {})], [change("u1", "z.txt", "modified", {})]));
    assert.equal(m.actors.find((a) => a.id === "other")!.name, "Unknown");
    const out = m.stops.find((s) => s.lane === "other")!;
    assert.equal(out.head, "Something outside the agents changed z.txt");
    assert.equal(out.sub, "Changed between agent calls; CoCheck can't tell who or what wrote it (you, an app, or another process).");
    assert.ok(!JSON.stringify(m).toLowerCase().includes("someone else"));
  });
  it("keeps the agent label on a change made inside a call", () => {
    const m = buildRailModel(timeline([change("c1", "a.txt", "modified", {})], [change("u1", "z.txt", "modified", {})]));
    const inside = m.stops.find((s) => s.lane === "claude" && s.change)!;
    assert.match(inside.head, /^Claude /);
    assert.equal(inside.sub, undefined);
    assert.ok(!inside.head.includes("outside the agents"));
  });
});
