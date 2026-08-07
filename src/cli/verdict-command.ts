// `fabrica verdict` end to end: parse the ruling, hand it to the Foreman,
// and report plainly what happened - CONTRACT rule 6, and the one command
// SPEC.md needs before the Client can close the loop by hand.
//
// Unlike `fabrica do`, this never detaches: a "fix" verdict runs its one
// extra worker attempt synchronously, so the command can report its
// outcome directly instead of the Client having to separately poll for it.

import { createForeman, ForemanError } from "../index.ts";
import { CliError } from "./errors.ts";
import { parseVerdictArgs, VERDICT_USAGE } from "./verdict-args.ts";
import { resolveRecordHome } from "./record-home.ts";

export const VERDICT_HELP = `Usage: ${VERDICT_USAGE}

Records the Client's ruling on a delivered task - the last word CONTRACT
rule 6 requires before a task can close. A task stays open and listed in
\`fabrica status\` until this is called.

  accept   The work is right. Closes the task.
  fix      Right direction, wrong details. <note> becomes a correction
           handed back to the same warm worker on the same line, counted
           against this task's attempt budget. The task stays open.
  wrong    Not what was wanted, and not worth correcting. Closes the
           task - a real outcome, not a failure of the system.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunVerdictCommandOptions {
  recordHome?: string;
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
    const foreman = createForeman({ recordHome });

    await foreman.verdict(taskId, ruling, note);

    if (ruling === "fix") {
      const delivery = await foreman.deliveryOf(taskId);
      stdout(
        `fix recorded: ${taskId} ran again with your note - outcome: ${delivery?.outcome ?? "unknown"}. ` +
          `Still open; run \`fabrica verdict ${taskId} accept|fix|wrong\` once you've reviewed it.`
      );
    } else {
      stdout(`${ruling} recorded: ${taskId} is closed.`);
    }
    return 0;
  } catch (err) {
    if (err instanceof CliError || err instanceof ForemanError) {
      stderr(err.message);
      return 1;
    }
    throw err;
  }
}
