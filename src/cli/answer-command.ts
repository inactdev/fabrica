// `fabrica answer` end to end (issue #8): hand the Client's answer to the
// Foreman and report what happened next.
//
// Like `fabrica verdict fix`, this never detaches: resuming runs the
// same isolate/work/verify/deliver pipeline `fabrica do` would have run
// if the task had never needed to ask, synchronously, so the command can
// report the outcome directly instead of the Client having to separately
// poll for it.

import { createForeman } from "../index.ts";
import type { Brain } from "../index.ts";
import { parseAnswerArgs, ANSWER_USAGE } from "./answer-args.ts";
import { resolveRecordHome } from "./record-home.ts";

export const ANSWER_HELP = `Usage: ${ANSWER_USAGE}

Answers the clarifying questions \`fabrica do\` printed and stopped on,
and resumes the task: the brief is extended with your answer, and the
task runs exactly as it would have if it had never needed to ask. One
clarification round - the ask-first dial is fixed at "ask" for v1, so
this can't be called again for the same task.

  <taskId>   The task's id, from \`fabrica do\`'s output.
  -m <text>  Your answer, in plain words. Quote it. Same shape as
             \`fabrica verdict -m\`, so an answer starting with a dash
             ("-1 means unlimited") goes through as written.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunAnswerCommandOptions {
  recordHome?: string;
  /** Test-only: forwarded to createForeman so a test can resume a real
   * round against a fake brain. Omitted, createForeman falls back to
   * defaultBrainAdapter(), what every real invocation does. */
  brain?: Brain;
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
    const foreman = createForeman({ recordHome, brain: opts.brain });

    await foreman.answer(taskId, text);

    // answerTask always runs the full pipeline to completion before
    // resolving (runProductionRound, same as do()) - the resulting task
    // is always "delivered" or "failed", never "asking" again (v1's
    // ask-first dial is fixed, so this never re-asks).
    const delivery = await foreman.deliveryOf(taskId);
    stdout(
      `${taskId} resumed with your answer - outcome: ${delivery?.outcome ?? "unknown"}. ` +
        `Run \`fabrica verdict ${taskId} accept|fix|wrong\` once you've reviewed it.`
    );
    return 0;
  } catch (err) {
    // Anything at all, by its message - never a class list, matching
    // verdict-command.ts's own reasoning: the set of error types
    // reachable here (CLI parsing, the Foreman, the ProductionLine,
    // config, the record, and whichever brain adapter is wired in,
    // CONTRACT rule 8) isn't knowable from this file, and nothing here
    // branches on a `code`.
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
