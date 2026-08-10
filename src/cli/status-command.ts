// `fabrica status` (SPEC.md, issue #12): one line per OPEN task - id,
// project, state, age - with the one state the Client most needs to see
// flagged plainly: "delivered" means a task is sitting there waiting on
// his verdict (CONTRACT rule 6), and nothing else in this listing says
// that unless this command does.

import { eventsByTask, stateOf } from "../index.ts";
import { CliError } from "./errors.ts";
import { resolveRecordHome } from "./record-home.ts";
import { checkStartedAt, formatStatusLine, isQuietTooLong, lastActivityAt, projectFromEvents } from "./render.ts";

export const STATUS_USAGE = "fabrica status";

export const STATUS_HELP = `Usage: ${STATUS_USAGE}

Lists every open task - one line each: id, project, state, age. A
"delivered" task is flagged as awaiting your verdict (\`fabrica verdict\`)
since nothing else tells you it's waiting. A "checking" task shows its
real elapsed time ("checking, 2m so far") instead of an alarm - the
check itself has a known start time, so there's no need to guess - up to
a long ceiling (4 hours), past which it gets its own alarm ("checking,
4h and still not finished") rather than implying progress nobody has
actually observed. A "working" task with no recorded activity in a while
is flagged "quiet" the same way, including the brief window before its
worker has even started (its own, much shorter ceiling, since a real
answer from the brain arrives in well under a minute). A closed task
(verdict recorded) drops off this list - see \`fabrica log <id>\` for its
history.

A task whose \`brain.ask()\` threw before any Worker ever ran has no \`fix\`
path back and never will again; it stays listed - marked "FAILED,
UNRESOLVABLE" and sorted after the entries still actually moving - rather
than vanishing or blending in with ordinary open work.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunStatusCommandOptions {
  recordHome?: string;
  now?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** `fabrica status` takes nothing: no flags, no positionals. Anything
 * given is refused with the exact usage line rather than ignored, the
 * same way log-args.ts and watch-args.ts refuse - a silently swallowed
 * `--json` reads as a supported flag that did nothing. */
export function parseStatusArgs(argv: string[]): void {
  const [first] = argv;
  if (first === undefined) return;
  if (first.startsWith("-")) {
    throw new CliError("bad-usage", `fabrica status: unknown flag "${first}". Usage: ${STATUS_USAGE}`);
  }
  throw new CliError(
    "bad-usage",
    `fabrica status: unexpected argument "${first}" - status takes none. ` +
      `Usage: ${STATUS_USAGE}, or \`fabrica log <taskId>\` for one task.`
  );
}

/** Returns the process exit code - never throws. */
export async function runStatusCommand(argv: string[], opts: RunStatusCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));
  const now = opts.now ?? Date.now();

  try {
    parseStatusArgs(argv);
    const recordHome = opts.recordHome ?? resolveRecordHome();

    // One pass over events.jsonl for the whole listing. Asking the
    // Foreman for the task list and then for each task's events would
    // re-read and re-parse the entire log once per open task.
    const openTasks = Array.from(eventsByTask(recordHome), ([id, events]) => ({
      task: { id, state: stateOf(events) },
      events,
      hasDelivery: events.some((e) => e.name === "delivered"),
    })).filter(({ task }) => task.state !== "closed");

    if (openTasks.length === 0) {
      stdout("No open tasks.");
      return 0;
    }

    // Dead-end (ask-failed) tasks sort after the entries still actually
    // moving, so a reader scanning top-down sees real open work first -
    // see formatStatusLine's "FAILED, UNRESOLVABLE" branch for why they
    // stay listed at all rather than being dropped (issue #12 review
    // finding, Client ruling).
    const sorted = [...openTasks].sort((a, b) => {
      const aDeadEnd = a.task.state === "failed" && !a.hasDelivery;
      const bDeadEnd = b.task.state === "failed" && !b.hasDelivery;
      return aDeadEnd === bDeadEnd ? 0 : aDeadEnd ? 1 : -1;
    });

    for (const { task, events, hasDelivery } of sorted) {
      const project = projectFromEvents(events);
      const firstEvent = events[0];
      const ageMs = firstEvent ? now - new Date(firstEvent.occurredAt).getTime() : 0;
      const quiet = isQuietTooLong(task.state, events, now);
      const last = lastActivityAt(events);
      const quietForMs = quiet && last ? now - last.getTime() : null;
      const checkStarted = task.state === "checking" ? checkStartedAt(events) : null;
      const checkingForMs = checkStarted ? now - checkStarted.getTime() : null;
      const hadHeartbeat = events.some((e) => e.name === "heartbeat");

      stdout(formatStatusLine(task, { project, ageMs, quietForMs, checkingForMs, hadHeartbeat, hasDelivery }));
    }

    return 0;
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
