// The secret detector. Its rules are gitleaks' default ruleset (src/secret-rules.generated.ts, generated from the pinned upstream
// config by scripts/gen-secret-rules.ts) and nothing else; no rule is written or edited by hand.
import { GLOBAL_ALLOW, SECRET_RULES, type SecretAllow, type SecretRule } from "./secret-rules.generated.ts";

const compiled = new Map<string, RegExp>();
function regexFor(src: string): RegExp {
  let re = compiled.get(src);
  if (re === undefined) {
    re = new RegExp(src, "g");
    compiled.set(src, re);
  }
  return re;
}

/** Shannon entropy in bits per character, as gitleaks computes it. */
function entropyOf(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = [...s].length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

function allowed(a: SecretAllow, secret: string, match: string, text: string, index: number): boolean {
  const subject = a.target === "match" ? match : a.target === "line" ? lineAround(text, index) : secret;
  for (const src of a.regexes) {
    const re = regexFor(src);
    re.lastIndex = 0;
    if (re.test(subject)) return true;
  }
  const low = secret.toLowerCase();
  return a.stopwords.some((w) => low.includes(w));
}

/** The spans (start, end) of every secret this rule finds in the text that its entropy floor and allowlists do not clear. `first` stops at one. */
function ruleSpans(rule: SecretRule, text: string, first = false): Array<[number, number]> {
  const re = regexFor(rule.regex);
  re.lastIndex = 0;
  const spans: Array<[number, number]> = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0] === "") re.lastIndex++;
    // gitleaks: the secret is the rule's secretGroup, else the first non-empty capture group, else the whole match.
    let secret = m[0];
    if (rule.secretGroup !== undefined) secret = m[rule.secretGroup] ?? m[0];
    else if (m.length > 1) secret = m.slice(1).find((g) => g !== undefined && g !== "") ?? m[0];
    if (rule.entropy !== undefined && entropyOf(secret) <= rule.entropy) continue;
    if (allowed(GLOBAL_ALLOW, secret, m[0], text, m.index)) continue;
    if (rule.allow.some((a) => allowed(a, secret, m[0], text, m.index))) continue;
    const at = secret === "" ? -1 : m[0].indexOf(secret);
    spans.push(at < 0 ? [m.index, m.index + m[0].length] : [m.index + at, m.index + at + secret.length]);
    if (first) return spans;
  }
  return spans;
}

/** True when this rule, on this text, finds a secret that its entropy floor and allowlists do not clear. */
const ruleHits = (rule: SecretRule, text: string): boolean => ruleSpans(rule, text, true).length > 0;

/** What replaces a secret value in text that is stored. */
const SECRET_MASK = "[secret withheld]";

/**
 * The text with every value the detector finds replaced by SECRET_MASK; the same string when it finds none (nothing else is touched, so a
 * path, a hash or a long hex string the rules clear stays as written). Same rules, entropy floors and allowlists as `firstSecretRule`.
 */
export function redactSecrets(text: string): string {
  if (text === "") return text;
  const low = text.toLowerCase();
  const spans: Array<[number, number]> = [];
  for (const rule of SECRET_RULES) {
    if (rule.keywords.length > 0 && !rule.keywords.some((k) => low.includes(k))) continue;
    spans.push(...ruleSpans(rule, text));
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let at = 0;
  for (const [a, b] of spans) {
    if (b <= at) continue;
    out += text.slice(at, Math.max(a, at)) + SECRET_MASK;
    at = b;
  }
  return out + text.slice(at);
}

/** The id of the first gitleaks rule that finds a secret in the text, or undefined. */
export function firstSecretRule(text: string): string | undefined {
  const low = text.toLowerCase();
  for (const rule of SECRET_RULES) {
    if (rule.keywords.length > 0 && !rule.keywords.some((k) => low.includes(k))) continue;
    if (ruleHits(rule, text)) return rule.id;
  }
  return undefined;
}

/** How much of a file's text is scanned from each end; see `secretRuleInBytes`. */
const CONTENT_SCAN_CAP_BYTES = 2 * 1024 * 1024;

/**
 * The id of the first gitleaks rule that finds a secret in a file's bytes, or undefined. Only text is scanned: bytes holding a NUL
 * (a binary file, a zipped office file, or UTF-16 text) are not. Text up to twice `CONTENT_SCAN_CAP_BYTES` is scanned whole; longer
 * text is scanned in its first and last `CONTENT_SCAN_CAP_BYTES`, so the cost stays bounded and the region between is not scanned.
 */
export function secretRuleInBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0 || bytes.includes(0)) return undefined;
  const text = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.length).toString("utf8");
  if (bytes.length <= 2 * CONTENT_SCAN_CAP_BYTES) return firstSecretRule(text(bytes));
  return firstSecretRule(text(bytes.subarray(0, CONTENT_SCAN_CAP_BYTES))) ?? firstSecretRule(text(bytes.subarray(bytes.length - CONTENT_SCAN_CAP_BYTES)));
}
