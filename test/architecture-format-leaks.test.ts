// The format-leak guard. Core code must not special-case office formats outside the two registries
// (src/connector/registry.ts, src/timeline/render/registry.ts). Driving today's leaks to zero is later work; this test freezes them.
// test/architecture-format-leaks-allowlist.json lists today's hits as {pattern, file, line}. A hit not on the list fails (route it through the
// registry), and a list entry that no longer matches fails too (delete it, so the list only shrinks). Hits match by trimmed line text, never
// by line number, so unrelated edits do not churn the list. Comment-only lines are skipped. Only src/ is scanned.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
const ALLOWLIST = path.join(import.meta.dirname, "architecture-format-leaks-allowlist.json");

export type Hit = { pattern: string; file: string; line: string };

const REGISTRIES = new Set(["src/connector/registry.ts", "src/timeline/render/registry.ts"]);
const RENDERERS = ["xlsx", "office", "pdf", "text", "fallback"];
const FORMATS = "xlsx|xlsm|xls|ods|docx|doc|pptx|ppsx|pptm|ppt|pdf|csv|word|powerpoint|excel|office|files|text";
const EXT = "xlsx|xlsm|xls|ods|docx|doc|pptx|ppsx|pptm|ppt|pdf|csv";

// (a) An import of a concrete format layer (src/formats/<fmt>/layer.ts) or renderer (src/timeline/render/{xlsx,office,pdf,text,fallback}.ts).
// Matched on the resolved specifier, so any relative spelling is caught. Exempt: the two registry files and anything under src/formats/.
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`](\.{1,2}\/[^"'`]+)["'`]/;
function isConcreteImport(file: string, line: string): boolean {
  const m = IMPORT_SPEC.exec(line);
  if (m === null || REGISTRIES.has(file) || file.startsWith("src/formats/")) return false;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]!)).replace(/\.(?:ts|js)$/, "");
  return /^src\/formats\/[^/]+\/layer$/.test(target) || RENDERERS.some((r) => target === `src/timeline/render/${r}`);
}

const PATTERNS: { name: string; says: string; test: (file: string, line: string) => boolean }[] = [
  { name: "a-concrete-import", says: "imports a concrete format layer or renderer", test: isConcreteImport },
  // (b) The per-format "open in app" identifiers on the rail model: one registry-driven open action should replace both.
  { name: "b-open-identifier", says: "uses openExcel or openOffice", test: (_f, l) => /\b(?:openExcel|openOffice)\b/.test(l) },
  // (c) Spreadsheet-only kinds as string literals in the shared view types file; a format-specific kind belongs to its renderer.
  { name: "c-spreadsheet-kind", says: "names a spreadsheet-only view kind in the shared view types", test: (f, l) => f === "src/timeline/render/types.ts" && /["'`](?:grid|cell|table-cell|table-row)["'`]/.test(l) },
  // (d) A layer or renderer name compared to a format string: `x.name === "xlsx"`, `"pdf" !== layer.name`, and the same with a layer-name variable.
  { name: "d-name-compare", says: "compares a layer name to a format string", test: (_f, l) => new RegExp(`\\bname\\s*[!=]==?\\s*["'\`](?:${FORMATS})["'\`]|["'\`](?:${FORMATS})["'\`]\\s*[!=]==?\\s*[\\w.]*\\bname\\b`).test(l) },
  // (e) Regexes or string tests on file extensions (`/\.(xlsx|docx)$/`, `endsWith(".pdf")`, `ext === ".pptx"`), only in the three files that route by extension.
  {
    name: "e-extension-test",
    says: "tests a file extension",
    test: (f, l) =>
      ["src/timeline/load.ts", "src/timeline/rail/model.ts", "src/fingerprint.ts"].includes(f) &&
      new RegExp(`\\\\\\.\\(?(?:(?:${EXT})\\b|(?:[a-z?\\[\\]]+\\|)+(?:${EXT})\\b)|\\.(?:endsWith|startsWith)\\(\\s*["'\`]\\.(?:${EXT})\\b|\\bext\\w*\\s*[!=]==?\\s*["'\`]\\.(?:${EXT})["'\`]`).test(l),
  },
];

const isComment = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line);

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sources(full, out);
    else if (/\.(?:ts|js|cjs|mjs)$/.test(e.name) && !e.name.endsWith(".generated.ts")) out.push(full);
  }
  return out;
}

