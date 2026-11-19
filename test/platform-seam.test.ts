// The Platform seam. darwin builds and parses hook commands byte-for-byte as install.ts did before; an OS with no implementation (Linux included) throws a named error.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlatformNotBuiltError, hostPlatform, platform, platformFor } from "../src/platform/index.ts";
import { claude } from "../src/hosts/claude.ts";
import { codex } from "../src/hosts/codex.ts";
import { copilot } from "../src/hosts/copilot.ts";

const spec = { dataHome: "/Users/me/CoCheck Data", launcher: "/opt/it's/hook-launch.sh", hookPath: "/opt/cocheck/dist/hook.js", host: "claude" };
const darwin = platformFor("darwin");

describe("darwin hookCommand", () => {
  it("builds today's bytes", () => {
    assert.equal(
      darwin.hookCommand.build(spec),
      "COCHECK_MANAGED=1 COCHECK_HOME='/Users/me/CoCheck Data' /bin/sh '/opt/it'\\''s/hook-launch.sh' '/opt/cocheck/dist/hook.js' --host claude",
    );
    assert.equal(
      darwin.hookCommand.build({ ...spec, node: "/opt/homebrew/opt/node/bin/node" }),
      "COCHECK_MANAGED=1 COCHECK_HOME='/Users/me/CoCheck Data' COCHECK_NODE='/opt/homebrew/opt/node/bin/node' /bin/sh '/opt/it'\\''s/hook-launch.sh' '/opt/cocheck/dist/hook.js' --host claude",
    );
  });

  it("parses what it builds, with and without a pinned Node", () => {
    for (const s of [spec, { ...spec, node: "/n/node", host: "codex" }]) assert.deepEqual(darwin.hookCommand.parse(darwin.hookCommand.build(s)), s);
  });

  it("refuses a user's own command that carries the marker, and the old pinned-Node shape", () => {
    const legacy = "COCHECK_MANAGED=1 COCHECK_HOME='/h' '/n/node' '/hook.js' --host claude";
    assert.equal(darwin.hookCommand.parse(legacy), undefined);
    assert.equal(darwin.hookCommand.parse("echo COCHECK_MANAGED=1 && rm -rf /"), undefined);
    assert.equal(darwin.hookCommand.parse(darwin.hookCommand.build(spec) + " && echo hi"), undefined);
  });

  it("isMarked accepts a suffix (Copilot's --event) that parse does not", () => {
    const withSuffix = `${darwin.hookCommand.build({ ...spec, host: "copilot" })} --event preToolUse || true`;
    assert.equal(darwin.hookCommand.isMarked(withSuffix), true);
    assert.equal(darwin.hookCommand.parse(withSuffix), undefined);
    assert.equal(darwin.hookCommand.isMarked("echo COCHECK_MANAGED=1"), false);
  });
});

describe("adapters build and parse through platform.hookCommand", () => {
  it("claude: add then remove round-trips, and a user's marker-text entry stays", () => {
    const own = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo COCHECK_MANAGED=1" }] }] } });
    const added = claude.install!.addHooks(own, "s.json", spec, darwin);
    assert.match(added, /--host claude/);
    const removed = claude.install!.removeHooks(added, "s.json", darwin);
    assert.equal(removed.changed, true);
    assert.deepEqual(JSON.parse(removed.text), JSON.parse(own));
  });

  it("codex and copilot write the platform's command bytes", () => {
    assert.ok(codex.install!.addHooks("", "c.toml", { ...spec, host: "codex" }, darwin).includes(`command = "${darwin.hookCommand.build({ ...spec, host: "codex" }).replace(/\\/g, "\\\\")}"`));
    const text = copilot.install!.addHooks("", "h.json", { ...spec, host: "copilot" }, darwin);
    assert.ok(JSON.parse(text).hooks.preToolUse[0].bash.startsWith(darwin.hookCommand.build({ ...spec, host: "copilot" })));
    assert.equal(copilot.install!.removeHooks(text, "h.json", darwin).changed, true);
  });
});

describe("an OS with no implementation fails loudly", () => {
  it("an OS with no implementation at all throws PlatformNotBuiltError", () => {
    assert.throws(() => platformFor("freebsd"), PlatformNotBuiltError);
  });
  it("linux: platformFor says Linux is not supported", () => {
    assert.throws(() => platformFor("linux"), (e: Error) => e instanceof PlatformNotBuiltError && /Linux is not supported/.test(e.message));
  });
  it("linux: platform() on a process whose platform is linux fails with 'Linux is not supported', and hostPlatform() reads undefined", () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      assert.throws(() => platform(), /Linux is not supported/);
      assert.equal(hostPlatform(), undefined);
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });
});
