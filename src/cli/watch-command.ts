// `fabrica watch <id>` (SPEC.md, issue #12): follows one task while it
// runs. Heartbeats appear as they happen, so you can see it's alive; the
// worker's own transcript arrives live too, entry by entry as the
// reference adapter maps its stream (attempts.ts's onTranscriptEntry
// fires per entry, not once per attempt - see AGENTS.md and
// src/brain/live-transcript.ts, issue #70). The sharp edge this whole command
// exists to get right: stopping the watch must never stop the work. This
// process never signals, kills, waits on, or otherwise touches the
// detached process `fabrica do` started (src/cli/spawn-detached.ts).
// Ctrl-C here can only ever end this process's own polling. See
// watch-command.test.ts and the PR's own end-to-end proof for that
// shown, not just asserted.
//
// Issue #99 is the one thing it now does beyond reading the record
// (events.jsonl, transcript.log): it LOOKS at whether the worker's
// process is still alive - the task's own pid file, verified against a
// real `ps` listing - so a silent stretch can be reported as a dead
// worker instead of as an unreadable silence. Looking is not touching:
// of task-process.ts's exports this file imports the probe only, never
// `stopTaskProcess`, and nothing here may ever change that.

import { followTask, stateOf } from "../index.ts";
import { CliError } from "./errors.ts";
import { delay } from "./delay.ts";
import { WATCH_USAGE, parseWatchArgs } from "./watch-args.ts";
import { resolveRecordHome } from "./record-home.ts";
import {
  QUIET_THRESHOLD_MS,
  checkStartedAt,
  checksSummaryFromEvents,
  describeLiveness,
  expectsWorkerProcess,
  formatTerminalNotice,
  formatTranscriptLine,
  isDeadEnd,
  isQuietTooLong,
  summarizeHeartbeatRun,
} from "./render.ts";
import { WORKER_PROBE_INTERVAL_MS, probeTaskWorker } from "./task-process.ts";
import type { WorkerPresence } from "./task-process.ts";
import type { FabricaTask, TaskFollower } from "../index.ts";

