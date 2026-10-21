// Shared rendering for status/log/watch (issue #12): these are the
// Client's eyes on the tool, so the same age/quiet/label logic must read
// identically everywhere it shows up rather than three slightly different
// home-grown formats.

import { DEFAULT_HEARTBEAT_INTERVAL_MS, formatUsd } from "../index.ts";
import type { FabricaEvent, FabricaTask, TranscriptEntry } from "../index.ts";
import type { WorkerPresence } from "./task-process.ts";

/** Longer than this since the last recorded event on a still-working task,
 * and silence stops meaning "progress" and starts meaning "quiet too long"
 * (issue #12) - three missed heartbeats' worth of margin absorbs a single
 * slow tick without crying wolf. */
export const QUIET_THRESHOLD_MS = DEFAULT_HEARTBEAT_INTERVAL_MS * 3;

/** "Checking" is exempt from the ordinary quiet alarm - Fabrica knows
 * exactly what it's doing (see `isQuietTooLong` below) - but not forever.
 * Past this, checking becomes eligible for the alarm too. This is NOT a
 * guess at how long a check "should" take - there is no such number; a
 * real project's own test suite can legitimately run for a long time,
 * and this constant must stay well clear of that or it starts crying
 * wolf on honest work, exactly the failure mode the exemption itself
 * exists to prevent. Its only job is catching the case a live-elapsed
 * reading genuinely can't explain: the detached worker was killed
 * (machine reboot, OOM) or the check itself hung while blocked inside
 * the worker's box, so the record's last event stays a
 * `"check-run"` with `phase: "started"` forever, with no matching
 * finish ever coming. Client ruling (issue #12 review finding) is
 * explicit that this is a time ceiling, not process-liveness detection
 * (checking whether the detached worker's PID is still alive would be
 * the better root-cause fix, but that is a separate issue, not this
 * one). Do NOT "tidy" this number down to match `QUIET_THRESHOLD_MS` or
 * anything else already in this file - it is deliberately a different
 * order of magnitude, for a different, much rarer failure. */
export const CHECKING_QUIET_CEILING_MS = 4 * 60 * 60 * 1000; // 4 hours

/** The pre-work window's own ceiling - the same ruling as
 * CHECKING_QUIET_CEILING_MS ("no state may be exempt from the quiet alarm
 * forever"), applied to its sibling gap: `stateOf` reports "working" from
 * `task-received` onward, but nothing is appended between it and
 * `"work-started"` except `"line-cut"`, so a machine reboot or OOM while
 * `brain.ask()` is running (or during `createProductionLine`, right
 * after `ask()` returns) would otherwise freeze the record there forever
 * with the alarm never firing. Client ruling (issue #12 review finding):
 * size THIS window to its own realistic duration, not to
 * CHECKING_QUIET_CEILING_MS's - `wait-for-ask-outcome.ts` gives the CLI's
 * own wait for an outcome 60s before it gives up (the detached process
 * keeps going regardless, so a real `ask()` call can still legitimately
 * run somewhat past that), which is nothing like a project's own test
 * suite, which can legitimately run for hours. Do NOT harmonize this
 * with CHECKING_QUIET_CEILING_MS - they guard different windows with
 * genuinely different realistic durations: collapsing them to one value
 * either makes this one too loose (missing a real reboot/OOM for
 * minutes) or the checking one too tight (crying wolf on an honest slow
 * test suite). */
export const PRE_WORK_QUIET_CEILING_MS = 5 * 60 * 1000; // 5 minutes

/** The project a task is running against, read from whichever event last
 * carried it (`work-started`/`delivered` details). The only implementation
 * of that lookup: it takes events the caller already holds, so `status`
 * never re-reads events.jsonl per task just to name the project. */
export function projectFromEvents(events: FabricaEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const details = events[i].details as { project?: string } | undefined;
    if (details?.project) return details.project;
  }
  return null;
}

/** The URL of the pull request Inspector opened, from the last "pr-opened"
 * event carrying one - null when none has landed yet. Mirrors
 * projectFromEvents: a fix round can hand off to Inspector again, so the
 * latest event wins rather than the first. */
export function prUrlFromEvents(events: FabricaEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].name !== "pr-opened") continue;
    const details = events[i].details as { url?: string } | undefined;
    if (details?.url) return details.url;
  }
  return null;
}

/** The most recent moment anything was recorded for this task - any event
 * counts as activity, heartbeats included. Null for a task with no events
 * at all (never happens for a real task; only for defensive callers). */
export function lastActivityAt(events: FabricaEvent[]): Date | null {
  if (events.length === 0) return null;
  return new Date(events[events.length - 1].occurredAt);
}

