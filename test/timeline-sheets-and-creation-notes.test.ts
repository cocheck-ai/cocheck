import { describe, it } from "node:test";
import { writeSealed } from "../src/seal.ts";
import { servedFor } from "./helpers/v1-served.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { zipSync } from "fflate";
import { formatChangesOf } from "../src/timeline/load.ts";
import { createXlsxLayer } from "../src/office/connector/xlsx/layer.ts";
import { createFilesLayer } from "../src/formats/files/layer.ts";
import { moreText, rowNote } from "../src/timeline/notes.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { storeDirOf } from "../src/states.ts";
import type { RawState } from "../src/timeline/runs.ts";
import type { Change, Timeline } from "../src/timeline/timeline.ts";

// A new file is one creation note, a capped list says how many and where, and CoCheck's own grid does not talk about Quick Look.
// Workbooks are built in memory; nothing opens Excel.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const str = (ref: string, t: string): string => `<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;
const num = (ref: string, v: number): string => `<c r="${ref}"><v>${v}</v></c>`;
const row = (r: number, ...cells: string[]): string => `<row r="${r}">${cells.join("")}</row>`;
const dataRows = (header: string, n: number): string => row(1, str("A1", "date"), str("B1", header)) + Array.from({ length: n }, (_, i) => row(i + 2, str(`A${i + 2}`, `d${i}`), num(`B${i + 2}`, i + 1))).join("");

function workbook(sheets: Array<{ name: string; rows: string }>): Buffer {
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": enc(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = enc(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.rows}</sheetData></worksheet>`); });
  return Buffer.from(zipSync(files, { mtime: new Date(2020, 0, 1) }));
}

/** A one-task store holding the given files, and the state row that changes `from` into `to`. */
async function store(from: Buffer | null, to: Buffer, file: string): Promise<{ home: string; s: RawState; stored: Map<string, number>; done: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  await mkdir(storeDirOf(home, 1), { recursive: true });
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const stored = new Map<string, number>();
  for (const b of [from, to]) if (b) { await writeSealed(path.join(storeDirOf(home, 1), sha(b)), b); stored.set(sha(b), b.length); }
  const s = { id: 1, step_id: 1, task_id: 1, file_path: `/w/${file}`, sha256: sha(to), prev_sha256: from ? sha(from) : null, phase: "post", calls_open_json: null, credited_json: null, size: to.length, kept: "whole", note: null, ts: null } as unknown as RawState;
  return { home, s, stored, done: () => rm(home, { recursive: true, force: true }) };
}
const layers = () => [createXlsxLayer({ openState: async () => "closed" }), createFilesLayer()];

describe("a created file reads created", () => {
  it("the layers' own words for a made or removed file give created and deleted, not changed", () => {
    const f = { actor: "Claude", file: "fred/GDP.csv", secret: false, expired: false };
    assert.equal(rowNote(f, { location: "file", kind: "new file", before: null, after: null, text: "new file (1 KB)" }).text, "Claude created GDP.csv in the fred folder");
    assert.equal(rowNote(f, { location: "file", kind: "file deleted", before: null, after: null, text: "x" }).text, "Claude deleted fred/GDP.csv");
  });
});

describe("a capped list says how many more and where", () => {
  it("the sentence", () => {
    assert.equal(moreText(250, [{ place: "GDP", count: 200, from: 35, to: 310 }, { place: "SPX", count: 50, from: 3, to: 3 }]), "250 more changes are not noted, in 'GDP' rows 35 to 310 and 'SPX' row 3.");
    assert.equal(moreText(1, [{ place: null, count: 1, from: null, to: null }]), "1 more change is not noted, in the file.");
  });
  it("the rail model carries the sentence", () => {
    const ref = (sha: string) => ({ sha256: sha, size: 10, kept: "whole" as const, stored: true, why: null, preview: { label: "p", ref: null, missing: null } });
    const change = { id: "c1", file: "b.xlsx", outside: false, at: null, kind: "modified", step: 1, before: ref("a".repeat(64)), after: ref("b".repeat(64)), credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: { module: "xlsx", rows: [], more: 50, moreIn: [{ place: "GDP", count: 50, from: 102, to: 151 }] }, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: "l" } } as unknown as Change;
    const model = JSON.parse(JSON.stringify(buildRailModel(tl(change))));
    assert.equal(model.stops.find((s: { change?: unknown }) => s.change).change.moreNote, "50 more changes are not noted, in 'GDP' rows 102 to 151.");
  });
});

function tl(change: Change): Timeline {
  return { schema: "cocheck.timeline/1", build: "b", task: 7, builtFrom: { highestOpId: 1, highestStateId: 1, valuesExpiredAt: null }, folder: "work", hosts: ["claude"], expired: null, unplaced: [], missing: [], requests: [{
    id: "r0", index: 0, session: "s", texts: [{ text: "Do it", source: "user", label: "what you typed" }], at: null, placement: { kind: "recorded", note: "" }, closing: null, missing: [],
    runs: [{ id: "run", rule: "x", files: [], callCount: 1, failedCount: 0, changedFiles: [], changedAtCall: 1, endedBy: "change", missing: [], calls: [{ id: "call", index: 1, of: 1, host: "claude", tool: "Bash", start: 1, end: null, outcome: "succeeded", closedBy: "post", background: false, onTarget: true, files: [], missing: [], changes: [change], line: { text: "t", source: "agent-description", label: "l" } }] }] }] } as unknown as Timeline;
}


