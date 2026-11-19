import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accountDocument, viewFromPages } from "../src/timeline/render/pdf.ts";
import { encodePng } from "./fixtures/png-encode.ts";

// Shape rule, ported from the bbox deep dive branch (pdf.ts cases only). On macOS 27.2 PDFKit reads a shape or picture as a run of U+FFFC.
function pagePng(w: number, h: number, rects: Array<[number, number, number, number]>): Buffer {
  const raw = Buffer.alloc(w * h * 3, 255);
  for (const [x0, y0, rw, rh] of rects) for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) raw.fill(0, (y * w + x) * 3, (y * w + x) * 3 + 3);
  return encodePng({ width: w, height: h, colorType: 2, raw });
}
const run = (text: string, y = 10) => ({ text, x: 10, y, w: 50, h: 8 });
const pg = (index: number, runs: Array<ReturnType<typeof run>>) => ({ index, width: 100, height: 100, runs });
const plain = pagePng(100, 100, []), shaped = pagePng(100, 100, [[60, 60, 20, 20]]);
const fileInfo = (file: string) => ({ id: "c1", file, kind: "modified" as const });
describe("a run that is only U+FFFC is a drawing, not text", () => {
  it("a slide whose only new 'text' is U+FFFC (a new shape) is compared by pixels: pixel boxes, no text-match box", async () => {
    const v = await viewFromPages([pg(1, [run("Revenue up 12%")])], [pg(1, [run("Revenue up 12%"), run("\ufffc", 60)])], Buffer.from("a"), Buffer.from("b"), fileInfo("deck.pptx"), { renderPage: async (side) => (side === "before" ? plain : shaped) });
    assert.ok(v.boxes.length > 0 && v.boxes.every((b) => b.confidence === "pixel"), JSON.stringify(v.boxes));
  });
  it("a real text edit on a line next to a shape keeps its text-match box (never demoted to pixel-only)", async () => {
    const v = await viewFromPages([pg(1, [run("Revenue up 12%")])], [pg(1, [run("\ufffc Revenue up 15%")])], Buffer.from("a"), Buffer.from("b"), fileInfo("deck.pptx"), { renderPage: async (side) => (side === "before" ? plain : shaped) });
    assert.ok(v.boxes.some((b) => b.confidence === "text-match" && b.side === "after"), JSON.stringify(v.boxes));
    assert.ok(v.boxes.every((b) => b.confidence !== "pixel"), "a page with a text box is never pixel-compared");
  });
  it("P6 slide 2: a shape added on a slide whose title also changed is boxed at the shape's rect", async () => {
    const shape = { text: "\ufffc", x: 60, y: 60, w: 20, h: 20 };
    const v = await viewFromPages([pg(2, [run("Review Agenda")])], [pg(2, [run("Review Agenda v2"), shape])], Buffer.from("a"), Buffer.from("b"), fileInfo("deck.pptx"), { renderPage: async (side) => (side === "before" ? plain : shaped) });
    assert.ok(v.boxes.some((b) => b.side === "after" && b.rect?.x === 60 && b.rect?.y === 60), JSON.stringify(v.boxes));
    assert.ok(v.boxes.some((b) => b.text === "Review Agenda v2"), "the title box stays");
  });
  it("an unchanged picture on a Word page with an edited paragraph gets no box (only the edit is boxed)", async () => {
    const pic = { text: "\ufffc", x: 10, y: 20, w: 30, h: 8 };
    const v = await viewFromPages([pg(1, [run("Scope", 10), pic, run("The plan is monthly.", 30)])], [pg(1, [run("Scope", 10), pic, run("The plan is quarterly.", 30)])], Buffer.from("a"), Buffer.from("b"), fileInfo("report.docx"), { renderPage: async (side) => (side === "before" ? plain : shaped) });
    assert.deepEqual(v.boxes.map((b) => b.text), ["The plan is monthly.", "The plan is quarterly."]);
  });
  it("an inline picture added beside an edited Word paragraph is boxed at its rect (the page is never pixel-compared, so this is its only mark)", async () => {
    const v = await viewFromPages([pg(1, [run("Scope", 10), run("The plan is monthly.", 30)])], [pg(1, [run("Scope", 10), { text: "\ufffc", x: 10, y: 20, w: 30, h: 8 }, run("The plan is quarterly.", 30)])], Buffer.from("a"), Buffer.from("b"), fileInfo("report.docx"), { renderPage: async (side) => (side === "before" ? plain : shaped) });
    assert.equal(v.boxes.filter((b) => b.side === "after" && b.rect?.y === 20).length, 1, JSON.stringify(v.boxes));
  });
});

