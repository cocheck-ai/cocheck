import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { runHook, type HookExit } from "../src/hook-cli.ts";
import { setTracking } from "../src/tracking.ts";
import { loadRows } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { copilot } from "../src/hosts/copilot.ts";
import { newCursor } from "../src/narration.ts";

// A Copilot `<system_notification>` prompt is the host's, not the user's: it opens no request, and the closing of a request is the
// main agent's last message, never a helper's. The records are the real VS Code 1.140.0 hook stdin and the real events.jsonl messages
// (platforms/copilot-vscode/versions/1.140.0/README.md); a temp home, folder and COPILOT_HOME are used, never the real ones.
const DIR = path.join(import.meta.dirname, "..", "platforms", "copilot-vscode", "versions", "1.140.0");
const NOTIFIED = { main: "30bc4d98-8dc8-4043-9b99-a97d599a6e92", hooks: "hook-calls-vscode-notified.jsonl", events: "events-vscode-notified.jsonl" };
const CONTROL = { main: "25ee9a7c-ca9a-4d10-bd2e-e53055cfac50", hooks: "hook-calls-vscode-control.jsonl", events: "events-vscode-control.jsonl" };
const NOTICE = '<system_notification>\nAgent "model-memo-writer" (memo-writer) has finished processing and is now idle.\n</system_notification>';

interface Rec {
  event: string;
  stdin: Record<string, any>;
}
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const lines = (file: string): string[] => readFileSync(path.join(DIR, file), "utf8").split("\n").filter(Boolean);

/** Replays a recorded session through the real hook. The session's events.jsonl grows as it did live: a line is written before the first hook whose timestamp is not earlier than the line's. */
async function replay(set: typeof NOTIFIED, edit: (recs: Rec[]) => Rec[] = (r) => r) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-")));
  dirs.push(root);
  const home = path.join(root, "home");
  const folder = path.join(root, "folder");
  const copilotHome = path.join(root, "copilot");
  mkdirSync(home);
  mkdirSync(folder);
  const sessionDir = path.join(copilotHome, "session-state", set.main);
  mkdirSync(sessionDir, { recursive: true });
  const eventsFile = path.join(sessionDir, "events.jsonl");
  writeFileSync(eventsFile, "");
  process.env.COPILOT_HOME = copilotHome;
  setTracking(home, "copilot", set.main, true, folder);
  // transcriptPath in the records names the recorded machine's file; every record of the session pointed at the main session's events.jsonl.
  const recs = edit(lines(set.hooks).map((l) => JSON.parse(l.split("<scratch>/ws").join(folder)) as { event_arg: string; stdin: Record<string, any> }).map((d) => ({ event: d.event_arg, stdin: d.stdin.transcriptPath === undefined ? d.stdin : { ...d.stdin, transcriptPath: eventsFile } })));
  const transcript = lines(set.events).map((l) => ({ at: Date.parse(JSON.parse(l).timestamp), line: l }));
  let next = 0;
  let clock = 0;
  const exits: Array<{ event: string; exit: HookExit }> = [];
  for (const rec of recs) {
    if (typeof rec.stdin.timestamp === "number") clock = rec.stdin.timestamp;
    while (next < transcript.length && transcript[next]!.at <= clock + 50) appendFileSync(eventsFile, transcript[next++]!.line + "\n");
    const exit = await runHook({ argv: ["node", "hook.ts", "--host", "copilot", "--event", rec.event], env: { COCHECK_HOME: home }, stdin: (async function* () { yield Buffer.from(JSON.stringify(rec.stdin)); })() });
    exits.push({ event: rec.event, exit });
  }
  const ledger = openLedger(home);
  const timeline = buildTimeline({ ...loadRows(ledger, 1, "test"), build: "t", folder, stored: new Map(), formats: new Map(), quickLook: false });
  ledger.close();
  return { timeline, exits };
}

