// Turns the record into the shape the live view's page polls for. Every
// read goes through src/index.ts (Fabrica's one public entry point) and,
// for events, through `followTask` specifically - its line-by-line tail
// reader already skips a line that fails JSON.parse instead of throwing
// (src/foreman/follow.ts's `parseLine`, the same mechanism `fabrica watch`
// relies on), so one malformed line in events.jsonl can never take this
// page down. `readEvents`/`eventsByTask` are deliberately never used here:
// they read the whole file in one JSON.parse per line and are supposed to
// throw on corruption for `fabrica log`/`status`'s one-shot reads - a
// much bigger blast radius than this read-only viewer needs.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError,
  daySpend,
  describeTaskCost,
  followTask,
  formatUsd,
  hasAttempts,
  loadConfig,
  readTaskFile,
  stateOf,
  taskSpend,
} from "../../src/index.ts";
import type { Caps, FabricaEvent, FabricaTask, TaskFollower, TranscriptEntry, WorkerWriteup } from "../../src/index.ts";

/** How much of the task's own text stands in for a title before a
 * worker's write-up exists - long enough to be recognizable, short
 * enough to keep a list row to one line. */
const FALLBACK_TITLE_MAX_LENGTH = 60;

/** The states the page shows. Mostly a collapse of FabricaTask's own
 * richer union ("checking" folds into "working" - detail this tiny
 * dashboard deliberately doesn't surface), except "closed", which keeps
 * the Client's actual ruling rather than folding into generic "stopped":
 * a verdict is a resolved, known outcome, and reads as one. "stopped" is
 * reserved for the one state that really has no ruling behind it -
 * Inspector reaching no verdict at all (Client ruling, issue #26 review
 * finding: "keep 'stopped' only for a task that was actually stopped"). */
export type DisplayState =
  | "working"
  | "asked a question"
  | "delivered"
  | "failed"
  | "stopped"
  | "closed (accept)"
  | "closed (wrong)"
  /** Defensive only: `stateOf` sets the raw "closed" state exclusively
   * from a verdict-recorded event whose own ruling is "accept" or
   * "wrong" (queries.ts), so `closedRuling` below should always be one
   * of those two whenever `state` is "closed". This exists so a caller
   * that somehow saw otherwise still gets a real string, never a crash. */
  | "closed";

export function displayState(state: FabricaTask["state"], closedRuling: "accept" | "wrong" | null = null): DisplayState {
  switch (state) {
    case "asking":
      return "asked a question";
    case "working":
    case "checking":
      return "working";
    case "delivered":
      return "delivered";
    case "failed":
      return "failed";
    case "closed":
      return closedRuling === "accept" ? "closed (accept)" : closedRuling === "wrong" ? "closed (wrong)" : "closed";
    case "refused":
      return "stopped";
  }
}

/** A task is history once nothing further is expected of it - every
 * closed verdict, a genuine stop, or an unresolved failure. */
export function isFinished(state: DisplayState): boolean {
  return state === "failed" || state === "stopped" || state === "closed (accept)" || state === "closed (wrong)" || state === "closed";
}

/** The ruling behind this task's most recent `verdict-recorded` event -
 * "fix" reopens the loop rather than closing it (rule 6), so only
 * "accept"/"wrong" are ever what makes `stateOf` report "closed" in the
 * first place; this reads the same event stateOf's own pass already
 * found, rather than re-deciding what counts as closed. */
function latestVerdictRuling(events: FabricaEvent[]): "accept" | "wrong" | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].name !== "verdict-recorded") continue;
    const ruling = (events[i].details as { ruling?: string } | undefined)?.ruling;
    if (ruling === "accept" || ruling === "wrong") return ruling;
  }
  return null;
}

export interface TaskView {
  id: string;
  /** The write-up title once there is one, else the task text's first
   * line cut to ~60 characters - what a list row shows, nothing else. */
  title: string;
  project: string | null;
  state: DisplayState;
  taskText: string;
  attempt: number | null;
  costLabel: string;
  /** Issue #188: real, metered dollars only - what the per-task cap
   * binds on. `subscriptionUsd` is the separate, notional figure. */
  costUsd: number;
  subscriptionUsd: number;
  perTaskCapUsd?: number;
  prUrl: string | null;
  writeup: WorkerWriteup | null;
  finished: boolean;
  lastActivityMs: number;
}

