// The in-process conformance runner. `runCases({ dir, casesDir })` runs the cases (public-kit/conformance/cases)
// against the connector in `dir`, through runner.ts (the child process) and schema.ts (the answer shape), and returns one { id, pass, reason? } per case.
// A connector answers cocheck.changes/1 and is graded per level by `gradeLevel` below (the level its hello declares, else the highest). A call that fails is a failed
// case (a false clean must never pass): only C12 treats a structured error as the pass.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ownNode, requireRun } from "./run-argv.ts";
import { startConnector, type ConnectorHandle } from "./runner.ts";
import { checkChanges, ISSUE_CHARS, ISSUES_SHOWN, issuesOf, SYSTEM_OF_TYPE } from "./changes-v1.ts";
import { decodePng, sameRegion, sameRegionAt, type Pixels } from "./png-pixels.ts";
import { checkManifest, EXPORT_METHOD, MANIFEST_FILE, MANIFEST_SPEC, type Problem } from "./schema.ts";

export interface CaseResult { id: string; pass: boolean; reason?: string }
interface RunCasesOptions { dir: string; casesDir: string }
export { EXPORT_METHOD };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// ---- canonical form -------------------------------------------------------------------------------------------------------------------

const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : isObj(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) : v);
/** Canonical text of an answer: keys sorted, no whitespace, no OS-dependent field. */
export const canonical = (v: unknown): string => JSON.stringify(sorted(v));
export const hashOf = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("hex");

// ---- the checks of each level of a cocheck.changes/1 answer ----------------------------------------------------------------------
//
// Level 1 and 2 (a change list, then pictures): the document is valid at the declared level (checkChanges) and the same pair answered again gives an identical document.
// Level 3 adds: every box resolves in its picture's system, and a box over identical before and after pixels is demoted. These are exactly the checks; nothing else is graded.

export type Level = 1 | 2 | 3;
/** The level a connector declares in hello, or undefined (none declared, or a value that is not 1, 2 or 3). Read with brackets: the field is named in public-kit/spec/v1.md. */
export const helloLevel = (hello: Obj): Level | undefined => (hello["level"] === 1 || hello["level"] === 2 || hello["level"] === 3 ? hello["level"] : undefined);

export const DEMOTED = "this box may not point at a real change";

interface LevelContext {
  /** The level the connector declares in hello. */
  level: Level;
  /** The text of the two state files the pair was answered from: a text picture is resolved against its side's file. */
  beforeText: string;
  afterText: string;
  /** The folder a relative picture `src` is read from (the connector's own folder). */
  dir: string;
  /** The connector's hello declares `nothingChanged: true` (its empty list means "saved again, nothing changed"). */
  nothingChanged?: boolean;
}
interface LevelReport {
  /** The highest level whose checks all hold, 0 when level 1 does not. */
  passed: 0 | 1 | 2 | 3;
  failures: string[];
  /** Printed, never graded: what could not be checked. */
  warnings: string[];
  /** The level the document actually holds (boxes: 3, pictures: 2, else 1), whatever the connector declared. */
  reached: Level;
}

const splitLines = (t: string): string[] => {
  if (t === "") return [];
  const lines = t.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};
const colOf = (letters: string): number => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const cellOf = (ref: string): { col: number; row: number } | undefined => {
  const m = /^([A-Za-z]{1,3})([1-9]\d*)$/.exec(ref);
  return m === null ? undefined : { col: colOf(m[1]!), row: Number(m[2]) };
};

const readPicture = (dir: string, src: unknown): Pixels | undefined => {
  if (typeof src !== "string" || src === "") return undefined;
  try {
    const m = /^data:image\/png;base64,(.*)$/s.exec(src);
    return decodePng(m !== null ? Buffer.from(m[1]!, "base64") : readFileSync(path.resolve(dir, src)));
  } catch {
    return undefined;
  }
};

