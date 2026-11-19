import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPptxLayer } from "../src/office/connector/pptx/layer.ts";
import { mediaChanges } from "../src/office/connector/shared/package-media.ts";
import { renderReviewShell } from "../src/timeline/rail/page.ts";

// A real deck v2 -> v3 changed only docProps/core.xml timestamps, p14:section GUIDs and an embedded workbook's core.xml.
const V2 = "test/fixtures/long-html-deck-v2.pptx", V3 = "test/fixtures/long-html-deck-v3.pptx";
// the saved-again wording is the connector's (office/connector/nothing-changed.ts and the page's nothing-changed line); core's
// per-format note and its look-here exception are gone. The reader's empty answer stays pinned here.

describe("saved again", () => {
  it("timestamps, section GUIDs and embedded-workbook properties are never a content row", async () => {
    assert.deepEqual(await createPptxLayer().diff(V2, V3), []);
    assert.deepEqual(mediaChanges(".pptx", await readFile(V2), await readFile(V3)), []);
  });
  it("the banner sits above the stage", () => {
    const html = renderReviewShell(1);
    assert.ok(html.indexOf('id="banner"') < html.indexOf('id="stage"'));
  });
});
