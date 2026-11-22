// The L3 extras: first-party code a harness manifest opts into by name (`"extras": ["codex-rollout-narration"]`). A manifest is data and holds no code,
// so whatever is not data (a reader of the host's own session file, a config editor, a trust probe) lives here, in this repo, under a name.
// A manifest that names an extra this table lacks fails validation. The table is read at call time: the profile modules it imports load in any order.
import { readClaudeCalls } from "../coverage.ts";
import { CLAUDE_HELPERS, claudeClosing, claudeFieldText, claudeLine } from "./claude.ts";
import { CODEX_TOML_EDITOR, codexClaimAtPre, codexFailure, codexToolName, codexDisplayText, codexLine, codexTrustProblemOf, locateHelperRollout, locateRollout, rolloutCallExits, rolloutCallText, rolloutRefusedCommands } from "./codex.ts";
import { copilotLine, locateEvents } from "./copilot.ts";
import { claudeSessionTitle, codexSessionTitle, copilotSessionTitle } from "./session-titles.ts";
import type { HostProfile } from "./types.ts";

type Part<K extends keyof HostProfile> = Partial<NonNullable<HostProfile[K]>>;

/** What an extra adds to a profile. Members that are objects (`narration`, `sessionFile`, `install`, `capabilities`, `fields`) are merged one level; any other member replaces the profile's. */
export interface ExtraPart {
  about: string;
  /** True: a manifest loaded from the person's own folder may name this extra. Only an extra that reads nothing beyond the host's own payload and the manifest qualifies; every other extra is for built-in manifests. */
  outsiderSafe?: true;
  /** Environment variables that move the folders this extra reads or writes. */
  homeEnv?: readonly string[];
  narration?: Part<"narration">;
  sessionFile?: Part<"sessionFile">;
  install?: Part<"install">;
  capabilities?: Part<"capabilities">;
  fields?: Part<"fields">;
  coverage?: HostProfile["coverage"];
  reveal?: HostProfile["reveal"];
  helpers?: HostProfile["helpers"];
  sessionTitle?: HostProfile["sessionTitle"];
  displayText?: HostProfile["displayText"];
  failureOf?: HostProfile["failureOf"];
  toolName?: HostProfile["toolName"];
}

/** Every extra, by name. */
export const extras = (): Readonly<Record<string, ExtraPart>> => ({
  "claude-transcript-narration": { about: "Reads the call's words and the closing message from a Claude Code transcript.", narration: { foldLine: claudeLine, closing: claudeClosing } },
  "codex-rollout-narration": { about: "Reads the call's words and the closing message from a Codex rollout.", narration: { foldLine: codexLine, claimAtPre: codexClaimAtPre, closing: (cur) => cur?.closing ?? "" } },
  "copilot-events-narration": { about: "Reads the call's words and the closing message from a Copilot session's events.jsonl.", narration: { foldLine: copilotLine, closing: (cur) => cur?.closing ?? "" } },
  "transcript-coverage": { about: "Lists every call id a Claude Code transcript holds, to check the hook saw them all.", coverage: { readCalls: (sessionFile, session) => readClaudeCalls(sessionFile, session) } },
  "transcript-helpers": { about: "Finds a helper's own transcript and meta file beside a Claude Code session file.", helpers: CLAUDE_HELPERS },
  "claude-reveal": { about: "Reads a withheld tool-input field back from a Claude Code transcript.", reveal: { fieldText: claudeFieldText } },
  "codex-rollout-locate": { about: "Finds a Codex rollout from the thread id.", sessionFile: { bySessionId: true, locate: locateRollout } },
  "copilot-events-locate": { about: "Finds a Copilot session's events.jsonl from the session id.", sessionFile: { bySessionId: true, locate: locateEvents } },
  "codex-helper-rollout-lookup": { about: "Finds a Codex helper's own rollout, when its header names the main thread.", sessionFile: { locateHelper: locateHelperRollout } },
  "codex-rollout-call-readers": { about: "Reads each call's own text, exit status and host refusals from a Codex rollout.", sessionFile: { callText: rolloutCallText, callExit: rolloutCallExits, refusedCommands: rolloutRefusedCommands } },
  "codex-display-text": { about: "Turns a Codex reply's file-citation directives into plain words.", outsiderSafe: true, displayText: codexDisplayText },
  "claude-session-title": { about: "Reads the title Claude Code gave a session.", sessionTitle: claudeSessionTitle },
  "codex-failure-read": { about: "Reads a failed Codex call: the shared error flags, and a Bash output that is only shell error lines (inferred).", failureOf: codexFailure },
  "codex-tool-name": { about: "Takes Codex's tool namespace (`collaborationsend_message`) off a tool name.", toolName: codexToolName },
  "codex-session-title": { about: "Reads the title Codex gave a session.", sessionTitle: codexSessionTitle },
  "copilot-session-title": { about: "Reads the title Copilot gave a session.", sessionTitle: copilotSessionTitle },
  "codex-toml-editor": { about: "Adds, removes and checks CoCheck's hook tables in Codex's config.toml.", homeEnv: ["CODEX_HOME"], install: CODEX_TOML_EDITOR },
  "codex-trust-probe": { about: "Asks Codex whether it trusts the installed hooks.", install: { trustProblem: codexTrustProblemOf } },
  "helper-linker": { about: "Links a helper's events (under the helper's own session id) to the main session, or holds them (src/helper-linker.ts).", capabilities: { helperSessions: true, launchKey: true }, fields: { launchKey: "cocheckLaunchKey" } },
  "install-default": { about: "Marks the host an install record without a host list, and a hook check without a host, fall back to." },
});

export const knownExtra = (name: string): boolean => Object.hasOwn(extras(), name);

/** True when a manifest from the person's own folder may name the extra. */
export const outsiderSafeExtra = (name: string): boolean => Object.hasOwn(extras(), name) && extras()[name]!.outsiderSafe === true;

const MERGED = ["narration", "sessionFile", "install", "capabilities", "fields"] as const;

/** The profile with the named extras added. Throws for a name the table lacks. */
export function applyExtras(profile: HostProfile, names: readonly string[]): HostProfile {
  const table = extras();
  const out: Record<string, unknown> = { ...profile };
  for (const name of names) {
    const part = table[name];
    if (part === undefined) throw new Error(`unknown extra ${JSON.stringify(name)}`);
    for (const [k, v] of Object.entries(part)) {
      if (k === "about" || v === undefined) continue;
      if (k === "homeEnv") {
        out[k] = [...new Set([...((out[k] as readonly string[] | undefined) ?? []), ...(v as readonly string[])])];
        continue;
      }
      out[k] = (MERGED as readonly string[]).includes(k) ? { ...(out[k] as object | undefined), ...(v as object) } : v;
    }
  }
  return { ...(out as unknown as HostProfile), extras: [...(profile.extras ?? []), ...names] };
}
