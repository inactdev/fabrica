// `fabrica watch <id>` (SPEC.md, issue #12): follows one task while it
// runs. Heartbeats appear as they happen, so you can see it's alive; the
// worker's own transcript arrives in a batch at the end of each attempt,
// not word by word (attempts.ts calls onTranscript only once brain.work
// has fully resolved - see AGENTS.md). The sharp edge this whole command
// exists to get right: stopping the watch must never stop the work. This
// process only ever reads the record (events.jsonl, transcript.log) - it
// never spawns, signals, or otherwise touches the detached process
// `fabrica do` started (src/cli/spawn-detached.ts). Ctrl-C here can only
// ever end this process's own polling; there is nothing in this file that
// could reach the worker even if it wanted to. See watch-command.test.ts
// and the PR's own end-to-end proof for that shown, not just asserted.

import { followTask, stateOf } from "../index.ts";
import { CliError } from "./errors.ts";
import { delay } from "./delay.ts";
import { WATCH_USAGE, parseWatchArgs } from "./watch-args.ts";
import { resolveRecordHome } from "./record-home.ts";
import {
  QUIET_THRESHOLD_MS,
  checkStartedAt,
  formatAge,
  formatQuietNotice,
  formatTerminalNotice,
  formatTranscriptLine,
  isQuietTooLong,
  lastActivityAt,
  summarizeHeartbeatRun,
} from "./render.ts";
import type { FabricaTask, TaskFollower } from "../index.ts";

export const WATCH_HELP = `Usage: ${WATCH_USAGE}

Follows one task while it runs. Heartbeats appear as they happen, so you
can see it's alive; the worker's own transcript arrives in a batch at the
end of each attempt, not word by word - the same entries \`fabrica log
--transcript\` prints after the fact. A silent stretch longer than a few
heartbeats is flagged "quiet" instead of implying progress nobody has
actually observed. A task running its check instead says so plainly -
"checking, 2m so far" - since that has a real, known start time; it is
never flagged "quiet".

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
        taskId,
        follower,
        stdout,
        signal: controller.signal,
        pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
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
  taskId: string;
  follower: TaskFollower;
  stdout: (line: string) => void;
  signal: AbortSignal;
  pollIntervalMs: number;
}): Promise<void> {
  const { taskId, follower, stdout, signal, pollIntervalMs } = ctx;
  let printedTranscript = 0;
  let printedHeartbeats = 0;
  let wasQuiet = false;
  let wasChecking = false;
  let lastCheckingPace = -1;
  // Which state the last terminal notice was issued for, not merely
  // "whether one was" - a `fix` verdict moves a delivered task back to
  // "working" and then delivers it again, and that second delivery has to
  // say so. A one-shot latch would leave the stream silently stopping
  // instead, which is the exact looks-like-a-hang case the notice exists
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

    // Say what it's doing (issue #12, the Client's own ruling): a check
    // has a real, recorded start time, so a task mid-check says so
    // plainly - on the same cadence QUIET_THRESHOLD_MS already sets - and
    // isQuietTooLong (below) never raises an alarm for it, since there is
    // nothing unexplained about this silence.
    const checking = state === "checking";
    if (checking) {
      const startedAt = checkStartedAt(events);
      const elapsedMs = startedAt ? now - startedAt.getTime() : 0;
      const pace = Math.floor(elapsedMs / QUIET_THRESHOLD_MS);
      if (!wasChecking || pace > lastCheckingPace) {
        stdout(`checking, ${formatAge(elapsedMs)} so far`);
        lastCheckingPace = pace;
      }
    } else {
      lastCheckingPace = -1;
    }
    wasChecking = checking;

    const quiet = isQuietTooLong(state, events, now);
    if (quiet !== wasQuiet) {
      const last = lastActivityAt(events);
      stdout(quiet && last ? formatQuietNotice(now - last.getTime()) : "signal resumed");
    }
    wasQuiet = quiet;

    const hasDelivery = events.some((e) => e.name === "delivered");
    const notice = formatTerminalNotice(state, { taskId, hasDelivery });
    if (!notice) {
      noticedState = null;
    } else if (state !== noticedState) {
      noticedState = state;
      stdout(notice);
    }

    // Two states provably cannot change again, and the watch ends for
    // both: "closed" (recordVerdict refuses any further ruling once the
    // last verdict was accept or wrong - src/foreman/verdict.ts's
    // "already-closed"), and a "failed" task with no "delivered" event -
    // brain.ask() itself threw before any Worker ran, so `fabrica
    // verdict ... fix` refuses it with "not-delivered" and `fabrica
    // answer` refuses it with "no-questions-pending" (issue #12 review
    // finding, Client ruling: identical property to "closed", so it gets
    // the same treatment). A genuine failed DELIVERY, "asking", and
    // "delivered" all still keep polling - a `fix` verdict or a `fabrica
    // answer` genuinely wakes those back up, and this watch should show
    // it when it happens.
    return state === "closed" || (state === "failed" && !hasDelivery);
  };

  if (await poll()) return;
  while (!signal.aborted) {
    await delay(pollIntervalMs, signal);
    if (signal.aborted) break;
    if (await poll()) return;
  }
}