describe("the VS Code session with system notifications", () => {
  it("is one request with every call, the main agent's closing sentence, and the helpers' finishes as finishes", async () => {
    const { timeline, exits } = await replay(NOTIFIED);
    for (const { event, exit } of exits) assert.ok(exit.exitCode === 0 || exit.exitCode === 1, `${event}: exit ${exit.exitCode}`);
    assert.equal(timeline.requests.length, 1, JSON.stringify(timeline.requests.map((r) => r.texts)));
    const r = timeline.requests[0]!;
    assert.match(r.texts.map((t) => t.text).join("\n"), /^Start tracking/);
    assert.ok(!JSON.stringify(timeline.requests).includes("system_notification"), "the notification is nowhere labelled the user's words");
    const calls = r.runs.flatMap((x) => x.calls);
    // The live session recorded 19 (18 before the notification, the failing ls after). The replay starts with tracking already on, so the two calls that
    // started it (the cocheck skill and `cocheck track start`) are recorded here and are left out of the count.
    assert.deepEqual(calls.slice(0, 2).map((c) => c.tool), ["skill", "bash"]);
    assert.equal(calls.length - 2, 19);
    const ls = calls.find((c) => c.line?.text === "Run required failing verification command");
    assert.equal(ls?.outcome, "failed", "the failing ls (the main agent's own call after the notification) is in the request");
    assert.equal(r.closing?.text, "All three delegated helpers completed; the required command failed as expected.");
    assert.deepEqual((r.finishes ?? []).map((f) => f.agentType).sort(), ["general-purpose", "general-purpose", "memo-writer"]);
  });

  it("the first turn's closing is the main agent's own words, not the memo helper's, which was the closing before the fix", async () => {
    const { timeline } = await replay(NOTIFIED);
    const replies = (timeline.requests[0]!.replies ?? []).map((x) => x.line.text);
    assert.ok(replies.length > 0 && replies.every((t) => !/memo\.md|openpyxl|markdown fallback deck/.test(t)), JSON.stringify(replies));
    assert.equal(replies[0], "Waiting for all three delegated helpers to finish.");
  });

  it("control: the same run with no notifications is one request closed by the main agent", async () => {
    const { timeline } = await replay(CONTROL);
    assert.equal(timeline.requests.length, 1);
    assert.match(timeline.requests[0]!.closing?.text ?? "", /^Tracking started; helpers created/);
  });
});

describe("a closing is the main agent's last message, never a helper's", () => {
  // The real lines of the session, in file order: the main agent's answer, then the helpers' task prompts and answers landing in the same file.
  const real = lines(NOTIFIED.events);
  const closingAfter = (pick: (d: any) => boolean): string | undefined => {
    const cur = newCursor("events.jsonl");
    for (const l of real) if (pick(JSON.parse(l))) copilot.narration.foldLine(cur, l);
    return copilot.narration.closing(cur);
  };
  it("a helper's final answer (parentToolCallId) does not replace the main agent's", () => {
    assert.equal(closingAfter((d) => d.type === "assistant.message" && Date.parse(d.timestamp) < Date.parse("2026-10-24T23:35:00Z")), "Waiting for all three delegated helpers to finish.");
  });
  it("a helper's task prompt (a user.message with a source) does not blank the main agent's closing", () => {
    const all = real.map((l) => JSON.parse(l));
    const mainAnswer = all.find((d) => d.data.content === "Waiting for all three delegated helpers to finish.");
    const helperPrompt = all.find((d) => d.type === "user.message" && typeof d.data.source === "string");
    const cur = newCursor("events.jsonl");
    copilot.narration.foldLine(cur, JSON.stringify(mainAnswer));
    copilot.narration.foldLine(cur, JSON.stringify(helperPrompt));
    assert.equal(copilot.narration.closing(cur), "Waiting for all three delegated helpers to finish.");
  });
  it("a prompt the person typed (no source) still starts a new turn and blanks the closing", () => {
    const all = real.map((l) => JSON.parse(l));
    const typed = all.find((d) => d.type === "user.message" && d.data.source === undefined);
    const cur = newCursor("events.jsonl");
    copilot.narration.foldLine(cur, JSON.stringify(all.find((d) => d.data.content === "Waiting for all three delegated helpers to finish.")));
    copilot.narration.foldLine(cur, JSON.stringify(typed));
    assert.equal(copilot.narration.closing(cur), "");
  });
});

describe("must not: a real user prompt is never mistaken for a notification", () => {
  const withPrompt = (prompt: string) => (recs: Rec[]): Rec[] => recs.map((r) => (r.event === "userPromptSubmitted" && r.stdin.prompt === NOTICE ? { ...r, stdin: { ...r.stdin, prompt } } : r));
  const texts = async (prompt: string) => (await replay(NOTIFIED, withPrompt(prompt))).timeline.requests.flatMap((r) => r.texts.map((t) => t.text));
  for (const prompt of [
    "Did you get the notification about the memo helper?",
    `Why did I get this? ${NOTICE}`,
    `${NOTICE}\nPlease ignore that and run ls again.`,
    `<system_notification>one</system_notification> and <system_notification>two</system_notification>`,
    "<system_notification> never closed",
  ]) {
    it(`opens its own request: ${JSON.stringify(prompt).slice(0, 50)}`, async () => {
      assert.ok((await texts(prompt)).includes(prompt));
    });
  }
  it("only the whole prompt as one element counts, matched on the wrapper not the English inside", () => {
    const kind = (prompt: string) => copilot.refineKind!("prompt", { prompt });
    assert.equal(kind(NOTICE), "other");
    assert.equal(kind(`  ${NOTICE}\n`), "other");
    assert.equal(kind('<system_notification>\nAgente "x" terminó.\n</system_notification>'), "other");
    assert.equal(kind("<system_notification></system_notification>"), "other");
    assert.equal(kind("nothing here"), "prompt");
    assert.equal(kind(`<system_notification>a</system_notification> tail`), "prompt");
    assert.equal(kind("a <system_notification>a</system_notification>"), "prompt");
    assert.equal(kind(`<system_notification>a</system_notification><system_notification>b</system_notification>`), "prompt");
  });
});
