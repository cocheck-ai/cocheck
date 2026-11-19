import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// the Files view draws a version the model marks muted (a re-save the connector vouched changed nothing) as a quiet line that reads
// "saved again, nothing changed" and still opens its step; a version without muted true is drawn as before.

class N {
  tag: string; attrs: Record<string, unknown> = {}; kids: N[] = []; text = ""; style = { setProperty() {} }; onclick?: () => void; scrollLeft = 0;
  constructor(tag: string) { this.tag = tag; }
  get cls(): string { return String(this.attrs.class ?? ""); }
  get textContent(): string { return this.text + this.kids.map((k) => k.textContent).join(""); }
  set textContent(v: string) { this.text = v; this.kids = []; }
  append(...c: unknown[]) { for (const x of c.flat()) this.kids.push(typeof x === "string" ? Object.assign(new N("#t"), { text: x }) : (x as N)); }
  all(): N[] { return this.kids.flatMap((k) => [k, ...k.all()]); }
}
function el(tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]): N { const n = new N(tag); n.attrs = attrs; if (typeof attrs.onclick === "function") n.onclick = attrs.onclick as () => void; n.append(...kids); return n; }

async function strip(versions: Array<Record<string, unknown>>) {
  const root: Record<string, unknown> = {};
  vm.runInContext(await readFile(new URL("../src/timeline/rail/assets/files-view.js", import.meta.url), "utf8"), vm.createContext(root), {});
  const FV = root.CoCheckFilesView as { paintStrip: (b: N, f: unknown, p: number, h: unknown) => void };
  const went: number[] = [];
  const h = { el, chip: () => el("span"), name: () => "Agent", color: () => "red", go: (q: number) => went.push(q), markOfVersion: () => null };
  const box = new N("div");
  FV.paintStrip(box, { versions }, 1, h);
  return { nodes: box.kids, went };
}
const v = (extra: Record<string, unknown> = {}) => ({ lane: "a", label: "Edited", kind: "edited", at: null, ...extra });

describe("muted version in the Files strip", () => {
  it("a version with muted true gets the muted class and the words, and still opens its step", async () => {
    const { nodes, went } = await strip([v({ muted: true })]);
    const b = nodes.find((n) => n.attrs["data-p"] === "1")!;
    assert.match(b.cls, /\bmuted\b/);
    assert.ok(b.textContent.includes("saved again, nothing changed"));
    b.onclick!();
    assert.deepEqual(went, [1]);
  });
  it("a normal version (a real change must never be muted) has neither the class nor the words", async () => {
    for (const extra of [{}, { muted: false }, { muted: "true" }]) {
      const { nodes } = await strip([v(extra)]);
      const b = nodes.find((n) => n.attrs["data-p"] === "1")!;
      assert.doesNotMatch(b.cls, /muted/);
      assert.ok(b.textContent.includes("Edited"));
      assert.ok(!b.textContent.includes("saved again"));
    }
  });
});
