// Parses the arguments after `fabrica answer` (SPEC.md: `fabrica answer
// <id> "<text>"`). Two positionals, no flags - matching do-args.ts and
// verdict-args.ts's style of refusing with exact instructions rather
// than guessing.

import { CliError } from "./errors.ts";

export const ANSWER_USAGE = 'fabrica answer <taskId> "<text>"';

export interface AnswerArgs {
  taskId: string;
  text: string;
}

export function parseAnswerArgs(argv: string[]): AnswerArgs {
  const positionals: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("-")) {
      throw new CliError("bad-usage", `fabrica answer: unknown flag "${arg}". Usage: ${ANSWER_USAGE}`);
    }
    positionals.push(arg);
  }

  if (positionals.length === 0) {
    throw new CliError("bad-usage", `fabrica answer: missing <taskId>. Usage: ${ANSWER_USAGE}`);
  }
  if (positionals.length === 1) {
    throw new CliError("bad-usage", `fabrica answer: missing "<text>". Usage: ${ANSWER_USAGE}`);
  }
  if (positionals.length > 2) {
    throw new CliError(
      "bad-usage",
      `fabrica answer: got ${positionals.length} positional arguments, expected a taskId and your answer. ` +
        `Wrap the answer in quotes: ${ANSWER_USAGE}`
    );
  }

  const [taskId, text] = positionals;
  if (text.trim().length === 0) {
    throw new CliError("bad-usage", `fabrica answer: the answer text can't be empty. Usage: ${ANSWER_USAGE}`);
  }

  return { taskId, text };
}
