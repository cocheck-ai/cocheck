import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

// the file row is icon, name and one status glyph. The list keeps the given order.
const g: Record<string, unknown> = {};
vm.runInContext(readFileSync(new URL("../src/timeline/rail/assets/files-view.js", import.meta.url), "utf8"), vm.createContext(Object.assign(g, { globalThis: g })));
const FV = g.CoCheckFilesView as Record<string, (...a: unknown[]) => unknown>;
type E = { tag: string; attrs: Record<string, unknown>; kids: unknown[]; open?: boolean; append: (...k: unknown[]) => void; addEventListener: () => void; style: Record<string, unknown> };
const el = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]): E => { const e: E = { style: {}, tag, attrs, kids: kids.flat().filter((k) => k !== "" && k != null), append: (...k) => { e.kids.push(...k.flat()); }, addEventListener() {} }; return e; };
const walk = (e: E): E[] => [e, ...e.kids.filter((k) => typeof k !== "string").flatMap((k) => walk(k as E))];
const ver = (n: number) => Array.from({ length: n }, (_, i) => ({ lane: "main", kind: "created", at: i + 1, label: "x", stop: "s", change: "c", sha: "x", chip: "C", kept: true }));
const file = (name: string, n = 1, extra: Record<string, unknown> = {}) => ({ file: "/w/" + name, name, start: "none", versions: ver(n), ...extra });
const base = { el, chip: (l: string) => el("b", {}, l), name: (l: string) => l, color: () => "#000", pick() {} };
function paint(files: unknown[], sel: number, h: Record<string, unknown>): E[] {
  const box = { kids: [] as unknown[], textContent: "", append(...k: unknown[]) { box.kids.push(...k); } };
  FV.paintList(box, files, sel, { ...base, ...h });
  return box.kids as E[];
}
const order = (top: E[]): string[] => top.flatMap((k) => (k.tag ? walk(k) : [])).filter((x) => x.attrs?.["data-file"] !== undefined).map((x) => String(x.attrs["data-file"]));

describe("file row", () => {
  const rowOf = (f: unknown, h: Record<string, unknown> = {}) => paint([f], 0, h).flatMap((k) => (k.tag ? walk(k) : [])).find((x) => x.attrs?.["data-file"] === "0")!;
  const classes = (e: E) => walk(e).map((x) => String(x.attrs?.class ?? ""));
  it("has no mini strip, version count or lane dots: icon, name, one status glyph", () => {
    const row = rowOf(file("a.csv", 40));
    assert.equal(classes(row).filter((c) => /\b(mini|seg|dia|more|vv)\b/.test(c)).length, 0);
    assert.equal(walk(row).filter((x) => x.tag === "b").length, 0, "no actor chip on a file row");
    assert.equal(classes(row).filter((c) => /\bjm\b/.test(c)).length, 1);
  });
  it("the status glyph is an open circle when not reviewed, a check when passed, a cross when failed", () => {
    const glyph = (m: string | null) => walk(rowOf(file("a.csv", 2), { markOf: () => m })).find((x) => /\bjm\b/.test(String(x.attrs?.class ?? "")))!;
    assert.match(String(glyph(null).attrs.class), /\bopen\b/);
    assert.equal(glyph(null).attrs.title, "Not reviewed");
    assert.match(String(glyph("passed").attrs.class), /\bpass\b/);
    assert.match(String(glyph("failed").attrs.class), /\bfail\b/);
  });
  it("a file with the same bytes as another has no pill: the row carries the tooltip 'Identical to X'", () => {
    const row = rowOf(file("r-3.jpg", 1, { sameAs: "same bytes as slide-3.jpg (deck_assets)" }));
    assert.equal(row.attrs.title, "Identical to slide-3.jpg (deck_assets)");
    assert.ok(!classes(row).some((c) => /\bsame\b/.test(c)));
    assert.equal(walk(row).filter((x) => x.kids.includes("=")).length, 0);
  });
});

describe("list order", () => {
  const files = [file("a"), file("b"), file("c"), file("d"), file("e"), file("o", 1, { outside: true, ref: "r" })];
  const grp = (top: E[]) => top.filter((k) => k.tag === "details");
  it("the model order stands, with no verdict pill, line, or Not final products group", () => {
    const top = paint(files, 0, {});
    assert.deepEqual(order(top), ["0", "1", "2", "3", "4", "5"]);
    assert.deepEqual(grp(top).map((x) => x.attrs["data-group"]), ["outside"]);
    assert.equal(top.flatMap((k) => (k.tag ? walk(k) : [])).filter((x) => String(x.attrs?.class ?? "").match(/vchip|\bmv\b/)).length, 0);
  });
  it("a verdictOf hook from an old caller changes nothing", () => {
    const top = paint(files, 0, { verdictOf: () => ({ yes: false, p: 0.9 }) });
    assert.deepEqual(order(top), ["0", "1", "2", "3", "4", "5"]);
    assert.deepEqual(grp(top).map((x) => x.attrs["data-group"]), ["outside"]);
  });
});

describe("row pick", () => {
  it("a row picks Now (versions + 1)", () => {
    const picked: number[] = [];
    const top = paint([file("a.csv", 3)], 0, { pick: (_: number, p: number) => picked.push(p) });
    (top.flatMap((k) => (k.tag ? walk(k) : [])).find((x) => x.attrs?.["data-file"] === "0")!.attrs.onclick as () => void)();
    assert.deepEqual(picked, [4]);
  });
});