/** Where a box of a level-3 document points: a failure text when it does not resolve in its picture's system, and the pixel rectangles it covers (for the demotion check). */
function resolveBox(b: Obj, pic: Obj, ctx: LevelContext): { problem?: string; rects: Array<{ x: number; y: number; w: number; h: number }> } {
  const sys = SYSTEM_OF_TYPE[String(pic.type)] ?? "none";
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (sys === "pixels") {
    const w = pic.width, h = pic.height;
    if (typeof w !== "number" || typeof h !== "number") return { problem: "the picture has no width and height, so the box cannot be placed on it", rects };
    const list = [...(isObj(b.rect) ? [b.rect] : []), ...(Array.isArray(b.highlights) ? b.highlights.filter(isObj) : [])] as Array<{ x: number; y: number; w: number; h: number }>;
    for (const r of list) {
      if (r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0 || r.x + r.w > w + 1e-6 || r.y + r.h > h + 1e-6) return { problem: `the rect {x ${r.x}, y ${r.y}, w ${r.w}, h ${r.h}} is not inside the picture (${w} by ${h})`, rects };
      rects.push(r);
    }
  } else if (sys === "cells") {
    const rows = pic.rows, cols = pic.cols;
    if (typeof rows !== "number" || typeof cols !== "number") return { problem: "the grid picture has no rows and cols, so the cell cannot be placed in it", rects };
    for (const ref of String(b.cell).split(":")) {
      const c = cellOf(ref);
      if (c === undefined || c.col > cols || c.row > rows) return { problem: `the cell ${String(b.cell)} is not inside the grid (${cols} columns by ${rows} rows)`, rects };
    }
  } else if (sys === "text") {
    const lines = splitLines(pic.side === "before" ? ctx.beforeText : ctx.afterText);
    if (isObj(b.lines)) {
      const from = b.lines.from as number, to = b.lines.to as number;
      if (to > lines.length) return { problem: `lines ${from} to ${to} are not inside the text (${lines.length} lines)`, rects };
    }
    if (isObj(b.range)) {
      const { line, end } = b.range as { line: number; end: number };
      if (line > lines.length) return { problem: `line ${line} is not inside the text (${lines.length} lines)`, rects };
      if (end > lines[line - 1]!.length) return { problem: `the range ends at ${end} but line ${line} has ${lines[line - 1]!.length} characters`, rects };
    }
  }
  return { rects };
}

