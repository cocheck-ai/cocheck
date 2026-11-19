// The import collector the architecture tests share (shared with test/architecture-office-ratchet.test.ts, so the end-state
// import test reads imports exactly as the ratchet does). Collected forms: see the ratchet's header.
import path from "node:path";

export const SOURCE_EXT = /\.(?:ts|mts|cts|mjs|cjs)$/;

/** Blank out comments, keeping strings, template literals and regex literals intact, so a commented-out import is not an edge
 *  and a `//` or quote inside a string or regex does not hide a real one. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let last = ""; // last significant non-space char of code, to tell a regex from a division
  const n = src.length;
  const regexAllowed = (): boolean => last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(out.trimEnd());
  const readString = (q: string): void => {
    out += src[i++];
    while (i < n && src[i] !== q) {
      if (src[i] === "\\") out += src[i++];
      if (q === "`" && src[i] === "$" && src[i + 1] === "{") {
        out += "${";
        i += 2;
        let depth = 1;
        const start = i;
        while (i < n && depth > 0) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          if (depth > 0) i++;
        }
        out += stripComments(src.slice(start, i));
        continue;
      }
      if (i < n) out += src[i++];
    }
    if (i < n) out += src[i++];
  };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      readString(c);
      last = c;
    } else if (c === "/" && regexAllowed()) {
      out += src[i++];
      let inClass = false;
      while (i < n && src[i] !== "\n" && (inClass || src[i] !== "/")) {
        if (src[i] === "\\") out += src[i++];
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        if (i < n) out += src[i++];
      }
      if (i < n && src[i] === "/") out += src[i++];
      last = "/";
    } else {
      out += src[i++];
      if (!/\s/.test(c)) last = c;
    }
  }
  return out;
}

export const LIT = String.raw`(?:"([^"\n]*)"|'([^'\n]*)'|\x60([^\x60$\n]*)\x60)`;
export const SPEC_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b(?:import|export)\s+(?:type\s+)?[\w*{}\s,$]*?\bfrom\s*${LIT}`, "g"), // import/export ... from, type-only included
  new RegExp(String.raw`\bimport\s*${LIT}`, "g"), // side-effect import
  new RegExp(String.raw`\bimport\s*\(\s*${LIT}`, "g"), // dynamic import() and type-position import("x").T
  new RegExp(String.raw`\brequire\s*\(\s*${LIT}`, "g"),
  new RegExp(String.raw`\bnew\s+URL\s*\(\s*${LIT}\s*,\s*import\.meta\.url`, "g"),
];
export const COMPUTED = /\b(import|require)\s*\(\s*(?!["'\x60]|new\s+URL\s*\(\s*["'\x60][^"'\x60]*["'\x60]\s*,\s*import\.meta\.url)/g;

/** Resolve a specifier written in `importerRel` to a src-relative module path, or undefined when it is a package or not under src/. */
export function resolveSpec(importerRel: string, spec: string, exists: (rel: string) => boolean): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importerRel), spec));
  if (!base.startsWith("src/")) return undefined;
  const tries: string[] = [];
  const m = /\.(js|mjs|cjs|jsx)$/.exec(base);
  if (m) tries.push(base.slice(0, -m[0].length) + ({ js: ".ts", mjs: ".mts", cjs: ".cts", jsx: ".tsx" } as Record<string, string>)[m[1]], base);
  else if (SOURCE_EXT.test(base)) tries.push(base);
  else tries.push(`${base}.ts`, `${base}.mts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`);
  return tries.find(exists) ?? tries[0]; // an unresolvable path still names its target, so an Office-dir spec is never lost
}


/** Every relative specifier `text` (a module at `importerRel`) imports, resolved to a repo-relative path (packages and non-relative specifiers left out). */
export function importsOf(importerRel: string, text: string, exists: (rel: string) => boolean): string[] {
  const code = stripComments(text);
  const out = new Set<string>();
  for (const re of SPEC_PATTERNS) {
    for (const m of code.matchAll(re)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec === undefined || !spec.startsWith(".")) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(importerRel), spec));
      out.add(base.startsWith("src/") ? (resolveSpec(importerRel, spec, exists) ?? base) : base);
    }
  }
  return [...out].sort();
}
