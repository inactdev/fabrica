// `fabrica status` (SPEC.md, issue #12): one line per OPEN task - id,
// project, state, age - with the one state the Client most needs to see
// flagged plainly: "delivered" means a task is sitting there waiting on
// his verdict (CONTRACT rule 6), and nothing else in this listing says
// that unless this command does.

import {
  capsActive,
  daySpend,
  deliveredBranchOf,
  deliveredFingerprintOf,
  describeBaseStandingOf,
  describeFingerprint,
  describeMeters,
  describeModel,
  describeTaskCost,
  describeUnmeasured,
  earlyStopKindOf,
  eventsByTask,
  formatUsd,
  hasAttempts,
  latestMeterReading,
  loadConfigOrProblem,
  meterPauseOf,
  modelFromEvents,
  readerFailureCount,
  refusalFor,
  shadowCountsLine,
  SPEND_UNKNOWN_LINE,
  standingOf,
  stateOf,
  taskSpend,
  unmeasuredSpend,
} from "../index.ts";
import type { MeterStanding, PauseRule } from "../index.ts";
import { CliError } from "./errors.ts";
import { resolveRecordHome } from "./record-home.ts";
import {
  checkModeFromEvents,
  checksSummaryFromEvents,
  describeLiveness,
  expectsWorkerProcess,
  formatStatusLine,
  isDeadEnd,
  projectFromEvents,
  prUrlFromEvents,
  readFromEvents,
  testMapNoteFromEvents,
} from "./render.ts";
import { cachedProcessTable, probeTaskWorker } from "./task-process.ts";

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

