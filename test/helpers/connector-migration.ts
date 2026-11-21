// Shared capture code for the connector migration goldens. Used by test/connector-migration-goldens.test.ts (fast) and
// test/connector-migration-render.slow.test.ts. It only READS today's code paths and the checked-in fixtures; it writes nothing outside
// a temp home it creates.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import vm from "node:vm";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../../src/ledger.ts";
import { tempDirRemovedAtExit } from "./temp-dirs.ts";
import { ensureStoreDir } from "../../src/states.ts";
import { writeSealed } from "../../src/seal.ts";
import { loadTimeline } from "../../src/timeline/load.ts";
import { buildRailModel } from "../../src/timeline/rail/model.ts";
import { createXlsxLayer } from "../../src/office/connector/xlsx/layer.ts";
import { createPptxLayer } from "../../src/office/connector/pptx/layer.ts";
import { createFilesLayer } from "../../src/office/connector/docx/layer.ts";
import type { FormatLayer } from "../../src/formats/layer.ts";
import { PRODUCTION_BUILTIN_CONNECTORS, setBuiltinConnectorsForTest } from "../../src/connector/builtins.ts";
import { settlePendingCaptures } from "../../src/connector/file-capture.ts";
import { readFrozen } from "../../src/connector/frozen.ts";
import { queueOldRows } from "../../src/connector/old-rows.ts";
import { connectorRowDoc } from "../../src/connector/row-doc.ts";
import type { DiffObject } from "../../src/connector/diff-object.ts";
import type { ViewChange } from "../../src/timeline/render/types.ts";
import { served } from "./v1-served.ts";

export const FIX = path.join(import.meta.dirname, "..", "fixtures");
export const GOLD = path.join(FIX, "migration-goldens");
export const readFix = (rel: string): Buffer => readFileSync(path.join(FIX, rel));
export const readGold = <T = unknown>(rel: string): T => JSON.parse(readFileSync(path.join(GOLD, rel), "utf8")) as T;

export type Format = "xlsx" | "docx" | "pptx";
export interface Pair { name: string; format: Format; before: string; after: string }

/** The representative before/after pairs, all already in test/fixtures. */
export const PAIRS: Pair[] = [
  { name: "xlsx-formula-edit", format: "xlsx", before: "formula-edit-before.xlsx", after: "formula-edit-after.xlsx" },
  { name: "xlsx-inserted-row", format: "xlsx", before: "inserted-row-before.xlsx", after: "inserted-row-after.xlsx" },
  { name: "xlsx-value-edit", format: "xlsx", before: "value-edit-before.xlsx", after: "value-edit-after.xlsx" },
  { name: "docx-W1", format: "docx", before: "word-change-first/W1-before.docx", after: "word-change-first/W1-after.docx" },
  { name: "docx-W6", format: "docx", before: "word-change-first/W6-before.docx", after: "word-change-first/W6-after.docx" },
  { name: "docx-W16", format: "docx", before: "word-conditional-format-w16-before.docx", after: "word-conditional-format-w16-after.docx" },
  { name: "pptx-PM", format: "pptx", before: "change-first-deck/PM-before.pptx", after: "change-first-deck/PM-after.pptx" },
  { name: "pptx-PD", format: "pptx", before: "change-first-deck/PD-before.pptx", after: "change-first-deck/PD-after.pptx" },
  { name: "pptx-R9", format: "pptx", before: "change-first-deck/d2.pptx", after: "change-first-deck/R9-after.pptx" },
];

// ---- normalisation -----------------------------------------------------------------------------------------------------------------

/** Keys that hold a wall-clock or clock-derived value: dropped from every captured structure (the record's own times, not the content). */
const TIME_KEYS = new Set(["at", "ts", "mtimeNs", "mtime_ns", "startSeq", "start", "end", "openedAt", "closedAt"]);
const TEMP_PATH = /(?:\/private)?\/var\/folders\/[^\s"'\\]+|\/tmp\/[^\s"'\\]+|[A-Za-z]:[\\/](?:Users|Windows|Temp)[^\s"']*|\/Users\/[^\s"']*\/AppData[^\s"']*/g;

/** POSIX separators, no drive letter, no temp path; time-valued keys dropped. Key order is sorted so a golden does not pin insertion order of a map. */
export function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\\/g, "/").replace(/^[A-Za-z]:(?=\/)/, "").replace(TEMP_PATH, "<tmp>");
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      if (TIME_KEYS.has(k)) continue;
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

