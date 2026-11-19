import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { killTestDecks } from "../scripts/lib/pptx-fixtures.ts";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";
import { diffDecks } from "../src/office/connector/pptx/diff.ts";
import { readDeck } from "../src/office/connector/pptx/reader.ts";

// The paragraph-aware row cases of the deleted pptx-edit-safety.test.ts. They pin the kept deck diff and
// layer, not the deleted deck tools, so they live here. The edited deck is now built directly instead of
// through `editDeck`.

const layer = createPptxLayer();

async function tmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "cocheck-pptx-rows-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("paragraph-aware number rows", () => {
  const T = "Slide 1 / TextBox 2";
  /** TextBox 2 holding the given paragraphs; "|" splits a paragraph into runs. */
  function paragraphsDeck(paras: string[]): Uint8Array {
    const z = unzipSync(killTestDecks()["chart-deck"]!);
    const body = paras.map((t) => `<a:p>${t.split("|").map((r) => `<a:r><a:t>${r}</a:t></a:r>`).join("")}</a:p>`).join("");
    z["ppt/slides/slide1.xml"] = strToU8(
      strFromU8(z["ppt/slides/slide1.xml"]!).replace(/<a:p><a:r>(?:(?!<a:p>).)*?Revenue grew 12% to \$4\.2M in Q3<\/a:t><\/a:r><\/a:p>/, body),
    );
    return zipSync(z);
  }

  it("rows carry their paragraph and index within it, locations unchanged", () => {
    const bytes = paragraphsDeck(["Revenue grew", "Cost 150 and $4.2M"]);
    const out = paragraphsDeck(["Revenue grew", "Cost 150 and $4.7M"]);
    const r = diffDecks(readDeck(bytes), readDeck(out));
    assert.equal(r.length, 1);
    assert.equal(r[0]!.location, `${T} / number 2`);
    assert.equal(r[0]!.detail.paragraph, 2);
    assert.equal(r[0]!.detail.paragraphNumberIndex, 2);
  });
});

describe("structural paragraphs", () => {
  /** A paragraph is a list of parts: plain strings are runs, "\n" an a:br, "@x" an a:fld showing "x". */
  type P = string[];
  const xmlOf = (p: P) =>
    `<a:p>${p.map((x) => (x === "\n" ? "<a:br/>" : x.startsWith("@") ? `<a:fld id="{1}" type="custom"><a:t>${x.slice(1)}</a:t></a:fld>` : `<a:r><a:t>${x}</a:t></a:r>`)).join("")}</a:p>`;
  function deckOf(paras: P[]): Uint8Array {
    const z = unzipSync(killTestDecks()["chart-deck"]!);
    z["ppt/slides/slide1.xml"] = strToU8(
      strFromU8(z["ppt/slides/slide1.xml"]!).replace(/<a:p><a:r>(?:(?!<a:p>).)*?Revenue grew 12% to \$4\.2M in Q3<\/a:t><\/a:r><\/a:p>/, paras.map(xmlOf).join("")),
    );
    return zipSync(z);
  }
  const EARLIER: { name: string; p: P }[] = [
    { name: "plain", p: ["Rev 5m"] },
    { name: "a:br", p: ["Rev 5m", "\n", "line2 $1M"] },
    { name: "a:fld", p: ["Rev ", "@F ", "5m"] },
  ];
  const COST: P = ["Cost $4.2M"];
  const rowsBetween = (a: P[], b: P[]) =>
    tmp(async (dir) => {
      const [x, y] = [path.join(dir, "a.pptx"), path.join(dir, "b.pptx")];
      await writeFile(x, deckOf(a));
      await writeFile(y, deckOf(b));
      return layer.diff(x, y);
    });

  for (const E of EARLIER) {
    it(`earlier paragraph ${E.name}: number rows carry the a:p index, whatever a:br or a:fld came before`, async () => {
      const rows = await rowsBetween([E.p, COST], [E.p, ["Cost $4.7M"]]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.detail.paragraph, 2);
      assert.equal(rows[0]!.detail.paragraphNumberIndex, 1);
      assert.match(rows[0]!.location, / \/ number \d+$/);
    });
  }
});
