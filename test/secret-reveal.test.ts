import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toolLabel } from "../src/tool-label.ts";
import { revealWithheld } from "../src/reveal.ts";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// Reveal a withheld helper field from the host's own transcript. The ledger keeps only the field name, rule family, sha256 and locator;
// the text is read on the person's click, returned only when its sha256 matches, and never written anywhere. Every file here is a fixture in a temp dir.
// Guard: a path outside the profile root (copy, `..`, symlink), a hash mismatch, a missing or wrong-id transcript returns nothing.

const TOKEN = "t".repeat(40);
// The fixture secret is a GitHub token, a vendor format in the gitleaks default ruleset.
const GH = "ghp_Z8k2Qm4Xv7Rt1Pw9Yb3Nc6Hd5Jf0Lg8Ae2SW";
const SECRET = `${GH} and the rest of the brief`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hooks = { text: (s: string) => s, path: (s: string) => s };
const jsonl = (id: string, field: string, value: string) => [
  JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id, name: "SendMessage", input: { to: "x", [field]: value } }] } }),
].join("\n") + "\n";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function tmp(prefix: string): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
}

/** A profile root with one project folder holding a session transcript that carries the call `toolu_1`. */
async function fixture(opts: { value?: string } = {}) {
  const root = await tmp("cocheck-root-");
  const proj = path.join(root, "-work");
  await mkdir(proj, { recursive: true });
  const file = path.join(proj, "sess.jsonl");
  await writeFile(file, jsonl("toolu_1", "message", opts.value ?? SECRET));
  return { root, proj, file };
}
const entry = (file: string, text = SECRET, id = "toolu_1") => ({ family: "name-assignment", sha256: sha(text), locator: { file, id } });

describe("the ledger record of a withheld field", () => {
  it("toolLabel records the field name, family and sha256 of the raw text, never the text", () => {
    const label = toolLabel("SendMessage", { to: "x", message: SECRET }, hooks);
    assert.deepEqual(label.dropped?.message, "secret-looking value, not recorded");
    const w = label.withheld!.message!;
    assert.equal(w.sha256, sha(SECRET));
    assert.equal(typeof w.family, "string");
    assert.deepEqual(Object.keys(w).sort(), ["family", "sha256"]);
    assert.ok(!JSON.stringify(label).includes(GH));
    assert.equal(toolLabel("SendMessage", { to: "x", message: "all good" }, hooks).withheld, undefined);
  });

  it("the hook adds the transcript locator (file and tool_use id) and nothing else of the text", async () => {
    const home = await tmp("cocheck-home-");
    const folder = await tmp("cocheck-folder-");
    const { file } = await fixture();
    const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, outsideWatching: true, now: (() => { let c = 1_000_000; return () => (c += 1000); })() };
    const send = (over: Record<string, unknown>) => handleHook({ session_id: "s1", cwd: folder, hook_event_name: "", transcript_path: file, ...over } as HookPayload, opts);
    const input = { to: "x", message: SECRET };
    await send({ hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_use_id: "toolu_1", tool_input: input });
    await send({ hook_event_name: "PostToolUse", tool_name: "SendMessage", tool_use_id: "toolu_1", tool_input: input });
    const ledger = openLedger(home);
    try {
      const rows = ledger.okOpsForTask(1, 0, ledger.maxOpId()).filter((o) => o.argsJson.includes("toolu_1"));
      assert.ok(rows.length > 0);
      for (const r of rows) assert.ok(!r.argsJson.includes(GH));
      const last = JSON.parse(rows.at(-1)!.argsJson);
      assert.deepEqual(last.toolLabel.withheld.message.locator, { file, id: "toolu_1" });
      assert.equal(last.toolLabel.withheld.message.sha256, sha(SECRET));
    } finally {
      ledger.close();
    }
  });
});

