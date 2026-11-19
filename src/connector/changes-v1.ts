// Hand-written check for a connector v1 change document (public-kit/spec/v1.md): { spec, changes, pictures?, caveats? }.
// Level 1 is a change list, level 2 adds pictures, level 3 adds anchors (boxes) on those pictures. The level is the connector's own (its hello), passed in; the
// document does not carry one. A picture's anchor system follows from its type and a box's side is its picture's side, so neither is a field. No JSON Schema library.
import { Collector, isObj, isStr, type Obj, type Problem } from "./schema.ts";
// The spec constant is the published kit helper (public-kit/helpers/spec.mjs), so core and outside connectors read one value.
import { CHANGES_SPEC } from "../../public-kit/helpers/spec.mjs";

export { CHANGES_SPEC };

export const CHANGES_FILE = "<changes>";
export const MARKS = ["added", "removed", "changed", "moved", "described"] as const;
export const SIDES = ["before", "after"] as const;
export const PICTURE_TYPES = ["image", "grid", "text", "html"] as const;
/** The anchor system of each picture type (a picture's system is never written down: it follows from its type). */
export const SYSTEM_OF_TYPE: Record<string, string> = { image: "pixels", grid: "cells", text: "text", html: "none" };

const quote = (list: readonly string[]) => list.map((s) => `"${s}"`).join(", ");
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isRect = (v: unknown): boolean => isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.w) && isNum(v.h);
/** Optional picture flags: the side has no such page, the page was compared and matches, the page only reflowed, the picture has changes on it whether or not each one is drawn as a box (so a sheet whose changed cells are all past the draw cap is still marked). */
export const PICTURE_FLAGS = ["absent", "unchanged", "reflowed", "changed"] as const;
/** Why a side could not be drawn. `evidence` is opaque text the connector chooses; CoCheck shows it and reads nothing into it. */
export const STATUS_KINDS = ["refused", "prompt", "hang", "crash", "unavailable"] as const;
/** The most a connector may ask CoCheck to retry a pending document (a bounded count, so a stuck product is never polled forever). */
export const MAX_PENDING_RETRY = 5;
function checkStatus(c: Collector, f: string, v: unknown): void {
  if (v === undefined) return;
  if (!isObj(v)) return void c.add(f, `{ kind, evidence } with kind one of ${quote(STATUS_KINDS)}`, v, `Write ${f} as { "kind": "refused", "evidence": "text" }, or leave it out.`);
  if (!(STATUS_KINDS as readonly unknown[]).includes(v.kind)) c.add(`${f}.kind`, `one of ${quote(STATUS_KINDS)}`, v.kind, `Set kind to ${quote(STATUS_KINDS)}.`);
  if (typeof v.evidence !== "string") c.add(`${f}.evidence`, "a string (opaque evidence)", v.evidence, "Put the evidence as one string, empty if there is none.");
}
const CELL_RE = /^[A-Za-z]{1,3}[1-9]\d*(?::[A-Za-z]{1,3}[1-9]\d*)?$/;

