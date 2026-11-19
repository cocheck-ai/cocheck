import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toolLabel, looksSecret } from "../src/tool-label.ts";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";

// A flagged helper field (Agent/Task prompt, SendMessage message, content, summary) is withheld whole and never stored; no part of it is kept.
// Design: withhold whole, never span redaction. Leak shapes cover prose, .env line, heredoc, quoted, escaped JSON, YAML and TOML.
const hooks = { text: (s: string) => s, path: (s: string) => s };
const A = "kq7m";
const B = "vz9p";
// The leak list is gitleaks vendor formats in the shapes above. Generic password shapes are on the not-detected list below.
const GH = "ghp_Z8k2Qm4Xv7Rt1Pw9Yb3Nc6Hd5Jf0Lg8Ae2SW";
const LEAKS: Array<[string, string]> = [
  ["a GitHub token in prose", `use ${GH} for the push`],
  ["a .env line", `GITHUB_TOKEN=${GH}`],
  ["a .env heredoc", `cat > .env <<EOF\nGITHUB_TOKEN=${GH}\nEOF`],
  ["a quoted value", `token: "${GH}"`],
  ["escaped JSON", `{"env": "{\\"token\\": \\"${GH}\\"}"}`],
  ["a YAML block scalar", `db:\n  token: |\n    ${GH}\n  host: db.local`],
  ["TOML", `token = "${GH}"`],
  ["a PRIVATE KEY block", `-----BEGIN RSA PRIVATE KEY-----\n${A}${B}MIIEowIBAAKCAQEAxk3Jq9Zr2Lw8Vn5Tt7Yh1Ud4Bc6Fg0Ha3Sj\n${A}Wq9Er2Ty5Ui8Op1As4Df7Gh0Jk3Lz6Xc9Vb2Nm5Qw8Er1Ty4Ui7\n-----END RSA PRIVATE KEY-----`],
  ["an AWS access key", `aws key AKIAIOSFODNN7REALKEY here`],
  ["a Slack bot token", `xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx`],
];
const FIELDS: Array<[string, string]> = [["Agent", "prompt"], ["Task", "prompt"], ["SendMessage", "message"], ["SendMessage", "content"], ["SendMessage", "summary"]];

describe("a flagged helper field is withheld whole", () => {
  for (const [name, text] of LEAKS) {
    for (const [tool, field] of FIELDS) {
      it(`${tool}.${field}: ${name}`, () => {
        const body = `Step one.\n${text}\nThen report.`;
        const l = toolLabel(tool, { [field]: body }, hooks);
        assert.equal(l.fields[field], undefined, JSON.stringify(l));
        assert.ok(l.dropped?.[field], JSON.stringify(l));
        const stored = JSON.stringify(l);
        assert.ok(!stored.includes(A) && !stored.includes(B) && !stored.includes("Step one") && !stored.includes("withheld]"), stored);
        assert.equal((l as { redacted?: unknown }).redacted, undefined);
      });
    }
  }
});

describe("long messages and briefs keep head and tail around a middle cut", () => {
  const long = (n: number) => `HEAD-LINE\n${"word ".repeat(n)}\nTAIL-LINE`;
  for (const [tool, field] of [["SendMessage", "message"], ["Agent", "prompt"]] as const) {
    it(`${tool}.${field} over 6000 characters`, () => {
      const l = toolLabel(tool, { [field]: long(2000) }, hooks);
      const s = l.fields[field] as string;
      assert.ok(s.length <= 6000, String(s.length));
      assert.ok(s.startsWith("HEAD-LINE") && s.endsWith("TAIL-LINE"), s.slice(0, 20));
      assert.ok(s.includes("\n[middle cut]\n"));
    });
    it(`${tool}.${field} under 6000 characters is kept in full`, () => {
      const t = long(900);
      assert.equal(toolLabel(tool, { [field]: t }, hooks).fields[field], t);
    });
  }
});

