import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// A Chrome launched by a test or probe with HOME on a temp folder made macOS show "Keychain Not Found". Every launch in
// test/ and scripts/ must carry --use-mock-keychain and --password-store=basic (via test/helpers/chrome.ts or literally), and
// product code under src/ must never launch Chrome or carry these flags (they would cut the user's real browser off its keychain).

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SELF = "test/chrome-launch-flags.test.ts";
const HELPER = "test/helpers/chrome.ts";
const LAUNCH = /Google Chrome|google-chrome|chromium|--remote-debugging-port|chrome\.exe/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "fixtures" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|js|mjs|cjs|sh)$/.test(n)) out.push(p);
  }
  return out;
}

/** Why a file's Chrome launch is unsafe, or undefined when it has none or is safe. */
export function unsafeChromeLaunch(text: string): string | undefined {
  if (!LAUNCH.test(text)) return undefined;
  if (/chromeHeadlessArgs\(|CHROME_KEYCHAIN_FLAGS/.test(text)) return undefined;
  const missing = ["--use-mock-keychain", "--password-store=basic"].filter((f) => !text.includes(f));
  return missing.length ? `launches Chrome without ${missing.join(" and ")}` : undefined;
}

describe("Chrome launches keep off the real keychain", () => {
  it("detector flags a launch without the flags (must not: a bare launch)", () => {
    assert.match(unsafeChromeLaunch(`spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=0"])`) ?? "", /--use-mock-keychain and --password-store=basic/);
    assert.match(unsafeChromeLaunch(`spawn(chromium, ["--use-mock-keychain"])`) ?? "", /--password-store=basic/);
    assert.equal(unsafeChromeLaunch(`spawn(chromium, ["--use-mock-keychain", "--password-store=basic"])`), undefined);
    assert.equal(unsafeChromeLaunch(`spawn(CHROME, chromeHeadlessArgs(dir))`) , undefined);
    assert.equal(unsafeChromeLaunch(`no browser here`), undefined);
  });

  it("every Chrome launch in test/ and scripts/ passes both flags", () => {
    const bad: string[] = [];
    for (const dir of ["test", "scripts"]) for (const f of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, f);
      if (rel === SELF || rel === HELPER) continue;
      const why = unsafeChromeLaunch(readFileSync(f, "utf8"));
      if (why) bad.push(`${rel}: ${why}`);
    }
    assert.deepEqual(bad, []);
  });

  it("the shared helper carries both flags", () => {
    const h = readFileSync(join(ROOT, HELPER), "utf8");
    assert.ok(h.includes("--use-mock-keychain") && h.includes("--password-store=basic"));
  });

  it("product code under src/ never launches Chrome and never carries the mock-keychain flags", () => {
    const bad: string[] = [];
    for (const f of walk(join(ROOT, "src"))) {
      const t = readFileSync(f, "utf8");
      if (/--use-mock-keychain|--password-store=basic|--remote-debugging-port|Google Chrome\.app|google-chrome/.test(t)) bad.push(relative(ROOT, f));
    }
    assert.deepEqual(bad, []);
  });
});
