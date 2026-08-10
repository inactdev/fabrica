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

  <taskId>       The task to show. See \`fabrica status\` for open ids.
  --transcript   Also print the worker's raw transcript, oldest first.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunLogCommandOptions {
  recordHome?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
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

    for (const line of formatEventLines(events)) stdout(line);

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