Every line names the model that did the work - the real one the worker
reported, not a placeholder. A task that asked for a particular model
(\`fabrica do --model\`, or a project's own \`model\` in projects.toml)
shows that declaration beside it, so a worker that ran something else is
visible rather than assumed: "model: small-5 (declared via --model)".
Before the first attempt has reported one it reads "not reported yet".

Every line also carries what the repository's own checks said about that
task's pull request - "CI: 5 green, rehearsal red". Those are the checks
GitHub runs on the pull request after Inspector has published it, read
once by the round itself and shown here from the record; a task whose
pull request has not been read says nothing about CI rather than
implying there were none. A check that never finished within the round's
bounded wait reads as "unknown", never as green.

Every delivered task also names which mode actually checked it, since a
green reached by Inspector's own independent run and a green the worker
gave itself are very different claims: "checked by Inspector",
"self-tested, not independently checked", "not checked - nothing ran"
(no Inspector and no check ever ran - a round that went red on its own
write-up, or whose box could not run the check at all), or "check mode
unknown" for a record that says neither. That line is never left off -
a missing one would read as nothing to say.

A delivered task whose branch no longer contains origin's default tip
is marked "behind origin/<branch>, a fix will rebase" - the rebase a
\`fix\` verdict already performs before its round starts. That reading is
taken from this machine's own git refs and writes nothing, so it is only
as current as the last fetch (which Fabrica itself does when it cuts a
line and before every fix round); the mark says how long ago that was.
When it cannot be read at all - no "origin" remote, origin/HEAD unset,
the branch or the project gone - the line says "base unknown: <reason>"
rather than quietly implying the branch is current.

Every delivered task also carries a fingerprint of the change itself -
a \`git patch-id\` of the branch's own diff against where it forks from
origin's default branch, which stays the same when the branch is
rebased and changes only when the change does. A later round says how
it compares: "fingerprint 1f84653, unchanged since pass 1", or
"fingerprint 9ab20c4, changed from pass 1 (1f84653) - every earlier
Inspector stamp, check result and CI conclusion on this task is void".
Void means exactly that and nothing more: those observations were made
about a different change, so they say nothing about this one. Your own
verdict is never blocked by it, and verdicts, quiz results and the
clarify step's answers are never voided - they are not observations of
the change. A task that was already on the record before fingerprints
existed reads "fingerprint unstamped", and is never stamped after the
fact.

For a task whose round should have a process running it, that process
is really looked for - its own pid file, verified against what is
actually running - instead of liveness being read off the record alone.
A task nothing is running says so plainly, "worker process not found",
in place of any quiet notice; one whose round started before Fabrica
recorded worker pids says "liveness unknown (started before pid files)"
rather than claiming either way. Nothing here is written back to the
record, and neither reading changes this command's exit code.

This listing opens with the same number the daily cap check itself
uses - "spent in the last 24 hours: $X of $Y" when [caps].perDayUsd is
set, "$X, no daily cap" when it isn't - so the Client never has to add
up task lines by hand to see where that cap stands. A flat-rate
subscription's own notional figure (e.g. the reference adapter's Max
plan) is never folded into that $X: it's named separately, with a "~",
as "(+ ~$Z subscription-estimate, not counted against the cap)" - real,
metered dollars are the only thing the cap ever binds on.

A second opening line carries the two subscription meters (issue #189) -
"subscription meters: 5h 7%, 7d 64%" - with the pause rule's own
thresholds beside them, because a flat-rate subscription's windows cost
no dollars and so nothing in the line above can show them. When the
7-day window is past its refuse threshold, that line says new work is
paused; when no usable reading exists at all, it says so and that the
rule is therefore refusing nothing. A task a meter stopped mid-round is
listed like any other delivery - it waits on your fix verdict - with the
pause named on its own line.

Every line carries the task's cost so far - "cost: unknown" when an
attempt's spend was never measured, never a silent $0. While a spending
cap is set, any unmeasured spend blocks all new work, and this listing
opens with "${SPEND_UNKNOWN_LINE}" and the \`fabrica cost\` command
that clears each one. That line is read from the record on every run,
so it stays until the real cost is recorded.

A third opening line appears for a record home whose projects have skip
rules (issue #204): "skip rules (shadow, nothing closes): 12 would have
closed, 11 you accepted, 1 you did not". Shadow mode only - no task has
ever closed by rule, and every one of those still waited on your
verdict. \`fabrica shadow-report\` breaks the same numbers down per
project and kind. Absent entirely when no project has a rules file.

A projects.toml that will not parse is printed on this listing's very
first line - the file's path, the line the parser stopped on, and what it
objected to - and the listing then runs anyway: tasks come from the
record, which needs no config. Without that line the caps would read as
"no cap set", which is what an unreadable config looks like from here and
is not the same thing at all. (\`fabrica do\`, \`answer\` and \`verdict\`
refuse outright on the same file - they spend money; this only reports.)

Every delivered task also says what the code reader made of its diff -
"code reader flagged 2 things, 1 declined by the worker (<model>)", or
"code reader found nothing to flag (<model>)". The reader runs once per
task, on the whole diff, after Inspector turns it green; it never blocks
and never approves, so this is information for your verdict, not a
judgement on it. A reader that could not run at all says so instead
("code reader failed (<model>): ..."), and every such failure across the
record is also counted at the bottom, "code reads that failed, on
record: N" - a reader that cannot run is usually one fact about this
machine, not N facts about N tasks.

A question this task asked that it had already been answered once is
never put to the Client twice (issue #175, "the first answer wins"): it
is answered from the record, and the task's line says how many times
that happened - "N question(s) answered from the record".

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
it is neither a failure nor a quiet task. Both of these are still waiting
on you, same as a delivered task - \`fabrica verdict <id> wrong\` closes
either one, named right on its own line.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunStatusCommandOptions {
  recordHome?: string;
  now?: number;
  /** Replaces the real process table behind the worker-liveness check
   * (issue #99) - tests hand this a table of their own making instead
   * of needing a real detached worker on the machine running them. */
  listProcesses?: () => { pid: number; args: string }[];
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

    // A projects.toml that will not parse is said out loud, on this
    // listing's very first line, and then the listing runs anyway: the
    // tasks come from the record, which needs no config at all, and a
    // broken config file is no reason to stop showing the Client his own
    // work (Client ruling). What it IS a reason for is never being
    // silent - the caps below read as "no cap set" while that file is
    // unreadable, and without this line that would look like a
    // deliberate configuration rather than a parse error. `fabrica
    // do`/`answer`/`verdict` still refuse outright on the same file
    // (src/cli/load-config.ts's loadConfigOrDefault, which throws) -
    // they spend money; this one only reports.
    const { config, problem } = loadConfigOrProblem(recordHome);
    if (problem) stdout(problem.message);
    const { caps } = config;

    // One pass over events.jsonl for the whole listing. Asking the
    // Foreman for the task list and then for each task's events would
    // re-read and re-parse the entire log once per open task.
    const byTask = eventsByTask(recordHome);
    const allEvents = [...byTask.values()].flat();

    // Issues #81/#110: the same number the daily cap check itself derives
    // (caps.ts's requireRoomToStart), so this never drifts from what
    // actually gates new work.
    stdout(formatDaySpendLine(daySpend(allEvents, now), caps.perDayUsd));

    // Issue #189: the two subscription meters, right under the money -
    // read with the same functions the pause rule itself decides with
    // (`latestMeterReading`/`standingOf`/`refusalFor`), so this listing
    // can never show a number that disagrees with what actually gates
    // new work. A flat-rate subscription's windows cost no dollars, so
    // nothing above this line can show them.
    stdout(formatMetersLine(standingOf(latestMeterReading(allEvents), now), config.pause));

    // Issue #204, shadow mode: what the skip rules would have done, as
    // one count line - the same string the live view's header shows,
    // from the same function, so the terminal and the phone can never
    // disagree. Null (and so no line at all) for a record home where no
    // project has a rules file: there is nothing to report, and "0 would
    // have closed" would imply a file that exists and is doing nothing.
    const shadowLine = shadowCountsLine(byTask, now);
    if (shadowLine !== null) stdout(shadowLine);

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
    })).filter(
      ({ task }) =>
        !task.id.startsWith(PHANTOM_TASK_PREFIX) &&
        task.state !== "closed" &&
        // Issue #203: the Client's own stop is as resolved as a closed
        // verdict - he decided it, nothing is expected of him, and the
        // task cannot move again. Listed under "open tasks" it would be
        // the one line on this listing asking nothing of anyone. The
        // live view's /history page is where it stays visible.
        task.state !== "stopped"
    );

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

      // Issue #99: one process table for the whole listing, read lazily
      // and at most once - `probeTaskWorker` would otherwise spawn a real
      // `ps -A` per open task, and a record home with a dozen open tasks
      // would pay for a dozen of them on every `fabrica status`.
      const processTable = cachedProcessTable(opts.listProcesses);

      for (const { task, events, hasDelivery } of sorted) {
        const project = projectFromEvents(events);
        const firstEvent = events[0];
        const ageMs = firstEvent ? now - new Date(firstEvent.occurredAt).getTime() : 0;
        // Issue #99: for a task whose round should have a process
        // running it, say what a real look at that process found, rather
        // than leaving the Client with a quiet notice that cannot tell a
        // slow worker from a dead one. Reporting only - nothing here
        // writes to the record, and a task whose worker is gone still
        // leaves this command's exit code at 0 (Client ruling), since
        // the listing is a report, not a check.
        const worker = expectsWorkerProcess(task.state, events)
          ? probeTaskWorker(recordHome, task.id, { listProcesses: processTable })
          : null;
        const liveness = describeLiveness(task.state, events, now, worker);

        const cost = describeTaskCost(taskSpend(events, task.id), hasAttempts(events, task.id));
        // The exact same reason the phone review page shows for this same
        // task (record-view.ts's getReviewRows) - both read it from this
        // one function so they can never disagree (issue #202 follow-up).
        const stop = earlyStopKindOf(events);
        const failedBecause = stop?.kind === "failed" ? stop.reason : undefined;
        const refusalReason = stop?.kind === "refused" ? stop.reason : undefined;
        // Issue #189: a paused task is "delivered" (it waits on the
        // Client's own fix verdict), so its line has to name what it is
        // waiting for or it reads like any other delivery.
        const pausedByMeter = meterPauseOf(recordHome, task.id)?.message;
        // Where the delivered branch stands against origin's default
        // branch - the one thing on this line that is read from git
        // rather than from the record, because the record cannot know
        // it: origin moves while a task works, and a `fix` would rebase
        // onto it first (issue #235). Local refs only, nothing written,
        // and only for a delivered task - the single state where that
        // `fix` is the Client's live option. The same string the live
        // view shows, from the same function.
        const baseStanding =
          task.state === "delivered" ? describeBaseStandingOf(project, deliveredBranchOf(events), now) : null;
        // What the change being offered for a verdict hashes to, and
        // whether it is the one the task's previous pass was checked
        // at - read straight off the record, in the same wording
        // `fabrica log` and `delivery.md` use. Shown only for a
        // delivered task, the one state where a change is actually
        // being handed over; a changed fingerprint says the Inspector
        // stamp and CI result on this same line were made about
        // something else.
        const deliveredStamp = task.state === "delivered" ? deliveredFingerprintOf(events) : null;
        const fingerprint =
          deliveredStamp === null
            ? null
            : describeFingerprint(deliveredStamp.fingerprint, deliveredStamp.fingerprintMatch);
        stdout(
          formatStatusLine(task, {
            project,
            ageMs,
            liveness,
            hasDelivery,
            cost,
            // Issue #184: which model did (or is doing) the work, in the
            // one wording `fabrica log` and the live view also use - read
            // off the same events this listing already holds.
            model: describeModel(modelFromEvents(events)),
            failedBecause,
            refusalReason,
            prUrl: prUrlFromEvents(events),
            baseStanding,
            fingerprint,
            // Issue #267: what the repository's own checks said about this
            // task's pull request, read off the record like everything else
            // on this line.
            checksSummary: checksSummaryFromEvents(events),
            // What this task's touched files mapped to nothing in the
            // project's committed tests.map, and any mapping that names
            // a test file the project no longer has. Read off the
            // delivery the same way, and said out loud here rather than
            // left to `fabrica log` - a gap nobody is told about is a
            // gap nobody closes.
            testMapNote: testMapNoteFromEvents(events),
            // Issue #111: which mode judged this task - Inspector's own
            // independent run, or the worker checking itself. Read from
            // the same events this listing already holds; only a
            // delivered line shows it, and it always shows something.
            checkMode: checkModeFromEvents(events),
            // Inspector issue #34: what the code reader made of this
            // task's diff, read off the delivery this listing already
            // holds - the Client is being asked for a verdict on this
            // line, and this is what was already looked at.
            read: readFromEvents(events),
            // Issue #175: how many of this task's questions answered
            // themselves from the record rather than being put to the
            // Client twice - counted off the same events this listing
            // already holds.
            autoAnswered: events.filter((e) => e.name === "question-auto-answered").length,
            ...(pausedByMeter === undefined ? {} : { pausedByMeter }),
          })
        );
      }
    }

    if (blockedEditCount > 0) stdout(`blocked edit attempts on record: ${blockedEditCount}`);

    // Inspector issue #34, the Client's own clarification: a reader
    // failure is "counted". Counted across the whole record home rather
    // than per task, and shown next to the blocked-edit count for the
    // same reason that one is: a reader that cannot run is nearly always
    // one fact about this machine's configuration or a provider's
    // outage, not N separate facts about N tasks. Each task's own line
    // still says so individually; this is the number that makes a
    // pattern visible.
    const readerFailures = readerFailureCount(allEvents);
    if (readerFailures > 0) {
      stdout(`code reads that failed, on record: ${readerFailures} (see \`fabrica log <id>\` for each)`);
    }

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
 * `meteredUsd` the daily cap check (`caps.ts`'s `requireRoomToStart`)
 * derives from `daySpend`, so this can never say something different
 * from what actually gates new work. Issue #188: a nonzero subscription
 * estimate is named separately, with a "~", since it never counts
 * against the cap above it. */
function formatDaySpendLine(spend: { meteredUsd: number; subscriptionUsd: number }, perDayUsd: number | undefined): string {
  const spent = formatUsd(spend.meteredUsd);
  const base =
    perDayUsd === undefined
      ? `spent in the last 24 hours: ${spent}, no daily cap`
      : `spent in the last 24 hours: ${spent} of ${formatUsd(perDayUsd)}`;
  return spend.subscriptionUsd > 0
    ? `${base} (+ ~${formatUsd(spend.subscriptionUsd)} subscription-estimate, not counted against the cap)`
    : base;
}

/** Issue #189: the second line this listing opens with - both
 * subscription meters, and what the pause rule makes of them right now.
 * Says plainly when the reading is unusable, and why: a pause rule that
 * is currently refusing nothing must never look like one that is
 * watching (fail open, but never fail quiet). */
function formatMetersLine(standing: MeterStanding, rule: PauseRule): string {
  const base = `subscription meters: ${describeMeters(standing)}`;
  if (!standing.usable) return `${base} - the pause rule is refusing nothing: ${standing.unknownBecause}`;
  const refusal = refusalFor(standing, rule);
  if (refusal !== undefined) return `${base}  <- NEW WORK PAUSED: ${refusal.message}`;
  return `${base} (new work stops above ${rule.sevenDayRefusePercent}% of the week, running work above ${rule.sevenDayStopPercent}%)`;
}

