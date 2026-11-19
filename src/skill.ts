// The one skill `cocheck install` writes, so a person can tell any session to start or stop tracking in plain words. The same
// SKILL.md goes to the three folders the hosts read (Claude Code, Codex and others via ~/.agents, Copilot) and `cocheck uninstall`
// removes exactly the files that carry the marker line.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { allProfiles } from "./hosts/index.ts";

const SKILL_NAME = "cocheck";
export const SKILL_MARKER = "<!-- written by cocheck install; cocheck uninstall removes it -->";
/** The folders under the person's home that hold skills, one per host family, read from the host profiles (hosts that share a folder list it once). */
export const skillRoots = (): readonly string[] => [...new Set(allProfiles().flatMap((p) => (p.install === undefined ? [] : [p.install.skillRoot])))];

/** The SKILL.md text; `cli` is the command that runs CoCheck's CLI (src/session-context.ts cliCommand). `windows` sends the host to PowerShell: Codex on Windows reads "Bash" as WSL bash.exe, which its sandbox denies, so the text names PowerShell. */
export function skillText(cli: string, windows = false): string {
  const where = windows ? "as its own shell command in PowerShell (never WSL bash), by itself." : "as its own Bash command, by itself.";
  return [
    "---",
    `name: ${SKILL_NAME}`,
    "description: Start or stop CoCheck tracking for this session, check whether it is tracking, or open the CoCheck review page. Use when the person says start tracking, stop tracking, track this, is it tracking, or asks to see the review of the work.",
    "---",
    SKILL_MARKER,
    "",
    "# CoCheck",
    "",
    "CoCheck records a session's work so the person can review it. Every session starts untracked: nothing is recorded until the person starts it.",
    "",
    `Run each command below ${where} Do not put anything before it on the line, do not put it in a string, an echo or a heredoc, and do not chain it with another command: only a command that begins with exactly \`cocheck track\` switches tracking.`,
    "",
    `- Start tracking (the person says start tracking): run \`${cli} track start\`. It takes effect from your next tool call, and the folder you are in becomes the task folder. Put the files for this work inside that folder. Then run \`${cli} track status\` and tell the person whether this session is listed as tracked (its host and folder). If it is not listed, say so plainly: tracking is off, and do not tell the person it is on.`,
    `- Stop tracking (the person says stop tracking): run \`${cli} track stop\`. Calls after it are not recorded. What was already recorded stays.`,
    `- Check tracking: run \`${cli} track status\` and tell the person what it prints.`,
    `- Open the review page: run \`${cli} open\`.`,
    "",
    "CoCheck has no close action: nothing here closes the review page or ends a task. If the person says close, ask what \"close\" means to them (stop tracking, or something else) before running anything.",
    "",
  ].join("\n");
}

/** The skill folder each host reads, so an install writes the skill only for the hosts it installed. */
export function skillRootOf(host: string): string {
  const root = allProfiles().find((p) => p.key === host)?.install?.skillRoot;
  if (root === undefined) throw new Error(`no skill folder for host: ${host}`);
  return root;
}

/**
 * Writes the skill under each of `roots` in `userHome`; returns the files written. An `cocheck/SKILL.md` already there that lacks SKILL_MARKER
 * is the person's own: it is never overwritten, and its path goes into `skipped`.
 */
export function installSkill(userHome: string, cli: string, roots: readonly string[] = skillRoots(), skipped: string[] = [], windows = false): string[] {
  const written: string[] = [];
  for (const root of roots) {
    const dir = path.join(userHome, root, SKILL_NAME);
    const file = path.join(dir, "SKILL.md");
    if (existsSync(file)) {
      let mine = true;
      try {
        mine = !readFileSync(file, "utf8").includes(SKILL_MARKER);
      } catch {
        // unreadable: treated as the person's own
      }
      if (mine) {
        skipped.push(file);
        continue;
      }
    }
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, skillText(cli, windows), { mode: 0o644 });
    renameSync(tmp, file);
    written.push(file);
  }
  return written;
}

/** The `skills` folders under `userHome` that do not exist yet, i.e. the ones an install would create. */
export const missingSkillRoots = (userHome: string, roots: readonly string[] = skillRoots()): string[] => roots.map((r) => path.join(userHome, r)).filter((d) => !existsSync(d));

/**
 * Removes the skill files CoCheck wrote (only those carrying the marker) and their folders when empty; returns the files removed.
 * A `skills` folder goes too, only when it is listed in `made` (the install created it) and is empty: a person's own empty folder stays.
 */
export function removeSkill(userHome: string, made: readonly string[] = []): string[] {
  const removed: string[] = [];
  for (const root of skillRoots()) {
    const dir = path.join(userHome, root, SKILL_NAME);
    const file = path.join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(SKILL_MARKER)) continue;
    rmSync(file, { force: true });
    removed.push(file);
    try {
      rmdirSync(dir);
      if (made.includes(path.dirname(dir))) rmdirSync(path.dirname(dir));
      // The host folder itself (~/.agents) when the install made it too.
      if (made.includes(path.dirname(path.dirname(dir)))) rmdirSync(path.dirname(path.dirname(dir)));
    } catch {
      // the folder holds something of the person's: it stays
    }
  }
  return removed;
}