/** When the check currently running started, or null when the task isn't
 * mid-check. A "check-run" event now lands twice per attempt - once with
 * `details.phase === "started"` right before the check runs (see
 * attempts.ts's `onCheckStarted`), once with its result once it finishes -
 * so the latest "started" one, if nothing has finished since, is a real
 * recorded start time, not a guess (the Client's own call on issue #12's
 * quiet-detection finding: say what it's doing, don't estimate). */
export function checkStartedAt(events: FabricaEvent[]): Date | null {
  let startedAt: Date | null = null;
  for (const event of events) {
    if (event.name !== "check-run") continue;
    const details = event.details as { phase?: string } | undefined;
    startedAt = details?.phase === "started" ? new Date(event.occurredAt) : null;
  }
  return startedAt;
}

/** True for a task genuinely mid brain.work() whose silence has run past
 * QUIET_THRESHOLD_MS, a task "checking" whose check has run past
 * CHECKING_QUIET_CEILING_MS, or a pre-work task (see
 * PRE_WORK_QUIET_CEILING_MS) whose silence since task-received has run
 * past that window's own ceiling - a delivered, failed, refused, or
 * closed task is finished rather than quiet. Client ruling
 * (issue #12 review finding): no state stays exempt forever - "checking"
 * and the pre-work window both get their own long-but-finite ceilings
 * instead of an unconditional pass, each sized to that window's own
 * realistic duration (see each constant's own comment for why). Below
 * its ceiling, "checking" stays exempt: Fabrica knows exactly what it's
 * doing and since when (checkStartedAt), so status/watch say that
 * plainly instead of raising an alarm about a silence that has a known,
 * honest explanation. The pre-work window is the same idea applied to the
 * gap between `"task-received"` and `"work-started"` - nothing else is
 * appended there except `"line-cut"`, and a `"work-started"` event
 * marks the moment a genuinely silent worker becomes distinguishable
 * from a `brain.ask()` call (or the `createProductionLine` step right
 * after it) simply still being in flight. */
export function isQuietTooLong(state: FabricaTask["state"], events: FabricaEvent[], now: number = Date.now()): boolean {
  if (isDeadEnd(state, events.some((event) => event.name === "delivered"))) return false;
  if (state === "checking") {
    const startedAt = checkStartedAt(events);
    return startedAt !== null && now - startedAt.getTime() > CHECKING_QUIET_CEILING_MS;
  }
  if (state !== "working") return false;
  const last = lastActivityAt(events);
  if (!last) return false;
  const elapsed = now - last.getTime();
  const hasWorkStarted = events.some((e) => e.name === "work-started");
  return elapsed > (hasWorkStarted ? QUIET_THRESHOLD_MS : PRE_WORK_QUIET_CEILING_MS);
}

/** True exactly when a real process ought to be running this task's
 * round right now, so `status`/`watch` may go and look for it (issue
 * #99). Two conditions, both necessary:
 *
 * - the state is one a worker is mid-round in ("working" or
 *   "checking"); every other state - delivered, closed, asking, failed,
 *   refused, stopped - is one where the round has ended or never
 *   started, and whose pid file therefore names a process that exited
 *   for a perfectly ordinary reason. Looking there would turn every
 *   finished task into a "worker process not found" alarm.
 * - THIS round's `"work-started"` has landed. A `"verdict-recorded"`
 *   (the Client's `fix`) or `"answers-given"` after the last
 *   `"work-started"` means the next round has been decided but its
 *   detached process may not have started - and the pid file still
 *   names the previous round's long-exited one, which is exactly the
 *   false "not found" this condition exists to prevent. It is also the
 *   Client's own ruling for the first round, where there is no earlier
 *   pid file to be fooled by either: a task before `work-started` is
 *   not judged at all.
 */
export function expectsWorkerProcess(state: FabricaTask["state"], events: FabricaEvent[]): boolean {
  if (state !== "working" && state !== "checking") return false;
  // A single forward pass, same shape as stateOf's - the question is
  // which of these landed LAST, not whether each ever happened.
  let roundStarted = false;
  for (const event of events) {
    if (event.name === "work-started") roundStarted = true;
    else if (event.name === "verdict-recorded" || event.name === "answers-given") roundStarted = false;
  }
  return roundStarted;
}

/** Compact, human age like "3s", "12m", "4h15m", "2d3h" - dense enough for
 * a one-line-per-task status listing. */
