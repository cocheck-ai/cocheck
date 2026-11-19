import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { commandNamesFile } from "../src/attribution/names.ts";
import { workbookClaims } from "./helpers/claims.ts";

// Two helpers' shell calls open over the same writes, neither tagged: the one call whose own command names the file is credited
// (basis `named`, inferred). Zero or several naming calls keep the joint credit. A command that only reads the file never names it.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-tiebreak-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};

async function rig() {
  const home = await tmp("home");
  const folder = await tmp("folder");
  let clock = Date.parse("2026-11-15T14:00:00Z");
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const bash = (event: string, agent: string, id: string, command: string) => send({ hook_event_name: event, tool_name: "Bash", tool_use_id: id, tool_input: { command }, agent_id: agent, agent_type: "general-purpose" });
  const put = (rel: string, body: string) => writeFile(path.join(folder, rel), body);
  const states = () => {
    const l = openLedger(home);
    try {
      const rows = l.fileStatesForTask(1).map((s) => ({ file: path.basename(s.filePath), credited: [...s.credited].sort().join("+"), basis: s.creditBasis }));
      const last = new Map<string, (typeof rows)[number]>();
      for (const r of rows) last.set(r.file, r);
      return Object.fromEntries([...last].map(([f, r]) => [f, `${r.credited}:${r.basis}`]));
    } finally {
      l.close();
    }
  };
  await send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
  return { bash, put, states, send };
}

const MEMO = "pip install python-docx matplotlib && python3 make_chart.py && python3 build_memo.py && python3 soffice.py --headless --convert-to pdf memo.docx";
const DECK = "node build_deck.js && python3 validate.py NVDA_AAPL_deck.pptx; cd deck_assets && python3 /s/scripts/office/soffice.py --headless --convert-to pdf ../NVDA_AAPL_deck.pptx >/dev/null 2>&1; rm -f slide-*.jpg; pdftoppm -jpeg -r 70 NVDA_AAPL_deck.pdf slide && ls -1 \"$PWD\"/slide-*";

describe("name tiebreak among open shell calls", () => {
  it("overlap: the deck helper's command names the deck, the pdf and the slides; the memo call's does not", async () => {
    const t = await rig();
    await t.bash("PreToolUse", "helper1", "M", MEMO);
    await t.bash("PreToolUse", "helper2", "D", DECK);
    await t.put("NVDA_AAPL_deck.pptx", "pptx");
    await t.put("NVDA_AAPL_deck.pdf", "pdf");
    for (const n of [1, 2, 3, 4, 5]) await t.put(`slide-${n}.jpg`, `jpg${n}`);
    await t.bash("PostToolUse", "helper2", "D", DECK);
    const rebuild = "cd deck_assets && pdftoppm -jpeg -r 110 -f 4 -l 4 NVDA_AAPL_deck.pdf s4";
    await t.bash("PreToolUse", "helper2", "D2", rebuild);
    await t.put("s4-4.jpg", "s4");
    await t.bash("PostToolUse", "helper2", "D2", rebuild);
    await t.bash("PostToolUse", "helper1", "M", MEMO);
    const s = t.states();
    for (const f of ["NVDA_AAPL_deck.pptx", "NVDA_AAPL_deck.pdf", "slide-1.jpg", "slide-5.jpg"]) assert.equal(s[f], "D:named", `${f} ${JSON.stringify(s)}`);
    assert.equal(s["s4-4.jpg"], "D2:named", JSON.stringify(s));
  });

  it("no open call names the file: credit stays joint, as before", async () => {
    const t = await rig();
    await t.bash("PreToolUse", "helper1", "M", "python3 a.py");
    await t.bash("PreToolUse", "helper2", "D", "python3 b.py");
    await t.put("out.pdf", "x");
    await t.bash("PostToolUse", "helper2", "D", "python3 b.py");
    await t.bash("PostToolUse", "helper1", "M", "python3 a.py");
    assert.equal(t.states()["out.pdf"], "D+M:window");
  });

  it("both open calls name the file: credit stays joint, as before", async () => {
    const t = await rig();
    await t.bash("PreToolUse", "helper1", "M", "python3 a.py out.pdf");
    await t.bash("PreToolUse", "helper2", "D", "python3 b.py out.pdf");
    await t.put("out.pdf", "x");
    await t.bash("PostToolUse", "helper2", "D", "python3 b.py out.pdf");
    await t.bash("PostToolUse", "helper1", "M", "python3 a.py out.pdf");
    assert.equal(t.states()["out.pdf"], "D+M:window");
  });

  // Must not happen: a call that only reads the file must not take a silent writer's credit.
  it("a command that only reads the file (pdftoppm's input, cat) does not take credit from a silent writer", async () => {
    const t = await rig();
    const reader = "cat deck.pdf > /dev/null; pdftoppm -png deck.pdf page && python3 check.py";
    await t.bash("PreToolUse", "helper1", "W", "python3 build_everything.py");
    await t.bash("PreToolUse", "helper2", "R", reader);
    await t.put("deck.pdf", "x");
    await t.bash("PostToolUse", "helper2", "R", reader);
    await t.bash("PostToolUse", "helper1", "W", "python3 build_everything.py");
    assert.equal(t.states()["deck.pdf"], "R+W:window");
  });
});

