// `cocheck harness <sub>`: the commands for a person adding an agent harness. Each subcommand is its own module.
import { runHarnessTest } from "./test.ts";

/** Where a command writes: a piece of output and a piece of error, each given without a trailing newline (the caller adds one per call). */
export interface HarnessIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** The folder relative paths are read against. Default: the current folder. */
  cwd?: string;
  /** Aborted by the caller on an interrupt; `record` stops its child and finishes. */
  signal?: AbortSignal;
}

export const HARNESS_USAGE = `usage:
  cocheck harness create <key> [--dir <path>]
  cocheck harness record <key> --manifest <path> --out <dir> [--timeout <seconds>] [-- <harness command...>]
  cocheck harness record --stop <scratch>
  cocheck harness test --cases <dir> [--manifest <path>]`;

/** Runs one `cocheck harness` command (the words after `harness`); resolves to the exit code. */
export async function runHarnessCommand(args: string[], io: HarnessIo): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "create") return (await import("./create.ts")).runHarnessCreate(rest, io);
  if (sub === "record") return (await import("./record.ts")).runHarnessRecord(rest, io);
  if (sub === "test") return runHarnessTest(rest, io);
  io.err(sub === undefined ? HARNESS_USAGE : `unknown harness command ${JSON.stringify(sub)}\n${HARNESS_USAGE}`);
  return sub === undefined ? 2 : 1;
}
