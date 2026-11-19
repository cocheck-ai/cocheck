// The v1 change-document check (src/connector/changes-v1.ts) and the v1 manifest additions. Every reject is a mutation of a REAL converted
// fixture (test/fixtures/spec-v1, hand-converted from the nine migration pairs), so the check is held to both failure directions: loose enough
// to pass a mismatched anchor, or too strict for the real pairs.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { PAIRS } from "./helpers/connector-migration.ts";
import { beforeReadMsOf, checkManifest, DEFAULT_BEFORE_READ_MS } from "../src/connector/schema.ts";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "spec-v1");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;
const load = (name: string): Doc => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8"));
const fields = (d: unknown) => checkChanges(d).map((p) => p.field);

describe("v1 fixtures: the nine real pairs are valid at level 3 (the level is the connector's, passed to the check; no fixture carries one)", () => {
  it("there is one fixture per pair and each has zero problems", () => {
    assert.deepEqual(readdirSync(DIR).filter((f) => f.endsWith(".json")).sort(), PAIRS.map((p) => `${p.name}.json`).sort());
    for (const p of PAIRS) {
      const d = load(p.name);
      assert.ok(!("level" in d), p.name);
      for (const pic of d.pictures ?? []) assert.ok(!("system" in pic), p.name);
      for (const c of d.changes) for (const b of c.boxes ?? []) assert.ok(!("side" in b), p.name);
      assert.deepEqual(checkChanges(d, 3), [], p.name);
    }
  });
});

describe("v1 rejects (each a mutation of a real fixture, naming the field path)", () => {
  const cells = () => load("xlsx-value-edit"); // grid pictures, cell boxes
  const pixels = () => load("docx-W6"); // image pictures, rect + highlights boxes, both sides at changes[1]

  it("a real fixture mutated nowhere is clean (the baseline the mutations start from)", () => {
    assert.deepEqual(checkChanges(cells()), []);
    assert.deepEqual(checkChanges(pixels()), []);
  });

  it("rect off a cells picture", () => { const d = cells(); d.changes[0].boxes[0].rect = { x: 1, y: 2, w: 3, h: 4 }; assert.deepEqual(fields(d), ["changes[0].boxes[0].rect"]); });
  it("highlights off a cells picture", () => { const d = cells(); d.changes[0].boxes[0].highlights = [{ x: 1, y: 2, w: 3, h: 4 }]; assert.deepEqual(fields(d), ["changes[0].boxes[0].highlights"]); });
  it("cell off a pixels picture", () => { const d = pixels(); d.changes[0].boxes[0].cell = "B3"; assert.deepEqual(fields(d), ["changes[0].boxes[0].cell"]); });
  it("lines off a pixels picture", () => { const d = pixels(); d.changes[0].boxes[0].lines = { from: 1, to: 2 }; assert.deepEqual(fields(d), ["changes[0].boxes[0].lines"]); });
  it("range off a cells picture", () => { const d = cells(); d.changes[0].boxes[0].range = { line: 1, start: 0, end: 3 }; assert.deepEqual(fields(d), ["changes[0].boxes[0].range"]); });
  it("lines off a cells picture", () => { const d = cells(); d.changes[0].boxes[0].lines = { from: 1, to: 2 }; assert.deepEqual(fields(d), ["changes[0].boxes[0].lines"]); });
  it("a pixels box on a text picture", () => {
    const d = pixels();
    for (const p of d.pictures) p.type = "text";
    assert.ok(fields(d).includes("changes[0].boxes[0].rect"));
  });
  it("any box on an html picture (a rect on it, and a cell on it)", () => {
    const d = pixels();
    for (const p of d.pictures) p.type = "html";
    assert.ok(fields(d).includes("changes[0].boxes[0].rect"));
    const g = cells();
    for (const p of g.pictures) p.type = "html";
    assert.ok(fields(g).includes("changes[0].boxes[0].cell"));
  });
  it("a picture's system and a box's side are not fields: stale ones are ignored, never an error", () => { const d = pixels(); d.pictures[0].system = "cells"; d.changes[0].boxes[0].side = "nowhere"; d.level = 9; assert.deepEqual(fields(d), []); });
  it("a box sits on its picture, whichever side that is: the box takes the picture's side", () => { const d = pixels(); const other = d.pictures.find((p: Doc) => p.id !== d.changes[1].boxes[0].picture); d.changes[1].boxes[0].picture = other.id; assert.deepEqual(fields(d), []); });
  it("a box naming a picture that does not exist", () => { const d = cells(); d.changes[0].boxes[0].picture = "nope"; assert.deepEqual(fields(d), ["changes[0].boxes[0].picture"]); });
  it("a box above the connector's level (the level-3 fixture checked at 2, and 1)", () => {
    for (const lv of [2, 1] as const) assert.ok(checkChanges(cells(), lv).some((p) => p.field === "changes[0].boxes"), `level ${lv}`);
  });
  it("unplaced above level 3", () => { assert.ok(checkChanges(load("docx-W16"), 2).some((p) => p.field === "changes[1].unplaced")); });
  it("a picture above the connector's level (the level-3 fixture checked at 1)", () => { assert.ok(checkChanges(cells(), 1).some((p) => p.field === "pictures")); });
  it("an unknown mark", () => { const d = cells(); d.changes[1].mark = "edited"; assert.deepEqual(fields(d), ["changes[1].mark"]); });
  it("a duplicate change id", () => { const d = cells(); d.changes[1].id = d.changes[0].id; assert.deepEqual(fields(d), ["changes[1].id"]); });
  it("a duplicate picture id", () => { const d = cells(); d.pictures[1].id = d.pictures[0].id; assert.ok(fields(d).includes("pictures[1].id")); });
  it("a parent that names no change", () => { const d = load("pptx-R9"); d.changes[1].parent = "k99"; assert.deepEqual(fields(d), ["changes[1].parent"]); });
  it("a wrong spec", () => { const d = cells(); d.spec = "x"; assert.deepEqual(fields(d), ["spec"]); });
  it("a box with no anchor at all", () => { const d = cells(); delete d.changes[0].boxes[0].cell; assert.deepEqual(fields(d), ["changes[0].boxes[0]"]); });
});