describe("revealWithheld (nothing unless the hash matches inside the root)", () => {
  it("returns the text on a match under the root", async () => {
    const f = await fixture();
    assert.equal(await revealWithheld("message", entry(f.file), f.root, "claude"), SECRET);
  });
  it("hash mismatch returns nothing", async () => {
    const f = await fixture({ value: SECRET + " edited" });
    assert.equal(await revealWithheld("message", entry(f.file), f.root, "claude"), undefined);
  });
  it("a missing transcript, a wrong call id and a wrong field return nothing", async () => {
    const f = await fixture();
    assert.equal(await revealWithheld("message", entry(path.join(f.proj, "gone.jsonl")), f.root, "claude"), undefined);
    assert.equal(await revealWithheld("message", entry(f.file, SECRET, "toolu_2"), f.root, "claude"), undefined);
    assert.equal(await revealWithheld("summary", entry(f.file), f.root, "claude"), undefined);
  });
  it("a transcript outside the root returns nothing", async () => {
    const f = await fixture();
    const other = await tmp("cocheck-other-");
    const outside = path.join(other, "sess.jsonl");
    await writeFile(outside, jsonl("toolu_1", "message", SECRET));
    assert.equal(await revealWithheld("message", entry(outside), f.root, "claude"), undefined);
  });
  it("a `..` traversal out of the root returns nothing", async () => {
    const f = await fixture();
    const other = await tmp("cocheck-other-");
    await writeFile(path.join(other, "sess.jsonl"), jsonl("toolu_1", "message", SECRET));
    const sneaky = path.join(f.root, "-work", "..", "..", path.basename(other), "sess.jsonl");
    assert.equal(await revealWithheld("message", entry(sneaky), f.root, "claude"), undefined);
  });
  it("a symlink whose realpath leaves the root returns nothing (file link and folder link)", async () => {
    const f = await fixture();
    const other = await tmp("cocheck-other-");
    await writeFile(path.join(other, "real.jsonl"), jsonl("toolu_1", "message", SECRET));
    await symlink(path.join(other, "real.jsonl"), path.join(f.proj, "link.jsonl"));
    await symlink(other, path.join(f.root, "linkdir"));
    assert.equal(await revealWithheld("message", entry(path.join(f.proj, "link.jsonl")), f.root, "claude"), undefined);
    assert.equal(await revealWithheld("message", entry(path.join(f.root, "linkdir", "real.jsonl")), f.root, "claude"), undefined);
  });
  it("a relative path, a non-jsonl file, a folder and a host with no reader return nothing", async () => {
    const f = await fixture();
    await writeFile(path.join(f.proj, "notes.txt"), jsonl("toolu_1", "message", SECRET));
    assert.equal(await revealWithheld("message", entry("sess.jsonl"), f.root, "claude"), undefined);
    assert.equal(await revealWithheld("message", entry(path.join(f.proj, "notes.txt")), f.root, "claude"), undefined);
    assert.equal(await revealWithheld("message", entry(f.proj), f.root, "claude"), undefined);
    assert.equal(await revealWithheld("message", entry(f.file), f.root, "codex"), undefined);
    assert.equal(await revealWithheld("message", entry(f.file), f.root, null), undefined);
    assert.equal(await revealWithheld("message", { family: "x", sha256: sha(SECRET) } as never, f.root, "claude"), undefined);
  });
});

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const n of (await readdir(d)).sort()) {
      const p = path.join(d, n);
      const st = await stat(p);
      if (st.isDirectory()) await walk(p);
      else out.push(`${path.relative(dir, p)}:${st.size}:${st.mtimeMs}:${sha(await readFile(p, "latin1"))}`);
    }
  };
  await walk(dir);
  return out;
}

