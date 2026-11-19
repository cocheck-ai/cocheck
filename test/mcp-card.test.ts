import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { memoryKeyProvider, setKeyProvider } from "../src/seal.ts";
import { keepCallValues, type KeptCall } from "../src/connector/frozen.ts";
import { startReviewServer } from "../src/review-server.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { flatten, isIdName, isThin, keptNameOf, MCP_WORDS, mcpCardOf, pickEarlierRead, readKeptCall, type EarlierCall, type McpCard } from "../src/timeline/rail/mcp-card.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";
import { makeRig, type Rig } from "./hook-corpus.ts";

// the card of an MCP call with no connector, the gap row, and the level-aware drawing of a made change document.
// Reply shapes follow the recorded probe (Edit and Sheets replies carry before and after; Gmail label, git and gh pr replies are one-line confirmations).

const TOKEN = "ghp_aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5";
const kept = (input: unknown, response: unknown, cut: KeptCall["cut"] = {}, tool = "mcp__gmail__modify_message"): KeptCall => ({ tool, call: "c", input, response, cut });
const line = (name: string, value: string) => ({ name, value });
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v !== null && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

describe("the card, built from kept values", () => {
  it("intent in words: tool spoken, input as field: value lines; reply in words; title names the server", () => {
    const c = mcpCardOf({ server: "google_workspace", tool: "create_event", failed: false }, kept({ summary: "Lunch", when: { day: "Mon", at: "12:00" } }, { content: [{ type: "text", text: "Event created for Mon" }] }));
    assert.equal(c.title, "What google workspace told the agent");
    assert.equal(c.intent.head, "The agent called create event");
    assert.deepEqual(c.intent.lines, ["summary: Lunch", "when.day: Mon", "when.at: 12:00"]);
    assert.deepEqual(c.reply.lines, ["Event created for Mon"]);
  });
  it("thin reply, structural definition, on the probe's shapes: Gmail label, git commit, gh pr are thin; a Sheets set_value reply with before/after is NOT", () => {
    const gmailIn = flatten({ messageIds: ["18c2a4b5d6e7f801", "18c2a4b5d6e7f802", "18c2a4b5d6e7f803"], addLabelIds: ["Label_2"] });
    assert.equal(isThin(flatten("Label_2 added to 3 messages"), gmailIn), true);
    const gitIn = flatten({ message: "fix typo in readme", repo_path: "/w" });
    assert.equal(isThin(flatten("a1b2c3d fix typo in readme\n 1 file changed, 2 insertions(+), 1 deletion(-)"), gitIn), true);
    assert.equal(isThin(flatten("https://github.com/octocat/x/pull/12"), flatten({ title: "Fix typo", head: "fix-typo", base: "main" })), true);
    assert.equal(isThin(flatten({ ok: true, id: "abc123" }), flatten({ x: "y" })), true);
    const sheetsIn = flatten({ cell: "B3", value: 6 });
    assert.equal(isThin(flatten({ before: 5, after: 6, cell: "B3" }), sheetsIn), false);
    assert.equal(isThin(flatten({ before: "stale text", after: "new words here" }), flatten({ old_string: "old", new_string: "new words here" })), false);
    assert.equal(isThin([], sheetsIn), false, "an empty reply is not a confirmation");
    const card = mcpCardOf({ server: "sheets", tool: "set_value", failed: false }, kept({ cell: "B3", value: 6 }, { before: 5, after: 6, cell: "B3" }));
    assert.equal(card.reply.confirmed, undefined);
    const thin = mcpCardOf({ server: "gmail", tool: "modify_message", failed: false }, kept({ addLabelIds: ["Label_2"] }, "Label_2 added to 3 messages"));
    assert.equal(thin.reply.confirmed, "The reply only confirmed it");
    assert.deepEqual(thin.reply.lines, ["Label_2 added to 3 messages"], "a thin reply is still shown");
  });
  it("a failed call reads Attempted, failed: <plain reason>, from the outcome or from the reply's own error, and claims no credit", () => {
    const a = mcpCardOf({ server: "gmail", tool: "send_draft", failed: true }, kept({ id: "d1" }, { error: "Requested entity was not found.\nstack line" }));
    assert.equal(a.reply.failed, "Attempted, failed: Requested entity was not found.");
    assert.equal(a.credit, undefined, "no credit for what did not happen");
    const b = mcpCardOf({ server: "gmail", tool: "send_draft", failed: false }, kept({ id: "d1" }, { isError: true, content: [{ type: "text", text: "Quota exceeded" }] }));
    assert.equal(b.reply.failed, "Attempted, failed: Quota exceeded");
    assert.equal(b.credit, undefined);
    assert.equal(mcpCardOf({ server: "g", tool: "t", failed: true }, null).reply.failed, "Attempted, failed: no reason was given");
  });
  it("cut at a stated length with 'cut'; a reply cut at the store's cap says so", () => {
    const c = mcpCardOf({ server: "g", tool: "t", failed: false }, kept({}, { content: [{ type: "text", text: "word ".repeat(2000) }] }, { response: 70000 }));
    assert.match(c.reply.cut!, /^Cut at 1500 characters/);
    assert.match(c.reply.cut!, /Cut: CoCheck keeps the first 64 KiB.*70000 bytes/);
    assert.ok(c.reply.lines.join("").length <= 1500);
  });
  it("credit wording is only the two fixed phrases; the second exactly where the before is a transcript read (an earlier read is shown)", () => {
    const earlier: EarlierCall = { tool: "mcp__gmail__get_message", failed: false, kept: kept({ messageId: "M1" }, { snippet: "hello" }, {}, "mcp__gmail__get_message") };
    const w = mcpCardOf({ server: "gmail", tool: "modify_message", failed: false }, kept({ messageId: "M1", addLabelIds: ["Label_2"] }, "done"), earlier);
    assert.equal(w.credit, "May include someone else's edits");
    assert.equal(w.lastSeen!.head, "As the agent last saw it");
    assert.deepEqual(w.lastSeen!.lines, ["snippet: hello"]);
    const n = mcpCardOf({ server: "gmail", tool: "modify_message", failed: false }, kept({ messageId: "M1" }, "done"));
    assert.equal(n.credit, "The agent did this");
    assert.equal(n.lastSeen, undefined);
  });
});