export interface SpendView {
  /** Issue #188: real, metered dollars - what `perDayCapUsd` binds on. */
  dailyUsd: number;
  dailyLabel: string;
  /** The day's flat-rate subscription estimate - notional, shown
   * separately, never counted against `perDayCapUsd`. */
  dailySubscriptionUsd: number;
  dailySubscriptionLabel: string;
  perDayCapUsd?: number;
  perTaskCapUsd?: number;
}

export interface LiveViewState {
  now: number;
  spend: SpendView;
  tasks: TaskView[];
}

/** Whichever event last carried `details.project` - mirrors
 * src/cli/render.ts's `projectFromEvents` (a fix round's own
 * work-started/delivered events carry it too, so the latest wins). Kept
 * as its own small copy rather than imported: that function lives under
 * src/cli/, the CLI's own presentation layer, and this integration reaches
 * Fabrica only through src/index.ts, never into src/cli/. */
function projectFromEvents(events: FabricaEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const details = events[i].details as { project?: string } | undefined;
    if (details?.project) return details.project;
  }
  return null;
}

/** Mirrors src/cli/render.ts's `prUrlFromEvents` for the same reason as
 * `projectFromEvents` above - the last "pr-opened" event wins. */
function prUrlFromEvents(events: FabricaEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].name !== "pr-opened") continue;
    const details = events[i].details as { url?: string } | undefined;
    if (details?.url) return details.url;
  }
  return null;
}

/** The worker's own structured write-up (title/what/why/how/deviations),
 * carried on a "delivered" event's own `details` (src/foreman/do.ts and
 * verdict.ts, alongside `delivery`) rather than on the ratified `Delivery`
 * shape itself - `Delivery` is CONTRACT rule 4's contract type, and this
 * is presentation-only metadata the contract never promised. Absent until
 * an attempt's write-up was valid; the latest "delivered" event wins,
 * same as `prUrlFromEvents`. */
function writeupFromEvents(events: FabricaEvent[]): WorkerWriteup | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].name !== "delivered") continue;
    const writeup = (events[i].details as { writeup?: WorkerWriteup } | undefined)?.writeup;
    if (writeup) return writeup;
  }
  return null;
}

/** The short label a list row shows: the worker's own write-up title once
 * there is one, otherwise the task text's first line cut to about 60
 * characters - never both, and never the full task text on the row
 * itself. */
export function taskTitle(taskText: string, writeupTitle: string | undefined): string {
  if (writeupTitle && writeupTitle.trim()) return writeupTitle.trim();
  const firstLine = taskText.split("\n", 1)[0].trim();
  if (firstLine.length <= FALLBACK_TITLE_MAX_LENGTH) return firstLine || "(no task text)";
  return `${firstLine.slice(0, FALLBACK_TITLE_MAX_LENGTH).trimEnd()}…`;
}

/** The highest attempt number mentioned by any event this task has
 * produced so far - a finished attempt's own receipt, or the heartbeat/
 * check-run of one still in flight. Null before any attempt has started
 * (e.g. a task still "asking"). */
function latestAttempt(events: FabricaEvent[]): number | null {
  let max: number | null = null;
  for (const event of events) {
    let attempt: unknown;
    if (event.name === "receipt-recorded") attempt = (event.details as { receipt?: { attempt?: number } } | undefined)?.receipt?.attempt;
    else if (event.name === "heartbeat" || event.name === "check-run") attempt = (event.details as { attempt?: number } | undefined)?.attempt;
    if (typeof attempt === "number" && (max === null || attempt > max)) max = attempt;
  }
  return max;
}

function lastActivityMs(events: FabricaEvent[]): number {
  const last = events[events.length - 1];
  return last ? Date.parse(last.occurredAt) : 0;
}

/** A record home with no projects.toml yet has no caps at all - not an
 * error (mirrors src/cli/load-config.ts's loadConfigOrDefault, which
 * lives under src/cli/ and so isn't imported directly - see the note on
 * projectFromEvents above). */
function loadCapsOrDefault(recordHome: string): Caps {
  try {
    return loadConfig(recordHome).caps;
  } catch (err) {
    if (err instanceof ConfigError && err.code === "not-found") return {};
    throw err;
  }
}