/** What a golden must never hold: a temp path, a drive letter, a backslash path, an epoch-millisecond number. Returns the offending text or null. */
export function volatileIn(json: string): string | null {
  const m = json.match(/\/var\/folders\/|\/private\/|\/tmp\/|cocheck-test-|[A-Za-z]:\\\\|"[A-Za-z]:\/|\b1[5-9]\d{11}\b|\b\d{19}\b/);
  return m === null ? null : m[0];
}

// ---- comparison ----------------------------------------------------------------------------------------------------------------------

const BOX_KEYS = new Set(["rect", "highlights", "rects"]);
export const BOX_TOLERANCE_PX = 2;

/**
 * First place `actual` differs from `golden`, or null. Everything is exact (counts, labels, order, ids) except the numbers inside a box rectangle
 * (`rect`, `highlights`), which may differ by `BOX_TOLERANCE_PX`. A moved box, a lost or extra card, a changed label all return a path.
 */
export function firstMismatch(golden: unknown, actual: unknown, where = "$", inBox = false): string | null {
  if (typeof golden === "number" && typeof actual === "number") {
    const ok = inBox ? Math.abs(golden - actual) <= BOX_TOLERANCE_PX : golden === actual;
    return ok ? null : `${where}: ${golden} vs ${actual}`;
  }
  if (Array.isArray(golden) || Array.isArray(actual)) {
    if (!Array.isArray(golden) || !Array.isArray(actual)) return `${where}: array vs non-array`;
    if (golden.length !== actual.length) return `${where}: length ${golden.length} vs ${actual.length}`;
    for (let i = 0; i < golden.length; i++) {
      const r = firstMismatch(golden[i], actual[i], `${where}[${i}]`, inBox);
      if (r !== null) return r;
    }
    return null;
  }
  if (golden !== null && actual !== null && typeof golden === "object" && typeof actual === "object") {
    const gk = Object.keys(golden), ak = Object.keys(actual);
    if (gk.join("\u0000") !== ak.join("\u0000")) return `${where}: keys ${gk.join(",")} vs ${ak.join(",")}`;
    for (const k of gk) {
      const r = firstMismatch((golden as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k], `${where}.${k}`, inBox || BOX_KEYS.has(k));
      if (r !== null) return r;
    }
    return null;
  }
  return golden === actual ? null : `${where}: ${JSON.stringify(golden)} vs ${JSON.stringify(actual)}`;
}

// ---- G1: layer rows --------------------------------------------------------------------------------------------------------------------

function layerFor(format: Format): FormatLayer {
  return format === "xlsx" ? createXlsxLayer({ openState: async () => "closed" }) : format === "pptx" ? createPptxLayer() : createFilesLayer();
}

/** Writes bytes to a temp dir under the file's own extension (layers pick granularity by it), runs `fn`, then removes the dir. */
async function withFiles<T>(ext: string, before: Buffer, after: Buffer, fn: (b: string, a: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-migration-"));
  const [pb, pa] = [path.join(dir, `before${ext}`), path.join(dir, `after${ext}`)];
  await Promise.all([writeFile(pb, before, { mode: 0o600 }), writeFile(pa, after, { mode: 0o600 })]);
  try {
    return await fn(pb, pa);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export async function captureG1(p: Pair): Promise<unknown> {
  const layer = layerFor(p.format);
  const rows = await withFiles(path.extname(p.before), readFix(p.before), readFix(p.after), (b, a) => layer.diff(b, a));
  return normalize({ layer: layer.name, rows: rows.map((r) => ({ ...r, described: layer.describe(r) })) });
}

// ---- G2: renderer views (the captured golden stays as data for the diff tests) ----------------------------

/** One captured view of g2-renderer-views.json. */
export interface ViewCapture { format: Format; engine: string | null; panes: { before: number; after: number }; paneText: { before: string[]; after: string[] }; changes: ViewChange[] | null; boxes: unknown; caveats: string[] }

// ---- G3 / G4: ledger snapshots -> rail model and card markup -----------------------------------------------------------------------------

export interface LedgerSnapshot {
  snapshot: string;
  client: string;
  folder: string;
  /** fixture path (under test/fixtures) by the sha-256 of its bytes: the store's content-addressed copies. */
  blobs: Record<string, string>;
  /** The ledger's file_states in step order, as the ingestion path recorded them. */
  steps: Array<{ seq: number; phase: string; file: string; sha256: string; prevSha256: string | null; size: number; kept: string; callsOpen?: string[]; credited?: string[] }>;
  /** Recorded calls (real hook line shapes from test/fixtures/attribution, clock values replaced by ticks), written through ledger.recordOp before the steps. */
  /** Which pair's bytes the page's view of a file is drawn from (by file name); absent: the `pane` pair. */
  viewPairs?: Record<string, string>;
  ops?: Array<{ tool: string; intent: string; args: Record<string, unknown> }>;
  /** Which pair's saved helper output supplies the pane count of this snapshot's last change. */
  pane: string;
}
export const SNAPSHOTS = ["xlsx-inserted-row", "docx-W1", "pptx-PM", "xlsx-credited"];
export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/**
 * Replays a snapshot through the real ingestion path (a real ledger and sealed store in a temp home) and returns the raw rail model.
 * core reads no Office file, so the replay does what the review process does when a task loads
 * (review-server.ts, queueOldRows then the capture settle): the snapshot's rows, recorded with no connector, are read later by today's built-in
 * connectors (shipped folders; under the test bootstrap Office is never run, so each answer is the change list).
 */
export async function railOf(snap: LedgerSnapshot): Promise<ReturnType<typeof buildRailModel>> {
  return (await replay(snap)).model;
}

export async function replay(snap: LedgerSnapshot): Promise<{ model: ReturnType<typeof buildRailModel>; diffOf: (key: string) => Promise<unknown> }> {
  // Removed at exit, not here: the returned diffOf still reads the home after replay returns.
  const home = tempDirRemovedAtExit("cocheck-migration-home-");
  const ledger = openLedger(home);
  setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
  try {
    const id = ledger.openTask(snap.client);
    const states = await ensureStoreDir(home, id);
    await mkdir(path.join(home, "tasks", String(id)), { recursive: true });
    await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: snap.folder }));
    for (const [sha, rel] of Object.entries(snap.blobs)) {
      const bytes = readFix(rel);
      if (sha256(bytes) !== sha) throw new Error(`snapshot ${snap.snapshot}: ${rel} no longer has sha ${sha}`);
      await writeSealed(path.join(states, sha), bytes);
    }
    for (const o of snap.ops ?? []) ledger.recordOp({ taskId: id, tool: o.tool, args: o.args, intent: o.intent, clientName: snap.client, durationMs: 1, resultCode: "OK" });
    for (const s of snap.steps) {
      // the ledger stamps each step with the wall clock and the timeline orders unplaced changes by it: a 3 ms gap keeps the stamps strictly increasing, so the order is the snapshot's
      await new Promise((r) => setTimeout(r, 3));
      ledger.recordStep({ taskId: id, client: snap.client, seq: s.seq, phase: s.phase as "Post", callsOpen: s.callsOpen ?? [], credited: s.credited ?? [], files: [{ filePath: `${snap.folder}/${s.file}`, sha256: s.sha256, prevSha256: s.prevSha256, size: s.size, kept: s.kept as "whole", note: "" }] });
    }
    queueOldRows(ledger, home, id);
    await settlePendingCaptures(ledger, home, id, 60_000);
    const { timeline } = await loadTimeline(ledger, home, id, { build: "t", quickLook: false, render: async () => null });
    const changes = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))];
    const diffOf = async (key: string): Promise<unknown> => {
      const d = (changes.find((c) => c.id === key) as { diff?: DiffObject } | undefined)?.diff;
      return d === undefined ? undefined : connectorRowDoc(d, { before: null, after: null, readFrozen: (ref) => readFrozen(home, id, ref) });
    };
    return { model: buildRailModel(timeline), diffOf };
  } finally {
    setBuiltinConnectorsForTest(undefined);
    ledger.close();
  }
}

