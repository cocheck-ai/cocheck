import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { XMLValidator } from "fast-xml-parser";

// The OPC/PresentationML package invariants PowerPoint enforces before it opens a deck without a repair prompt.
// Moved out of test/pptx-fixtures-valid.test.ts so the tag kill test can hold its output to the same bar.

export type Files = Record<string, string>;
interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

export const load = (bytes: Uint8Array): Files => {
  const out: Files = {};
  for (const [name, data] of Object.entries(unzipSync(bytes))) out[name] = /\.(xml|rels)$/.test(name) ? strFromU8(data) : "";
  return out;
};

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
};

const relsOf = (files: Files, part: string): Rel[] => {
  const dir = path.posix.dirname(part);
  const xml = files[`${dir === "." ? "" : `${dir}/`}_rels/${path.posix.basename(part)}.rels`];
  if (xml === undefined) return [];
  return [...xml.matchAll(/<Relationship\s[^>]*>/g)].map((m) => {
    const a = attrs(m[0]);
    const external = a.TargetMode === "External";
    const target = external ? a.Target! : a.Target!.startsWith("/") ? a.Target!.slice(1) : path.posix.join(dir === "." ? "" : dir, a.Target!);
    return { id: a.Id!, type: a.Type!, target: external ? target : path.posix.normalize(target), external };
  });
};

const ofType = (rels: Rel[], suffix: string): Rel[] => rels.filter((r) => r.type.endsWith(`/${suffix}`));

