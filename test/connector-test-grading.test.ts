import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runConnectorTest } from "../src/connector-test-cli.ts";
import { afterSnapshot, afterSnapshotSerial } from "../src/connector/after-snapshot.ts";
import { beforeSnapshot, createConnectorPool } from "../src/connector/before-snapshot.ts";
import { openLedger } from "../src/ledger.ts";
import { startReviewServer } from "../src/review-server.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { makeRig } from "./hook-corpus.ts";
import { drawn } from "./helpers/made-page.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";

// Clauses 2, 3, 4 and exit (c). Must not happen: a connector that passes `connector test` but draws nothing or something else once installed
// (the junk connectors below must FAIL), against refusing an honest one (the toys must pass).
const ROOT = path.resolve(import.meta.dirname, "..");
const STATES = path.join(ROOT, "public-kit", "toy-product", "states");
const EX = (n: string) => path.join(ROOT, "public-kit", "examples", n);
const TOKEN = "t".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); setKeyProvider(null); delete process.env.TOY_VENDOR_STORE; });

const MANIFEST = (entry: string, extra: Record<string, unknown> = {}) => JSON.stringify({ spec: "cocheck.connector/1", id: "junk", version: "0.0.1", entry, matches: { extensions: [".junk.json"] }, run: ["node", "c.mjs"], credentials: [], ...extra });
async function connector(entry: string, program: string, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-conn-"));
  await writeFile(path.join(dir, "cocheck-connector.json"), MANIFEST(entry, extra));
  await writeFile(path.join(dir, "c.mjs"), `import readline from "node:readline";import {readFileSync} from "node:fs";\nconst rl=readline.createInterface({input:process.stdin});rl.on("line",(l)=>{const m=JSON.parse(l);let r;try{${program}}catch(e){r={error:{code:"bad",message:String(e.message)}}}process.stdout.write(JSON.stringify({id:m.id,...r})+"\\n")});`);
  return dir;
}
const run = (dir: string) => runConnectorTest([dir, "--states", STATES]);

describe("connector test: a connector that ignores the product does not pass", () => {
  it("level 1 junk (always three 'something' changes, no sides) fails", async () => {
    const dir = await connector("state", `if(m.method==="hello")r={result:{spec:"cocheck.connector/1",level:1,methods:["diff"]}};else{const a=readFileSync(m.params.after,"utf8");const b=readFileSync(m.params.before,"utf8");JSON.parse(a);r={result:a===b?{spec:"cocheck.changes/1",changes:[]}:{spec:"cocheck.changes/1",changes:[{id:"1",mark:"added",label:"something"},{id:"2",mark:"changed",label:"something2"},{id:"3",mark:"removed",label:"something3"}]}}}`);
    const r = await run(dir);
    assert.equal(r.exitCode, 1, r.stdout);
    assert.match(r.stdout, /same answer|before and an after/);
  });
  it("a level 1 connector that throws on an empty file fails (production sends empty files for a side that does not exist)", async () => {
    const dir = await connector("state", `if(m.method==="hello")r={result:{spec:"cocheck.connector/1",level:1,methods:["diff"]}};else{const rd=(f)=>{const t=readFileSync(f,"utf8");return JSON.parse(t)};const b=rd(m.params.before),a=rd(m.params.after);const bm=new Map(b.notes.map(n=>[n.id,n.text])),am=new Map(a.notes.map(n=>[n.id,n.text]));const ch=[];for(const[i,t]of am){if(!bm.has(i))ch.push({id:i,mark:"added",label:"Note "+i,after:t});else if(bm.get(i)!==t)ch.push({id:i,mark:"changed",label:"Note "+i,before:bm.get(i),after:t})}for(const[i,t]of bm)if(!am.has(i))ch.push({id:i,mark:"removed",label:"Note "+i,before:t});r={result:{spec:"cocheck.changes/1",changes:ch}}}`);
    const r = await run(dir);
    assert.equal(r.exitCode, 1, r.stdout);
    assert.match(r.stdout, /empty (before|after)|empty file/);
  });
  it("an export that prints the raw file unchanged is flagged", async () => {
    const dir = await connector("export", `if(m.method==="hello")r={result:{spec:"cocheck.connector/1",methods:["export"]}};else{const t=readFileSync(m.params.subject,"utf8");JSON.parse(t);r={result:{text:t}}}`);
    const r = await run(dir);
    assert.equal(r.exitCode, 1, r.stdout);
    assert.match(r.stdout, /file's text, unchanged|not the file's own text/);
  });
  it("the honest toys still pass (level 1, level 3, export, vendor)", async () => {
    for (const n of ["toy-level-1", "toy-level-3", "toy-export", "toy-vendor"]) {
      const r = await run(EX(n));
      assert.equal(r.exitCode, 0, `${n}: ${r.stdout}`);
    }
  });
  it("a connector with a subject template that does not answer snapshot fails (installed, nothing would ever be captured)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-conn-"));
    await cp(EX("toy-vendor"), dir, { recursive: true });
    const cp0 = path.join(dir, "connector.mjs");
    await writeFile(cp0, (await readFile(cp0, "utf8")).replace('methods: ["snapshot", "diff"]', 'methods: ["diff"]').replace('msg.method === "snapshot"', 'msg.method === "never"'));
    const r = await run(dir);
    assert.equal(r.exitCode, 1, r.stdout);
    assert.match(r.stdout, /snapshot/);
  });
  it("openInProduct and permissions.network are refused; permissions.env is kept", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-conn-"));
    await cp(EX("toy-level-1"), dir, { recursive: true });
    const mp = path.join(dir, "cocheck-connector.json");
    const m = JSON.parse(await readFile(mp, "utf8"));
    await writeFile(mp, JSON.stringify({ ...m, openInProduct: { url: "https://x" }, permissions: { network: true, env: ["A"] } }));
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /openInProduct/);
    assert.match(r.stdout, /permissions\.network/);
    assert.doesNotMatch(r.stdout, /permissions\.env: /);
  });
});

