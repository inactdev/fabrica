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
 * carried it (`work-started`/`delivered` details - see queries.ts's
 * projectOf, which this mirrors for callers already holding the events). */
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

/** True only for a task still in flight (working/checking) whose silence
 * has run past QUIET_THRESHOLD_MS - a delivered, failed, or closed task is
 * quiet by definition and that's not the same fact. */
export function isQuietTooLong(state: FabricaTask["state"], events: FabricaEvent[], now: number = Date.now()): boolean {
  if (state !== "working" && state !== "checking") return false;
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
 * most important thing status has to surface, per issue #12), and a
 * working/checking task gone quiet too long says so instead of implying
 * progress nobody has actually observed. */
export function formatStatusLine(
  task: FabricaTask,
  opts: { project: string | null; ageMs: number; quietForMs: number | null }
): string {
  const project = opts.project ?? "unknown project";
  const age = formatAge(opts.ageMs);
  const base = `${task.id}  ${project}  ${task.state}  ${age} old`;

  if (task.state === "delivered") {
    return `${base}  <- AWAITING YOUR VERDICT: fabrica verdict ${task.id} accept|fix|wrong`;
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

/** One line for `fabrica log` - timestamp, name, and details compacted to
 * one line each so a whole task's history stays scannable. */
export function formatEventLine(event: FabricaEvent): string {
  const details = event.details !== undefined ? `  ${JSON.stringify(event.details)}` : "";
  return `${event.occurredAt}  ${event.name}${details}`;
}

/** One transcript line, in the single format `log --transcript` and
 * `watch` both print - the two views of the same file must not drift. */
export function formatTranscriptLine(entry: TranscriptEntry): string {
  return `${entry.occurredAt}  [${entry.kind}]  ${entry.text}`;
}