/** v1.2 `issues`: problems the connector found in a state it read, at the document, on a picture or on a change. Each `{ text, side?, where? }`. */
function checkIssues(c: Collector, f: string, v: unknown): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) return void c.add(f, "a list of { text, side?, where? }", v, `Write ${f} as a list of issues, or leave it out.`);
  v.forEach((it, i) => {
    const g = `${f}[${i}]`;
    if (!isObj(it)) return c.add(g, "an object { text, side?, where? }", it, `Make ${g} an object with text.`);
    if (!isStr(it.text)) c.add(`${g}.text`, "a non-empty string (the problem, in words)", it.text, "Say the problem in words.");
    if (it.side !== undefined && !(SIDES as readonly unknown[]).includes(it.side)) c.add(`${g}.side`, `one of ${quote(SIDES)}`, it.side, `Set side to ${quote(SIDES)}, or leave it out.`);
    if (it.where !== undefined && !isStr(it.where)) c.add(`${g}.where`, "a non-empty string (a short label)", it.where, "Write where as a short label in your own words, or leave it out.");
  });
}
/** The page draws at most this many issues of a step, each cut to ISSUE_CHARS characters, then "and N more" (spec v1.2). The checker never rejects a longer list. */
export const ISSUES_SHOWN = 50;
export const ISSUE_CHARS = 300;
/** Every issue of a document, wherever it sits (document, pictures, changes), in document order; malformed entries are skipped. */
export function issuesOf(doc: unknown): Array<{ text: string; side?: string; where?: string }> {
  if (!isObj(doc)) return [];
  const out: Array<{ text: string; side?: string; where?: string }> = [];
  const take = (v: unknown): void => { if (Array.isArray(v)) for (const it of v) if (isObj(it) && isStr(it.text)) out.push({ text: it.text, ...(isStr(it.side) ? { side: it.side } : {}), ...(isStr(it.where) ? { where: it.where } : {}) }); };
  take(doc.issues);
  for (const p of Array.isArray(doc.pictures) ? doc.pictures : []) if (isObj(p)) take(p.issues);
  for (const ch of Array.isArray(doc.changes) ? doc.changes : []) if (isObj(ch)) take(ch.issues);
  return out;
}
/** v1.2 `more`: how many changes (on the document) or children (on a change) are not listed. */
function checkMore(c: Collector, f: string, v: unknown): void {
  if (v !== undefined && !(isInt(v) && v >= 0)) c.add(f, "a whole number from 0 (how many are not listed)", v, `Write ${f} as how many are not listed, or leave it out.`);
}

function checkWords(c: Collector, field: string, v: unknown): void {
  if (v !== undefined && typeof v !== "string") c.add(field, "a string (words)", v, `Write ${field} as words, or leave it out.`);
}

interface Pic { side: string; system: string; type: string }
export type Level = 1 | 2 | 3;