export function formatAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) return remMinutes > 0 ? `${totalHours}h${remMinutes}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

/** One line for `fabrica status` - dense, scannable, and honest: a
 * delivered task is flagged as awaiting the Client's verdict (the single
 * most important thing status has to surface, per issue #12), a task mid-
 * check says so plainly with its real elapsed time, and a working task
 * gone quiet too long says so instead of implying progress nobody has
 * actually observed. */
export function formatStatusLine(
  task: FabricaTask,
  opts: {
    project: string | null;
    ageMs: number;
    liveness: string | null;
    hasDelivery: boolean;
    /** Rule 10: the task's cost in one phrase ("$0.0421", "unknown",
     * "no attempts yet") - omitted, the line says nothing about cost. */
    cost?: string;
    /** Why a failed task with no delivery never started, when it was not
     * the brain's clarify step (e.g. a spending cap refused it). The exact
     * same string `earlyStopKindOf` (queries.ts) hands the phone review
     * page for the same task, so the two can never disagree (issue #202
     * follow-up). */
    failedBecause?: string;
    /** Set only for an Inspector refusal with no delivery behind it
     * (`earlyStopKindOf`'s "refused" case) - Inspector's own report, shown
     * plainly instead of the generic liveness label, alongside the one
     * verdict ("wrong") that closes it. Omitted for the rarer case where a
     * later refusal supersedes an earlier real delivery: that one has all
     * three rulings open to it (`fix` included - it hands the refusal's
     * reason to the worker), and names them on its own line below, with
     * the reason itself left to `fabrica log`. */
    refusalReason?: string;
    /** The pull request Inspector opened, if any - shown once, on a
     * delivered task's own line, never implied for any other state. */
    prUrl?: string | null;
    /** Issue #189: set when this task's latest round was stopped by a
     * subscription meter and nothing has moved it since
     * (`meterPauseOf`). A paused task is "delivered" - it waits on the
     * Client's own `fix` verdict, exactly like any other delivery, and
     * is explicitly never a failure - so without this the line would
     * say it is waiting without saying what for. */
    pausedByMeter?: string;
  }
): string {
  const project = opts.project ?? "unknown project";
  const age = formatAge(opts.ageMs);
  const base = `${task.id}  ${project}  ${task.state}  ${age} old${opts.cost === undefined ? "" : `  cost: ${opts.cost}`}`;

  if (task.state === "delivered") {
    const pr = opts.prUrl ? `  pull request: ${opts.prUrl}` : "";
    if (opts.pausedByMeter !== undefined) {
      return (
        `${base}  <- PAUSED BY THE SUBSCRIPTION METER: ${opts.pausedByMeter} - nothing restarts by itself: ` +
        `\`fabrica verdict ${task.id} fix\` continues it${pr}`
      );
    }
    return `${base}  <- AWAITING YOUR VERDICT: fabrica verdict ${task.id} accept|fix|wrong${pr}`;
  }
  if (isDeadEnd(task.state, opts.hasDelivery)) {
    if (task.state === "failed") {
      // isDeadEnd's "failed" branch is exactly `failedWithNoDelivery`
      // (queries.ts), so this is always closeable by "wrong" (issue #143) -
      // no separate flag needed the way the refused branch below needs one.
      const because = opts.failedBecause ?? "brain's clarify step threw before any work started";
      return `${base}  <- FAILED, UNRESOLVABLE: ${because} - see \`fabrica log ${task.id}\` - \`fabrica verdict ${task.id} wrong\` closes it`;
    }
    if (opts.refusalReason !== undefined) {
      return `${base}  <- INSPECTOR REACHED NO VERDICT: ${opts.refusalReason} - \`fabrica verdict ${task.id} wrong\` closes it (see \`fabrica log ${task.id}\`)`;
    }
    if (task.state === "refused" && opts.hasDelivery) {
      // A refusal with a real delivery behind it is the one dead-end
      // state the Client's own ruling still moves: `fix` re-enters the
      // worker with the refusal's reason as its correction, and
      // accept/wrong rule on that earlier delivery. Said here rather
      // than left to the generic line below, which named no command at
      // all and read as "nothing to be done but go and look".
      return (
        `${base}  <- INSPECTOR REACHED NO VERDICT: \`fabrica verdict ${task.id} fix\` runs the worker again ` +
        `with the refusal as its correction; accept|wrong rule on the last delivery (see \`fabrica log ${task.id}\`)`
      );
    }
    return `${base}  <- ${(opts.liveness ?? "Inspector reached no verdict").toUpperCase()}: fabrica log ${task.id}`;
  }
  // Whatever describeLiveness decided - "checking, 2m so far", a quiet
  // alarm (whichever wording fits), or nothing - is exactly what shows
  // up here. This function no longer decides that itself: it used to,
  // and `watch-command.ts` independently re-derived the identical
  // decision beside it, and the two had already drifted apart once
  // (issue #12 review finding) before being caught.
  return opts.liveness ? `${base}  <- ${opts.liveness}` : base;
}