export const WATCH_HELP = `Usage: ${WATCH_USAGE}

Follows one task while it runs. Heartbeats appear as they happen, so you
can see it's alive; the worker's own transcript arrives live too, entry
by entry as the worker produces it - the same entries \`fabrica log
--transcript\` prints after the fact. A silent stretch longer than a few
heartbeats is flagged "quiet" instead of implying progress nobody has
actually observed. A task running its check instead says so plainly -
"checking, 2m so far" - since that has a real, known start time. That
exemption holds up to a long ceiling (4 hours); a check still running
past it gets its own alarm ("checking, 4h and still not finished") since
by then the silence no longer has an honest explanation - it never
claims a heartbeat that a check never emits. The same idea covers the
window before a task's worker has even started (\`fabrica do\` waiting on
its brain to finish clarifying): that has its own, much shorter ceiling,
since a real answer arrives in well under a minute.

A silence that is not a silence at all gets named for what it is: while
a task's round should have a process running it, that process is really
looked for - its own pid file, verified against what is actually
running - and if nothing is running the task, the watch says "worker
process not found" once and keeps following the record anyway, in case
the task's own failure still lands on it. A round that started before
Fabrica recorded worker pids says its liveness is unknown rather than
claiming either way.

Stopping this (Ctrl-C) only stops watching. The task itself runs in a
separate, already-detached process (\`fabrica do\` starts it that way) that
this command never touches - closing the view never touches the room.

  <taskId>   The task to watch. See \`fabrica status\` for open ids.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

const DEFAULT_POLL_INTERVAL_MS = 500;

export interface RunWatchCommandOptions {
  recordHome?: string;
  pollIntervalMs?: number;
  /** Aborting stops the poll loop and returns. Combined with (not
   * replaced by) the real SIGINT handler this installs by default. */
  signal?: AbortSignal;
  /** Test-only: skip installing the real `process.on("SIGINT", ...)`
   * handler, so a test can drive stopping purely through `signal`
   * without sending the test runner's own process a signal. Real CLI use
   * always leaves this true. */
  installSigintHandler?: boolean;
  /** Replaces the real process table behind the worker-liveness check
   * (issue #99), the same seam `fabrica status` takes - a test can
   * describe what is running instead of needing a real detached worker
   * on the machine running it. */
  listProcesses?: () => { pid: number; args: string }[];
  /** Test-only: how long a probe of the worker's process stays good for
   * before the loop asks the operating system again. Real use leaves
   * this at `WORKER_PROBE_INTERVAL_MS`; a test with a 10ms poll
   * interval sets it to 0 so the second poll re-probes rather than
   * waiting out a real 15 seconds. */
  probeIntervalMs?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Returns the process exit code - never throws. */
export async function runWatchCommand(argv: string[], opts: RunWatchCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    const { taskId } = parseWatchArgs(argv);
    const recordHome = opts.recordHome ?? resolveRecordHome();
    // One follower for the whole watch: every poll below reads through
    // it, so each line of the record is read and parsed exactly once no
    // matter how long the Client watches.
    const follower = followTask(recordHome, taskId);

    if (follower.read().events.length === 0) {
      throw new CliError(
        "unknown-task",
        `fabrica watch: no task "${taskId}" in this record. Check the id with \`fabrica status\`.`
      );
    }

    const controller = new AbortController();
    const callerSignal = opts.signal;
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const installSigint = opts.installSigintHandler ?? true;
    const onSigint = () => {
      stdout("");
      stdout(
        "stopped watching - the task keeps running in the background, untouched; " +
          "nothing here can stop it. Check `fabrica status` any time."
      );
      controller.abort();
    };
    if (installSigint) process.on("SIGINT", onSigint);

    try {
      await streamTranscript({
        recordHome,
        taskId,
        follower,
        stdout,
        signal: controller.signal,
        pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        listProcesses: opts.listProcesses,
        probeIntervalMs: opts.probeIntervalMs ?? WORKER_PROBE_INTERVAL_MS,
      });
    } finally {
      if (installSigint) process.off("SIGINT", onSigint);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }

    return 0;
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function streamTranscript(ctx: {
  recordHome: string;
  taskId: string;
  follower: TaskFollower;
  stdout: (line: string) => void;
  signal: AbortSignal;
  pollIntervalMs: number;
  listProcesses?: () => { pid: number; args: string }[];
  probeIntervalMs: number;
}): Promise<void> {
  const { recordHome, taskId, follower, stdout, signal, pollIntervalMs, probeIntervalMs } = ctx;
  let printedTranscript = 0;
  let printedHeartbeats = 0;
  let wasQuiet = false;
  // Whether a quiet notice was actually printed, as opposed to merely
  // reached - "signal resumed" is a reply to one, and must not answer a
  // notice this stream suppressed (see the quiet branch below).
  let announcedQuiet = false;
  let wasChecking = false;
  let lastCheckingPace = -1;
  // Issue #99's three pieces of state: the last reading of the worker's
  // own process, when it was taken (so a 2Hz poll loop doesn't spawn a
  // `ps` twice a second), and whether its "not found" has already been
  // said. The notice is printed once per death, not once per poll
  // (Client ruling) - and the latch clears if a later round brings a
  // real process back, so a second death is reported too.
  let workerPresence: WorkerPresence | null = null;
  let probedAt: number | null = null;
  let saidWorkerGone = false;
  // Which state the last terminal notice was issued for, not merely
  // "whether one was" - a `fix` verdict moves a delivered task back to
  // "working" and then reaches a new delivery or refusal, and that new
  // result has to say so. A one-shot latch would leave the stream silently
  // stopping instead, which is the exact looks-like-a-hang case the notice exists
  // to prevent.
  let noticedState: FabricaTask["state"] | null = null;

  /** True once nothing further can ever land, so the caller stops polling. */
  const poll = async (): Promise<boolean> => {
    // One read of the record per poll, not three, and only the bytes
    // that landed since the last one (followTask, src/foreman/follow.ts):
    // this task's own events answer both "what's new" and "where does it
    // stand" (stateOf is the same derivation foreman.status() runs, given
    // the same events), so asking foreman.status() as well would re-read
    // and re-parse the whole log - twice a second, for as long as the
    // Client watches, on a file every running task appends a heartbeat
    // to every 15 seconds.
    const { transcript: entries, events } = follower.read();
    for (; printedTranscript < entries.length; printedTranscript++) {
      stdout(formatTranscriptLine(entries[printedTranscript]));
    }

    const heartbeats = events.filter((e) => e.name === "heartbeat");
    // A run of new heartbeats gets the same collapsing fabrica log applies
    // to its whole history (issue #12 review finding, Client ruling): the
    // first poll after attaching to a task that's been running a while
    // can find dozens already on the record, and printing each as its own
    // line would bury the transcript entries printed just above. A single
    // new heartbeat - the normal case, one per pollIntervalMs tick once
    // caught up - still reads as a plain liveness line.
    const newHeartbeats = heartbeats.slice(printedHeartbeats);
    if (newHeartbeats.length === 1) {
      stdout(`${newHeartbeats[0].occurredAt}  [heartbeat]  still working...`);
    } else if (newHeartbeats.length > 1) {
      stdout(`${newHeartbeats[0].occurredAt}  [heartbeat]  ${summarizeHeartbeatRun(newHeartbeats)}`);
    }
    printedHeartbeats = heartbeats.length;

    const state = events.length > 0 ? stateOf(events) : "working";

    const now = Date.now();

    // Issue #99: while this task's round should have a process running
    // it, really look - but at most once per probe interval, since each
    // probe spawns a `ps` and this loop runs twice a second for as long
    // as the Client watches (the same discipline the follower above
    // applies to re-reading the record). A state with no process to look
    // for drops the reading entirely and resets the clock, so the next
    // round's first poll probes straight away rather than inheriting
    // this one's timer.
    if (expectsWorkerProcess(state, events)) {
      if (probedAt === null || now - probedAt >= probeIntervalMs) {
        workerPresence = probeTaskWorker(recordHome, taskId, { listProcesses: ctx.listProcesses });
        probedAt = now;
      }
    } else {
      workerPresence = null;
      probedAt = null;
    }

    // Said once per death, not once per poll (Client ruling): the record
    // may still gain the task's own failure, so the watch keeps
    // following either way. WHAT it says comes from `describeLiveness`,
    // like every other line here - this is only the decision of when.
    if (workerPresence === "not-found") {
      if (!saidWorkerGone) {
        const gone = describeLiveness(state, events, now, workerPresence);
        if (gone) stdout(gone);
        saidWorkerGone = true;
      }
    } else {
      saidWorkerGone = false;
    }

    // isQuietTooLong is computed first: below CHECKING_QUIET_CEILING_MS,
    // a check has a real, recorded start time, so a task mid-check says
    // so plainly instead of getting the quiet alarm - but past that
    // ceiling it becomes eligible for the alarm too (issue #12 review
    // finding, Client ruling), and the alarm then takes over the display
    // the same way it does in `fabrica status` (render.ts's
    // `formatStatusLine`). This is purely a WHEN-to-print decision -
    // pace-limiting the checking line, edge-triggering the quiet one;
    // WHAT to print for either always comes from `describeLiveness`, the
    // one place that decision is made (issue #12 review finding: this
    // command used to re-derive that wording itself, independently of
    // render.ts, and the two had already drifted apart once).
    const quiet = isQuietTooLong(state, events, now);

    // Issue #99: once the worker's process has been looked for and is
    // gone, the record's own readings are about a wait that has already
    // ended - "checking, 2m so far" and "quiet 3m, not known to be
    // stuck, not known to be fine" would both walk back the definite
    // thing just said. The bookkeeping below still runs, so a `fix`
    // round that brings a real process back picks up cleanly (a
    // "signal resumed" when its first event lands).
    const sayRecordLiveness = workerPresence !== "not-found";

    const checking = state === "checking" && !quiet;
    if (checking) {
      const startedAt = checkStartedAt(events);
      const elapsedMs = startedAt ? now - startedAt.getTime() : 0;
      const pace = Math.floor(elapsedMs / QUIET_THRESHOLD_MS);
      if (!wasChecking || pace > lastCheckingPace) {
        const notice = describeLiveness(state, events, now, workerPresence);
        if (notice && sayRecordLiveness) stdout(notice);
        lastCheckingPace = pace;
      }
    } else {
      lastCheckingPace = -1;
    }
    wasChecking = checking;

    if (quiet !== wasQuiet) {
      if (quiet && sayRecordLiveness) {
        // The `??` arm is defensive only, not a second wording competing
        // with render.ts's: every case describeLiveness returns null for
        // is one isQuietTooLong already answered false, so `quiet` being
        // true means it returned a sentence. It exists so a future
        // divergence between the two prints something honest rather than
        // swallowing the transition (it once printed "signal resumed").
        stdout(
          describeLiveness(state, events, now, workerPresence) ??
            "quiet, nothing recorded for a while - not known to be stuck, not known to be fine",
        );
        announcedQuiet = true;
      } else if (!quiet && announcedQuiet) {
        // Only ever a reply to a quiet notice this stream actually
        // printed (issue #99): a suppressed one - the worker was already
        // known to be gone - must not be answered with "signal resumed"
        // when the task's own failure finally lands.
        stdout("signal resumed");
        announcedQuiet = false;
      }
    }
    wasQuiet = quiet;

    const hasDelivery = events.some((e) => e.name === "delivered");
    // Issue #267: the one line this command prints about a finished
    // task also says what the pull request's own checks did, since a
    // streamed transcript has no task line to put it on.
    const notice = formatTerminalNotice(state, {
      taskId,
      hasDelivery,
      checksSummary: checksSummaryFromEvents(events),
    });
    if (!notice) {
      noticedState = null;
    } else if (state !== noticedState) {
      noticedState = state;
      stdout(notice);
    }

    // A closed task, one the Client stopped himself (issue #203), an ask
    // failure before delivery, and an Inspector refusal with no verdict
    // cannot move again. isDeadEnd is the one shared definition for the
    // latter two, so this exit condition stays aligned with status and
    // terminal notices. A failed delivery, "asking", and "delivered"
    // still keep polling - a `fix` verdict or `fabrica answer` can wake
    // those back up.
    return state === "closed" || state === "stopped" || isDeadEnd(state, hasDelivery);
  };

  if (await poll()) return;
  while (!signal.aborted) {
    await delay(pollIntervalMs, signal);
    if (signal.aborted) break;
    if (await poll()) return;
  }
}
