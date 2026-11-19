import { unzipSync } from "fflate";
import { canonicalOrRaw } from "./ooxml-names.ts";

/**
 * A pure structure checker for .pptx / .xlsx / .docx. It looks for the few defects that make Office say "we found a problem
 * with some content ... repair?", by targeted, high-precision rules (never a full schema validation, which is too noisy). It reads
 * the package only; it never writes. A file it cannot read as an Office package gives `null`, which is "not checked" (no badge).
 *
 * Severity: "likely-repair" is a defect Office is known to refuse or repair; "tolerated" is a defect Office usually opens quietly.
 * Every finding names the part, the slide or sheet it maps to (through the relationships), and carries one plain sentence.
 */

export type Severity = "likely-repair" | "tolerated";
export type OfficeApp = "PowerPoint" | "Excel" | "Word";

export interface StructureFinding {
  severity: Severity;
  rule: string;
  /** The package part the defect is in. */
  part: string;
  /** "slide 5", `sheet "Data"`, "the document"; null when the defect is not in one place. */
  where: string | null;
  /** What in that place: "chart", "slide", "sheet", "document"... */
  subject: string;
  /** What is wrong, as a phrase that follows "has": "23 empty values". */
  detail: string;
  sentence: string;
}

export interface StructureResult {
  v: 1;
  app: OfficeApp;
  findings: StructureFinding[];
}

const MAX_PART_BYTES = 64 * 1024 * 1024;
const MAX_FINDINGS_PER_RULE = 40;

const appOf = (file: string): OfficeApp | null => {
  const e = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  if (e === "pptx" || e === "ppsx" || e === "pptm" || e === "potx") return "PowerPoint";
  if (e === "xlsx" || e === "xlsm" || e === "xltx") return "Excel";
  if (e === "docx" || e === "docm" || e === "dotx") return "Word";
  return null;
};

