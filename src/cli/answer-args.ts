// Parses the arguments after `fabrica answer` (SPEC.md: `fabrica answer
// <id> -m "<text>"`). One positional and one required flag - matching
// do-args.ts and verdict-args.ts's style of refusing with exact
// instructions rather than guessing. `-m` is the one way to pass the
// answer (Client ruling): it is `git commit -m`'s shape, the same shape
// `fabrica verdict` already uses for the other place the Client types
// free prose, and unlike a bare positional it takes an answer starting
// with a dash (`-1 means unlimited`) without mistaking it for a flag.
//
// Issue #359 added `--via-assistant`/`--by-client`: who the record should
// say typed this answer, overriding what the environment says on its own
// (assistant-session.ts).

import { CliError } from "./errors.ts";
import { QUESTION_ID_PATTERN } from "../index.ts";

export const ANSWER_USAGE =
  'fabrica answer <taskId> [--option <n>] [--question <id>] [-m "<text>"] [--via-assistant|--by-client]';

export interface AnswerArgs {
  taskId: string;
  text: string;
  /** Which of the question's options the Client picked, 1-based as
   * `fabrica do`/`fabrica status` list them (issue #176). Omitted means
   * "other", answered in his own words with -m - which is what this
   * command has always taken. */
  option?: number;
  /** Which question is being answered (issue #175). Omitted answers the
   * one the task is stopped on; naming one the task already answered is
   * a correction. */
  questionId?: string;
  /** Who the record should say typed this (issue #359). Omitted means
   * "work it out from the environment" - see `assistant-session.ts`'s
   * `ranViaAssistant`. */
  viaAssistant?: boolean;
}

export function parseAnswerArgs(argv: string[]): AnswerArgs {
  let text: string | undefined;
  let option: number | undefined;
  let questionId: string | undefined;
  let viaAssistant: boolean | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-m") {
      const value = argv[++i];
      if (value === undefined) {
        throw new CliError("bad-usage", `fabrica answer: -m needs an answer. Usage: ${ANSWER_USAGE}`);
      }
      text = value;
    } else if (arg === "-o" || arg === "--option") {
      const value = argv[++i];
      if (value === undefined) {
        throw new CliError("bad-usage", `fabrica answer: ${arg} needs an option number. Usage: ${ANSWER_USAGE}`);
      }
      // The number only - which option it names is the Foreman's call,
      // since only the record knows how many the question has.
      if (!/^[1-9][0-9]*$/.test(value)) {
        throw new CliError(
          "bad-usage",
          `fabrica answer: ${arg} takes the option's number as \`fabrica status\` lists it, got "${value}".`
        );
      }
      option = Number(value);
    } else if (arg === "--question") {
      const value = argv[++i];
      if (value === undefined) {
        throw new CliError("bad-usage", `fabrica answer: --question needs a question id. Usage: ${ANSWER_USAGE}`);
      }
      if (!QUESTION_ID_PATTERN.test(value)) {
        throw new CliError(
          "bad-usage",
          `fabrica answer: --question takes a question id as \`fabrica log\` shows it (q- then 12 hex ` +
            `characters), got "${value}".`
        );
      }
      questionId = value;
    } else if (arg === "--via-assistant" || arg === "--by-client") {
      // Same shape, same reasoning as verdict-args.ts's own pair: both
      // override the auto-detection, and passing both contradictory
      // spellings is a usage error rather than a precedence rule.
      const wanted = arg === "--via-assistant";
      if (viaAssistant !== undefined && viaAssistant !== wanted) {
        throw new CliError(
          "bad-usage",
          `fabrica answer: --via-assistant and --by-client say opposite things about who ran this - pass one.`
        );
      }
      viaAssistant = wanted;
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
  // An option number is an answer on its own; without one, the answer is
  // the Client's own words and there has to be some (issue #176: picking
  // "other" requires them).
  if (option === undefined && (text === undefined || text.trim().length === 0)) {
    throw new CliError(
      "bad-usage",
      `fabrica answer: an answer needs an option or actual text. ` +
        `Usage: fabrica answer ${taskId} --option <n>, or fabrica answer ${taskId} -m "<text>"`
    );
  }

  return {
    taskId,
    text: text ?? "",
    ...(option !== undefined ? { option } : {}),
    ...(questionId ? { questionId } : {}),
    ...(viaAssistant !== undefined ? { viaAssistant } : {}),
  };
}
