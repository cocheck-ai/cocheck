// Generates src/secret-rules.generated.ts from the vendored gitleaks default config (vendor/gitleaks/gitleaks.toml, pinned by
// vendor/gitleaks/VERSION). Run: `node scripts/gen-secret-rules.ts`. Nothing is added or edited by hand: the generated module is a mechanical
// translation of the upstream TOML (Go RE2 regex syntax to JavaScript). A rule that cannot be translated is printed and recorded in
// EXCLUDED_RULES with the reason; it is never dropped silently.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toml = readFileSync(join(root, "vendor/gitleaks/gitleaks.toml"), "utf8");
const license = readFileSync(join(root, "vendor/gitleaks/LICENSE"), "utf8").trimEnd();
const version = readFileSync(join(root, "vendor/gitleaks/VERSION"), "utf8").trim();

// ---- the TOML subset gitleaks' default config uses: tables, [[arrays of tables]], key = '''literal''' | "basic" | number | [ list ] ----

type Value = string | number | string[];
interface Table {
  [key: string]: Value;
}
interface RawRule extends Table {}
interface RawAllow extends Table {}

function parseToml(text: string): { global: Table; globalAllow: RawAllow; rules: Array<{ rule: RawRule; allows: RawAllow[] }> } {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const global: Table = {};
  const globalAllow: RawAllow = {};
  const rules: Array<{ rule: RawRule; allows: RawAllow[] }> = [];
  let target: Table = global;
  const readValue = (first: string): Value => {
    let s = first.trim();
    if (s.startsWith("[")) {
      let buf = s;
      while (!/\]\s*$/.test(buf) || !balanced(buf)) buf += "\n" + lines[++i];
      return parseList(buf);
    }
    return parseScalar(s);
  };
  const balanced = (b: string): boolean => {
    // a list is closed when its last `]` is outside any literal string
    let inLit: string | null = null;
    let depth = 0;
    for (let k = 0; k < b.length; k++) {
      if (inLit !== null) {
        if (b.startsWith(inLit, k)) {
          k += inLit.length - 1;
          inLit = null;
        } else if (inLit === '"' && b[k] === "\\") k++;
        continue;
      }
      if (b.startsWith("'''", k)) {
        inLit = "'''";
        k += 2;
      } else if (b[k] === '"') inLit = '"';
      else if (b[k] === "'") inLit = "'";
      else if (b[k] === "[") depth++;
      else if (b[k] === "]") depth--;
    }
    return depth === 0;
  };
  const parseScalar = (s: string): string | number => {
    s = s.trim();
    if (s.startsWith("'''")) return s.slice(3, s.lastIndexOf("'''"));
    if (s.startsWith("'")) return s.slice(1, s.lastIndexOf("'"));
    if (s.startsWith('"')) {
      let end = 1;
      while (s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
      return JSON.parse(s.slice(0, end + 1));
    }
    return Number(s);
  };
  const parseList = (buf: string): string[] => {
    const out: string[] = [];
    let k = buf.indexOf("[") + 1;
    for (; k < buf.length; k++) {
      const c = buf[k];
      if (buf.startsWith("'''", k)) {
        const end = buf.indexOf("'''", k + 3);
        out.push(buf.slice(k + 3, end));
        k = end + 2;
      } else if (c === "'") {
        const end = buf.indexOf("'", k + 1);
        out.push(buf.slice(k + 1, end));
        k = end;
      } else if (c === '"') {
        let end = k + 1;
        while (buf[end] !== '"') end += buf[end] === "\\" ? 2 : 1;
        out.push(JSON.parse(buf.slice(k, end + 1)));
        k = end;
      } else if (c === "#") {
        while (k < buf.length && buf[k] !== "\n") k++;
      }
    }
    return out;
  };
  let current: { rule: RawRule; allows: RawAllow[] } | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (line.trim() === "[[rules]]") {
      current = { rule: {}, allows: [] };
      rules.push(current);
      target = current.rule;
      continue;
    }
    if (line.trim() === "[[rules.allowlists]]") {
      const a: RawAllow = {};
      current!.allows.push(a);
      target = a;
      continue;
    }
    if (line.trim() === "[allowlist]") {
      target = globalAllow;
      continue;
    }
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m === null) throw new Error(`gitleaks.toml line ${i + 1}: cannot parse ${JSON.stringify(line)}`);
    target[m[1]] = readValue(m[2]);
  }
  return { global, globalAllow, rules };
}