/** Grades the runs of one pair against the declared level. `answers` holds the same pair answered once per run (at least two). */
export function gradeLevel(answers: unknown[], ctx: LevelContext): LevelReport {
  const failures: string[] = [];
  const warnings: string[] = [];
  const doc = answers[0];
  // level 1 and 2: valid at the declared level
  for (const p of checkChanges(doc, ctx.level)) failures.push(`${p.field === "" ? "document" : p.field}: expected ${p.expected}, found ${p.found}`);
  // The level is the connector's own (its hello); what the document holds is judged below (`reached`).
  const picList = isObj(doc) && Array.isArray(doc.pictures) ? doc.pictures : [];
  const hasBoxes = isObj(doc) && Array.isArray(doc.changes) && (doc.changes as Obj[]).some((c) => isObj(c) && Array.isArray(c.boxes) && c.boxes.length > 0);
  const reached: Level = hasBoxes ? 3 : picList.length > 0 ? 2 : 1;
  if (reached > ctx.level) failures.push(`level: the connector declares level ${ctx.level} but the document holds ${reached === 3 ? "boxes" : "pictures"}, which is level ${reached}`);
  // level 1 and 2: the same pair twice gives an identical document
  if (answers.length < 2) failures.push("no second run given");
  for (let i = 1; i < answers.length; i++) if (canonical(answers[i]) !== canonical(doc)) { failures.push("a second run of the same pair gave a different document"); break; }
  const base = failures.length;
  // v1.2, how the optional fields degrade on the page: printed, never graded (an optional field never fails a connector)
  const issues = issuesOf(doc);
  if (issues.length > ISSUES_SHOWN) warnings.push(`issues: ${issues.length} issues, the page shows the first ${ISSUES_SHOWN} and "and ${issues.length - ISSUES_SHOWN} more"`);
  const long = issues.filter((x) => x.text.length > ISSUE_CHARS).length;
  if (long > 0) warnings.push(`issues: ${long} issue text${long === 1 ? " is" : "s are"} over ${ISSUE_CHARS} characters, the page cuts ${long === 1 ? "it" : "them"} there`);
  // the nothing-changed rule: an empty list says the two states match in everything the connector sees, and the page says "saved again, nothing changed"
  if (ctx.nothingChanged === true && isObj(doc) && Array.isArray(doc.changes) && doc.changes.length === 0 && doc.status === undefined && doc.pendingRetry === undefined && ctx.beforeText !== ctx.afterText) warnings.push(`changes: empty for two state files that differ, so the page will say nothing changed; list one "described" change for any difference you do not model`);
  // level 3: boxes resolve, and a box over unchanged pixels is demoted
  if (ctx.level === 3 && isObj(doc) && Array.isArray(doc.changes) && failures.length === 0) {
    const pics = new Map((Array.isArray(doc.pictures) ? doc.pictures.filter(isObj) : []).map((p) => [String(p.id), p] as const));
    const decoded = new Map<string, Pixels | undefined>();
    const pixels = (p: Obj): Pixels | undefined => {
      const id = String(p.id);
      if (!decoded.has(id)) decoded.set(id, readPicture(ctx.dir, p.src));
      return decoded.get(id);
    };
    (doc.changes as Obj[]).forEach((ch, i) => {
      (Array.isArray(ch.boxes) ? (ch.boxes as Obj[]) : []).forEach((b, j) => {
        const where = `changes[${i}].boxes[${j}]`;
        const pic = pics.get(String(b.picture));
        if (pic === undefined) return;
        const r = resolveBox(b, pic, ctx);
        if (r.problem !== undefined) { failures.push(`${where}: ${r.problem}`); return; }
        const claimsSame = b.looksSame === true;
        if (r.rects.length === 0) { if (claimsSame) failures.push(`${where}: looksSame needs a pixel picture and a rectangle to compare, and this box has none`); return; }
        // the same page on the other side: a picture with a group has as its mate the one picture on the other side with the same group and order (none, or more than one, means no mate: it is never paired with an arbitrary picture); a picture without a group keeps the old rule, the picture with the same label, else the only image on that side
        const other = [...pics.values()].filter((q) => q.side !== pic.side && SYSTEM_OF_TYPE[String(q.type)] === "pixels");
        const grouped = typeof pic.group === "string" && pic.group !== "";
        let mate: Obj | undefined;
        if (grouped) { const c = other.filter((q) => q.group === pic.group && q.order === pic.order); mate = c.length === 1 ? c[0] : undefined; }
        else mate = pic.label !== undefined ? other.find((q) => q.label === pic.label) : other.length === 1 ? other[0] : undefined;
        const a = pixels(pic), m = mate === undefined ? undefined : pixels(mate);
        if (claimsSame && (a === undefined || m === undefined)) { failures.push(`${where}: looksSame cannot be accepted, ${mate === undefined ? "no picture on the other side could be paired with this one" : "the pictures could not be read as 8-bit PNG files to compare"}`); return; }
        if (a === undefined || m === undefined) { warnings.push(`${where}: ${mate === undefined ? "no pixel check, no picture on the other side could be paired with this one" : "no pixel check, the pictures could not be read as 8-bit PNG files"}`); return; }
        // the same change's box on the mate picture, only when the change has exactly one box on this picture and exactly one on the mate: each side is read under its own rect
        const own = (Array.isArray(ch.boxes) ? (ch.boxes as Obj[]) : []).filter((x) => x.picture === pic.id);
        const theirs = (Array.isArray(ch.boxes) ? (ch.boxes as Obj[]) : []).filter((x) => x.picture === mate!.id);
        const mb = own.length === 1 && theirs.length === 1 ? theirs[0] : undefined; // with more than one box on a side nothing links a before box to an after box: same rect
        const mr = mb === undefined ? undefined : resolveBox(mb, mate!, ctx);
        let same: Array<boolean | undefined>;
        if (mr !== undefined && mr.problem === undefined && mr.rects.length > 0) {
          same = r.rects.length === mr.rects.length ? r.rects.map((rect, k) => (pic.side === "before" ? sameRegionAt(a, rect, m, mr.rects[k]!) : sameRegionAt(m, mr.rects[k]!, a, rect))) : [false];
        } else {
          const [bp, ap] = pic.side === "before" ? [a, m] : [m, a];
          same = r.rects.map((rect) => sameRegion(bp, ap, rect));
        }
        if (claimsSame) {
          // LooksSame is accepted only over identical pixels; a box that says "looks the same" over differing pixels is a lie and fails (it is never demoted or passed).
          if (!same.every((x) => x === true)) failures.push(`${where}: looksSame is true but the before and after pixels under the box differ`);
          return;
        }
        if (same.every((x) => x === true)) { warnings.push(`${where}: ${DEMOTED}`); failures.push(`${where}: ${DEMOTED}: the before and after pixels under it are identical`); }
      });
    });
  }
  const passed: LevelReport["passed"] = base > 0 ? 0 : failures.length > 0 ? 2 : ctx.level;
  return { passed, failures, warnings, reached };
}

