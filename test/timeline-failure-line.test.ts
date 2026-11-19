import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { loadRows } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { firstMeaningfulLine } from "../src/timeline/rail/failure-line.ts";
import { workbookClaims } from "./helpers/claims.ts";

// The plain line of a failed step: the first meaningful line of the host's words, with the words kept whole behind it.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

const captured = async (): Promise<Array<Record<string, any>>> =>
  (await readFile(path.join(import.meta.dirname, "fixtures", "posttoolusefailure.jsonl"), "utf8")).split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));

/** A home and a folder holding one request and the two captured failed calls (exit 3, and exit 1 with stderr).
 *  The two are a run of failed calls by one actor with no change between them, so they are one failure group with one line. */
const BOTH = "Exit code 3\n\ncat: file: No such file or directory";
async function run() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  const before = process.env.COCHECK_HOME;
  process.env.COCHECK_HOME = home;
  cleanups.push(async () => {
    if (before === undefined) delete process.env.COCHECK_HOME;
    else process.env.COCHECK_HOME = before;
    for (const d of [home, folder]) await rm(d, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  const opts = { host: "claude" as const, home, claimed: workbookClaims, folder, perSession: false, now: () => (clock += 1000) };
  const hook = (o: Record<string, unknown>) => handleHook({ session_id: "sess", cwd: folder, ...o } as HookPayload, opts);
  await hook({ hook_event_name: "UserPromptSubmit", prompt: "Tidy up the notes" });
  for (const p of await captured()) await hook({ ...p, cwd: undefined });
  const model = () => {
    const ledger = openLedger(home);
    try {
      return buildRailModel(buildTimeline({ ...loadRows(ledger, 1, "test"), build: "t", folder, stored: new Map(), formats: new Map(), quickLook: false }));
    } finally {
      ledger.close();
    }
  };
  return { home, folder, model, hook };
}

const failures = (m: ReturnType<typeof buildRailModel>) => m.stops.filter((s) => s.failure);

describe("the failure line", () => {
  it("a failed step shows the first meaningful line of the raw text, and the raw stays behind it", async () => {
    const t = await run();
    const f = failures(t.model());
    assert.equal(f.length, 1);
    assert.equal(f[0]!.label, "2 runs failed");
    assert.equal(f[0]!.failure!.blurb, "cat: file: No such file or directory");
    assert.equal(f[0]!.failure!.raw, BOTH);
    assert.equal(f[0]!.failure!.hasText, true);
  });
  it("a preferences file that still holds an aiLines entry changes nothing", async () => {
    const t = await run();
    const plain = JSON.stringify(t.model());
    for (const v of ["on", "errors", 3]) {
      await writeFile(path.join(t.home, "preferences.json"), JSON.stringify({ railOrder: "oldest-first", aiLines: v }));
      assert.equal(JSON.stringify(t.model()), plain);
    }
    assert.ok(!/"summary"|aiPending|quietSummaries/.test(plain));
  });
  it("the host text keeps its lines and masks an outside path behind Show output (real timeline build)", async () => {
    const t = await run();
    const p = { tool_name: "Bash", tool_use_id: "toolu_x", tool_input: { command: "make" } };
    await t.hook({ hook_event_name: "PreToolUse", ...p });
    await t.hook({ hook_event_name: "PostToolUseFailure", ...p, error: "Exit code 2\nError: cannot open /Users/someone/private/data.csv\nsecond line", is_interrupt: false });
    const ledger = openLedger(t.home);
    const built = buildTimeline({ ...loadRows(ledger, 1, "test"), build: "t", folder: t.folder, stored: new Map(), formats: new Map(), quickLook: false });
    ledger.close();
    const c = built.requests.flatMap((r) => r.runs.flatMap((x) => x.calls)).find((x) => x.id === "toolu_x")!;
    assert.equal(c.error!.includes("\n"), false, "the rail's line stays one line");
    assert.ok(c.errorFull!.includes("second line") && c.errorFull!.includes("Exit code 2"));
    assert.ok(!c.errorFull!.includes("/Users/someone"), String(c.errorFull));
    assert.ok(c.errorFull!.includes("data.csv"));
  });
  it("skips blanks and a bare exit code", () => {
    assert.equal(firstMeaningfulLine("\n  \nExit code 2\n--\nboom: bad thing"), "boom: bad thing");
    assert.equal(firstMeaningfulLine("Exit code 3"), "Exit code 3");
    assert.equal(firstMeaningfulLine("x".repeat(300)).length, 200);
  });
});

describe("the fallback line on real failure texts", () => {
  const py = `Exit code 1\nls: macro: No such file or directory\nkey=\nTraceback (most recent call last):\n  File "<string>", line 1, in <module>\n    import pandas;print(pandas.__version__)\n    ^^^^^^^^^^^^^\nModuleNotFoundError: No module named 'pandas'`;
  const nodeMissing = `Exit code 1\nnode:internal/modules/cjs/loader:1595\n  throw err;\n  ^\n\nError: Cannot find module 'docx'\nRequire stack:\n- /work/memo.js\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1591:15)\n    at Module._load (node:internal/modules/cjs/loader:1368:5) {\n  code: 'MODULE_NOT_FOUND',\n  requireStack: [\n    '/work/memo.js'\n  ]\n}\n\nNode.js v26.10.0`;
  const sed = `Exit code 1\nsed: 1: "macro/fetch_equities.py\n": invalid command code m`;
  const yf = `Exit code 1\n$^SP500V: 1d data not available for startTime=-2208970800 and endTime=1791894886. Only 100 years worth of day granularity data are allowed to be fetched per request.\n$^500VNTR: 1d data not available for startTime=-2208970800 and endTime=1791894886. Only 100 years worth of day granularity data are allowed to be fetched per request.\nSPXEW       ^SPXEW    2006-12-08 -> 2026-10-12 n=4976 last=8638.22\nFAILED SP500V (^SP500V): empty\nGSPC        ^GSPC     1927-12-30 -> 2026-10-12 n=24812 last=7807.24\nTraceback (most recent call last):\n  File "/work/venv/lib/python3.14/site-packages/pandas/core/indexes/base.py", line 3641, in get_loc\n    return self._engine.get_loc(casted_key)\n           ~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^`;
  const chart = `Exit code 1\nTraceback (most recent call last):\n  File "/work/build.py", line 129, in <module>\n    chart('Real GDP', 'Percent', E4)\n    ~~~~~^^^^^^^^\n  File "/work/openpyxl/descriptors/nested.py", line 33, in __set__\n    super().__set__(instance, value)\nValueError: Value must be one of {'l', 'r', 't', 'b', 'tr'}`;
  it("a Python traceback gives its final error line", () => {
    assert.equal(firstMeaningfulLine(py), "ModuleNotFoundError: No module named 'pandas'");
    assert.equal(firstMeaningfulLine(chart), "ValueError: Value must be one of {'l', 'r', 't', 'b', 'tr'}");
  });
  it("node module-not-found names the module (not the header, the throw or the stack)", () => {
    assert.equal(firstMeaningfulLine(nodeMissing), "Error: Cannot find module 'docx'");
  });
  it("a sed error gives the sed message", () => {
    assert.equal(firstMeaningfulLine(sed), '": invalid command code m');
  });
  it("a data-download failure gives the data error, not a header, a frame or a progress row", () => {
    assert.match(firstMeaningfulLine(yf), /^\$\^500VNTR: 1d data not available/);
  });
});
