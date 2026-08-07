// Parses the arguments after `fabrica answer` (SPEC.md: `fabrica answer
// <id> -m "<text>"`). One positional and one required flag - matching
// do-args.ts and verdict-args.ts's style of refusing with exact
// instructions rather than guessing. `-m` is the one way to pass the
// answer (Client ruling): it is `git commit -m`'s shape, the same shape
// `fabrica verdict` already uses for the other place the Client types
// free prose, and unlike a bare positional it takes an answer starting
// with a dash (`-1 means unlimited`) without mistaking it for a flag.

import { CliError } from "./errors.ts";

export const ANSWER_USAGE = 'fabrica answer <taskId> -m "<text>"';

export interface AnswerArgs {
  taskId: string;
  text: string;
}

export function parseAnswerArgs(argv: string[]): AnswerArgs {
  let text: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-m") {
      const value = argv[++i];
      if (value === undefined) {
        throw new CliError("bad-usage", `fabrica answer: -m needs an answer. Usage: ${ANSWER_USAGE}`);
      }
      text = value;
    } else if (arg.startsWith("-")) {
      throw new CliError("bad-usage", `fabrica answer: unknown flag "${arg}". Usage: ${ANSWER_USAGE}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) {
    throw new CliError("bad-usage", `fabrica answer: missing <taskId>. Usage: ${ANSWER_USAGE}`);
  }
  if (positionals.length > 1) {
    throw new CliError(
      "bad-usage",
      `fabrica answer: got ${positionals.length} positional arguments, expected just a taskId. ` +
        `Your answer is passed with -m, quoted: ${ANSWER_USAGE}`
    );
  }

  const [taskId] = positionals;
  if (text === undefined || text.trim().length === 0) {
    throw new CliError(
      "bad-usage",
      `fabrica answer: an answer needs actual text. Usage: fabrica answer ${taskId} -m "<text>"`
    );
  }

  return { taskId, text };
}
