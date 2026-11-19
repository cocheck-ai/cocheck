import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel, type RailModel } from "../src/timeline/rail/model.ts";
import { scriptReads } from "../src/timeline/read-signal.ts";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { call, prompt, state, stop } from "./fixtures/timeline.ts";

// "Built from" links per version. The shapes are a recorded Claude run's: the data files made by
// shell calls, build_workbook.py made by a Write call whose content the ledger does not keep (the label holds only file_path), and
// `python3 build_workbook.py && which soffice ...` building the workbook. The script's text is not in the record (only its stored bytes are, which the
// snapshot lacks), so the text below is a reconstruction in the forms named above, not a copy.

const W = "/Users/user/Desktop/quarterly-report/";
const D = W + "claude/";
const sha = (c: string): string => c.repeat(64);
const label = (file: string) => ({ toolLabel: { fields: { file_path: file } } });
const RUN = 'python3 build_workbook.py && which soffice libreoffice 2>/dev/null; ls /Applications | grep -i -E "libre|excel|numbers"';

// the recorded run's real build_workbook.py (the Claude run), verbatim: paths built as `ROOT / "data/nwunemp.csv"`, passed to load(), and the workbook saved through `OUT`.
const SCRIPT_V1 = readFileSync(new URL("./fixtures/build-econ-workbook.py.txt", import.meta.url), "utf8");

function fixture(extra: { readCall?: boolean } = {}): RailModel {
  const c = (id: string, at: number, cmd: string, o: Record<string, unknown> = {}, named: string[] = []) => call(id, { at, end: at + 4, cmd, named, extra: { startSeq: at, ...o } });
  const ops = [
    c("u1", 10, "curl -sL https://nwdata.example/NWUNEMP -o data/nwunemp.csv"),
    c("p1", 12, "curl -sL https://nwdata.example/NWCPI -o data/cpi.csv"),
    c("o1", 14, "echo old > data/old.csv"),
    ...(extra.readCall ? [call("rd", { tool: "Read", at: 28, end: 29, cmd: "Read", extra: { startSeq: 28, ...label(D + "data/cpi.csv") } })] : []),
    call("w1", { tool: "Write", at: 30, end: 33, cmd: "Write", extra: { startSeq: 30, ...label(D + "build_workbook.py") } }),
    c("r1", 40, RUN),
    c("p2", 50, "sed -i '' '1s/.*/date,NWCPI/' data/cpi.csv"),
    c("r2", 60, RUN),
    prompt("s1", ["Build the workbook."], { requests: [{ seq: 1, at: 5, firstStep: null }] }),
    stop("s1", "done"),
  ];
  const f = (file: string, now: string, prev: string | null, by: string) => state(D + file, sha(now), prev === null ? null : sha(prev), { open: [by], credited: [by] });
  const fileStates = [
    f("data/nwunemp.csv", "a", null, "u1"),
    f("data/cpi.csv", "b", null, "p1"),
    f("data/old.csv", "c", null, "o1"),
    f("build_workbook.py", "d", null, "w1"),
    f("econ_data_unemployment_cpi.xlsx", "e", null, "r1"),
    f("data/cpi.csv", "f", "b", "p2"),
    f("econ_data_unemployment_cpi.xlsx", "g", "e", "r2"),
    f("data/audit.csv", "h", null, "r1"),
  ];
  const input: TimelineInput = { taskId: 5, build: "t", ops, fileStates, folder: W.replace(/\/$/, ""), valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, scriptTexts: new Map([[sha("d"), SCRIPT_V1]]) };
  return buildRailModel(buildTimeline(input));
}