/** The one definition of a task that cannot move again in its current
 * round: `brain.ask()` failed before delivery, or Inspector reached no
 * verdict. It keeps status sorting, terminal notices, quiet detection,
 * and watch's exit condition aligned.
 *
 * "In its current round" is the whole of it - a refusal with a real
 * delivery behind it is still the Client's to rule `fix` on, which
 * starts a fresh round (src/foreman/verdict.ts). What each case can
 * actually be ruled is said in the notices above, not here. */
export function isDeadEnd(state: FabricaTask["state"], hasDelivery: boolean): boolean {
  return state === "refused" || (state === "failed" && !hasDelivery);
}

/** The one wording for an ordinary "working" task gone quiet, shared by
 * `status` and `watch` so the Client reads the same sentence in both - it
 * says what is known (nothing has been recorded for this long, and what
 * that last recording actually was) and refuses to imply anything past
 * that. `lastSignal` names the one thing this is anchored to - always
 * the record's literal last event, never a separate "did X ever happen"
 * query (issue #12 review finding: the wording used to pair an elapsed
 * time read from the last event with a fact - "did a heartbeat ever
 * happen, anywhere in the history" - read from a different query over
 * the whole history; those two could disagree, and this is the third
 * finding of that exact shape on this branch. See `nameLastSignal` for
 * where the label comes from). */
export function formatQuietNotice(elapsedMs: number, lastSignal: string): string {
  return `quiet ${formatAge(elapsedMs)}, no signal since ${lastSignal} - not known to be stuck, not known to be fine`;
}

/** A short label for what the record's last event actually was, for
 * `formatQuietNotice` - "last heartbeat", "work started", "the check
 * finished," and so on. This is deliberately the ONLY place that reads
 * `event.name` to produce that label: `describeLiveness` passes it the
 * literal last event, never asks a separate "has a heartbeat ever
 * landed" (or any other "ever, anywhere") question. The set covered is
 * exhaustive for a "working" task's last event (verified against
 * `stateOf`'s switch in `src/foreman/queries.ts`). An Inspector refusal
 * is the one terminal liveness case, named below before a quiet reading:
 * `task-received` and
 * `line-cut` are the only things that can land before `work-started`
 * (the pre-work window), `heartbeat` and a finished `check-run` are the
 * only things that can land after it without changing the state away
 * from "working" (a `check-run` with `phase: "started"` produces
 * "checking" instead, handled by `describeLiveness`'s other branch, so
 * it never reaches here), and `answers-given` covers the one-clarifying-
 * round case (issue #8) where the Client's answer landed before the
 * ProductionLine was even cut. The fallback is defensive only - every
 * event that can reach here while "working" is named above. */
function nameLastSignal(event: FabricaEvent): string {
  switch (event.name) {
    case "heartbeat":
      return "last heartbeat";
    case "work-started":
      return "work started";
    case "check-run":
      return "the check finished";
    case "inspection-finished": {
      const details = event.details as { verdict?: string } | undefined;
      return details?.verdict === "refused" ? "Inspector reached no verdict" : "Inspector finished";
    }
    case "answers-given":
      return "the answer was recorded";
    case "line-cut":
      return "the line was cut";
    case "task-received":
      return "the task was received";
    default:
      return event.name;
  }
}

/** The wording for a "checking" task whose check has run past
 * CHECKING_QUIET_CEILING_MS - names what's actually known (a check that
 * started this long ago and has not finished) instead of reusing
 * `formatQuietNotice`'s "no signal since <the record's last event>":
 * during a check that last event is the check's own `"started"` one -
 * nothing else lands there, since `attempts.ts`'s heartbeat interval
 * only wraps `brain.work`, never the check - and `nameLastSignal`
 * would label it "the check finished", which is precisely what has not
 * happened (issue #12 review finding, Client ruling). */
export function formatCheckingQuietNotice(elapsedMs: number): string {
  return `checking, ${formatAge(elapsedMs)} and still not finished - not known to be stuck, not known to be fine`;
}

/** The one wording for a task whose worker's process has been looked
 * for and is not there (issue #99) - the Client's own phrase, "worker
 * process not found", plus the two things that follow from it. Unlike
 * every other notice in this file it is not hedged, because this one is
 * not an inference from silence: the task's own pid file was read and
 * the pid it names is not running one of Fabrica's task runners, so
 * nothing is left to append to this task's record.
 *
 * It deliberately names no command to run. Every other terminal-ish
 * notice here points at one the tool will actually accept, and for this
 * case there is none: a "working" task has no delivery, so
 * `fabrica verdict <id> wrong` would be refused as "not-delivered".
 * Pointing the Client at a command that bounces would be worse than
 * pointing him nowhere.
 *
 * The elapsed time is "nothing has been recorded for this long", the
 * same quantity `formatQuietNotice` reports - but, deliberately, with
 * no `nameLastSignal` label on it: during a check the record's last
 * event is the check's own `"started"` one, which that function labels
 * "the check finished", and a dead worker's check is precisely what
 * never finished. */
