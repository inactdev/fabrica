// Shared rendering for status/log/watch (issue #12): these are the
// Client's eyes on the tool, so the same age/quiet/label logic must read
// identically everywhere it shows up rather than three slightly different
// home-grown formats.

import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "../index.ts";
import type { FabricaEvent, FabricaTask, TranscriptEntry } from "../index.ts";

/** Longer than this since the last recorded event on a still-working task,
 * and silence stops meaning "progress" and starts meaning "quiet too long"
 * (issue #12) - three missed heartbeats' worth of margin absorbs a single
 * slow tick without crying wolf. */
export const QUIET_THRESHOLD_MS = DEFAULT_HEARTBEAT_INTERVAL_MS * 3;

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

/** True only for a task genuinely mid brain.work() whose silence has run
 * past QUIET_THRESHOLD_MS - a delivered, failed, or closed task is quiet
 * by definition and that's not the same fact. A task that is "checking"
 * is never quiet-too-long: Fabrica knows exactly what it's doing and
 * since when (checkStartedAt), so status/watch say that plainly instead
 * of raising an alarm about a silence that has a known, honest
 * explanation. The same reasoning covers the pre-work window: `stateOf`
 * reports "working" from the moment `task-received` lands, including the
 * whole stretch `brain.ask()` runs in before any ProductionLine exists -
 * a real, often-slow brain call (`wait-for-ask-outcome.ts` budgets 60s
 * for it) with nothing to append until it resolves. That gap is
 * distinguished from a genuinely silent worker by whether a
 * `"work-started"` event has landed yet - the alarm stays fully
 * meaningful for the case it actually means something: a worker that
 * started and then went quiet. */
export function isQuietTooLong(state: FabricaTask["state"], events: FabricaEvent[], now: number = Date.now()): boolean {
  if (state !== "working") return false;
  if (!events.some((e) => e.name === "work-started")) return false;
  const last = lastActivityAt(events);
  if (!last) return false;
  return now - last.getTime() > QUIET_THRESHOLD_MS;
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
  opts: { project: string | null; ageMs: number; quietForMs: number | null; checkingForMs: number | null }
): string {
  const project = opts.project ?? "unknown project";
  const age = formatAge(opts.ageMs);
  const base = `${task.id}  ${project}  ${task.state}  ${age} old`;

  if (task.state === "delivered") {
    return `${base}  <- AWAITING YOUR VERDICT: fabrica verdict ${task.id} accept|fix|wrong`;
  }
  if (task.state === "checking" && opts.checkingForMs !== null) {
    return `${base}  <- checking, ${formatAge(opts.checkingForMs)} so far`;
  }
  if (opts.quietForMs !== null) {
    return `${base}  <- ${formatQuietNotice(opts.quietForMs)}`;
  }
  return base;
}

/** The one wording for "this task has gone quiet", shared by `status` and
 * `watch` so the Client reads the same sentence in both - it says what is
 * known (nothing has been recorded for this long) and refuses to imply
 * either of the two things that aren't. */
export function formatQuietNotice(quietForMs: number): string {
  return `quiet ${formatAge(quietForMs)}, no signal since last heartbeat - not known to be stuck, not known to be fine`;
}

/** What `fabrica watch` prints when a task reaches a state nothing
 * further is expected from, so a stream that simply stops is never
 * mistaken for a hang - null for a state the worker is still moving
 * through. Every branch names an action the tool will actually accept:
 * a task that failed before it ever delivered has no `fix` path at all
 * (`recordVerdict` refuses it with "not-delivered"), so it is worded
 * apart from the delivered/failed-delivery case rather than pointing the
 * Client at a command that would be rejected. */
export function formatTerminalNotice(
  state: FabricaTask["state"],
  ctx: { taskId: string; hasDelivery: boolean }
): string | null {
  switch (state) {
    case "delivered":
      return `-- task delivered - nothing more expected on this transcript unless a \`fix\` verdict wakes the worker again --`;
    case "failed":
      if (!ctx.hasDelivery) {
        // The only way to be "failed" with no "delivered" event on the
        // record: brain.ask() itself threw, before any Worker ran (see
        // stateOf's "ask-failed" branch). Nothing was ever delivered, so
        // there is nothing to rule on.
        return (
          `-- task failed before any work started - the brain's clarify step threw, so nothing was ever ` +
          `delivered and there is no \`fix\` path; \`fabrica log ${ctx.taskId}\` has the reason --`
        );
      }
      return `-- task failed - nothing more expected on this transcript unless a \`fix\` verdict wakes the worker again --`;
    case "closed":
      // Rule 6: closed means the Client's verdict is recorded and final -
      // unlike "delivered", there is no fix path left to reopen this one.
      return "-- task closed - your verdict is recorded; nothing more will ever land on this transcript --";
    case "asking":
      // Stopped for clarifying questions before any Worker ran (issue #8)
      // - polling forever here would look like a hang with no way out.
      return `-- task asking - stopped for clarifying questions; answer with \`fabrica answer ${ctx.taskId} -m "<text>"\` to resume it --`;
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
      const d = details as { attempt?: number; phase?: string; green?: boolean };
      if (d.phase === "started") return `check started (attempt ${d.attempt})`;
      return `check finished (attempt ${d.attempt}): ${d.green ? "green" : "red"}`;
    }

    case "delivered": {
      // Deliberately excludes delivery.evidence and receipts[].checks -
      // both carry the check's raw stdout+stderr (runCheck's own 64MB
      // maxBuffer), which is exactly the unbounded-line problem this
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