describe("v1 accepts a text picture with line anchors (no real pair has one)", () => {
  const doc = (anchor: Record<string, unknown>): Doc => ({
    spec: "cocheck.changes/1",
    pictures: [{ id: "after:t", side: "after", type: "text" }],
    changes: [{ id: "k1", mark: "added", label: "lines 3-4", boxes: [{ picture: "after:t", ...anchor }] }],
  });
  it("lines and range pass; a malformed range fails", () => {
    assert.deepEqual(checkChanges(doc({ lines: { from: 3, to: 4 } })), []);
    assert.deepEqual(checkChanges(doc({ range: { line: 3, start: 0, end: 5 } })), []);
    assert.deepEqual(fields(doc({ range: { line: 3, start: 5, end: 1 } })), ["changes[0].boxes[0].range"]);
    assert.deepEqual(fields(doc({ lines: { from: 4, to: 3 } })), ["changes[0].boxes[0].lines"]);
  });
});

describe("v1 manifest additions", () => {
  const base = { spec: "cocheck.connector/1", id: "toy", version: "0.1.0", entry: "both", matches: { extensions: [".x"] }, run: ["node", "c.mjs"] };
  it("beforeReadMs accepts integers 0..3000 and rejects 3001, non-integers, strings, negatives", () => {
    for (const ok of [0, 1500, 3000]) assert.deepEqual(checkManifest({ ...base, beforeReadMs: ok }), [], String(ok));
    for (const bad of [3001, 1.5, "1500", -1, null]) assert.deepEqual(checkManifest({ ...base, beforeReadMs: bad }).map((p) => p.field), ["beforeReadMs"], String(bad));
  });
  it("the helper defaults to 1500 and returns a set value", () => {
    assert.equal(DEFAULT_BEFORE_READ_MS, 1500);
    assert.equal(beforeReadMsOf(base), 1500);
    assert.equal(beforeReadMsOf({ ...base, beforeReadMs: 0 }), 0);
    assert.equal(beforeReadMsOf({ ...base, beforeReadMs: 2500 }), 2500);
  });
  it("openInProduct is not part of v1: a manifest that has it is refused", () => {
    assert.deepEqual(checkManifest({ ...base, openInProduct: { url: "https://x.example/p" } }).map((p) => p.field), ["openInProduct"]);
  });
  it("permissions: env is a list of strings; network and files are not part of v1", () => {
    assert.deepEqual(checkManifest({ ...base, permissions: { env: ["TOKEN"] } }), []);
    assert.deepEqual(checkManifest({ ...base, permissions: { network: ["api.x.example"], files: true } }).map((p) => p.field), ["permissions.network", "permissions.files"]);
    assert.deepEqual(checkManifest({ ...base, permissions: {} }), []);
    assert.deepEqual(checkManifest({ ...base, permissions: { env: "TOKEN" } }).map((p) => p.field), ["permissions.env"]);
    assert.deepEqual(checkManifest({ ...base, permissions: [] }).map((p) => p.field), ["permissions"]);
  });
});
