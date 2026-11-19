// What CoCheck tells the agent at the start of each turn. On UserPromptSubmit, Claude Code adds a hook's plain stdout (exit 0) to
// the session's context. Without it, an agent working in a watched folder may save its deliverables to a temp scratchpad or an artifact,
// where CoCheck sees nothing, and cannot open the review page when asked, because it does not know CoCheck exists.
import { existsSync } from "node:fs";
import path from "node:path";

/** The command that runs CoCheck's CLI from `root` (the folder holding `dist/`): `node <root>/scripts/cocheck.ts` from a source checkout, `cocheck` for a packaged install. The installer prints the same form. */
export function cliCommand(root: string): string {
  const script = path.join(root, "scripts", "cocheck.ts");
  return existsSync(script) ? `node ${script}` : "cocheck";
}

/** The context text for a session working in `folder`, the folder CoCheck watches for it. */
export function sessionContextText(folder: string, cli: string): string {
  return [
    "CoCheck is recording this session so the person can review the work.",
    `Files you create or change for this work belong inside ${folder}: CoCheck only sees files there, so do not save deliverables only to a temp or scratchpad folder or a published artifact (temporary scratch elsewhere is fine).`,
    `When the person asks to see the review or what was done, run \`${cli} open\`.`,
  ].join(" ");
}
