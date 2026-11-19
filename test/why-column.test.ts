import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openLedger, type RecordReviewRowInput } from "../src/ledger.ts";
import { reviewModel } from "./helpers/legacy-review-model.ts";
import { renderReviewPage } from "./helpers/legacy-review-page.ts";

const CMD = "S=/private/tmp/claude-501/x/scratchpad && python3 $S/set_cell.py casebook.xlsx B17 0.21 && echo done";

type Op = NonNullable<RecordReviewRowInput["ops"]>[number];

/** One round with one explained row per op; returns the page's Why cell for each, in order. */
async function whyCells(ops: Op[], filePath = "/work/proj/casebook.xlsx"): Promise<string[]> {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-"));
  const ledger = openLedger(home);
  try {
    const taskId = ledger.openTask("claude");
    const rows: RecordReviewRowInput[] = ops.map((op, i) => ({
      filePath,
      layer: "xlsx",
      kind: "value",
      location: `Sheet1!B${i + 1}`,
      status: "explained",
      before: 1,
      after: 2,
      ops: [op],
      description: `B${i + 1} changed`,
      detail: {},
    }));
    ledger.recordRound({ taskId, seq: 1, intent: "go", clientName: "claude", final: true, lastOpId: 1, snapshots: [], rows });
    const html = renderReviewPage(reviewModel(ledger, taskId));
    return [...html.matchAll(/<td class="why">(.*?)<\/td><td class="state">/gs)].map((m) => m[1]!);
  } finally {
    ledger.close();
    await rm(home, { recursive: true, force: true });
  }
}

const visible = (cell: string) => cell.replace(/<details[\s\S]*?<\/details>/g, "").replace(/<[^>]+>/g, " ");
const hook = (intent: string, extra: Partial<Op> = {}): Op => ({ opId: 1, tool: "Bash", intent, client: "claude", callId: "toolu_1", closedBy: "post", ...extra }) as Op;

describe("the Why column shows the agent's words, not the command", () => {
  it("a stored 'command - description' intent shows the description, the command only behind show command", async () => {
    const [cell] = await whyCells([hook(`${CMD} - Step 3: set marginal tax rate and verify`)]);
    assert.match(visible(cell!), /Step 3: set marginal tax rate and verify/);
    for (const bad of ["&&", "$", "/private", "python3"]) assert.ok(!visible(cell!).includes(bad), `visible text leaks ${bad}`);
    assert.match(cell!, /<details[^>]*><summary[^>]*>show command<\/summary>/);
    assert.ok(cell!.includes("set_cell.py"), "the command is still available");
  });

  it("a recorded description wins, and a joint-attribution suffix does not leak or break it", async () => {
    const [cell] = await whyCells([hook(`${CMD} - Raise the rate [joint attribution: calls a, b overlapped]`, { description: "Raise the rate" } as Partial<Op>)]);
    assert.match(visible(cell!), /Raise the rate/);
    assert.ok(!visible(cell!).includes("joint"));
    assert.ok(!visible(cell!).includes("&&"));
  });

  it("no description: a plain label naming the tool and the file name, never the command or a path", async () => {
    for (const intent of [CMD, "python3 - <<'PY'\nimport openpyxl\nx = a - b\nPY", "ls -la", "Bash"]) {
      const [cell] = await whyCells([hook(intent)]);
      const v = visible(cell!);
      assert.match(v, /Bash call on casebook\.xlsx/, intent);
      for (const bad of ["&&", "$", "/work", "/private", "python", "openpyxl", "ls -la"]) assert.ok(!v.includes(bad), `${bad} leaked for ${JSON.stringify(intent)}`);
    }
  });

  it("an empty or whitespace description falls back to the label", async () => {
    for (const description of ["", "   ", " \n "]) {
      const [cell] = await whyCells([hook(`${CMD} - ${description}`, { description } as Partial<Op>)]);
      assert.match(visible(cell!), /Bash call on casebook\.xlsx/);
      assert.ok(!visible(cell!).includes("&&"));
    }
  });

  it("a description that is itself command-shaped is not shown", async () => {
    const [cell] = await whyCells([hook(`${CMD} - cd /tmp && rm x`, { description: "cd /tmp && rm x" } as Partial<Op>)]);
    assert.match(visible(cell!), /Bash call on casebook\.xlsx/);
    assert.ok(!visible(cell!).includes("&&"));
  });

  it("a stored intent whose tail looks like code is not split", async () => {
    const [cell] = await whyCells([hook("python3 -c 'print(1)' - x=$HOME/y")]);
    assert.match(visible(cell!), /Bash call on casebook\.xlsx/);
    assert.ok(!visible(cell!).includes("$"));
  });
});
