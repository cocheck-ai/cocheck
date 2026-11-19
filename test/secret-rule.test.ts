import { afterEach, describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { startReviewServer } from "../src/review-server.ts";
import { ensureStoreDir } from "../src/states.ts";
import { isSecretPath, secretLine } from "../src/secret-files.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { buildTimeline, type Change, type Timeline } from "../src/timeline/timeline.ts";
import { renderGenericPage, type GenericPart } from "../src/timeline/page.ts";
import { workbookClaims } from "./helpers/claims.ts";

// One secret rule end to end: "the following secret file was changed", never "here's what your new API key is".
// The route test goes through the real hook adapter and the real review server, on scratch homes and folders only.

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const TOKEN = "t".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const SENTINELS = { top: "SENTINEL-TOP-ENV-b2c4d8", nested: "SENTINEL-NESTED-ENV-7f3a91", pem: "SENTINEL-PEM-KEY-19ee05" };

async function everyFile(dir: string): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await everyFile(full)));
    else if (e.isFile()) out.push(await readFile(full));
  }
  return out;
}

describe("a secret file through the real hook adapter and the real review server", () => {
  it("never leaves a sentinel in the timeline, the page, the store or the ledger, says the shared line, and answers 404 for its states", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
    cleanups.push(async () => {
      await rm(home, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    });
    await copyFile(path.join(FIXTURES, "probe", "S0.xlsx"), path.join(folder, "casebook.xlsx"));
    const put = async (rel: string, data: string) => {
      await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
      await writeFile(path.join(folder, rel), data);
    };
    await put(".env", `API_KEY=${SENTINELS.top}\n`);
    await put("a/b/.env", `API_KEY=${SENTINELS.nested}\n`);
    await put("certs/server.pem", `-----BEGIN PRIVATE KEY-----\n${SENTINELS.pem}\n-----END PRIVATE KEY-----\n`);
    const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder };
    const send = async (name: string, over: Record<string, unknown>) =>
      handleHook({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), cwd: folder, ...over } as HookPayload, opts);
    const edit = async (id: string, rel: string, text: string) => {
      const tool_input = { command: `edit ${rel}`, description: id };
      await send("claude-pre-bash.json", { tool_use_id: id, tool_input });
      await writeFile(path.join(folder, rel), text);
      await send("claude-post-bash.json", { tool_use_id: id, tool_input });
    };
    await edit("toolu_1", ".env", `API_KEY=${SENTINELS.top}-v2\n`);
    await edit("toolu_2", "a/b/.env", `API_KEY=${SENTINELS.nested}-v2\n`);
    await edit("toolu_3", "certs/server.pem", `${SENTINELS.pem}-v2\n`);
    const stop = await send("claude-stop.json", {});
    const taskId = stop.summary!.taskId;

    const ledger = openLedger(home);
    // Plant a placeholder in the store under every secret state's hash, as if an older build had kept one. The placeholder holds no
    // sentinel; it makes the route's own guard, not a missing file, the only thing that can answer 404.
    const storeDir = await ensureStoreDir(home, taskId);
    for (const s of ledger.fileStatesForTask(taskId)) {
      if (!/\.env$|\.pem$/.test(s.filePath)) continue;
      for (const h of [s.sha256, s.prevSha256]) if (h !== null) await writeSealed(path.join(storeDir, h), "PLACEHOLDER");
    }
    const { server, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async (file, outDir) => {
        // A renderer that works, so only the route's own guard can produce the 404.
        const out = path.join(outDir, `${path.basename(file)}.png`);
        await writeFile(out, "PNG-BYTES");
        return out;
      }, quickLook: true });
    cleanups.push(async () => {
      await new Promise<void>((r) => (server as Server).close(() => r()));
      ledger.close();
    });
    const get = (p: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });

    const json = await get(`/timeline/${taskId}`);
    const page = await get(`/timeline/${taskId}/page`);
    assert.equal(json.status, 200);
    assert.equal(page.status, 200);
    assert.equal(page.headers["cache-control"], "private, no-store");

    const states = ledger.fileStatesForTask(taskId).filter((s) => /\.env$|\.pem$/.test(s.filePath));
    const changed = states.filter((s) => s.prevSha256 !== null);
    assert.equal(changed.length, 3, "one change per secret file");
    const dump = JSON.stringify({ steps: ledger.stepsForTask(taskId), states: ledger.fileStatesForTask(taskId), ops: ledger.okOpsForTask(taskId, 0, ledger.maxOpId()) });
    for (const needle of Object.values(SENTINELS)) {
      assert.ok(!json.body.includes(needle), `timeline holds ${needle}`);
      assert.ok(!page.body.includes(needle), `page holds ${needle}`);
      assert.ok(!dump.includes(needle), `ledger dump holds ${needle}`);
      for (const bytes of await everyFile(home)) assert.ok(!bytes.includes(needle), `a file under the home holds ${needle}`);
    }
    // One string across the hook record, the timeline and the page.
    for (const rel of [".env", "a/b/.env", "certs/server.pem"]) {
      const line = secretLine(rel);
      assert.ok(changed.some((s) => s.note.includes(line)), `hook record says: ${line}`);
      assert.ok(json.body.includes(JSON.stringify(line).slice(1, -1)), `timeline says: ${line}`);
      assert.ok(page.body.includes(line), `page says: ${line}`);
    }
    assert.ok(!page.body.includes("The following secret file"), "the page has its own wording");
    assert.ok(!json.body.includes("/preview/"), "a secret state carries a preview link");
    assert.ok(!page.body.includes("<img"), "the page pictures a secret file");
    for (const s of states) {
      for (const h of [s.sha256, s.prevSha256]) {
        if (h === null) continue;
        assert.equal((await get(`/timeline/${taskId}/preview/${h}`)).status, 404, `preview of ${s.filePath}`);
      }
    }
  });
});