/**
 * A connector process may answer many diffs and must answer each from its inputs only. Pairs A, B, A are
 * asked of one process, and each answer must equal, byte for byte (as the runner hands it over, serialized in the order it was written), the answer a fresh
 * process gives the same pair. Returns the failure in words, or undefined when it holds. Every process it starts it stops.
 */
export async function warmMatchesFresh(start: () => Promise<ConnectorHandle>, ask: (h: ConnectorHandle, pair: "A" | "B") => Promise<unknown>): Promise<string | undefined> {
  const once = async (pairs: Array<"A" | "B">): Promise<string[]> => {
    const h = await start();
    try {
      const out: string[] = [];
      for (const p of pairs) out.push(JSON.stringify(await ask(h, p)));
      return out;
    } finally {
      await h.stop().catch(() => undefined);
    }
  };
  const warm = await once(["A", "B", "A"]);
  const [freshA] = await once(["A"]);
  const [freshB] = await once(["B"]);
  const want = [freshA, freshB, freshA];
  const at = warm.findIndex((w, i) => w !== want[i]);
  if (at < 0) return undefined;
  return `answer ${at + 1} of A, B, A asked of one process differs from a fresh process's answer to ${at === 1 ? "B" : "A"}: a connector process must answer each diff from its inputs only`;
}

// ---- the runner -----------------------------------------------------------------------------------------------------------------------

interface Pair { name?: string; before: string; after: string; expectChanges?: Array<{ kind: string; entity: string }> }
interface Case { id: string; inputs: unknown; expect: Obj; env?: Obj }

const CALL_MS = 15_000;
const argvOf = (manifest: Obj): string[] => {
  return ownNode(requireRun(manifest.run));
};

