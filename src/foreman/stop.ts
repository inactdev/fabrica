// The Client stopping a task himself (issue #203) - the record half,
// and only the record half. Signaling the worker's own detached process
// is `src/cli/task-process.ts`'s job, deliberately not this module's:
// finding a process means reading the real process table through `ps`,
// and `src/foreman/no-host-check.test.ts` fails if anything under
// src/foreman spawns anything but `git` (issue #64, "Fabrica runs no
// project check on the host"). So this validates and records, the CLI
// layer signals, and the caller composes the two - the same split
// issue #123 already made for `recordVerdictDecision` (foreground,
// synchronous, validating) and `spawnDetachedResume` (the process work).
//
// Order is deliberate: the event is appended BEFORE anything is
// signaled, and a signal that finds nothing to kill does not undo it.
// The Client's decision is the fact (Client ruling, issue #203's
// clarification: "the record moves to a terminal stopped state the
// moment the stopped-by-owner event lands"); the signal is how the
// machine is asked to catch up with it.

import { appendEvent } from "../record/index.ts";
import { ForemanError } from "./errors.ts";
import { eventsOf, stateOf } from "./queries.ts";
import { readTranscript } from "./transcript.ts";

/** The one state pair a running task can be in - `stateOf`'s "working"
 * (a worker mid-call, or anything between rounds) and "checking" (its
 * own box running the project's check). Everything else is either
 * waiting on the Client or already finished, and there is nothing there
 * to stop. */
const RUNNING_STATES: ReadonlySet<string> = new Set(["working", "checking"]);

/** The worker's last recorded activity at the moment it was stopped
 * (Client ruling, issue #203's clarification: "timestamp plus the
 * content of the last transcript line"). Null when the task has
 * produced no transcript at all yet - a worker stopped before its first
 * line landed. */
export interface LastWorkerActivity {
  occurredAt: string;
  /** The transcript entry's own `kind` - an adapter's free-form word for
   * what sort of chunk this was ("stdout", "tool-call", ...). */
  kind: string;
  text: string;
}

/** Everything the "stopped-by-owner" event's `details` carries. */
export interface StoppedByOwnerDetails {
  /** Who stopped it - the `Tailscale-User-Login` the request carried
   * (server.ts's identity gate). Recorded because a stop is a decision,
   * and the record says who made every other one. */
  by: string;
  /** The state the task was in when the stop was recorded, so the
   * record says what was actually interrupted. */
  stoppedFrom: "working" | "checking";
  lastActivity: LastWorkerActivity | null;
}

/** The worker's last transcript entry, as `LastWorkerActivity` - read
 * through `readTranscript` (which already skips a line that fails
 * JSON.parse rather than throwing), so a short write at exactly the
 * wrong moment costs the detail, never the stop. */
export function lastWorkerActivity(recordHome: string, taskId: string): LastWorkerActivity | null {
  const last = readTranscript(recordHome, taskId).at(-1);
  if (!last) return null;
  return { occurredAt: last.occurredAt, kind: last.kind, text: last.text };
}

/**
 * Records the Client's decision to stop a task, and returns exactly what
 * went onto the record so a caller can report it back.
 *
 * Refuses, before writing anything:
 * - a task this record home has never heard of (`unknown-task`);
 * - a task that is not running (`not-running`), naming the state it is
 *   actually in. The review page hides the control for one of these, but
 *   the server refuses it anyway (Client ruling, issue #203's
 *   clarification) - a page can be stale, and a 400 naming the state is
 *   a better answer than a stop event on a task that finished an hour
 *   ago.
 */
export function recordStopDecision(recordHome: string, taskId: string, by: string): StoppedByOwnerDetails {
  const events = eventsOf(recordHome, taskId);
  if (events.length === 0) {
    throw new ForemanError(
      "unknown-task",
      `fabrica: no task "${taskId}" in this record. Check the id with \`fabrica status\`.`
    );
  }

  const state = stateOf(events);
  if (!RUNNING_STATES.has(state)) {
    throw new ForemanError(
      "not-running",
      `fabrica: task "${taskId}" is ${state}, not running - there is nothing to stop.`
    );
  }

  const details: StoppedByOwnerDetails = {
    by,
    stoppedFrom: state as "working" | "checking",
    lastActivity: lastWorkerActivity(recordHome, taskId),
  };
  appendEvent(recordHome, { taskId, name: "stopped-by-owner", details });
  return details;
}
