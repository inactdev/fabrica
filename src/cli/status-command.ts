// `fabrica status` (SPEC.md, issue #12): one line per OPEN task - id,
// project, state, age - with the one state the Client most needs to see
// flagged plainly: "delivered" means a task is sitting there waiting on
// his verdict (CONTRACT rule 6), and nothing else in this listing says
// that unless this command does.

import {
  capsActive,
  daySpend,
  describeTaskCost,
  describeUnmeasured,
  eventsByTask,
  formatUsd,
  hasAttempts,
  SPEND_UNKNOWN_LINE,
  stateOf,
  taskSpend,
  unmeasuredSpend,
} from "../index.ts";
import type { FabricaEvent } from "../index.ts";
import { CliError } from "./errors.ts";
import { loadConfigOrDefault } from "./load-config.ts";
import { resolveRecordHome } from "./record-home.ts";
import { describeLiveness, formatStatusLine, isDeadEnd, projectFromEvents, prUrlFromEvents } from "./render.ts";

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

This listing opens with the same number the daily cap check itself
uses - "spent in the last 24 hours: $X of $Y" when [caps].perDayUsd is
set, "$X, no daily cap" when it isn't - so the Client never has to add
up task lines by hand to see where that cap stands.

Every line carries the task's cost so far - "cost: unknown" when an
attempt's spend was never measured, never a silent $0. While a spending
cap is set, any unmeasured spend blocks all new work, and this listing
opens with "${SPEND_UNKNOWN_LINE}" and the \`fabrica cost\` command
that clears each one. That line is read from the record on every run,
so it stays until the real cost is recorded.

A blocked file-edit attempt (issue #13's off-the-books net) is not a
task and never appears as one here - the record's own
"project:<name>"/"project:unregistered" buckets for it are counted and
shown as one line at the bottom, "blocked edit attempts on record: N",
instead.

A task whose \`brain.ask()\` threw before any Worker ever ran has no \`fix\`
path back and never will again; it stays listed - marked "FAILED,
UNRESOLVABLE" and sorted after the entries still actually moving - rather
than vanishing or blending in with ordinary open work. An Inspector
refusal also sorts after live work, but says Inspector reached no verdict:
it is neither a failure nor a quiet task.

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
    const { caps } = loadConfigOrDefault(recordHome);

    // One pass over events.jsonl for the whole listing. Asking the
    // Foreman for the task list and then for each task's events would
    // re-read and re-parse the entire log once per open task.
    const byTask = eventsByTask(recordHome);
    const allEvents = [...byTask.values()].flat();

    // Issues #81/#110: the same number the daily cap check itself derives
    // (caps.ts's requireRoomToStart), so this never drifts from what
    // actually gates new work.
    stdout(formatDaySpendLine(daySpend(allEvents, now).knownUsd, caps.perDayUsd));

    // Rule 10 (issue #11, Client ruling 2026-10-08): derived from the
    // record on every run, closed tasks included, so the block survives
    // a restart and is shown until the real cost is recorded.
    const unmeasured = capsActive(caps) ? unmeasuredSpend(allEvents) : [];
    if (unmeasured.length > 0) {
      stdout(SPEND_UNKNOWN_LINE);
      for (const line of describeUnmeasured(unmeasured)) stdout(`  ${line}`);
    }

    // Issues #81/#110: a blocked file-edit attempt is recorded against a
    // "project:<name>"/"project:unregistered" bucket (offbooks/blocked-
    // edit.ts) - never a real task, so it never belongs in this listing.
    const blockedEditCount = [...byTask.entries()]
      .filter(([id]) => id.startsWith(PHANTOM_TASK_PREFIX))
      .reduce((sum, [, events]) => sum + events.filter((e) => e.name === "edit-attempt-blocked").length, 0);

    const openTasks = Array.from(byTask, ([id, events]) => ({
      task: { id, state: stateOf(events) },
      events,
      hasDelivery: events.some((e) => e.name === "delivered"),
    })).filter(({ task }) => !task.id.startsWith(PHANTOM_TASK_PREFIX) && task.state !== "closed");

    if (openTasks.length === 0) {
      stdout("No open tasks.");
    } else {
      // Dead-end tasks sort after the entries still actually moving, so a
      // reader scanning top-down sees real open work first. isDeadEnd is
      // the one definition shared with render.ts's marker, so an ask
      // failure and an Inspector refusal with no verdict cannot drift from
      // this sort order.
      const sorted = [...openTasks].sort((a, b) => {
        const aDeadEnd = isDeadEnd(a.task.state, a.hasDelivery);
        const bDeadEnd = isDeadEnd(b.task.state, b.hasDelivery);
        return aDeadEnd === bDeadEnd ? 0 : aDeadEnd ? 1 : -1;
      });

      for (const { task, events, hasDelivery } of sorted) {
        const project = projectFromEvents(events);
        const firstEvent = events[0];
        const ageMs = firstEvent ? now - new Date(firstEvent.occurredAt).getTime() : 0;
        const liveness = describeLiveness(task.state, events, now);

        const cost = describeTaskCost(taskSpend(events, task.id), hasAttempts(events, task.id));
        const failedBecause = refusedByCap(events)
          ? "a spending cap refused it before any work started"
          : taskFailedMessage(events);
        stdout(formatStatusLine(task, { project, ageMs, liveness, hasDelivery, cost, failedBecause, prUrl: prUrlFromEvents(events) }));
      }
    }

    if (blockedEditCount > 0) stdout(`blocked edit attempts on record: ${blockedEditCount}`);

    return 0;
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** `src/offbooks/blocked-edit.ts`'s own taskId key for a blocked edit
 * attempt - "project:<name>" or "project:unregistered". No real task is
 * ever keyed this way, so it's the exact, documented way to tell a
 * phantom bucket apart from an ordinary task id. */
const PHANTOM_TASK_PREFIX = "project:";

/** Issues #81/#110: the one line this listing opens with - the same
 * `knownUsd` the daily cap check (`caps.ts`'s `requireRoomToStart`)
 * derives from `daySpend`, so this can never say something different
 * from what actually gates new work. */
function formatDaySpendLine(knownUsd: number, perDayUsd: number | undefined): string {
  const spent = formatUsd(knownUsd);
  return perDayUsd === undefined
    ? `spent in the last 24 hours: ${spent}, no daily cap`
    : `spent in the last 24 hours: ${spent} of ${formatUsd(perDayUsd)}`;
}

function refusedByCap(events: FabricaEvent[]): boolean {
  return events.some((e) => e.name === "cap-refused") && !events.some((e) => e.name === "work-started");
}

/** #73: the reason a task failed before any delivery, as recorded. */
function taskFailedMessage(events: FabricaEvent[]): string | undefined {
  const failed = events.filter((e) => e.name === "task-failed").at(-1);
  const message = (failed?.details as { message?: string } | undefined)?.message;
  return message === undefined ? undefined : `the task failed: ${message.split("\n")[0]}`;
}
