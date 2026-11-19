import { describe, it } from "node:test";
import assert from "node:assert/strict";
await import(new URL("../src/timeline/rail/assets/view-table.js", import.meta.url).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const VT = (globalThis as any).CoCheckViewTable;

// Clauses 3 and 4: a made change document (cocheck.changes/1 plus envelope source) is drawn by level with the source wording; the card view has a
// tally line, children grouped under their parent, and a coverage line. Documents are built here; the served document carries `source` in the served document.

const ch = (id: string, mark: string, extra: Record<string, unknown> = {}) => ({ id, mark, label: `Item ${id}`, kind: "value", ...extra });
const doc = (level: number, source: unknown, changes: unknown[], pictures: unknown[] = [], extra: Record<string, unknown> = {}) => ({ spec: "cocheck.changes/1", changes, pictures, caveats: [], engine: "x", file: "f", kind: "card", ...(source === undefined ? {} : { source }), ...extra });
const textPic = (id: string, side: string, name = "P") => ({ id, side, type: "text", label: name, private: { text: { lines: [{ n: 1, text: "hello" }] } } });
const box = (picture: string, side: string, line = 1) => ({ side, picture, lines: { from: line, to: line } });

describe("(3) source wording and level drawing", () => {
  it("the four wordings", () => {
    assert.equal(VT.sourceLine({ by: "connector", name: "notion", level: 1 }), "Change list from notion");
    assert.equal(VT.sourceLine({ by: "connector", name: "notion", level: 2 }), "", "no renderedBy, no line (never the internal id)");
    assert.equal(VT.sourceLine({ by: "connector", name: "notion", level: 3 }, [{ renderedBy: { tool: "Notion", version: "1", os: "web" } }]), "Drawn by Notion", "the picture's renderedBy.tool");
    assert.equal(VT.sourceLine({ by: "connector", name: "microsoft-powerpoint", level: 3 }, [{}]), "", "never the connector id");
    assert.equal(VT.sourceLine({ by: "cocheck", name: "CoCheck", level: 3 }), "Drawn by CoCheck from the text");
    assert.equal(VT.sourceLine({ by: "cocheck", name: "notion", level: 3 }), "Drawn by CoCheck from the text");
  });
  it("level 1 draws cards only; level 2 pictures unboxed; level 3 boxes; the page never draws more than the envelope or the document claims", () => {
    const pics = [textPic("b", "before"), textPic("a", "after")];
    const changes = [ch("c1", "changed", { boxes: [box("a", "after"), box("b", "before")] })];
    const l1 = VT.sceneOf(doc(1, { by: "connector", name: "n", level: 1 }, changes, pics));
    assert.deepEqual([l1.before.length, l1.after.length, l1.marks.length, l1.items.length], [0, 0, 0, 1]);
    const l2 = VT.sceneOf(doc(2, { by: "connector", name: "n", level: 2 }, changes, pics));
    assert.deepEqual([l2.before.length, l2.after.length, l2.marks.length], [1, 1, 0]);
    const l3 = VT.sceneOf(doc(3, { by: "connector", name: "n", level: 3 }, changes, pics));
    assert.deepEqual([l3.before.length, l3.after.length, l3.marks.length], [1, 1, 2]);
    const claimed2 = VT.sceneOf(doc(3, { by: "connector", name: "n", level: 2 }, changes, pics));
    assert.equal(claimed2.marks.length, 0, "the envelope claims level 2: no boxes");
    assert.equal(VT.sceneOf(doc(3, undefined, changes, pics)).marks.length, 2, "no source: drawn as level 3 (the level is the connector's, never the document's)");
    assert.equal(l3.source.text, "", "no renderedBy on these pictures: no line, never the id");
  });
  it("an html picture shows in the sandboxed frame address only, unboxed; any other src is not framed", () => {
    const ok = "http://127.0.0.1:4455/v/0123456789abcdef0123456789abcdef";
    const s = VT.sceneOf(doc(3, { by: "connector", name: "n", level: 3 }, [ch("c1", "changed", { boxes: [] })], [{ id: "h", side: "after", type: "html", src: ok }]));
    assert.equal(s.after[0].frame, ok);
    const bad = VT.sceneOf(doc(3, { by: "connector", name: "n", level: 3 }, [], [{ id: "h", side: "after", type: "html", src: "https://evil.example/x" }]));
    assert.equal(bad.after[0].frame, undefined);
    assert.equal(VT.describePane(s.after[0], [], "after").kind, "frame");
  });
  it("a source that is malformed is not drawn; a document with no source (Office today) gets none", () => {
    for (const bad of [{ by: "x", name: "n", level: 1 }, { by: "connector", name: "", level: 1 }, { by: "connector", name: "n", level: 4 }, "connector"]) assert.equal(VT.sceneOf(doc(1, bad, [])).source, undefined);
    assert.equal(VT.sceneOf(doc(3, undefined, [])).source, undefined);
    assert.equal(VT.sceneOf(doc(3, undefined, [])).level, 3);
  });
});

describe("(4) the card view: tally, groups, coverage", () => {
  it("tally: '3 changed, 1 added', most first, no regions", () => {
    assert.equal(VT.tallyLine([ch("1", "changed"), ch("2", "added"), ch("3", "changed"), ch("4", "changed"), ch("r", "changed", { private: { kind: "region" } })], true), "3 changed, 1 added");
    assert.equal(VT.tallyLine([ch("r", "changed", { kind: "region", private: { kind: "region" } })]), "1 changed", "a stranger's kind or private hint is not read");
    assert.equal(VT.tallyLine([]), "");
  });
  it("children sit under their parent; a missing parent or a cycle leaves the change at the top", () => {
    const g = VT.groupChanges([ch("p", "changed"), ch("k1", "added", { parent: "p" }), ch("k2", "added", { parent: "p" }), ch("o", "added", { parent: "gone" }), ch("a", "added", { parent: "b" }), ch("b", "added", { parent: "a" })]);
    assert.deepEqual(g.map((x: { change: { id: string } }) => x.change.id), ["p", "o", "a", "b"]);
    assert.deepEqual(g[0].children.map((x: { change: { id: string } }) => x.change.id), ["k1", "k2"]);
  });
  it("coverage: '2 changes have no place in the picture' only where the picture can place (level 3 with a picture); a child inside its parent's box is placed", () => {
    const pics = [textPic("a", "after")];
    const changes = [ch("p", "changed", { boxes: [box("a", "after")] }), ch("k", "added", { parent: "p" }), ch("x", "added"), ch("y", "added")];
    assert.equal(VT.coverageLine(doc(3, { by: "connector", name: "n", level: 3 }, changes, pics)), "2 changes have no place in the picture");
    assert.equal(VT.coverageLine(doc(3, { by: "connector", name: "n", level: 3 }, [changes[0], changes[2]], pics)), "1 change has no place in the picture");
    assert.equal(VT.coverageLine(doc(3, { by: "connector", name: "n", level: 3 }, [changes[0], changes[1]], pics)), "");
    assert.equal(VT.coverageLine(doc(2, { by: "connector", name: "n", level: 2 }, changes, pics)), "", "level 2 boxes nothing, so nothing is unplaced");
    assert.equal(VT.coverageLine(doc(1, { by: "connector", name: "n", level: 1 }, changes)), "");
  });
});

// ---- the page, drawn from a document ----
import { drawn } from "./helpers/made-page.ts";

describe("page: a level 1 connector row is cards only, with the tally and the grouped children", () => {
  const changes = [ch("p", "changed", { label: "Page A", after: "new title" }), ch("k", "added", { parent: "p", label: "Block 1", text: "a new block" }), ch("q", "changed", { label: "Page B" })];
  it("source line, tally line, parent card holding its child card, no picture, stage hidden", async () => {
    const p = await drawn(doc(1, { by: "connector", name: "notion", level: 1 }, changes, [], { kind: "card" }));
    const text = p.byId("bodyview").textContent;
    assert.ok(p.details().includes("Change list from notion"));
    assert.ok(p.details().includes("2 changed, 1 added"));
    assert.ok(!/Change list from|2 changed, 1 added/.test(text), "the source and tally lines are Details notes (fix/notes-panel)");
    assert.ok(text.indexOf("Page A") < text.indexOf("Block 1") && text.indexOf("Block 1") < text.indexOf("Page B"), "the child sits under its parent, before the next card");
    assert.equal(p.byId("bodyview").hidden, false);
    assert.equal(p.byId("stage").hidden, true);
    const parent = p.byId("bodyview").descendants().find((n) => n.className.includes("cvcard") && !n.className.includes("child") && n.textContent.includes("Page A"))!;
    assert.ok(parent.descendants().some((n) => n.className.includes("child") && n.textContent.includes("Block 1")));
  });
  it("a level 3 made picture: the source and tally lines and each change with no place are Details notes (fix/notes-panel), nothing over the stage", async () => {
    const pics = [textPic("a", "after")];
    const p = await drawn(doc(3, { by: "connector", name: "notion", level: 3 }, [ch("p", "changed", { boxes: [box("a", "after")] }), ch("x", "added"), ch("y", "added")], pics, { kind: "text" }));
    const line = p.byId("viewline");
    assert.equal(line.hidden, true);
    const d = p.details();
    assert.ok(!d.includes("notion's") && !d.includes("Picture from") && d.includes("2 added, 1 changed"), d);
    assert.equal(d.split("\n").filter((l) => l.startsWith("unplaced ")).length, 2, d);
  });
  it("DANGEROUS DIRECTION: connector text is text, never markup; a document with no source draws no source line", async () => {
    const p = await drawn(doc(1, { by: "connector", name: "n<b>", level: 1 }, [ch("p", "changed", { label: "<img src=x onerror=1>" })]));
    assert.ok(p.all.every((n) => !(n.tag === "img" && n.attrs.src === "x") && n.attrs.onerror === undefined));
    assert.ok(p.byId("bodyview").textContent.includes("<img src=x onerror=1>"));
    const none = await drawn(doc(3, undefined, [ch("p", "changed")]));
    assert.equal(none.byId("viewline").hidden, true);
  });
});

import { finishPictures } from "../src/timeline/rail/made-pictures.ts";
describe("serve boundary: pictures finished from the stored states", () => {
  it("a text picture gets its side's lines; an html picture with a data:text/html src is minted into the frame, any other src is dropped", () => {
    const minted: string[] = [];
    const d = finishPictures(doc(3, { by: "connector", name: "n", level: 3 }, [], [
      { id: "a", side: "after", type: "text", system: "text" },
      { id: "h", side: "after", type: "html", src: "data:text/html," + encodeURIComponent("<p>hi</p>") },
      { id: "h2", side: "before", type: "html", src: "file:///etc/passwd" },
    ]) as never, { before: null, after: Buffer.from("one\ntwo\n"), mint: (h) => { minted.push(h); return "http://127.0.0.1:1/v/" + "a".repeat(32); } });
    const ps = d.pictures as unknown as Array<{ id: string; src?: string; private?: { text: { lines: unknown[] } } }>;
    assert.deepEqual(ps[0]!.private!.text.lines, [{ n: 1, text: "one" }, { n: 2, text: "two" }]);
    assert.deepEqual(minted, ["<p>hi</p>"]);
    assert.match(ps[1]!.src!, /^http:\/\/127\.0\.0\.1:1\/v\/a{32}$/);
    assert.equal(ps[2]!.src, undefined, "DANGEROUS DIRECTION: a connector-named path is never passed on");
  });
});
