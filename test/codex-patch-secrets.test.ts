import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleHook, type HookPayload } from "../src/hook-adapter.ts";
import { journalEvent } from "../src/hook-journal.ts";
import { openLedger } from "../src/ledger.ts";
import { normalize } from "../src/normalize.ts";
import { scrubPatchText, scrubPayloadBytes } from "../src/patch-secrets.ts";
import { helperGate } from "../src/helper-linker.ts";
import { setTracking } from "../src/tracking.ts";
import { firstSecretRule } from "../src/secret-scan.ts";
import { trackedClaims } from "./helpers/claims.ts";

// Codex writes files with apply_patch: the patch text (the new file contents) is in tool_input.command (live run 2026-11-01, ops 556 to 560,
// Codex 0.162/0.166). It was stored raw as the op's intent, so a .env body and a gitleaks-shaped token sat in the ledger in plain text. A patch
// section for a secret path, or holding a gitleaks-shaped value, is now withheld everywhere it is stored (ledger intent and args, hook state,
// journal body, timeline reads). Must not happen: (a) a normal patch keeps its headers, its lines and exact credit; (b) a secret in a
// patch to a NORMAL file is withheld; (c) the person's own prompt text is out of scope and unchanged.
const GHP = "ghp_" + "R7xK2mQ9vL4pW8nT3zY6bH1cJ5dF0gS2aE7u";
const ENVBODY = "API_KEY=sk-test-" + "9f8e7d6c5b4a3210fedcba";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const tmp = async (name: string) => {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), `cocheck-patchsec-${name}-`)));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
};
async function allText(dir: string): Promise<string> {
  let out = "";
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out += (await readFile(path.join(e.parentPath, e.name), "latin1")) + "\n";
  return out;
}
async function rig(host: "codex" | "claude" = "codex") {
  const home = await tmp("home");
  const folder = await tmp("folder");
  await mkdir(path.join(folder, "t21"), { recursive: true });
  await writeFile(path.join(folder, "readme.md"), "start\n");
  let clock = Date.parse("2026-11-01T14:00:00Z");
  const opts = { host, home, claimed: trackedClaims, folder, now: () => clock };
  const send = (over: Record<string, unknown>) => {
    clock += 1000;
    return handleHook({ session_id: "s1", transcript_path: "/x/t.jsonl", cwd: folder, hook_event_name: "", ...over } as HookPayload, opts);
  };
  const call = (event: string, id: string, name: string, input: unknown) => send({ hook_event_name: event, tool_name: name, tool_use_id: id, tool_input: input });
  const patch = async (id: string, command: string, files: Record<string, string>, mid?: () => Promise<void>) => {
    await call("PreToolUse", id, "apply_patch", { command });
    for (const [rel, text] of Object.entries(files)) await writeFile(path.join(folder, rel), text);
    await mid?.();
    await call("PostToolUse", id, "apply_patch", { command });
  };
  const ops = () => {
    const l = openLedger(home);
    try {
      return l.okOpsForTask(1, 0, l.maxOpId()).map((o) => ({ tool: o.tool, intent: o.intent, args: o.argsJson }));
    } finally {
      l.close();
    }
  };
  const states = () => {
    const l = openLedger(home);
    try {
      return l.fileStatesForTask(1).map((s) => ({ file: path.basename(s.filePath), basis: s.creditBasis }));
    } finally {
      l.close();
    }
  };
  await call("PreToolUse", "warm", "Bash", { command: "true" });
  await call("PostToolUse", "warm", "Bash", { command: "true" });
  await send({ hook_event_name: "Stop", last_assistant_message: "warmed" });
  return { home, folder, send, call, patch, ops, states };
}
const SECRET_PATCH = `*** Begin Patch\n*** Add File: t21/.env\n+${ENVBODY}\n*** Add File: t21/config.txt\n+${GHP}\n*** Add File: t21/notes.txt\n+plain notes\n*** End Patch`;

