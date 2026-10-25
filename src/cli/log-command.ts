// `fabrica log <id>` (SPEC.md, issue #12): the task's full event history,
// in order - the record's own words, not a summary of them. `--transcript`
// additionally prints the worker's raw transcript entries, oldest first.

import { createForeman, readTranscript } from "../index.ts";
import { CliError } from "./errors.ts";
import { LOG_USAGE, parseLogArgs } from "./log-args.ts";
import { resolveRecordHome } from "./record-home.ts";
import { formatEventLines, formatTranscriptLine } from "./render.ts";

export const LOG_HELP = `Usage: ${LOG_USAGE}

Prints one task's full event history, in order, rendered readably rather
than as raw stored data. A consecutive run of heartbeats collapses into
one line ("14 heartbeats over 3m") so a long stretch of liveness pings
doesn't bury the real events around it.

A long message - a failure's reason, say - is printed whole, wrapped to
the terminal's width and indented under its own event, never cut off
part-way through. Only a genuinely huge payload is shortened, and that
line says so, with how much of it you are seeing.

Every attempt's receipt line and every delivery line carries the
change's own fingerprint - a \`git patch-id\` of the branch's diff
against where it forks from origin's default branch, so a rebase
leaves it alone and only a real change moves it. A delivery after the
first also says how it compares with the pass before it, and names
plainly when a change makes every earlier Inspector stamp, check
result and CI conclusion on the task void.

A task with no Inspector reads the mode it will be judged in, right
where that was decided (before any work started): "check mode:
self-tested, not independently checked - no .inspector.json at the task
base commit". Nothing is skipped there - that is the only check the task
gets. A task Inspector did judge says so in its own events, where
Inspector was called and where it answered.

  <taskId>       The task to show. See \`fabrica status\` for open ids.
  --transcript   Also print the worker's raw transcript, oldest first.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunLogCommandOptions {
  recordHome?: string;
  /** What width to soft-wrap a long event detail at (issue #169).
   * Omitted means "work it out": the real terminal's width when this is
   * really writing to one, and no wrapping otherwise. Pass `null` for no
   * wrapping explicitly. */
  wrapWidth?: number | null;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** The terminal's width, or null if stdout isn't a terminal - a piped or
 * redirected `fabrica log` is read by something other than a pair of
 * eyes, and reflowing it to whatever width this window happens to have
 * would make its output unreproducible for no one's benefit. */
function detectWrapWidth(): number | null {
  if (!process.stdout.isTTY) return null;
  const columns = process.stdout.columns;
  return typeof columns === "number" && columns > 0 ? columns : null;
}

/** Returns the process exit code - never throws. */
export async function runLogCommand(argv: string[], opts: RunLogCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    const { taskId, transcript } = parseLogArgs(argv);
    const recordHome = opts.recordHome ?? resolveRecordHome();
    const foreman = createForeman({ recordHome });

    const events = await foreman.events(taskId);
    if (events.length === 0) {
      throw new CliError(
        "unknown-task",
        `fabrica log: no task "${taskId}" in this record. Check the id with \`fabrica status\`.`
      );
    }

    // Wrapping is a property of the terminal being written to, so it is
    // only inferred when this really is the one writing to it: a caller
    // that brought its own `stdout` gets unwrapped output, stable
    // whatever size the window running it happens to be.
    const wrapWidth = opts.wrapWidth !== undefined ? opts.wrapWidth : opts.stdout ? null : detectWrapWidth();
    for (const line of formatEventLines(events, { wrapWidth })) stdout(line);

    if (transcript) {
      const entries = readTranscript(recordHome, taskId);
      stdout("");
      stdout(entries.length === 0 ? "--- transcript: nothing written yet ---" : "--- transcript ---");
      for (const entry of entries) stdout(formatTranscriptLine(entry));
    }

    return 0;
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
