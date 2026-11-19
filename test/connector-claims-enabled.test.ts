// A connector's manifest declares the file types it claims (`matches.extensions`); CoCheck keeps, per type, which connector is
// enabled for it, in one setting file in the data folder (`connector-types.json`), written only by `cocheck connector enable|disable <id> <type>` and
// shown by `cocheck connector list`. Built-in and installed connectors follow the same rules. A type is already served when an enabled connector
// claims it or CoCheck draws it itself; a connector that is not the first to serve a type starts disabled for it until the user enables it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { PRODUCTION_BUILTIN_CONNECTORS, builtinClaims, setBuiltinConnectorsForTest } from "../src/connector/builtins.ts";
import { connectorClaimsFor } from "../src/connector/installed-match.ts";
import { CORE_DRAWN_TYPES, ENABLED_TYPES_FILE, readEnabledTypes } from "../src/connector/enabled-types.ts";
import { runConnectorList, runConnectorSwitch } from "../src/connector-types-cli.ts";

afterEach(() => setBuiltinConnectorsForTest(undefined));

const manifest = (id: string, extensions: string[]) => JSON.stringify({ spec: "cocheck.connector/1", id, version: "0.0.1", entry: "state", matches: { extensions }, run: ["node", "c.mjs"], credentials: [], platforms: ["darwin", "win32", "linux"] });
function folder(parent: string, id: string, extensions: string[]): string {
  const dir = path.join(parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "cocheck-connector.json"), manifest(id, extensions));
  return dir;
}
const scratch = (tag: string): string => mkdtempSync(path.join(tmpdir(), `${tag}-`));
/** A data folder with these installed connectors. */
function home(installed: Record<string, string[]>): string {
  const h = scratch("home");
  for (const [id, ext] of Object.entries(installed)) folder(path.join(h, "connectors"), id, ext);
  return h;
}
/** A toy built-in (registered by CoCheck's own code, as the production ones are) claiming `extensions`. */
function builtin(id: string, extensions: string[]): void {
  setBuiltinConnectorsForTest([{ id, dir: folder(scratch("builtin"), id, extensions) }]);
}
const claimOf = (h: string) => connectorClaimsFor(h, builtinClaims());
const enable = (h: string, id: string, type: string) => runConnectorSwitch(["enable", id, type], { home: h });
const disable = (h: string, id: string, type: string) => runConnectorSwitch(["disable", id, type], { home: h });

test("an installed connector claiming .docx is disabled for it by default, and wins once the user enables it", () => {
  builtin("toy-word", [".docx"]);
  const h = home({ "my-docx": [".docx"] });
  // Must not happen: installing it alone never moves the type; the reviewer keeps the built-in's view until the user chooses.
  assert.equal(claimOf(h)("/w/report.docx"), "toy-word");
  const r = enable(h, "my-docx", ".docx");
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(claimOf(h)("/w/report.docx"), "my-docx");
  assert.deepEqual(JSON.parse(readFileSync(path.join(h, ENABLED_TYPES_FILE), "utf8")), { types: { ".docx": "my-docx" } });
  // The user can always switch back.
  assert.equal(enable(h, "toy-word", ".docx").exitCode, 0);
  assert.equal(claimOf(h)("/w/report.docx"), "toy-word");
});

test("a disabled built-in leaves the type to the enabled one; with none enabled the type falls to CoCheck's own tiers", () => {
  builtin("toy-word", [".docx"]);
  const h = home({ "my-docx": [".docx"] });
  assert.equal(disable(h, "toy-word", ".docx").exitCode, 0);
  // No connector is enabled for .docx: core's generic tiers take the file (text, picture, fingerprint), and no connector id is written on its row.
  assert.equal(claimOf(h)("/w/report.docx"), undefined);
  assert.equal(enable(h, "my-docx", ".docx").exitCode, 0);
  assert.equal(claimOf(h)("/w/report.docx"), "my-docx");
  // Disabling the one that is not enabled changes nothing.
  assert.equal(disable(h, "toy-word", ".docx").exitCode, 0);
  assert.equal(claimOf(h)("/w/report.docx"), "my-docx");
});

