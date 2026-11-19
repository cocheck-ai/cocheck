// The whole-file view (Now and Before task positions) is decided by what draws the file, not by a list of endings in
// review-server. A renderer that draws pages (pdf, text lines) or a claimed card has it; the quick-look fallback does not.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createRegistry } from "../src/connector/registry.ts";
import { pdfRenderer } from "../src/timeline/render/pdf.ts";
import { wholeViewFor } from "../src/timeline/render/whole.ts";

const text = { tier: "text" } as never;
const none = { tier: "none" } as never;

describe("whole-file view follows the renderer", () => {
  it(".pdf keeps the whole-file view (before and after), and the asked side is kept", () => {
    const reg = createRegistry({ builtins: [{ id: "pdf", extensions: [".pdf"], renderer: pdfRenderer }] });
    assert.equal(reg.rendererFor("/x/a.pdf", none).name, "pdfkit");
    assert.equal(wholeViewFor(reg.rendererFor("/x/a.pdf", none), none, "before"), "before");
    assert.equal(wholeViewFor(reg.rendererFor("/x/a.pdf", none), none, "after"), "after");
  });
  it("an unclaimed paged type (a text-tier file with an ending nothing names) keeps it; an unclaimed type with no pages does not", () => {
    const reg = createRegistry();
    assert.equal(wholeViewFor(reg.rendererFor("/x/n.weird", text), text, "after"), "after");
    assert.equal(wholeViewFor(reg.rendererFor("/x/n.bin", none), none, "after"), undefined);
  });
  it("a secret text file never gets it; nothing asked means nothing", () => {
    const reg = createRegistry();
    const secret = { tier: "text", secret: true } as never;
    assert.equal(wholeViewFor(reg.rendererFor("/x/n.txt", secret), secret, "after"), undefined);
    assert.equal(wholeViewFor(reg.rendererFor("/x/n.txt", text), text, undefined), undefined);
  });
  it("a type a connector claims keeps it (the claimed card), whatever its ending; this includes the endings core no longer names", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "whole-"));
    const dir = path.join(home, "connectors", "mine");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: "mine", version: "1.0.0", entry: "state", matches: { extensions: [".qqq", ".pdf"] }, run: ["node", "c.mjs"] }));
    const reg = createRegistry({ home });
    for (const f of ["/x/a.qqq", "/x/a.pdf"]) {
      const r = reg.rendererFor(f, none);
      assert.equal(r.name, "connector-claimed", f);
      assert.equal(wholeViewFor(r, none, "before"), "before", f);
    }
  });
});
