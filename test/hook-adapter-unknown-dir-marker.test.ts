import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLedger } from "../src/ledger.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { workbookClaims } from "./helpers/claims.ts";

// the tracker's stand-in for a directory it cannot resolve (`cd $SP/x`, `git -C "$d"`) is an internal value.
// In the replay it reached the review page as "/", a NUL byte and "cocheck-unknown-dir" on 6 of 22
// Claude-leg calls. Where it stood, the call must read "path unknown" and still count as outside-or-unknown.
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const fixture = async (name: string, over: Record<string, unknown>): Promise<HookPayload> =>
  ({ ...JSON.parse(await readFile(path.join(FIXTURES, "hooks", name), "utf8")), ...over }) as HookPayload;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

// The shapes the Claude leg produced: a directory built from a variable, then paths relative to it.
const COMMANDS: Record<string, string> = {
  toolu_UNZIP: `SP=/private/tmp/scratch; cd $SP/x && unzip -o -q ../casebook.backup.xlsx && grep -l "x14" xl/worksheets/*.xml`,
  toolu_CPBOOK: `cd "$SP/x" && cp ../casebook.backup.xlsx out/copy.xlsx`,
  toolu_GITC: `git -C "$REPO" status`,
};

async function run(outsideWatching: boolean) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-home-"));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "cocheck-folder-")));
  await copyFile(path.join(FIXTURES, "probe", "S0.xlsx"), path.join(folder, "casebook.xlsx"));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  const opts = { perSession: false, host: "claude" as const, home, claimed: workbookClaims, folder, outsideWatching };
  const send = (name: string, over: Record<string, unknown>) => fixture(name, { cwd: folder, ...over }).then((p) => handleHook(p, opts));
  for (const [id, command] of Object.entries(COMMANDS)) {
    const tool_input = { command, description: id };
    await send("claude-pre-bash.json", { tool_use_id: id, tool_input });
    await send("claude-post-bash.json", { tool_use_id: id, tool_input });
  }
  const stopped = await send("claude-stop.json", {});
  assert.ok(stopped.summary, "Stop returned a round summary");
  const ledger = openLedger(home);
  try {
    const taskId = stopped.summary.taskId;
    const page = renderReviewPage(reviewModel(ledger, taskId));
    const ops = ledger.okOpsForTask(taskId, 0, ledger.maxOpId());
    const args = ops.map((o) => JSON.parse(o.argsJson) as Record<string, unknown>);
    const dump = ops.map((o) => `${o.argsJson}\n${o.intent}`).join("\n");
    const stateFiles: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(path.join(dir, e.name));
        else if (e.name === "state.json") stateFiles.push(await readFile(path.join(dir, e.name), "utf8"));
      }
    };
    await walk(path.join(home, "hooks"));
    return { page, dump, args, state: stateFiles.join("\n") };
  } finally {
    ledger.close();
  }
}

const clean = (label: string, text: string) => {
  assert.ok(!text.includes("\0"), `${label} holds a NUL byte`);
  assert.ok(!text.includes("\\u0000"), `${label} holds an escaped NUL byte`);
  assert.ok(!text.includes("cocheck-unknown-dir"), `${label} names the marker`);
};

describe("the unknown-directory marker is an internal value", () => {
  it("outside watching on: no NUL and no marker name on the page, in the ledger or in state; each call reads path unknown", async () => {
    const r = await run(true);
    clean("page", r.page);
    clean("ledger", r.dump);
    clean("state", r.state);
    for (const id of Object.keys(COMMANDS)) {
      const a = r.args.find((x) => x.tool_use_id === id);
      assert.ok(a, `${id} is in the ledger`);
      assert.equal(a.pathUnknown, true, `${id} still counts as unknown`);
    }
  });

  it("outside watching off: the count survives, no NUL or marker name anywhere", async () => {
    const r = await run(false);
    clean("page", r.page);
    clean("ledger", r.dump);
    clean("state", r.state);
    for (const id of ["toolu_UNZIP", "toolu_CPBOOK"]) {
      const a = r.args.find((x) => x.tool_use_id === id);
      assert.ok(a, `${id} is in the ledger`);
      assert.ok(typeof a.outsideCount === "number" && a.outsideCount > 0, `${id} still counts as outside (must not change)`);
    }
  });
});
