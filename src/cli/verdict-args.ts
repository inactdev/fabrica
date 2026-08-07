// Parses the arguments after `fabrica verdict` (SPEC.md: `fabrica verdict
// <id> <accept|fix|wrong> [-m "<note>"]`). Two positionals and one
// optional flag, required for "fix" - matching do-args.ts's style of
// refusing with exact instructions rather than guessing. `-m` is the one
// way to pass a note (Client ruling): it is `git commit -m`'s shape,
// already muscle memory, and a bare positional note would be a second
// spelling of the same thing.

import { CliError } from "./errors.ts";

export const VERDICT_USAGE = 'fabrica verdict <taskId> <accept|fix|wrong> [-m "<note>"]';

const RULINGS = ["accept", "fix", "wrong"] as const;
export type Ruling = (typeof RULINGS)[number];

export interface VerdictArgs {
  taskId: string;
  ruling: Ruling;
  note?: string;
}

export function parseVerdictArgs(argv: string[]): VerdictArgs {
  let note: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-m") {
      const value = argv[++i];
      if (value === undefined) {
        throw new CliError("bad-usage", `fabrica verdict: -m needs a note. Usage: ${VERDICT_USAGE}`);
      }
      note = value;
    } else if (arg.startsWith("-")) {
      throw new CliError("bad-usage", `fabrica verdict: unknown flag "${arg}". Usage: ${VERDICT_USAGE}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) {
    throw new CliError("bad-usage", `fabrica verdict: missing <taskId>. Usage: ${VERDICT_USAGE}`);
  }
  if (positionals.length === 1) {
    throw new CliError("bad-usage", `fabrica verdict: missing <accept|fix|wrong>. Usage: ${VERDICT_USAGE}`);
  }
  if (positionals.length > 2) {
    throw new CliError(
      "bad-usage",
      `fabrica verdict: got ${positionals.length} positional arguments, expected a taskId and a ruling. ` +
        `A note is passed with -m, quoted: ${VERDICT_USAGE}`
    );
  }

  const [taskId, rulingArg] = positionals;
  if (!(RULINGS as readonly string[]).includes(rulingArg)) {
    throw new CliError(
      "bad-usage",
      `fabrica verdict: "${rulingArg}" is not a verdict. Use one of: ${RULINGS.join(", ")}. Usage: ${VERDICT_USAGE}`
    );
  }
  const ruling = rulingArg as Ruling;

  if (ruling === "fix" && (note === undefined || note.trim().length === 0)) {
    throw new CliError(
      "bad-usage",
      `fabrica verdict: a "fix" needs a note saying what to change. ` +
        `Usage: fabrica verdict ${taskId} fix -m "<what to fix>"`
    );
  }

  return { taskId, ruling, note };
}
