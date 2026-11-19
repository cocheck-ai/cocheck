// `cocheck connector doctor [<id>]`. Stand-in secret store and a temp home only; the real store is never reached.
// Must not happen: a connector reported healthy with a failed hello or a missing credential; a stored value reaching the terminal.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runConnectorDoctor } from "../src/connector-doctor.ts";
import { main } from "../src/cli.ts";

const SECRET = "sentinel-T399-7f3a91-do-not-print";
const store = (items: Record<string, string> = {}) => ({
  get: (s: string, a: string) => (items[`${s}/${a}`] === undefined ? null : Buffer.from(items[`${s}/${a}`]!)),
});

function install(h: string, id: string, script: string | undefined, extra: Record<string, unknown> = {}): string {
  const dir = path.join(h, "connectors", id);
  mkdirSync(dir, { recursive: true });
  if (script !== undefined) writeFileSync(path.join(dir, "c.mjs"), script);
  writeFileSync(path.join(dir, "cocheck-connector.json"), JSON.stringify({ spec: "cocheck.connector/1", id, version: "0.1.0", entry: "diff", matches: { extensions: [".x"] }, run: [process.execPath, "c.mjs"], ...extra }));
  return dir;
}
const GOOD = `process.stdin.on("data",d=>{const m=JSON.parse(String(d).split("\\n")[0]);console.log(JSON.stringify({id:m.id,result:{ok:true}}));});`;
const SILENT = `process.stdin.on("data",()=>{});setInterval(()=>{},1000);`;
const ECHO_ERR = `process.stdin.on("data",d=>{const m=JSON.parse(String(d).split("\\n")[0]);console.log(JSON.stringify({id:m.id,error:"boom "+JSON.stringify(m.params)}));});`;
const tmp = () => mkdtempSync(path.join(tmpdir(), "cocheck-"));
const run = (h: string, argv: string[], items: Record<string, string> = {}, ms = 800) => runConnectorDoctor(argv, { home: h, store: store(items), helloTimeoutMs: ms });

describe("connector doctor", () => {
  it("zero installed: says so, exit 0", async () => {
    const r = await run(tmp(), []);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /No connectors are installed/);
  });

  it("a healthy connector passes every check", async () => {
    const h = tmp();
    install(h, "good", GOOD, { credentials: [{ name: "k" }], requires: { binaries: ["node"] } });
    const r = await run(h, [], { "cocheck-connector:good/k": SECRET });
    assert.equal(r.exitCode, 0, r.stdout);
    assert.match(r.stdout, /manifest valid/);
    assert.match(r.stdout, /run command found/);
    assert.match(r.stdout, /required binary "node" found: yes/);
    assert.match(r.stdout, /credential "k" stored: yes/);
    assert.match(r.stdout, /hello answered within 0\.8 seconds/);
    assert.ok(!r.stdout.includes("FAIL"));
  });

  it("named id not installed: exit 1", async () => {
    const h = tmp();
    install(h, "good", GOOD);
    const r = await run(h, ["nope"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /no connector "nope" is installed/);
  });

  it("named id checks only that connector", async () => {
    const h = tmp();
    install(h, "a", GOOD);
    install(h, "b", SILENT);
    const r = await run(h, ["a"]);
    assert.equal(r.exitCode, 0);
    assert.ok(!r.stdout.includes("\nb"));
  });

  it("DANGEROUS: missing credential is failed, never healthy, and hello is not tried", async () => {
    const h = tmp();
    install(h, "c", GOOD, { credentials: [{ name: "k" }] });
    const r = await run(h, []);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /FAIL credential "k" stored: no/);
    assert.match(r.stdout, /FAIL hello answered: not tried/);
  });

  it("DANGEROUS: a hello that times out is failed, in plain words, no path or id", async () => {
    const h = tmp();
    const dir = install(h, "slow", SILENT);
    const r = await run(h, [], {}, 300);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /FAIL hello answered within 0\.3 seconds: no, no answer to hello within 0\.3 seconds/);
    assert.ok(!r.stdout.includes(dir) && !r.stdout.includes(tmpdir()));
    assert.ok(!/validate:|connector slow/.test(r.stdout));
  });

  it("DANGEROUS: a hello error that echoes the credential never reaches the output", async () => {
    const h = tmp();
    install(h, "e", ECHO_ERR, { credentials: [{ name: "k" }] });
    const r = await run(h, [], { "cocheck-connector:e/k": SECRET });
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /hello was answered with an error/);
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  });

  it("missing run command and missing binary fail", async () => {
    const h = tmp();
    install(h, "m", undefined, { run: ["definitely-not-a-real-cmd"], requires: { binaries: ["definitely-not-a-real-bin"] } });
    const r = await run(h, []);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /FAIL run command found: no/);
    assert.match(r.stdout, /FAIL required binary "definitely-not-a-real-bin" found: no/);
  });

  it("an installed manifest that fails to parse is reported failed, not skipped", async () => {
    const h = tmp();
    const dir = install(h, "bad", undefined);
    writeFileSync(path.join(dir, "cocheck-connector.json"), "{ not json");
    install(h, "good", GOOD);
    const r = await run(h, []);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /bad\n  FAIL manifest valid: no/);
    assert.ok(!r.stdout.includes(h));
  });

  it("a schema-invalid manifest is reported failed", async () => {
    const h = tmp();
    install(h, "inv", undefined, { run: 5 });
    const r = await run(h, ["inv"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /FAIL manifest valid: no/);
  });

  it("CLI dispatch and usage name doctor", async () => {
    const r = await main(["connector", "bogus"]);
    assert.match(r.stderr, /cocheck connector doctor \[<id>\]/);
  });
});
