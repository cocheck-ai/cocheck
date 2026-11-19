import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkPlatforms, loadPlatforms, writeMatrix, type Platform } from "../scripts/platforms-check.ts";
import { allProfiles } from "../src/hosts/index.ts";
import { CLAUDE_EXTRA_EVENTS } from "../src/hosts/claude.ts";
import type { HostProfile } from "../src/hosts/types.ts";

const REAL = path.join(import.meta.dirname, "..", "platforms");
const RECORDED_HOOKS = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures", "platforms", "recorded-hook-events.json"), "utf8"));
const REGISTER_KEY: Record<string, string> = { claude: "claude-code", codex: "codex", copilot: "copilot-cli" };

/** The events and fields a profile consumes: the events it installs, and for each the fields in its `shape` (plus the call id, for a host that has no call-id fallback). */
function consumed(p: HostProfile): { events: string[]; fields: Map<string, Set<string>> } {
  const events = new Set<string>([...(p.install?.events ?? []), ...(p.key === "claude" ? CLAUDE_EXTRA_EVENTS : [])]);
  const fields = new Map<string, Set<string>>();
  for (const e of events) fields.set(e, new Set(p.shape[e] ?? []));
  for (const [name, kind] of Object.entries(p.eventKinds)) {
    if (!events.has(name) || p.calls !== undefined) continue;
    if (kind === "tool-pre" || kind === "tool-post" || kind === "tool-failure") fields.get(name)!.add(p.fields.toolUseId);
  }
  return { events: [...events], fields };
}

/** Everything a profile consumes that the register marks absent or does not list. Empty means the profile agrees with the register. */
export function disagreements(platforms: Platform[], p: HostProfile): string[] {
  const reg = platforms.find((x) => x.key === REGISTER_KEY[p.key]);
  if (reg === undefined) return [`${p.key}: no register entry`];
  const out: string[] = [];
  const absentEvents = new Set<string>((reg.data.hooks.absent_events ?? []).flatMap((f: any) => (Array.isArray(f.value) ? f.value : [])));
  const { events, fields } = consumed(p);
  for (const name of events) {
    const ev = reg.data.hooks.events.find((e: any) => e.name === name);
    if (absentEvents.has(name)) out.push(`${p.key} consumes event ${name}, which the register marks absent`);
    else if (ev === undefined) out.push(`${p.key} consumes event ${name}, which the register does not list`);
    else {
      for (const f of fields.get(name) ?? []) {
        if ((ev.absent_fields ?? []).includes(f)) out.push(`${p.key} consumes ${name}.${f}, which the register marks absent`);
        else if (![...ev.payload_fields, ...(ev.unverified_fields ?? [])].includes(f)) out.push(`${p.key} consumes ${name}.${f}, which the register does not list`);
      }
    }
  }
  return out;
}

async function scratch(): Promise<string> {
  // A small repo root of its own: the OS temp folder as root made every check list a folder of tens of thousands of entries.
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "platforms-register-")), "platforms");
  await cp(REAL, dir, { recursive: true });
  await writeMatrix(dir);
  return dir;
}

async function editCaps(dir: string, platform: string, edit: (j: any) => void): Promise<void> {
  const file = path.join(dir, platform, "capabilities.json");
  const json = JSON.parse(await readFile(file, "utf8"));
  edit(json);
  await writeFile(file, JSON.stringify(json, null, 2));
}

const eventOf = (platforms: Platform[], key: string, name: string): any => platforms.find((p) => p.key === key)!.data.hooks.events.find((e: any) => e.name === name);