describe("commandNamesFile", () => {
  it("basename anywhere outside a read-only part", () => {
    assert.equal(commandNamesFile("zip -dq NVDA_AAPL_deck.pptx '*/'", "/f/NVDA_AAPL_deck.pptx"), true);
    assert.equal(commandNamesFile("python3 x.py > report.csv", "/f/report.csv"), true);
    assert.equal(commandNamesFile("python3 x.py > myreport.csv", "/f/report.csv"), false);
    assert.equal(commandNamesFile("cat report.csv; python3 x.py", "/f/report.csv"), false);
    assert.equal(commandNamesFile("cat report.csv > /dev/null; python3 x.py", "/f/report.csv"), false);
    assert.equal(commandNamesFile("ls -1 slide-1.jpg && python3 x.py", "/f/slide-1.jpg"), false);
    assert.equal(commandNamesFile("python3 x.py >report.csv", "/f/report.csv"), true);
  });
  it("literal directories before the basename must be the file's own", () => {
    assert.equal(commandNamesFile("cd /f/raw; curl -s https://x/y -o lnk/yahoo_CEMB.json", "/f/raw/yahoo_CEMB.json"), false);
    assert.equal(commandNamesFile("curl -s https://x/y -o raw/yahoo_CEMB.json", "/f/raw/yahoo_CEMB.json"), true);
    assert.equal(commandNamesFile("python3 b.py --out=/f/raw/a.json", "/f/raw/a.json"), true);
    assert.equal(commandNamesFile("python3 b.py --out=/g/raw/a.json", "/f/raw/a.json"), false);
    assert.equal(commandNamesFile("zip -dq ../NVDA_AAPL_deck.pptx x", "/f/NVDA_AAPL_deck.pptx"), true);
    assert.equal(commandNamesFile("python3 b.py \"$OUT\"/a.json", "/f/raw/a.json"), true);
    assert.equal(commandNamesFile("cd /f/raw; rm -f yahoo_{1COV.F,3011.HK}.json", "/f/raw/yahoo_3011.HK.json"), true);
  });
  it("pdftoppm pages: <prefix>-<n>.<ext>, any zero padding, -f/-l bound, -singlefile, never its input", () => {
    const cmd = "cd deck_assets && pdftoppm -jpeg -r 70 NVDA_AAPL_deck.pdf slide";
    assert.equal(commandNamesFile(cmd, "/f/deck_assets/slide-1.jpg"), true);
    assert.equal(commandNamesFile(cmd, "/f/deck_assets/slide-05.jpg"), true);
    assert.equal(commandNamesFile(cmd, "/f/deck_assets/slide-1.png"), false);
    assert.equal(commandNamesFile(cmd, "/f/deck_assets/slides-1.jpg"), false);
    assert.equal(commandNamesFile(cmd, "/f/deck_assets/NVDA_AAPL_deck.pdf"), false);
    const one = "pdftoppm -jpeg -r 110 -f 4 -l 4 NVDA_AAPL_deck.pdf s4";
    assert.equal(commandNamesFile(one, "/f/s4-4.jpg"), true);
    assert.equal(commandNamesFile(one, "/f/s4-04.jpg"), true);
    assert.equal(commandNamesFile(one, "/f/s4-3.jpg"), false);
    assert.equal(commandNamesFile("pdftoppm in.pdf out", "/f/out-1.ppm"), true);
    assert.equal(commandNamesFile("pdftoppm -png -singlefile in.pdf cover", "/f/cover.png"), true);
    assert.equal(commandNamesFile("pdftoppm -png -singlefile in.pdf cover", "/f/cover-1.png"), false);
  });
  it("soffice --convert-to: the input's stem with the new extension, never the input itself", () => {
    const cmd = "python3 $S/scripts/office/soffice.py --headless --convert-to pdf ../NVDA_AAPL_deck.pptx >/dev/null 2>&1";
    assert.equal(commandNamesFile(cmd, "/f/deck_assets/NVDA_AAPL_deck.pdf"), true);
    assert.equal(commandNamesFile(cmd, "/f/NVDA_AAPL_deck.pptx"), false);
    assert.equal(commandNamesFile("soffice --headless --convert-to docx:\"MS Word 2007 XML\" --outdir out memo.odt", "/f/out/memo.docx"), true);
  });
});
