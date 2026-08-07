// Parses the arguments after `fabrica verdict` (CONTRACT rule 6:
// `fabrica verdict <taskId> <accept|fix|wrong> ["<note>"]`). Three
// positionals, the last optional except for "fix" - matching do-args.ts's
// style of refusing with exact instructions rather than guessing.

import { CliError } from "./errors.ts";

export const VERDICT_USAGE = 'fabrica verdict <taskId> <accept|fix|wrong> ["<note>"]';

const RULINGS = ["accept", "fix", "wrong"] as const;
export type Ruling = (typeof RULINGS)[number];

export interface VerdictArgs {
  taskId: string;
  ruling: Ruling;
  note?: string;
}

export function parseVerdictArgs(argv: string[]): VerdictArgs {
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      throw new CliError("bad-usage", `fabrica verdict: unknown flag "${arg}". Usage: ${VERDICT_USAGE}`);
    }
    positionals.push(arg);
  }

  if (positionals.length === 0) {
    throw new CliError("bad-usage", `fabrica verdict: missing <taskId>. Usage: ${VERDICT_USAGE}`);
  }
  if (positionals.length === 1) {
    throw new CliError("bad-usage", `fabrica verdict: missing <accept|fix|wrong>. Usage: ${VERDICT_USAGE}`);
  }
  if (positionals.length > 3) {
    throw new CliError(
      "bad-usage",
      `fabrica verdict: got ${positionals.length} positional arguments, expected a taskId, a ruling, and ` +
        `an optional note. Wrap the note in quotes: ${VERDICT_USAGE}`
    );
  }

  const [taskId, rulingArg, note] = positionals;
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
      `fabrica verdict: a "fix" needs a note saying what to change. Usage: fabrica verdict ${taskId} fix "<what to fix>"`
    );
  }

  return { taskId, ruling, note };
}
