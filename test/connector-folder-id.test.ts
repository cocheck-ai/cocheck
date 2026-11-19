// A connector's manifest id must equal its folder name (connectors/<id>/). A planted folder copying a real connector's id is skipped, so
// it neither wins the match nor gets that connector's credential (the credential service is `cocheck-connector:${manifest.id}`).
// Must not happen: a planted folder taking a real connector's credential (versus skipping a legitimate one: a folder that matches its id is kept).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readInstalledManifests } from "../src/connector/installed-manifests.ts";
import { askConnector, createConnectorPool, installedConnectorFor } from "../src/connector/before-snapshot.ts";
import { runConnectorDoctor } from "../src/connector-doctor.ts";

// The shape of the real installed connector (copied from cocheck-connectors/nb-diff/cocheck-connector.json).
const REAL = { spec: "cocheck.connector/1", id: "ipynb-cells", version: "0.1.0", entry: "state", matches: { extensions: [".ipynb"] }, run: ["node", "connector.mjs"] };
function put(home: string, dir: string, m: unknown): void {
  mkdirSync(path.join(home, "connectors", dir), { recursive: true });
  writeFileSync(path.join(home, "connectors", dir, "cocheck-connector.json"), JSON.stringify(m));
}
/** The real installed connector: its manifest and entry file copied from cocheck-connectors/nb-diff. */
function putReal(home: string): void {
  const src = path.join(import.meta.dirname, "fixtures", "connectors", "ipynb-cells-real");
  put(home, "ipynb-cells", REAL);
  copyFileSync(path.join(src, "connector.mjs"), path.join(home, "connectors", "ipynb-cells", "connector.mjs"));
}
const tmp = (): string => mkdtempSync(path.join(tmpdir(), "cocheck-"));

describe("manifest id must match its folder", () => {
  it("skips a manifest whose id differs from its folder, with an onSkip message naming both", () => {
    const home = tmp();
    put(home, "aaa-planted", REAL);
    const skips: string[] = [];
    assert.deepEqual(readInstalledManifests(home, { onSkip: (_f, why) => skips.push(why) }), []);
    assert.equal(skips.length, 1);
    assert.match(skips[0]!, /aaa-planted/);
    assert.match(skips[0]!, /ipynb-cells/);
  });

  it("must not: a planted folder copying a real id does not win the match (it sorts first) and the real one is kept", () => {
    const home = tmp();
    put(home, "aaa-planted", REAL);
    put(home, "ipynb-cells", REAL);
    assert.equal(installedConnectorFor(home, "/work/a.ipynb")?.dir, "ipynb-cells");
  });

  it("must not: with only the planted folder, no connector is chosen and no credential is read (404 before any start)", async () => {
    const home = tmp();
    put(home, "aaa-planted", { ...REAL, credentials: [{ name: "token" }] });
    assert.equal(installedConnectorFor(home, "/work/a.ipynb"), undefined);
    await assert.rejects(
      askConnector({ home, pool: createConnectorPool(), subject: "/work/a.ipynb", budgetMs: 1000, method: "state", params: {} } as never),
      (e: { status?: number }) => e.status === 404,
    );
  });

  it("a legitimate folder whose id matches is kept (the real shape)", () => {
    const home = tmp();
    put(home, "ipynb-cells", REAL);
    assert.deepEqual(readInstalledManifests(home).map((m) => m.manifest.id), ["ipynb-cells"]);
  });

  it("doctor lists ipynb-cells ok, and the planted folder as a problem with a plain reason", async () => {
    const home = tmp();
    putReal(home);
    put(home, "aaa-planted", REAL);
    const r = await runConnectorDoctor([], { home } as never);
    assert.match(r.stdout, /aaa-planted/);
    assert.match(r.stdout, /does not match its folder name/);
    assert.equal(r.exitCode, 1);
    const ok = await runConnectorDoctor(["ipynb-cells"], { home } as never);
    assert.match(ok.stdout, /ipynb-cells/);
    assert.equal(ok.exitCode, 0, ok.stdout);
  });
});
