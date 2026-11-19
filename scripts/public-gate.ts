// The leak gate for the public export. Usage: node scripts/public-gate.ts <dir>   or   ... --text-stdin (scans stdin as one text file)
// or   ... --git-history <repo dir> (every commit reachable from HEAD: author and committer name and email, and the full message; hit lines are
// `<short sha> <field>: <rule id>`; only the denylist judges commits, no identity is exempt).
// Exit 0 and "public-gate: clean (<N> files)" when nothing hits; exit 1 and one `<relpath>:<line>: <rule id>` per hit otherwise (the
// matched text is never printed); exit 2 when the gate itself cannot run (no denylist, empty denylist, bad pattern, bad usage).
// Bound: this catches the denylist patterns, the gitleaks rules and the named metadata fields. It is not a general personal-data detector.
// Compressed PDF streams, XMP packets and image EXIF are not inspected. A file the gate cannot read is a hit.
// Accepted gap: the gate reads plain text, OOXML parts and PDF Info strings only. A file that holds a NUL byte, any other binary encoding
// (UTF-16 text outside OOXML and PDF, compressed or packed data) and archives other than OOXML (tar, gz, plain zip, jar) are not scanned, so
// owner-identifying text inside them passes. release.sh also checks the installed version by substring match, not equality.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { Zip } from "../src/office/connector/pptx/zip.ts";
import { firstSecretRule } from "../src/secret-scan.ts";

const DENYLIST = path.join(import.meta.dirname, "public-denylist.txt");
// Export-ignored, so the public copy of the gate never sees it. COCHECK_GATE_ALLOW points the gate at another file (the tests use it).
const ALLOW = process.env.COCHECK_GATE_ALLOW ?? path.join(import.meta.dirname, "public-gate-allow.txt");
// Metadata values that may stay: exact strings, compared after trimming. Anything else in an author, last-modified-by, company or
// manager field (and in a PDF /Author) is a hit.
const ALLOWED_META = new Set(["CoCheck", "CoCheck test fixture", "python-docx", "openpyxl", "Steve Canny", "PptxGenJS", "Sample Author A"]);
const OOXML = new Set(["docx", "docm", "dotx", "dotm", "xlsx", "xlsm", "xltx", "xltm", "pptx", "pptm", "potx", "potm", "ppsx", "ppsm"]);
const TEXT_PART = /\.(xml|rels|vml|txt|json)$/i;

interface Rule {
  id: string;
  re: RegExp;
}
export interface Hit {
  file: string;
  line: number;
  rule: string;
}

export function loadDenylist(file: string = DENYLIST): Rule[] {
  const rules: Rule[] = [];
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) return;
      const end = line.lastIndexOf("/");
      if (!line.startsWith("/") || end < 1) throw new Error(`denylist line ${i + 1} is not /pattern/flags`);
      const flags = line.slice(end + 1).replace(/[gy]/g, "");
      rules.push({ id: `DENY-${i + 1}`, re: new RegExp(line.slice(1, end), flags) });
    });
  if (rules.length === 0) throw new Error("denylist has no patterns");
  return rules;
}

/** `<relpath> <rule id> <sha256 of the whole file> # reason`, one per line. Exact file and exact rule; the hash pins the content. */
export function loadAllow(file: string = ALLOW): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(file)) return entries;
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) return;
      const m = /^(\S+) (\S+) ([0-9a-f]{64}) # \S.*$/.exec(line);
      if (m === null) throw new Error(`allow line ${i + 1} is not "<relpath> <rule id> <sha256> # reason"`);
      entries.set(`${m[1]}\0${m[2]}`, m[3]!);
    });
  return entries;
}

function denyHits(rules: Rule[], text: string, file: string, out: Hit[], firstLine = 1): void {
  const lines = text.split(/\r\n|\r|\n/);
  for (const rule of rules) {
    for (let i = 0; i < lines.length; i++) if (rule.re.test(lines[i]!)) out.push({ file, line: i + firstLine, rule: rule.id });
  }
}

function secretHit(text: string, file: string, out: Hit[]): void {
  if (firstSecretRule(text) === undefined) return;
  const lines = text.split(/\r\n|\r|\n/);
  let at = 1;
  if (lines.length > 1) {
    const i = lines.findIndex((l) => firstSecretRule(l) !== undefined);
    if (i >= 0) at = i + 1;
  }
  out.push({ file, line: at, rule: "SECRET" });
}

