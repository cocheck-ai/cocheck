// Core draws no view of any kind for a claimed state, whatever its bytes are. A file whose name a known connector claims
// but whose bytes are plain text (a broken or agent-faked .xlsx, or an outside connector's .foo) got the text tier's lines through textRenderer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { createRegistry } from "../src/connector/registry.ts";
import { openLedger, type Ledger } from "../src/ledger.ts";
import { writeSealed } from "../src/seal.ts";
import { ensureStoreDir } from "../src/states.ts";
import { loadTimeline } from "../src/timeline/load.ts";
import { rendererFor } from "../src/timeline/render/registry.ts";
import type { ChangeInfo } from "../src/timeline/render/types.ts";
import { encodePng } from "./fixtures/png-encode.ts";

const CLIENT = "claude-hook:/work";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
afterEach(() => setBuiltinConnectorsForTest(undefined));

const TOY = `process.stdin.resume();\n`;
async function connectorFolder(root: string, id: string, extensions: string[]): Promise<string> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id, version: "1.0.0", entry: "state", matches: { extensions }, run: ["node", "connector.mjs"] }));
  await writeFile(path.join(dir, "connector.mjs"), TOY);
  return dir;
}
async function claims(home: string): Promise<void> {
  const dir = await connectorFolder(await mkdtemp(path.join(tmpdir(), "builtin-")), "toy-office", [".xlsx", ".docx", ".pptx"]);
  setBuiltinConnectorsForTest([{ id: "toy-office", dir }]);
  await connectorFolder(path.join(home, "connectors"), "foo-reader", [".foo"]);
}

const NAMES = ["t.xlsx", "t.docx", "t.pptx", "t.foo"];
const textTier = { tier: "text", label: "Text, 1 line changed", text: { hunks: [{ beforeStart: 1, beforeLines: 1, afterStart: 1, afterLines: 1, lines: [{ op: "-", text: "secret-old" }, { op: "+", text: "secret-new" }] }] } };

describe("rendererFor draws no content for a claimed state", () => {
  for (const connector of [null, "toy-office"]) {
    it(`text-tier generic, row connector ${connector}: a card with no pane and no lines`, async () => {
      const home = await mkdtemp(path.join(tmpdir(), "reg-"));
      await claims(home);
      const reg = createRegistry({ home });
      // a connector row reaches the renderer as a generic marked claimed (the loader's mark); a claimed name needs no mark
      const generic = (connector === null ? textTier : { ...textTier, claimed: true }) as unknown as ChangeInfo["generic"];
      for (const name of [...NAMES, ...(connector === null ? [] : ["plain.txt"])]) {
        const v = await reg.rendererFor(`/x/${name}`, generic).view(Buffer.from("old\n"), Buffer.from("new\n"), { id: "c", file: `/x/${name}`, kind: "modified", generic });
        assert.equal(v.kind, "card", name);
        assert.deepEqual([v.before, v.after, v.boxes], [[], [], []], name);
        assert.ok(v.caveats.length > 0 && v.caveats.every((c) => !/office|excel|word|powerpoint|workbook|deck|document/i.test(c)), `${name}: ${v.caveats}`);
        assert.ok(!JSON.stringify(v).includes("old") || v.caveats.join("").includes("old") === false);
      }
    });
  }
  it("the module-level rendererFor takes the home, so an outside connector's ending is a card too", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "reg2-"));
    await claims(home);
    for (const name of NAMES) assert.equal((await rendererFor(`/x/${name}`, textTier as never, home).view(Buffer.from("a"), Buffer.from("b"), { id: "c", file: name, kind: "modified" })).kind, "card", name);
  });
  it("the other direction: .txt keeps the text view and .png its picture", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "reg3-"));
    await claims(home);
    const reg = createRegistry({ home });
    const t = await reg.rendererFor("/x/n.txt", textTier as never).view(Buffer.from("secret-old\n"), Buffer.from("secret-new\n"), { id: "c", file: "n.txt", kind: "modified", generic: textTier as never });
    assert.notEqual(t.kind, "card");
    const pic = { tier: "picture", picture: { before: "b", after: "a", width: 10, height: 10, regions: [] } } as never;
    assert.equal((await reg.rendererFor("/x/p.png", pic).view(null, null, { id: "c", file: "p.png", kind: "modified", generic: pic })).kind, "pages");
  });
});