describe("Codex apply_patch secrets", () => {
  it("the fixture values are what the detector flags", () => {
    assert.equal(firstSecretRule(GHP), "github-pat");
  });

  it("a patch with a .env body and a token: ledger intent and args, hook state and the timeline read hold neither; headers and the plain section stay", async () => {
    const t = await rig();
    let midState = "";
    await t.patch("P1", SECRET_PATCH, { "t21/.env": `${ENVBODY}\n`, "t21/config.txt": `${GHP}\n`, "t21/notes.txt": "plain notes\n" }, async () => {
      midState = await allText(path.join(t.home, "hooks"));
    });
    await t.send({ hook_event_name: "Stop", last_assistant_message: "done" });
    const hit = t.ops().find((o) => o.tool === "apply_patch");
    assert.ok(hit, "the patch op exists");
    for (const text of [hit.intent, hit.args, midState, await allText(path.join(t.home, "hooks"))]) {
      assert.ok(!text.includes(GHP), "no token");
      assert.ok(!text.includes(ENVBODY) && !text.includes("sk-test-"), "no .env body");
    }
    assert.match(hit.intent, /\*\*\* Add File: t21\/\.env/);
    assert.match(hit.intent, /\*\*\* Add File: t21\/config\.txt/);
    assert.match(hit.intent, /\+plain notes/, "the normal section keeps its lines");
  });

  it("(b) a secret in a patch to a normal file is withheld, the header kept", async () => {
    const t = await rig();
    await t.patch("P1", `*** Begin Patch\n*** Add File: t21/plain.txt\n+hello\n+token ${GHP}\n*** End Patch`, { "t21/plain.txt": `hello\ntoken ${GHP}\n` });
    await t.send({ hook_event_name: "Stop", last_assistant_message: "done" });
    const hit = t.ops().find((o) => o.tool === "apply_patch")!;
    assert.ok(!hit.intent.includes(GHP) && !hit.args.includes(GHP));
    assert.match(hit.intent, /\*\*\* Add File: t21\/plain\.txt/);
  });

  it("(a) a normal patch keeps its text, its headers and exact credit (host-reported-edit)", async () => {
    const t = await rig();
    const text = "# Plan\n- a\n";
    await t.patch("P1", "*** Begin Patch\n*** Add File: t21/notes.md\n+# Plan\n+- a\n*** End Patch", { "t21/notes.md": text });
    await t.send({ hook_event_name: "Stop", last_assistant_message: "done" });
    const hit = t.ops().find((o) => o.tool === "apply_patch")!;
    assert.match(hit.intent, /\*\*\* Add File: t21\/notes\.md\n\+# Plan\n\+- a\n\*\*\* End Patch/);
    assert.deepEqual(t.states().filter((s) => s.file === "notes.md").map((s) => s.basis), ["host-reported-edit"], JSON.stringify(t.states()));
  });

  it("(c) the person's own prompt text is unchanged (out of scope)", async () => {
    const t = await rig();
    await t.send({ hook_event_name: "UserPromptSubmit", prompt: `create config.txt containing ${GHP}` });
    await t.patch("P1", SECRET_PATCH, { "t21/config.txt": `${GHP}\n` });
    await t.send({ hook_event_name: "Stop", last_assistant_message: "done" });
    assert.ok(t.ops().some((o) => o.args.includes(GHP)), "the prompt op still holds the user's own text");
  });

  it("the journal keeps the index line and no payload for a tool call with a secret patch or a normal patch", async () => {
    const home = await tmp("jhome");
    const ev = (command: string) => Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_use_id: "t1", tool_name: "apply_patch", tool_input: { command } }));
    const bad = journalEvent(home, ev(SECRET_PATCH), "codex", () => 1);
    const text = await allText(path.join(home, "journal"));
    assert.ok(!text.includes(GHP) && !text.includes("sk-test-") && !text.includes("t21/config.txt"), "no payload token in any journal file");
    assert.equal(bad.event, "PreToolUse", "the index line exists");
    const ok = journalEvent(home, ev("*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch"), "codex", () => 2);
    assert.equal(ok.event, "PreToolUse");
    assert.ok(!(await allText(path.join(home, "journal"))).includes("a.md"), "a normal patch's text is not in the journal either");
  });

  // Security probes. The raw input is scrubbed once, in normalize; every consumer reads the scrubbed form.
  const MOVE_IN = `*** Begin Patch\n*** Update File: t21/a.txt\n*** Move to: t21/.env\n@@\n-old\n+DB_PASSWORD=${"hunter22-" + "Zq8rT5vN2xK7"}\n*** End Patch`;
  const MOVE_OUT = `*** Begin Patch\n*** Update File: t21/.env\n*** Move to: t21/notes.txt\n@@\n-OLD_SECRET=${"hunter22-" + "Zq8rT5vN2xK7"}\n+NEW_SECRET=${"hunter23-" + "Wp4mL9cB6yH1"}\n*** End Patch`;
  for (const [name, patch] of [["a Move to a secret path", MOVE_IN], ["a Move from a secret path", MOVE_OUT]] as const) {
    it(`${name}: the body is in no store (ledger intent, args, hook state, journal, loader)`, async () => {
      const t = await rig();
      let mid = "";
      await t.patch("M1", patch, { "t21/.env": "x\n", "t21/notes.txt": "x\n" }, async () => {
        mid = await allText(path.join(t.home, "hooks"));
      });
      await t.send({ hook_event_name: "Stop", last_assistant_message: "done" });
      const hit = t.ops().find((o) => o.tool === "apply_patch")!;
      for (const text of [hit.intent, hit.args, mid, await allText(path.join(t.home, "hooks")), scrubPatchText(patch)]) assert.ok(!/hunter2[23]-/.test(text), "no body");
      assert.match(hit.intent, /\*\*\* Move to: t21\/(\.env|notes\.txt)/, "headers stay");
      const home = await tmp("jm");
      const ref = journalEvent(home, Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_use_id: "m", tool_name: "apply_patch", tool_input: { command: patch } })), "codex", () => 1);
      assert.equal(ref.event, "PreToolUse");
      assert.ok(!/hunter2[23]-/.test(await allText(path.join(home, "journal"))));
    });
  }

  it("the journal checks every host's input field: Copilot toolArgs as a JSON string, {patch}, {input}, and a plain patch string", async () => {
    const sp = SECRET_PATCH;
    const shapes: unknown[] = [JSON.stringify({ patch: sp }), JSON.stringify({ input: sp }), sp, { patch: sp }, { input: sp }];
    for (const [i, toolArgs] of shapes.entries()) {
      const home = await tmp(`jc${i}`);
      const ref = journalEvent(home, Buffer.from(JSON.stringify({ hook_event_name: "preToolUse", sessionId: "s", toolCallId: `c${i}`, toolName: "apply_patch", toolArgs })), "copilot", () => 1);
      assert.equal(ref.event, "preToolUse", `shape ${i}`);
      assert.ok(!(await allText(path.join(home, "journal"))).includes(GHP), `shape ${i}`);
    }
  });
  it("the Copilot held-events spool holds the scrubbed form, and the held event still replays (probe shape)", async () => {
    const home = await tmp("held");
    setTracking(home, "copilot", "main", true, home, () => 5);
    await writeFile(path.join(home, "copilot-helpers.json"), JSON.stringify({ launches: [{ parent: "main", prompt: "p", at: 4, key: "k" }], links: {} }) + "\n");
    const patch = `*** Begin Patch\n*** Add File: .env\n+DB_PASSWORD=hunter2zz-Qm4xT8\n*** Add File: n.md\n+plain\n*** End Patch`;
    for (const toolArgs of [patch, JSON.stringify({ patch })]) {
      const raw = { hook_event_name: "preToolUse", sessionId: "helper1", toolCallId: "t", toolName: "apply_patch", toolArgs, cwd: "/x" };
      await helperGate(home, undefined, normalize("copilot", raw, "preToolUse"), Buffer.from(JSON.stringify(raw)), "preToolUse", 5);
    }
    const held = await allText(path.join(home, "copilot-held"));
    assert.ok(held.length > 0 && !held.includes("hunter2zz"), "the spool holds no body");
    assert.ok(held.includes("n.md") && held.includes("plain"), "the normal section and headers are kept");
    for (const line of held.split("\n").filter(Boolean)) {
      const ev = normalize("copilot", JSON.parse(JSON.parse(line).body), "preToolUse");
      assert.equal(ev.toolName, "apply_patch", "the held body re-normalizes");
    }
  });

  it("only a patch tool's patch fields are scrubbed: a Write whose content holds a patch block is untouched; scrubPayloadBytes is idempotent", () => {
    const content = `notes\n*** Begin Patch\n*** Add File: x/.env\n+A=b-c-d-e-f-g\n*** End Patch\n`;
    const writeBytes = Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Write", tool_input: { file_path: "/w/notes.md", content } }));
    assert.equal(scrubPayloadBytes(writeBytes), writeBytes, "same bytes");
    assert.equal((normalize("claude", JSON.parse(writeBytes.toString()), "PreToolUse").toolInput as { content: string }).content, content);
    const once = scrubPayloadBytes(Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "apply_patch", tool_input: { command: SECRET_PATCH } })));
    assert.ok(!once.toString().includes(GHP));
    assert.deepEqual(scrubPayloadBytes(once), once);
  });

  it("a failed patch's response echoing a withheld line is in no journal file (Codex tool_response string and object, Copilot toolResult)", async () => {
    const patch = "*** Begin Patch\n*** Add File: .env\n+DB_PASSWORD=hunter2zz\n*** End Patch";
    const echo = "apply_patch verification failed: expected lines DB_PASSWORD=hunter2zz\nplain failure line";
    const shapes: Array<[string, string, object]> = [
      ["codex", "str", { hook_event_name: "PostToolUse", session_id: "s", tool_use_id: "t", tool_name: "apply_patch", tool_input: { command: patch }, tool_response: echo }],
      ["codex", "obj", { hook_event_name: "PostToolUse", session_id: "s", tool_use_id: "t", tool_name: "apply_patch", tool_input: { command: patch }, tool_response: { is_error: true, content: echo } }],
      ["copilot", "result", { hook_event_name: "postToolUse", sessionId: "s", toolCallId: "t", toolName: "apply_patch", toolArgs: patch, toolResult: { resultType: "failure", textResultForLlm: echo, sessionLog: echo } }],
    ];
    for (const [host, name, payload] of shapes) {
      const home = await tmp(`jr-${name}`);
      journalEvent(home, Buffer.from(JSON.stringify(payload)), host, () => 1);
      const text = await allText(path.join(home, "journal"));
      assert.ok(!text.includes("hunter2zz"), `${host} ${name}`);
      assert.ok(!text.includes("plain failure line"), `${host} ${name}: no payload text in the journal`);
    }
  });

  it("a failed patch whose error echoes the hunk lines: the stored error text holds none of them (and a normal error stays)", async () => {
    const t = await rig("claude");
    const echo = `patch failed: context mismatch near ${ENVBODY}\nline 2: ${GHP}`;
    await t.call("PreToolUse", "F1", "apply_patch", { command: SECRET_PATCH });
    await writeFile(path.join(t.folder, "t21/notes.txt"), "plain notes\n");
    await t.send({ hook_event_name: "PostToolUseFailure", tool_name: "apply_patch", tool_use_id: "F1", tool_input: { command: SECRET_PATCH }, error: `${echo}\nplain failure line` });
    await t.send({ hook_event_name: "Stop", last_assistant_message: "done" });
    const hit = t.ops().find((o) => o.tool === "apply_patch")!;
    assert.ok(hit.args.includes("plain failure line"), "the failure is still recorded: " + hit.args.slice(0, 300));
    assert.ok(!hit.args.includes(GHP) && !hit.args.includes("sk-test-"), "no echoed secret");
    const ev = normalize("claude", { hook_event_name: "PostToolUseFailure", tool_name: "apply_patch", tool_input: { command: SECRET_PATCH }, error: echo });
    assert.ok(!ev.failure!.raw.includes("sk-test-") && !ev.failure!.raw.includes(GHP));
  });

  it("a /path-shaped secret value in a patch is not recorded as an outside reference (state or ledger)", async () => {
    const t = await rig();
    const val = "/opt/zzhidden-9f3a7c/secret-dir";
    const patch = `*** Begin Patch\n*** Add File: t21/.env\n+SECRET_DIR=${val}\n*** End Patch`;
    let mid = "";
    await t.patch("O1", patch, { "t21/.env": `SECRET_DIR=${val}\n` }, async () => {
      mid = await allText(path.join(t.home, "hooks"));
    });
    await t.send({ hook_event_name: "Stop", last_assistant_message: "done" });
    const hit = t.ops().find((o) => o.tool === "apply_patch")!;
    for (const text of [mid, hit.intent, hit.args]) assert.ok(!text.includes("zzhidden-9f3a7c"), "no value");
  });

  it("scrubPatchText: withholds secret sections, keeps every other line byte for byte", () => {
    const out = scrubPatchText(SECRET_PATCH);
    assert.ok(!out.includes(GHP) && !out.includes("sk-test-"));
    assert.equal(scrubPatchText("*** Begin Patch\n*** Update File: a.md\n@@\n a\n-b\n+c\n*** End Patch"), "*** Begin Patch\n*** Update File: a.md\n@@\n a\n-b\n+c\n*** End Patch");
  });
});
