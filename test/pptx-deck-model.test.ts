import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { mediaChanges } from "../src/office/connector/shared/package-media.ts";
import { diffDecks, matchDeckSlides } from "../src/office/connector/pptx/diff.ts";
import { readDeck } from "../src/office/connector/pptx/reader.ts";
import { buildDeck, type DeckSpec, type SlideSpec } from "./pptx-deck-builder.ts";

/**
 * Deck model additions. Rows for hidden slides, layout, master, theme, transitions, media and the chart workbook, and one
 * slide-identity map (`matchDeckSlides`) that the row diff and the change-first boxes both read, so a label, a row, a box and the
 * before picture always name the same slide.
 */

const slide = (id: number, text: string, more: Partial<SlideSpec> = {}): SlideSpec => ({ id, text, ...more });
const rows = (a: DeckSpec, b: DeckSpec) => diffDecks(readDeck(buildDeck(a)), readDeck(buildDeck(b)));
const kinds = (a: DeckSpec, b: DeckSpec): string[] => rows(a, b).map((r) => `${r.location}|${r.kind}`);
const base = (): DeckSpec => ({ slides: [slide(256, "Alpha"), slide(257, "Beta")] });

test("an unchanged deck makes no model rows", () => {
  assert.deepEqual(kinds(base(), base()), []);
});

test("hidden: hiding and showing a slide are rows", () => {
  const h = base();
  h.slides[1] = slide(257, "Beta", { hidden: true });
  assert.deepEqual(kinds(base(), h), ["Slide 2 / Hidden|slide hidden"]);
  assert.deepEqual(kinds(h, base()), ["Slide 2 / Hidden|slide shown"]);
});

test("transition: a changed, added or removed transition is a row naming it", () => {
  const a = base(), b = base();
  a.slides[0] = slide(256, "Alpha", { transition: `<p:transition spd="med"><p:fade/></p:transition>` });
  b.slides[0] = slide(256, "Alpha", { transition: `<p:transition spd="slow"><p:push dir="u"/></p:transition>` });
  const r = rows(a, b);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.location, "Slide 1 / Transition");
  assert.equal(r[0]!.kind, "transition changed");
  assert.match(String(r[0]!.before), /fade/);
  assert.match(String(r[0]!.after), /push/);
  assert.deepEqual(kinds(base(), a), ["Slide 1 / Transition|transition changed"]);
});

test("layout, master, theme and media are covered by the media layer, paired by the same identity map", () => {
  const asRows = (x: DeckSpec, y: DeckSpec) => mediaChanges(".pptx", buildDeck(x), buildDeck(y)).map((c) => `${c.location}|${c.kind}|${c.detail ?? ""}`);
  assert.deepEqual(asRows(base(), { ...base(), layout: "Title and Content" }), ["Slide 1|slide changed|its layout changed", "Slide 2|slide changed|its layout changed"]);
  assert.deepEqual(asRows(base(), { ...base(), master: "Dark" }), ["Slide 1|slide changed|its master changed", "Slide 2|slide changed|its master changed"]);
  assert.ok(asRows(base(), { ...base(), theme: "Ion" }).some((r) => r.startsWith("Deck|theme changed")));
  const a = base(), b = base();
  a.slides[0] = slide(256, "Alpha", { media: ["PNG-ONE"] });
  b.slides[0] = slide(256, "Alpha", { media: ["PNG-TWO"] });
  assert.deepEqual(asRows(a, b), ["Slide 1|slide changed|a picture was replaced"]);
  assert.deepEqual(asRows(a, a), []);
});

test("media layer, renumbered ids that collide do not move a picture change onto the wrong slide", () => {
  const before: DeckSpec = { slides: [slide(256, "X", { media: ["PNG-X"] }), slide(257, "Y", { media: ["PNG-Y"] })] };
  const after: DeckSpec = { slides: [slide(256, "Y", { media: ["PNG-Y"] }), slide(257, "X", { media: ["PNG-X2"] })] };
  const got = mediaChanges(".pptx", buildDeck(before), buildDeck(after)).map((c) => `${c.location}|${c.detail}`);
  assert.deepEqual(got, ["Slide 2|a picture was replaced"]);
});