// The review page's own code, run in a DOM stub (as the sheet-tabs test does).
class N {
  attrs: Record<string, string> = {}; children: N[] = []; parentNode: N | null = null; listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = ""; hidden = false; style: Record<string, unknown> = { setProperty() {} }; _text = ""; nodeType = 1;
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  append(...c: N[]) { for (const x of c) { x.parentNode = this; this.children.push(x); } }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
  focus() {} scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(sel: string): N | null { for (let n: N | null = this; n; n = n.parentNode) if (sel === ".vw[hidden]" && n.hidden && n.className.split(/\s+/).includes("vw")) return n; return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
}
const mk = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

async function boot(view: unknown, change: Change) {
  const model = JSON.parse(JSON.stringify(buildRailModel(tl(change))));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mk(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const handlers: Record<string, (e: unknown) => void> = {};
  const body = mk(); body.getAttribute = (() => "7") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mk(t), createElementNS: (_: string, t: string) => mk(t), createTextNode: (t: string) => { const n = mk("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: "#1" }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; }, setInterval, clearInterval, console,
    fetch: async (u: string) => ({ ok: true, status: 200, json: async () => (u.includes("/review/model") ? model : servedFor(view, model, u)) }) };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  // No start stop; the page opens on the change (the first step that needs a verdict), so no key is pressed to reach it.
  return { byId };
}
const cellOf = (ref: string, text: string) => ({ ref, text, value: text, formula: null, numFmt: "General", fill: null, bold: false, box: null });
const pane = (side: string, sheet: string) => ({ id: `${side}:${sheet}`, label: `${sheet}, ${side}`, grid: { sheet, state: "visible", columns: [{ name: "A", width: null, hidden: false }], rows: [{ row: 1, hidden: false, cells: { A: cellOf("A1", `${sheet} ${side}`) } }], merges: [], moreRows: 0 } });
const changeWith = (moreNote: boolean): Change => ({ id: "c1", file: "book.xlsx", outside: false, at: null, kind: "modified", step: 1, before: { sha256: "a".repeat(64), size: 1, kept: "whole", stored: true, why: null, preview: { label: "p", ref: null, missing: null } }, after: { sha256: "b".repeat(64), size: 1, kept: "whole", stored: true, why: null, preview: { label: "p", ref: null, missing: null } }, credit: { calls: ["c"], joint: false, text: "x" }, note: null, format: moreNote ? { module: "xlsx", rows: [], more: 7, moreIn: [{ place: "GDP", count: 7, from: 5, to: 20 }] } : null, alsoNamedBy: [], missing: [], generic: { tier: "fingerprint", label: "l" } }) as unknown as Change;
const gridView = (o: Record<string, unknown>) => ({ change: "c1", file: "book.xlsx", engine: "drawn by CoCheck", kind: "grid", before: [], after: [], boxes: [], caveats: [], ...o });

describe("on the page", () => {
  it("a workbook whose only changes are on added sheets does not say 'nothing here yet' on the before side", async () => {
    const p = await boot(gridView({ after: [pane("after", "SPX"), pane("after", "NDX")], boxes: [{ side: "after", pane: "after:SPX", cell: "A1", change: "c1", confidence: "exact" }] }), changeWith(false));
    const before = p.byId("vb").textContent;
    assert.doesNotMatch(before, /nothing here yet/i);
    assert.match(before, /did not exist yet/);
    // No sheet tabs, the sheets' changes are listed in words
    assert.deepEqual(p.byId("tb").children, []);
  });
});

// One "more changes" figure per stop. The format layer's `more` is the source and the rail model shows it.
describe("one more-changes figure on the rail", () => {
  it("a change set over the caps: the rail sentence carries the format layer's one number", async () => {
    const old = workbook([{ name: "GDP", rows: dataRows("GDP", 150) }]);
    const next = workbook([{ name: "GDP", rows: dataRows("GDP", 150).replace(/<v>(\d+)<\/v>/g, (_, v) => `<v>${Number(v) + 1000}</v>`) }]);
    const st = await store(old, next, "b.xlsx");
    try {
      const out = await formatChangesOf(st.home, 1, st.s, layers(), st.stored, new Set());
      assert.ok("rows" in out);
      const change = { ...changeWith(false), format: out } as unknown as Change;
      const model = JSON.parse(JSON.stringify(buildRailModel(tl(change))));
      const note: string = model.stops.find((s: { change?: unknown }) => s.change).change.moreNote;
      assert.match(note, /^50 more changes/);
    } finally { await st.done(); }
  });
});