/** Every task id the record home knows about, from the one place they are
 * ever created (SPEC.md "The record": `tasks/<id>/`) - never from
 * events.jsonl, so a task whose very first event hasn't landed yet (the
 * brief window inside `registerTask` between creating its folder and
 * appending "task-received") still shows up rather than looking lost. */
function discoverTaskIds(recordHome: string): string[] {
  try {
    return readdirSync(join(recordHome, "tasks"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Holds one `TaskFollower` per task for this record home's whole process
 * lifetime, so a 2Hz poll costs the bytes appended since the last one
 * (the same reasoning as `fabrica watch` - see src/record/tail.ts) rather
 * than re-reading every task's history from byte zero every time. */
export function createRecordView(recordHome: string) {
  const followers = new Map<string, TaskFollower>();

  function followerFor(taskId: string): TaskFollower {
    let follower = followers.get(taskId);
    if (!follower) {
      follower = followTask(recordHome, taskId);
      followers.set(taskId, follower);
    }
    return follower;
  }

  function getState(now: number = Date.now()): LiveViewState {
    const caps = loadCapsOrDefault(recordHome);
    const ids = discoverTaskIds(recordHome);

    const perTask = ids.map((id) => {
      const { events } = followerFor(id).read();
      return { id, events };
    });

    const allEvents = perTask.flatMap(({ events }) => events);
    const { meteredUsd: dailyUsd, subscriptionUsd: dailySubscriptionUsd } = daySpend(allEvents, now);

    const tasks: TaskView[] = perTask.map(({ id, events }) => buildTaskView(id, events, caps));

    tasks.sort((a, b) => b.lastActivityMs - a.lastActivityMs);

    return {
      now,
      spend: {
        dailyUsd,
        dailyLabel: formatUsd(dailyUsd),
        dailySubscriptionUsd,
        dailySubscriptionLabel: formatUsd(dailySubscriptionUsd),
        ...(caps.perDayUsd !== undefined ? { perDayCapUsd: caps.perDayUsd } : {}),
        ...(caps.perTaskUsd !== undefined ? { perTaskCapUsd: caps.perTaskUsd } : {}),
      },
      tasks,
    };
  }

  function buildTaskView(id: string, events: FabricaEvent[], caps: Caps): TaskView {
    const spend = taskSpend(events, id);
    const rawState = stateOf(events);
    const state = displayState(rawState, rawState === "closed" ? latestVerdictRuling(events) : null);
    const taskText = (readTaskFile(recordHome, id, "request.md") ?? "").trim();
    const writeup = writeupFromEvents(events);
    return {
      id,
      title: taskTitle(taskText, writeup?.title),
      project: projectFromEvents(events),
      state,
      taskText,
      attempt: latestAttempt(events),
      costLabel: describeTaskCost(spend, hasAttempts(events, id)),
      costUsd: spend.meteredUsd,
      subscriptionUsd: spend.subscriptionUsd,
      ...(caps.perTaskUsd !== undefined ? { perTaskCapUsd: caps.perTaskUsd } : {}),
      prUrl: prUrlFromEvents(events),
      writeup,
      finished: isFinished(state),
      lastActivityMs: lastActivityMs(events),
    };
  }

  /** One task's full view, for the per-task page (/tasks/<id>) - null for
   * a task id this record home has never heard of. Reuses the same
   * `buildTaskView` `getState` uses, so the list and the detail page never
   * disagree on one task's own fields. */
  function getTask(taskId: string): TaskView | null {
    if (!discoverTaskIds(recordHome).includes(taskId)) return null;
    const { events } = followerFor(taskId).read();
    return buildTaskView(taskId, events, loadCapsOrDefault(recordHome));
  }

  /** The worker's transcript for one task, tailing as it grows - null for
   * a task id this record home has never heard of. Reuses the same
   * follower `getState` uses, so the two never fall out of step. */
  function getTranscript(taskId: string): TranscriptEntry[] | null {
    if (!discoverTaskIds(recordHome).includes(taskId)) return null;
    return followerFor(taskId).read().transcript;
  }

  return { getState, getTask, getTranscript };
}

export type RecordView = ReturnType<typeof createRecordView>;
