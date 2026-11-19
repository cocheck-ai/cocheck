// Conformance per level (clause 3), the guarded case (clause 7) and the three toy connectors (clause 5, the test half).
// Must not happen: a connector graded as passing whose boxes point at nothing, or whose answers change between runs, versus an honest level-1 connector refused.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorTest } from "../src/connector-test-cli.ts";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { DEMOTED, gradeLevel, runCases } from "../src/connector/conformance.ts";
import { decodePng } from "../src/connector/png-pixels.ts";
import { png } from "./helpers/png-writer.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EX = path.join(ROOT, "public-kit/examples");
const CASES = path.join(ROOT, "public-kit/conformance/cases");
const scratch = (): string => mkdtempSync(path.join(tmpdir(), "cocheck-"));

/** A copy of an example connector with its connector.mjs rewritten by `edit`. */
function variant(example: string, edit: (src: string) => string): string {
  const dir = scratch();
  cpSync(path.join(EX, example), dir, { recursive: true });
  writeFileSync(path.join(dir, "connector.mjs"), edit(readFileSync(path.join(dir, "connector.mjs"), "utf8")));
  return dir;
}

const TEXT = "{\n  \"notes\": [\n    {\n      \"id\": \"n1\",\n      \"text\": \"a\"\n    }\n  ]\n}\n";
const text3 = (boxes: unknown[], extra: Record<string, unknown> = {}) => ({
  spec: "cocheck.changes/1",
  pictures: [{ id: "after", side: "after", type: "text" }],
  changes: [{ id: "k", mark: "added", label: "n1", after: "a", boxes }], ...extra,
});
const grade = (doc: unknown, level: 1 | 2 | 3 = 3, dir = ".") => gradeLevel([doc, doc], { level, beforeText: "", afterText: TEXT, dir });

test("the three toy examples pass `cocheck connector test` at their level", async () => {
  const l1 = await runConnectorTest([path.join(EX, "toy-level-1")]);
  assert.equal(l1.exitCode, 0, l1.stdout);
  assert.match(l1.stdout, /^level 1 passed$/m);
  const l3 = await runConnectorTest([path.join(EX, "toy-level-3")]);
  assert.equal(l3.exitCode, 0, l3.stdout);
  assert.match(l3.stdout, /^level 3 passed$/m);
  const ex = await runConnectorTest([path.join(EX, "toy-export")]);
  assert.equal(ex.exitCode, 0, ex.stdout);
  assert.match(ex.stdout, /export: CoCheck draws the difference/);
});

test("the toy examples pass the conformance cases", async () => {
  for (const ex of ["toy-level-1", "toy-level-3"]) {
    const results = await runCases({ dir: path.join(EX, ex), casesDir: CASES });
    assert.deepEqual(results.filter((r) => !r.pass), [], ex);
  }
});

test("must not: level-3 boxes that point at nothing are refused, never graded as passing level 3", async () => {
  const dir = variant("toy-level-3", (s) => s.replace("return lines === undefined ? [] : [{ picture: side, lines }];", "return [{ picture: side, lines: { from: 900, to: 901 } }];"));
  const r = await runConnectorTest([dir]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /are not inside the text/);
  assert.match(r.stdout, /^level passed: 2 \(declared 3\)$/m);
  assert.doesNotMatch(r.stdout, /^level 3 passed$/m);
  assert.doesNotMatch(r.stdout, /^passed$/m);
});

test("must not: answers that change between runs are refused at every level", async () => {
  for (const [ex, level] of [["toy-level-1", 1], ["toy-level-3", 3]] as const) {
    const dir = variant(ex, (s) => s.replace('spec: "cocheck.changes/1",', 'spec: "cocheck.changes/1", caveats: [String(Math.random())],'));
    const r = await runConnectorTest([dir]);
    assert.equal(r.exitCode, 1, `${ex}\n${r.stdout}`);
    assert.match(r.stdout, /a second run of the same pair gave a different document/, ex);
    assert.doesNotMatch(r.stdout, /^passed$/m);
  }
});

test("must not: an honest level-1 connector is not refused for having no pictures or boxes", async () => {
  const r = await runConnectorTest([path.join(EX, "toy-level-1")]);
  assert.equal(r.exitCode, 0, r.stdout);
  const doc = { spec: "cocheck.changes/1", changes: [{ id: "a", mark: "added", label: "x", after: "y" }] };
  assert.deepEqual(grade(doc, 1), { passed: 1, failures: [], warnings: [], reached: 1 });
});