function checkPictures(c: Collector, level: Level, v: unknown): Map<string, Pic> {
  const byId = new Map<string, Pic>();
  if (v === undefined) return byId;
  if (!Array.isArray(v)) { c.add("pictures", "a list of pictures", v, "Write pictures as a list, or leave it out."); return byId; }
  if (level < 2) { c.add("pictures", "no pictures at level 1", "a list", "Remove pictures, or declare level 2 or 3 in the connector's hello: level 1 is a change list only."); return byId; }
  v.forEach((p, i) => {
    const f = `pictures[${i}]`;
    if (!isObj(p)) return c.add(f, "an object", p, `Make ${f} an object with id, side and type.`);
    if (!isStr(p.id)) c.add(`${f}.id`, "a non-empty string", p.id, "Give each picture a unique id.");
    else if (byId.has(p.id)) c.add(`${f}.id`, "a unique id", p.id, `Another picture already uses ${p.id}; give each picture its own id.`);
    if (!(SIDES as readonly unknown[]).includes(p.side)) c.add(`${f}.side`, `one of ${quote(SIDES)}`, p.side, `Set side to ${quote(SIDES)}.`);
    if (!(PICTURE_TYPES as readonly unknown[]).includes(p.type)) c.add(`${f}.type`, `one of ${quote(PICTURE_TYPES)}`, p.type, `Set type to ${quote(PICTURE_TYPES)}.`);
    if (p.src !== undefined && !isStr(p.src)) c.add(`${f}.src`, "a non-empty string", p.src, "Write src as a path or address, or leave it out.");
    if (p.private !== undefined && !isObj(p.private)) c.add(`${f}.private`, "an object", p.private, "Put product-only data in the private object, or leave it out.");
    if (p.label !== undefined && !isStr(p.label)) c.add(`${f}.label`, "a non-empty string", p.label, "Write label as words (a tab or caption), or leave it out.");
    if (p.note !== undefined && !isStr(p.note)) c.add(`${f}.note`, "a non-empty string", p.note, "Write note as one sentence shown under the picture, or leave it out.");
    for (const k of ["width", "height"] as const) if (p[k] !== undefined && !(isNum(p[k]) && (p[k] as number) > 0)) c.add(`${f}.${k}`, "a number above 0 (pixels)", p[k], `Write ${k} as the picture's size in pixels, or leave it out.`);
    for (const k of ["rows", "cols"] as const) if (p[k] !== undefined && !(isInt(p[k]) && (p[k] as number) > 0)) c.add(`${f}.${k}`, "a whole number above 0 (cells)", p[k], `Write ${k} as the grid's size in cells, so a cell box can be checked against it, or leave it out.`);
    for (const k of PICTURE_FLAGS) if (p[k] !== undefined && typeof p[k] !== "boolean") c.add(`${f}.${k}`, "true or false", p[k], `Write ${k} as true, or leave it out.`);
    checkStatus(c, `${f}.status`, p.status);
    if (p.hidden !== undefined && p.hidden !== true) c.add(`${f}.hidden`, "true", p.hidden, "Write hidden as true, or leave it out.");
    if (p.renderedBy !== undefined) {
      const rb = p.renderedBy;
      if (!isObj(rb)) c.add(`${f}.renderedBy`, "{ tool, version, os } as text", rb, "Write renderedBy as { \"tool\": \"name\", \"version\": \"1.0\", \"os\": \"darwin\" }, or leave it out.");
      else for (const k of ["tool", "version", "os"] as const) if (!isStr(rb[k])) c.add(`${f}.renderedBy.${k}`, "a non-empty string", rb[k], `Name the ${k} that drew the picture.`);
    }
    if (p.page !== undefined && !(isInt(p.page) && p.page >= 1)) c.add(`${f}.page`, "a whole number from 1 (the page this picture shows)", p.page, "Write page as the page number, or leave it out.");
    if (p.pageCount !== undefined && !(isInt(p.pageCount) && p.pageCount >= 1 && (!isInt(p.page) || p.pageCount >= p.page))) c.add(`${f}.pageCount`, "a whole number from 1 that is not below page", p.pageCount, "Write pageCount as how many pages the side has, or leave it out.");
    // v1.1 `group` and `order`: pictures sharing a group are shown together as one before-and-after set, each side ordered by `order`
    if (p.group !== undefined && !isStr(p.group)) c.add(`${f}.group`, "a non-empty string (the set this picture belongs to)", p.group, "Write group as the same string on every picture of one before-and-after set, or leave it out.");
    if (p.order !== undefined && !(isInt(p.order) && p.order >= 0 && isStr(p.group))) c.add(`${f}.order`, isStr(p.group) ? "a whole number from 0 (the picture's place in its group)" : "order only with a group", p.order, isStr(p.group) ? "Write order as the picture's place on its side of the group: 0, 1, 2 ..." : "Give the picture a group, or leave order out.");
    checkIssues(c, `${f}.issues`, p.issues);
    if (isStr(p.id) && !byId.has(p.id)) byId.set(p.id, { side: String(p.side), system: SYSTEM_OF_TYPE[String(p.type)] ?? "none", type: String(p.type) });
  });
  return byId;
}

const ANCHOR_KEYS = ["rect", "highlights", "cell", "lines", "range"] as const;
const SYSTEM_ALLOWS: Record<string, readonly string[]> = { pixels: ["rect", "highlights"], cells: ["cell"], text: ["lines", "range"], none: [] };