// ---- the page, from synthetic timelines ----

const A = "a".repeat(64);
const B = "b".repeat(64);
const ref = (sha_: string) => ({ sha256: sha_, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
function change(file: string, generic: GenericPart | undefined, extra: Partial<Change> = {}): Change {
  return { id: "c1", file, kind: "modified", step: 1, before: ref(A), after: ref(B), credit: { calls: ["call1"], joint: false, text: "x" }, note: null, format: null, alsoNamedBy: [], missing: [], ...extra, ...(generic ? { generic } : {}) } as Change;
}
function timeline(changes: Change[]): Timeline {
  return {
    schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [],
    requests: [{ id: "r1", index: 1, session: "s", texts: [{ text: "Tidy.", source: "user", label: "what you typed" }], placement: { kind: "recorded", note: "" }, missing: [], closing: null,
      runs: [{ id: "run1", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [],
        calls: [{ id: "call1", index: 1, of: 1, host: "claude", tool: "Bash", start: 1_700_000_000_000, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes,
          line: { text: "tidy", source: "agent-description", label: "the agent's own description of the call" } }] }] }],
  } as unknown as Timeline;
}
const FORMAT = { module: "files", rows: [{ location: "FORMAT-LOC", kind: "k", before: "FORMAT-BEFORE", after: "FORMAT-AFTER", text: "" }], more: 0 };

describe("the page", () => {
  it("prints the shared secret line for a secret card", () => {
    const secret: GenericPart = { tier: "fingerprint", label: "L", secret: true, fingerprint: { before: null, after: null, kind: "k", note: "n" } };
    const html = renderGenericPage(timeline([change("a/b/.env", secret)]), "tok");
    assert.ok(html.includes(secretLine("a/b/.env")));
    assert.ok(!html.includes("The following"));
  });

  it("fails closed when a change has no generic part: name, who, when, why only, no format rows, no pictures", () => {
    const html = renderGenericPage(timeline([change("deck.pptx", undefined, { format: FORMAT as never })]), "tok");
    assert.ok(html.includes("deck.pptx"));
    assert.match(html, /Credit: claude call 1 of 1/);
    assert.match(html, /Request 1, call 1 of 1/);
    for (const banned of ["FORMAT-LOC", "FORMAT-BEFORE", "<img", 'class="fold"']) assert.ok(!html.includes(banned), `page holds ${banned}`);
  });

  it("a secret name with no generic part still prints the shared line and no format rows", () => {
    const html = renderGenericPage(timeline([change(".env", undefined, { format: FORMAT as never })]), "tok");
    assert.ok(html.includes(secretLine(".env")));
    assert.ok(!html.includes("FORMAT-LOC"));
  });

  it("guards a zero width or height in the region math", () => {
    for (const [width, height] of [[0, 100], [100, 0], [0, 0]]) {
      const pic: GenericPart = { tier: "picture", label: "A pair", picture: { before: A, after: B, width, height, regions: [{ x: 1, y: 1, w: 5, h: 5 }] } };
      const html = renderGenericPage(timeline([change("deck.pptx", pic)]), "tok");
      assert.ok(!/NaN|Infinity/.test(html), `${width}x${height} gave a non-number`);
    }
  });
});

// ---- the loader, from stored states ----

async function loaded(files: Array<{ file: string; before: string; after: string; beforeSize?: number }>, opts: { expired?: boolean } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-load-"));
  const ledger = openLedger(home);
  cleanups.push(async () => {
    ledger.close();
    await rm(home, { recursive: true, force: true });
  });
  const id = ledger.openTask("claude:/work");
  const states = await ensureStoreDir(home, id);
  await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
  let seq = 0;
  for (const f of files) {
    for (const text of [f.before, f.after]) await writeSealed(path.join(states, sha(text)), text);
    ledger.recordStep({ taskId: id, client: "claude:/work", seq: ++seq, phase: "Post", callsOpen: [], credited: [], files: [{ filePath: `/work/${f.file}`, sha256: sha(f.before), prevSha256: null, size: f.before.length, kept: "whole", note: "" }] });
    ledger.recordStep({ taskId: id, client: "claude:/work", seq: ++seq, phase: "Post", callsOpen: [], credited: [], files: [{ filePath: `/work/${f.file}`, sha256: sha(f.after), prevSha256: sha(f.before), size: f.after.length, kept: "whole", note: "" }] });
  }
  const rows = loadRows(ledger, id, "test");
  const input = await loadTimelineInput(ledger, home, opts.expired ? { ...rows, valuesExpiredAt: "2026-01-01T00:00:00Z" } : rows, { build: "test", quickLook: false });
  return buildTimeline(input);
}
const changesOf = (t: Timeline): Array<Change & { generic: GenericPart & { fingerprint?: { before: { size: number | null } | null; after: { size: number | null } | null } } }> => {
  const out: never[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.file === "string" && typeof o.generic === "object") (out as unknown[]).push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(t);
  return out;
};

describe("the secret rule in the loader", () => {
  it("a secret side's size is null, never 0", async () => {
    const t = await loaded([{ file: ".env", before: "K=old\n", after: "K=new\n" }]);
    const [c] = changesOf(t);
    assert.equal(c!.generic.secret, true);
    assert.equal(c!.generic.fingerprint!.before!.size, null);
    assert.equal(c!.generic.fingerprint!.after!.size, null);
  });

  it("after the 30-day value expiry a secret change keeps secret:true and its line", async () => {
    const t = await loaded([{ file: "a/b/.env", before: "K=old\n", after: "K=new\n" }], { expired: true });
    const [c] = changesOf(t);
    assert.equal(c!.generic.secret, true);
    assert.equal(c!.generic.label, secretLine("a/b/.env"));
    assert.ok(!JSON.stringify(t).includes("K=new"));
  });

  it("a text file over the 32 MB read cap is read head-only and stays tier text, with the cut in words", async () => {
    const big = "line of text\n".repeat(Math.ceil((33 * 1024 * 1024) / 13));
    const t = await loaded([{ file: "big.txt", before: big, after: big + "more\n" }]);
    const [c] = changesOf(t);
    assert.equal(c!.generic.tier, "text");
    assert.match(c!.generic.text!.cut ?? "", /MB/);
  });
});

describe("the wider secret name list", () => {
  it("matches any base name ending .env, plus .keystore, .jks, .token and service-account*.json, at any depth", () => {
    for (const p of ["config.env", "a/b/prod.env", "app.keystore", "x/release.jks", "api.token", "service-account.json", "gcp/service-account-prod.json", "CONFIG.ENV"]) assert.equal(isSecretPath(p), true, p);
  });
  it("leaves near misses alone", () => {
    for (const p of ["environment.ts", "environment.md", "tokens.md", "token.ts", "jks.md", "keystore.md", "service-account-guide.md", "service-accounts.txt", "myenv.txt", "env.json"]) assert.equal(isSecretPath(p), false, p);
  });
});