export function formatWorkerGoneNotice(elapsedMs: number): string {
  return (
    `worker process not found - nothing is running this task and nothing has been recorded for ` +
    `${formatAge(elapsedMs)}; it cannot move again on its own`
  );
}

/** Shown when the worker's process could not be looked for at all
 * (`WorkerPresence`'s "unknown") - the Client's own wording, and
 * deliberately a caveat appended to whatever the record already said
 * rather than a replacement for it: with no reading to go on, the
 * record is still the best available account, and this says only that
 * it was not confirmed against a real process. In practice this is a
 * round that started before Fabrica wrote per-task pid files. */
export const WORKER_LIVENESS_UNKNOWN_NOTICE = "liveness unknown (started before pid files)";

/** What to say about a task's liveness right now - "checking, 2m so
 * far" for a check genuinely still in progress, the quiet alarm past a
 * ceiling (whichever wording fits: `formatCheckingQuietNotice` for
 * "checking", `formatQuietNotice` otherwise), an Inspector refusal's
 * no-verdict outcome, or null when neither applies. The one definition
 * of that decision AND the elapsed-time
 * arithmetic under it - `checkStartedAt` for "checking", the record's
 * literal last event otherwise (read inline, see below), since those are
 * different quantities that only coincide by accident (a heartbeat
 * landing after a check starts doesn't change `stateOf`'s "checking"
 * verdict). `status` and `watch` used to each derive this
 * independently - once here, once hand-inlined in
 * `watch-command.ts` - and the two had already drifted apart once
 * (issue #12 review finding) before being caught; this is the fix for
 * that whole class of bug, not just the one instance. Callers that need
 * to tell "worth re-printing as time passes" (checking-in-progress)
 * apart from "worth printing once per transition" (the quiet alarm)
 * already have `state` and can call `isQuietTooLong` themselves for
 * that - this function only ever answers "what does it look like,"
 * never "when to show it again."
 *
 * Issue #99 adds the one fact that is not in the record at all: whether
 * the worker's own process is still running (`worker`, a
 * `WorkerPresence` from `probeTaskWorker`). It belongs HERE, not in the
 * two commands, for exactly the reason above - `status` and `watch` have
 * to read the same sentence - so the commands decide only whether to
 * take that reading (`expectsWorkerProcess`) and when to print it. */
export function describeLiveness(
  state: FabricaTask["state"],
  events: FabricaEvent[],
  now: number,
  /** What a real look at the worker's own process found (issue #99), or
   * null for "no look was taken" - either the caller doesn't check (it
   * has no record home to check against) or `expectsWorkerProcess` said
   * this task's round has no process to look for. Null keeps the
   * record-only wording this function produced before issue #99, so a
   * caller that passes nothing is unaffected. */
  worker: WorkerPresence | null = null
): string | null {
  if (isDeadEnd(state, events.some((event) => event.name === "delivered"))) {
    if (state !== "refused") return null;
    const last = events[events.length - 1];
    return last ? nameLastSignal(last) : "Inspector reached no verdict";
  }

  // Issue #99: a verified reading of the worker's own process outranks
  // everything derived from the record below, because it answers the
  // one question those sentences have to leave open ("not known to be
  // stuck, not known to be fine"). It is not combined with them either:
  // once nothing is running the task, "quiet 3m" and "checking, 2m so
  // far" are both descriptions of a wait that has already ended.
  if (worker === "not-found") {
    const last = events[events.length - 1];
    return formatWorkerGoneNotice(last ? now - new Date(last.occurredAt).getTime() : 0);
  }

  const fromRecord = describeLivenessFromRecord(state, events, now);
  if (worker !== "unknown") return fromRecord;
  // No reading to add, so the record's own account stands and only
  // carries the caveat that it is unconfirmed.
  return fromRecord ? `${fromRecord} - ${WORKER_LIVENESS_UNKNOWN_NOTICE}` : WORKER_LIVENESS_UNKNOWN_NOTICE;
}

/** Everything `describeLiveness` can say from the record alone - the
 * whole of what it said before issue #99 gave it a real process reading
 * to prefer. Split out so that reading can take precedence over this
 * (or caveat it) in one place, rather than being threaded through each
 * of these branches. */