/** True when every value of the field is empty or one of the allowed exact strings. */
function fieldOk(xml: string, tag: string): boolean {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  for (const m of xml.matchAll(re)) {
    const v = m[1]!.replace(/<[^>]*>/g, "").trim();
    if (v !== "" && !ALLOWED_META.has(v)) return false;
  }
  return true;
}

function scanOoxml(rules: Rule[], bytes: Uint8Array, file: string, out: Hit[]): void {
  const zip = new Zip(bytes);
  for (const name of zip.names) {
    if (name.endsWith("/")) continue;
    const part = zip.read(name);
    const label = `${file}!${name}`;
    denyHits(rules, name, label, out, 0);
    if (!TEXT_PART.test(name) && part.includes(0)) continue;
    const text = Buffer.from(part).toString("utf8");
    denyHits(rules, text, label, out);
    if (name === "docProps/core.xml") {
      if (!fieldOk(text, "dc:creator")) out.push({ file: label, line: 1, rule: "META-CREATOR" });
      if (!fieldOk(text, "cp:lastModifiedBy")) out.push({ file: label, line: 1, rule: "META-LAST-MODIFIED-BY" });
    }
    if (name === "docProps/app.xml") {
      if (!fieldOk(text, "Company")) out.push({ file: label, line: 1, rule: "META-COMPANY" });
      if (!fieldOk(text, "Manager")) out.push({ file: label, line: 1, rule: "META-MANAGER" });
    }
  }
}

/** Decode a PDF string token (`<hex>` or `(literal)`) to text: UTF-16 when it starts with a byte-order mark, else Latin-1. */
function decodePdfString(tok: string): string {
  let bytes: number[] = [];
  if (tok.startsWith("<")) {
    let hex = tok.slice(1, -1).replace(/[^0-9A-Fa-f]/g, "");
    if (hex.length % 2 === 1) hex += "0";
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  } else {
    const body = tok.slice(1, -1);
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!;
      if (c !== "\\") {
        bytes.push(body.charCodeAt(i) & 0xff);
        continue;
      }
      const n = body[++i];
      if (n === undefined) break;
      const oct = /^[0-7]{1,3}/.exec(body.slice(i, i + 3));
      if (oct !== null) {
        bytes.push(parseInt(oct[0], 8) & 0xff);
        i += oct[0].length - 1;
      } else if (n === "\r" || n === "\n") {
        if (n === "\r" && body[i + 1] === "\n") i++;
      } else bytes.push(simple[n] ?? (n.charCodeAt(0) & 0xff));
    }
  }
  const buf = Buffer.from(bytes);
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  return buf.toString("latin1");
}

const PDF_STRING = String.raw`\((?:\\[\s\S]|[^\\)])*\)|<[^>]*>`;

function scanPdf(rules: Rule[], bytes: Uint8Array, file: string, out: Hit[]): void {
  const raw = Buffer.from(bytes).toString("latin1");
  denyHits(rules, raw, file, out);
  const lineOf = (index: number): number => raw.slice(0, index).split(/\r\n|\r|\n/).length;
  // Info strings in hex or octal escapes hide words from the byte scan above: decode them and scan the text too.
  for (const m of raw.matchAll(new RegExp(String.raw`/(?:Title|Author|Subject|Keywords|Creator|Producer|Company|Manager)\s*(${PDF_STRING})`, "g"))) {
    const text = decodePdfString(m[1]!);
    if (text !== m[1]!.slice(1, -1)) denyHits(rules, text, file, out, lineOf(m.index));
  }
  for (const m of raw.matchAll(new RegExp(String.raw`/Author\s*(${PDF_STRING}|\d+\s+\d+\s+R)`, "g"))) {
    const v = m[1]!;
    if (v.endsWith("R") && !v.startsWith("(") && !v.startsWith("<")) {
      out.push({ file, line: lineOf(m.index), rule: "PDF-AUTHOR-INDIRECT" });
      continue;
    }
    const text = decodePdfString(v).trim();
    if (text !== "" && !ALLOWED_META.has(text)) out.push({ file, line: lineOf(m.index), rule: "PDF-AUTHOR" });
  }
}