function checkBox(c: Collector, f: string, b: unknown, pics: Map<string, Pic>): void {
  if (!isObj(b)) return c.add(f, "an object", b, `Make ${f} an object with picture and one anchor.`);
  let pic: Pic | undefined;
  if (!isStr(b.picture)) c.add(`${f}.picture`, "the id of a picture", b.picture, "Name the picture this box sits on.");
  else {
    pic = pics.get(b.picture);
    if (pic === undefined) c.add(`${f}.picture`, "the id of a picture in pictures", b.picture, "Add that picture to pictures, or name one that exists.");
  }
  if (b.looksSame !== undefined && b.looksSame !== true) c.add(`${f}.looksSame`, "true", b.looksSame, "Write looksSame as true (the pixels under the box are the same on both sides), or leave it out.");
  const present = ANCHOR_KEYS.filter((k) => b[k] !== undefined);
  if (present.length === 0) c.add(f, `one anchor (${ANCHOR_KEYS.join(", ")})`, "no anchor", "Give the box an anchor that fits its picture.");
  const allowed = pic === undefined ? undefined : SYSTEM_ALLOWS[pic.system] ?? [];
  for (const k of present) {
    if (allowed !== undefined && !allowed.includes(k)) {
      const want = allowed.length === 0 ? "no box (a html picture cannot be anchored in v1)" : allowed.join(" or ");
      c.add(`${f}.${k}`, want, `${k} on a ${pic!.system} picture`, allowed.length === 0 ? "Remove the box: html pictures can be shown but not anchored." : `Anchor a ${pic!.system} picture with ${allowed.join(" or ")}, not ${k}.`);
      continue;
    }
    const bad = (expected: string) => c.add(`${f}.${k}`, expected, b[k], `Write ${k} as ${expected}.`);
    if (k === "rect" && !isRect(b.rect)) bad("{ x, y, w, h } numbers");
    if (k === "highlights" && !(Array.isArray(b.highlights) && b.highlights.every(isRect))) bad("a list of { x, y, w, h } numbers");
    if (k === "cell" && !(typeof b.cell === "string" && CELL_RE.test(b.cell))) bad("a cell or range such as \"B3\" or \"B3:D7\"");
    if (k === "lines") {
      const l = b.lines;
      if (!(isObj(l) && isInt(l.from) && isInt(l.to) && l.from >= 1 && l.from <= l.to)) bad("{ from, to } whole line numbers, 1 <= from <= to");
    }
    if (k === "range") {
      const r = b.range;
      if (!(isObj(r) && isInt(r.line) && r.line >= 1 && isInt(r.start) && isInt(r.end) && r.start >= 0 && r.start <= r.end)) bad("{ line, start, end } whole numbers, line >= 1, 0 <= start <= end");
    }
  }
}

/** Problems with a v1 change document, each naming the field path; an empty list means the document is valid. */
/** A changes list whose entries carry `kind` or `anchors`: the shape connectors answered before cocheck.changes/1. */
const olderShape = (doc: Obj): boolean => Array.isArray(doc.changes) && doc.changes.some((x) => isObj(x) && ("anchors" in x || "kind" in x));
const OLDER_SHAPE_FIX = `This is the older change-list shape (kind, anchors, confidence) that CoCheck no longer reads, so answer a "${CHANGES_SPEC}" document with spec set to it and an id, a mark and a label on each change (public-kit/spec/v1.md).`;

