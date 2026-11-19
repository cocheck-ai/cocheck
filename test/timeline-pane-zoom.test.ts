// Pane zoom: Fit width / 100% / 200%. Guards against: 100% not meaning one picture pixel per CSS pixel, a zoom past the cap or below fit-width,
// the box or scroll centre jumping on a zoom change, and Cmd/Ctrl +, - or 0 stealing the browser's zoom inside a text field.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import vm from "node:vm";

interface VTApi {
  zoomTarget(mode: string, o: Record<string, number>): number; zoomMode(z: number, o: Record<string, number>): string | null;
  zoomStep(z: number, dir: number, o: Record<string, number>): string | null; keepCentre(scroll: number, view: number, z0: number, z1: number): number;
  zoomShortcut(e: Record<string, unknown>): string | null;
}
async function vt(): Promise<VTApi> {
  const ctx = vm.createContext({ console });
  vm.runInContext(await readFile(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url), "utf8"), ctx);
  return (ctx as unknown as { CoCheckViewTable: VTApi }).CoCheckViewTable;
}
const O = { fitW: 500, picW: 1500 };

describe("pane zoom math", () => {
  it("100% is one picture pixel per CSS pixel and 200% two, from the picture width", async () => {
    const VT = await vt();
    assert.equal(VT.zoomTarget("fit", O), 1);
    assert.equal(VT.zoomTarget("100", O), 3);
    assert.equal(VT.zoomTarget("200", O), 6);
  });
  it("never below fit-width (a picture narrower than the pane) and never past the cap; bad input is fit-width", async () => {
    const VT = await vt();
    assert.equal(VT.zoomTarget("100", { fitW: 800, picW: 400 }), 1);
    assert.equal(VT.zoomTarget("200", { fitW: 800, picW: 400 }), 1);
    assert.equal(VT.zoomTarget("200", { fitW: 100, picW: 60000 }), 16);
    assert.equal(VT.zoomTarget("100", { fitW: 0, picW: 1500 }), 1);
    assert.equal(VT.zoomTarget("100", { fitW: 500, picW: 0 }), 1);
  });
  it("the selected choice is the one that matches; an automatic open-on-box zoom matches none", async () => {
    const VT = await vt();
    assert.equal(VT.zoomMode(1, O), "fit");
    assert.equal(VT.zoomMode(3, O), "100");
    assert.equal(VT.zoomMode(6, O), "200");
    assert.equal(VT.zoomMode(1.8, O), null);
  });
  it("steps through the choices from any zoom, skipping a choice equal to the current one", async () => {
    const VT = await vt();
    assert.equal(VT.zoomStep(1, 1, O), "100");
    assert.equal(VT.zoomStep(3, 1, O), "200");
    assert.equal(VT.zoomStep(6, 1, O), null);
    assert.equal(VT.zoomStep(1.8, 1, O), "100", "from an automatic zoom, plus goes to the next larger choice");
    assert.equal(VT.zoomStep(1.8, -1, O), "fit");
    assert.equal(VT.zoomStep(1, -1, O), null);
    assert.equal(VT.zoomStep(1, 1, { fitW: 800, picW: 400 }), null, "a small picture has nothing larger to step to");
  });
  it("keeps the middle of the view on the same picture point", async () => {
    const VT = await vt();
    // view 400 wide scrolled to 100: the middle is at picture x 300 (at z=1); at z=3 that point is at 900, so scroll 700
    assert.equal(VT.keepCentre(100, 400, 1, 3), 700);
    assert.equal(VT.keepCentre(0, 400, 1, 3), 400);
    assert.equal(VT.keepCentre(700, 400, 3, 1), 100);
    assert.equal(VT.keepCentre(0, 400, 3, 1), 0, "never negative");
    assert.equal(VT.keepCentre(50, 400, 0, 2), 50);
  });
});

describe("pane zoom keys", () => {
  it("Cmd or Ctrl with plus, equals, minus, 0 are in, in, out, fit", async () => {
    const VT = await vt();
    const t = { tagName: "DIV" };
    for (const mod of ["metaKey", "ctrlKey"]) {
      assert.equal(VT.zoomShortcut({ [mod]: true, key: "+", target: t }), "in");
      assert.equal(VT.zoomShortcut({ [mod]: true, key: "=", target: t }), "in");
      assert.equal(VT.zoomShortcut({ [mod]: true, key: "-", target: t }), "out");
      assert.equal(VT.zoomShortcut({ [mod]: true, key: "0", target: t }), "fit");
    }
  });
  it("does nothing without the modifier, with Alt, or inside a text field", async () => {
    const VT = await vt();
    assert.equal(VT.zoomShortcut({ key: "+", target: { tagName: "DIV" } }), null);
    assert.equal(VT.zoomShortcut({ metaKey: true, altKey: true, key: "+", target: { tagName: "DIV" } }), null);
    for (const tag of ["TEXTAREA", "INPUT", "SELECT"]) assert.equal(VT.zoomShortcut({ metaKey: true, key: "+", target: { tagName: tag } }), null, tag);
    assert.equal(VT.zoomShortcut({ ctrlKey: true, key: "0", target: { tagName: "DIV", isContentEditable: true } }), null);
    assert.equal(VT.zoomShortcut({ metaKey: true, key: "p", target: { tagName: "DIV" } }), null);
  });
});