function describeLivenessFromRecord(state: FabricaTask["state"], events: FabricaEvent[], now: number): string | null {
  if (state === "checking") {
    const startedAt = checkStartedAt(events);
    if (startedAt === null) return null; // defensive: shouldn't happen for a real task
    const elapsed = now - startedAt.getTime();
    return isQuietTooLong(state, events, now) ? formatCheckingQuietNotice(elapsed) : `checking, ${formatAge(elapsed)} so far`;
  }
  if (!isQuietTooLong(state, events, now)) return null;
  // Read from the record's literal last event, once - its name and its
  // own timestamp - never a separate query over the whole history. That
  // was the actual bug in the last two rounds' fixes: "how long since
  // anything happened" (lastActivityAt) and "what kind of thing last
  // happened" (an "ever, anywhere" query like events.some(heartbeat))
  // were two independently-derived facts that could disagree, so every
  // round one pair got fixed and the next pair broke. There's nothing
  // left to disagree with once both come from the same event object.
  const last = events[events.length - 1];
  if (!last) return null; // defensive: shouldn't happen for a real task
  const elapsed = now - new Date(last.occurredAt).getTime();
  return formatQuietNotice(elapsed, nameLastSignal(last));
}

/** What `fabrica watch` prints when a task reaches a state nothing
 * further is expected from, so a stream that simply stops is never
 * mistaken for a hang - null for a state the worker is still moving
 * through. Every branch names an action the tool will actually accept:
 * a task that failed before it ever delivered has no `fix` path at all
 * (`recordVerdict` refuses it with "not-delivered"), so it is worded
 * apart from the delivered/failed-delivery case rather than pointing the
 * Client at a command that would be rejected. An Inspector refusal
 * splits the same way, on whether a delivery sits behind it: with one,
 * `fix` is accepted and hands the refusal's reason to the worker; with
 * none, only `wrong` is. */
export function formatTerminalNotice(
  state: FabricaTask["state"],
  ctx: { taskId: string; hasDelivery: boolean }
): string | null {
  if (isDeadEnd(state, ctx.hasDelivery)) {
    if (state === "refused") {
      // With a delivery behind it, the refusal is the loop's to clear,
      // not the Client's to go and resolve by hand: `fix` hands the
      // reason to the same warm worker (src/foreman/verdict.ts). With no
      // delivery behind it there is nothing to fix, and "wrong" is the
      // one ruling that closes it.
      return ctx.hasDelivery
        ? `-- Inspector reached no verdict - \`fabrica verdict ${ctx.taskId} fix\` runs the worker again with that reason as its correction; accept|wrong rule on the last delivery --`
        : `-- Inspector reached no verdict and nothing was ever delivered, so there is nothing to fix - \`fabrica verdict ${ctx.taskId} wrong\` closes it; \`fabrica log ${ctx.taskId}\` has the reason --`;
    }
    return (
      `-- task failed before any work started - the brain's clarify step threw, so nothing was ever ` +
      `delivered and there is no \`fix\` path; \`fabrica log ${ctx.taskId}\` has the reason --`
    );
  }

  switch (state) {
    case "delivered":
      return `-- task delivered - nothing more expected on this transcript unless a \`fix\` verdict wakes the worker again --`;
    case "failed":
      return `-- task failed - nothing more expected on this transcript unless a \`fix\` verdict wakes the worker again --`;
    case "closed":
      // Rule 6: closed means the Client's verdict is recorded and final -
      // unlike "delivered", there is no fix path left to reopen this one.
      return "-- task closed - your verdict is recorded; nothing more will ever land on this transcript --";
    case "asking":
      // Stopped for clarifying questions before any Worker ran (issue #8)
      // - polling forever here would look like a hang with no way out.
      return `-- task asking - stopped for clarifying questions; answer with \`fabrica answer ${ctx.taskId} -m "<text>"\` to resume it --`;
    case "stopped":
      // Issue #203: the Client stopped it himself. Terminal, and
      // deliberately not worded as a failure or as something to resolve
      // - the decision was his, and nothing is being asked of him.
      return "-- task stopped by you - the worker's process was signaled; nothing more will land on this transcript --";
    default:
      return null;
  }
}

/** A generic fallback for an event name this file has no specific
 * rendering for (an unimplemented one like "cap-refused", or a future one
 * this file hasn't been taught yet) - compact JSON, but capped, so an
 * event nobody anticipated can never repeat the same unbounded-line
 * mistake a specific renderer was written to fix. */
const FALLBACK_DETAIL_LIMIT = 200;
function fallbackDetail(details: unknown): string {
  const json = JSON.stringify(details);
  return json.length > FALLBACK_DETAIL_LIMIT ? `${json.slice(0, FALLBACK_DETAIL_LIMIT)}…` : json;
}

