// A vm page harness: review.js over a small DOM stand-in, with the served /view document supplied by the caller.
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { buildTimeline, type TimelineInput } from "../../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../../src/timeline/rail/model.ts";
import { fixtures } from "../fixtures/timeline.ts";

export class N {
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
export const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

export function changeModel(): { model: RailModel; index: number } {
  const f = fixtures.directWriter!();
  const input: TimelineInput = { taskId: 1, build: "t", ops: f.ops, fileStates: f.fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: true, scriptTexts: new Map() };
  const model = buildRailModel(buildTimeline(input));
  return { model, index: model.stops.findIndex((s) => s.change?.viewUrl) };
}
/** `quietTimers`: the page's own timers are stubbed (never fire), for a served document that is still pending, whose page asks again on a timer. */
export async function drawn(served: unknown, opts: { quietTimers?: boolean } = {}): Promise<{ all: N[]; byId: (id: string) => N; details: () => string }> {
  const { model, index } = changeModel();
  const m = JSON.parse(JSON.stringify(model)) as Record<string, unknown>; m.excel = true;
  const files = ["view-table.js", "files-view.js", "review.js"];
  const src = await Promise.all(files.map((f) => readFile(new URL(`../../src/timeline/rail/assets/${f}`, import.meta.url), "utf8")));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const body = mkNode(); body.getAttribute = (() => "7") as never;
  const created: N[] = [];
  const document = { body, getElementById: byId, createElement: (t: string) => { const n = mkNode(t); created.push(n); return n; }, createElementNS: (_: string, t: string) => { const n = mkNode(t); created.push(n); return n; }, createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [], addEventListener() {}, activeElement: null };
  const json = (v: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(v)) });
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash: `#${index}` }, history: { replaceState() {} }, innerWidth: 1600, URLSearchParams, console, addEventListener() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (u: string) => (u.includes("/review/status") ? json({ stops: {}, passes: { markers: [], tags: {} } }) : u.includes("/review/model") ? json(m) : u.includes("/view/") ? json(served) : json({})) };
  if (opts.quietTimers === true) { g.setTimeout = () => 1; g.clearTimeout = () => {}; }
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  files.forEach((f, k) => vm.runInContext(src[k]!, ctx, { filename: f }));
  for (let k = 0; k < 6; k++) await new Promise((r) => setTimeout(r, 40));
  /** Every note in the Details panel (fix/notes-panel), one per line. */
  const details = (): string => ((g.CoCheckDetails as { entries(): Array<{ text: string }> } | undefined)?.entries() ?? []).map((e) => e.text).join("\n");
  return { all: [...nodes.values(), ...created], byId, details };
}

