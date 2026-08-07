// `fabrica status` (SPEC.md, issue #12): one line per OPEN task - id,
// project, state, age - with the one state the Client most needs to see
// flagged plainly: "delivered" means a task is sitting there waiting on
// his verdict (CONTRACT rule 6), and nothing else in this listing says
// that unless this command does.

import { createForeman } from "../index.ts";
import { resolveRecordHome } from "./record-home.ts";
import { formatStatusLine, isQuietTooLong, lastActivityAt, projectFromEvents } from "./render.ts";

export const STATUS_HELP = `Usage: fabrica status

Lists every open task - one line each: id, project, state, age. A
"delivered" task is flagged as awaiting your verdict (\`fabrica verdict\`)
since nothing else tells you it's waiting. A "working"/"checking" task
with no recorded activity in a while is flagged "quiet" rather than
implying progress nobody has actually observed. A closed task (verdict
recorded) drops off this list - see \`fabrica log <id>\` for its history.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunStatusCommandOptions {
  recordHome?: string;
  now?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Returns the process exit code - never throws. */
export async function runStatusCommand(argv: string[], opts: RunStatusCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const now = opts.now ?? Date.now();

  const recordHome = opts.recordHome ?? resolveRecordHome();
  const foreman = createForeman({ recordHome });

  const openTasks = (await foreman.status()).filter((task) => task.state !== "closed");

  if (openTasks.length === 0) {
    stdout("No open tasks.");
    return 0;
  }

  for (const task of openTasks) {
    const events = await foreman.events(task.id);
    const project = projectFromEvents(events);
    const firstEvent = events[0];
    const ageMs = firstEvent ? now - new Date(firstEvent.occurredAt).getTime() : 0;
    const quiet = isQuietTooLong(task.state, events, now);
    const last = lastActivityAt(events);
    const quietForMs = quiet && last ? now - last.getTime() : null;

    stdout(formatStatusLine(task, { project, ageMs, quietForMs }));
  }

  return 0;
}
