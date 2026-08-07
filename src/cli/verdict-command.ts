// `fabrica verdict` end to end: parse the ruling, hand it to the Foreman,
// and report plainly what happened - CONTRACT rule 6, and the one command
// SPEC.md needs before the Client can close the loop by hand.
//
// Unlike `fabrica do`, this never detaches: a "fix" verdict runs its
// worker round synchronously, so the command can report that round's
// number and outcome directly instead of the Client having to separately
// poll for it. There is no cap on how many rounds a task can have
// (issue #65) - see `fixRoundOf` for where the number comes from.

import { createForeman, fixRoundOf } from "../index.ts";
import type { Brain } from "../index.ts";
import { parseVerdictArgs, VERDICT_USAGE } from "./verdict-args.ts";
import { resolveRecordHome } from "./record-home.ts";

export const VERDICT_HELP = `Usage: ${VERDICT_USAGE}

Records the Client's ruling on a delivered task - the last word CONTRACT
rule 6 requires before a task can close. A task stays open and listed in
\`fabrica status\` until this is called.

  accept   The work is right. Closes the task.
  fix      Right direction, wrong details. The note becomes a correction
           handed back to the same warm worker on the same line. No limit
           on how many times you can rule fix; each round reports which
           one it is. The task stays open.
  wrong    Not what was wanted, and not worth correcting. Closes the
           task - a real outcome, not a failure of the system.

Options:
  -m "<note>"   Your note on the work, in the shape \`git commit -m\` uses.
                Optional for accept and wrong, required for fix - it is
                the correction the worker is handed.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunVerdictCommandOptions {
  recordHome?: string;
  /** Test-only: forwarded to createForeman so a test can run a real "fix"
   * round - the one path here that wakes a worker - against a fake brain.
   * Omitted, createForeman falls back to defaultBrainAdapter(), which is
   * what every real invocation does. */
  brain?: Brain;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Returns the process exit code - never throws. */
export async function runVerdictCommand(argv: string[], opts: RunVerdictCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    const { taskId, ruling, note } = parseVerdictArgs(argv);
    const recordHome = opts.recordHome ?? resolveRecordHome();
    const foreman = createForeman({ recordHome, brain: opts.brain });

    await foreman.verdict(taskId, ruling, note);

    if (ruling === "fix") {
      const delivery = await foreman.deliveryOf(taskId);
      const round = fixRoundOf(recordHome, taskId);
      stdout(
        `fix round ${round} recorded: ${taskId} ran again with your note - outcome: ${delivery?.outcome ?? "unknown"}. ` +
          `Still open; run \`fabrica verdict ${taskId} accept|fix|wrong\` once you've reviewed it.`
      );
    } else {
      stdout(`${ruling} recorded: ${taskId} is closed.`);
    }
    return 0;
  } catch (err) {
    // Anything at all, by its message - never a class list. A "fix"
    // reaches every layer Fabrica has (the CLI's own parsing, the
    // Foreman, the ProductionLine, config, the record, and whichever
    // brain adapter is wired in) and CONTRACT rule 8 makes that last one
    // pluggable, so the set of error types reachable here is not
    // knowable from this file. `verdict-recorded` is already on the
    // record by the time most of them can fire, so an escaped one would
    // replace an instruction the Client can act on with a stack trace,
    // on a task that then looks unruled. Nothing here branches on a
    // `code`, so nothing here needs the type.
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
