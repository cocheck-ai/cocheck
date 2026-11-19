// the three built-in Office connectors run on every OS and claim the macro and show endings.
// No test here launches or scripts an Office app: the Mac driver is the fake (test/helpers/office-fake.ts); a non-Mac OS is injected through the
// functions' own platform argument, never by changing process.platform.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PRODUCTION_BUILTIN_CONNECTORS } from "../src/connector/builtins.ts";
import { checkChanges } from "../src/connector/changes-v1.ts";
import { drawnLevel } from "../src/connector/doc-level.ts";
import { requireRun } from "../src/connector/run-argv.ts";
import { availableOn } from "../src/platform/index.ts";
import { OFFICE_APPS, type OfficeApp } from "../src/office/connector/apps.ts";
import { officeDeps } from "../src/office/connector/main.ts";
import { answerDiff, type ProgramDeps } from "../src/office/connector/program.ts";
import { fakeCropper, fakeDriver, fakePageReader, fakePager, FIXTURES } from "./helpers/office-fake.ts";

const ROOT = path.join(import.meta.dirname, "..");
const apps = Object.values(OFFICE_APPS);
const manifestOf = (id: string): Record<string, any> => JSON.parse(readFileSync(path.join(ROOT, "connectors", id, "cocheck-connector.json"), "utf8"));
/** What each built-in claimed on main c2ae3b1a. */
const BEFORE: Record<string, string[]> = { "microsoft-excel": [".xlsx"], "microsoft-word": [".docx"], "microsoft-powerpoint": [".pptx"] };
/** The fixture ending (and the fallback staging ending) of each app: its first claimed ending, written out so the tests do not lean on the code under test. */
const FX: Record<OfficeApp["key"], string> = { excel: ".xlsx", word: ".docx", powerpoint: ".pptx" };

describe("the manifests and the built-in list name every OS", () => {
  it("each manifest's run resolves for darwin and win32 to the same launcher", () => {
    for (const app of apps) {
      const m = manifestOf(app.id);
      for (const os of ["darwin", "win32"]) assert.deepEqual(requireRun(m.run, os), ["node", "connector.mjs"], `${app.id} ${os}`);
    }
  });
  it("requireRun still throws for an OS a manifest does not list", () => {
    assert.throws(() => requireRun(manifestOf("microsoft-word").run, "freebsd"), /no entry for freebsd/);
  });
  it("no manifest asks for a desktop session, and none limits its platforms to the Mac", () => {
    for (const app of apps) {
      const m = manifestOf(app.id);
      assert.equal(m.requires?.session, undefined, app.id);
      assert.deepEqual([...(m.platforms ?? ["darwin", "win32"])].sort(), ["darwin", "win32"], app.id);
    }
  });
  it("the production built-ins carry no platform limit, so each is available on win32 and darwin", () => {
    assert.equal(availableOn(undefined, "win32"), true);
    for (const b of PRODUCTION_BUILTIN_CONNECTORS) {
      assert.equal(b.platforms, undefined, b.id);
      for (const os of ["win32", "darwin"]) assert.equal(availableOn(b.platforms, os), true, `${b.id} ${os}`);
    }
  });
});

describe("with no Office driver (an OS with none built; Windows has one since, tested in office-win-driver.test.ts) the program answers a level-1 change list", () => {
  for (const os of ["freebsd"]) {
    it(`${os}: officeDeps makes no driver and no window helper, outside the test switch too`, () => {
      const deps = officeDeps({ CI: "1" }, os);
      assert.equal(deps.driver, undefined);
      assert.equal(deps.windows, undefined);
    });
    for (const app of apps) {
      it(`${os} ${app.id}: the change list, no pictures, drawn at level 1, no Mac-only words, no lock taken`, async () => {
        const deps: ProgramDeps = { ...officeDeps({ CI: "1", SSH_CONNECTION: "1 2 3 4" }, os), lockPath: path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "lock") };
        const doc = await answerDiff(app, path.join(FIXTURES, `v1${FX[app.key]}`), path.join(FIXTURES, `v2${FX[app.key]}`), deps);
        assert.ok(doc.changes.length > 0, JSON.stringify(doc));
        assert.equal(doc.pictures, undefined);
        assert.equal(doc.status, undefined);
        assert.equal(drawnLevel(doc, 3), 1);
        assert.deepEqual(checkChanges(doc, 1), [], JSON.stringify(checkChanges(doc, 1)));
        assert.ok(doc.caveats.length > 0, "a no-driver answer says why there are no pages");
        for (const c of doc.caveats) assert.doesNotMatch(c, /mac|apple|darwin/i, c);
        assert.equal(existsSync(deps.lockPath), false, "headless-safe: the Office lock is never taken");
      });
    }
  }
  it("win32: officeDeps makes the Windows driver, and building it starts no process", () => {
    const deps = officeDeps({ CI: "1" }, "win32");
    assert.notEqual(deps.driver, undefined);
    assert.equal(deps.noDriverWhy, undefined);
    assert.equal((deps.driver as unknown as { host: { pid: number | undefined } }).host.pid, undefined, "no PowerShell host started");
  });
  it("darwin: officeDeps still makes the Mac driver (the driver path is unchanged)", () => {
    const deps = officeDeps({}, "darwin");
    assert.notEqual(deps.driver, undefined);
  });
});