const dec = new TextDecoder("utf-8");

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) out[m[1]!] = m[2] ?? m[3] ?? "";
  return out;
}
const local = (name: string): string => name.slice(name.indexOf(":") + 1);
/** The attributes of every start tag whose local name is `name`. */
function tagsNamed(xml: string, name: string, prefix?: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const re = new RegExp(`<${prefix === undefined ? "(?:[\\w.-]+:)?" : prefix === "" ? "" : prefix + ":"}${name}(?=[\\s/>])([^>]*)>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(attrs(m[1]!));
  return out;
}
const byLocal = (a: Record<string, string>, name: string): string | undefined => {
  for (const k of Object.keys(a)) if (local(k) === name && !k.startsWith("xmlns")) return a[k];
  return undefined;
};

/** The text inside the first `<prefix:name>...</prefix:name>` block (prefix "" for none), or "" when there is none. Used so a same-named element of another namespace (p14:sldId in a section list) is never counted. */
function blockOf(xml: string, prefix: string, name: string): string {
  const q = prefix === "" ? "" : prefix + ":";
  const m = new RegExp(`<${q}${name}(?=[\\s>])[^>]*>([\\s\\S]*?)</${q}${name}>`).exec(xml);
  return m?.[1] ?? "";
}
/** The p:sldId elements of p:sldIdLst only. */
const slideIds = (pres: string): Array<Record<string, string>> => tagsNamed(blockOf(pres, "p", "sldIdLst"), "sldId", "p");

const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;

/** A part's directory and its resolved target, the way a relationship target is read. */
function resolve(source: string, target: string): string {
  const parts = target.startsWith("/") ? target.slice(1).split("/") : [...source.split("/").slice(0, -1), ...target.split("/")]; // kept: an OOXML package part name, not a file path
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}
function safeDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}
const relsPartOf = (part: string): string => {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
};
const sourceOfRels = (rels: string): string | null => {
  const m = /^(.*)_rels\/(.*)\.rels$/.exec(rels);
  return m ? `${m[1]}${m[2]}` : null;
};

interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

// ---- enum sets (ECMA-376 Transitional, the values Office accepts) ----

const ENUM = {
  prstDash: new Set(["solid", "dot", "dash", "lgDash", "dashDot", "lgDashDot", "lgDashDotDot", "sysDash", "sysDot", "sysDashDot", "sysDashDotDot"]),
  algn: new Set(["l", "ctr", "r", "just", "justLow", "dist", "thaiDist"]),
  anchor: new Set(["t", "ctr", "b", "just", "dist"]),
  cap: new Set(["rnd", "sq", "flat"]),
  cmpd: new Set(["sng", "dbl", "thickThin", "thinThick", "tri"]),
  lineEnd: new Set(["none", "triangle", "stealth", "diamond", "oval", "arrow"]),
  lineEndSize: new Set(["sm", "med", "lg"]),
  jc: new Set(["start", "center", "end", "both", "mediumKashida", "distribute", "numTab", "highKashida", "lowKashida", "thaiDistribute", "left", "right"]),
  grouping: new Set(["standard", "stacked", "percentStacked", "clustered"]),
  legendPos: new Set(["b", "tr", "l", "r", "t"]),
  barDir: new Set(["bar", "col"]),
  dLblPos: new Set(["bestFit", "b", "ctr", "inBase", "inEnd", "l", "outEnd", "r", "t"]),
  symbol: new Set(["circle", "dash", "diamond", "dot", "none", "picture", "plus", "square", "star", "triangle", "x", "auto"]),
  tickLblPos: new Set(["high", "low", "nextTo", "none"]),
  axPos: new Set(["b", "l", "r", "t"]),
  crosses: new Set(["autoZero", "max", "min"]),
  orientation: new Set(["maxMin", "minMax"]),
  scatterStyle: new Set(["none", "line", "lineMarker", "marker", "smooth", "smoothMarker"]),
  crossBetween: new Set(["between", "midCat"]),
};

interface EnumRule {
  /** Element local names the rule reads. */
  tags: string[];
  /** The attribute holding the value. */
  attr: string;
  set: Set<string>;
  /** What a violation is called in the banner: "an invalid line dash". */
  noun: string;
  /** Which package kinds carry the rule (a `w:jc` is Word's; a `jc` elsewhere is not). */
  only?: RegExp;
}
const ENUM_RULES: EnumRule[] = [
  { tags: ["prstDash"], attr: "val", set: ENUM.prstDash, noun: "an invalid line dash" },
  { tags: ["pPr", "defPPr", "lvl1pPr", "lvl2pPr", "lvl3pPr", "lvl4pPr", "lvl5pPr", "lvl6pPr", "lvl7pPr", "lvl8pPr", "lvl9pPr"], attr: "algn", set: ENUM.algn, noun: "an invalid paragraph alignment" },
  { tags: ["bodyPr"], attr: "anchor", set: ENUM.anchor, noun: "an invalid text anchor" },
  { tags: ["ln"], attr: "cap", set: ENUM.cap, noun: "an invalid line cap" },
  { tags: ["ln"], attr: "cmpd", set: ENUM.cmpd, noun: "an invalid compound line" },
  { tags: ["headEnd", "tailEnd"], attr: "type", set: ENUM.lineEnd, noun: "an invalid arrowhead" },
  { tags: ["headEnd", "tailEnd"], attr: "w", set: ENUM.lineEndSize, noun: "an invalid arrowhead width" },
  { tags: ["headEnd", "tailEnd"], attr: "len", set: ENUM.lineEndSize, noun: "an invalid arrowhead length" },
  { tags: ["jc"], attr: "val", set: ENUM.jc, noun: "an invalid paragraph alignment", only: /^word\// },
  { tags: ["grouping"], attr: "val", set: ENUM.grouping, noun: "an invalid chart grouping", only: /charts\// },
  { tags: ["legendPos"], attr: "val", set: ENUM.legendPos, noun: "an invalid legend position", only: /charts\// },
  { tags: ["barDir"], attr: "val", set: ENUM.barDir, noun: "an invalid bar direction", only: /charts\// },
  { tags: ["dLblPos"], attr: "val", set: ENUM.dLblPos, noun: "an invalid data label position", only: /charts\// },
  { tags: ["symbol"], attr: "val", set: ENUM.symbol, noun: "an invalid marker symbol", only: /charts\// },
  { tags: ["tickLblPos"], attr: "val", set: ENUM.tickLblPos, noun: "an invalid tick label position", only: /charts\// },
  { tags: ["axPos"], attr: "val", set: ENUM.axPos, noun: "an invalid axis position", only: /charts\// },
  { tags: ["crosses"], attr: "val", set: ENUM.crosses, noun: "an invalid axis crossing", only: /charts\// },
  { tags: ["orientation"], attr: "val", set: ENUM.orientation, noun: "an invalid axis orientation", only: /charts\// },
  { tags: ["scatterStyle"], attr: "val", set: ENUM.scatterStyle, noun: "an invalid scatter style", only: /charts\// },
  { tags: ["crossBetween"], attr: "val", set: ENUM.crossBetween, noun: "an invalid axis crossing mode", only: /charts\// },
];

// ---- where a part sits ----

interface Place {
  where: string;
  subject: string;
}

function subjectOfPart(part: string): string {
  if (/\/charts\/chart[^/]*\.xml$/.test(part) || /\/charts\/style|colors/.test(part)) return "chart";
  if (/\/notesSlides\//.test(part)) return "notes";
  if (/\/slides\/slide[^/]*\.xml$/.test(part)) return "slide";
  if (/\/diagrams\//.test(part)) return "diagram";
  if (/\/drawings\//.test(part)) return "drawing";
  if (/\/worksheets\//.test(part)) return "sheet";
  if (/\/chartsheets\//.test(part)) return "chart sheet";
  if (/\/tables\//.test(part)) return "table";
  if (/\/(header|footer)[^/]*\.xml$/.test(part)) return "header or footer";
  return "part";
}

/** Maps each part to the slide or sheet that reaches it (the first one in order), by walking relationships from slides, sheets and the main document. */
function placesOf(app: OfficeApp, get: (p: string) => string | undefined, relsOf: (p: string) => Rel[], names: Set<string>): Map<string, Place> {
  const places = new Map<string, Place>();
  const roots: Array<{ part: string; where: string; subject: string }> = [];
  if (app === "PowerPoint") {
    const pres = [...names].find((n) => /^ppt\/presentation\.xml$/.test(n));
    if (pres) {
      const rels = new Map(relsOf(pres).map((r) => [r.id, r]));
      let n = 0;
      for (const a of slideIds(get(pres) ?? "")) {
        const rid = byLocal(a, "id") && Object.entries(a).find(([k]) => k.endsWith(":id"))?.[1];
        const rel = rid ? rels.get(rid) : undefined;
        n++;
        if (rel && !rel.external) roots.push({ part: resolve(pres, rel.target), where: `slide ${n}`, subject: "slide" });
      }
    }
  } else if (app === "Excel") {
    const wb = [...names].find((x) => x === "xl/workbook.xml");
    if (wb) {
      const rels = new Map(relsOf(wb).map((r) => [r.id, r]));
      const xml = get(wb) ?? "";
      const re = /<(?:[\w.-]+:)?sheet(?=[\s/>])([^>]*)>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) {
        const a = attrs(m[1]!);
        const rid = Object.entries(a).find(([k]) => k.endsWith(":id"))?.[1];
        const rel = rid ? rels.get(rid) : undefined;
        if (rel && !rel.external) roots.push({ part: resolve(wb, rel.target), where: `sheet "${decodeXml(a.name ?? "")}"`, subject: "sheet" });
      }
    }
  } else {
    roots.push({ part: "word/document.xml", where: "the document", subject: "document" });
  }
  for (const root of roots) {
    const queue = [root.part];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const part = queue.shift()!;
      if (seen.has(part) || !names.has(part)) continue;
      seen.add(part);
      if (!places.has(part)) places.set(part, { where: root.where, subject: part === root.part ? root.subject : subjectOfPart(part) });
      for (const r of relsOf(part)) {
        if (r.external || /slideLayout|slideMaster|theme|\/slide$|\/worksheet$|\/chartsheet$/.test(r.type) && !/chart$/.test(r.type)) continue;
        if (/\/(slide|notesMaster)$/.test(r.type)) continue;
        queue.push(resolve(part, r.target));
      }
    }
  }
  return places;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
}

// ---- the check ----

export function checkStructure(bytes: Uint8Array, file: string, opts: { maxPartBytes?: number } = {}): StructureResult | null {
  const maxPart = opts.maxPartBytes ?? MAX_PART_BYTES;
  const app = appOf(file) ?? null;
  if (app === null) return null;
  let files: Record<string, Uint8Array>;
  /** Every entry of the package, read or not: a part over the size cap still exists. */
  const listed: string[] = [];
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        listed.push(f.name);
        return /\.(xml|rels|vml)$/i.test(f.name) && f.originalSize <= maxPart;
      },
    });
  } catch {
    return null;
  }
  // A package with no content-types part is not an Office package this checker knows how to read.
  // (unzip with a filter would still list every name, but non-xml bodies are not needed; they are read lazily by name only.)
  const rawNames = listed.filter((n) => !n.endsWith("/"));
  if (rawNames.length === 0) return null;
  const names = new Set(rawNames);
  /** Text parts over the size cap: they exist but were not read, so a rule that needs one is skipped, never judged on an empty read. */
  const skipped = new Set(rawNames.filter((n) => /\.(xml|rels|vml)$/i.test(n) && files[n] === undefined));
  // The skeleton itself unread: nothing reliable can be said, so the file is unchecked.
  if (skipped.has("[Content_Types].xml") || [...skipped].some((n) => n.endsWith(".rels"))) return null;
  const text = new Map<string, string>();
  const get = (p: string): string | undefined => {
    const hit = text.get(p);
    if (hit !== undefined) return hit;
    const b = files[p];
    if (!b) return undefined;
    // Names are read as their namespaces say, whatever prefix the writer chose; a part that cannot be resolved is checked as written.
    const s = /\.(xml|rels)$/i.test(p) ? canonicalOrRaw(dec.decode(b), "ooxml", p) : dec.decode(b);
    text.set(p, s);
    return s;
  };
  if (!names.has("[Content_Types].xml") && !names.has("_rels/.rels")) return null;
  const main = app === "PowerPoint" ? "ppt/presentation.xml" : app === "Excel" ? "xl/workbook.xml" : "word/document.xml";
  const findings: StructureFinding[] = [];
  const counts = new Map<string, number>();
  const add = (f: Omit<StructureFinding, "where" | "subject"> & { where?: string | null; subject?: string }): void => {
    const n = (counts.get(f.rule) ?? 0) + 1;
    counts.set(f.rule, n);
    if (n > MAX_FINDINGS_PER_RULE) return;
    const place = places.get(f.part);
    findings.push({ ...f, where: f.where !== undefined ? f.where : place?.where ?? null, subject: f.subject ?? place?.subject ?? subjectOfPart(f.part) });
  };

  const relCache = new Map<string, Rel[]>();
  const relsOf = (part: string): Rel[] => {
    const hit = relCache.get(part);
    if (hit) return hit;
    const xml = get(relsPartOf(part));
    const out: Rel[] = [];
    if (xml) {
      const re = /<(?:[\w.-]+:)?Relationship(?=[\s/>])([^>]*)>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) {
        const a = attrs(m[1]!);
        out.push({ id: a.Id ?? "", type: a.Type ?? "", target: safeDecode(a.Target ?? ""), external: /^external$/i.test(a.TargetMode ?? "") });
      }
    }
    relCache.set(part, out);
    return out;
  };
  const places = placesOf(app, get, relsOf, names);

  // 1. Content types.
  const ct = get("[Content_Types].xml");
  if (ct === undefined) {
    add({ severity: "likely-repair", rule: "content-type-missing", part: "[Content_Types].xml", where: null, subject: "package", detail: "no [Content_Types].xml", sentence: `The package has no [Content_Types].xml, so ${app} cannot tell what its parts are.` });
  } else {
    const defaults = new Set(tagsNamed(ct, "Default").map((a) => (a.Extension ?? "").toLowerCase()));
    const overrides = new Set(tagsNamed(ct, "Override").map((a) => (a.PartName ?? "").replace(/^\//, "")));
    for (const n of rawNames) {
      if (n === "[Content_Types].xml") continue;
      const ext = /\.([^./]+)$/.exec(n)?.[1]?.toLowerCase() ?? "";
      if (overrides.has(n) || defaults.has(ext)) continue;
      add({ severity: "likely-repair", rule: "content-type-missing", part: n, detail: "no content type", sentence: `${n} has no content type (no Default for .${ext} and no Override), so ${app} may refuse it.` });
    }
    // A related Office part that falls back to the generic Default for .xml is read as plain XML, not as what it is.
    const xmlDefault = tagsNamed(ct, "Default").find((a) => (a.Extension ?? "").toLowerCase() === "xml")?.ContentType ?? "";
    if (xmlDefault === "" || xmlDefault === "application/xml" || xmlDefault === "text/xml") {
      for (const rn of rawNames.filter((x) => x.endsWith(".rels"))) {
        const source = sourceOfRels(rn);
        if (source === null) continue;
        for (const r of relsOf(source)) {
          if (r.external || !/^http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\//.test(r.type) || /\/(customXml|xmlMaps)$/.test(r.type)) continue;
          const target = resolve(source, r.target);
          if (!/\.xml$/.test(target) || !names.has(target) || overrides.has(target)) continue;
          add({ severity: "likely-repair", rule: "content-type-missing", part: target, detail: "no content type", sentence: `${target} has no content-type override, so ${app} reads it as plain XML instead of a ${r.type.split("/").pop()}.` });
        }
      }
    }
    // An Override for a part that is not there (slideMaster2..N in PowerPoint and PptxGenJS output) is normal and not reported.
  }

  // 2. Relationships: duplicate ids, missing targets, ids used but not defined.
  const TOLERATED_TARGET = /\/(image|media|video|audio|thumbnail|printerSettings|customXml|oleObject|package|hdphoto|vmlDrawing|legacyDrawing)$|metadata\/thumbnail|printerSettings|hyperlink/i;
  for (const rn of rawNames.filter((n) => n.endsWith(".rels"))) {
    const source = sourceOfRels(rn);
    if (source === null) continue;
    const rels = relsOf(source);
    const seen = new Set<string>();
    for (const r of rels) {
      if (seen.has(r.id)) add({ severity: "likely-repair", rule: "duplicate-rel-id", part: rn, detail: `a repeated relationship id ${r.id}`, sentence: `${rn} uses the relationship id ${r.id} twice.` });
      seen.add(r.id);
      if (r.external || r.target.startsWith("#")) continue;
      const target = resolve(source === "" ? "x" : source, r.target);
      if (names.has(target) || names.has(safeDecode(target))) continue;
      const kind = r.type.split("/").pop() ?? "part";
      const place = places.get(source);
      add({
        severity: TOLERATED_TARGET.test(r.type) ? "tolerated" : "likely-repair",
        rule: "dangling-rel",
        part: source,
        detail: `a ${kind} link to ${target}, which is missing`,
        sentence: `${source}${place ? ` (${place.where})` : ""} points to ${target} as a ${kind}, and that part is not in the package.`,
      });
    }
  }
  for (const n of rawNames) {
    if (!/\.xml$/.test(n) || n === "[Content_Types].xml" || n.startsWith("customXml/") || n.startsWith("docProps/")) continue;
    const xml = get(n);
    if (xml === undefined || !/\br:(id|embed|link|pict)=/.test(xml)) continue;
    const have = new Set(relsOf(n).map((r) => r.id));
    const missing = new Set<string>();
    const re = /\br:(?:id|embed|link|pict)="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) if (m[1] !== "" && !have.has(m[1]!)) missing.add(m[1]!);
    for (const id of missing) add({ severity: "likely-repair", rule: "dangling-rel-id", part: n, detail: `a reference to relationship ${id}, which is not defined`, sentence: `${n} refers to relationship ${id}, but its relationships do not define it.` });
  }
  if (!names.has(main) && (names.has("[Content_Types].xml") || names.has("_rels/.rels"))) {
    add({ severity: "likely-repair", rule: "main-part-missing", part: main, where: null, subject: "package", detail: `no ${main}`, sentence: `The package has no ${main}.` });
  }

  // 3. Enums, chart caches, chart structure.
  for (const n of rawNames) {
    if (!/\.xml$/.test(n) || !/^(ppt|xl|word)\//.test(n)) continue;
    const xml = get(n);
    if (xml === undefined) continue;
    if (/(^|\/)charts\/[^/]*\.xml$/.test(n)) chartRules(n, xml);
    const tally = new Map<string, { noun: string; bad: Set<string>; count: number }>();
    for (const rule of ENUM_RULES) {
      if (rule.only && !rule.only.test(n)) continue;
      for (const tag of rule.tags) {
        if (!xml.includes(tag)) continue;
        for (const a of tagsNamed(xml, tag, tag === "jc" ? "w" : undefined)) {
          const v = rule.attr === "val" ? byLocal(a, "val") : a[rule.attr];
          if (v === undefined || rule.set.has(v)) continue;
          const t = tally.get(rule.noun) ?? { noun: rule.noun, bad: new Set(), count: 0 };
          t.bad.add(v);
          t.count++;
          tally.set(rule.noun, t);
        }
      }
    }
    for (const t of tally.values()) {
      add({ severity: "likely-repair", rule: "enum", part: n, detail: t.noun, sentence: `${n} has ${t.noun} (${[...t.bad].slice(0, 3).map((v) => `"${v}"`).join(", ")}${t.count > 1 ? `, ${t.count} times` : ""}), which ${app} reads as corrupt.` });
    }

  }

  function chartRules(n: string, xml: string): void {
    let empty = 0;
    let nonNum = 0;
    const re = /<((?:[\w.-]+:)?)(numCache|numLit)(?=[\s>])[\s\S]*?<\/\1\2>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const vre = /<((?:[\w.-]+:)?)v(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1v>)/g;
      let v: RegExpExecArray | null;
      while ((v = vre.exec(m[0])) !== null) {
        const val = (v[2] ?? "").trim();
        if (val === "") empty++;
        else if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(val) && !/^(NaN|[+-]?INF|#.*)$/.test(val)) nonNum++;
      }
    }
    if (empty > 0) add({ severity: "likely-repair", rule: "chart-empty-value", part: n, detail: `${plural(empty, "empty value")}`, sentence: `${n} has ${plural(empty, "empty value")} in its numeric caches; ${app} rejects an empty number there.` });
    if (nonNum > 0) add({ severity: "likely-repair", rule: "chart-nonnumeric-value", part: n, detail: `${plural(nonNum, "non-numeric value")}`, sentence: `${n} has ${plural(nonNum, "non-numeric value")} in its numeric caches.` });
    // An axis that crosses an axis the chart does not have (crossAx naming no axId of the chart part). Found by bisecting an openpyxl-written workbook: either
    // dangling crossAx alone (the date axis's, or the value axis's: openpyxl's default value axis crosses id 10 once the category axis is replaced by a DateAxis) makes Excel show
    // "We found a problem with some content"; setting both to the other axis's id removes the prompt. Excel workbooks only (Word and PowerPoint charts were not tested).
    // Precision first (a false repair banner is worse than none): ids are read from EVERY axis through the shared attribute reader (any quoting, spaces around "="), an axis with
    // no crossAx is not judged, ids are compared as numbers ("02" is 2: not flagged), and a chart whose axis ids cannot all be read is not judged at all.
    if (/^xl\//.test(n)) {
      const axes: { id: number | null; cross: number | null; crossText?: string; idText?: string }[] = [];
      const axRe = /<((?:[\w.-]+:)?)(catAx|valAx|dateAx|serAx)(?=[\s>])[\s\S]*?<\/\1\2>/g;
      const num = (v: string | undefined): number | null => (v !== undefined && /^\s*-?\d+\s*$/.test(v) ? Number(v) : null);
      while ((m = axRe.exec(xml)) !== null) {
        const idText = tagsNamed(m[0], "axId").map((a) => byLocal(a, "val"))[0];
        const crossText = tagsNamed(m[0], "crossAx").map((a) => byLocal(a, "val"))[0];
        axes.push({ id: num(idText), cross: crossText === undefined ? null : num(crossText), ...(crossText !== undefined ? { crossText } : {}), ...(idText !== undefined ? { idText } : {}) });
      }
      const readable = axes.every((a) => a.id !== null && (a.crossText === undefined || a.cross !== null));
      const ids = new Set(axes.map((a) => a.id));
      const dangling = readable ? axes.filter((a) => a.cross !== null && !ids.has(a.cross)) : [];
      if (dangling.length > 0) add({ severity: "likely-repair", rule: "chart-axis-crossref", part: n, detail: `${plural(dangling.length, "axis", "axes")} crossing an axis the chart does not have`, sentence: `${n} has ${dangling.map((a) => `axis ${a.idText} crossing axis ${a.crossText}`).join(" and ")}, and the chart has no axis ${[...new Set(dangling.map((a) => a.crossText))].join(" or ")}.` });
    }
    // Series elements in the wrong chart type.
    const blockRe = /<((?:[\w.-]+:)?)(lineChart|areaChart|scatterChart|pieChart|radarChart|doughnutChart|stockChart)(?=[\s>])[\s\S]*?<\/\1\2>/g;
    while ((m = blockRe.exec(xml)) !== null) {
      const kind = m[2]!;
      const block = m[0];
      if (/<(?:[\w.-]+:)?invertIfNegative(?=[\s/>])/.test(block)) {
        add({ severity: "tolerated", rule: "chart-line-invert", part: n, detail: `an invalid series setting (invertIfNegative in a ${kind.replace("Chart", "")} series)`, sentence: `${n} has invertIfNegative inside a ${kind} series, which only bar and bubble series allow.` });
      }
      if (kind === "lineChart" && !/<(?:[\w.-]+:)?grouping(?=[\s/>])/.test(block.replace(/<(?:[\w.-]+:)?ser(?=[\s>])[\s\S]*?<\/(?:[\w.-]+:)?ser>/g, ""))) {
        add({ severity: "tolerated", rule: "chart-no-grouping", part: n, detail: "a line chart with no grouping", sentence: `${n} has a line chart with no grouping element, which the schema requires.` });
      }
    }
  }

  // 4. Format specifics.
  if (app === "PowerPoint") pptxRules();
  else if (app === "Excel") xlsxRules();
  else docxRules();

  function pptxRules(): void {
    const pres = get("ppt/presentation.xml");
    if (pres !== undefined) {
      const ids = new Map<string, number>();
      for (const a of slideIds(pres)) {
        const id = a.id ?? "";
        ids.set(id, (ids.get(id) ?? 0) + 1);
        if (/^\d+$/.test(id) && Number(id) < 256) add({ severity: "likely-repair", rule: "duplicate-id", part: "ppt/presentation.xml", where: null, subject: "presentation", detail: `a slide id below 256 (${id})`, sentence: `A slide has id ${id}, below the minimum of 256 PowerPoint allows.` });
      }
      for (const [id, c] of ids) if (c > 1) add({ severity: "likely-repair", rule: "duplicate-id", part: "ppt/presentation.xml", where: null, subject: "presentation", detail: `a slide id used twice (${id})`, sentence: `Two slides share the id ${id} in ppt/presentation.xml.` });
    }
    for (const n of rawNames) {
      if (!/^ppt\/slides\/slide[^/]*\.xml$/.test(n)) continue;
      const xml = get(n) ?? "";
      const seen = new Map<string, number>();
      for (const a of tagsNamed(xml.replace(/<mc:Fallback[\s\S]*?<\/mc:Fallback>/g, ""), "cNvPr", "p")) if (a.id !== undefined) seen.set(a.id, (seen.get(a.id) ?? 0) + 1);
      const dups = [...seen].filter(([, c]) => c > 1).map(([id]) => id);
      if (dups.length > 0) add({ severity: "tolerated", rule: "duplicate-shape-id", part: n, detail: `${plural(dups.length, "shape id")} used more than once`, sentence: `${n} has ${plural(dups.length, "shape id")} used more than once (${dups.slice(0, 3).join(", ")}); PowerPoint usually opens it without complaint.` });
    }
  }

  function countOf(xml: string | undefined, container: string, child: string): number | null {
    if (xml === undefined) return null;
    const m = new RegExp(`<(?:[\\w.-]+:)?${container}(?=[\\s>/])[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${container}>)`).exec(xml);
    if (!m) return null;
    return m[1] === undefined ? 0 : tagsNamed(m[1], child).length;
  }

  function xlsxRules(): void {
    const wb = get("xl/workbook.xml");
    if (wb !== undefined) {
      const sheets = tagsNamed(blockOf(wb, "", "sheets") || blockOf(wb, "[\\w.-]+", "sheets"), "sheet");
      const ids = new Map<string, number>();
      const nm = new Map<string, number>();
      for (const a of sheets) {
        if (a.sheetId !== undefined) ids.set(a.sheetId, (ids.get(a.sheetId) ?? 0) + 1);
        const k = (a.name ?? "").toLowerCase();
        nm.set(k, (nm.get(k) ?? 0) + 1);
      }
      for (const [id, c] of ids) if (c > 1) add({ severity: "tolerated", rule: "duplicate-id", part: "xl/workbook.xml", where: null, subject: "workbook", detail: `a sheet id used twice (${id})`, sentence: `Two sheets share the id ${id} in the workbook.` });
      for (const [k, c] of nm) if (c > 1) add({ severity: "likely-repair", rule: "duplicate-id", part: "xl/workbook.xml", where: null, subject: "workbook", detail: `a sheet name used twice ("${k}")`, sentence: `Two sheets are named "${k}" in the workbook.` });
    }
    const styles = get("xl/styles.xml");
    const xfCount = countOf(styles, "cellXfs", "xf");
    const fonts = countOf(styles, "fonts", "font");
    const fills = countOf(styles, "fills", "fill");
    const borders = countOf(styles, "borders", "border");
    if (styles !== undefined && xfCount !== null) {
      const m = /<(?:[\w.-]+:)?cellXfs(?=[\s>/])[\s\S]*?<\/(?:[\w.-]+:)?cellXfs>/.exec(styles);
      const bad = { font: 0, fill: 0, border: 0 };
      for (const a of tagsNamed(m?.[0] ?? "", "xf")) {
        if (fonts !== null && a.fontId !== undefined && Number(a.fontId) >= fonts) bad.font++;
        if (fills !== null && a.fillId !== undefined && Number(a.fillId) >= fills) bad.fill++;
        if (borders !== null && a.borderId !== undefined && Number(a.borderId) >= borders) bad.border++;
      }
      for (const k of ["font", "fill", "border"] as const) {
        if (bad[k] > 0) add({ severity: "likely-repair", rule: "xlsx-style-index", part: "xl/styles.xml", where: null, subject: "styles", detail: `${plural(bad[k], "cell format")} pointing to a ${k} that does not exist`, sentence: `${plural(bad[k], "cell format")} in xl/styles.xml point to a ${k} that is not defined.` });
      }
    }
    const sstPart = rawNames.find((n) => /^xl\/sharedStrings\.xml$/.test(n));
    const sstUnread = sstPart !== undefined && skipped.has(sstPart);
    const sstCount = sstPart && !sstUnread ? countOf(get(sstPart), "sst", "si") ?? tagsNamed(get(sstPart) ?? "", "si").length : null;
    for (const n of rawNames) {
      if (!/^xl\/worksheets\/[^/]*\.xml$/.test(n)) continue;
      const xml = get(n) ?? "";
      let badStr = 0;
      let badStyle = 0;
      const re = /<(?:[\w.-]+:)?c(?=[\s>])([^>]*?)(\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g;
      let m: RegExpExecArray | null;
      let firstStr = "";
      while ((m = re.exec(xml)) !== null) {
        const a = attrs(m[1]!);
        if (a.s !== undefined && /^\d+$/.test(a.s) && xfCount !== null && Number(a.s) >= xfCount) badStyle++;
        if (a.t === "s" && m[3] !== undefined && !sstUnread) {
          const v = /<(?:[\w.-]+:)?v>\s*(\d+)\s*<\/(?:[\w.-]+:)?v>/.exec(m[3]);
          if (v && (sstCount === null || Number(v[1]) >= sstCount)) {
            badStr++;
            firstStr ||= a.r ?? "";
          }
        }
      }
      if (badStr > 0) add({ severity: "likely-repair", rule: "xlsx-string-index", part: n, detail: `${plural(badStr, "cell")} pointing to a shared string that does not exist${firstStr ? ` (first ${firstStr})` : ""}`, sentence: `${plural(badStr, "cell")} ${sstCount === null ? "use shared strings but the workbook has none" : "point past the end of the shared strings"}${firstStr ? `, the first at ${firstStr}` : ""}.` });
      if (badStyle > 0) add({ severity: "likely-repair", rule: "xlsx-style-index", part: n, detail: `${plural(badStyle, "cell")} with a format that does not exist`, sentence: `${plural(badStyle, "cell")} use a cell format number past the end of the style table.` });
    }
  }

  function docxRules(): void {
    if (skipped.has("word/numbering.xml")) return;
    const numbering = get("word/numbering.xml");
    const nums = new Set<string>();
    const absDefined = new Set<string>();
    if (numbering !== undefined) {
      for (const a of tagsNamed(numbering, "num")) if (a.numId !== undefined || byLocal(a, "numId") !== undefined) nums.add(byLocal(a, "numId") ?? "");
      for (const a of tagsNamed(numbering, "abstractNum")) absDefined.add(byLocal(a, "abstractNumId") ?? "");
      const re = /<(?:[\w.-]+:)?num(?=[\s>])[^>]*>[\s\S]*?<(?:[\w.-]+:)?abstractNumId[^>]*?val="([^"]*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(numbering)) !== null) {
        if (!absDefined.has(m[1]!)) add({ severity: "likely-repair", rule: "docx-numid", part: "word/numbering.xml", where: null, subject: "numbering", detail: `a list definition using abstractNumId ${m[1]}, which does not exist`, sentence: `A list in word/numbering.xml uses abstract list ${m[1]}, which is not defined.` });
      }
    }
    for (const n of rawNames) {
      if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes|styles)\.xml$/.test(n)) continue;
      const xml = get(n) ?? "";
      const missing = new Set<string>();
      for (const a of tagsNamed(xml, "numId")) {
        const v = byLocal(a, "val");
        if (v !== undefined && v !== "0" && !nums.has(v)) missing.add(v);
      }
      for (const id of missing) add({ severity: "likely-repair", rule: "docx-numid", part: n, detail: `a list that is not defined (numId ${id})`, sentence: `${n} uses list ${id}, which word/numbering.xml does not define${numbering === undefined ? " (the package has no numbering part)" : ""}.` });
    }
  }

  return { v: 1, app, findings };
}

// ---- wording for the page ----

/**
 * Every rule, in plain words. `detail` is the phrase after "has" (no element names, part paths or rule ids), `sentence` is one plain
 * line for a person who does not code, `fix` is one instruction for an AI agent (it can open the file itself). The technical `detail` and
 * `sentence` on the finding stay in the data for debugging; the page shows them only behind a click. A new rule without an entry here fails
 * test/structure-plain.test.ts.
 */
export interface PlainRule {
  detail: string;
  sentence: string;
  fix: string;
}
const PLAIN_SUBJECT: Record<string, string> = { package: "file", presentation: "deck", workbook: "workbook", styles: "workbook", numbering: "document" };
function plainPlace(f: StructureFinding): string {
  if (f.where === null) return `the ${PLAIN_SUBJECT[f.subject] ?? f.subject}`;
  return f.subject === "slide" || f.subject === "sheet" || f.subject === "document" ? f.where : `${f.where} ${PLAIN_SUBJECT[f.subject] ?? f.subject}`;
}
export const PLAIN_RULES: Record<string, (f: StructureFinding, app: OfficeApp) => PlainRule> = {
  "content-type-missing": (f, app) => ({ detail: "a part that is not labelled properly", sentence: `Part of this file is not labelled the way ${app} expects, so ${app} may refuse to open it.`, fix: `Some parts of the file are not labelled the way ${app} expects. Re-save or rebuild the file so every part is properly declared.` }),
  "duplicate-rel-id": (f, app) => ({ detail: "two links with the same name", sentence: `${plainPlace(f)} has two internal links with the same name, which ${app} can reject.`, fix: `In ${plainPlace(f)}, two internal links share one name. Give each link its own name.` }),
  "dangling-rel": (f) => ({ detail: "a link to something that is gone", sentence: `${plainPlace(f)} links to something that is no longer in the file.`, fix: `${plainPlace(f)} links to an item (such as a picture, chart or sheet) that is missing from the file. Put the item back, or remove the link.` }),
  "dangling-rel-id": (f) => ({ detail: "a reference to something that does not exist", sentence: `${plainPlace(f)} refers to something that does not exist in the file.`, fix: `${plainPlace(f)} refers to an item that does not exist. Remove the reference or add the missing item.` }),
  "main-part-missing": (f, app) => ({ detail: "no main content", sentence: `The file has no main content, so ${app} cannot open it.`, fix: `The file is missing its main content. Rebuild it so the ${app === "PowerPoint" ? "slides" : app === "Excel" ? "sheets" : "text"} are saved in it.` }),
  enum: (f, app) => ({ detail: f.detail, sentence: `${plainPlace(f)} has ${f.detail}, which ${app} treats as corrupt.`, fix: `${plainPlace(f)} has ${f.detail}. Replace it with a value ${app} accepts.` }),
  "chart-empty-value": (f, app) => ({ detail: f.detail, sentence: `${plainPlace(f)} has ${f.detail} where a number is needed, and ${app} rejects that.`, fix: `${plainPlace(f)} has ${f.detail} where a number is required. Fill them with numbers, or leave those points out of the chart.` }),
  "chart-nonnumeric-value": (f) => ({ detail: f.detail, sentence: `${plainPlace(f)} has ${f.detail} where a number is needed.`, fix: `${plainPlace(f)} has ${f.detail} where a number is required. Make those values real numbers.` }),
  "chart-axis-crossref": (f, app) => ({ detail: "an axis tied to an axis that does not exist", sentence: `${plainPlace(f)} has an axis tied to an axis that does not exist, and ${app} will likely ask to repair that.`, fix: `${plainPlace(f)} has an axis whose crossing axis (crossAx) names an axis id that is not in the chart. Set each axis's crossAx to the id of the chart's other axis.` }),
  "chart-line-invert": (f) => ({ detail: "a setting a line chart does not use", sentence: `${plainPlace(f)} has a leftover setting that a line chart does not use. The program usually opens it anyway.`, fix: `${plainPlace(f)} is a line chart that carries a setting only bar charts use. Remove that setting.` }),
  "chart-no-grouping": (f) => ({ detail: "a line chart missing a required setting", sentence: `${plainPlace(f)} is a line chart that is missing a setting the format requires. The program usually opens it anyway.`, fix: `${plainPlace(f)} is a line chart missing its standard grouping setting. Add the standard setting.` }),
  "duplicate-id": (f, app) => ({ detail: f.detail, sentence: `${plainPlace(f)} has ${f.detail}, which ${app} may not accept.`, fix: `${plainPlace(f)} has ${f.detail}. Make each one unique.` }),
  "duplicate-shape-id": (f) => ({ detail: "shapes that share an identifier", sentence: `${plainPlace(f)} has shapes that share an identifier. The program usually opens it anyway.`, fix: `${plainPlace(f)} has shapes that share an identifier. Give each shape its own.` }),
  "xlsx-style-index": (f, app) => ({ detail: "cells with a format that does not exist", sentence: `Some cells use a format that does not exist, and ${app} may ask to repair the workbook.`, fix: `Some cells use a cell format that is not defined in the workbook. Point them at a format that exists.` }),
  "xlsx-string-index": (f, app) => ({ detail: "cells pointing at text that does not exist", sentence: `Some cells point at text that is not stored in the workbook, and ${app} may ask to repair it.`, fix: `${plainPlace(f)} has cells that point at text that is not stored in the workbook. Rewrite those cells with their real text.` }),
  "docx-numid": (f, app) => ({ detail: "a list whose definition is missing", sentence: `A list in the document has no definition, and ${app} may ask to repair it.`, fix: `A bulleted or numbered list in the document has no definition. Re-create the list with the standard list style.` }),
};
const plainOf = (f: StructureFinding, app: OfficeApp): PlainRule => {
  const r = PLAIN_RULES[f.rule];
  return r ? r(f, app) : { detail: "a problem", sentence: `${plainPlace(f)} has a problem in how the file is built.`, fix: `${plainPlace(f)} has a problem in how the file is built. Re-save the file so it opens cleanly.` };
};
/** One plain sentence for a finding, for a person who does not code: the text of the connector's issue (migration X1). */
export const plainSentence = (f: StructureFinding, app: OfficeApp): string => plainOf(f, app).sentence;