describe("the detector no longer reads a heading as a credential", () => {
  const DECK = "Deck spec\nDesign tokens:\n  PAPER  #FFFFFF\n  INK    #111111\nSlides follow.";
  it("msg-5 shape: 'Design tokens:' then an indented line is not a secret", () => {
    assert.equal(looksSecret(DECK), false);
    assert.equal(toolLabel("SendMessage", { message: DECK }, hooks).fields.message, DECK);
  });
  for (const t of ["Tokens:\n- PAPER is the background\n- INK is the text", "Secret sauce: the cover slide carries the thesis"]) {
    it(`stays readable: ${JSON.stringify(t).slice(0, 40)}`, () => assert.equal(looksSecret(t), false));
  }
  // These were accepted false withholds under the hand-written name rules; with only the gitleaks rules they are readable.
  for (const t of ["Keys: arrow keys move between versions", "The API key: read it from the environment", "Password:\n  Slide one", "Key:\n  revenue grew 4%", "Design token:\n  PAPER #FFFFFF"]) {
    it(`no longer a false withhold: ${JSON.stringify(t).slice(0, 40)}`, () => assert.equal(looksSecret(t), false));
  }
});

describe("documented gaps (not caught, pinned so a change is noticed)", () => {
  it("a secret with no name is not caught", () => assert.equal(looksSecret(`log in with admin / ${A}${B} on the staging box`), false));
  // Free-prose passwords with no vendor format are not detected. Bound stated in docs/security.md.
  for (const t of ["password: hunter22", "password: correct horse battery staple", `password:\n  ${A}${B}`, `DB_PASS=${A} ${B}`, `Authorization: Bearer ${A}${B}abcdefgh`, `curl -u "u:${A} ${B}" https://api.example.com`])
    it(`free-prose password is not caught: ${JSON.stringify(t).slice(0, 40)}`, () => assert.equal(looksSecret(t), false));
  it("a Markdown table cell is not caught", () => assert.equal(looksSecret(`| key | value |\n| password | ${A} ${B} |`), false));
});

describe("none of the 24 recorded briefs and messages is withheld", () => {
  const rows = JSON.parse(readFileSync(new URL("./fixtures/secret/helper-agent-inputs.json", import.meta.url), "utf8")) as Array<{ id: string; tool: string; fields: Record<string, string> }>;
  it("0 of 24 withheld, in any field", () => {
    const ids = new Set(rows.map((r) => r.id));
    assert.equal(ids.size, 24);
    const hit: string[] = [];
    for (const r of rows) {
      const l = toolLabel(r.tool, r.fields, hooks);
      if (l.dropped) hit.push(`${r.id}:${Object.keys(l.dropped).join(",")}`);
    }
    assert.deepEqual(hit, []);
  });
  it("msg-5 (the 4809-character deck spec) is recorded in full", () => {
    const m = rows.find((r) => r.fields.message?.includes("Design tokens"))!;
    assert.equal(m.fields.message.length, 4809);
    assert.equal(toolLabel("SendMessage", m.fields, hooks).fields.message, m.fields.message);
  });
});

// ---- the page ----
const c = (id: string, seq: number, extra: Record<string, unknown>, tool: string) => call(id, { session: "s1", tool, desc: id, at: seq * 10, named: [], extra: { startSeq: seq, ...extra } });
const input = (ops: TimelineInput["ops"]): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates: [], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false });
const NOTE = "This message was withheld because it looked like it held a secret.";
describe("the page says a message was withheld", () => {
  const stops = (label: Record<string, unknown>) => buildRailModel(buildTimeline(input([prompt("s1", ["Go."], { requests: [{ seq: 1, at: 10, firstStep: null }] }), c("S1", 2, { toolLabel: label }, "SendMessage"), stop("s1", "ok")]))).stops;
  it("a withheld message shows the note, and the 50-character content field is never shown as the message", () => {
    const fifty = "Message sent to team-lead, delivery is not tracked";
    const s = stops({ fields: { to: "team-lead", summary: "deck spec", content: fifty }, dropped: { message: "secret-looking value, not recorded" } }).find((x) => x.label?.startsWith("Message to"))!;
    assert.ok(s, "no message stop");
    const lines = s.card!.lines.map((l) => l.text);
    assert.ok(lines.includes(NOTE), lines.join("|"));
    assert.ok(!lines.some((l) => l.includes(fifty)) && !s.head.includes(fifty), s.head);
  });
  it("a withheld content field alone shows the note", () => {
    const s = stops({ fields: { to: "team-lead" }, dropped: { content: "secret-looking value, not recorded" } }).find((x) => x.label?.startsWith("Message to"))!;
    assert.ok(s.card!.lines.map((l) => l.text).includes(NOTE));
  });
  it("a withheld summary shows the note", () => {
    const s = stops({ fields: { to: "team-lead", message: "Memo done." }, dropped: { summary: "secret-looking value, not recorded" } }).find((x) => x.label?.startsWith("Message to"))!;
    assert.ok(s.card!.lines.map((l) => l.text).includes(NOTE));
  });
});
