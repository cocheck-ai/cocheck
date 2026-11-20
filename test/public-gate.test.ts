// The public export gate (scripts/public-gate.ts) and the export script (scripts/export-public.sh). Words the gate must catch are
// assembled at run time inside temp folders this test makes, so no committed file here holds one. Every repo below is a temp
// `git init`; nothing points at a real remote.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";

const ROOT = path.resolve(import.meta.dirname, "..");
const GATE = process.env.GATE_UNDER_TEST ?? path.join(ROOT, "scripts", "public-gate.ts");
const EXPORT = path.join(ROOT, "scripts", "export-public.sh");
const join = (...p: string[]): string => p.join("");
const OWNER = join("To", "mas");
const TICKET = join("T", "-123");
const BOT = { COCHECK_BOT_NAME: "Public Bot", COCHECK_BOT_EMAIL: "bot@example.com" };

const tmp = (): string => mkdtempSync(path.join(tmpdir(), "public-gate-test-"));
function put(dir: string, rel: string, data: string | Uint8Array): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), data);
}
function gate(dir: string, allowFile?: string): { code: number | null; out: string } {
  // No allow file means "none": point the gate at a path that does not exist so the repo's real allow file is never read here.
  const env = { ...process.env, COCHECK_GATE_ALLOW: allowFile ?? path.join(dir, "..", "no-such-allow-file.txt") };
  const r = spawnSync("node", [GATE, dir], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout + r.stderr };
}
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function docx(creator: string, extra: Record<string, string> = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(`<w:document><w:t>hello</w:t></w:document>`),
    "docProps/core.xml": strToU8(`<cp:coreProperties><dc:creator>${creator}</dc:creator><cp:lastModifiedBy></cp:lastModifiedBy></cp:coreProperties>`),
    "docProps/app.xml": strToU8(`<Properties><Company></Company><Manager/></Properties>`),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])),
  });
}
const pdf = (author: string): string => `%PDF-1.4\n1 0 obj\n<< /Title (Report) /Author (${author}) >>\nendobj\ntrailer\n<< /Info 1 0 R >>\n%%EOF\n`;

// The deny list and the allow file are export-ignored (the deny list names the owner), so a public copy has neither and the gate cannot run.
const NO_LISTS = existsSync(path.join(ROOT, "scripts", "public-denylist.txt")) && existsSync(path.join(ROOT, "scripts", "public-gate-allow.txt")) ? false : "the deny list and allow file are not in a public copy";

// The public copy is itself an export: the export-ignored files are not in it, so there is nothing to check there.
const isExportSource = !NO_LISTS && git(ROOT, "ls-files", "scripts/baseline-capture.ts").trim() !== "";

describe("public export: git archive leaves private files out", () => {
  it("lists none of the export-ignored files", { skip: isExportSource ? false : "not the export source (a public copy)" }, () => {
    const tracked = git(ROOT, "ls-files").split("\n").filter(Boolean);
    const bases = ["baseline-capture", "baseline-compare", "live-office-check", "rediff-step"];
    const mustLeave = new Set(tracked.filter((f) => bases.some((b) => path.basename(f).startsWith(b))));
    for (const f of ["docs/readme-pitch-draft.md", "scripts/public-denylist.txt"]) if (tracked.includes(f)) mustLeave.add(f);
    assert.ok(mustLeave.has("scripts/baseline-capture.ts") && mustLeave.has("scripts/public-denylist.txt"), "the check is not vacuous");
    const listed = new Set(spawnSync("sh", ["-c", `git -C '${ROOT}' archive HEAD | tar -t`], { encoding: "utf8" }).stdout.split("\n"));
    for (const f of mustLeave) assert.ok(!listed.has(f), `${f} is in git archive HEAD`);
  });
});