test("must not: an installed connector never silently takes a type CoCheck draws itself, by exact ending or a longer one", () => {
  setBuiltinConnectorsForTest([]);
  const h = home({ grabber: [".xlsx", ".pdf", ".md", ".notes.md", ".CSV", ".png", ".txt"], free: [".notes.json"] });
  const claim = claimOf(h);
  for (const f of ["a.xlsx", "a.pdf", "a.md", "x.notes.md", "a.csv", "a.png", "a.txt", "A.PPTX"]) assert.equal(claim(f), undefined, f);
  // A type nothing serves goes to the connector that claims it, as before.
  assert.equal(claim("x.notes.json"), "free");
  // Enabled by the user, the same connector takes a core-drawn type.
  assert.equal(enable(h, "grabber", ".notes.md").exitCode, 0);
  assert.equal(claimOf(h)("x.notes.md"), "grabber");
  assert.equal(claimOf(h)("x.md"), undefined, "enabling .notes.md does not enable .md");
});

test("two installed connectors on a type nothing served: the first folder by name is enabled, the other waits", () => {
  setBuiltinConnectorsForTest([]);
  const h = home({ "b-notes": [".notes.json"], "a-notes": [".notes.json"], json: [".json"] });
  assert.equal(claimOf(h)("x.notes.json"), "a-notes");
  assert.equal(claimOf(h)("x.json"), "json");
  assert.equal(enable(h, "b-notes", ".notes.json").exitCode, 0);
  assert.equal(claimOf(h)("x.notes.json"), "b-notes");
  // A disabled longer ending leaves the file to the shorter enabled one.
  assert.equal(disable(h, "b-notes", ".notes.json").exitCode, 0);
  assert.equal(claimOf(h)("x.notes.json"), "json");
});

test("upgrade: with no setting file every production built-in serves the types it served on main 25220428, plus exactly .xlsm, .pptm, .ppsx, .ppsm on every OS", () => {
  setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
  const h = home({});
  const claim = claimOf(h);
  const main: Record<string, string | undefined> = {
    ".xlsx": "microsoft-excel", ".docx": "microsoft-word", ".pptx": "microsoft-powerpoint",
    ".xlsm": "microsoft-excel", ".pptm": "microsoft-powerpoint", ".ppsx": "microsoft-powerpoint", ".ppsm": "microsoft-powerpoint",
    // the allow-list is exact: other Office endings the connectors cannot be shown to read stay unclaimed
    ".docm": undefined, ".xls": undefined, ".xlsb": undefined, ".xltx": undefined, ".potx": undefined, ".ppt": undefined, ".doc": undefined,
    ".pdf": undefined, ".txt": undefined, ".md": undefined, ".csv": undefined, ".json": undefined,
  };
  for (const [ext, id] of Object.entries(main)) assert.equal(claim(`/w/a${ext}`), id, ext);
  assert.equal(claim("/w/A.XLSM"), "microsoft-excel");
  // An installed connector claiming the built-ins' types does not take them on upgrade either.
  folder(path.join(h, "connectors"), "other-office", [".xlsx", ".docx", ".pptx", ".xlsm"]);
  for (const [ext, id] of Object.entries(main)) assert.equal(claimOf(h)(`/w/a${ext}`), id, `${ext} beside an installed claimant`);
});