describe("platforms hook register", () => {
  it("lists the four register hosts, each with the full hook record", async () => {
    const { platforms, errors } = await loadPlatforms(REAL);
    assert.deepEqual(errors, []);
    for (const key of ["claude-code", "codex", "copilot-cli", "copilot-vscode"]) {
      const h = platforms.find((p) => p.key === key)?.data.hooks;
      assert.ok(h, `${key} missing`);
      for (const list of ["config_paths", "surfaces", "skill_and_plugin_paths", "sandbox_and_network"]) assert.ok(h[list].length > 0, `${key} hooks.${list} is empty`);
      assert.ok(h.events.length > 0, `${key} lists no events`);
    }
    assert.equal(platforms.find((p) => p.key === "claude-code")!.data.hooks.events.length, 33);
    assert.equal(platforms.find((p) => p.key === "codex")!.data.hooks.events.length, 14);
    assert.equal(platforms.find((p) => p.key === "copilot-cli")!.data.hooks.events.length, 14);
  });

  it("host profiles consume nothing the register marks absent (real profiles)", async () => {
    const { platforms } = await loadPlatforms(REAL);
    for (const p of allProfiles()) assert.deepEqual(disagreements(platforms, p), [], p.key);
    // eventKinds is a lookup of names; this one entry is inert because the Codex profile never installs it (Codex has no failure event).
    const inert = allProfiles().flatMap((p) => Object.keys(p.eventKinds).filter((n) => {
      const ev = eventOf(platforms, REGISTER_KEY[p.key]!, n);
      const absent = (platforms.find((x) => x.key === REGISTER_KEY[p.key])!.data.hooks.absent_events as any[]).some((f) => f.value.includes(n));
      return ev === undefined || absent;
    }).map((n) => `${p.key}:${n}`));
    assert.deepEqual(inert, ["codex:PostToolUseFailure"]);
  });

  it("a profile that consumes an absent event or field fails the check", async () => {
    const { platforms } = await loadPlatforms(REAL);
    const codex = allProfiles().find((p) => p.key === "codex")!;
    const copilot = allProfiles().find((p) => p.key === "copilot")!;
    const claude = allProfiles().find((p) => p.key === "claude")!;
    // Codex starts installing the failure event it does not have.
    const withFailure = { ...codex, install: { ...codex.install!, events: [...codex.install!.events, "PostToolUseFailure"] } } as HostProfile;
    assert.ok(disagreements(platforms, withFailure).some((m) => m.includes("PostToolUseFailure") && m.includes("absent")), "codex failure event");
    // Codex PermissionRequest carries no tool_use_id: a profile that installs it and reads the id is wrong.
    const permission = { ...codex, install: { ...codex.install!, events: [...codex.install!.events, "PermissionRequest"] }, shape: { ...codex.shape, PermissionRequest: ["session_id", "tool_use_id"] } } as HostProfile;
    assert.ok(disagreements(platforms, permission).some((m) => m.includes("PermissionRequest.tool_use_id") && m.includes("absent")), "codex permission id");
    // Copilot has no call id: a profile without the call-id fallback reads one that never arrives.
    const noFallback = { ...copilot, calls: undefined } as HostProfile;
    assert.ok(disagreements(platforms, noFallback).some((m) => m.includes("toolCallId") && m.includes("absent")), "copilot call id");
    // An event nobody lists.
    const invented = { ...claude, install: { ...claude.install!, events: [...claude.install!.events, "PreMagic"] } } as HostProfile;
    assert.ok(disagreements(platforms, invented).some((m) => m.includes("PreMagic")), "unlisted event");
    // The register edited to mark a consumed field absent.
    const dir = await scratch();
    try {
      await editCaps(dir, "claude-code", (j) => { j.hooks.absent_events.push({ claim: "x", value: ["PreToolUse"], kind: "documented", source: "https://code.claude.com/docs/en/hooks", date: "2026-10-24", verified_on: null, status: "confirmed" }); });
      const edited = (await loadPlatforms(dir)).platforms;
      assert.ok(disagreements(edited, claude).some((m) => m.includes("PreToolUse") && m.includes("absent")));
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it("real use: every event CoCheck consumed in the drive records is confirmed on an official page or a probe", async () => {
    const { platforms } = await loadPlatforms(REAL);
    for (const [host, names] of Object.entries(RECORDED_HOOKS.journal_events as Record<string, string[]>)) {
      for (const name of names) {
        const ev = eventOf(platforms, REGISTER_KEY[host]!, name);
        assert.ok(ev, `${host} ${name} not in the register`);
        assert.equal(ev.fact.status, "confirmed", `${host} ${name}`);
        assert.match(ev.fact.source, /^(https:\/\/|probe:|binary:)/, `${host} ${name} source`);
      }
    }
    // SessionStart is installed by the Claude profile for attribution and recorded in the Claude probe.
    assert.equal(eventOf(platforms, "claude-code", "SessionStart").fact.status, "confirmed");
    // The SubagentStop payload fields seen live are all listed.
    const sub = eventOf(platforms, "claude-code", "SubagentStop");
    for (const f of RECORDED_HOOKS.subagent_stop_payload_keys) assert.ok(sub.payload_fields.includes(f), `SubagentStop.${f}`);
  });

  it("a confirmed hook fact needs an official source or a probe record", async () => {
    const dir = await scratch();
    try {
      await editCaps(dir, "codex", (j) => { const e = j.hooks.events.find((x: any) => x.name === "Interrupt"); e.fact.status = "confirmed"; e.fact.source = "https://example.com/a-blog"; });
      await editCaps(dir, "copilot-cli", (j) => { j.hooks.surfaces[0].status = "confirmed"; j.hooks.surfaces[0].source = "local:~/notes.md"; j.hooks.surfaces[0].kind = "documented"; });
      await writeMatrix(dir);
      const r = await checkPlatforms(dir);
      assert.ok(r.errors.some((e) => e.includes("codex") && e.includes("Interrupt") && e.includes("confirmed")), r.errors.join("\n"));
      assert.ok(r.errors.some((e) => e.includes("copilot-cli") && e.includes("surfaces[0]") && e.includes("confirmed")), r.errors.join("\n"));
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it("fails an event entry that lacks the register fields", async () => {
    const dir = await scratch();
    try {
      await editCaps(dir, "claude-code", (j) => { delete j.hooks.events[0].can_rewrite; delete j.hooks.events[1].timeout_sec; });
      await writeMatrix(dir);
      const r = await checkPlatforms(dir);
      assert.ok(r.errors.some((e) => e.includes("events[0]") && e.includes("can_rewrite")), r.errors.join("\n"));
      assert.ok(r.errors.some((e) => e.includes("events[1]") && e.includes("timeout_sec")), r.errors.join("\n"));
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it("matrix carries the discrepancies section with the five required entries", async () => {
    const matrix = await readFile(path.join(REAL, "matrix.md"), "utf8");
    assert.match(matrix, /^## Discrepancies$/m);
    for (const needle of ["no failure event", "no call id", ".claude/settings.json", "cannot reach the Mac", "0.164.0"]) {
      assert.ok(matrix.toLowerCase().includes(needle.toLowerCase()), `matrix lacks "${needle}"`);
    }
    assert.match(matrix, /copilot-vscode/);
  });

  it("a stale discrepancies file makes the matrix stale; a discrepancy without a fact is invalid", async () => {
    const dir = await scratch();
    try {
      const file = path.join(dir, "discrepancies.json");
      const j = JSON.parse(await readFile(file, "utf8"));
      j.items[0].title += " (edited)";
      await writeFile(file, JSON.stringify(j, null, 2));
      assert.equal((await checkPlatforms(dir)).stale, true);
      delete j.items[0].fact.source;
      await writeFile(file, JSON.stringify(j, null, 2));
      const r = await checkPlatforms(dir);
      assert.ok(r.errors.some((e) => e.includes("discrepancies") && e.includes("source")), r.errors.join("\n"));
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });
});