test("structural: each level's checks are exactly the listed ones (a level-1 or 2 document is not asked to resolve anchors it cannot have)", () => {
  // level 2 pictures with no size are fine: sizes only matter for a box, and a box is level 3
  const l2 = { spec: "cocheck.changes/1", pictures: [{ id: "p", side: "after", type: "image" }], changes: [{ id: "a", mark: "added", label: "x", after: "y" }] };
  assert.deepEqual(grade(l2, 2), { passed: 2, failures: [], warnings: [], reached: 2 });
  // a connector declaring level 1 that answers a level-3 document is refused
  const g = grade(text3([{ picture: "after", lines: { from: 1, to: 2 } }]), 1);
  assert.ok(g.failures.some((f) => /declares level 1 but the document holds boxes/.test(f)), g.failures.join("; "));
  assert.equal(g.passed, 0);
});

test("level 3: every anchor resolves in its system or the document is not level 3", () => {
  const ok = grade(text3([{ picture: "after", lines: { from: 4, to: 5 } }]));
  assert.deepEqual(ok, { passed: 3, failures: [], warnings: [], reached: 3 });
  const lines = grade(text3([{ picture: "after", lines: { from: 8, to: 20 } }]));
  assert.match(lines.failures.join(), /lines 8 to 20 are not inside the text \(8 lines\)/);
  assert.equal(lines.passed, 2);
  const range = grade(text3([{ picture: "after", range: { line: 5, start: 0, end: 99 } }]));
  assert.match(range.failures.join(), /ends at 99 but line 5 has/);
  const line = grade(text3([{ picture: "after", range: { line: 40, start: 0, end: 1 } }]));
  assert.match(line.failures.join(), /line 40 is not inside the text/);
  const img = { spec: "cocheck.changes/1", pictures: [{ id: "p", side: "after", type: "image", width: 100, height: 50 }], changes: [{ id: "k", mark: "added", label: "n1", boxes: [{ picture: "p", rect: { x: 90, y: 10, w: 20, h: 10 } }] }] };
  assert.match(grade(img).failures.join(), /not inside the picture \(100 by 50\)/);
  const noSize = { ...img, pictures: [{ id: "p", side: "after", type: "image" }] };
  assert.match(grade(noSize).failures.join(), /no width and height/);
  const grid = (cell: string, size: object) => ({ spec: "cocheck.changes/1", pictures: [{ id: "g", side: "after", type: "grid", ...size }], changes: [{ id: "k", mark: "added", label: "n1", boxes: [{ picture: "g", cell }] }] });
  assert.deepEqual(grade(grid("B3:D7", { rows: 10, cols: 5 })).failures, []);
  assert.match(grade(grid("B3:D70", { rows: 10, cols: 5 })).failures.join(), /not inside the grid \(5 columns by 10 rows\)/);
  assert.match(grade(grid("F1", { rows: 10, cols: 5 })).failures.join(), /not inside the grid/);
  assert.match(grade(grid("A1", {})).failures.join(), /no rows and cols/);
  assert.ok(checkChanges(grid("A1", { rows: 0, cols: 5 })).some((p) => p.field.endsWith(".rows")));
});

// ---- the pixel check ---------------------------------------------------------------------------------------------------------------------

/** A level-3 connector over images: a rect box on the left quarter of an 8 by 8 picture for every change. `afterPaint` is how the after picture differs. */
function pixelConnector(afterPaint: string, files = true): string {
  const dir = variant("toy-level-3", (s) => s
    .replace(/return \{\n    spec: "cocheck.changes\/1",[\s\S]*?\n  \};\n\}/, `const rect = { x: 0, y: 0, w: 4, h: 4 };
  const withBox = changes.map((c) => ({ id: c.id, mark: c.mark, label: c.label, ...(c.before !== undefined ? { before: c.before } : {}), ...(c.after !== undefined ? { after: c.after } : {}), boxes: [...(c.before !== undefined ? [{ picture: "b", rect }] : []), ...(c.after !== undefined ? [{ picture: "a", rect }] : [])] }));
  return { spec: "cocheck.changes/1", pictures: [{ id: "b", side: "before", type: "image", width: 8, height: 8, src: "before.png", label: "page" }, { id: "a", side: "after", type: "image", width: 8, height: 8, src: "after.png", label: "page" }], changes: withBox };
}`));
  if (files) {
    writeFileSync(path.join(dir, "before.png"), png(8, 8, () => [200, 200, 200]));
    writeFileSync(path.join(dir, "after.png"), png(8, 8, (x, y) => (afterPaint === "same" ? [200, 200, 200] : afterPaint === "inside" ? (x < 4 && y < 4 ? [10, 10, 10] : [200, 200, 200]) : x >= 6 ? [10, 10, 10] : [200, 200, 200])));
  }
  return dir;
}