test("chart cache versus workbook: each divergence is its own row", () => {
  const mk = (workbook: string, values: string[]): DeckSpec => ({ slides: [slide(256, "Alpha", { chart: { workbook, values } })] });
  const wbOnly = kinds(mk("WB1", ["1", "2"]), mk("WB2", ["1", "2"]));
  assert.ok(wbOnly.some((k) => /chart workbook changed/.test(k) && k.includes("Chart 9")), `workbook edited, cache same: ${wbOnly.join(" ; ")}`);
  const cacheOnly = rows(mk("WB1", ["1", "2"]), mk("WB1", ["1", "3"]));
  assert.ok(cacheOnly.some((r) => r.kind === "chart value") && !cacheOnly.some((r) => r.kind === "chart workbook changed"), "cache edited, workbook same: only the value row");
  const both = rows(mk("WB1", ["1", "2"]), mk("WB2", ["1", "3"]));
  assert.ok(both.some((r) => r.kind === "chart workbook changed" && (r.detail as { cache: string }).cache === "changed"));
  assert.equal(wbOnly.length, 1);
  // a resave that only rewrites the workbook's properties and revision uids is not a change
  const resaved = (props: string): DeckSpec => ({ slides: [slide(256, "Alpha", { chart: { workbook: "WB1", values: ["1", "2"], props } })] });
  assert.deepEqual(kinds(resaved("A"), resaved("B")), []);
  assert.deepEqual(kinds(mk("WB1", ["1", "2"]), mk("WB1", ["1", "2"])), []);
});

test("notes and comments stay rows (reader unchanged)", () => {
  const a = base(), b = base();
  a.slides[0] = slide(256, "Alpha", { notes: "old note" });
  b.slides[0] = slide(256, "Alpha", { notes: "new note" });
  assert.ok(kinds(a, b).some((k) => k.startsWith("Slide 1 / Notes")));
});

// ---- the slide-identity map ----

const match = (a: DeckSpec, b: DeckSpec): Array<[number, number]> => [...matchDeckSlides(readDeck(buildDeck(a)), readDeck(buildDeck(b)))].sort((x, y) => x[0] - y[0]);

test("identity: a pure reorder pairs each slide with itself", () => {
  const a: DeckSpec = { slides: [slide(256, "A"), slide(257, "B"), slide(258, "C")] };
  const b: DeckSpec = { slides: [slide(258, "C"), slide(256, "A"), slide(257, "B")] };
  assert.deepEqual(match(a, b), [[0, 1], [1, 2], [2, 0]]);
});

test("identity: a duplicate pairs the original (same sldId) and the copy is added", () => {
  const a: DeckSpec = { slides: [slide(256, "A"), slide(257, "B")] };
  const b: DeckSpec = { slides: [slide(256, "A"), slide(300, "A"), slide(257, "B")] };
  assert.deepEqual(match(a, b), [[0, 0], [1, 2]]);
  const r = rows(a, b).map((x) => `${x.location}|${x.kind}`);
  assert.ok(r.includes("Slide 2|slide added"), r.join(";"));
});

test("identity: a duplicated original that was edited keeps its sldId pairing, the unedited copy is added", () => {
  const a: DeckSpec = { slides: [slide(256, "A")] };
  const b: DeckSpec = { slides: [slide(256, "A edited"), slide(300, "A")] };
  assert.deepEqual(match(a, b), [[0, 0]]);
});

test("identity: ids renumbered by a tool collide across slides; content, not the colliding id, decides", () => {
  const a: DeckSpec = { slides: [slide(256, "X"), slide(257, "Y")] };
  const b: DeckSpec = { slides: [slide(256, "Y"), slide(257, "X")] };
  assert.deepEqual(match(a, b), [[0, 1], [1, 0]]);
});

