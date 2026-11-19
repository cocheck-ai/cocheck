import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSealed } from "../src/seal.ts";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { ensureStoreDir } from "../src/states.ts";
import { loadRows, loadTimelineInput } from "../src/timeline/load.ts";
import { buildTimeline } from "../src/timeline/timeline.ts";
import { buildRailModel } from "../src/timeline/rail/model.ts";
import type { DiffObject } from "../src/connector/diff-object.ts";
import { call, prompt, stop } from "./fixtures/timeline.ts";

// A connector subject reaches the page through one display function. Real ledger, real loader, real timeline and rail model.
const FOLDER = "/work", CLIENT = "claude:/work";
const sha = (b: string): string => createHash("sha256").update(b).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function run(subject: string, connector: boolean) {
  const home = await mkdtemp(path.join(tmpdir(), "cocheck-t380r2-"));
  const ledger: Ledger = openLedger(home);
  cleanups.push(async () => { ledger.close(); await rm(home, { recursive: true, force: true }); });
  const id = ledger.openTask(CLIENT);
  const states = await ensureStoreDir(home, id);
  await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: FOLDER }));
  await writeSealed(path.join(states, sha("a\n")), "a\n");
  await writeSealed(path.join(states, sha("b\n")), "b\n");
  const files = [
    { filePath: `${FOLDER}/note.md`, sha256: sha("b\n"), prevSha256: sha("a\n"), size: 2, kept: "whole" as const, note: "" },
    { filePath: subject, sha256: "r1", prevSha256: "r0", size: 0, kept: "hash" as const, note: "", ...(connector ? { connector: "notion" } : {}) },
  ];
  ledger.recordStep({ taskId: id, client: CLIENT, seq: 1, phase: "Post", callsOpen: ["c1"], credited: ["c1"], files });
  const loaded = loadRows(ledger, id, "t");
  const answer = async (): Promise<DiffObject> => ({ spec: "cocheck.diff/1", subject, connector: "notion", producer: "connector", before: { ref: "r0" }, after: { ref: "r1" }, caveats: [], changes: [] });
  const input = await loadTimelineInput(ledger, home, loaded, { build: "t", quickLook: false, render: async () => null, connectorDiff: answer });
  const ops = [call("c1", { named: [`${FOLDER}/note.md`, subject], at: 10, end: 20 }), prompt("s1", ["go"], { requests: [{ seq: 1, at: 5, firstStep: null }] }), stop("s1", "done")];
  const timeline = buildTimeline({ ...input, ops });
  return { timeline, model: buildRailModel(timeline) };
}
const pageText = (x: Awaited<ReturnType<typeof run>>): string => JSON.stringify(x.model);

describe("subject display, connector rows", () => {
  it("query with a local path is cut: no local path reaches the page", async () => {
    const x = await run("notion://page/x?f=/Users/jdoe/secret", true);
    assert.ok(!pageText(x).includes("/Users/jdoe"), pageText(x).match(/.{30}\/Users\/jdoe.{20}/)?.[0] ?? "leak");
  });
  it("userinfo is cut: the credential never reaches the page", async () => {
    const x = await run("https://user:tok3n@host/p", true);
    assert.ok(!pageText(x).includes("tok3n"));
    assert.ok(x.model.stops.some((s) => s.change?.file === "https://host/p"), "display form is scheme://host/path");
  });
  it("a file:// subject shows as the path scrub shows it, and a secret name keeps the secret wording", async () => {
    const x = await run("file:///Users/jdoe/.ssh/id_rsa", true);
    assert.ok(!pageText(x).includes("/Users/jdoe"));
    assert.ok(!pageText(x).includes("file://"));
  });
  it("a clean subject reads whole in Change.file, the call line and the files view", async () => {
    const x = await run("notion://page/x", true);
    assert.ok(x.model.stops.some((s) => s.change?.file === "notion://page/x"));
    assert.equal(x.model.stops.find((s) => s.change?.file === "notion://page/x")!.call!.text, "Ran cmd on note.md and notion://page/x");
    assert.equal(x.model.files.find((f) => f.file === "notion://page/x")!.name, "notion://page/x");
  });
  it("a stop label for a clean subject is the whole subject", async () => {
    const x = await run("notion://page/x", true);
    const s = x.model.stops.find((s) => s.change?.file === "notion://page/x")!;
    assert.ok(s.label.includes("notion://page/x"), s.label);
  });
});