test("a PNG written by the test decodes to the pixels it was given", () => {
  const p = decodePng(png(3, 2, (x, y) => [x * 40, y * 90, 7]))!;
  assert.deepEqual([p.width, p.height], [3, 2]);
  assert.deepEqual([...p.rgba.subarray(4 * 4, 4 * 4 + 4)], [40, 90, 7, 255]);
  assert.equal(decodePng(Buffer.from("not a png at all, not a png at all, not a png at all")), undefined);
});

test("must not: a box over identical before and after pixels is demoted with the warning, never passed silently", async () => {
  const r = await runConnectorTest([pixelConnector("same")]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.ok(r.stdout.includes(DEMOTED), r.stdout);
  assert.equal(DEMOTED, "this box may not point at a real change");
  assert.match(r.stdout, /^warning: .*this box may not point at a real change$/m);
  assert.match(r.stdout, /^level passed: 2 \(declared 3\)$/m);
  assert.doesNotMatch(r.stdout, /^level 3 passed$/m);
});

test("a box over pixels that really differ passes level 3, and a box beside the change is the one demoted", async () => {
  const inside = await runConnectorTest([pixelConnector("inside")]);
  assert.equal(inside.exitCode, 0, inside.stdout);
  assert.match(inside.stdout, /^level 3 passed$/m);
  assert.doesNotMatch(inside.stdout, /may not point/);
  const beside = await runConnectorTest([pixelConnector("beside")]); // the pictures differ at the right, the box is at the left
  assert.equal(beside.exitCode, 1, beside.stdout);
  assert.match(beside.stdout, /may not point at a real change/);
});

test("pictures that cannot be read are warned about, not treated as identical or as different", async () => {
  const r = await runConnectorTest([pixelConnector("same", false)]);
  assert.match(r.stdout, /no pixel check, the pictures could not be read as 8-bit PNG files/);
  assert.doesNotMatch(r.stdout, /may not point at a real change/);
});

// ---- export mode --------------------------------------------------------------------------------------------------------------------------

test("export: a connector that gives the same text for a state that changed is refused", async () => {
  const dir = variant("toy-export", (s) => s.replace("return state.notes.map((n) => `${n.id}: ${n.text}`).join(\"\\n\") + \"\\n\";", "return \"items\\n\";"));
  const r = await runConnectorTest([dir]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /expected a different text after the (create|edit|delete), found the same text/);
});

test("export: empty text for a malformed state (a false clean) is refused, and text that changes between runs is refused", async () => {
  const empty = variant("toy-export", (s) => s.replace("if (!state || !Array.isArray(state.notes)) throw new Error(`not a notes state: ${file}`);", "if (!state || !Array.isArray(state.notes)) return \"\";").replace("JSON.parse(text);", "(() => { try { return JSON.parse(text); } catch { return null; } })();"));
  const r1 = await runConnectorTest([empty]);
  assert.equal(r1.exitCode, 1, r1.stdout);
  assert.match(r1.stdout, /expected an error for a malformed state/);
  const flaky = variant("toy-export", (s) => s.replace('.join("\\n") + "\\n";', '.join("\\n") + "\\n" + Math.random();'));
  const r2 = await runConnectorTest([flaky]);
  assert.equal(r2.exitCode, 1, r2.stdout);
  assert.match(r2.stdout, /expected the same text on every run/);
});

test("an export connector that names no export method in hello is refused", async () => {
  const dir = variant("toy-export", (s) => s.replace('methods: ["export"]', 'methods: ["diff"]'));
  const r = await runConnectorTest([dir]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /hello\.methods/);
});

test("hello declares a level of 1, 2 or 3 or the connector is refused", async () => {
  const dir = variant("toy-level-1", (s) => s.replace("level: 1, methods", "level: 4, methods"));
  const r = await runConnectorTest([dir]);
  assert.equal(r.exitCode, 1, r.stdout);
  assert.match(r.stdout, /hello\.level/);
});
