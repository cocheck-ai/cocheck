import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineInput } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import { isEncryptedToken, toolLabel } from "../src/tool-label.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";
import type { RawOp } from "../src/timeline/runs.ts";

// Codex 0.166.0 records a spawn_agent `message` as an encrypted token (op 380 of a live run), never text. The page must not show it as the
// agent's words. The token below is the real shape (Fernet: gAAAAA + base64url), cut short and altered.
const TOKEN = "gAAAAABq5_3NUG0wSgKuMUeiMpzd-EJbo7QvRrNzPYhcB8EL_8b12MzGEspP-jPxPBxiD5cr02TI2Zx_vK1welX5XfxLSRvQ0T1uqH4JU_JD4jBeAkxctldmHAMqiZZ9yQ0_kLw8hT3sXc1vNn5pP7rA2dE4fG6hJ8kL0mQ";
const hooks = { text: (s: string) => s, path: (s: string) => s };

const c = (id: string, seq: number, extra: Record<string, unknown>) => call(id, { session: "s1", host: "codex", tool: "collaborationspawn_agent", desc: id, at: seq * 10, named: [], extra: { startSeq: seq, ...extra } });
const input = (ops: RawOp[]): TimelineInput => ({ taskId: 1, build: "t", ops, fileStates: [], folder: "/w", valuesExpiredAt: null, removals: [], stored: new Map(), formats: new Map(), quickLook: false } as unknown as TimelineInput);
const startOf = (fields: Record<string, string>, dropped?: Record<string, string>) => {
  const ops = [prompt("s1", ["Go."], { requests: [{ seq: 1, at: 10, firstStep: null }] }), c("A1", 2, { toolLabel: { fields, ...(dropped ? { dropped } : {}) } }), stop("s1", "done")];
  return buildRailModel(buildTimeline(input(ops))).stops.find((x) => x.id.startsWith("start-"))!;
};

describe("encrypted helper brief (Codex)", () => {
  it("detects the Fernet token and Codex's object shape, not a sentence or a plain word", () => {
    assert.equal(isEncryptedToken(TOKEN), true);
    assert.equal(isEncryptedToken({ type: "encrypted_content", encrypted_content: "x" }), true);
    assert.equal(isEncryptedToken(`Use ${TOKEN} as the key name in the config please`), false);
    assert.equal(isEncryptedToken("Write a ten line poem to t08/one.md."), false);
    assert.equal(isEncryptedToken("/Users/x/some/long/path/" + "a".repeat(150)), false);
  });
  it("the hook's label records no token (dropped, with the reason), for a string and for Codex's object", () => {
    for (const message of [TOKEN, { type: "encrypted_content", encrypted_content: TOKEN }]) {
      const l = toolLabel("spawn_agent", { task_name: "recipe", message }, hooks);
      assert.equal(l.fields.task_name, "recipe");
      assert.ok(!("message" in l.fields), JSON.stringify(l));
      assert.ok(!JSON.stringify(l).includes("gAAAAA"));
      assert.match(l.dropped!.message!, /encrypted/);
    }
  });
  it("an old record that still holds the token in fields is not shown either (the timeline layer)", () => {
    const s = startOf({ task_name: "recipe", message: TOKEN });
    assert.equal(s.brief!.encrypted, true);
    assert.deepEqual(s.brief!.lines, []);
    assert.ok(!JSON.stringify(s).includes("gAAAAA"));
  });
  it("a new record (dropped as encrypted) says encrypted, not 'no brief recorded'", () => {
    const s = startOf({ task_name: "recipe" }, { message: "encrypted by the host, not recorded" });
    assert.equal(s.brief!.encrypted, true);
  });
  it("the title reads naturally for a bare task name, and still 'to ...' for a sentence (Claude and Copilot titles unchanged)", () => {
    assert.equal(startOf({ task_name: "recipe", message: TOKEN }).head, "Started a helper: recipe");
    assert.match(startOf({ task_name: "build the deck", message: "do it" }).head, /^Started a helper to build the deck$/);
  });
  it("DANGEROUS DIRECTION: a plain brief, including one with a long token-like word inside a sentence, still shows", () => {
    const plain = `Write the recipe to t08/two.md and use ${TOKEN} as the label.`;
    const s = startOf({ task_name: "recipe", message: plain });
    assert.equal(s.brief!.encrypted, undefined);
    assert.deepEqual(s.brief!.lines, [plain]);
    const l = toolLabel("spawn_agent", { task_name: "recipe", message: plain }, hooks);
    assert.equal(l.fields.message, plain);
  });
});
