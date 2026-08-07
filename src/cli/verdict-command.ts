// `fabrica verdict` end to end: parse the ruling, hand it to the Foreman,
// and report plainly what happened - CONTRACT rule 6, and the one command
// SPEC.md needs before the Client can close the loop by hand.
//
// Unlike `fabrica do`, this never detaches: a "fix" verdict runs its one
// extra worker attempt synchronously, so the command can report its
// outcome directly instead of the Client having to separately poll for it.

import { ConfigError, createForeman, DeliveryError, ForemanError, LineError } from "../index.ts";
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
    // Every layer a verdict reaches, not just the two nearest ones: a
    // "fix" reopens a ProductionLine (LineError), resolves the project's
    // check command from projects.toml (ConfigError), and validates the
    // delivery it builds (DeliveryError). All four of these speak the
    // Client directly, and `verdict-recorded` is already on the record by
    // the time any of them can fire - so an escaped one would replace an
    // instruction the Client can act on with a stack trace, on a task
    // that then looks unruled.
    if (
      err instanceof CliError ||
      err instanceof ForemanError ||
      err instanceof LineError ||
      err instanceof ConfigError ||
      err instanceof DeliveryError
    ) {
      stderr(err.message);
      return 1;
    }
    throw err;
  }
}