/** What `fabrica log` shows for one event's `details` - readable prose,
 * judged per event name, never the stored object dumped raw (issue #12,
 * Client ruling): a Client re-reading this constantly needs "what
 * happened", not punctuation. The two events known to carry unbounded
 * text - "delivered" (a receipt's full check stdout+stderr can run to
 * 64MB) and "questions-asked" (a list of questions, which would
 * otherwise show as an escaped JSON string) - are exactly the ones this
 * replaces with a judged summary; undefined means "the bare event name
 * already says it all" (e.g. "task-received" has no details). */
function describeEventDetails(event: FabricaEvent): string | undefined {
  const details = event.details;
  if (details === undefined) return undefined;

  switch (event.name) {
    case "work-started": {
      const d = details as { project?: string; verdict?: string };
      const round = d.verdict === "fix" ? "fix round" : "work";
      return d.project ? `${round} started on ${d.project}` : `${round} started`;
    }

    case "check-run": {
      const d = details as { attempt?: number; phase?: string; green?: boolean; where?: string; notVerified?: string };
      const where = d.where ? ` in the ${d.where}` : "";
      if (d.phase === "started") return `check started${where} (attempt ${d.attempt})`;
      // The worker's box could not run the check at all: not verified,
      // which must never read as red.
      if (d.notVerified !== undefined) return `check could not run (attempt ${d.attempt}): ${d.notVerified.split("\n")[0]}`;
      return `check finished (attempt ${d.attempt}): ${d.green ? "green" : "red"}`;
    }

    case "inspector-called": {
      const d = details as { branch?: string };
      return d.branch ? `Inspector called for ${d.branch}` : "Inspector called";
    }

    case "inspection-finished": {
      const d = details as { verdict?: string; report?: string };
      const verdict = d.verdict ?? "unknown";
      return d.report ? `Inspector ${verdict}: ${d.report}` : `Inspector ${verdict}`;
    }

    case "cap-refused":
    case "cap-stopped": {
      const d = details as { message?: string };
      return d.message ?? fallbackDetail(details);
    }

    case "receipt-recorded": {
      const d = details as { receipt?: { attempt?: number; costUsd?: number | null } };
      const cost = d.receipt?.costUsd;
      return `attempt ${d.receipt?.attempt} cost ${typeof cost === "number" ? formatUsd(cost) : "unknown"}`;
    }

    case "cost-recorded": {
      const d = details as { usd?: number; attempts?: number[] };
      return `cost recorded by hand: ${formatUsd(d.usd ?? 0)} for attempt(s) ${(d.attempts ?? []).join(", ")}`;
    }

    case "inspection-skipped": {
      const d = details as { reason?: string };
      return d.reason ? `Inspector skipped: ${d.reason}` : "Inspector skipped";
    }

    case "delivered": {
      // Deliberately excludes delivery.evidence and receipts[].checks -
      // both carry the check's raw stdout+stderr (any size), which is
      // exactly the unbounded-line problem this
      // rendering exists to fix. "What happened," not the whole output.
      const d = details as {
        outcome?: string;
        delivery?: { confidence?: number; summary?: string; branch?: string; files?: string[]; gateChanges?: string };
        receipts?: unknown[];
      };
      const delivery = d.delivery;
      if (!delivery) return d.outcome ? `delivered: ${d.outcome}` : undefined;

      // Just the count, never a "N/totalAttempts" ratio: a fix round
      // draws no budget of its own (issue #65), so receipts.length can
      // exceed the original totalAttempts once one has run - a ratio
      // whose numerator outgrows its denominator is exactly the
      // unreadable output this rendering exists to eliminate. Client
      // ruling, issue #12 review finding.
      const bits: string[] = [`confidence ${delivery.confidence}%`];
      if (d.receipts) bits.push(`attempt ${d.receipts.length}`);
      if (delivery.branch) bits.push(`branch ${delivery.branch}`);
      if (delivery.files) bits.push(`${delivery.files.length} file(s)`);
      if (delivery.gateChanges) bits.push("gate changes declared");

      const summary = delivery.summary ? ` - ${delivery.summary}` : "";
      return `delivered: ${d.outcome ?? "?"}${summary} (${bits.join(", ")})`;
    }

    case "verdict-recorded": {
      const d = details as { ruling?: string; note?: string };
      return d.note ? `verdict: ${d.ruling} - ${d.note}` : `verdict: ${d.ruling}`;
    }

    case "heartbeat": {
      const d = details as { attempt?: number };
      return d.attempt !== undefined ? `heartbeat (attempt ${d.attempt})` : "heartbeat";
    }

    case "questions-asked": {
      // `src/foreman/ask.ts` emits this with `details.questions` as a
      // string[] (issue #8) - the array branch below is the confirmed
      // shape; the string branch stays for tolerance, so a question list
      // always reads as questions, not JSON.
      const d = details as { questions?: string[] | string };
      if (Array.isArray(d.questions)) return d.questions.map((q, i) => `${i + 1}) ${q}`).join("; ");
      if (typeof d.questions === "string") return d.questions;
      return fallbackDetail(details);
    }

    case "answers-given": {
      const d = details as { answer?: string };
      return d.answer ? `answer: ${d.answer}` : fallbackDetail(details);
    }

    case "line-cut": {
      // `do.ts` emits this with `{ branch, reopened }` every time a
      // ProductionLine is cut - once per ordinary task, and again on a
      // `fabrica answer` resume, where `reopened` distinguishes checking
      // out the same branch again from cutting a fresh one. It lands on
      // every task's history, so a raw-JSON fallback here would be the
      // single most common instance of the exact bug this rendering
      // exists to fix.
      const d = details as { branch?: string; reopened?: boolean };
      const verb = d.reopened ? "line reopened" : "line cut";
      return d.branch ? `${verb}: ${d.branch}` : verb;
    }

    case "ask-failed": {
      // `ask.ts` emits this with `{ error }` (issue #8) when
      // `brain.ask()` itself throws, before any Worker ever ran.
      const d = details as { error?: string };
      return d.error ? `ask failed: ${d.error}` : "ask failed";
    }

    case "stopped-by-owner": {
      // `stop.ts`'s StoppedByOwnerDetails (issue #203). The last
      // activity is a whole transcript line, which can be long and can
      // have newlines in it - its first line only, like `task-failed`
      // above, since this rendering is one line per event.
      const d = details as { by?: string; stoppedFrom?: string; lastActivity?: { text?: string } | null };
      const who = d.by ? ` by ${d.by}` : "";
      const from = d.stoppedFrom ? ` while ${d.stoppedFrom}` : "";
      const last = d.lastActivity?.text ? `, last activity: ${d.lastActivity.text.split("\n")[0]}` : "";
      return `stopped${who}${from}${last}`;
    }

    default:
      return fallbackDetail(details);
  }
}