describe("exit (c): the MCP-vendor toy draws on the page after a hook-path MCP call", () => {
  it("toy-vendor: Pre and Post hooks with a real local process, then the review route and the page", async () => {
    setKeyProvider(memoryKeyProvider());
    const rig = await makeRig();
    const store = await mkdtemp(path.join(tmpdir(), "cocheck-store-"));
    process.env.TOY_VENDOR_STORE = store;
    await mkdir(path.join(rig.home, "connectors"), { recursive: true });
    await cp(EX("toy-vendor"), path.join(rig.home, "connectors", "toy-vendor"), { recursive: true });
    const ledger = openLedger(rig.home);
    const pool = createConnectorPool();
    const { server, port } = await startReviewServer(ledger, TOKEN, rig.home, 0, undefined, { previewRenderer: async () => null, quickLook: false });
    cleanups.push(async () => { await pool.stopAll(); await new Promise<void>((r) => server.close(() => r())); ledger.close(); await rig.cleanup(); });
    const pending: Array<Promise<unknown>> = [];
    const localProcess = {
      request: async (q: { subject: string; tool?: string; budgetMs: number }) => { const b = await beforeSnapshot({ home: rig.home, pool, subject: q.subject, ...(q.tool !== undefined ? { tool: q.tool } : {}), budgetMs: q.budgetMs }); if (b.ref === null) throw new Error("absent"); return { ref: b.ref }; },
      afterSnapshot: async (q: Record<string, unknown>) => { pending.push(afterSnapshotSerial(() => afterSnapshot({ home: rig.home, ledger, pool, ...(q as object), budgetMs: 10_000 } as never))); },
    };
    const SESSION = "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11";
    const base = { session_id: SESSION, cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default" };
    const send = async (body: Record<string, unknown>) => { const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: rig.home, TOY_VENDOR_STORE: store }, stdin: (async function* () { yield Buffer.from(JSON.stringify(body)); })(), localProcess } as any); assert.equal(res.exitCode, 0, res.stderr); }; // eslint-disable-line @typescript-eslint/no-explicit-any
    await writeFile(path.join(store, "n1.json"), await readFile(path.join(STATES, "edit.before.json")));
    const call = { tool_name: "mcp__toyvendor__update_note", tool_use_id: "toolu_vendor_1", tool_input: { note_id: "n1" } };
    await send({ ...base, hook_event_name: "UserPromptSubmit", prompt: "update the note" });
    await send({ ...base, hook_event_name: "PreToolUse", ...call });
    await writeFile(path.join(store, "n1.json"), await readFile(path.join(STATES, "edit.after.json")));
    await send({ ...base, hook_event_name: "PostToolUse", ...call, tool_response: { ok: true } });
    await Promise.all(pending);
    await new Promise((r) => setTimeout(r, 1500));
    await Promise.all(pending);
    const task = ledger.allTaskIds()[0]!;
    const get = (p: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => { http.get({ hostname: "127.0.0.1", port, path: `${p}?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => { const c: Buffer[] = []; res.on("data", (x: Buffer) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(c).toString("utf8") })); }).on("error", reject); });
    const timeline = JSON.parse((await get(`/timeline/${task}`)).body) as { unplaced: Array<{ id: string }>; requests: Array<{ runs: Array<{ calls: Array<{ changes: Array<{ id: string }> }> }> }> };
    const all = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((x) => x.calls.flatMap((c) => c.changes)))];
    assert.equal(all.length, 1, JSON.stringify(timeline).slice(0, 800));
    const view = await get(`/timeline/${task}/view/${encodeURIComponent(all[0]!.id)}`);
    assert.equal(view.status, 200, view.body);
    const p = await drawn(JSON.parse(view.body));
    const t = p.details() + "\n" + p.byId("bodyview").textContent;
    assert.ok(t.includes("Change list from toy-vendor"), t);
    assert.ok(t.includes("1 changed") && t.includes("buy oat milk"), t);
  });
});