test("an unreadable or malformed setting file falls back to the default with a warning, never to nothing enabled", () => {
  builtin("toy-word", [".docx"]);
  const bad = ["{ not json", "[]", JSON.stringify({ types: { ".docx": 7 } }), JSON.stringify({ types: [] }), "null"];
  for (const text of bad) {
    const h = home({ "my-docx": [".docx"], free: [".notes.json"] });
    writeFileSync(path.join(h, ENABLED_TYPES_FILE), text);
    assert.equal(claimOf(h)("/w/a.docx"), "toy-word", text);
    assert.equal(claimOf(h)("/w/a.notes.json"), "free", text);
    assert.match(readEnabledTypes(h).warning ?? "", /could not be read|is not valid/, text);
    const list = runConnectorList([], { home: h });
    assert.match(list.stdout, /warning: .*connector-types\.json/, text);
    // The writer refuses to replace a file it cannot read, rather than lose the user's choices.
    assert.equal(enable(h, "my-docx", ".docx").exitCode, 1, text);
    assert.equal(readFileSync(path.join(h, ENABLED_TYPES_FILE), "utf8"), text);
  }
  // Unreadable: a folder where the file should be, and (where the OS enforces modes) a file with no read permission.
  const dirHome = home({ "my-docx": [".docx"] });
  mkdirSync(path.join(dirHome, ENABLED_TYPES_FILE));
  assert.equal(claimOf(dirHome)("/w/a.docx"), "toy-word");
  assert.match(readEnabledTypes(dirHome).warning ?? "", /could not be read/);
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const h = home({ "my-docx": [".docx"] });
    writeFileSync(path.join(h, ENABLED_TYPES_FILE), JSON.stringify({ types: { ".docx": "my-docx" } }));
    chmodSync(path.join(h, ENABLED_TYPES_FILE), 0o000);
    assert.equal(claimOf(h)("/w/a.docx"), "toy-word");
    chmodSync(path.join(h, ENABLED_TYPES_FILE), 0o600);
  }
  // Absent: the default, with no warning.
  assert.equal(readEnabledTypes(home({})).warning, undefined);
});

test("a setting naming a connector that no longer claims the type falls back to the default for that type", () => {
  builtin("toy-word", [".docx"]);
  const h = home({ "my-docx": [".docx"] });
  writeFileSync(path.join(h, ENABLED_TYPES_FILE), JSON.stringify({ types: { ".docx": "gone-docx" } }));
  assert.equal(claimOf(h)("/w/a.docx"), "toy-word");
});

test("enable and disable refuse a connector that does not claim the type, or that is not known", () => {
  builtin("toy-word", [".docx"]);
  const h = home({ "my-docx": [".docx"] });
  assert.equal(enable(h, "my-docx", ".xlsx").exitCode, 1);
  assert.equal(enable(h, "nobody", ".docx").exitCode, 1);
  assert.equal(disable(h, "nobody", ".docx").exitCode, 1);
  assert.equal(runConnectorSwitch(["enable", "my-docx"], { home: h }).exitCode, 1);
  // "docx" is read as ".docx" when the connector claims ".docx".
  assert.equal(enable(h, "my-docx", "docx").exitCode, 0);
  assert.equal(claimOf(h)("/w/a.docx"), "my-docx");
});

test("`cocheck connector list` shows per type the claimants, which one is enabled, and where CoCheck's own tiers would take it", () => {
  builtin("toy-word", [".docx"]);
  const h = home({ "my-docx": [".docx"], free: [".notes.json"] });
  const before = runConnectorList([], { home: h });
  assert.equal(before.exitCode, 0);
  assert.equal(before.stdout, [
    ".docx: claimed by toy-word (built-in), my-docx; enabled: toy-word (default); with none enabled: CoCheck reads it itself",
    ".notes.json: claimed by free; enabled: free (default); with none enabled: CoCheck's generic tiers (text, picture or fingerprint)",
    "",
  ].join("\n"));
  disable(h, "toy-word", ".docx");
  assert.match(runConnectorList([], { home: h }).stdout, /^\.docx: claimed by toy-word \(built-in\), my-docx; enabled: none \(set by you\); with none enabled: CoCheck reads it itself$/m);
  enable(h, "my-docx", ".docx");
  assert.match(runConnectorList([], { home: h }).stdout, /^\.docx: claimed by toy-word \(built-in\), my-docx; enabled: my-docx \(set by you\);/m);
});

