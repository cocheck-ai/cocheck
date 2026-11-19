// Test helper: the same Office package with every XML part spelled differently and meaning the same thing. Each modelled namespace gets a
// prefix of its own (`n0`, `n1`, ...), including the one the part wrote as its default, attributes are single-quoted, and `=` is spaced. Readers
// that identify elements by namespace URI and local name read the result exactly as the original; readers that match a writer's prefix do not.
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

const MODELLED = new Set([
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://schemas.openxmlformats.org/drawingml/2006/chart",
  "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  "http://schemas.openxmlformats.org/drawingml/2006/picture",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://schemas.openxmlformats.org/package/2006/relationships",
  "http://schemas.openxmlformats.org/package/2006/content-types",
]);

export interface Respell { bom?: boolean }

/** One XML part respelled; a part with no declaration of a modelled namespace on its root comes back unchanged. */
export function respellXml(xml: string, opts: Respell = {}): string {
  const rootAt = /<(?![?!])[^\s/>]+(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(xml);
  if (!rootAt) return xml;
  const names = new Map<string, string>(); // old prefix ("" for default) -> new prefix
  let n = 0;
  for (const m of rootAt[0].matchAll(/\sxmlns(?::([^\s=]+))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (MODELLED.has(m[2] ?? m[3] ?? "")) names.set(m[1] ?? "", `n${n++}`);
  }
  if (names.size === 0) return xml;
  const out = xml.replace(/<(\/?)([^\s/>!?][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (_w, slash: string, name: string, rest: string) => {
    const c = name.indexOf(":");
    const old = c < 0 ? "" : name.slice(0, c);
    const local = c < 0 ? name : name.slice(c + 1);
    const to = names.get(old);
    const qname = to === undefined ? name : `${to}:${local}`;
    if (slash) return `</${qname}>`;
    const attrs = rest.replace(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_a, an: string, dq?: string, sq?: string) => {
      const v = dq ?? sq ?? "";
      let nn = an;
      if (an === "xmlns") nn = names.has("") ? `xmlns:${names.get("")}` : an;
      else if (an.startsWith("xmlns:")) nn = names.has(an.slice(6)) ? `xmlns:${names.get(an.slice(6))}` : an;
      else if (an.includes(":") && names.has(an.slice(0, an.indexOf(":")))) nn = `${names.get(an.slice(0, an.indexOf(":")))}:${an.slice(an.indexOf(":") + 1)}`;
      return `${nn} = '${v.replace(/'/g, "&apos;")}'`;
    });
    return `<${qname}${attrs}>`;
  });
  return (opts.bom ? "﻿" : "") + out;
}

/** Every .xml and .rels part of the package respelled; other parts keep their bytes. */
export function respell(bytes: Uint8Array, opts: Respell = {}): Uint8Array {
  const files = unzipSync(bytes);
  const out: Zippable = {};
  for (const [name, data] of Object.entries(files)) out[name] = /\.(xml|rels)$/i.test(name) ? strToU8(respellXml(strFromU8(data), opts)) : data;
  return zipSync(out);
}
