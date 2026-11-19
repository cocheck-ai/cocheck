import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stopIdentities, summarize } from "../src/timeline/rail/stop-status.ts";
import { buildSendBack, failedStopDetail, type RegionPrompt } from "../src/timeline/rail/send-back.ts";
import type { RegionRef } from "../src/timeline/rail/regions.ts";

// "Reviewer pointed at:" lines in the send-back prompt. Guarded against: the prompt never names a picture path that is not on disk
// at build time, and a send-back with no regions is byte-identical to today's.

const change = (id: string, file: string, rows: Array<{ location: string; text: string }>): any => ({
  id, file, kind: "modified", before: { sha256: `b${id}` }, after: { sha256: `a${id}` }, note: { text: `Changed ${file}.`, source: "rule" },
  format: rows.length === 0 ? null : { module: "xlsx", rows: rows.map((r) => ({ ...r, kind: "value", before: null, after: null })), more: 0 }, 
});
const stopOf = (c: any): any => ({ id: `chg-${c.id}`, label: path.basename(c.file), head: `Claude changed ${c.file}`, lane: "main", change: { key: c.id, file: c.file, kind: c.kind, note: c.note.text, rowNotes: [], secret: false } });

function fixture(failures: Record<string, string>) {
  const a = change("c1", "/work/budget.xlsx", [{ location: "Sheet1!B2", text: "B2 went from 10 to 12" }]);
  const c = change("c3", "/work/slides.pdf", [{ location: "page 3", text: "Page 3 text changed" }]);
  const timeline: any = { unplaced: [a, c], requests: [] };
  const model: any = { task: 7, folder: "/work", actors: [], stops: [stopOf(a), stopOf(c)] };
  const ids = stopIdentities(model, timeline);
  const rows = Object.entries(failures).map(([stop, note], i) => ({ id: i + 1, taskId: 7, stopId: stop, subject: ids.get(stop)!.subject, fingerprint: ids.get(stop)!.fingerprint, status: "failed" as const, note, reviewer: "t", ts: "2026-10-12T00:00:00.000Z" }));
  return { model, timeline, summary: summarize(model, timeline, rows) };
}

const dir = mkdtempSync(path.join(tmpdir(), "cocheck-"));
const png = path.join(dir, "7.png");
writeFileSync(png, "x");
const ref = (over: Partial<RegionRef>): RegionRef => ({ id: 1, stop: null, where: "page 3 of the after version", lines: [], picture: null, ...over });
const none: RegionPrompt = { byStop: new Map(), overall: [] };

describe("region lines in the prompt", () => {
  it("a send-back with no regions is byte-identical, with the argument absent, empty, or an empty map", () => {
    const f = fixture({ "chg-c1": "wrong", "chg-c3": "also" });
    const base = buildSendBack(f.model, f.timeline, f.summary, "keep it short");
    assert.deepEqual(buildSendBack(f.model, f.timeline, f.summary, "keep it short", none), base);
    assert.doesNotMatch(base.prompt, /Reviewer pointed at/);
  });

  it("prints a picture region under its step's note with the absolute path", () => {
    const f = fixture({ "chg-c3": "wrong page" });
    const out = buildSendBack(f.model, f.timeline, f.summary, "", { byStop: new Map([["chg-c3", [ref({ stop: "chg-c3", picture: png })]]]), overall: [] });
    assert.match(out.prompt, new RegExp(`Reviewer's note: wrong page\\n   Reviewer pointed at: page 3 of the after version, picture ${png.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`.replace(/\\n$/, "$")));
  });

  it("a picture path that is not on disk is never named; the locator alone prints", () => {
    const f = fixture({ "chg-c3": "wrong page" });
    const gone = path.join(dir, "gone.png");
    const out = buildSendBack(f.model, f.timeline, f.summary, "", { byStop: new Map([["chg-c3", [ref({ stop: "chg-c3", picture: gone })]]]), overall: [ref({ picture: gone })] });
    assert.ok(!out.prompt.includes("gone.png") && !out.prompt.includes("picture "));
    assert.match(out.prompt, /Reviewer pointed at: page 3 of the after version$/m);
  });

  it("cells and lines are followed by their text; lists cap at 25 and the rest is counted", () => {
    const f = fixture({ "chg-c1": "wrong" });
    const lines = Array.from({ length: 30 }, (_, i) => `B${i}: v${i}`);
    const out = buildSendBack(f.model, f.timeline, f.summary, "", { byStop: new Map([["chg-c1", [ref({ stop: "chg-c1", where: "Sheet1!B0:B29 in the after version", lines })]]]), overall: [] });
    assert.match(out.prompt, /Reviewer pointed at: Sheet1!B0:B29 in the after version\n {5}- B0: v0\n/);
    assert.ok(out.prompt.includes("B24: v24") && !out.prompt.includes("B25: v25"));
    assert.match(out.prompt, /5 more lines are not listed/);
  });

  it("regions of a stop that is not failed are not printed; overall regions go under Overall note, also when no stop failed", () => {
    const f = fixture({});
    const out = buildSendBack(f.model, f.timeline, f.summary, "see this", { byStop: new Map([["chg-c1", [ref({ stop: "chg-c1" })]]]), overall: [ref({ id: 2, where: "Sheet1!A1 in the after version" })] });
    assert.equal(out.prompt, "I reviewed your work on task 7.\n\nOverall note: see this\nReviewer pointed at: Sheet1!A1 in the after version");
  });

  it("at most 25 regions per note, the rest counted", () => {
    const f = fixture({});
    const overall = Array.from({ length: 27 }, (_, i) => ref({ id: i + 1, where: `spot ${i}` }));
    const out = buildSendBack(f.model, f.timeline, f.summary, "n", { byStop: new Map(), overall });
    assert.equal(out.prompt.split("\n").filter((l) => l.startsWith("Reviewer pointed at:")).length, 25);
    assert.match(out.prompt, /2 more regions are not listed/);
  });

  it("failedStopDetail carries the same lines the prompt prints", () => {
    const f = fixture({ "chg-c3": "wrong page" });
    const regions = [ref({ stop: "chg-c3", picture: png })];
    const d = failedStopDetail(f.model, f.timeline, f.summary.failed[0]!, regions);
    const out = buildSendBack(f.model, f.timeline, f.summary, "", { byStop: new Map([["chg-c3", regions]]), overall: [] });
    assert.equal(d.regions.length, 1);
    assert.ok(out.prompt.includes(d.regions[0]!));
    assert.deepEqual(failedStopDetail(f.model, f.timeline, f.summary.failed[0]!).regions, []);
  });
});