test("identity: two identical slides and a delete pair by sldId first, then in order", () => {
  const a: DeckSpec = { slides: [slide(256, "T"), slide(257, "T"), slide(258, "U")] };
  const b: DeckSpec = { slides: [slide(257, "T"), slide(258, "U")] };
  assert.deepEqual(match(a, b), [[1, 0], [2, 1]]);
});

test("identity: reviewer case - S1 deleted, S2 edited, ids renumbered by position: no guessed edit, removed plus added", () => {
  const ids = (xs: string[], f: number): SlideSpec[] => xs.map((t, i) => slide(f + i, t));
  const a: DeckSpec = { slides: ids(["S0 body", "S1 body", "S2 body", "S3 body", "S4 body"], 256) };
  const b: DeckSpec = { slides: ids(["S0 body", "S2 edited", "S3 body", "S4 body"], 256) };
  assert.deepEqual(match(a, b), [[0, 0], [3, 2], [4, 3]]);
  const mc = mediaChanges(".pptx", buildDeck(a), buildDeck(b)).map((c) => `${c.location}|${c.kind}`);
  assert.ok(!mc.includes("Slide 2|slide changed"), mc.join(";"));
});

test("identity: ids kept, original deleted and its copy remains: ids stay trusted, a neighbour's edit is still an edit", () => {
  const a: DeckSpec = { slides: [slide(256, "A"), slide(257, "B")] };
  const b: DeckSpec = { slides: [slide(900, "A"), slide(257, "B edited")] };
  assert.deepEqual(match(a, b), [[0, 0], [1, 1]]);
});

test("identity: blank twins - 257 deleted, 256 edited: the edit pairs as an edit (shared content is no proof of renumbering)", () => {
  const a: DeckSpec = { slides: [slide(256, "Alpha"), slide(257, ""), slide(258, "")] };
  const b: DeckSpec = { slides: [slide(256, "Alpha edited"), slide(258, "")] };
  assert.deepEqual(match(a, b), [[0, 0], [2, 1]]);
  const r = kinds(a, b);
  assert.deepEqual(r.filter((k) => k.endsWith("slide added")), [], r.join(";"));
  assert.deepEqual(r.filter((k) => k.endsWith("slide removed")), ["Slide 2|slide removed"], r.join(";"));
});

test("identity: unique slides renumbered beside blank twins still make ids untrusted, no pair joins different origins", () => {
  const a: DeckSpec = { slides: [slide(256, "U body"), slide(257, ""), slide(258, ""), slide(259, "V body"), slide(260, "W body")] };
  const b: DeckSpec = { slides: [slide(256, "V body"), slide(257, ""), slide(258, ""), slide(259, "U body"), slide(260, "W edited")] };
  assert.deepEqual(match(a, b), [[0, 3], [1, 1], [2, 2], [3, 0]]);
});