export const readSnapshot = (name: string): LedgerSnapshot => readGold<LedgerSnapshot>(`ledger-snapshots/${name}.json`);

/** G3: the rail model of the snapshot, timestamps and temp paths stripped. */
export async function captureG3(name: string): Promise<unknown> {
  return normalize(await railOf(readSnapshot(name)));
}

// ---- G4: the page's own output ------------------------------------------------------------------------------------------------------

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
  focus() {}
  scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest(): N | null { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

export interface PageStep { index: number; heading: string; panes: { before: number; after: number }; cards: string[]; bodyCards: string[]; buttons: Array<{ side: string; label: string }> }

/**
 * Boots the REAL src/timeline/rail/assets/review.js (with view-table.js and files-view.js) in a vm over a small DOM stand-in (pattern of
 * test/follow-link.test.ts and test/timeline-hwho-label.test.ts, no new dependency), feeds it the rail model and returns what it drew for
 * each change stop: heading, pane tabs, note cards and the open-in-app buttons. The model's `excel` flag is the server's "Excel is installed" answer:
 * pinned true here so the Excel button is part of what the page draws.
 */
export async function pageOf(model: unknown, views: (change: string, file: string) => Promise<unknown>, patch?: (file: string, source: string) => string): Promise<PageStep[]> {
  const m = JSON.parse(JSON.stringify(model)) as { stops: Array<{ id: string; change?: unknown }>; excel?: boolean };
  m.excel = true;
  const src = await Promise.all(["view-table.js", "files-view.js", "review.js"].map(async (f) => { const t = await readFile(new URL(`../../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"); return patch === undefined ? t : patch(f, t); }));
  const out: PageStep[] = [];
  // one page boot per change stop, landing on it by its hash (the page's own deep link), so no step carries state into the next
  for (let i = 0; i < m.stops.length; i++) {
    if (m.stops[i]!.change === undefined) continue;
    const nodes = new Map<string, N>();
    const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
    const body = mkNode(); body.getAttribute = (() => "7") as never;
    const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [], addEventListener() {}, activeElement: null };
    const json = (v: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(v)) });
    const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: `#${i}` }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console,
      addEventListener() {}, setInterval: () => 1, clearInterval() {},
      fetch: async (u: string) => {
        if (u.includes("/review/status")) return json({ stops: {}, passes: { markers: [], tags: {} } });
        if (u.includes("/review/model")) return json(m);
        const key = /\/view\/([^/?]+)/.exec(u)?.[1];
        if (key === undefined) return json({});
        const file = m.stops.map((x) => x.change as { key?: string; file?: string } | undefined).find((c) => c?.key === decodeURIComponent(key))?.file ?? "";
        return json(await views(decodeURIComponent(key), file));
      } };
    g.window = g; g.globalThis = g;
    const ctx = vm.createContext(g);
    ["view-table.js", "files-view.js", "review.js"].forEach((f, k) => vm.runInContext(src[k]!, ctx, { filename: f }));
    for (let k = 0; k < 4; k++) await new Promise((r) => setTimeout(r, 40));
    const all = (n: N): N[] => [n, ...n.descendants()];
    const has = (n: N, c: string): boolean => n.className.split(/\s+/).includes(c);
    out.push({
      index: i, heading: byId("h1").textContent,
      panes: { before: all(byId("tb")).filter((n) => n.tag === "button").length, after: all(byId("ta")).filter((n) => n.tag === "button").length },
      cards: all(byId("notes")).filter((n) => has(n, "note")).map((n) => n.textContent),
      // a level-1 connector document is drawn as change cards in the body view (review.js drawCardList), not as note cards
      bodyCards: all(byId("bodyview")).filter((n) => has(n, "cvcard") && !has(n, "child")).map((n) => n.textContent),
      buttons: byId("openxl").hidden ? [] : all(byId("openxl")).filter((n) => n.tag === "button").map((n) => ({ side: n.attrs["data-side"] ?? "", label: n.textContent })),
    });
  }
  return out;
}

/** G4: what the page (review.js) draws for each change of the snapshot: pane tabs, note-card text and the open-in-app buttons, plus the model's change fields. */
export async function captureG4(name: string, patch?: (file: string, source: string) => string): Promise<unknown> {
  const snap = readSnapshot(name);
  const { model, diffOf } = await replay(snap);
  // every Office step is a connector row (read later), served as the connector's document the way the /view route serves it
  // (connectorRowDoc); the page reads that v1 document
  const page = await pageOf(model, async (key) => (await diffOf(key)) ?? served({}, model.stops.map((st) => st.change).find((c) => c?.key === key)), patch);
  return normalize({
    snapshot: name,
    page,
    changes: model.stops.flatMap((s) => (s.change === undefined ? [] : [s.change])).map((c) => ({
      file: c.file, kind: c.kind, note: c.note,
      rowNotes: c.rowNotes.map((r) => r.location),
      viewUrl: c.viewUrl,
    })),
  });
}