// ---- Go RE2 to JavaScript. Case folding and dot-all are expanded by hand (no `i`/`s` flag, no `(?i:` modifier group) so the module runs on any Node 22. ----

class Untranslatable extends Error {}

function swapRange(lo: string, hi: string): string {
  // the other-case image of an ASCII letter range, if any
  let out = "";
  const a = lo.charCodeAt(0);
  const b = hi.charCodeAt(0);
  const lowLo = Math.max(a, 97);
  const lowHi = Math.min(b, 122);
  if (lowLo <= lowHi) out += `${String.fromCharCode(lowLo - 32)}-${String.fromCharCode(lowHi - 32)}`;
  const upLo = Math.max(a, 65);
  const upHi = Math.min(b, 90);
  if (upLo <= upHi) out += `${String.fromCharCode(upLo + 32)}-${String.fromCharCode(upHi + 32)}`;
  return out;
}

const POSIX: Record<string, string> = { alnum: "a-zA-Z0-9", alpha: "a-zA-Z", digit: "0-9", lower: "a-z", upper: "A-Z", space: "\\s", word: "\\w", xdigit: "0-9A-Fa-f", punct: "!-\\/:-@\\[-`{-~" };

function translate(src: string): string {
  let out = "";
  const flagStack: Array<{ i: boolean; s: boolean }> = [];
  let ci = false;
  let dotAll = false;
  let k = 0;
  // class: returns the JS class text, k left after the closing bracket
  const readClass = (): string => {
    let body = "";
    let extra = "";
    k++; // [
    let neg = false;
    if (src[k] === "^") {
      neg = true;
      k++;
    }
    let first = true;
    while (k < src.length && (src[k] !== "]" || first)) {
      first = false;
      if (src.startsWith("[:", k)) {
        const end = src.indexOf(":]", k);
        const name = src.slice(k + 2, end);
        if (!(name in POSIX)) throw new Untranslatable(`POSIX class [:${name}:]`);
        body += POSIX[name];
        k = end + 2;
        continue;
      }
      let ch = src[k];
      let lit: string | undefined;
      if (ch === "\\") {
        const nx = src[k + 1];
        if (nx === "x") {
          if (src[k + 2] === "{") throw new Untranslatable("\\x{...} escape");
          body += src.slice(k, k + 4);
          k += 4;
          continue;
        }
        if ("dDsSwW".includes(nx)) {
          body += `\\${nx}`;
          k += 2;
          continue;
        }
        if ("pPQE".includes(nx)) throw new Untranslatable(`\\${nx} in class`);
        body += `\\${nx}`;
        lit = /[A-Za-z]/.test(nx) ? undefined : nx; // \t \n \r are not letters to fold
        k += 2;
      } else {
        if (ch === "]" || ch === "[") body += `\\${ch}`;
        else body += ch;
        lit = ch;
        k++;
      }
      if (ci && lit !== undefined && /[A-Za-z]/.test(lit)) {
        // range?
        if (src[k] === "-" && src[k + 1] !== "]" && src[k + 1] !== undefined && src[k + 1] !== "\\") {
          const hi = src[k + 1];
          body += `-${hi}`;
          k += 2;
          extra += swapRange(lit, hi);
        } else extra += lit === lit.toLowerCase() ? lit.toUpperCase() : lit.toLowerCase();
      } else if (ci && lit !== undefined && src[k] === "-" && src[k + 1] !== "]" && src[k + 1] !== undefined && src[k + 1] !== "\\" && /[A-Za-z]/.test(src[k + 1]) === true) {
        // a range from a non-letter into a letter (rare): keep as is, add image of the letter part
        const hi = src[k + 1];
        body += `-${hi}`;
        k += 2;
        extra += swapRange(lit, hi);
      } else if (src[k] === "-" && src[k + 1] !== "]" && src[k + 1] !== undefined) {
        body += "-";
        k++;
        if (src[k] === "\\") {
          body += src.slice(k, k + 2);
          k += 2;
        } else body += src[k++];
      }
    }
    if (src[k] !== "]") throw new Untranslatable("unterminated class");
    k++;
    return `[${neg ? "^" : ""}${extra}${body}]`; // folded images first, so a trailing literal `-` in body stays a literal
  };
  while (k < src.length) {
    const c = src[k];
    if (c === "\\") {
      const nx = src[k + 1];
      if (nx === "z") {
        out += "$";
        k += 2;
      } else if (nx === "x") {
        if (src[k + 2] === "{") throw new Untranslatable("\\x{...} escape");
        out += src.slice(k, k + 4);
        k += 4;
      } else if ("AQEpPhHRXGKCZ".includes(nx)) throw new Untranslatable(`\\${nx}`);
      else {
        out += `\\${nx}`;
        k += 2;
      }
    } else if (c === "[") out += readClass();
    else if (c === "(") {
      if (src.startsWith("(?P<", k)) {
        const end = src.indexOf(">", k);
        out += `(?<${src.slice(k + 4, end)}>`;
        flagStack.push({ i: ci, s: dotAll });
        k = end + 1;
      } else if (src[k + 1] === "?") {
        const m = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?([:)])/.exec(src.slice(k));
        if (m !== null && (m[1] !== "" || m[2] !== undefined)) {
          const on = m[1];
          const off = m[2] ?? "";
          for (const f of on + off) if (f !== "i" && f !== "s") throw new Untranslatable(`inline flag ${f}`);
          if (m[3] === ":") flagStack.push({ i: ci, s: dotAll });
          if (on.includes("i")) ci = true;
          if (off.includes("i")) ci = false;
          if (on.includes("s")) dotAll = true;
          if (off.includes("s")) dotAll = false;
          if (m[3] === ":") out += "(?:";
          k += m[0].length;
        } else {
          // (?: (?= (?! (?<= (?<! (?<name>
          const m2 = /^\(\?(?::|<[A-Za-z_][A-Za-z0-9_]*>)/.exec(src.slice(k));
          if (m2 === null) throw new Untranslatable(`group syntax ${src.slice(k, k + 4)}`);
          out += m2[0];
          flagStack.push({ i: ci, s: dotAll });
          k += m2[0].length;
        }
      } else {
        out += "(";
        flagStack.push({ i: ci, s: dotAll });
        k++;
      }
    } else if (c === ")") {
      const f = flagStack.pop();
      if (f !== undefined) {
        ci = f.i;
        dotAll = f.s;
      }
      out += ")";
      k++;
    } else if (c === ".") {
      out += dotAll ? "[\\s\\S]" : "[^\\n]";
      k++;
    } else if (ci && /[A-Za-z]/.test(c)) {
      out += `[${c.toLowerCase()}${c.toUpperCase()}]`;
      k++;
    } else {
      out += c;
      k++;
    }
  }
  return out;
}