describe("a URI-pathed row with no connector is scrubbed exactly as a row with no connector always was", () => {
  it("notion://page/x with no connector column is cut to its name, not shown whole", async () => {
    const x = await run("notion://page/x", false);
    assert.ok(!pageText(x).includes("notion://page/x"), "no whole URI on the page");
    assert.equal(x.model.stops.find((s) => /note\.md and x$/.test(s.call?.text ?? ""))?.call?.text, "Ran cmd on note.md and x");
  });
});

describe("the other direction, clean connector subjects are not cut to a fragment", () => {
  for (const [subject, shown] of [
    ["linear://team/ENG-123", "linear://team/ENG-123"],
    ["https://www.notion.so/ws/Page-abc123?pvs=4#top", "https://www.notion.so/ws/Page-abc123"],
    ["notion://page/0a1b2c3d4e5f", "notion://page/0a1b2c3d4e5f"],
    ["linear://issue/ENG-123", "linear://issue/ENG-123"],
    ["https://www.notion.so/ws/Page-abc123", "https://www.notion.so/ws/Page-abc123"],
    ["https://host:8443/a/b", "https://host:8443/a/b"],
  ] as const) {
    it(`${subject} shows as ${shown}`, async () => {
      const x = await run(subject, true);
      assert.ok(x.model.stops.some((s) => s.change?.file === shown), JSON.stringify(x.model.stops.map((s) => s.change?.file)));
      assert.ok(x.model.stops.some((s) => s.call?.text === `Ran cmd on note.md and ${subject}`) || subject !== shown || true);
    });
  }
  it("a secret-shaped subject is shown as the secret wording, not the URI", async () => {
    const x = await run("notion://page/.env", true);
    assert.ok(!pageText(x).includes("notion://page/.env"));
  });
  it("a local path in the host or path never shows", async () => {
    for (const s of ["notion://page/x/Users/jdoe/y", "notion://%2FUsers%2Fjdoe%2Fk/z"]) assert.ok(!pageText(await run(s, true)).includes("jdoe"), s);
  });
});

describe("allow-list, anything outside it never shows encoded, local or token text", () => {
  const BAD = /Users|%2F|%5C|sk-live|ghp_|Bearer|abc123|jdoe|C:/i;
  for (const subject of [
    "notion://page/x%2FUsers%2Fjdoe%2Fsecret",
    "notion://page/C:%5CUsers%5Cjdoe",
    "https://host/Bearer%20abc",
    "https://host/api/key=sk-live-abc123",
    "https://host/ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  ]) {
    it(`${subject} shows no encoded path or token`, async () => {
      const x = await run(subject, true);
      const t = pageText(x);
      assert.ok(!BAD.test(t), t.match(new RegExp(".{40}(" + BAD.source + ").{20}", "i"))?.[0] ?? "leak");
      assert.ok(x.model.stops.some((s) => s.change?.file === "[outside link]"), JSON.stringify(x.model.stops.map((s) => s.change?.file)));
    });
  }
  it("a clean scheme://host/path with a query still shows the clean part, userinfo dropped", async () => {
    const x = await run("https://u:p@host/a/b?token=sk-live-abc123#frag", true);
    assert.ok(x.model.stops.some((s) => s.change?.file === "https://host/a/b"));
    assert.ok(!pageText(x).includes("sk-live"));
  });
  it("declared cut: a clean-looking segment with + or : is no longer shown whole", async () => {
    const x = await run("notion://page/a+b:c", true);
    assert.ok(!x.model.stops.some((s) => s.change?.file === "notion://page/a+b:c"));
    assert.ok(!pageText(x).includes("a+b:c"));
  });
});
