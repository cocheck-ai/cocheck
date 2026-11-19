import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { handleEvent } from "../src/hook-adapter.ts";
import { normalize } from "../src/normalize.ts";
import { workbookClaims } from "./helpers/claims.ts";

// the first live Copilot run (1.0.93, scrubbed). The apply_patch request carries `arguments` as a string and no intentionSummary;
// the closing claim is the session's last `final_answer` message.
const REC = path.join(import.meta.dirname, "fixtures", "hosts", "copilot-1.0.93-live");
const probe = (n: number) => path.join(import.meta.dirname, "fixtures", "probe", `S${n}.xlsx`);
const SESSION = "d04e2784-9897-4b0b-9413-6d40501b2967";
const IDS = ["call_0gzs9Io5osZXggWETLx6Jj4R", "custom_call_HK1y7EkdiaSvA6HHSBi1Fzoy", "call_obcEmz3cCcckAy4xa57jZE5o"];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const lines = async (file: string): Promise<Array<Record<string, any>>> => (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const recorded = async (event: string) => lines(path.join(REC, "hook-payloads", `${event}.jsonl`));

describe("the live Copilot run", () => {
  it("three rows with real ids and reasons, the string-arguments call included, and the final answer as the closing claim", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-h009-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const folder = path.join(root, "folder");
    const sessions = path.join(root, "session-state");
    await mkdir(home);
    await mkdir(folder);
    await mkdir(path.join(sessions, SESSION), { recursive: true });
    await copyFile(probe(0), path.join(folder, "casebook.xlsx"));
    let clock = Date.UTC(2026, 9, 18, 12, 0, 0);
    const opts = { perSession: false, host: "copilot" as const, home, claimed: workbookClaims, folder, now: () => (clock += 1000), codexSessions: sessions };
    const send = (event: string, payload: Record<string, unknown>) => handleEvent(normalize("copilot", { ...payload, cwd: folder }, event), opts);
    const events = path.join(sessions, SESSION, "events.jsonl");
    const all = (await readFile(path.join(REC, "session-events.jsonl"), "utf8")).split("\n").filter(Boolean);
    const fileUpTo = async (nth: number, through = true) => {
      let seen = 0;
      const cutAt = all.findIndex((l) => /"type":"assistant\.message"/.test(l) && ++seen === nth);
      await writeFile(events, all.slice(0, cutAt + (through ? 1 : 0)).join("\n") + "\n");
    };
    const [prompt] = await recorded("userPromptSubmitted");
    const pres = await recorded("preToolUse");
    const posts = await recorded("postToolUse");
    const [stop] = await recorded("agentStop");
    await send("userPromptSubmitted", prompt);
    for (let i = 0; i < 3; i++) {
      // Live (timing.log): the apply_patch request was not yet in the file at its Pre (the last lines were the earlier call's result and the turn change); it was by its Post.
      await fileUpTo(i + 1, i !== 1);
      await send("preToolUse", pres[i]);
      await fileUpTo(i + 1);
      await copyFile(probe(i % 3), path.join(folder, "casebook.xlsx"));
      await send("postToolUse", posts[i]);
    }
    // Live: the final_answer line was not in the file when agentStop ran; it landed within milliseconds. Another process writes it, as the host does (a wait in this one blocks its timers).
    await fileUpTo(4, false);
    const full = all.slice(0, all.findIndex((l) => /"phase":"final_answer"/.test(l)) + 1).join("\n") + "\n";
    const writer = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").writeFileSync(process.argv[1], process.argv[2]), 150)`, events, full], { stdio: "ignore" });
    await send("agentStop", { ...stop, transcriptPath: events });
    writer.kill();
    const ledger = openLedger(home);
    const ops = ledger.allTaskIds().flatMap((t) => ledger.okOpsForTask(t, 0, ledger.maxOpId()).map((o) => JSON.parse(o.argsJson) as Record<string, any>));
    ledger.close();
    const calls = ops.filter((o) => o.tool_name === "bash" || o.tool_name === "apply_patch");
    assert.deepEqual(calls.map((o) => o.tool_use_id), IDS, "real ids, none synthetic");
    // order: the host's own reason, else the commentary as the row's fallback reason.
    assert.deepEqual(calls.map((o) => o.description || o.reasonFallback), ["Read data.csv", "I’ll write `totals.csv` with the summed values: `a=4` and `b=6`.", "Verify totals.csv"]);
    assert.equal(calls[1].narration.text, "I’ll write `totals.csv` with the summed values: `a=4` and `b=6`.");
    const closing = JSON.stringify(ops.filter((o) => !calls.includes(o)));
    assert.match(closing, /summed each column, and wrote the results to `totals.csv`/);
    assert.ok(!closing.includes("no narration recorded"));
  });
});
