// ONE function decides the winning installed connector, and the hook and snapshot path, the page and the overlap warning all use it.
// Must not happen: the page or the warning names one connector while another captures. Structural rule: with one matching connector every path picks it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { installedConnectorFor } from "../src/connector/before-snapshot.ts";
import { overlapsOf, overlapWarning, winnerFor } from "../src/connector/installed-match.ts";
import { readInstalledManifests } from "../src/connector/installed-manifests.ts";
const mcpConnectorFor = (home: string, server: string, tool: string): string | undefined => winnerFor(readInstalledManifests(home), { call: { server, tool } })?.id;
import { makeRig, type Rig } from "./hook-corpus.ts";
import { runHookTracked as runHook } from "./helpers/track.ts";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

const TOOL = "mcp__notion__update_page";
type Spec = Array<{ dir: string; id: string; matches: Record<string, unknown> }>;
function install(h: string, list: Spec): void {
  for (const c of list) {
    mkdirSync(path.join(h, "connectors", c.dir), { recursive: true });
    writeFileSync(path.join(h, "connectors", c.dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: c.id, version: "1", entry: "state", matches: c.matches, run: ["node", "x.mjs"] }));
  }
}

/** Runs the real pre-call hook for TOOL and returns what it asked the review process for (the hook path's request). */
async function hookRequest(list: Spec): Promise<{ home: string; request: { subject: string; tool?: string } }> {
  const r = await makeRig();
  rigs.push(r);
  install(r.home, list);
  const requests: any[] = [];
  await runHook({
    argv: ["node", "hook.ts", "--host", "claude", "--folder", r.folder],
    env: { COCHECK_HOME: r.home },
    stdin: (async function* () {
      yield Buffer.from(JSON.stringify({ session_id: "7c1f0a52-4b7e-4f06-9a53-1d2f6c0e9b11", cwd: r.folder, transcript_path: "/x/claude.jsonl", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: TOOL, tool_use_id: "toolu_1", tool_input: { id: "2f6c0e9b11a14b7e9a531d2f6c0e9b11" } }));
    })(),
    localProcess: { request: (req: unknown) => { requests.push(req); return Promise.resolve({ ref: "a".repeat(64) }); } },
  } as any);
  assert.equal(requests.length, 1);
  return { home: r.home, request: requests[0] };
}

const TEMPLATE_AND_TOOL: Spec = [
  { dir: "a-template", id: "a-template", matches: { mcpServers: ["other"], subjects: { [TOOL]: "notion://page/{id:hex}" } } },
  { dir: "b-tool", id: "b-tool", matches: { mcpTools: [TOOL], schemes: ["notion://"] } },
];

test("a subject-template connector and an mcpTools connector for one tool: the hook path, the page path and the warning name the same winner", async () => {
  const { home, request } = await hookRequest(TEMPLATE_AND_TOOL);
  const hookWinner = installedConnectorFor(home, request.subject, request.tool)?.manifest.id; // what the review process asks to capture
  const pageWinner = mcpConnectorFor(home, "notion", "update_page");
  const warning = overlapsOf(readInstalledManifests(home)).find((o) => o.key === TOOL);
  assert.equal(pageWinner, "b-tool");
  assert.equal(hookWinner, pageWinner);
  assert.equal(warning?.winner, pageWinner);
  assert.match(overlapWarning(warning!), /"b-tool" wins/);
});

test("the one function: winnerFor with a call ranks by the call, with only a subject by the subject", () => {
  const h = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  install(h, TEMPLATE_AND_TOOL);
  const installed = readInstalledManifests(h);
  assert.equal(winnerFor(installed, { subject: "notion://page/1", call: { server: "notion", tool: "update_page" } })?.id, "b-tool");
  assert.equal(winnerFor(installed, { subject: "notion://page/1" })?.id, "a-template"); // no call known: the subject template ranks first
});

// Structural rule: with one matching connector every path picks it.
const ONE: Array<[string, Record<string, unknown>]> = [
  ["mcpTools", { mcpTools: [TOOL], schemes: ["notion://"] }],
  ["subject template", { mcpServers: ["notion"], subjects: { [TOOL]: "notion://page/{id:hex}" } }],
  ["mcpServers", { mcpServers: ["notion"], schemes: ["notion://"] }],
  ["schemes", { schemes: ["notion://"] }],
];
for (const [kind, matches] of ONE) {
  test(`one connector matching by ${kind}: the hook path (with or without the tool), the page and the warnings pick it`, () => {
    const h = mkdtempSync(path.join(tmpdir(), "cocheck-"));
    install(h, [{ dir: "only", id: "only", matches }]);
    const subject = "notion://page/2f6c0e9b11a14b7e9a531d2f6c0e9b11";
    assert.equal(installedConnectorFor(h, subject)?.manifest.id, "only");
    assert.equal(installedConnectorFor(h, subject, TOOL)?.manifest.id, "only");
    if (kind !== "schemes") assert.equal(mcpConnectorFor(h, "notion", "update_page"), "only");
    assert.deepEqual(overlapsOf(readInstalledManifests(h)), []);
  });
}

test("one connector matching by extension: every path picks it", () => {
  const h = mkdtempSync(path.join(tmpdir(), "cocheck-"));
  install(h, [{ dir: "only", id: "only", matches: { extensions: [".notes.json"] } }]);
  assert.equal(installedConnectorFor(h, "/x/a.notes.json")?.manifest.id, "only");
  assert.equal(winnerFor(readInstalledManifests(h), { subject: "/x/a.notes.json" })?.id, "only");
});
