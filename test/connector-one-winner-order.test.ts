// Clause 4: when two installed connectors match one subject exactly one wins, by the stated order, and the overlap is printed naming the losers.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorDoctor } from "../src/connector-doctor.ts";
import { runConnectorTest } from "../src/connector-test-cli.ts";
import { installedConnectorFor } from "../src/connector/before-snapshot.ts";
import { connectorClaimsFor, mcpConnectorMatches, overlapsOf, WINNER_ORDER, winnerFor } from "../src/connector/installed-match.ts";
const mcpConnectorFor = (home: string, server: string, tool: string): string | undefined => winnerFor(readInstalledManifests(home), { call: { server, tool } })?.id;
import { readInstalledManifests } from "../src/connector/installed-manifests.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function home(list: Array<{ dir: string; id: string; matches: Record<string, unknown> }>): string {
  const h = mkdtempSync(path.join(tmpdir(), "home-"));
  for (const c of list) {
    mkdirSync(path.join(h, "connectors", c.dir), { recursive: true });
    writeFileSync(path.join(h, "connectors", c.dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id: c.id, version: "1", entry: "state", matches: c.matches, run: ["node", "x.mjs"] }));
  }
  return h;
}

test("an MCP call: mcpTools beats a subject template beats mcpServers, whatever the folder order", () => {
  const h = home([
    { dir: "a-server", id: "a-server", matches: { mcpServers: ["notion"] } },
    { dir: "b-template", id: "b-template", matches: { mcpServers: ["other"], subjects: { mcp__notion__update_page: "notion://page/{id}" } } },
    { dir: "c-tool", id: "c-tool", matches: { mcpTools: ["mcp__notion__update_page"] } },
  ]);
  assert.equal(mcpConnectorFor(h, "notion", "update_page"), "c-tool");
  assert.equal(mcpConnectorFor(h, "notion", "other_tool"), "a-server");
  const noTool = home([{ dir: "a-server", id: "a-server", matches: { mcpServers: ["notion"] } }, { dir: "b-template", id: "b-template", matches: { mcpServers: ["x"], subjects: { mcp__notion__update_page: "notion://page/{id}" } } }]);
  assert.equal(mcpConnectorFor(noTool, "notion", "update_page"), "b-template");
  assert.equal(mcpConnectorMatches(h, "notion", "anything"), true);
  assert.equal(mcpConnectorMatches(h, "nobody", "anything"), false);
});

test("a tie inside one rank goes to the first folder by name", () => {
  const h = home([{ dir: "zz", id: "zz", matches: { mcpServers: ["s"] } }, { dir: "aa", id: "aa", matches: { mcpServers: ["s"] } }]);
  assert.equal(mcpConnectorFor(h, "s", "t"), "aa");
});

test("a URI subject: a template beats schemes; a file: the longest extension wins, a tie goes to the first folder", () => {
  const h = home([
    { dir: "a-scheme", id: "a-scheme", matches: { schemes: ["notion://"] } },
    { dir: "b-template", id: "b-template", matches: { mcpServers: ["n"], subjects: { mcp__n__t: "notion://page/{id}" } } },
    { dir: "c-json", id: "c-json", matches: { extensions: [".json"] } },
    { dir: "d-notes", id: "d-notes", matches: { extensions: [".notes.json"] } },
    { dir: "e-notes2", id: "e-notes2", matches: { extensions: [".notes.json"] } },
  ]);
  assert.equal(installedConnectorFor(h, "notion://page/1")?.manifest.id, "b-template");
  assert.equal(connectorClaimsFor(h)("/x/a.notes.json"), "d-notes");
  assert.equal(connectorClaimsFor(h)("/x/a.json"), "c-json");
});

test("overlaps name the winner and the losers, deterministically, with the stated order", () => {
  const h = home([
    { dir: "a-server", id: "a-server", matches: { mcpServers: ["notion"], extensions: [".json"] } },
    { dir: "b-tool", id: "b-tool", matches: { mcpTools: ["mcp__notion__update_page"], extensions: [".notes.json"] } },
    { dir: "c-alone", id: "c-alone", matches: { extensions: [".zzz"] } },
  ]);
  const o = overlapsOf(readInstalledManifests(h));
  assert.deepEqual(o.map((x) => [x.key, x.winner, x.losers]), [
    ["extension .notes.json", "b-tool", ["a-server"]],
    ["mcp__notion__update_page", "b-tool", ["a-server"]],
  ]);
  assert.deepEqual(overlapsOf(readInstalledManifests(h)), o);
  assert.match(WINNER_ORDER, /mcpTools, then subject template, then mcpServers, then schemes/);
});

test("`cocheck connector doctor` prints the overlap warning naming the losers", async () => {
  const h = home([{ dir: "a", id: "a", matches: { mcpServers: ["s"] } }, { dir: "b", id: "b", matches: { mcpServers: ["s"] } }]);
  const r = await runConnectorDoctor([], { home: h, store: { get: () => null } });
  assert.match(r.stdout, /warning: server s is claimed by more than one connector: "a" wins; not used for it: "b" \(order: mcpTools, then subject template/);
  const none = home([{ dir: "a", id: "a", matches: { mcpServers: ["s"] } }, { dir: "b", id: "b", matches: { mcpServers: ["t"] } }]);
  assert.doesNotMatch((await runConnectorDoctor([], { home: none, store: { get: () => null } })).stdout, /warning/);
});

test("`cocheck connector test` prints the overlap of the connector under test with an installed one", async () => {
  const h = home([{ dir: "a-installed", id: "a-installed", matches: { extensions: [".level1.notes.json"] } }]);
  const dir = mkdtempSync(path.join(tmpdir(), "z-"));
  cpSync(path.join(ROOT, "public-kit/examples/toy-level-1"), dir, { recursive: true });
  const r = await runConnectorTest([dir], { home: h });
  assert.equal(r.exitCode, 0, r.stdout);
  assert.match(r.stdout, /warning: extension \.level1\.notes\.json is claimed by more than one connector: "a-installed" wins; not used for it: "toy-level-1"/);
  const clean = await runConnectorTest([dir], { home: home([]) });
  assert.doesNotMatch(clean.stdout, /warning/);
});
