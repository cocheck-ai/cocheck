// public-kit/spec/v1.md is held to the code: the fifteen examples (five marks at each of three levels) are executed, and the prose names the same
// marks, levels and anchor systems the check accepts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkChanges, MARKS, PICTURE_TYPES } from "../src/connector/changes-v1.ts";

const SPEC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public-kit", "spec", "v1.md"), "utf8");
const fences = [...SPEC.matchAll(/^```json (changes-(\w+)-(\d))\n([\s\S]*?)^```$/gm)].map((m) => ({ tag: m[1]!, mark: m[2]!, level: Number(m[3]), doc: JSON.parse(m[4]!) as { changes: Array<{ mark: string; boxes?: unknown[]; unplaced?: unknown }>; pictures?: unknown[] } }));

describe("v1 spec: examples are executed", () => {
  it("has exactly one tagged example per mark at each level (15), each valid and each at its tagged level and mark", () => {
    assert.equal(fences.length, 15);
    for (const mark of MARKS) for (const level of [1, 2, 3]) {
      const f = fences.filter((x) => x.mark === mark && x.level === level);
      assert.equal(f.length, 1, `${mark} level ${level}`);
      assert.ok(!("level" in f[0]!.doc), "the document carries no level");
      assert.deepEqual(f[0]!.doc.changes.map((c) => c.mark), [mark]);
      assert.deepEqual(checkChanges(f[0]!.doc, level as 1 | 2 | 3), [], f[0]!.tag);
    }
  });
  it("each level carries only what it may: level 1 no pictures, level 2 no boxes", () => {
    for (const f of fences) {
      if (f.level === 1) assert.equal(f.doc.pictures, undefined, f.tag);
      if (f.level < 3) for (const c of f.doc.changes) assert.ok(c.boxes === undefined && c.unplaced === undefined, f.tag);
    }
  });
});

describe("v1 spec: prose names what the check accepts", () => {
  it("every mark, picture type, anchor system and the three manifest fields", () => {
    for (const w of [...MARKS, ...PICTURE_TYPES, "pixels", "cells", "text", "none", "beforeReadMs", "openInProduct", "permissions"]) assert.ok(SPEC.includes("`" + w + "`"), w);
    assert.doesNotMatch(SPEC, /opens it as it is now/, "openInProduct is not drawn, so the spec does not promise a link");
    assert.match(SPEC, /1500/);
  });
});