// The deck layer does emit a card per changed slide ("Slide 1": "Its master changed; its shapes or text
// changed", from package-media "slide changed"), but it never led to its slide's pixel boxes. Whether this
const r3run = (text: string, y: number, x = 140, w = 300, h = 40) => ({ text, x, y, w, h });
const r3page = (index: number, runs: any[]) => ({ index, width: 1920, height: 1080, runs });
const P7before = [r3page(2, [r3run("Review Agenda", 93), r3run("Topics for the review", 180), r3run("• Project status", 300), r3run("• Revenue performance", 375), r3run("• Customer growth", 449), r3run("• Delivery metrics", 525)])];
const P7after = [r3page(2, [r3run("Review Agenda", 93), r3run("Topics for the review", 180), r3run("• Project status", 300), r3run("• Revenue performance", 375), r3run("• Delivery metrics", 449), r3run("￼", 551, 1102, 283, 142)])];
describe("shape rule: every known case", () => {
  it("P7 (real runs): a bullet deleted on the before side only, a rectangle added: the rectangle keeps its box", async () => {
    const r = await accountDocument(P7before as any, P7after as any, async () => null);
    assert.equal(r.boxed.filter((b: any) => b.side === "after" && b.line.run.text === "￼").length, 1, JSON.stringify(r.boxed.map((b: any) => [b.side, b.line.run.text])));
  });
  it("P7: no 'same text, page breaks moved' label on either page, and the removed bullet keeps its before box and the shape its after box", async () => {
    const v = await viewFromPages(P7before as any, P7after as any, Buffer.from("a"), Buffer.from("b"), fileInfo("deck.pptx"), { renderPage: async () => null });
    assert.ok([...v.before, ...v.after].every((p) => !/page breaks moved/.test(p.label)), JSON.stringify([...v.before, ...v.after].map((p) => p.label)));
    assert.ok(v.boxes.some((x) => x.side === "before" && x.text === "• Customer growth"), JSON.stringify(v.boxes));
    assert.equal(v.boxes.filter((x) => x.side === "after" && x.rect?.y === 551).length, 1, JSON.stringify(v.boxes));
  });
  it("P7 without the shape: the after page whose partner lost a line is not labelled 'same text, page breaks moved', and a caveat says it was not pixel-compared", async () => {
    const v = await viewFromPages(P7before as any, [r3page(2, P7after[0]!.runs.slice(0, 5))] as any, Buffer.from("a"), Buffer.from("b"), fileInfo("deck.pptx"), { renderPage: async () => null });
    assert.ok([...v.before, ...v.after].every((p) => !/page breaks moved/.test(p.label)));
    assert.ok(v.caveats.some((c) => /After page 2 was not compared by pixels/.test(c)), JSON.stringify(v.caveats));
  });
  it("a picture swapped for one of another size on a text-changed page is boxed on both sides (open: a same-size swap is not seen)", async () => {
    const v = await viewFromPages([pg(1, [run("Scope", 10), { text: "￼", x: 10, y: 20, w: 30, h: 8 }, run("The plan is monthly.", 30)])], [pg(1, [run("Scope", 10), { text: "￼", x: 10, y: 20, w: 24, h: 12 }, run("The plan is quarterly.", 30)])], Buffer.from("a"), Buffer.from("b"), fileInfo("report.docx"), { renderPage: async () => null });
    assert.deepEqual(v.boxes.filter((b) => b.rect?.y === 20).map((b) => b.side).sort(), ["after", "before"]);
  });
  it("a picture that only moved with the reflow (same size, new place) is not a change", async () => {
    const v = await viewFromPages([pg(1, [run("Scope", 10), { text: "￼", x: 10, y: 20, w: 30, h: 8 }, run("The plan is monthly.", 40)])], [pg(1, [run("Scope", 10), run("Inserted line.", 20), { text: "￼", x: 10, y: 30, w: 30, h: 8 }, run("The plan is monthly.", 50)])], Buffer.from("a"), Buffer.from("b"), fileInfo("report.docx"), { renderPage: async () => null });
    assert.deepEqual(v.boxes.map((b) => b.text), ["Inserted line."]);
  });
});
