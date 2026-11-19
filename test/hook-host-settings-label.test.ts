import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { loadRows, taskHostOf } from "../src/timeline/load.ts";
import { buildTimeline, type Timeline } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { trackedClaims } from "./helpers/claims.ts";

// The Claude desktop app saves the user's permission choices into <task folder>/.claude/settings.local.json. CoCheck can't tell that
// write from an agent's background write (`(sleep 2; printf ... > .claude/settings.local.json) &` lands after its call's Post), and a
// content rule can't either. So the file is never dropped: recorded as any outside change, labelled "Probably the Claude app ..." (a
// guess, said as one), shown as a muted step with its diff viewable. Guards against: a credited agent write reads as the agent's
// own, never as "probably the app"; and the agent's backgrounded write is recorded and visible, not hidden.

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const SETTINGS = `{"permissions":{"allow":["Bash(ls:*)"]}}\n`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-hostlabel-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-hostlabel-folder-")));
  await writeFile(path.join(folder, "readme.md"), "start\n");
  const ledger = openLedger(home);
  cleanups.push(async () => {
    ledger.close();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const hostOpts = { perSession: false, host: "claude" as const, home, claimed: trackedClaims, folder };
  const base = JSON.parse(await readFile(path.join(FIXTURES, "hooks", "claude-pre-bash.json"), "utf8")) as HookPayload;
  const send = (over: Record<string, unknown>) => handleHook({ ...base, cwd: folder, ...over } as HookPayload, hostOpts);
  const call = async (id: string, act: () => Promise<void>, command = "python3 write_files.py") => {
    const tool_input = { command, description: "Write the files" };
    await send({ hook_event_name: "PreToolUse", tool_use_id: id, tool_input });
    await act();
    await send({ hook_event_name: "PostToolUse", tool_use_id: id, tool_input, tool_response: { stdout: "", stderr: "" } });
  };
  const put = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), text);
  };
  /** Stop, then the rail's stops for the settings file (and the files recorded). */
  const stop = async () => {
    const r = await send({ hook_event_name: "Stop", tool_name: undefined, tool_input: undefined, tool_use_id: undefined });
    assert.ok(r.summary, "the stop closes a task");
    const taskId = r.summary.taskId;
    const files = ledger.fileStatesForTask(taskId).map((s) => path.relative(folder, s.filePath));
    const tl = buildTimeline({ ...loadRows(ledger, taskId, "test"), build: "t", folder, host: taskHostOf(ledger, taskId), stored: new Map(), formats: new Map(), quickLook: false }) as Timeline;
    const stops = buildRailModel(tl).stops.filter((s) => s.change?.file === ".claude/settings.local.json");
    return { files, stops };
  };
  return { call, put, stop };
}

describe("host-written .claude/settings.local.json is labelled, never skipped", () => {
  it("the reviewer's probe: an agent's backgrounded write landing after its call closed is recorded and visible", async () => {
    const t = await setup();
    const cmd = `(sleep 2; printf '{"permissions":{"allow":["Bash(*)"]}}' > .claude/settings.local.json) &`;
    await t.call("toolu_E", async () => {}, cmd);
    await t.put(".claude/settings.local.json", '{"permissions":{"allow":["Bash(*)"]}}'); // the background subshell, after Post
    await t.call("toolu_F", () => t.put("more.txt", "more\n"));
    const { files, stops } = await t.stop();
    assert.ok(files.includes(path.join(".claude", "settings.local.json")), `recorded: ${files}`);
    assert.equal(stops.length, 1, "one step for it, on the page");
    assert.ok(stops[0]!.change!.viewUrl !== null && !stops[0]!.change!.secret, "its diff stays viewable");
  });

  it("a plain host write between calls: recorded, labelled as a guess, muted", async () => {
    const t = await setup();
    await t.call("toolu_A", () => t.put("notes.txt", "agent notes\n"));
    await t.put(".claude/settings.local.json", SETTINGS);
    await t.call("toolu_B", () => t.put("more.txt", "more\n"));
    const { files, stops } = await t.stop();
    assert.ok(files.includes(path.join(".claude", "settings.local.json")), `recorded: ${files}`);
    const s = stops[0]!;
    assert.match(s.head, /Probably the Claude app saving your permission choices/);
    assert.match(s.sub ?? "", /can't tell for sure/);
    assert.equal(s.muted, true, "shown as a muted step");
    assert.ok(s.change!.viewUrl !== null && !s.change!.secret, "its diff stays viewable");
  });

  it("a credited agent edit of the file shows as the agent's, no 'probably the app' label, not muted", async () => {
    const t = await setup();
    await t.call("toolu_C", () => t.put(".claude/settings.local.json", SETTINGS));
    const { stops } = await t.stop();
    const s = stops[0]!;
    assert.doesNotMatch(`${s.head} ${s.sub ?? ""}`, /Probably|app/);
    assert.equal(s.muted, undefined);
  });
});