/** One line for `fabrica log` - timestamp, name, and a judged, readable
 * rendering of its details, so a whole task's history stays scannable
 * (issue #12, Client ruling: present it, don't dump it). */
export function formatEventLine(event: FabricaEvent): string {
  const detail = describeEventDetails(event);
  return `${event.occurredAt}  ${event.name}${detail ? `  ${detail}` : ""}`;
}

/** One transcript line, in the single format `log --transcript` and
 * `watch` both print - the two views of the same file must not drift. */
export function formatTranscriptLine(entry: TranscriptEntry): string {
  return `${entry.occurredAt}  [${entry.kind}]  ${entry.text}`;
}

/** `fabrica log`'s full rendering of a task's history (Client ruling on
 * issue #12's log-heartbeat-noise finding: collapse, don't hide behind a
 * flag): a consecutive run of "heartbeat" events folds into one line - "N
 * heartbeats over <span>" - so the fact worth keeping (the task was alive
 * for that whole stretch) survives without one line per 15s tick burying
 * the real events around it. A run of exactly one heartbeat reads as an
 * ordinary single heartbeat line, not "1 heartbeats over 0s". */
export function formatEventLines(events: FabricaEvent[]): string[] {
  const lines: string[] = [];
  let i = 0;
  while (i < events.length) {
    if (events[i].name !== "heartbeat") {
      lines.push(formatEventLine(events[i]));
      i++;
      continue;
    }
    let j = i + 1;
    while (j < events.length && events[j].name === "heartbeat") j++;
    const run = events.slice(i, j);
    lines.push(run.length === 1 ? formatEventLine(run[0]) : formatHeartbeatRun(run));
    i = j;
  }
  return lines;
}

function formatHeartbeatRun(run: FabricaEvent[]): string {
  return `${run[0].occurredAt}  heartbeat  ${summarizeHeartbeatRun(run)}`;
}

/** "N heartbeats over <span>" - the count-and-real-elapsed-span math
 * shared by `fabrica log`'s collapsed history line (`formatHeartbeatRun`,
 * above) and `fabrica watch`'s collapsed catch-up line for a heartbeat
 * backlog it attaches mid-stream (issue #12 review finding, Client
 * ruling: same collapsing rule, applied to watch's initial batch too -
 * only the line format around it differs per view. */
export function summarizeHeartbeatRun(run: FabricaEvent[]): string {
  const spanMs = Date.parse(run[run.length - 1].occurredAt) - Date.parse(run[0].occurredAt);
  return `${run.length} heartbeats over ${formatAge(spanMs)}`;
}
