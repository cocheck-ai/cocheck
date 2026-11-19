// The OS seam's architecture lint. No `process.platform`, OS path or OS call outside src/platform/. Today's sites are allowlisted in
// test/architecture-platform-allowlist.json as per-file counts per rule. The list may only shrink: a count above it fails (a new site), and a
// count below it fails too (lower the number, so the room cannot be used again). Comment-only lines are not counted.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const SRC = path.join(import.meta.dirname, "..", "src");
const ALLOWLIST = path.join(import.meta.dirname, "architecture-platform-allowlist.json");

export const RULES: Record<string, RegExp> = {
  "process.platform": /process\.platform/,
  "/bin/sh": /\/bin\/sh\b/,
  osascript: /osascript/,
  "os-path": /["'`]\/(?:Users|private|opt|usr|Applications|Library|tmp|var|etc|System)\//,
  "os-tool": /(?:execFile|execFileSync|spawn|spawnSync)\(\s*["'`](?:open|ps|lsof|pkill|kill|lockf|caffeinate|security|sips|qlmanage|soffice|osascript|sh|bash)["'`]/,
};

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "platform") sources(full, out);
    } else if (/\.(?:ts|cjs|mjs)$/.test(e.name) && !e.name.endsWith(".generated.ts")) out.push(full);
  }
  return out;
}

const isComment = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line);

export function count(): Record<string, Record<string, number>> {
  const found: Record<string, Record<string, number>> = {};
  for (const file of sources(SRC)) {
    const rel = path.relative(path.join(SRC, ".."), file).split(path.sep).join("/");
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (isComment(line)) continue;
      for (const [rule, re] of Object.entries(RULES)) if (re.test(line)) ((found[rel] ??= {})[rule] = (found[rel]?.[rule] ?? 0) + 1);
    }
  }
  return found;
}

describe("architecture lint: OS knowledge lives in src/platform/", () => {
  it("fails on a new OS site and on room left unused in the allowlist", () => {
    const allowed = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as Record<string, Record<string, number>>;
    const found = count();
    const problems: string[] = [];
    for (const file of new Set([...Object.keys(allowed), ...Object.keys(found)])) {
      for (const rule of new Set([...Object.keys(allowed[file] ?? {}), ...Object.keys(found[file] ?? {})])) {
        const have = found[file]?.[rule] ?? 0;
        const max = allowed[file]?.[rule] ?? 0;
        if (have > max) problems.push(`${file}: ${have} x ${rule}, allowed ${max}. Move the OS call behind platform() in src/platform/.`);
        if (have < max) problems.push(`${file}: ${have} x ${rule}, allowlist says ${max}. Lower the allowlist number.`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it("the rules see a planted site (the lint is not blind)", () => {
    const planted = ['const p = process.platform;', 'spawnSync("/bin/sh", [])', 'const x = "/Applications/Foo.app";', 'execFileSync("ps", ["-p", "1"])', "osascript -e"];
    for (const line of planted) assert.ok(Object.values(RULES).some((re) => re.test(line)), line);
  });

  it("src/platform is the only place the rules are not applied", () => {
    assert.ok(!sources(SRC).some((f) => f.includes(`${path.sep}platform${path.sep}`)));
  });
});