test("CoCheck's own list of the types it draws holds the endings its readers name today", () => {
  for (const e of [".txt", ".md", ".csv", ".pdf", ".png", ".jpg"]) assert.ok(CORE_DRAWN_TYPES.includes(e), e);
});

test("with the production built-ins, an installed connector claiming .py starts enabled and one claiming .png starts disabled, and `cocheck connector list` run as the CLI says so", () => {
  setBuiltinConnectorsForTest(PRODUCTION_BUILTIN_CONNECTORS);
  // One case: one connector claiming code, text and CoCheck's own endings.
  const h = home({ "py-view": [".py"], "png-view": [".png"], evil: [".png", ".md", ".notes.md", ".docx", ".xlsx", ".xlsm", ".py", ".json", ".rtf", ".pdf", ".txt", ".csv", ".jpg", ".PNG"] });
  const claim = claimOf(h);
  // Code and other text endings CoCheck does not name go to a claiming connector by default (the first folder by name), as the spec now says.
  assert.equal(claim("/w/a.py"), "evil");
  assert.equal(claim("/w/a.json"), "evil");
  assert.equal(claim("/w/a.rtf"), "evil");
  // CoCheck's own endings stay with the built-ins or with core.
  assert.equal(claim("/w/a.docx"), "microsoft-word");
  assert.equal(claim("/w/a.xlsx"), "microsoft-excel");
  // The built-in Excel connector now claims .xlsm, so it serves it ahead of evil
  assert.equal(claim("/w/a.xlsm"), "microsoft-excel");
  for (const f of ["a.png", "A.PNG", "a.jpg", "a.md", "x.notes.md", "a.pdf", "a.txt", "a.csv"]) assert.equal(claim(`/w/${f}`), undefined, f);
  // The CLI, as a user runs it, in a temp HOME and data folder with the production built-ins (the bootstrap's no-built-ins switch removed).
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: h, COCHECK_HOME: h };
  delete env.COCHECK_TEST_NO_BUILTIN_CONNECTORS;
  const cli = path.join(import.meta.dirname, "..", "src", "cli-main.ts");
  const run = spawnSync(process.execPath, [cli, "connector", "list"], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const row = (type: string): string => run.stdout.split("\n").find((l) => l.startsWith(`${type}: `)) ?? `(no ${type} row)`;
  assert.equal(row(".py"), ".py: claimed by evil, py-view; enabled: evil (default); with none enabled: CoCheck's generic tiers (text, picture or fingerprint)");
  assert.equal(row(".png"), ".png: claimed by evil, png-view; enabled: none (default); with none enabled: CoCheck reads it itself");
  assert.equal(row(".docx"), ".docx: claimed by microsoft-word (built-in), evil; enabled: microsoft-word (default); with none enabled: CoCheck reads it itself");
  // The built-ins are enabled for the macro and show endings by default, and the list says so
  assert.equal(row(".xlsm"), ".xlsm: claimed by microsoft-excel (built-in), evil; enabled: microsoft-excel (default); with none enabled: CoCheck reads it itself");
  for (const t of [".pptm", ".ppsx", ".ppsm"]) assert.equal(row(t), `${t}: claimed by microsoft-powerpoint (built-in); enabled: microsoft-powerpoint (default); with none enabled: CoCheck reads it itself`);
  // The listed state is the one routing uses: enabling png-view through the CLI moves .png files to it, and the list follows.
  const on = spawnSync(process.execPath, [cli, "connector", "enable", "png-view", ".png"], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(on.status, 0, on.stderr);
  assert.equal(claimOf(h)("/w/a.png"), "png-view");
  const after = spawnSync(process.execPath, [cli, "connector", "list"], { env, encoding: "utf8", timeout: 60_000 });
  assert.match(after.stdout, /^\.png: claimed by evil, png-view; enabled: png-view \(set by you\);/m);
});