const sha = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hexUtf16 = (text: string): string => "FEFF" + [...text].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("").toUpperCase();
const octalUtf16 = (text: string): string => "\\376\\377" + [...text].map((c) => `\\000\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`).join("");
const pdfWith = (info: string): string => `%PDF-1.4\n1 0 obj\n<< ${info} >>\nendobj\ntrailer\n<< /Info 1 0 R >>\n%%EOF\n`;

describe("public-gate metadata allow-list (exact values)", { skip: NO_LISTS }, () => {
  it("passes each allowed creator and lastModifiedBy, fails any other value, including a near match", () => {
    for (const ok of ["CoCheck", "CoCheck test fixture", "python-docx", "openpyxl", "Steve Canny", "PptxGenJS"]) {
      const d = tmp();
      put(d, "a.docx", docx(ok));
      assert.equal(gate(d).code, 0, ok);
    }
    for (const bad of ["CoCheck2", "cocheck", "CoCheck, Jane Doe", "Jane Doe"]) {
      const d = tmp();
      put(d, "a.docx", docx(bad));
      assert.match(gate(d).out, /^a\.docx!docProps\/core\.xml:1: META-CREATOR$/m, bad);
    }
  });
  it("the owner's name in dc:creator fails even next to an allowed value", () => {
    const d = tmp();
    put(d, "a.docx", docx(`CoCheck ${OWNER}`));
    assert.match(gate(d).out, /META-CREATOR$/m);
  });
  it("a PDF /Author in the allow-list passes; any other fails", () => {
    const d = tmp();
    put(d, "a.pdf", pdf("CoCheck"));
    put(d, "b.pdf", pdfWith(`/Author <${hexUtf16("Sample Author A")}>`));
    assert.equal(gate(d).code, 0);
    put(d, "c.pdf", pdf("Jane Doe"));
    put(d, "d.pdf", pdfWith(`/Author <${hexUtf16("Jane Doe")}>`));
    const r = gate(d).out;
    assert.match(r, /^c\.pdf:3: PDF-AUTHOR$/m);
    assert.match(r, /^d\.pdf:3: PDF-AUTHOR$/m);
    assert.ok(!/^[ab]\.pdf/m.test(r));
  });
});

describe("public-gate PDF Info strings are decoded", { skip: NO_LISTS }, () => {
  it("fails a /Title whose hex UTF-16 text is a denylisted word", () => {
    const d = tmp();
    put(d, "t.pdf", pdfWith(`/Title <${hexUtf16(OWNER)}>`));
    const r = gate(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /^t\.pdf:3: DENY-\d+$/m);
  });
  it("fails a /Title in (\\376\\377...) octal form, and an /Author that decodes to a name", () => {
    const d = tmp();
    put(d, "o.pdf", pdfWith(`/Title (${octalUtf16(OWNER)})`));
    put(d, "a.pdf", pdfWith(`/Author (${octalUtf16("Jane Doe")})`));
    const r = gate(d).out;
    assert.match(r, /^o\.pdf:3: DENY-\d+$/m);
    assert.match(r, /^a\.pdf:3: PDF-AUTHOR$/m);
  });
  it("passes a decoded benign title", () => {
    const d = tmp();
    put(d, "ok.pdf", pdfWith(`/Title <${hexUtf16("Quarterly report")}>`));
    assert.equal(gate(d).code, 0);
  });
});

