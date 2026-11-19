import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evidenceDir, rootsFile } from "../src/attribution/tag.ts";
import { handleEvent } from "../src/hook-adapter.ts";
import { normalize } from "../src/normalize.ts";
import { openLedger } from "../src/ledger.ts";
import { toolNeverWrites } from "../src/credit-guard.ts";
import { workbookClaims } from "./helpers/claims.ts";

// Copilot names its tools in lower case. The static write-scope exclusion matched Claude's `Bash` only, and the no-credit tool
// list held Claude names only. Copilot tool names below come from the recorded 1.0.103 run (platforms/copilot-cli/versions/1.0.103/hook-calls.jsonl):
// bash, glob, rg, view (read-only), apply_patch (writes), task, read_agent. The commands are the shapes of a recorded run.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};

const MAIN = "a4fc20df-a65b-46b0-a846-badfb7c89142";
const TICKERS_B = ["1COV.F", "3011.HK", "3081.HK", "IDEM.L", "KBND"];
const cmdH5 = (raw: string) => `cd ${raw}; rm spdji_dashboard_apac_fi_2026-02.pdf; now=$(date +%s)
for t in PLUS.AX CORP.AX CRED.AX; do curl -s "https://query1.finance.yahoo.com/v8/finance/chart/$t?period1=0&period2=$now&interval=1d&events=div" -H "User-Agent: Mozilla/5.0" -o /tmp/y_$t.json; done`;
const cmdH6 = (raw: string) => `cd ${raw}; rm -f yahoo_{${TICKERS_B.join(",")}}.json`;

async function live() {
  const home = await tmp("home");
  const folder = await tmp("folder");
  const raw = path.join(folder, "data", "raw");
  await mkdir(raw, { recursive: true });
  await writeFile(path.join(raw, "spdji_dashboard_apac_fi_2026-02.pdf"), "%PDF");
  await mkdir(evidenceDir(home), { recursive: true });
  await writeFile(rootsFile(home), JSON.stringify([folder]) + "\n");
  let clock = Date.parse("2026-10-25T12:00:00Z");
  const opts = { host: "copilot" as const, home, claimed: workbookClaims, folder, now: () => clock };
  const send = (event: string, over: Record<string, unknown>, taggedCall = false) => {
    clock += 1000;
    return handleEvent(normalize("copilot", { sessionId: MAIN, cwd: raw, timestamp: clock, ...over }, event), { ...opts, taggedCall });
  };
  // the recorded shape: toolName, toolArgs, no call id; a helper's calls carry its agentId, agentType and parentAgentId (the main session)
  const helper = (n: string) => ({ sessionId: n, agentId: n, agentType: "general-purpose", parentAgentId: MAIN });
  const pre = (agent: string, tool: string, input: Record<string, unknown>) => send("preToolUse", { toolName: tool, toolArgs: input, ...helper(agent) }, true);
  const post = (agent: string, tool: string, input: Record<string, unknown>) => send("postToolUse", { toolName: tool, toolArgs: input, toolResult: { resultType: "success", textResultForLlm: "" }, ...helper(agent) });
  /** Per changed file, how many calls the change is credited to. */
  const credits = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).filter((s) => s.prevSha256 !== null || s.credited.length > 0).map((s) => `${path.basename(s.filePath)}:${s.credited.length}`);
    } finally {
      l.close();
    }
  };
  return { raw, pre, post, send, credits };
}

const removed = async (L: Awaited<ReturnType<typeof live>>, tool5: string, input5: Record<string, unknown>) => {
  for (const t of ["3011.HK", "IDEM.L"]) await writeFile(path.join(L.raw, `yahoo_${t}.json`), "{}");
  await L.send("userPromptSubmitted", { prompt: "go" });
  await L.pre("H5", tool5, input5);
  await L.pre("H6", "bash", { command: cmdH6(L.raw) });
  for (const t of ["3011.HK", "IDEM.L"]) await rm(path.join(L.raw, `yahoo_${t}.json`));
  await L.post("H6", "bash", { command: cmdH6(L.raw) });
  return L.credits().filter((c) => c.startsWith("yahoo_")).sort();
};

describe("Copilot `bash` gets the static write-scope exclusion", () => {
  it("(1) an open Copilot bash that provably writes elsewhere is not credited with H6's removals", async () => {
    const L = await live();
    assert.deepEqual(await removed(L, "bash", { command: cmdH5(L.raw) }), ["yahoo_3011.HK.json:1", "yahoo_IDEM.L.json:1"]);
  });
  it("(1b) must not: a Copilot bash that names the file stays a suspect", async () => {
    const L = await live();
    assert.deepEqual(await removed(L, "bash", { command: `cd ${L.raw}; rm -f yahoo_3011.HK.json` }), ["yahoo_3011.HK.json:2", "yahoo_IDEM.L.json:1"]);
  });
});

describe("Copilot read-only tools take no credit", () => {
  for (const tool of ["glob", "rg", "view"]) {
    it(`(2) an open ${tool} call is never credited with H6's removals`, async () => {
      const L = await live();
      assert.deepEqual(await removed(L, tool, { pattern: "*.json", path: L.raw }), ["yahoo_3011.HK.json:1", "yahoo_IDEM.L.json:1"]);
    });
  }
  it("(3) Claude names stay no-credit", () => {
    for (const t of ["Read", "Glob", "Grep"]) assert.equal(toolNeverWrites(t), true, t);
  });
  it("(4) must not: an unknown tool name is never read-only; the writers stay creditable", async () => {
    for (const t of ["apply_patch", "create", "edit", "str_replace_editor", "frobnicate", "Views", "glob2", "", "mcp__x__do_thing"]) assert.equal(toolNeverWrites(t), false, t);
    assert.equal(toolNeverWrites(undefined), false);
    const L = await live();
    assert.deepEqual(await removed(L, "frobnicate", { pattern: "*.json" }), ["yahoo_3011.HK.json:2", "yahoo_IDEM.L.json:2"]);
  });
});
