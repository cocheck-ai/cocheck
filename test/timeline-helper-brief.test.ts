import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import type { RailModel } from "../src/timeline/rail/model.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";
import type { RawOp } from "../src/timeline/runs.ts";

// a helper's start step shows the brief the main agent gave it (the Agent call's prompt), labelled as Claude's words, folded when long
// with its ending kept; a start with no recorded brief says so. Line shapes copy the recorded run's Agent calls (ops 1128, 1130): a toolLabel with
// subagent_type and description, now plus the prompt.

const c = (id: string, seq: number, extra: Record<string, unknown> = {}, tool = "Agent", desc = id) => call(id, { session: "s1", tool, desc, at: seq * 10, named: [], extra: { startSeq: seq, ...extra } });
const input = (ops: RawOp[]): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates: [], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quietLook: false } as unknown as TimelineInput);
const model = (ops: RawOp[]) => buildRailModel(buildTimeline(input(ops)));
const label = (fields: Record<string, string>) => ({ toolLabel: { fields: { subagent_type: "general-purpose", ...fields } } });

const BRIEF = "Fetch the FRED unemployment series (UNRATE).\n\n## Output\n- Save it as **unrate.csv**.\n- Report the row count.";
const ops = [
  prompt("s1", ["Build the workbook."], { requests: [{ seq: 1, at: 10, firstStep: null }] }),
  c("A1", 2, label({ description: "Fetch FRED unemployment", prompt: BRIEF }), "Agent", "Fetch FRED unemployment"),
  c("A2", 3, label({ description: "Fetch FRED CPI" }), "Agent", "Fetch FRED CPI"),
  stop("s1", "done"),
];

describe("a helper's start step shows its brief", () => {
  it("the start step carries the brief as plain lines, from the host, for the helper", () => {
    const s = model(ops).stops.filter((x) => x.id.startsWith("start-"))[0]!;
    assert.ok(s.brief, JSON.stringify(s));
    assert.deepEqual(s.brief!.lines, ["Fetch the FRED unemployment series (UNRATE).", "Output", "- Save it as unrate.csv.", "- Report the row count."]);
    assert.equal(s.brief!.by, "Claude");
  });
  it("parallel helpers each show their own brief, and a withheld brief says so on its own helper only", () => {
    const two = [
      prompt("s1", ["Build."], { requests: [{ seq: 1, at: 10, firstStep: null }] }),
      c("B1", 2, label({ description: "Fetch UNRATE", prompt: "Brief ONE: fetch UNRATE." }), "Agent", "Fetch UNRATE"),
      c("B2", 3, label({ description: "Fetch CPI", prompt: "Brief TWO: fetch CPI." }), "Agent", "Fetch CPI"),
      c("B3", 4, { toolLabel: { fields: { subagent_type: "general-purpose", description: "Fetch GDP" }, dropped: { prompt: "secret-looking value, not recorded" } } }, "Agent", "Fetch GDP"),
      stop("s1", "done"),
    ];
    const st = model(two).stops;
    assert.deepEqual(st.filter((x) => x.id.startsWith("start-"))[0]!.brief!.lines, ["Brief ONE: fetch UNRATE."]);
    assert.deepEqual(st.filter((x) => x.id.startsWith("start-"))[1]!.brief!.lines, ["Brief TWO: fetch CPI."]);
    const w = st.filter((x) => x.id.startsWith("start-"))[2]!.brief!;
    assert.deepEqual(w.lines, []);
    assert.equal(w.withheld, true);
    assert.equal(st.filter((x) => x.id.startsWith("start-"))[0]!.brief!.withheld, undefined);
  });
  it("a start with no recorded brief says so (null lines), never an empty panel", () => {
    const s = model(ops).stops.filter((x) => x.id.startsWith("start-"))[1]!;
    assert.deepEqual(s.brief, { by: "Claude", lines: [] });
  });
  it("a non-start step has no brief", () => {
    assert.equal(model(ops).stops.find((x) => x.id.startsWith("reply-"))?.brief, undefined);
  });
});

// The page: review.js runs as is in a vm with a DOM stub (the harness of the page tests).
class N {
  tag: string; attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty(this: Record<string, unknown>, k: string, v: string) { this[k] = v; } }; dataset = {}; _text = ""; nodeType = 1; disabled = false; value = ""; title = ""; open = false; focused = false;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  fire(k: string, e: Record<string, unknown> = {}) { (this.listeners[k] ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this, ...e })); }
  click() { this.fire("click"); }
  focus() { this.focused = true; } select() {} scrollIntoView() {} scrollTo() {} showModal() { this.open = true; } close() { this.open = false; }
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { if (!s.className.split(/\s+/).includes(c)) s.className += " " + c; }, remove: (c: string) => { s.className = s.className.split(/\s+/).filter((x) => x !== c).join(" "); }, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });
const has = (n: N, c: string) => n.className.split(/\s+/).includes(c);