describe("the loader's text path (generic and change rows) for claimed text-bytes files", () => {
  async function plant(ledger: Ledger, home: string, files: Array<{ name: string; connector?: string; before: Buffer; after: Buffer }>): Promise<number> {
    const id = ledger.openTask(CLIENT);
    const states = await ensureStoreDir(home, id);
    await writeFile(path.join(home, "tasks", String(id), "folder.json"), JSON.stringify({ dir: "/work" }));
    const rows = [];
    for (const f of files) {
      for (const x of [f.before, f.after]) await writeSealed(path.join(states, sha(x)), x);
      rows.push({ filePath: `/work/${f.name}`, sha256: sha(f.after), prevSha256: sha(f.before), size: f.after.length, kept: "whole" as const, note: "", ...(f.connector ? { connector: f.connector } : {}) });
    }
    ledger.recordStep({ taskId: id, client: CLIENT, seq: 1, phase: "Post", callsOpen: [], credited: [], files: rows });
    return id;
  }
  it("tier is never text and no line row exists for a claimed name or a row with a connector; .txt and .png still draw", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "load-"));
    await claims(home);
    const ledger = openLedger(home);
    const T = (s: string): Buffer => Buffer.from(`${s}\n`);
    const png = (v: number): Buffer => encodePng({ width: 40, height: 40, colorType: 6, raw: Buffer.alloc(40 * 40 * 4, v) });
    const files = [
      ...NAMES.flatMap((n) => [{ name: n, before: T(`${n} secret-old`), after: T(`${n} secret-new`) }, { name: `r-${n}`, connector: n === "t.foo" ? "foo-reader" : "toy-office", before: T(`r${n} secret-old`), after: T(`r${n} secret-new`) }]),
      { name: "shared.txt", before: T("t.xlsx secret-old"), after: T("shared secret-new") },
      { name: "plain.txt", before: T("plain old"), after: T("plain new") },
      { name: "pic.png", before: png(10), after: png(200) },
    ];
    const id = await plant(ledger, home, files);
    const render = async (_file: string, out: string): Promise<string | null> => { const p = path.join(out, "ql.png"); await writeFile(p, png(50)); return p; };
    // the picture is drawn in the background: load again until the picture is no longer pending
    let timeline = (await loadTimeline(ledger, home, id, { build: "t", quickLook: true, render })).timeline;
    for (let i = 0; i < 40; i++) {
      const all = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))] as unknown as Array<{ file: string; generic: { pending?: true } }>;
      if (all.find((x) => x.file === "pic.png")?.generic.pending !== true) break;
      await new Promise((r) => setTimeout(r, 100));
      timeline = (await loadTimeline(ledger, home, id, { build: "t", quickLook: true, render })).timeline;
    }
    ledger.close();
    const cs = [...timeline.unplaced, ...timeline.requests.flatMap((q) => q.runs.flatMap((r) => r.calls.flatMap((c) => c.changes)))] as unknown as Array<{ file: string; generic: { tier: string; claimed?: true; text?: unknown }; format?: { rows: Array<{ kind: string; text: string; before: string | null; after: string | null }> } | null }>;
    const names = [...NAMES, ...NAMES.map((n) => `r-${n}`)];
    for (const n of names) {
      const c = cs.find((x) => x.file === n)!;
      assert.ok(c, n);
      assert.notEqual(c.generic.tier, "text", n);
      assert.equal(c.generic.text, undefined, n);
      assert.equal(c.generic.claimed, true, n);
      if (c.format != null) for (const r of c.format.rows) assert.ok(!/secret/.test(`${r.text} ${r.before} ${r.after}`) && r.kind !== "line", `${n}: ${JSON.stringify(r)}`);
    }
    // bytes shared with a claimed state: blocked under every name (its before side is t.xlsx's before bytes)
    assert.notEqual(cs.find((x) => x.file === "shared.txt")!.generic.tier, "text");
    // the other direction
    assert.equal(cs.find((x) => x.file === "plain.txt")!.generic.tier, "text");
    const pg = cs.find((x) => x.file === "pic.png")!.generic as { tier: string; label?: string };
    assert.equal(pg.tier, "picture", pg.label ?? "");
  });
});
