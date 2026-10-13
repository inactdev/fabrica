// `fabrica verdict` end to end: parse the ruling, hand it to the Foreman,
// and report plainly what happened - CONTRACT rule 6, and the one command
// SPEC.md needs before the Client can close the loop by hand.
//
// `accept` and `wrong` are instant (they only append a record event) and
// still run synchronously, reporting the outcome directly. `fix` (issue
// #123) returns immediately instead: the ruling is validated and
// recorded right here - a bad "fix" still fails on the spot - but the
// round itself (the same warm worker re-entering the same line) is
// handed to a detached process, the same mechanism `fabrica do` uses.
// There is no cap on how many rounds a task can have (issue #65) - see
// `fixRoundOf` for where the round number printed below comes from.

import { createForeman, fixRoundOf, recordVerdictDecision } from "../index.ts";
import { parseVerdictArgs, VERDICT_USAGE } from "./verdict-args.ts";
import { resolveRecordHome } from "./record-home.ts";
import { loadConfigOrDefault } from "./load-config.ts";
import { spawnDetachedResume } from "./spawn-detached.ts";

export const VERDICT_HELP = `Usage: ${VERDICT_USAGE}

Records the Client's ruling on a delivered task - the last word CONTRACT
rule 6 requires before a task can close. A task stays open and listed in
\`fabrica status\` until this is called.

  accept   The work is right. Closes the task.
  fix      Right direction, wrong details. The note becomes a correction
           handed back to the same warm worker on the same line, in the
           background - this command returns as soon as the ruling is
           recorded. No limit on how many times you can rule fix; each
           round reports which one it is. The task stays open; follow
           progress with \`fabrica log <id>\`/\`fabrica watch <id>\`.
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
  /** Test-only, "fix" only: forwarded to spawnDetachedResume so a test
   * can run a real fix round against a fake brain, the same way
   * do-command.test.ts uses entryScript. Omitted, the real default
   * entry script runs, which is what every real invocation does. */
  entryScript?: string;
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
    const caps = loadConfigOrDefault(recordHome).caps;

    // Validates and records the ruling right here, synchronously - a bad
    // ruling (an unknown task, an already-closed one, a missing note, a
    // cap refusal) fails on the spot, before anything is handed off to
    // the background.
    recordVerdictDecision(recordHome, taskId, ruling, note, { caps });

    if (ruling === "fix") {
      const round = fixRoundOf(recordHome, taskId);
      spawnDetachedResume({ recordHome, taskId, kind: "fix", entryScript: opts.entryScript });
      stdout(
        `fix round ${round} recorded: ${taskId} is running again with your note in the background. ` +
          `Follow progress with \`fabrica log ${taskId}\` or \`fabrica watch ${taskId}\`.`
      );
      return 0;
    }

    if (ruling === "accept") {
      const events = await createForeman({ recordHome, caps }).events(taskId);
      const prEvent = events.filter((e) => e.name === "pr-opened").at(-1);
      const url = (prEvent?.details as { url?: string } | undefined)?.url;
      stdout(`${ruling} recorded: ${taskId} is closed.${url ? ` pull request: ${url}` : ""}`);
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