describe("the macro and show endings are claimed, exactly", () => {
  it("each manifest claims what its app stages, and the additions over main are exactly .xlsm, .pptm, .ppsx, .ppsm", () => {
    const added: string[] = [];
    for (const app of apps) {
      const claimed = manifestOf(app.id).matches.extensions as string[];
      assert.deepEqual(claimed, [...app.exts], app.id);
      assert.deepEqual(claimed.slice(0, BEFORE[app.id]!.length), BEFORE[app.id], `${app.id} keeps its old ending first`);
      added.push(...claimed.filter((e) => !BEFORE[app.id]!.includes(e)));
    }
    assert.deepEqual(added.sort(), [".ppsm", ".ppsx", ".pptm", ".xlsm"]);
  });
});

function setup() {
  const f = fakeDriver();
  const lockPath = path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "lock");
  const deps: ProgramDeps = { driver: f.driver, pager: fakePager, crop: fakeCropper, pages: fakePageReader, lockPath, pollMs: 5, goneWaitMs: 100, lockWaitMs: 200 };
  return { ...f, deps };
}
/** A pair of the fixture's two states under `name` (the engine sends both sides under the subject's base name, in separate folders). */
function pair(app: OfficeApp, name: string): [string, string] {
  const root = mkdtempSync(path.join(tmpdir(), "pair-"));
  return ([1, 2] as const).map((v) => {
    const dir = path.join(root, v === 1 ? "before" : "after");
    mkdirSync(dir);
    copyFileSync(path.join(FIXTURES, `v${v}${FX[app.key]}`), path.join(dir, name));
    return path.join(dir, name);
  }) as [string, string];
}
const exportOf = (app: OfficeApp): string => (app.key === "excel" ? "exportTargets" : "exportPdf");
const stagedNames = (app: OfficeApp, calls: Array<{ method: string; args: unknown[] }>): string[] => calls.filter((c) => c.method === exportOf(app)).map((c) => path.basename(String(c.args[1])));

describe("each side is staged under the file's own ending (a wrong staging name makes the app refuse a good file)", () => {
  const cases: Array<[OfficeApp, string]> = [
    [OFFICE_APPS.excel, "Budget.xlsm"], [OFFICE_APPS.excel, "Budget.xlsx"],
    [OFFICE_APPS.powerpoint, "Talk.ppsx"], [OFFICE_APPS.powerpoint, "Talk.pptm"], [OFFICE_APPS.powerpoint, "Talk.ppsm"], [OFFICE_APPS.powerpoint, "Talk.pptx"],
    [OFFICE_APPS.word, "Memo.docx"],
  ];
  for (const [app, name] of cases) {
    it(`${app.id}: ${name} is staged as ${name} on both sides, and drawn`, async () => {
      const s = setup();
      const [b, a] = pair(app, name);
      const doc = await answerDiff(app, b, a, s.deps);
      assert.deepEqual(stagedNames(app, s.calls), [name, name]);
      assert.ok((doc.pictures ?? []).length > 0, JSON.stringify(doc.caveats));
    });
  }
  it("an uppercase claimed ending keeps the file's own name", async () => {
    const s = setup();
    const [b, a] = pair(OFFICE_APPS.powerpoint, "TALK.PPSX");
    await answerDiff(OFFICE_APPS.powerpoint, b, a, s.deps);
    assert.deepEqual(stagedNames(OFFICE_APPS.powerpoint, s.calls), ["TALK.PPSX", "TALK.PPSX"]);
  });
  it("a name with no claimed ending is staged under the app's first ending, as before", async () => {
    for (const app of apps) {
      const s = setup();
      const [b, a] = pair(app, "state");
      await answerDiff(app, b, a, s.deps);
      assert.deepEqual(stagedNames(app, s.calls), [`before${FX[app.key]}`, `after${FX[app.key]}`], app.id);
    }
  });
  it("an ending another app claims is not taken as this app's own (a .ppsx sent to Excel is staged as .xlsx)", async () => {
    const s = setup();
    const [b, a] = pair(OFFICE_APPS.excel, "x.ppsx");
    await answerDiff(OFFICE_APPS.excel, b, a, s.deps);
    assert.deepEqual(stagedNames(OFFICE_APPS.excel, s.calls), ["before.xlsx", "after.xlsx"]);
  });
});