describe("public-gate allow file (exact file, exact rule, pinned hash)", { skip: NO_LISTS }, () => {
  const body = `// ${OWNER} planted by design\n`;
  const entry = (rel: string, rule: string, hash: string): string => `${rel} ${rule} ${hash} # plants a name by design\n`;
  function setup(): { d: string; allow: string; rule: string } {
    const d = tmp();
    put(d, "src/x.ts", body);
    const first = gate(d).out.match(/^src\/x\.ts:1: (DENY-\d+)$/m);
    assert.ok(first, "the planted word hits without an allow file");
    const allow = path.join(d, "..", `allow-${path.basename(d)}.txt`);
    return { d, allow, rule: first[1]! };
  }
  it("suppresses that rule in that file only", () => {
    const { d, allow, rule } = setup();
    put(d, "src/y.ts", body);
    writeFileSync(allow, entry("src/x.ts", rule, sha(body)));
    const r = gate(d, allow);
    assert.ok(!/^src\/x\.ts/m.test(r.out), r.out);
    assert.match(r.out, /^src\/y\.ts:1: DENY-\d+$/m);
  });
  it("an allowed file that gains one byte hits again", () => {
    const { d, allow, rule } = setup();
    writeFileSync(allow, entry("src/x.ts", rule, sha(body)));
    assert.equal(gate(d, allow).code, 0);
    put(d, "src/x.ts", body + " ");
    assert.match(gate(d, allow).out, /^src\/x\.ts:1: DENY-\d+$/m);
  });
  it("an entry with a wrong sha is ignored", () => {
    const { d, allow, rule } = setup();
    writeFileSync(allow, entry("src/x.ts", rule, "0".repeat(64)));
    assert.match(gate(d, allow).out, /^src\/x\.ts:1: DENY-\d+$/m);
  });
  it("an entry covers only its own rule, not another rule in the same file", () => {
    const { d, allow, rule } = setup();
    const both = body + `see ${TICKET}\n`;
    put(d, "src/x.ts", both);
    writeFileSync(allow, entry("src/x.ts", rule, sha(both)));
    const r = gate(d, allow).out;
    assert.ok(!r.includes(`src/x.ts:1: ${rule}`));
    assert.match(r, /^src\/x\.ts:2: DENY-\d+$/m);
  });
  it("a directory or pattern entry suppresses nothing, and a malformed line stops the gate", () => {
    const { d, allow, rule } = setup();
    writeFileSync(allow, entry("src/", rule, sha(body)) + entry("src/*.ts", rule, sha(body)));
    assert.match(gate(d, allow).out, /^src\/x\.ts:1: DENY-\d+$/m);
    writeFileSync(allow, "src/x.ts nonsense\n");
    assert.equal(gate(d, allow).code, 2);
  });
});

describe("public-gate", { skip: NO_LISTS }, () => {
  it("passes a clean tree and counts files", () => {
    const d = tmp();
    put(d, "a.ts", "export const x = 1;\n");
    put(d, "b/c.md", "# hi\n");
    assert.deepEqual(gate(d), { code: 0, out: "public-gate: clean (2 files)\n" });
  });
  it("fails a planted owner-name comment, by line and rule id, without printing the text", () => {
    const d = tmp();
    put(d, "src/a.ts", `const a = 1;\n// ${OWNER} said so\n`);
    const r = gate(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /^src\/a\.ts:2: DENY-\d+$/m);
    assert.ok(!r.out.toLowerCase().includes(OWNER.toLowerCase()));
  });
  it("fails a planted ticket id", () => {
    const d = tmp();
    put(d, "a.md", `see ${TICKET}\n`);
    const r = gate(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /^a\.md:1: DENY-\d+$/m);
  });
  it("fails a planted private path and a hit in a file name", () => {
    const d = tmp();
    put(d, "a.md", join("/Us", "ers/", OWNER.toLowerCase(), "/x"));
    put(d, `${OWNER.toLowerCase()}-notes.txt`, "fine");
    const r = gate(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /^a\.md:1: DENY-\d+$/m);
    assert.match(r.out, /-notes\.txt:0: DENY-\d+$/m);
  });
  it("fails a planted secret", () => {
    const d = tmp();
    put(d, "k.env", `KEY=${join("AKIA", "Q3Z7XK2MWPN5RTVB")}\n`);
    const r = gate(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /^k\.env:1: SECRET$/m);
  });
  it("fails a docx whose dc:creator is Jane Doe, passes one with empty metadata", () => {
    const d = tmp();
    put(d, "ok.docx", docx(""));
    assert.equal(gate(d).code, 0);
    put(d, "bad.docx", docx("Jane Doe"));
    const r = gate(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /^bad\.docx!docProps\/core\.xml:1: META-CREATOR$/m);
    assert.ok(!r.out.includes("ok.docx"));
  });
  it("fails a docx with a denylisted word in a part, or a Company field", () => {
    const d = tmp();
    put(d, "w.docx", docx("", { "word/comments.xml": `<w:comment>${OWNER}</w:comment>` }));
    put(d, "c.xlsx", docx("", { "docProps/app.xml": "<Properties><Company>Acme</Company></Properties>" }));
    const r = gate(d);
    assert.match(r.out, /^w\.docx!word\/comments\.xml:1: DENY-\d+$/m);
    assert.match(r.out, /^c\.xlsx!docProps\/app\.xml:1: META-COMPANY$/m);
  });
  it("fails an unreadable office file (fail closed)", () => {
    const d = tmp();
    put(d, "broken.docx", "not a zip at all");
    const r = gate(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /^broken\.docx:0: UNREADABLE$/m);
  });
  it("fails a PDF with /Author Jane Doe, passes empty /Author, fails a denylisted word in the bytes", () => {
    const d = tmp();
    put(d, "ok.pdf", pdf(""));
    assert.equal(gate(d).code, 0);
    put(d, "bad.pdf", pdf("Jane Doe"));
    put(d, "word.pdf", pdf("") + `% ${OWNER}\n`);
    const r = gate(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /^bad\.pdf:3: PDF-AUTHOR$/m);
    assert.match(r.out, /^word\.pdf:\d+: DENY-\d+$/m);
    assert.ok(!r.out.includes("ok.pdf"));
  });
  it("refuses a directory it cannot read", () => {
    assert.equal(gate(path.join(tmp(), "missing")).code, 2);
  });
});

