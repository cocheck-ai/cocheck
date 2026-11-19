import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { load, validate } from "../scripts/lib/pptx-validate.ts";
import { tagShape } from "../scripts/lib/pptx-tags.ts";
import { readDeck } from "../src/office/connector/pptx/reader.ts";
import { brokenLinks, collectLinks } from "../src/office/connector/pptx/links.ts";
import { parseTagPart, readShapeTag } from "../src/office/connector/pptx/tags.ts";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";

// The deck write tools do not exist; the read side of COCHECK.LINKS stays so old tagged decks keep their
// "link broken" row. Tagged decks are built with the test helper `scripts/lib/pptx-tags.ts`, the way the write tools wrote them.
// Each kept export has a case that fails when its rule is broken.

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, "fixtures", name)));
const TRICKY = JSON.stringify({ note: 'say "hi" & <b>bye</b> \'x\' > y\ttab\nline é 日本語 😀', n: 1 });

const entry = (location: string, over: Record<string, unknown> = {}) => ({
  [location]: { link_id: `L-${location}`, source: { workbook: "m.xlsx", sheet: "Model", cell: "B7" }, anchors: { row_label: null, column_header: null }, format: "#,##0", last_value: 1, ...over },
});

describe("link tags: parseTagPart", () => {
  it("a tag part as PowerPoint writes it, bare '>' inside the attribute, reparses exactly", () => {
    const val = TRICKY.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\t/g, "&#9;").replace(/\n/g, "&#10;");
    assert.ok(val.includes(" > y"), "the fixture keeps a bare >");
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:tagLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:tag name="COCHECK.LINKS" val="${val}"/><p:tag name="OTHER" val="a&gt;b"/></p:tagLst>`;
    assert.deepEqual(parseTagPart(xml), [{ name: "COCHECK.LINKS", value: TRICKY }, { name: "OTHER", value: "a>b" }]);
  });
});

describe("link tags: readShapeTag", () => {
  for (const f of ["deck-resave-resaved.pptx", "ppt-table-deck.pptx"]) {
    it(`${f}: reads the value off the tagged shape only, and nothing off an untagged deck`, () => {
      const deck = fixture(f);
      const [first, second] = readDeck(deck).slides[0]!.shapes.filter((s) => s.name !== "");
      assert.equal(readShapeTag(deck, 1, first!.id, "COCHECK.LINKS"), undefined);
      const tagged = tagShape(deck, 1, first!.name, TRICKY);
      assert.deepEqual(validate(load(tagged)), []);
      assert.equal(readShapeTag(tagged, 1, first!.id, "COCHECK.LINKS"), TRICKY);
      assert.equal(readShapeTag(tagged, 1, first!.id, "OTHER.NAME"), undefined);
      assert.equal(readShapeTag(tagged, 1, second!.id, "COCHECK.LINKS"), undefined);
      assert.throws(() => readShapeTag(tagged, 1, "9999", "COCHECK.LINKS"), /no shape with id 9999/);
    });
  }
});

describe("link tags: collectLinks", () => {
  it("lists every entry of every tagged shape with its slide and shape, and skips a tag that is not a JSON map", () => {
    const deck = fixture("ppt-table-deck.pptx");
    const s1 = readDeck(deck).slides[0]!.shapes;
    const s2 = readDeck(deck).slides[1]!.shapes;
    let tagged = tagShape(deck, 1, "Title 1", JSON.stringify({ ...entry("Slide 1 / Title 1 / number 1"), ...entry("Slide 1 / Title 1 / number 2") }));
    tagged = tagShape(tagged, 1, "TextBox 2", JSON.stringify([1, 2]));
    tagged = tagShape(tagged, 2, "Subtitle 2", JSON.stringify(entry("Slide 2 / Subtitle 2 / number 1")));
    const found = collectLinks(tagged).map((l) => [l.slide, l.shapeId, l.location, l.entry.link_id]);
    assert.deepEqual(found, [
      [1, s1.find((s) => s.name === "Title 1")!.id, "Slide 1 / Title 1 / number 1", "L-Slide 1 / Title 1 / number 1"],
      [1, s1.find((s) => s.name === "Title 1")!.id, "Slide 1 / Title 1 / number 2", "L-Slide 1 / Title 1 / number 2"],
      [2, s2.find((s) => s.name === "Subtitle 2")!.id, "Slide 2 / Subtitle 2 / number 1", "L-Slide 2 / Subtitle 2 / number 1"],
    ]);
    assert.deepEqual(collectLinks(deck), []);
  });
});

describe("link tags: brokenLinks and the page's link broken row", () => {
  const deck = fixture("ppt-table-deck.pptx");
  const healthy = tagShape(deck, 1, "Title 1", JSON.stringify({ ...entry("Slide 1 / Title 1 / number 1"), ...entry("Slide 1 / Title 1 / number 2") }));
  const broken = tagShape(
    deck,
    1,
    "Title 1",
    JSON.stringify({ ...entry("Slide 1 / Title 1 / number 1", { broken: "cell Model!B7 was deleted" }), ...entry("Slide 1 / Title 1 / number 2") }),
  );

  it("brokenLinks keys only the entries marked broken, with their reason and link id", () => {
    assert.deepEqual([...brokenLinks(broken)], [["Slide 1 / Title 1 / number 1", { reason: "cell Model!B7 was deleted", linkId: "L-Slide 1 / Title 1 / number 1" }]]);
    assert.deepEqual([...brokenLinks(healthy)], []);
  });

  it("the deck layer gives one link broken row when a link breaks, and none when it was already broken", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cocheck-link-tags-"));
    try {
      const [a, b] = [path.join(dir, "a.pptx"), path.join(dir, "b.pptx")];
      await writeFile(a, healthy);
      await writeFile(b, broken);
      const layer = createPptxLayer();
      const rows = await layer.diff(a, b);
      assert.deepEqual(
        rows.map((r) => [r.location, r.kind, r.after, r.detail.linkId]),
        [["Slide 1 / Title 1 / number 1", "link broken", "cell Model!B7 was deleted", "L-Slide 1 / Title 1 / number 1"]],
      );
      assert.equal(layer.describe(rows[0]!), "Slide 1 / Title 1 / number 1: link broken, cell Model!B7 was deleted");
      // Same broken reason on both sides (and a byte change elsewhere): no row.
      const again = tagShape(broken, 2, "Subtitle 2", JSON.stringify(entry("Slide 2 / Subtitle 2 / number 1")));
      await writeFile(a, broken);
      await writeFile(b, again);
      assert.deepEqual((await layer.diff(a, b)).filter((r) => r.kind === "link broken"), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
