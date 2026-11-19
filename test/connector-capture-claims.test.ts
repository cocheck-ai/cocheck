import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectorClaimsFor } from "../src/connector/installed-match.ts";
import { coreDraws, ENABLED_TYPES_FILE, readEnabledTypes, stateOf } from "../src/connector/enabled-types.ts";
import { claimantsOf } from "../src/connector-types-cli.ts";
import { PRODUCTION_BUILTIN_CONNECTORS, builtinTypesOf } from "../src/connector/builtins.ts";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { book, dumpLedger, makeRig, type Rig } from "./hook-corpus.ts";
import { workbookClaims } from "./helpers/claims.ts";

// Clause 1: a changed file whose name an installed valid manifest claims by extension (longest suffix) is recorded with file_states.connector =
// that connector's id when it is enabled for the type (a type CoCheck draws itself starts with no connector enabled, even when a manifest claims it).
const rigs: Rig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.cleanup(); });

const manifest = (id: string, extensions: string[]) => JSON.stringify({ spec: "cocheck.connector/1", id, version: "0.0.1", entry: "state", matches: { extensions }, run: ["node", "c.mjs"], credentials: [], platforms: ["darwin", "win32", "linux"] });
async function install(home: string, id: string, extensions: string[], valid = true) {
  const dir = path.join(home, "connectors", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cocheck-connector.json"), valid ? manifest(id, extensions) : "{ not json");
}

async function session(r: Rig, files: Record<string, string>): Promise<Array<{ file_path: string; connector: string | null }>> {
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(r.folder, name), body);
  let clock = 1_700_000_000_000;
  const opts = { host: "claude" as const, home: r.home, claimed: workbookClaims, folder: r.folder, now: () => (clock += 1000) };
  const base = { session_id: "session-1", cwd: r.folder, transcript_path: "/x/t.jsonl", permission_mode: "default" };
  const call = (event: string, extra: Record<string, unknown> = {}) => ({ ...base, hook_event_name: event, tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "python3 edit.py", description: "edit" }, ...extra });
  const send = (p: Record<string, unknown>) => handleHook(p as unknown as HookPayload, opts);
  await send({ ...base, hook_event_name: "UserPromptSubmit", prompt: "edit things" });
  await send(call("PreToolUse"));
  for (const name of Object.keys(files)) await writeFile(path.join(r.folder, name), name.endsWith(".xlsx") ? Buffer.from(book({ A1: 9 })) : `${files[name]} changed`);
  await send(call("PostToolUse", { tool_response: { stdout: "ok" } }));
  const rows = dumpLedger(r.home, r.folder).file_states as Array<{ file_path: string; connector: string | null; prev_sha256: string | null }>;
  return rows.map((x) => ({ file_path: path.basename(x.file_path.replace("<folder>", "")), connector: x.connector }));
}

describe("capture: file_states.connector", () => {
  it("a file a manifest claims by extension is recorded with that connector; the longest suffix wins; a type CoCheck draws itself is not taken by default", async () => {
    const r = await makeRig();
    rigs.push(r);
    await install(r.home, "wide", [".json", ".csv", ".xlsx"]);
    await install(r.home, "narrow", [".notes.json"]);
    const rows = await session(r, { "a.notes.json": "{}", "b.json": "{}", "c.csv": "x", "d.txt": "x", "model.xlsx": "" });
    const byName = new Map(rows.map((x) => [x.file_path, x.connector]));
    assert.equal(byName.get("a.notes.json"), "narrow", "longest suffix");
    assert.equal(byName.get("b.json"), "wide");
    assert.equal(byName.get("c.csv") ?? null, null, "csv is the files layer's, though a manifest claims it");
    assert.equal(byName.get("model.xlsx") ?? null, null, "xlsx is the xlsx layer's, though a manifest claims it");
    assert.equal(byName.get("d.txt") ?? null, null, "no manifest claims it");
  });

  it("an invalid manifest and no manifest claim nothing", async () => {
    const r = await makeRig();
    rigs.push(r);
    await install(r.home, "broken", [".notes.json"], false);
    const rows = await session(r, { "a.notes.json": "{}" });
    const mine = rows.filter((x) => x.file_path === "a.notes.json");
    assert.ok(mine.length > 0 && mine.every((x) => x.connector === null));
  });

  it("connectorClaimsFor: claims by name, case-insensitively, and not a type CoCheck draws itself unless enabled", async () => {
    const r = await makeRig();
    rigs.push(r);
    await install(r.home, "wide", [".json", ".PDF", ".md"]);
    const claim = connectorClaimsFor(r.home);
    assert.equal(claim("/x/A.JSON"), "wide");
    assert.equal(claim("/x/a.pdf"), undefined);
    assert.equal(claim("/x/a.md"), undefined);
    assert.equal(connectorClaimsFor(undefined)("/x/a.json"), undefined);
  });

  it("every type the shipped manifests claim is served by default: an enabled connector's claim or a type CoCheck draws itself; the setting moves it", async () => {
    const r = await makeRig();
    rigs.push(r);
    // The expected set: the types the shipped manifests claim (matches.extensions, read from the manifest files), plus .pdf and .md that core draws.
    const types = [...new Set([...builtinTypesOf(PRODUCTION_BUILTIN_CONNECTORS), ".pdf", ".md"])];
    assert.ok(types.length > 2, "the shipped manifests claim types");
    await install(r.home, "wide", types);
    for (const e of types) {
      const s = stateOf(e, claimantsOf(r.home), readEnabledTypes(r.home));
      assert.ok(s.enabled !== undefined || coreDraws(e), e);
      assert.equal(connectorClaimsFor(r.home)(`/x/a${e}`), s.enabled, e);
    }
    // With the setting, the manifests' claims decide: "wide" enabled for .pdf takes .pdf files, and a type nothing draws goes to the one that claims it.
    await writeFile(path.join(r.home, ENABLED_TYPES_FILE), JSON.stringify({ types: { ".pdf": "wide" } }));
    assert.equal(connectorClaimsFor(r.home)("/x/a.pdf"), "wide");
    assert.equal(connectorClaimsFor(r.home)("/x/a.md"), undefined);
    await install(r.home, "other", [".zzz"]);
    assert.equal(connectorClaimsFor(r.home)("/x/a.zzz"), "other", "a manifest claim on a type nothing serves is enabled by default");
    await writeFile(path.join(r.home, ENABLED_TYPES_FILE), JSON.stringify({ types: { ".zzz": null } }));
    assert.equal(connectorClaimsFor(r.home)("/x/a.zzz"), undefined, "the setting turns it off");
  });
});
