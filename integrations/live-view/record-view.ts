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
import type { Caps, FabricaEvent, FabricaTask, TaskFollower, TranscriptEntry } from "../../src/index.ts";

/** The five states the page shows, collapsing FabricaTask's own richer
 * union (which also distinguishes "checking" from "working", and a
 * closed verdict from an unresolved Inspector refusal - detail this
 * tiny dashboard deliberately doesn't surface). */
export type DisplayState = "working" | "asked a question" | "delivered" | "failed" | "stopped";

export function displayState(state: FabricaTask["state"]): DisplayState {
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
    case "refused":
      return "stopped";
  }
}

/** A task is history once nothing further is expected of it - the same
 * two display states a verdict or an unresolved failure ends on. */
export function isFinished(state: DisplayState): boolean {
  return state === "failed" || state === "stopped";
}

export interface TaskView {
  id: string;
  project: string | null;
  state: DisplayState;
  taskText: string;
  attempt: number | null;
  costLabel: string;
  costUsd: number;
  perTaskCapUsd?: number;
  prUrl: string | null;
  finished: boolean;
  lastActivityMs: number;
}

export interface SpendView {
  dailyUsd: number;
  dailyLabel: string;
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
    const { knownUsd: dailyUsd } = daySpend(allEvents, now);

    const tasks: TaskView[] = perTask.map(({ id, events }) => {
      const spend = taskSpend(events, id);
      const state = displayState(stateOf(events));
      return {
        id,
        project: projectFromEvents(events),
        state,
        taskText: (readTaskFile(recordHome, id, "request.md") ?? "").trim(),
        attempt: latestAttempt(events),
        costLabel: describeTaskCost(spend, hasAttempts(events, id)),
        costUsd: spend.knownUsd,
        ...(caps.perTaskUsd !== undefined ? { perTaskCapUsd: caps.perTaskUsd } : {}),
        prUrl: prUrlFromEvents(events),
        finished: isFinished(state),
        lastActivityMs: lastActivityMs(events),
      };
    });

    tasks.sort((a, b) => b.lastActivityMs - a.lastActivityMs);

    return {
      now,
      spend: {
        dailyUsd,
        dailyLabel: formatUsd(dailyUsd),
        ...(caps.perDayUsd !== undefined ? { perDayCapUsd: caps.perDayUsd } : {}),
        ...(caps.perTaskUsd !== undefined ? { perTaskCapUsd: caps.perTaskUsd } : {}),
      },
      tasks,
    };
  }

  /** The worker's transcript for one task, tailing as it grows - null for
   * a task id this record home has never heard of. Reuses the same
   * follower `getState` uses, so the two never fall out of step. */
  function getTranscript(taskId: string): TranscriptEntry[] | null {
    if (!discoverTaskIds(recordHome).includes(taskId)) return null;
    return followerFor(taskId).read().transcript;
  }

  return { getState, getTranscript };
}

export type RecordView = ReturnType<typeof createRecordView>;