const problemText = (ps: Problem[]): string => ps.map((p) => `${p.field}: expected ${p.expected}, found ${p.found}`).join("; ");
const fail = (msg: string): never => { throw new Error(msg); };
const sameSet = (got: string[], want: string[]) => JSON.stringify([...got].sort()) === JSON.stringify([...want].sort());
const countOf = (answer: unknown): number => (isObj(answer) && Array.isArray(answer.changes) ? answer.changes.length : 0);
const MARK_OF: Record<string, string> = { create: "added", edit: "changed", delete: "removed" };
const marksOf = (answer: unknown): string[] => (isObj(answer) && Array.isArray(answer.changes) ? (answer.changes as unknown[]).filter(isObj).map((c) => String(c.mark)) : []);
export async function runCases(options: RunCasesOptions): Promise<CaseResult[]> {
  const dir = path.resolve(options.dir);
  const root = path.resolve(options.casesDir, "..", "..", "..");
  const abs = (p: string) => path.resolve(root, p);
  const ids = readdirSync(options.casesDir).filter((n) => /^C\d+\.json$/.test(n)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  const cases = ids.map((n) => JSON.parse(readFileSync(path.join(options.casesDir, n), "utf8")) as Case);

  const manifest = JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as Obj;
  const run = argvOf(manifest);
  const baseId = typeof manifest.id === "string" ? manifest.id : path.basename(dir);
  const tag = `${baseId}#conformance-${process.pid}-${Date.now()}`;
  let seq = 0;
  const handles: ConnectorHandle[] = [];
  const start = async (extra: { env?: Record<string, string>; secret?: string } = {}, helloTimeoutMs = 5000): Promise<ConnectorHandle> => {
    const h = await startConnector({
      dir, run, id: `${tag}-${seq++}`, env: extra.env, helloTimeoutMs,
      ...(extra.secret !== undefined ? { credentials: [{ name: "seeded-token" }], secretStore: { get: () => Buffer.from(extra.secret!, "utf8") } } : {}),
    });
    handles.push(h);
    return h;
  };
  let shared: ConnectorHandle | undefined;
  const handle = async () => (shared ??= await start());
  const diff = async (h: ConnectorHandle, p: Pair, timeoutMs = CALL_MS): Promise<unknown> => h.call("diff", { before: abs(p.before), after: abs(p.after) }, { timeoutMs });
  const ctxOf = (p: Pair) => ({ beforeText: readFileSync(abs(p.before), "utf8"), afterText: readFileSync(abs(p.after), "utf8") });
  const shape = (answer: unknown, label: string) => {
    const ps = checkChanges(answer);
    if (ps.length > 0) fail(`${label}: ${problemText(ps)}`);
  };
  const pairsOf = (c: Case): Pair[] => (Array.isArray(c.inputs) ? (c.inputs as Pair[]) : [c.inputs as Pair]);

  /** Every pair: a valid answer, exactly the expected marks, and the checks of the connector's level clean. */
  const pairCase = async (c: Case, h?: ConnectorHandle): Promise<void> => {
    const hh = h ?? (await handle());
    const level = helloLevel(hh.hello) ?? 3;
    for (const p of pairsOf(c)) {
      const answer = await diff(hh, p);
      const label = p.name ?? "pair";
      shape(answer, label);
      if (p.expectChanges !== undefined) {
        const got = marksOf(answer);
        const want = p.expectChanges.map((x) => MARK_OF[x.kind] ?? x.kind);
        if (!sameSet(got, want)) fail(`${label}: expected changes ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
      }
      const g = gradeLevel([answer, await diff(hh, p)], { level, ...ctxOf(p), dir, nothingChanged: hh.hello["nothingChanged"] === true });
      if (g.failures.length > 0) fail(`${label} level ${level}: ${g.failures.join("; ")}`);
    }
  };
  const byId = new Map(cases.map((c) => [c.id, c]));
  const case3 = () => pairCase(byId.get("C3")!);

  const impl: Record<string, (c: Case) => Promise<void>> = {
    async C1() {
      const ps = checkManifest(manifest);
      if (ps.length > 0) fail(problemText(ps));
      if (manifest.spec !== MANIFEST_SPEC) fail(`spec is not ${MANIFEST_SPEC}`);
    },
    async C2() {
      const t0 = Date.now();
      const h = await start({}, 5000);
      if (Date.now() - t0 > 5000) fail("hello took over 5 s");
      for (const k of ["spec", "methods"]) if (h.hello[k] === undefined) fail(`hello has no ${k}`);
      if (h.hello["level"] !== undefined && helloLevel(h.hello) === undefined) fail(`hello level ${JSON.stringify(h.hello["level"])} is not 1, 2 or 3`);
      // The opt-in is true or absent; any other value is a mistake the connector should hear about, never a silent opt-in
      if (h.hello["nothingChanged"] !== undefined && h.hello["nothingChanged"] !== true) fail(`hello nothingChanged ${JSON.stringify(h.hello["nothingChanged"])} is not true; write true, or leave it out`);
    },
    C3: case3,
    async C4(c) {
      const h = await handle();
      const p = pairsOf(c)[0]!;
      const a = await diff(h, p);
      const b = await diff(h, p);
      if (canonical(a) !== canonical(b)) fail("a second run of the same pair gave a different document");
    },
    async C5(c) {
      const h = await handle();
      const answer = await diff(h, pairsOf(c)[0]!);
      shape(answer, "answer");
      const n = countOf(answer);
      if (n !== c.expect.changes) fail(`expected ${String(c.expect.changes)} changes for identical states, got ${n}`);
    },
    C6: (c) => pairCase(c),
    async C10() {
      // Network denied as far as a process can ask for it: every proxy variable points at a closed port, and the offline flag is set.
      const dead = "http://127.0.0.1:9";
      const h = await start({ env: { HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead, http_proxy: dead, https_proxy: dead, all_proxy: dead, NO_PROXY: "", no_proxy: "", COCHECK_OFFLINE: "1" } });
      await pairCase(byId.get("C3")!, h);
    },
    async C11(c) {
      const token = `cocheck-fake-token-${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 16)}`;
      const h = await start({ secret: token });
      const answer = await diff(h, pairsOf(c)[0]!);
      if (JSON.stringify(answer).includes(token) || JSON.stringify(h.hello).includes(token)) fail("the seeded token appears in the connector's output");
      if (h.log().includes(token)) fail("the seeded token appears in the connector's log");
    },
    async C12(c) {
      const h = await handle();
      let answer: unknown;
      try {
        answer = await diff(h, pairsOf(c)[0]!);
      } catch (error) {
        const m = (error as Error).message;
        if (/answered with an error/.test(m)) return; // a structured error is the pass
        fail(`the connector failed without a structured error: ${m}`);
      }
      fail(`a malformed product response gave an answer (${countOf(answer)} changes) instead of a structured error`);
    },
    async C13(c) {
      const g = (c.inputs as { generate: { script: string; args: string[]; writes: string[]; expectChanges: number } }).generate;
      // The large pair is written to a temp folder that is removed when the case ends, pass or fail: `cocheck connector test` runs on users' machines.
      const out = mkdtempSync(path.join(tmpdir(), "c13-"));
      let answer: unknown;
      let secs: number;
      const maxSeconds = Number(c.expect.maxSeconds ?? 30);
      try {
        const gen = spawnSync(process.execPath, [abs(g.script), g.args[0]!, out], { encoding: "utf8" });
        if (gen.status !== 0) fail(`the generator failed: ${gen.stderr}`);
        const h = await handle();
        const t0 = Date.now();
        answer = await h.call("diff", { before: path.join(out, g.writes[0]!), after: path.join(out, g.writes[1]!) }, { timeoutMs: maxSeconds * 1000 });
        secs = (Date.now() - t0) / 1000;
      } finally {
        rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
      if (secs > maxSeconds) fail(`the large pair took ${secs} s, over ${maxSeconds} s`);
      shape(answer, "answer");
      const n = countOf(answer);
      if (n !== g.expectChanges) fail(`expected ${g.expectChanges} changes on the large pair, got ${n}`);
      // maxRssMb is not measured: the runner does not expose the child's pid and reading its memory is OS-specific.
    },
    async C14(c) {
      // The entry comes from the manifest and the method is the one production calls: entry state or both -> `diff`, entry diff -> `diffs`, entry export -> `export`.
      const h = await start(); // a fresh process: another case may have ended the shared one
      const methods = Array.isArray(h.hello.methods) ? (h.hello.methods as unknown[]) : [];
      const entry = manifest.entry;
      if (entry === "export") {
        if (!methods.includes(EXPORT_METHOD)) fail(`manifest entry "export" needs hello.methods to name "${EXPORT_METHOD}"`);
        return;
      }
      if (entry === "diff") {
        if (!methods.includes("diffs")) fail('manifest entry "diff" needs hello.methods to name "diffs"');
        return;
      }
      if (entry !== "state" && entry !== "both") fail(`manifest entry ${JSON.stringify(entry)} is not state, diff, both or export`);
      if (!methods.includes("diff")) fail(`manifest entry ${JSON.stringify(entry)} needs hello.methods to name "diff"`);
      const p = pairsOf(c)[0]!;
      const answer = await diff(h, p);
      shape(answer, "diff");
      if (countOf(answer) === 0) fail("diff gave no change on a pair that differs");
    },
    async C17(c) {
      // One process answers A, B, A exactly as fresh processes answer A and B.
      const [a, b] = pairsOf(c) as [Pair, Pair];
      const bad = await warmMatchesFresh(() => start(), (h, p) => diff(h, p === "A" ? a : b));
      if (bad !== undefined) fail(bad);
    },
    async C16(c) {
      const goldenPath = path.join(dir, "golden.json");
      if (!existsSync(goldenPath)) return; // no golden for this connector: C3 pins its output instead
      const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<string, string>;
      for (const k of Object.keys(golden)) if (/darwin|win32|linux|macos|windows/i.test(k)) fail(`per-OS golden key ${k}`);
      const key = String(c.expect.goldenKey);
      if (golden[key] === undefined) fail(`the golden has no key ${key}`);
      const h = await handle();
      const hash = hashOf(await diff(h, pairsOf(c)[0]!));
      if (hash !== golden[key]) fail(`output hash ${hash} differs from the golden ${golden[key]}`);
    },
  };

  const out: CaseResult[] = [];
  try {
    // An export connector has no diff method to ask (CoCheck draws the difference): only its manifest, hello and methods are graded.
    const exportOnly = manifest.entry === "export";
    for (const c of cases) {
      const fn = impl[c.id];
      if (fn === undefined) { out.push({ id: c.id, pass: false, reason: "no implementation for this case" }); continue; }
      if (exportOnly && !["C1", "C2", "C14"].includes(c.id)) continue;
      try {
        await fn(c);
        out.push({ id: c.id, pass: true });
      } catch (error) {
        out.push({ id: c.id, pass: false, reason: (error as Error).message });
      }
    }
  } finally {
    for (const h of handles) await h.stop().catch(() => undefined);
  }
  return out;
}