// A leading (?i) with no group around it applies to the whole pattern: translate() already tracks it, since the flag is set at top level.
function compile(src: string): string {
  const js = translate(src);
  new RegExp(js, "g"); // throws on a bad translation
  return js;
}

// ---- build the data ----

const parsed = parseToml(toml);

interface OutAllow {
  target: "secret" | "match" | "line";
  regexes: string[];
  stopwords: string[];
}
const str = (v: Value | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const list = (v: Value | undefined): string[] => (Array.isArray(v) ? v : []);

function buildAllow(a: RawAllow): OutAllow | undefined {
  // An allowlist that needs a path to match too (condition AND with paths) can never be met by free text: skipped. With OR, the path half is moot and regexes/stopwords stay.
  if (a.condition === "AND" && list(a.paths).length > 0) return undefined;
  const target = (str(a.regexTarget) ?? "secret") as OutAllow["target"];
  return { target, regexes: list(a.regexes).map(compile), stopwords: list(a.stopwords).map((s) => s.toLowerCase()) };
}

interface OutRule {
  id: string;
  keywords: string[];
  regex: string;
  entropy?: number;
  secretGroup?: number;
  allow: OutAllow[];
}
const rules: OutRule[] = [];
const excluded: Array<{ id: string; reason: string }> = [];
for (const { rule, allows } of parsed.rules) {
  const id = String(rule.id);
  try {
    if (str(rule.regex) === undefined) throw new Untranslatable("no regex (path-only rule; free text has no path)");
    if (str(rule.path) !== undefined) throw new Untranslatable("rule is restricted to a file path; free text has none");
    const out: OutRule = {
      id,
      keywords: list(rule.keywords).map((s) => s.toLowerCase()),
      regex: compile(str(rule.regex)!),
      allow: allows.map(buildAllow).filter((x): x is OutAllow => x !== undefined),
    };
    if (typeof rule.entropy === "number") out.entropy = rule.entropy;
    if (typeof rule.secretGroup === "number") out.secretGroup = rule.secretGroup;
    rules.push(out);
  } catch (e) {
    if (!(e instanceof Untranslatable) && !(e instanceof SyntaxError)) throw e;
    excluded.push({ id, reason: e.message });
  }
}
const globalAllow = buildAllow(parsed.globalAllow) ?? { target: "secret" as const, regexes: [], stopwords: [] };

// A rule whose regex is a plain token (no metacharacters) matches its own line in the table, and so would flag the table as a leaked secret
// (the Bedrock short-lived key prefix is one). Such a literal is written as two joined strings: same value at load time, no contiguous token
// in the file for a scanner to find. Only whole-line plain values of 20 or more characters are split.
function selfSafe(json: string): string {
  return json.replace(/^(\s*"regex": )"([A-Za-z0-9_-]{20,})"/gm, (_m, lead: string, lit: string) => {
    const at = Math.floor(lit.length / 2);
    return `${lead}"${lit.slice(0, at)}" + "${lit.slice(at)}"`;
  });
}

const header = `// GENERATED by scripts/gen-secret-rules.ts from vendor/gitleaks/gitleaks.toml (gitleaks ${version}). Do not edit by hand; rerun \`node scripts/gen-secret-rules.ts\`.
// The secret detector is gitleaks' default ruleset and nothing else. gitleaks is MIT licensed; its notice ships below.
`;
const body = `
export const GITLEAKS_VERSION = ${JSON.stringify(version)};

/** The gitleaks license notice, shipped with the rules derived from it. */
export const GITLEAKS_LICENSE = ${JSON.stringify(license)};

export interface SecretAllow {
  /** What the allowlist regexes and stopwords are tested against. */
  target: "secret" | "match" | "line";
  regexes: string[];
  stopwords: string[];
}

export interface SecretRule {
  id: string;
  /** Lowercase; the rule runs only when the text, lowercased, holds one of them. */
  keywords: string[];
  /** JavaScript source, flags \`g\` only (case folding already expanded). */
  regex: string;
  entropy?: number;
  secretGroup?: number;
  allow: SecretAllow[];
}

export const GLOBAL_ALLOW: SecretAllow = ${JSON.stringify(globalAllow, null, 2)};

/** Rules that could not be translated, each with the reason. Never dropped silently. */
export const EXCLUDED_RULES: ReadonlyArray<{ id: string; reason: string }> = ${JSON.stringify(excluded, null, 2)};

export const SECRET_RULES: readonly SecretRule[] = ${selfSafe(JSON.stringify(rules, null, 2))};
`;
writeFileSync(join(root, "src/secret-rules.generated.ts"), header + body);
console.log(`gitleaks ${version}: ${rules.length} of ${parsed.rules.length} rules translated, ${excluded.length} excluded`);
for (const e of excluded) console.log(`  EXCLUDED ${e.id}: ${e.reason}`);