const named = (m: RailModel, file: string) => m.files.find((x) => x.file.endsWith(file))!;
const inputsOf = (m: RailModel, file: string, vi: number) => (named(m, file).versions[vi]!.inputs ?? []).map((i) => ({ name: m.files[i.file]!.file.replace(/^claude\//, ""), p: i.p, why: i.why }));

describe("the script's read forms", () => {
  it("lists read_csv, read_excel, load_workbook, open() read modes and csv.reader(open())", () => {
    const text = `import pandas as pd, csv
a = pd.read_csv("in/a.csv")
b = pd.read_excel('in/b.xlsx', sheet_name="S")
wb = openpyxl.load_workbook("in/c.xlsx")
f = open("in/d.txt")
g = open("in/e.txt", "rb")
r = csv.reader(open("in/f.csv", newline=""))
NAME = "in/g.csv"
h = open(NAME, "r")
`;
    for (const p of ["in/a.csv", "in/b.xlsx", "in/c.xlsx", "in/d.txt", "in/e.txt", "in/f.csv", "in/g.csv"]) assert.ok(scriptReads(text).includes(p), p);
  });

  it("the recorded run's real script: nwunemp.csv and cpi.csv are reads (inside ROOT / \"x\" and as load() arguments); the workbook saved through OUT is not", () => {
    const reads = scriptReads(SCRIPT_V1);
    assert.ok(reads.includes("data/nwunemp.csv") && reads.includes("data/cpi.csv"));
    assert.ok(!reads.includes("econ_data_unemployment_cpi.xlsx"));
  });

  it("a name assigned a path counts by its uses: written only is no read, any other use is", () => {
    assert.deepEqual(scriptReads('OUT = ROOT / "o.xlsx"\nwb.save(OUT)\nprint(f"wrote {OUT}")\n'), []);
    assert.deepEqual(scriptReads('P = os.path.join(ROOT, "in.csv")\nrows = load(P)\n'), ["in.csv"]);
    assert.deepEqual(scriptReads('P = "both.csv"\ndf.to_csv(P)\ndf2 = read(P)\n'), ["both.csv"]);
  });

  it("never lists a file only written or only mentioned in a comment", () => {
    const text = `# reads data/old.csv
df.to_csv("out/a.csv")
wb.save("out/b.xlsx")
open("out/c.txt", "w").write("x")
open("out/d.txt", mode="a")
open("out/e.txt", "wb")
open("out/f.txt", "x")
note = "see data/old.csv"
`;
    assert.deepEqual(scriptReads(text), []);
  });
});

describe("built-from links in the model", () => {
  it("recorded run: build_workbook.py reads nwunemp.csv and cpi.csv, each pinned to its latest version when the build ran, named in the script", () => {
    const m = fixture();
    assert.deepEqual(inputsOf(m, "econ_data_unemployment_cpi.xlsx", 0), [{ name: "data/nwunemp.csv", p: 1, why: "script" }, { name: "data/cpi.csv", p: 1, why: "script" }, { name: "build_workbook.py", p: 1, why: "script" }]);
    // the second build ran after cpi.csv changed again, so it pins cpi.csv v2
    assert.deepEqual(inputsOf(m, "econ_data_unemployment_cpi.xlsx", 1), [{ name: "data/nwunemp.csv", p: 1, why: "script" }, { name: "data/cpi.csv", p: 2, why: "script" }, { name: "build_workbook.py", p: 1, why: "script" }]);
  });

  it("a file the script only writes (to_csv, save, open w) or only mentions in a comment is never an input", () => {
    const m = fixture();
    for (let vi = 0; vi < 2; vi++) {
      const names = inputsOf(m, "econ_data_unemployment_cpi.xlsx", vi).map((i) => i.name);
      assert.ok(!names.includes("data/old.csv"), "old.csv appears only in a comment");
      assert.ok(!names.includes("data/audit.csv"), "audit.csv is only written");
      assert.ok(!names.includes("econ_data_unemployment_cpi.xlsx"), "the workbook the script saves is not its own input");
    }
  });

  it("a Read tool call's path is looked at, never an input; a version with no reads carries no inputs", () => {
    const m = fixture({ readCall: true });
    assert.equal(named(m, "data/nwunemp.csv").versions[0]!.inputs, undefined);
    const script = named(m, "build_workbook.py").versions[0]!;
    assert.equal(script.inputs, undefined);
    assert.deepEqual((script.looked ?? []).map((i) => ({ name: m.files[i.file]!.file, p: i.p })), [{ name: "claude/data/cpi.csv", p: 1 }]);
    assert.equal(script.stale, undefined);
  });

  it("a file the task found already there pins to Before task (0); a file made later than the call is no input", () => {
    const c = (id: string, at: number, cmd: string) => call(id, { at, end: at + 4, cmd, extra: { startSeq: at } });
    const ops = [c("m1", 10, 'python3 -c "import csv; open(\'in.csv\')" > out.txt'), c("m2", 20, "echo x > in.csv"), prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1")];
    const fileStates = [state("/w/out.txt", sha("a"), null, { open: ["m1"], credited: ["m1"] }), state("/w/in.csv", sha("b"), sha("z"), { open: ["m2"], credited: ["m2"] })];
    const input: TimelineInput = { taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
    const m = buildRailModel(buildTimeline(input));
    const out = m.files.find((f) => f.file === "out.txt")!;
    assert.deepEqual((out.versions[0]!.inputs ?? []).map((i) => [m.files[i.file]!.file, i.p]), [["in.csv", 0]]);
  });
});

describe("a file the producing call writes is never its input", () => {
  it("scriptReads: Path(..).write_text, Path(..).open('w'), a name assigned then written, pd.ExcelWriter", () => {
    assert.deepEqual(scriptReads('Path("out.csv").write_text("x")\n'), []);
    assert.deepEqual(scriptReads('Path("o.csv").open("w")\n'), []);
    assert.deepEqual(scriptReads('p = Path("o.csv"); p.write_text("x")\n'), []);
    assert.deepEqual(scriptReads('w = pd.ExcelWriter("o.xlsx")\ndf.to_excel(w)\n'), []);
    assert.deepEqual(scriptReads('Path("in.csv").read_text()\n'), ["in.csv"]);
  });

  // a version made by a call that also names the file (any signal) never lists it, whatever the script's write form
  const writeForm = (script: string) => {
    const c = (id: string, at: number, cmd: string) => call(id, { at, end: at + 4, cmd, extra: { startSeq: at } });
    const ops = [c("a1", 10, "echo in > in.csv"), c("m1", 20, `python3 - <<'EOF'\n${script}\nEOF`), prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1")];
    const fileStates = [state("/w/in.csv", sha("a"), null, { open: ["a1"], credited: ["a1"] }), state("/w/o.csv", sha("b"), null, { open: ["m1"], credited: ["m1"] })];
    const input: TimelineInput = { taskId: 1, build: "t", ops, fileStates, folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
    const m = buildRailModel(buildTimeline(input));
    return (m.files.find((f) => f.file === "o.csv")!.versions[0]!.inputs ?? []).map((i) => m.files[i.file]!.file);
  };
  for (const [name, script] of [
    ["Path(..).write_text", 'import pandas\nx = open("in.csv").read()\nprint(x)\nPath("o.csv").write_text(x)'],
    ["Path(..).open('w')", 'x = open("in.csv").read()\nprint(x)\nPath("o.csv").open("w")'],
    ["a name assigned then written", 'x = open("in.csv").read()\nprint(x)\np = Path("o.csv"); p.write_text(x)'],
    ["pd.ExcelWriter", 'x = open("in.csv").read()\nprint(x)\nw = pd.ExcelWriter("o.csv")\ndf.to_excel(w)'],
  ] as const) it(`${name}: in.csv is an input, o.csv is not`, () => assert.deepEqual(writeForm(script), ["in.csv"]));

  it("recorded run: the cp of the workbook after the script rewrote it is not an input, so v2 and v3 never list the workbook", () => {
    const CP = "python3 build_workbook.py && cp econ_data_unemployment_cpi.xlsx /tmp/s/v.xlsx && which soffice";
    const c = (id: string, at: number, cmd: string) => call(id, { at, end: at + 4, cmd, extra: { startSeq: at } });
    const ops = [c("u1", 10, "curl -sL https://nwdata.example/NWUNEMP -o data/nwunemp.csv"), c("p1", 12, "curl -sL https://nwdata.example/NWCPI -o data/cpi.csv"),
      call("w1", { tool: "Write", at: 30, end: 33, cmd: "Write", extra: { startSeq: 30, ...label(D + "build_workbook.py") } }),
      c("r1", 40, CP), c("r2", 60, CP), c("r3", 80, CP), prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1")];
    const f = (file: string, now: string, prev: string | null, by: string) => state(D + file, sha(now), prev === null ? null : sha(prev), { open: [by], credited: [by] });
    const fileStates = [f("data/nwunemp.csv", "a", null, "u1"), f("data/cpi.csv", "b", null, "p1"), f("build_workbook.py", "d", null, "w1"),
      f("econ_data_unemployment_cpi.xlsx", "e", null, "r1"), f("econ_data_unemployment_cpi.xlsx", "g", "e", "r2"), f("econ_data_unemployment_cpi.xlsx", "i", "g", "r3")];
    const input: TimelineInput = { taskId: 5, build: "t", ops, fileStates, folder: W.replace(/\/$/, ""), valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, scriptTexts: new Map([[sha("d"), SCRIPT_V1]]) };
    const m = buildRailModel(buildTimeline(input));
    assert.deepEqual(inputsOf(m, "econ_data_unemployment_cpi.xlsx", 0).map((i) => i.name), ["data/nwunemp.csv", "data/cpi.csv", "build_workbook.py"]);
    for (const vi of [1, 2]) assert.ok(!inputsOf(m, "econ_data_unemployment_cpi.xlsx", vi).some((i) => i.name.endsWith(".xlsx")), `v${vi + 1} lists the workbook`);
  });

  it("the script that ran is an input pinned at-or-before the call opened: a version whose time equals the call's start is pinned", () => {
    const c = (id: string, at: number, cmd: string) => call(id, { at, end: at + 4, cmd, extra: { startSeq: at } });
    const ops = [call("w1", { tool: "Write", at: 30, end: 33, cmd: "Write", extra: { startSeq: 30, ...label(D + "tool.py") } }), c("r1", 40, "python3 tool.py"), prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1")];
    const st = (file: string, now: string, by: string, at: number) => state(D + file, sha(now), null, { open: [by], credited: [by], at } as never);
    const fileStates = [st("tool.py", "d", "w1", 40), st("out.txt", "e", "r1", 44)];
    const input: TimelineInput = { taskId: 5, build: "t", ops, fileStates, folder: W.replace(/\/$/, ""), valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false };
    const m = buildRailModel(buildTimeline(input));
    assert.deepEqual(inputsOf(m, "out.txt", 0), [{ name: "tool.py", p: 1, why: "script" }]);
  });
});

// The page: clicking an input opens that file at that version, a breadcrumb records the path, Escape steps back out.
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
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, preventDefault() {}, target: this })); }
  focus() {}
  scrollIntoView() {}
  get classList() { const s = this; return { toggle: () => false, add: (c: string) => { s.className += " " + c; }, remove() {}, contains: (c: string) => s.className.split(/\s+/).includes(c) }; }
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, height: 0, width: 0, bottom: 0 }; }
  descendants(): N[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}
const mkNode = (tag = "div"): N => new Proxy(new N(tag), { get: (t, k) => (k in t ? (t as unknown as Record<string | symbol, unknown>)[k] : undefined), set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });

async function boot(hash: string) {
  const model = JSON.parse(JSON.stringify(fixture()));
  const nodes = new Map<string, N>();
  const byId = (id: string): N => { if (!nodes.has(id)) { const n = mkNode(); n.attrs.id = id; nodes.set(id, n); } return nodes.get(id)!; };
  const body = mkNode(); body.getAttribute = (() => "1") as never;
  const document = { body, getElementById: byId, createElement: (t: string) => mkNode(t), createElementNS: (_: string, t: string) => mkNode(t), createTextNode: (t: string) => { const n = mkNode("#text"); n._text = t; n.nodeType = 3; return n; }, querySelectorAll: () => [] };
  const spy = { hashes: [] as string[], views: [] as string[], intervals: [] as unknown[] };
  const handlers: Record<string, (e: unknown) => void> = {};
  const g: Record<string, unknown> = { document, location: { search: "?t=tok", hash }, history: { replaceState(_a: unknown, _b: unknown, h: string) { spy.hashes.push(h); } }, innerWidth: 1600, URLSearchParams, console,
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; },
    setInterval: (f: () => void, ms: number) => { const id = setInterval(f, ms); spy.intervals.push(id); return id; }, clearInterval,
    fetch: async (u: string) => {
      if (u.includes("/review/model")) return { ok: true, status: 200, json: async () => model };
      if (u.includes("/view/")) { spy.views.push(decodeURIComponent(u.split("/view/")[1]!.split("?")[0]!)); return { ok: true, status: 200, json: async () => ({ change: "c", file: "f", engine: "drawn by CoCheck", kind: "grid", before: [], after: [], boxes: [], caveats: [] }) }; }
      return { ok: false, status: 404, json: async () => ({}) };
    } };
  g.window = g; g.globalThis = g;
  const ctx = vm.createContext(g);
  for (const f of ["view-table.js", "files-view.js", "review.js"]) vm.runInContext(await readFile(new URL(`../src/timeline/rail/assets/${f}`, import.meta.url), "utf8"), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 30));
  return { byId, spy, model: model as RailModel, handlers, cleanup: () => spy.intervals.forEach((i) => clearInterval(i as never)), settle: () => new Promise((r) => setTimeout(r, 30)) };
}

describe("the page", () => {
  it("lists a version's inputs, opens one at its version with a breadcrumb, and Escape steps back out", async () => {
    const hold = JSON.parse(JSON.stringify(fixture())) as RailModel;
    const xi = hold.files.findIndex((f) => f.file.endsWith(".xlsx"));
    const p = await boot(`#v=files&f=${encodeURIComponent(hold.files[xi]!.file)}&p=2`);
    try {
      const link = () => p.byId("fvbuilt").descendants().filter((n) => n.tag === "button");
      const names = link().map((b) => b.textContent);
      assert.equal(names.length, 3);
      assert.match(names.join("|"), /nwunemp\.csv/);
      assert.match(names.join("|"), /cpi\.csv.*v2/);
      assert.match(p.byId("fvbuilt").textContent, /named in the script/);
      assert.doesNotMatch(p.byId("fvbuilt").textContent, /inferred/);
      const cpi = link().find((b) => /cpi\.csv/.test(b.textContent))!;
      cpi.click();
      await p.settle();
      assert.match(p.byId("fvname").textContent, /cpi\.csv/);
      assert.equal(p.spy.hashes.at(-1), `#v=files&f=${encodeURIComponent(hold.files.find((f) => f.file.endsWith("cpi.csv"))!.file)}&p=2`);
      assert.match(p.byId("fvcrumbs").textContent, /xlsx/, "the breadcrumb names where it came from");
      p.handlers.keydown!({ key: "Escape", target: { tagName: "BODY" }, preventDefault() {} });
      await p.settle();
      assert.match(p.byId("fvname").textContent, /xlsx/);
      assert.equal(p.byId("fvcrumbs").textContent, "");
      assert.equal(p.spy.hashes.at(-1), `#v=files&f=${encodeURIComponent(hold.files[xi]!.file)}&p=2`);
    } finally { p.cleanup(); }
  });
});