test("identity: unreadable deck fallback never pairs by sldId when ids are untrusted", () => {
  const a = buildDeck({ slides: [slide(256, "S0"), slide(257, "S1"), slide(258, "S2"), slide(259, "S3")] });
  const b = buildDeck({ slides: [slide(256, "S0"), slide(257, "S2 edited"), slide(258, "S3")] });
  // slide 256 (the same on both sides) has no shape tree: readDeck throws while the media layer still reads the package
  const strip = (x: Buffer): Buffer => {
    const files = unzipSync(x);
    files["ppt/slides/slide256.xml"] = strToU8(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`);
    return Buffer.from(zipSync(files));
  };
  assert.throws(() => readDeck(strip(a)));
  const mc = mediaChanges(".pptx", strip(a), strip(b)).map((c) => `${c.location}|${c.kind}`);
  assert.ok(!mc.includes("Slide 2|slide changed"), mc.join(";"));
});

// ---- the property test: random reorder, duplicate, delete keep label, row, box and before picture consistent ----

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const keyOf = (text: string): string => text.split(" ")[0]!;

interface Made { before: DeckSpec; after: DeckSpec; origin: Array<number | null>; renumbered: boolean }

function make(rand: () => number, renumbered: boolean): Made {
  const n = 3 + Math.floor(rand() * 6);
  const before: DeckSpec = { slides: Array.from({ length: n }, (_, k) => slide(256 + k, `K${k} body`)) };
  let cur: Array<{ spec: SlideSpec; origin: number | null }> = before.slides.map((s, k) => ({ spec: s, origin: k }));
  let nextId = 900;
  const ops = 1 + Math.floor(rand() * 5);
  for (let o = 0; o < ops; o++) {
    const kind = Math.floor(rand() * 3);
    if (kind === 0 && cur.length > 1) cur.splice(Math.floor(rand() * cur.length), 1);
    else if (kind === 1) {
      const i = Math.floor(rand() * cur.length);
      const src = cur[i]!;
      cur.splice(Math.floor(rand() * (cur.length + 1)), 0, { spec: { ...src.spec, id: nextId++ }, origin: null });
    } else {
      const a = Math.floor(rand() * cur.length), b = Math.floor(rand() * cur.length);
      [cur[a], cur[b]] = [cur[b]!, cur[a]!];
    }
  }
  if (!renumbered) {
    // edits are only made where ids are trusted: an original (origin set) gets new text but keeps its key and id
    cur = cur.map((c) => (c.origin !== null && rand() < 0.3 ? { ...c, spec: { ...c.spec, text: `${keyOf(c.spec.text)} edited` } } : c));
  }
  let after = cur.map((c) => c.spec);
  // a moved text box on some slides: no content change, so only the geometry pass (which needs the right before slide) sees it
  after = after.map((s) => (rand() < 0.4 ? { ...s, dx: 1200000 } : s));
  if (renumbered) after = after.map((s, i) => ({ ...s, id: 256 + i }));
  return { before, after: { slides: after }, origin: cur.map((c) => c.origin), renumbered };
}

test("property: random reorder, duplicate and delete pair each slide with its own before slide (seed 442, 300 runs, ids kept and ids renumbered)", async () => {
  const rand = rng(442);
  for (let run = 0; run < 300; run++) {
    const renumbered = run % 2 === 1;
    const m = make(rand, renumbered);
    const bB = buildDeck(m.before), bA = buildDeck(m.after);
    const keysB = m.before.slides.map((s) => keyOf(s.text)), keysA = m.after.slides.map((s) => keyOf(s.text));
    const ctx = `run ${run} ${renumbered ? "renumbered" : "ids kept"} before=${keysB} after=${keysA}`;
    const paired = new Map<number, number>(); // after idx -> before idx
    for (const [i, j] of matchDeckSlides(readDeck(bB), readDeck(bA))) paired.set(j, i);
    // 1. the map never pairs two slides with different keys
    for (const [j, i] of paired) assert.equal(keysA[j], keysB[i], `${ctx}: map paired ${keysB[i]} with ${keysA[j]}`);
    // 2. ids kept: the map is exactly the id truth (original keeps its sldId, a copy is added)
    if (!renumbered) {
      m.origin.forEach((o, j) => {
        // a copy (new sldId) is never paired while its original is still in the deck; it may take the place of a deleted original (identical content)
        if (o === null) assert.ok(!paired.has(j) || !m.origin.includes(Number(keysA[j]!.slice(1))), `${ctx}: a copy at ${j} was paired while its original is present`);
        else assert.equal(paired.get(j), o, `${ctx}: original at ${j} lost its before slide`);
      });
    } else {
      // renumbered: a maximum matching by content
      const count = (ks: string[], k: string): number => ks.filter((x) => x === k).length;
      for (const k of new Set([...keysB, ...keysA])) assert.equal([...paired].filter(([j]) => keysA[j] === k).length, Math.min(count(keysB, k), count(keysA, k)), `${ctx}: not a full matching for ${k}`);
    }
  }
});