function scanFile(rules: Rule[], abs: string, rel: string, out: Hit[]): void {
  denyHits(rules, rel, rel, out, 0);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    denyHits(rules, readlinkSync(abs), rel, out, 0);
    return;
  }
  if (!st.isFile()) return;
  const bytes = readFileSync(abs);
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (OOXML.has(ext)) return scanOoxml(rules, bytes, rel, out);
  if (ext === "pdf" || bytes.subarray(0, 5).toString("latin1") === "%PDF-") return scanPdf(rules, bytes, rel, out);
  if (bytes.includes(0)) return;
  const text = bytes.toString("utf8");
  denyHits(rules, text, rel, out);
  secretHit(text, rel, out);
}

/** Drop the hits an allow entry covers: same file, same rule, and the file's sha256 equals the pinned one. */
function suppress(allow: Map<string, string>, abs: string, rel: string, found: Hit[]): Hit[] {
  if (found.length === 0 || allow.size === 0) return found;
  let sha: string | undefined;
  return found.filter((h) => {
    const want = allow.get(`${rel}\0${h.rule}`);
    if (want === undefined) return true;
    sha ??= createHash("sha256").update(readFileSync(abs)).digest("hex");
    return want !== sha;
  });
}

function walk(dir: string, base: string, files: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) walk(path.join(dir, e.name), rel, files);
    else files.push(rel);
  }
}

/** Every commit reachable from HEAD of `repo`: the five identity and message fields go through the denylist. Throws when git cannot read the history. */
function historyHits(rules: Rule[], repo: string, out: Hit[]): number {
  const r = spawnSync("git", ["-C", repo, "log", "HEAD", "--no-mailmap", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x01"], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error("git log failed");
  const fields = ["author-name", "author-email", "committer-name", "committer-email", "message"];
  let count = 0;
  for (const record of r.stdout.split("\x01")) {
    if (record.trim() === "") continue;
    count++;
    const parts = record.replace(/^\n/, "").split("\0");
    const short = parts[0]!.slice(0, 8);
    fields.forEach((field, i) => {
      for (const rule of rules) if (rule.re.test(parts[i + 1] ?? "")) out.push({ file: short, line: 0, rule: `${field}: ${rule.id}` });
    });
  }
  return count;
}

function main(): number {
  const arg = process.argv[2];
  let rules: Rule[];
  try {
    rules = loadDenylist();
  } catch (error) {
    console.error(`public-gate: cannot run: ${(error as Error).message}`);
    return 2;
  }
  let allow: Map<string, string>;
  try {
    allow = loadAllow();
  } catch (error) {
    console.error(`public-gate: cannot run: ${(error as Error).message}`);
    return 2;
  }
  const hits: Hit[] = [];
  let count = 0;
  if (arg === "--text-stdin") {
    const text = readFileSync(0, "utf8");
    denyHits(rules, text, "<stdin>", hits);
    count = 1;
  } else if (arg === "--git-history" && process.argv.length === 4) {
    try {
      count = historyHits(rules, process.argv[3]!, hits);
    } catch (error) {
      console.error(`public-gate: cannot read the history of ${process.argv[3]}: ${(error as Error).message}`);
      return 2;
    }
    if (hits.length === 0) {
      console.log(`public-gate: history clean (${count} commits)`);
      return 0;
    }
    for (const h of hits) console.log(`${h.file} ${h.rule}`);
    return 1;
  } else if (arg !== undefined && process.argv.length === 3) {
    const files: string[] = [];
    try {
      walk(arg, "", files);
    } catch (error) {
      console.error(`public-gate: cannot read ${arg}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
      return 2;
    }
    files.sort();
    count = files.length;
    for (const rel of files) {
      const found: Hit[] = [];
      try {
        scanFile(rules, path.join(arg, rel), rel, found);
      } catch {
        found.push({ file: rel, line: 0, rule: "UNREADABLE" });
      }
      hits.push(...suppress(allow, path.join(arg, rel), rel, found));
    }
  } else {
    console.error("usage: node scripts/public-gate.ts <dir> | --text-stdin | --git-history <repo dir>");
    return 2;
  }
  if (hits.length === 0) {
    console.log(`public-gate: clean (${count} files)`);
    return 0;
  }
  for (const h of hits) console.log(`${h.file}:${h.line}: ${h.rule}`);
  return 1;
}

process.exitCode = main();