async function boot(model: RailModel) {
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const stops: Record<string, unknown> = {};
  for (const s of model.stops) stops[s.id] = { status: "not_reviewed", note: "", stale: false, history: [] };
  const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => v });
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, navigator: {},
    addEventListener() {}, setInterval: () => 0, clearInterval() {}, setTimeout: (f: () => void, ms: number) => (ms === 6000 || f.name === "poll" ? 0 : setTimeout(f, 0)), clearTimeout() {},
    fetch: async (u: string) => {
      if (u.includes("/review/model")) return json(JSON.parse(JSON.stringify(model)));
      if (u.includes("/review/status")) return json({ stops, passes: { markers: [], tags: {}, answeredBy: {} }, submitState: "none", submitted: null, earlier: [], anyFailed: false, submit: { blocking: [], superseded: [], notReviewed: [], eligible: true } });
      const v = /\/view\/([^?]+)/.exec(u);
      if (v) return json(decodeURIComponent(v[1]!) === "t" ? {} : {});
      return json({}, false);
    } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle(); await settle();
  const row = (label: string) => byId("tl").children.find((r) => has(r, "row") && r.textContent.includes(label));
  const go = async (label: string) => {
    /* a file under a closed call header is reached by opening the header first (a click on a header opens or closes it) */
    if (!row(label)) { const h = byId("tl").children.find((r) => has(r, "hdr") && r.attrs["aria-expanded"] === "false"); h?.click(); await settle(); await settle(); }
    const r = row(label); assert.ok(r, `a rail row reads ${label}`); r!.click(); await settle(); await settle();
  };
  const ai = byId("h2");
  /* everything the step's body shows: the AI line, the header's failure line and files, the body, the notes, the panes */
  const shown = () => ["h2", "callfail", "hdrview", "bodyview", "reqtext", "notes", "vb", "va"].map((id) => (byId(id).hidden ? "" : byId(id).textContent)).join(" | ");
  return { byId, go, ai, shown, settle };
}


const LONG = Array.from({ length: 30 }, (_, i) => `step ${i + 1} of the brief`).concat("THE-ENDING line");
const pageModel = (lines: string[]): RailModel => ({ task: 7, folder: "work", actors: [{ id: "claude", name: "Claude", chip: "C", color: "#6fb0e3", main: true }],
  stops: [{ id: "start-1", label: "Started Helper 1", lane: "claude", head: "Started Helper 1 to fetch", brief: { by: "Claude", lines } }] } as unknown as RailModel);

describe("the page paints the brief as text", () => {
  it("a short brief is shown whole under a label that says it is Claude's words", async () => {
    const p = await boot(pageModel(["Fetch UNRATE.", "Save unrate.csv."]));
    await p.go("Started Helper 1");
    const b = p.byId("bodyview");
    assert.equal(b.hidden, false);
    assert.match(b.textContent, /Claude to Helper 1, the brief it gave the helper/);
    const card = b.descendants().find((n) => has(n, "mcard"))!;
    assert.deepEqual(card.children.map((x) => x.textContent), ["Fetch UNRATE.", "Save unrate.csv."]);
  });
  it("a long brief is folded, the first lines and the ending stay, one button opens the middle", async () => {
    const p = await boot(pageModel(LONG));
    await p.go("Started Helper 1");
    const card = p.byId("bodyview").descendants().find((n) => has(n, "mcard"))!;
    const seen = () => card.children.filter((x) => x.tag === "p" && !x.hidden).map((x) => x.textContent);
    assert.ok(seen().includes("step 1 of the brief"));
    assert.ok(seen().includes("THE-ENDING line"), seen().join("|"));
    assert.ok(!seen().includes("step 15 of the brief"));
    const btn = card.children.find((x) => x.tag === "button")!;
    assert.match(btn.textContent, /Show the whole brief/);
    btn.click();
    assert.equal(seen().length, LONG.length);
  });
  it("a brief withheld as secret-looking says that, not that none was recorded", async () => {
    const m = pageModel([]);
    (m.stops[0] as { brief: { withheld?: boolean } }).brief.withheld = true;
    const p = await boot(m);
    await p.go("Started Helper 1");
    assert.match(p.byId("bodyview").textContent, /withheld because it looked like it held a secret/);
    assert.doesNotMatch(p.byId("bodyview").textContent, /No brief was recorded/);
  });
  it("a start with no recorded brief says so plainly", async () => {
    const p = await boot(pageModel([]));
    await p.go("Started Helper 1");
    assert.match(p.byId("bodyview").textContent, /No brief was recorded for this helper\./);
  });
});

describe("an encrypted brief (Codex) is never painted as the agent's words", () => {
  const TOKEN = "gAAAAABq5_3NUG0wSgKuMUeiMpzd-EJbo7QvRrNzPYhcB8EL_8b12MzGEspP-jPxPBxiD5cr02TI2Zx_vK1welX5XfxLSRvQ0T1uqH4JU_JD4jBeAkxctldmHAMqiZZ9yQ0";
  const model = (brief: Record<string, unknown>, head: string): RailModel => ({ task: 7, folder: "work", actors: [{ id: "claude", name: "Codex", chip: "C", color: "#6fb0e3", main: true }],
    stops: [{ id: "start-1", label: "Started Helper 1", lane: "claude", head, brief }] } as unknown as RailModel);
  it("says in one line that the host keeps it encrypted, keeps the title, shows no token", async () => {
    const p = await boot(model({ by: "Codex", lines: [], encrypted: true }, "Started Helper 1: recipe"));
    await p.go("Started Helper 1");
    const b = p.byId("bodyview");
    assert.match(b.textContent, /Codex keeps the brief it gives a helper encrypted, so CoCheck can't show it\./);
    assert.ok(!/gAAAAA|No brief was recorded/.test(b.textContent), b.textContent);
    assert.ok(!/Codex's words/.test(b.textContent), b.textContent);
  });
  it("a plain brief that holds a long token-like word still shows as the agent's words", async () => {
    const line = `Use ${TOKEN} as the label.`;
    const p = await boot(model({ by: "Codex", lines: [line] }, "Started Helper 1: recipe"));
    await p.go("Started Helper 1");
    assert.match(p.byId("bodyview").textContent, /Codex to Helper 1, the brief it gave the helper/);
    assert.ok(p.byId("bodyview").textContent.includes(line));
  });
});
