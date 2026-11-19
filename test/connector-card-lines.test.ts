import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { drawn, type N } from "./helpers/made-page.ts";

// The level-1 card view keeps a change's line breaks. The text shape is the ipynb-cells connector's: source lines and "[output]" parts joined by "\n".
const doc = (changes: unknown[]) => ({ spec: "cocheck.changes/1", changes, pictures: [], caveats: [], engine: "x", file: "f", kind: "card", source: { by: "connector", name: "ipynb-cells", level: 1 } });
const BEFORE = "df = load()\nfor r in df:\n    total += r.sales\n\n[output]\n42";
const AFTER = "df = load()\nfor r in df:\n    total += r.sales * 2\n[output]\n84";
const lineNodes = (n: N) => n.descendants().filter((d) => d.className.split(/\s+/).includes("cvl"));

describe("level-1 card keeps line breaks", () => {
  it("before and after multi-line text draw as separate lines, leading spaces kept in the text", async () => {
    const p = await drawn(doc([{ id: "c1", mark: "changed", label: "Cell 3", kind: "value", before: BEFORE, after: AFTER }]));
    const card = p.byId("bodyview").descendants().find((n) => n.className.includes("cvcard"))!;
    const b = card.descendants().find((n) => n.className.includes("cvbefore"))!, a = card.descendants().find((n) => n.className.includes("cvafter"))!;
    assert.deepEqual(lineNodes(b).map((n) => n.textContent), BEFORE.split("\n"));
    assert.deepEqual(lineNodes(a).map((n) => n.textContent), AFTER.split("\n"));
    assert.ok(lineNodes(a).some((n) => n.textContent === "    total += r.sales * 2"));
  });
  it("the line blocks draw pre-wrap with wrapping, and no horizontal scroll rule on the card", async () => {
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    const rule = css.split("\n").find((l) => l.startsWith(".cvcard .cvl{"))!;
    assert.ok(rule && /white-space:pre-wrap/.test(rule) && /overflow-wrap:anywhere/.test(rule));
    assert.ok(!/overflow-x|white-space:pre[;}]/.test(rule));
  });
  it("DANGEROUS DIRECTION: whitespace is preserved only in the before/after line blocks; the label, the text and a one-line value are drawn as before", async () => {
    const p = await drawn(doc([{ id: "c1", mark: "changed", label: "Cell\n  3", kind: "value", before: "old", after: "new", text: "a  note\nhere" }]));
    const card = p.byId("bodyview").descendants().find((n) => n.className.includes("cvcard"))!;
    assert.equal(lineNodes(card).length, 2, "one-line before and after are one block each");
    assert.ok(!lineNodes(card).some((n) => n.textContent.includes("note") || n.textContent.includes("Cell")), "label and text are not line blocks");
    const css = await readFile(new URL("../src/timeline/rail/assets/review.css", import.meta.url), "utf8");
    assert.ok(!/\.mcard[^{,]*\{[^}]*white-space:pre/.test(css) && !/\.cvcard\{[^}]*white-space/.test(css), "no pre rule on the card or the generic card class");
  });
});

// A blank before line must stay one line tall. A `<div class="cvl"><s></s></div>` is not :empty, so the zero-width-space rule never applies and the line collapses to 0px in a browser.
describe("a blank before line keeps its height", () => {
  it("a blank before line is an empty line block like a blank after line, with no empty <s> child; struck lines keep their <s>", async () => {
    const p = await drawn(doc([{ id: "c1", mark: "changed", label: "Cell 3", kind: "value", before: BEFORE, after: BEFORE }]));
    const card = p.byId("bodyview").descendants().find((n) => n.className.includes("cvcard"))!;
    const b = lineNodes(card.descendants().find((n) => n.className.includes("cvbefore"))!), a = lineNodes(card.descendants().find((n) => n.className.includes("cvafter"))!);
    const elems = (n: N) => n.children.filter((c) => c.tag !== "#text"); // an empty text node does not defeat :empty in a browser; an element child does
    const blankB = b[3]!, blankA = a[3]!;
    assert.equal(blankB.textContent, "");
    assert.equal(elems(blankB).length, 0, "blank before line has no <s> child (it would defeat .cvl:empty)");
    assert.equal(elems(blankB).length, elems(blankA).length, "same shape as a blank after line");
    assert.ok(b.filter((n) => n.textContent !== "").every((n) => elems(n).length === 1 && elems(n)[0]!.tag === "s"), "DANGEROUS DIRECTION: non-blank before lines keep their strike");
    assert.equal(b.length, 6);
  });
});