/** Every leak under `<root>/src`, as {pattern, file, line}. Line text is trimmed; one entry per matching line. */
export function scan(root: string = ROOT): Hit[] {
  const hits: Hit[] = [];
  for (const full of sources(path.join(root, "src"))) {
    const file = path.relative(root, full).split(path.sep).join("/");
    for (const raw of readFileSync(full, "utf8").split("\n")) {
      if (isComment(raw)) continue;
      for (const p of PATTERNS) if (p.test(file, raw)) hits.push({ pattern: p.name, file, line: raw.trim() });
    }
  }
  return hits;
}

const keyOf = (h: Hit): string => JSON.stringify([h.pattern, h.file, h.line]);
const says = (name: string): string => PATTERNS.find((p) => p.name === name)?.says ?? name;

/** Compare hits to an allowlist as multisets; return one message per unlisted hit and per stale entry. */
export function problems(hits: Hit[], allowed: Hit[]): string[] {
  const room = new Map<string, number>();
  for (const a of allowed) room.set(keyOf(a), (room.get(keyOf(a)) ?? 0) + 1);
  const out: string[] = [];
  for (const h of hits) {
    const left = room.get(keyOf(h)) ?? 0;
    if (left > 0) room.set(keyOf(h), left - 1);
    else out.push(`${h.file}: ${says(h.pattern)} [${h.pattern}]: ${h.line.slice(0, 160)}\n  New format leak. Route it through the registry (src/connector/registry.ts or src/timeline/render/registry.ts), not a new special case.`);
  }
  for (const [k, n] of room) {
    if (n <= 0) continue;
    const [pattern, file, line] = JSON.parse(k) as string[];
    out.push(`${file}: allowlist entry [${pattern}] no longer matches (x${n}): ${String(line).slice(0, 160)}\n  Delete it from test/architecture-format-leaks-allowlist.json so the list only shrinks.`);
  }
  return out;
}

describe("architecture lint: format knowledge lives in the registries", () => {
  it("fails on a new leak and on an allowlist entry that no longer matches", () => {
    const allowed = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as Hit[];
    assert.deepEqual(problems(scan(), allowed), []);
  });

  it("the patterns see planted leaks and skip comments (the guard is not blind or noisy)", () => {
    const planted: Hit[] = [
      ["src/hook-cli.ts", `import { x } from "./formats/pptx/layer.ts";`],
      ["src/timeline/load.ts", `import { y } from "./render/pdf.ts";`],
      ["src/timeline/rail/model.ts", `const a = rc.openExcel;`],
      ["src/timeline/render/types.ts", `  kind: "grid" | "pages";`],
      ["src/anything.ts", `if (layer.name === "pdf") run();`],
      ["src/anything.ts", `if ("docx" !== l.name) run();`],
      ["src/fingerprint.ts", `const R = /\\.(csv|pdf)$/i;`],
      ["src/fingerprint.ts", `if (f.endsWith(".xlsx")) run();`],
    ].map(([file, line]) => ({ file: file!, line: line!, pattern: "" }));
    for (const h of planted) assert.ok(PATTERNS.some((p) => p.test(h.file, h.line)), `not caught: ${h.line}`);
    const quiet: [string, string][] = [
      ["src/connector/registry.ts", `import { x } from "../formats/xlsx/layer.ts";`],
      ["src/formats/pptx/layer.ts", `import { x } from "./layer.ts";`],
      ["src/timeline/load.ts", `import { x } from "./render/registry.ts";`],
      ["src/timeline/render/types.ts", `  kind: "pages" | "card";`],
      ["src/other.ts", `if (host.name === "claude") run();`],
      ["src/other.ts", `const a = rc.openExcel;`.replace("openExcel", "openDoc")],
      ["src/home.ts", `if (f.endsWith(".pdf")) run();`],
    ];
    for (const [file, line] of quiet) assert.ok(!PATTERNS.some((p) => p.test(file, line)), `noisy: ${line}`);
    assert.ok(isComment(" * uses openExcel"));
  });

  it("an unlisted hit and a stale entry each fail with a message that names file and pattern", () => {
    const hit: Hit = { pattern: "d-name-compare", file: "src/x.ts", line: `if (l.name === "xlsx") {}` };
    assert.match(problems([hit], [])[0] ?? "", /src\/x\.ts.*d-name-compare[\s\S]*Route it through the registry/);
    assert.match(problems([], [hit])[0] ?? "", /no longer matches/);
    assert.deepEqual(problems([hit], [hit]), []);
  });
});