async function server(root: string, label: unknown) {
  const home = await tmp("cocheck-data-");
  const ledger = openLedger(home);
  const { server: srv, port } = await startReviewServer(ledger, TOKEN, home, 0, undefined, { previewRenderer: async () => null, quickLook: false, transcriptsRoot: root });
  cleanups.push(async () => { await new Promise<void>((r) => (srv as Server).close(() => r())); ledger.close(); });
  const client = "claude-hook:/work";
  const id = ledger.openTask(client);
  ledger.recordOp({ taskId: id, tool: "SendMessage", intent: "send", clientName: client, durationMs: 1, resultCode: "OK", args: { hookAdapter: 1, tool_use_id: "toolu_1", closedBy: "post", background: false, openedAt: 1000, closedAt: 2000, startSeq: 1, host: "claude", session_id: "sess", tool_name: "SendMessage", namedFiles: [], description: "", narration: { source: "none", text: "none" }, toolLabel: label } });
  const req = (method: string, p: string, o: { token?: string | null; origin?: string | null; host?: string; json?: unknown } = {}): Promise<{ status: number; body: string }> => {
    const token = o.token === undefined ? TOKEN : o.token;
    const body = o.json === undefined ? undefined : JSON.stringify(o.json);
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${port}`, ...(body === undefined ? {} : { "content-type": "application/json" }) };
    const origin = o.origin === undefined ? `http://127.0.0.1:${port}` : o.origin;
    if (origin !== null) headers.origin = origin;
    return new Promise((resolve, reject) => {
      const r = http.request({ hostname: "127.0.0.1", port, path: token === null ? p : `${p}?t=${token}`, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      r.on("error", reject);
      if (body !== undefined) r.write(body);
      r.end();
    });
  };
  return { home, id, req, ledger };
}
const labelFor = (file: string, text = SECRET) => ({ fields: { to: "x" }, dropped: { message: "secret-looking value, not recorded" }, withheld: { message: { family: "name-assignment", sha256: sha(text), locator: { file, id: "toolu_1" } } } });

describe("the review route", () => {
  it("returns the text on a match, with the same token, Host, Origin and method checks as every timeline route", async () => {
    const f = await fixture();
    const s = await server(f.root, labelFor(f.file));
    const url = `/timeline/${s.id}/review/reveal`;
    const ok = await s.req("POST", url, { json: { call: "toolu_1", field: "message" } });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).text, SECRET);
    assert.equal((await s.req("POST", url, { json: { call: "toolu_1", field: "message" }, token: "wrong" })).status, 403);
    assert.equal((await s.req("POST", url, { json: { call: "toolu_1", field: "message" }, token: null })).status, 403);
    assert.equal((await s.req("POST", url, { json: { call: "toolu_1", field: "message" }, origin: "http://evil.example" })).status, 403);
    assert.equal((await s.req("POST", url, { json: { call: "toolu_1", field: "message" }, host: "evil.example" })).status, 403);
    assert.equal((await s.req("GET", url)).status, 405);
    for (const r of [await s.req("POST", url, { json: { call: "toolu_1", field: "message" }, token: "wrong" }), await s.req("POST", url, { json: { call: "toolu_1", field: "message" }, origin: "http://evil.example" })]) assert.ok(!r.body.includes(GH));
  });

  it("returns nothing for a hash mismatch, a missing transcript, an outside path, an unknown call or a field with no record", async () => {
    const f = await fixture();
    const other = await tmp("cocheck-other-");
    await writeFile(path.join(other, "sess.jsonl"), jsonl("toolu_1", "message", SECRET));
    const cases: Array<[string, unknown, unknown]> = [
      ["hash mismatch", labelFor(f.file, "something else"), { call: "toolu_1", field: "message" }],
      ["missing transcript", labelFor(path.join(f.proj, "gone.jsonl")), { call: "toolu_1", field: "message" }],
      ["outside the root", labelFor(path.join(other, "sess.jsonl")), { call: "toolu_1", field: "message" }],
      ["unknown call", labelFor(f.file), { call: "toolu_9", field: "message" }],
      ["field with no record", labelFor(f.file), { call: "toolu_1", field: "summary" }],
      ["body not an object", labelFor(f.file), { call: 5, field: ["message"] }],
    ];
    for (const [name, label, body] of cases) {
      const s = await server(f.root, label);
      const r = await s.req("POST", `/timeline/${s.id}/review/reveal`, { json: body });
      assert.ok(r.status >= 400, name);
      assert.ok(!r.body.includes(GH) && !r.body.includes("hunter"), name);
      assert.equal(JSON.parse(r.body).text, undefined, name);
    }
  });

  it("writes nothing on a reveal: the data home is byte-identical before and after, and the transcript is untouched", async () => {
    const f = await fixture();
    const s = await server(f.root, labelFor(f.file));
    await s.req("GET", `/timeline/${s.id}/review/model`);
    const before = await snapshot(s.home);
    const tBefore = await snapshot(f.root);
    for (const body of [{ call: "toolu_1", field: "message" }, { call: "toolu_1", field: "summary" }]) await s.req("POST", `/timeline/${s.id}/review/reveal`, { json: body });
    assert.deepEqual(await snapshot(s.home), before);
    assert.deepEqual(await snapshot(f.root), tBefore);
    // the timeline body served afterwards never holds the text either
    const tl = await s.req("GET", `/timeline/${s.id}`);
    assert.ok(!tl.body.includes(GH));
    assert.ok(!(await s.req("GET", `/timeline/${s.id}/review/model`)).body.includes(GH));
  });
});

describe("scope: only a helper's message or brief leaves a way back", () => {
  it("a secret-looking command, query or path is dropped with no withheld record", () => {
    const l = toolLabel("Grep", { pattern: "AKIAIOSFODNN7REALKEY", path: GH }, hooks);
    assert.ok(l.dropped?.pattern);
    assert.equal(l.withheld, undefined);
    assert.equal(toolLabel("Agent", { prompt: SECRET }, hooks).withheld!.prompt!.sha256, sha(SECRET));
  });
});