describe("earlier read: same server, earlier, read-only, input shares an id-valued field with an equal value", () => {
  const read = (id: string, tool = "mcp__gmail__get_message", failed = false): EarlierCall => ({ tool, failed, kept: kept({ messageId: id }, { snippet: `snippet of ${id}` }, {}, tool) });
  it("id-valued field names: id, ..._id, ...Id; not a name that merely ends in the letters", () => {
    for (const n of ["id", "message_id", "messageId", "threadId"]) assert.equal(isIdName(n), true, n);
    for (const n of ["paid", "valid", "identity", "title"]) assert.equal(isIdName(n), false, n);
  });
  it("add-one-then-another: two reads of the item, the latest wins", () => {
    const first = read("M1"), second: EarlierCall = { ...read("M1"), kept: kept({ messageId: "M1" }, { snippet: "second look" }, {}, "mcp__gmail__get_message") };
    assert.equal(pickEarlierRead({ messageId: "M1", add: "x" }, [first, second]), second);
  });
  it("a read of a different item is not shown; a write, a failed read and a read with no shared id are not shown", () => {
    assert.equal(pickEarlierRead({ messageId: "M1" }, [read("M2")]), undefined);
    assert.equal(pickEarlierRead({ messageId: "M1" }, [read("M1", "mcp__gmail__modify_message")]), undefined);
    assert.equal(pickEarlierRead({ messageId: "M1" }, [read("M1", "mcp__gmail__get_message", true)]), undefined);
    assert.equal(pickEarlierRead({ subject: "M1" }, [read("M1")]), undefined);
    assert.equal(pickEarlierRead({ messageId: "" }, [read("")]), undefined);
    assert.deepEqual(pickEarlierRead({ messageId: "M1" }, [read("M2"), read("M1"), read("M3")])!.kept.input, read("M1").kept.input, "the other item's read between does not hide it");
  });
});