export function checkChanges(doc: unknown, level: Level = 3): Problem[] {
  const c = new Collector(CHANGES_FILE);
  if (!isObj(doc)) {
    c.add("", "a JSON object", doc, "Make the document one object with spec and changes.");
    return c.problems;
  }
  if (doc.spec !== CHANGES_SPEC) c.add("spec", `"${CHANGES_SPEC}"`, doc.spec, olderShape(doc) ? OLDER_SHAPE_FIX : `Set spec to "${CHANGES_SPEC}".`);
  if (doc.caveats !== undefined && !(Array.isArray(doc.caveats) && doc.caveats.every((s) => typeof s === "string"))) c.add("caveats", "a list of strings", doc.caveats, "Write caveats as a list of sentences.");

  checkStatus(c, "status", doc.status);
  if (doc.pendingRetry !== undefined && !(isInt(doc.pendingRetry) && doc.pendingRetry >= 1 && doc.pendingRetry <= MAX_PENDING_RETRY)) c.add("pendingRetry", `a whole number from 1 to ${MAX_PENDING_RETRY} (how many more times to ask)`, doc.pendingRetry, `Write pendingRetry as a whole number from 1 to ${MAX_PENDING_RETRY}, or leave it out.`);

  checkIssues(c, "issues", doc.issues);
  checkMore(c, "more", doc.more);

  const eff: Level = level === 1 || level === 2 || level === 3 ? level : 3;
  const pics = checkPictures(c, eff, doc.pictures);

  if (!Array.isArray(doc.changes)) {
    c.add("changes", "a list of changes", doc.changes, "Add a changes list, empty when nothing changed.");
    return c.problems;
  }
  const ids = new Set<string>();
  const all = new Set<string>();
  for (const ch of doc.changes) if (isObj(ch) && isStr(ch.id)) all.add(ch.id);
  doc.changes.forEach((ch: unknown, i: number) => {
    const f = `changes[${i}]`;
    if (!isObj(ch)) return c.add(f, "an object", ch, `Make ${f} an object with id, mark and label.`);
    if (!isStr(ch.id)) c.add(`${f}.id`, "a non-empty string", ch.id, "Give each change a unique id.");
    else if (ids.has(ch.id)) c.add(`${f}.id`, "a unique id", ch.id, `Another change already uses ${ch.id}; give each change its own id.`);
    else ids.add(ch.id);
    if (!(MARKS as readonly unknown[]).includes(ch.mark)) c.add(`${f}.mark`, `one of ${quote(MARKS)}`, ch.mark, `Set mark to ${quote(MARKS)}.`);
    if (!isStr(ch.label)) c.add(`${f}.label`, "a non-empty string (where, in words)", ch.label, "Say in words where the change is.");
    checkWords(c, `${f}.before`, ch.before);
    checkWords(c, `${f}.after`, ch.after);
    if (ch.text !== undefined && !isStr(ch.text)) c.add(`${f}.text`, "a non-empty string", ch.text, "Write text as one plain sentence of what changed, or leave it out.");
    if (ch.private !== undefined && !isObj(ch.private)) c.add(`${f}.private`, "an object", ch.private, "Put product-only data in the private object, or leave it out.");
    if (ch.kind !== undefined && !isStr(ch.kind)) c.add(`${f}.kind`, "a non-empty string", ch.kind, "Write kind as any short word, or leave it out.");
    if (ch.lines !== undefined && !(Array.isArray(ch.lines) && ch.lines.every((s) => typeof s === "string"))) c.add(`${f}.lines`, "a list of strings", ch.lines, "Write lines as a list of sentences.");
    if (ch.parent !== undefined && ch.parent !== null) {
      if (!isStr(ch.parent) || !all.has(ch.parent) || ch.parent === ch.id) c.add(`${f}.parent`, "null or the id of another change", ch.parent, "Name the id of the change that contains this one, or null.");
    }
    if (ch.causedBy !== undefined && (!isStr(ch.causedBy) || !all.has(ch.causedBy) || ch.causedBy === ch.id)) c.add(`${f}.causedBy`, "the id of another change", ch.causedBy, "Name the id of the change that caused this one, or leave causedBy out.");
    checkIssues(c, `${f}.issues`, ch.issues);
    checkMore(c, `${f}.more`, ch.more);
    if (ch.boxes !== undefined) {
      if (eff < 3) c.add(`${f}.boxes`, "no boxes below level 3", "a list", "Remove the boxes, or declare level 3 in the connector's hello: anchors are level 3.");
      else if (!Array.isArray(ch.boxes)) c.add(`${f}.boxes`, "a list of boxes", ch.boxes, "Write boxes as a list.");
      else ch.boxes.forEach((b: unknown, j: number) => checkBox(c, `${f}.boxes[${j}]`, b, pics));
    }
    if (ch.unplaced !== undefined) {
      if (eff < 3) c.add(`${f}.unplaced`, "no unplaced below level 3", "an object", "Remove unplaced, or declare level 3 in the connector's hello.");
      else if (!isObj(ch.unplaced)) c.add(`${f}.unplaced`, "an object with before and/or after words", ch.unplaced, "Write unplaced as { \"after\": \"not marked\" }.");
      else for (const s of SIDES) checkWords(c, `${f}.unplaced.${s}`, (ch.unplaced as Obj)[s]);
    }
  });
  return c.problems;
}