export function validate(files: Files): string[] {
  const bad: string[] = [];
  const names = Object.keys(files).filter((n) => !n.endsWith("/"));
  const xmlParts = names.filter((n) => /\.(xml|rels)$/.test(n));

  for (const n of xmlParts) {
    const ok = XMLValidator.validate(files[n]!);
    if (ok !== true) bad.push(`${n}: not well-formed XML (${ok.err.msg})`);
  }

  // Content types: a Default or Override for every part; every Override names a real part.
  const ct = files["[Content_Types].xml"] ?? "";
  const defaults = new Set([...ct.matchAll(/<Default\s[^>]*>/g)].map((m) => attrs(m[0]).Extension!.toLowerCase()));
  const overrides = new Set([...ct.matchAll(/<Override\s[^>]*>/g)].map((m) => attrs(m[0]).PartName!));
  for (const n of names) {
    if (n === "[Content_Types].xml") continue;
    if (!overrides.has(`/${n}`) && !defaults.has(n.endsWith(".rels") ? "rels" : path.posix.extname(n).slice(1).toLowerCase())) bad.push(`${n}: no content type`);
  }
  for (const o of overrides) if (!names.includes(o.slice(1))) bad.push(`${o}: content-type override for a missing part`);
  for (const n of names) if (/^ppt\/(slides|slideLayouts|slideMasters|notesSlides|notesMasters|charts)\/[^/]+\.xml$/.test(n) && !overrides.has(`/${n}`)) bad.push(`${n}: needs an Override, xml Default is not enough`);

  // Relationships: ids unique, targets exist, no rels file for a missing source, no orphan parts.
  const reached = new Set<string>(["[Content_Types].xml", "_rels/.rels"]);
  const queue = [""];
  const seen = new Set<string>();
  while (queue.length) {
    const src = queue.pop()!;
    if (seen.has(src)) continue;
    seen.add(src);
    const rels = relsOf(files, src === "" ? "" : src);
    if (src === "") {
      for (const m of (files["_rels/.rels"] ?? "").matchAll(/<Relationship\s[^>]*>/g)) {
        const a = attrs(m[0]);
        const target = a.Target!.replace(/^\//, "");
        if (!names.includes(target)) bad.push(`_rels/.rels: ${a.Id} -> ${target} missing`);
        reached.add(target);
        queue.push(target);
      }
      continue;
    }
    const ids = rels.map((r) => r.id);
    if (new Set(ids).size !== ids.length) bad.push(`${src}: duplicate relationship ids`);
    for (const r of rels) {
      if (r.external) continue;
      if (!names.includes(r.target)) bad.push(`${src}: ${r.id} -> ${r.target} missing`);
      else {
        reached.add(r.target);
        queue.push(r.target);
      }
    }
  }
  for (const n of names) {
    if (n === "_rels/.rels") continue;
    if (n.endsWith(".rels")) {
      const owner = n.replace(/_rels\//, "").replace(/\.rels$/, "");
      if (!names.includes(owner)) bad.push(`${n}: rels for a missing part`);
    } else if (!reached.has(n)) bad.push(`${n}: orphan part (no relationship reaches it)`);
  }

  // Every r:id / r:embed / r:link in a part resolves in that part's rels.
  for (const n of xmlParts.filter((x) => !x.endsWith(".rels") && x !== "[Content_Types].xml")) {
    const ids = new Set(relsOf(files, n).map((r) => r.id));
    for (const m of files[n]!.matchAll(/\sr:(?:id|embed|link|pict)="([^"]*)"/g)) if (!ids.has(m[1]!)) bad.push(`${n}: r:id ${m[1]} does not resolve`);
  }

  // Shape ids unique per slide-like part; txBody completeness; graphicFrame xfrm.
  for (const n of names.filter((x) => /^ppt\/(slides|notesSlides|notesMasters|slideMasters|slideLayouts)\/[^/]+\.xml$/.test(x))) {
    const xml = files[n]!;
    const ids = [...xml.matchAll(/<p:cNvPr\s[^>]*>/g)].map((m) => attrs(m[0]).id);
    if (new Set(ids).size !== ids.length) bad.push(`${n}: duplicate shape ids`);
    for (const m of xml.matchAll(/<p:txBody>(.*?)<\/p:txBody>/gs)) if (!/^<a:bodyPr[\s/>]/.test(m[1]!) || !/<a:lstStyle[\s/>]/.test(m[1]!)) bad.push(`${n}: txBody without bodyPr then lstStyle`);
    for (const m of xml.matchAll(/<p:graphicFrame>(.*?)<\/p:graphicFrame>/gs)) if (!/<p:xfrm>/.test(m[1]!)) bad.push(`${n}: graphicFrame without p:xfrm`);
  }

  // presentation.xml.
  const pres = files["ppt/presentation.xml"] ?? "";
  const presRels = relsOf(files, "ppt/presentation.xml");
  const relIds = new Set(presRels.map((r) => r.id));
  const sldIds = [...pres.matchAll(/<p:sldId\s[^>]*>/g)].map((m) => attrs(m[0]));
  if (new Set(sldIds.map((a) => a.id)).size !== sldIds.length) bad.push("presentation: duplicate sldId");
  for (const a of sldIds) {
    if (Number(a.id) < 256 || Number(a.id) >= 2147483648) bad.push(`presentation: sldId ${a.id} out of range`);
    if (!relIds.has(a["r:id"]!)) bad.push(`presentation: sldId r:id ${a["r:id"]} unresolved`);
  }
  if (sldIds.length !== ofType(presRels, "slide").length) bad.push("presentation: sldIdLst and slide rels disagree");
  if (!/<p:sldSz\s[^>]*cx="\d+"[^>]*cy="\d+"/.test(pres)) bad.push("presentation: sldSz missing");
  if (!/<p:notesSz\s/.test(pres)) bad.push("presentation: notesSz missing");
  const order = ["sldMasterIdLst", "notesMasterIdLst", "handoutMasterIdLst", "sldIdLst", "sldSz", "notesSz", "defaultTextStyle"]
    .map((t) => pres.indexOf(`<p:${t}`))
    .filter((i) => i >= 0);
  if (order.some((v, i) => i > 0 && v < order[i - 1]!)) bad.push("presentation: child elements out of schema order");
  const masters = ofType(presRels, "slideMaster");
  const notesMasters = ofType(presRels, "notesMaster");
  const hasNotesSlides = names.some((x) => /^ppt\/notesSlides\/[^/]+\.xml$/.test(x));
  if (notesMasters.length > 1) bad.push("presentation: more than one notesMaster");
  if (hasNotesSlides && notesMasters.length === 0) bad.push("presentation: notes slides without a notesMaster");
  if (notesMasters.length === 1 && !/<p:notesMasterIdLst><p:notesMasterId r:id="/.test(pres)) bad.push("presentation: notesMasterIdLst missing");
  if (notesMasters.length === 0 && /<p:notesMasterIdLst/.test(pres)) bad.push("presentation: notesMasterIdLst without a notesMaster");
  for (const nm of notesMasters) if (ofType(relsOf(files, nm.target), "theme").length !== 1) bad.push(`${nm.target}: needs exactly one theme rel`);
  const themeTargets = [...masters, ...notesMasters].map((m) => ofType(relsOf(files, m.target), "theme")[0]?.target);
  if (new Set(themeTargets).size !== themeTargets.length) bad.push("masters share a theme part");

  // Master and layout ids: >= 2^31, unique across masters and layouts.
  const allIds: string[] = [];
  for (const m of masters) {
    const xml = files[m.target]!;
    const mid = (pres.match(new RegExp(`<p:sldMasterId\\s[^>]*id="(\\d+)"[^>]*r:id="${m.id}"`)) ?? [])[1];
    if (mid === undefined) bad.push(`presentation: no sldMasterId for ${m.id}`);
    else allIds.push(mid);
    const mrels = relsOf(files, m.target);
    const layoutRels = ofType(mrels, "slideLayout");
    const listed = [...xml.matchAll(/<p:sldLayoutId\s[^>]*>/g)].map((x) => attrs(x[0]));
    if (listed.length !== layoutRels.length) bad.push(`${m.target}: sldLayoutIdLst and layout rels disagree`);
    for (const a of listed) {
      allIds.push(a.id!);
      if (!mrels.some((r) => r.id === a["r:id"])) bad.push(`${m.target}: sldLayoutId r:id ${a["r:id"]} unresolved`);
    }
    for (const lr of layoutRels) if (!ofType(relsOf(files, lr.target), "slideMaster").some((r) => r.target === m.target)) bad.push(`${lr.target}: does not point back at its master`);
    if (ofType(mrels, "theme").length !== 1) bad.push(`${m.target}: needs exactly one theme rel`);
    if (!/<p:txStyles>/.test(xml) || !/<p:titleStyle>/.test(xml) || !/<p:bodyStyle>/.test(xml)) bad.push(`${m.target}: txStyles incomplete`);
  }
  if (allIds.some((i) => Number(i) < 2147483648)) bad.push("master/layout ids must be >= 2147483648");
  if (new Set(allIds).size !== allIds.length) bad.push("master/layout ids not unique");
  if (!/<p:cSld/.test(files[masters[0]?.target ?? ""] ?? "")) bad.push("no slide master");

  // Slides: exactly one layout; notes slide points at the notes master and back at the slide.
  for (const s of ofType(presRels, "slide")) {
    const rels = relsOf(files, s.target);
    if (ofType(rels, "slideLayout").length !== 1) bad.push(`${s.target}: needs exactly one slideLayout rel`);
    for (const ns of ofType(rels, "notesSlide")) {
      const nrels = relsOf(files, ns.target);
      if (!ofType(nrels, "slide").some((r) => r.target === s.target)) bad.push(`${ns.target}: missing rel back to ${s.target}`);
      if (!ofType(nrels, "notesMaster").some((r) => notesMasters.some((m) => m.target === r.target))) bad.push(`${ns.target}: missing notesMaster rel`);
    }
  }

  // Content PowerPoint's own decks always carry and hand-rolled skeletons tend to drop.
  if (!/<p:defaultTextStyle>/.test(pres)) bad.push("presentation: defaultTextStyle missing");
  for (const m of masters) {
    for (const style of ["bodyStyle", "otherStyle"]) {
      const body = (files[m.target]!.match(new RegExp(`<p:${style}>(.*?)</p:${style}>`, "s")) ?? [])[1] ?? "";
      for (let l = 1; l <= 9; l++) if (!body.includes(`<a:lvl${l}pPr`)) bad.push(`${m.target}: ${style} lacks level ${l}`);
    }
  }
  for (const nm of notesMasters) {
    const body = (files[nm.target]!.match(/<p:notesStyle>(.*?)<\/p:notesStyle>/s) ?? [])[1] ?? "";
    for (let l = 1; l <= 9; l++) if (!body.includes(`<a:lvl${l}pPr`)) bad.push(`${nm.target}: notesStyle lacks level ${l}`);
    for (const ph of ["hdr", "dt", "sldImg", "body", "ftr", "sldNum"]) if (!files[nm.target]!.includes(`<p:ph type="${ph}"`)) bad.push(`${nm.target}: no ${ph} placeholder`);
  }
  for (const n of names.filter((x) => /^ppt\/theme\/[^/]+\.xml$/.test(x))) {
    for (const [list, item] of [["fillStyleLst", "(?:solidFill|gradFill|noFill|pattFill|blipFill)"], ["lnStyleLst", "ln"], ["effectStyleLst", "effectStyle"], ["bgFillStyleLst", "(?:solidFill|gradFill|noFill|pattFill|blipFill)"]] as const) {
      const body = (files[n]!.match(new RegExp(`<a:${list}>(.*?)</a:${list}>`, "s")) ?? [])[1] ?? "";
      const count = (body.match(new RegExp(`<a:${item}[\\s>/]`, "g")) ?? []).length;
      if (count < 3) bad.push(`${n}: ${list} needs at least 3 entries`);
    }
  }

  // Tables use a style PowerPoint knows; charts have their axes, plot area and workbook.
  const tableStyles = files["ppt/tableStyles.xml"] ?? "";
  for (const n of names.filter((x) => /^ppt\/slides\/[^/]+\.xml$/.test(x))) {
    for (const m of files[n]!.matchAll(/<a:tableStyleId>([^<]*)<\/a:tableStyleId>/g)) if (!tableStyles.includes(`<a:tblStyle styleId="${m[1]}"`)) bad.push(`${n}: table style ${m[1]} is named but not defined in tableStyles.xml`);
    for (const m of files[n]!.matchAll(/<p:graphicFrame>(.*?)<\/p:graphicFrame>/gs)) {
      const tbl = (m[1]!.match(/<a:tbl>(.*?)<\/a:tbl>/s) ?? [])[1];
      if (tbl === undefined) continue;
      const cols = [...tbl.matchAll(/<a:gridCol\s+w="(\d+)"/g)].map((c) => Number(c[1]));
      const rows = [...tbl.matchAll(/<a:tr\s+h="(\d+)"[^>]*>(.*?)<\/a:tr>/gs)];
      const ext = m[1]!.match(/<p:xfrm><a:off [^>]*\/><a:ext cx="(\d+)" cy="(\d+)"/);
      if (!ext) bad.push(`${n}: table frame without xfrm`);
      else {
        if (cols.reduce((a, b) => a + b, 0) !== Number(ext[1])) bad.push(`${n}: gridCol widths do not sum to the frame width`);
        if (rows.reduce((a, r) => a + Number(r[1]), 0) !== Number(ext[2])) bad.push(`${n}: row heights do not sum to the frame height`);
      }
      if (!/<a:tblPr[^>]*>.*<a:tableStyleId>/s.test(tbl)) bad.push(`${n}: tblPr without tableStyleId`);
      if ((tbl.match(/a16:colId/g) ?? []).length !== cols.length) bad.push(`${n}: every gridCol needs an a16:colId`);
      const rowIds = [...tbl.matchAll(/a16:rowId[^>]*val="(\d+)"/g)].map((r) => r[1]);
      if (rowIds.length !== rows.length || new Set(rowIds).size !== rowIds.length) bad.push(`${n}: every a:tr needs a unique a16:rowId`);
      for (const r of rows) {
        const cells = [...r[2]!.matchAll(/<a:tc>(.*?)<\/a:tc>/gs)];
        if (cells.length !== cols.length) bad.push(`${n}: row cell count differs from gridCol count`);
        if (!/<\/a:tc><a:extLst>/.test(r[2]!)) bad.push(`${n}: row extLst must follow the cells`);
        for (const c of cells) if (!/^<a:txBody><a:bodyPr\/><a:lstStyle\/><a:p>.*<\/a:txBody><a:tcPr\/?>/s.test(c[1]!)) bad.push(`${n}: a:tc must be txBody(bodyPr,lstStyle,p+) then tcPr`);
      }
    }
  }
  for (const n of names.filter((x) => /^ppt\/charts\/[^/]+\.xml$/.test(x))) {
    const xml = files[n]!;
    if (!/<c:plotArea>/.test(xml)) bad.push(`${n}: no plotArea`);
    const ax = [...xml.matchAll(/<c:(?:catAx|valAx|dateAx|serAx)>\s*<c:axId val="(\d+)"/g)].map((m) => m[1]);
    const used = [...xml.matchAll(/<c:axId val="(\d+)"\/><c:axId val="(\d+)"\/><\/c:\w+Chart>/g)].flatMap((m) => [m[1], m[2]]);
    for (const u of used) if (!ax.includes(u)) bad.push(`${n}: chart axId ${u} has no axis`);
    if (/<c:externalData/.test(xml) && ofType(relsOf(files, n), "package").length !== 1) bad.push(`${n}: externalData without a package rel`);
  }
  return bad;
}