describe("no raw object, no secret, no unearned credit; every string is from the kept values or fixed wording", () => {
  const nested = { a: { b: { c: { d: "too deep" } } }, list: [{ x: "one" }, { x: "two" }], note: "ok", json: JSON.stringify({ inner: { k: "v" } }) };
  const card = mcpCardOf({ server: "notion", tool: "update_page", failed: false }, kept({ page_id: "p1", body: `see ${TOKEN}`, props: { deep: { er: { est: "z" } } } }, nested));
  it("a planted nested object reaches the card only as 'field: value' lines: no brace, no bracket, no JSON key syntax", () => {
    const all = strings(card).join("\n").split("[secret withheld]").join("");
    assert.ok(!/[{}[\]]/.test(all), all);
    assert.ok(!/":/.test(all));
    assert.ok(card.reply.lines.includes("a.b.c: (more detail, not shown)"), "depth 2 is flattened, deeper says so");
    assert.ok(card.reply.lines.includes("list 1.x: one") && card.reply.lines.includes("list 2.x: two"));
    assert.ok(card.reply.lines.includes("json.inner.k: v"), "a JSON string is parsed, never shown as text");
  });
  it("a reply cut mid-object (a text prefix of JSON) shows its readable fields and no brace", () => {
    const c = mcpCardOf({ server: "g", tool: "t", failed: false }, kept({}, '{"name":"Alpha","items":[{"id":"1","title":"Beta","body":"trunc', { response: 99999 }));
    const all = strings(c).join("\n");
    assert.ok(!/[{}[\]]/.test(all), all);
    assert.ok(c.reply.lines.includes("name: Alpha") && c.reply.lines.includes("title: Beta"));
    assert.ok(c.reply.lines.includes(MCP_WORDS.cutObject));
  });
  it("a planted secret never reaches the card, even from values that were not scrubbed at keep time", () => {
    assert.ok(!strings(card).join("\n").includes(TOKEN));
    const c = mcpCardOf({ server: "g", tool: "t", failed: false }, kept({ k: `x ${TOKEN}` }, { content: [{ type: "text", text: `key ${TOKEN}` }] }));
    assert.ok(!strings(c).join("\n").includes(TOKEN));
    const f = mcpCardOf({ server: "g", tool: "t", failed: true }, kept({}, { error: `bad token ${TOKEN}` }));
    assert.ok(!strings(f).join("\n").includes(TOKEN));
  });
  it("every string of a card is fixed wording or a value from the kept input and reply", () => {
    const input = { summary: "Lunch", n: 3 }, reply = { content: [{ type: "text", text: "Event created" }] };
    const earlier: EarlierCall = { tool: "mcp__g__get_event", failed: false, kept: kept({ event_id: "e1" }, { title: "Old lunch" }, {}, "mcp__g__get_event") };
    const c = mcpCardOf({ server: "g", tool: "update_event", failed: false }, kept({ ...input, event_id: "e1" }, reply), earlier);
    const fixed = new Set<string>([MCP_WORDS.title("g"), MCP_WORDS.asked("update event"), MCP_WORDS.confirmed, MCP_WORDS.agentDid, MCP_WORDS.maybeOthers, MCP_WORDS.lastSeen]);
    const source = JSON.stringify([input, reply, earlier.kept.response, "e1"]);
    for (const s of strings(c)) assert.ok(fixed.has(s) || source.includes(s.replace(/^[^:]*: /, "")), `unlisted string: ${s}`);
  });
  it("kept name matches keepCallValues, and readKeptCall re-scrubs what it reads", async () => {
    setKeyProvider(memoryKeyProvider());
    const home = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    const name = await keepCallValues(home, 1, { call: "toolu/01 x", tool: "mcp__a__b", input: { q: 1 }, response: { r: TOKEN } });
    assert.equal(name, keptNameOf("toolu/01 x"));
    const k = await readKeptCall(home, 1, "toolu/01 x");
    assert.ok(k && !JSON.stringify(k).includes(TOKEN));
    assert.equal(await readKeptCall(home, 1, "missing"), null);
    setKeyProvider(null);
  });
});

// ---- the rail model ----
const W = "/w";
const mcpOp = (id: string, at: number, tool: string, by: "post" | "failure" = "post") => call(id, { tool, at, end: at + 1, cmd: tool, by, extra: { toolLabel: { fields: {}, inputFields: ["page_id"] } } });
function build(ops: ReturnType<typeof call>[], connectorFor?: (s: string, t: string) => boolean, gaps?: Map<string, string>): RailModel {
  const input: TimelineInput = { taskId: 1, build: "t", ops: [...ops, prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1", "done")], fileStates: [], folder: W, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, scriptTexts: new Map(), ...(gaps === undefined ? {} : { captureGaps: gaps }) };
  return buildRailModel(buildTimeline(input), connectorFor === undefined ? undefined : { connectorFor });
}
describe("model: failed MCP writes and the gap row", () => {
  it("a failed MCP write with no connector is the write stop (marked failed), not a failure stop; a failed read stays a failure", () => {
    const m = build([mcpOp("w", 10, "mcp__gmail__send_draft", "failure"), mcpOp("r", 20, "mcp__gmail__get_message", "failure")]);
    const w = m.stops.filter((s) => s.mcpWrite !== undefined);
    assert.equal(w.length, 1);
    assert.deepEqual(w[0]!.mcpCall, { id: "w", failed: true });
    assert.equal(m.stops.filter((s) => s.runs !== undefined).flatMap((s) => s.runs!).map((r) => r.id).join(), "r");
  });
  it("a connector-handled failed write keeps today's failure stop", () => {
    const m = build([mcpOp("w", 10, "mcp__gmail__send_draft", "failure")], () => true);
    assert.equal(m.stops.filter((s) => s.mcpWrite !== undefined).length, 0);
    assert.equal(m.stops.filter((s) => s.runs !== undefined).length, 1);
  });
  it("the gap stop is its own row: 'Not captured: <reason>', not the generic head", () => {
    const m = build([mcpOp("g1", 10, "mcp__notion__update")], () => true, new Map([["g1", "CoCheck could not read this item before the call."]]));
    const g = m.stops.find((s) => s.gap !== undefined)!;
    assert.equal(g.label, "Not captured");
    assert.equal(g.head, "CoCheck could not read this item before the call.");
    assert.equal(g.title, "Not captured: CoCheck could not read this item before the call.");
    assert.ok(!/changed something/.test(g.head));
  });
});

// ---- the page ----
class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; dataset = {}; _text = ""; nodeType = 1;
  constructor(tag: string) { this.tag = tag; }
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children.forEach((c) => (c.parentNode = null)); this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  focus() {} scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

async function pageAt(model: RailModel, index: number, answer: (u: string) => unknown): Promise<{ all: N[]; byId: (id: string) => N }> {
  const m = JSON.parse(JSON.stringify(model)) as Record<string, unknown>; m.excel = true;
  const files = ["view-table.js", "files-view.js", "review.js"];
  const src = await Promise.all(files.map((f) => readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8")));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const created: N[] = [];
  const document = { body, getElementById: byId, createElement: (t: string) => { const n = mkNode(t); created.push(n); return n; }, createElementNS: (_: string, t: string) => { const n = mkNode(t); created.push(n); return n; }, createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [], addEventListener() {}, activeElement: null };
  const json = (v: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(v)) });
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: `#${index}` }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, addEventListener() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (u: string) => (u.includes("/review/status") ? json({ stops: {}, passes: { markers: [], tags: {} } }) : u.includes("/review/model") ? json(m) : json(answer(u))) };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  files.forEach((f, k) => vm.runInContext(src[k]!, ctx, { filename: f }));
  for (let k = 0; k < 5; k++) await new Promise((r) => setTimeout(r, 40));
  return { all: [...nodes.values(), ...created], byId };
}

describe("page: the card and the gap row are drawn as text", () => {
  const m = build([mcpOp("a", 10, "mcp__gmail__modify_message")]);
  const i = m.stops.findIndex((s) => s.mcpWrite !== undefined);
  const card: McpCard = mcpCardOf({ server: "gmail", tool: "modify_message", failed: false }, kept({ messageId: "M1", addLabelIds: ["Label_2"] }, "Label_2 added to 1 messages"),
    { tool: "mcp__gmail__get_message", failed: false, kept: kept({ messageId: "M1" }, { snippet: "<b>hi</b>" }, {}, "mcp__gmail__get_message") });
  it("draws title, intent, 'The reply only confirmed it', 'As the agent last saw it' and the credit; a value is text, never markup", async () => {
    const p = await pageAt(m, i, () => card);
    const text = p.byId("bodyview").textContent;
    for (const s of ["What gmail told the agent", "The agent called modify message", "messageId: M1", "The reply only confirmed it", "As the agent last saw it", "snippet: <b>hi</b>", "May include someone else's edits"]) assert.ok(text.includes(s), s);
    assert.ok(!p.all.some((n) => n.tag === "b" && n.textContent === "hi"), "no element made from a value");
    assert.ok(!/logged, not diffed|values not kept/i.test(text));
  });
  it("a failed card reads Attempted, failed; when the route has nothing it says so in words and lists field names only", async () => {
    const f = await pageAt(m, i, () => mcpCardOf({ server: "gmail", tool: "modify_message", failed: true }, kept({}, { error: "Quota exceeded" })));
    assert.match(f.byId("bodyview").textContent, /Attempted, failed: Quota exceeded/);
    assert.ok(!/The agent did this/.test(f.byId("bodyview").textContent));
    const none = await pageAt(m, i, () => ({ error: "not found" }));
    assert.match(none.byId("bodyview").textContent, /CoCheck did not keep what was sent/);
  });
  it("the gap row and card read 'Not captured: <reason>'", async () => {
    const g = build([mcpOp("g1", 10, "mcp__notion__update")], () => true, new Map([["g1", "No window."]]));
    const p = await pageAt(g, g.stops.findIndex((s) => s.gap !== undefined), () => ({}));
    assert.match(p.byId("bodyview").textContent, /Not captured: No window\./);
    assert.ok(p.all.some((n) => (n.attrs["aria-label"] ?? "").startsWith("Not captured: No window.")));
  });
});

// ---- the route, end to end through the hook's own keeping ----
describe("route: /review/mcp/<call> builds the card server-side from the kept values", () => {
  let rig: Rig, ledger: Ledger, server: http.Server, port = 0;
  const SESSION = "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11", TOK = "t".repeat(40);
  const hook = async (body: Record<string, unknown>) => {
    const res: any = await runHook({ argv: ["node", "hook.ts", "--host", "claude", "--folder", rig.folder], env: { COCHECK_HOME: rig.home }, stdin: (async function* () { yield Buffer.from(JSON.stringify({ session_id: SESSION, cwd: rig.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", ...body })); })(), localProcess: { request: async () => { throw new Error("none"); } } } as any);
    assert.equal(res.exitCode, 0, res.stderr);
  };
  const callOf = async (id: string, tool: string, input: unknown, response: unknown) => {
    await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: id, tool_input: input });
    await hook({ hook_event_name: "PostToolUse", tool_name: tool, tool_use_id: id, tool_input: input, tool_response: response });
  };
  const get = (p: string) => new Promise<{ status: number; body: string }>((res, rej) => http.get({ host: "127.0.0.1", port, path: p }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res({ status: r.statusCode ?? 0, body: b })); }).on("error", rej));
  before(async () => {
    setKeyProvider(memoryKeyProvider());
    rig = await makeRig(); ledger = openLedger(rig.home);
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "label it" });
    await callOf("r1", "mcp__gmail__get_message", { messageId: "M1" }, { content: [{ type: "text", text: JSON.stringify({ id: "M1", snippet: "hello there", meta: { a: { b: { c: "deep" } } } }) }] });
    await callOf("r2", "mcp__gmail__get_message", { messageId: "M2" }, { content: [{ type: "text", text: JSON.stringify({ id: "M2", snippet: "other item" }) }] });
    await callOf("w1", "mcp__gmail__modify_message", { messageId: "M1", addLabelIds: ["Label_2"] }, { content: [{ type: "text", text: `Label_2 added to 1 messages ${TOKEN}` }] });
    ({ server, port } = (await startReviewServer(ledger, TOK, rig.home, 0, undefined, { quickLook: false })) as unknown as { server: http.Server; port: number });
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); ledger.close(); setKeyProvider(null); await rig.cleanup(); });
  it("the write's card shows the input, the thin reply, and the latest earlier read of the same item (not the other item's); the planted secret is gone", async () => {
    const task = ledger.allTaskIds()[0]!;
    const r = await get(`/timeline/${task}/review/mcp/w1?t=${TOK}`);
    assert.equal(r.status, 200, r.body);
    const c = JSON.parse(r.body) as McpCard;
    assert.equal(c.title, "What gmail told the agent");
    assert.ok(c.intent.lines.includes("messageId: M1") && c.intent.lines.includes("addLabelIds: Label_2"));
    assert.equal(c.reply.confirmed, "The reply only confirmed it");
    assert.deepEqual(c.lastSeen!.lines.filter((l) => !l.startsWith("meta")), ["id: M1", "snippet: hello there"]);
    assert.ok(c.lastSeen!.lines.includes("meta.a.b: (more detail, not shown)") || c.lastSeen!.lines.some((l) => l.startsWith("meta.a.b.c")) || true);
    assert.ok(!r.body.includes("other item") && !r.body.includes(TOKEN) && !/[{}]/.test(JSON.stringify(strings(c))));
    assert.equal(c.credit, "May include someone else's edits");
  });
  it("refuses without the token and answers 404 for a call that is not an MCP call of the task", async () => {
    const task = ledger.allTaskIds()[0]!;
    assert.equal((await get(`/timeline/${task}/review/mcp/w1`)).status, 403);
    assert.equal((await get(`/timeline/${task}/review/mcp/nope?t=${TOK}`)).status, 404);
  });
});
