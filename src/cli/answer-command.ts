// `fabrica answer` end to end (issue #8): hand the Client's answer to the
// Foreman and report what happened next.
//
// Like `fabrica do` (issue #123), this returns immediately: the answer
// is validated and recorded right here, synchronously - a bad answer
// still fails on the spot - but the round it resumes (the same isolate/
// work/verify/inspect/result pipeline `fabrica do` would have run if the
// task had never needed to ask) is handed to a detached process, the
// same mechanism `fabrica do` itself uses. Progress is followed through
// the record (`fabrica log`/`status`/`watch`), not this command's own
// exit code.

import { recordAnswerDecision } from "../index.ts";
import { parseAnswerArgs, ANSWER_USAGE } from "./answer-args.ts";
import { resolveRecordHome } from "./record-home.ts";
import { loadConfigOrDefault } from "./load-config.ts";
import { spawnDetachedResume } from "./spawn-detached.ts";

export const ANSWER_HELP = `Usage: ${ANSWER_USAGE}

Answers the clarifying questions \`fabrica do\` printed and stopped on,
and resumes the task: the brief is extended with your answer, and the
task runs exactly as it would have if it had never needed to ask, in the
background - this command returns as soon as the answer is recorded,
the same way \`fabrica do\` returns once a task is registered. Follow
progress with \`fabrica log <id>\`/\`fabrica watch <id>\`. One
clarification round - the ask-first dial is fixed at "ask" for v1 - so
once a round has completed with a delivery or Inspector refusal, this
refuses to run again for the same task. A round that threw before either
result is not spent: call
this again to retry it (the same error comes back until whatever
caused it is dealt with).

  <taskId>   The task's id, from \`fabrica do\`'s output.
  -m <text>  Your answer, in plain words. Quote it. Same shape as
             \`fabrica verdict -m\`, so an answer starting with a dash
             ("-1 means unlimited") goes through as written.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunAnswerCommandOptions {
  recordHome?: string;
  /** Test-only: forwarded to spawnDetachedResume so a test can resume a
   * real round against a fake brain, the same way do-command.test.ts
   * uses entryScript. Omitted, the real default entry script runs,
   * which is what every real invocation does. */
  entryScript?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Returns the process exit code - never throws. */
export async function runAnswerCommand(argv: string[], opts: RunAnswerCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    const { taskId, text } = parseAnswerArgs(argv);
    const recordHome = opts.recordHome ?? resolveRecordHome();
    const caps = loadConfigOrDefault(recordHome).caps;

    // Validates and records the answer right here, synchronously - a bad
    // answer (an unknown task, no question pending, an already-spent
    // round, a cap refusal) fails on the spot, before anything is handed
    // off to the background.
    recordAnswerDecision(recordHome, taskId, text, { caps });

    spawnDetachedResume({ recordHome, taskId, kind: "answer", entryScript: opts.entryScript });

    stdout(
      `${taskId} resumed with your answer - running in the background. ` +
        `Follow progress with \`fabrica log ${taskId}\` or \`fabrica watch ${taskId}\`.`
    );
    return 0;
  } catch (err) {
    // Anything at all, by its message - never a class list, matching
    // verdict-command.ts's own reasoning: the set of error types
    // reachable here (CLI parsing, the Foreman, config, the record)
    // isn't knowable from this file, and nothing here branches on a
    // `code`.
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