/** A private repo with one commit and a public repo with one commit; returns both paths. */
function repos(privateFiles: Record<string, string>, publicHasCommit = true): { priv: string; pub: string } {
  const priv = tmp();
  git(priv, "init", "-q", "-b", "main");
  for (const [k, v] of Object.entries(privateFiles)) put(priv, k, v);
  git(priv, "add", "-A");
  git(priv, "commit", "-q", "-m", "private history");
  const pub = tmp();
  git(pub, "init", "-q", "-b", "main");
  if (publicHasCommit) {
    put(pub, "old.txt", "deleted in private\n");
    git(pub, "add", "-A");
    git(pub, "commit", "-q", "-m", "public base");
  }
  return { priv, pub };
}
function runExport(priv: string, pub: string, env: Record<string, string | undefined> = BOT): { code: number | null; out: string } {
  const e: Record<string, string | undefined> = { ...process.env, COCHECK_BOT_NAME: undefined, COCHECK_BOT_EMAIL: undefined, COCHECK_EXPORT_SOURCE: priv, ...env };
  const r = spawnSync("bash", [EXPORT, pub], { encoding: "utf8", env: e as NodeJS.ProcessEnv });
  return { code: r.status, out: r.stdout + r.stderr };
}
const snapshot = (pub: string): string =>
  [git(pub, "rev-parse", "--abbrev-ref", "HEAD"), git(pub, "for-each-ref"), git(pub, "status", "--porcelain=v2", "--branch"), readdirSync(pub).sort().join(",")].join("\n--\n");

