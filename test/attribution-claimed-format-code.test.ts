import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PRODUCTION_BUILTIN_CONNECTORS, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { openLedger } from "../src/ledger.ts";
import { readRows } from "../src/timeline/load.ts";
import { buildTimeline, type Change, type TimelineInput } from "../src/timeline/timeline.ts";

// Format code leaves the hook, and no change an agent made becomes a "?" row
// or an "outside the agents" row. A run with two helpers and the main agent, through the live hook, whose writers are processes
// the hook never sees: a Python build that leaves the workbook cut short and finishes it after its call closed, soffice converting
// the workbook to pdf, pdftoppm rendering the pdf to a picture, and Excel saving the workbook for an osascript call. One change is
// a person's, made with no call open. The claims are the shipped connectors' (no extension list in the test).
//
// What main (88785690, the hook still reading workbooks with the xlsx layer) answered for this exact run, per change in ledger
// order, is pinned below (taken by running this file against a copy of main). The bar: no more "?" rows (joint, during, lost)
// and no more false-outside rows than main, and the same actor credited for every change.
const MAIN_88785690 = {
  credits: [
    "model.xlsx:A [call]",
    "model.xlsx:A [call]",
    "model.pdf:B [call]",
    "page-1.png:C [call]",
    "model.xlsx:D [call]",
    "notes.txt: [outside]",
  ],
  unsure: 0,
  falseOutside: 0,
};

const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setBuiltinConnectorsForTest(undefined);
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-h512-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};

function changesOf(input: TimelineInput): Change[] {
  const t = buildTimeline(input);
  const out = new Map<string, Change>();
  for (const r of t.requests) for (const run of r.runs) for (const c of run.calls) for (const ch of c.changes ?? []) out.set(ch.id, ch);
  for (const ch of t.unplaced) out.set(ch.id, ch);
  return [...out.values()];
}

/** Golden writer per changed file: a call id, or "" for the person. */
const GOLDEN: Record<string, string> = { "model.xlsx": "A or D", "model.pdf": "B", "page-1.png": "C", "notes.txt": "" };

export async function run(extra: Record<string, unknown> = {}) {
  setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
  const home = await tmp("home");
  const folder = await tmp("folder");
  const book = path.join(folder, "model.xlsx");
  const notes = path.join(folder, "notes.txt");
  await copyFile(probe(0), book);
  await writeFile(notes, "first line\n");
  let clock = Date.parse("2026-11-16T12:00:00Z");
  const opts = { host: "claude" as const, home, folder, perSession: false, now: () => clock, ...extra };
  const send = (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts as never);
  };
  const helper = (n: string) => ({ agent_id: `helper${n}`, agent_type: "general-purpose" });
  const pre = (id: string, command: string, who: Record<string, unknown> = {}) => send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command }, ...who });
  const post = (id: string, command: string, who: Record<string, unknown> = {}) => send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: { command }, tool_response: { stdout: "", stderr: "", interrupted: false }, ...who });

  await send({ hook_event_name: "UserPromptSubmit", prompt: "build the model and its pages" });
  // Helper 1's Python build writes the workbook through a child the hook never sees: first cut short, seen so by a sweep while A is open.
  const full = await readFile(probe(1));
  await pre("A", "python3 build.py", helper("1"));
  await writeFile(book, full.subarray(0, Math.floor(full.length / 2)));
  await pre("A2", "python3 -c 'print(1)'", helper("1"));
  await post("A2", "python3 -c 'print(1)'", helper("1"));
  await post("A", "python3 build.py", helper("1"));
  // The build's child finishes the file after A's Post; the next sweep (helper 2's Pre, no call open) finds it whole.
  await writeFile(book, full);
  // Helper 2: soffice converts the workbook; the pdf is written by soffice, a process the hook never sees.
  await pre("B", "soffice --headless --convert-to pdf model.xlsx", helper("2"));
  await writeFile(path.join(folder, "model.pdf"), "%PDF-1.7 fake pages\n");
  await post("B", "soffice --headless --convert-to pdf model.xlsx", helper("2"));
  // Main: pdftoppm renders the pdf to a picture.
  await pre("C", "pdftoppm -png -r 50 model.pdf page");
  await writeFile(path.join(folder, "page-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  await post("C", "pdftoppm -png -r 50 model.pdf page");
  // Main: Excel saves the workbook for an osascript call; Excel is the writer.
  const excel = `osascript -e 'tell application "Microsoft Excel" to save workbook "model.xlsx"'`;
  await pre("D", excel);
  await copyFile(probe(2), book);
  await post("D", excel);
  // A person edits the notes with no call open: genuinely outside.
  await writeFile(notes, "first line\nthe person's line\n");
  await send({ hook_event_name: "Stop", last_assistant_message: "done" });

  const l = openLedger(home);
  try {
    const { ops, fileStates } = readRows(l, 1);
    const input: TimelineInput = { taskId: 1, build: "h512", ops, fileStates, folder, valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false, host: "claude" };
    const byId = new Map(changesOf(input).map((c) => [c.id, c]));
    // Every state but the starting copies (the first step's), so a file a writer created counts as a change.
    const baselineStep = Math.min(...fileStates.map((s) => s.step_id ?? Infinity));
    const changed = fileStates.filter((s) => s.step_id !== baselineStep);
    const changes = changed.map((s) => byId.get(`c${s.id}`)!);
    const credits = changes.map((c, i) => `${path.basename(changed[i]!.file_path)}:${[...c.by.calls].sort().join("+")} [${c.by.kind}]`);
    const unsure = changes.filter((c) => c.by.kind === "joint" || c.by.kind === "during" || c.by.kind === "lost").length;
    const falseOutside = changes.filter((c, i) => c.by.kind === "outside" && GOLDEN[path.basename(changed[i]!.file_path)] !== "").length;
    return { credits, unsure, falseOutside };
  } finally {
    l.close();
  }
}

describe("attribution rule: format code leaving the hook adds no '?' and no false-outside row", () => {
  it("helpers and unseen child-process writers (python, soffice, pdftoppm, Excel): same actors as main, no more '?' or false-outside", async () => {
    const got = await run();
    assert.ok(got.unsure <= MAIN_88785690.unsure, `"?" rows: ${got.unsure} > main's ${MAIN_88785690.unsure}\n${got.credits.join("\n")}`);
    assert.ok(got.falseOutside <= MAIN_88785690.falseOutside, `false-outside rows: ${got.falseOutside} > main's ${MAIN_88785690.falseOutside}\n${got.credits.join("\n")}`);
    assert.deepEqual(got.credits, MAIN_88785690.credits, "the same actor credited for every change");
  });

  it("the cut-short check is what keeps the finished build on A: without it (or with nothing claimed) the finish reads outside", async () => {
    // The guarded case, shown: the hook without the xlsx layer and without a replacement would credit the build's finish to nobody.
    for (const extra of [{ cutShort: () => undefined }, { claimed: () => false }]) {
      const got = await run(extra);
      assert.equal(got.credits[1], "model.xlsx: [outside]", JSON.stringify(extra));
      assert.equal(got.falseOutside, 1);
    }
  });
});