describe("export-public.sh", { skip: NO_LISTS }, () => {
  it("refuses when a bot variable is unset, and leaves the public checkout unchanged", () => {
    const { priv, pub } = repos({ "a.ts": "export {};\n" });
    const before = snapshot(pub);
    for (const env of [{ COCHECK_BOT_EMAIL: "bot@example.com" }, { COCHECK_BOT_NAME: "Public Bot" }, {}]) {
      const r = runExport(priv, pub, env);
      assert.notEqual(r.code, 0);
      assert.match(r.out, /is not set/);
    }
    assert.equal(snapshot(pub), before);
  });
  it("refuses a bot identity that matches the denylist", () => {
    const { priv, pub } = repos({ "a.ts": "export {};\n" });
    const r = runExport(priv, pub, { COCHECK_BOT_NAME: `${OWNER} B`, COCHECK_BOT_EMAIL: "bot@example.com" });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /denylist/);
  });
  it("refuses a dirty private tree", () => {
    const { priv, pub } = repos({ "a.ts": "export {};\n" });
    put(priv, "a.ts", "changed\n");
    const before = snapshot(pub);
    const r = runExport(priv, pub);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /private tree is dirty/);
    assert.equal(snapshot(pub), before);
  });
  it("a gate hit exits non-zero and leaves the public checkout byte-identical", () => {
    const { priv, pub } = repos({ "a.ts": `// ${OWNER} said so\n`, "b.ts": "export {};\n" });
    const before = snapshot(pub);
    const r = runExport(priv, pub);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /^a\.ts:1: DENY-\d+$/m);
    assert.equal(snapshot(pub), before);
    assert.equal(readFileSync(path.join(pub, "old.txt"), "utf8"), "deleted in private\n");
  });
  it("a clean tree commits on sync/<date> with the bot as author and committer, +0000 dates, deletions applied", () => {
    const { priv, pub } = repos({ "a.ts": "export {};\n", "docs/b.md": "hi\n" });
    const privHead = git(priv, "rev-parse", "HEAD").trim();
    const r = runExport(priv, pub);
    assert.equal(r.code, 0, r.out);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(git(pub, "rev-parse", "--abbrev-ref", "HEAD").trim(), `sync/${day}`);
    assert.equal(git(pub, "log", "-1", "--format=%an|%ae|%cn|%ce").trim(), "Public Bot|bot@example.com|Public Bot|bot@example.com");
    const dates = git(pub, "log", "-1", "--format=%ad|%cd", "--date=raw").trim().split("|");
    for (const d of dates) assert.match(d, / \+0000$/);
    assert.deepEqual(git(pub, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean).sort(), ["a.ts", "docs/b.md"]);
    assert.equal(git(pub, "status", "--porcelain").trim(), "");
    assert.ok(!git(pub, "log", "-1", "--format=%B").includes(privHead));
    assert.match(r.out, /git -C .* push -u origin sync\//);
    assert.match(r.out, /gh pr create/);
    assert.equal(git(priv, "rev-parse", "HEAD").trim(), privHead);
    assert.equal(git(priv, "status", "--porcelain").trim(), "");
  });
  it("a COCHECK_GATE_ALLOW in the caller's environment cannot excuse a planted owner name", () => {
    const text = `// ${OWNER} said so\n`;
    const { priv, pub } = repos({ "a.ts": text });
    const dir = tmp();
    put(dir, "a.ts", text);
    const rules = [...gate(dir).out.matchAll(/^a\.ts:1: (DENY-\d+)$/gm)].map((m) => m[1]!);
    assert.ok(rules.length > 0, "the planted word hits");
    const permissive = path.join(tmp(), "permissive.txt");
    writeFileSync(permissive, rules.map((r) => `a.ts ${r} ${sha(text)} # permissive\n`).join(""));
    assert.equal(gate(dir, permissive).code, 0, "the permissive file does excuse it when the gate is called directly");
    const r = runExport(priv, pub, { ...BOT, COCHECK_GATE_ALLOW: permissive });
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /^a\.ts:1: DENY-\d+$/m);
  });
  it("an empty public repo gets an orphan first commit", () => {
    const { priv, pub } = repos({ "a.ts": "export {};\n" }, false);
    const r = runExport(priv, pub);
    assert.equal(r.code, 0, r.out);
    assert.equal(git(pub, "rev-list", "--count", "HEAD").trim(), "1");
    assert.equal(git(pub, "log", "-1", "--format=%an|%cn").trim(), "Public Bot|Public Bot");
  });
});
