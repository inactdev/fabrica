// "A question must only be asked while it is still true."
//
// The cheap, record-only half of that: the moment the Client accepts a
// task, every earlier accepted task whose own accepted work touched any
// of the same files has its quiz questions marked "may be outdated" and
// stops being asked. Nothing is judged here - a file in common is a
// reason to suspect a question, not a reason to retire it - and nothing
// here spends money or looks at the project at all. The judging is the
// re-check round's job (recheck.ts), which this only queues up.
//
// Two deliberate limits, both of them the point rather than an oversight:
// this compares file paths, not meaning, so it marks questions that are
// in fact still fine (the re-check confirms those, cheaply), and it
// cannot notice a question that went stale for a reason no accepted task
// explains. Over-marking is the safe direction - a question that may be
// wrong is simply not asked until something has looked.

import type { FabricaEvent } from "../record/index.ts";
import type { Delivery } from "../inspector/types.ts";
import { appendQuizStale } from "./events.ts";
import { quizQuestionsForTask } from "./questions.ts";

/** The files one task's current delivery says it changed
 * (`Delivery.files`). The latest `delivered` event wins and a later
 * Inspector refusal clears it - the same rule `queries.ts`'s `deliveryOf`
 * applies, read off events the caller already holds so marking a whole
 * record's worth of tasks costs one pass, not one file read per task. */
export function deliveredFilesOf(events: FabricaEvent[]): string[] {
  let delivery: Delivery | null = null;
  for (const event of events) {
    if (event.name === "delivered") {
      delivery = (event.details as { delivery?: Delivery } | undefined)?.delivery ?? null;
    } else if (
      event.name === "inspection-finished" &&
      (event.details as { verdict?: string } | undefined)?.verdict === "refused"
    ) {
      delivery = null;
    }
  }
  return Array.isArray(delivery?.files) ? delivery.files.filter((file): file is string => typeof file === "string") : [];
}

/** The paths two deliveries have in common, in the order the earlier
 * task listed them. Exact path equality: a path is the identity git
 * itself uses, and anything looser (a directory prefix, a rename guess)
 * would mark questions on the strength of a resemblance. */
function overlap(theirs: string[], mine: Set<string>): string[] {
  return theirs.filter((file) => mine.has(file));
}

/** One pass over the whole record: each task's own events, and where in
 * the record its latest "accept" verdict landed.
 *
 * Position, not timestamp, for the same reason `questions.ts`'s own
 * history is read by position: `occurredAt` is millisecond ISO, and two
 * accepts can share a millisecond, which would make "accepted earlier"
 * unanswerable exactly when it matters. An accept that a later verdict
 * supersedes is dropped, mirroring `acceptedAtOf` - though rule 6 makes
 * an accept terminal, so that is defensive rather than a real case. */
function readRecord(events: FabricaEvent[]): {
  byTask: Map<string, FabricaEvent[]>;
  acceptedAt: Map<string, number>;
} {
  const byTask = new Map<string, FabricaEvent[]>();
  const acceptedAt = new Map<string, number>();
  for (const [at, event] of events.entries()) {
    const list = byTask.get(event.taskId);
    if (list) list.push(event);
    else byTask.set(event.taskId, [event]);
    if (event.name !== "verdict-recorded") continue;
    if ((event.details as { ruling?: string } | undefined)?.ruling === "accept") acceptedAt.set(event.taskId, at);
    else acceptedAt.delete(event.taskId);
  }
  return { byTask, acceptedAt };
}

/**
 * Marks every earlier accepted task's questions "may be outdated" when
 * the just-accepted task touched one of the same files, and returns the
 * tasks it marked.
 *
 * Takes the whole record as the flat, ordered list the caller already has
 * to read anyway; appends one `quiz-stale` event per affected task (the
 * mark is a fact about the task's work, not about one of its three
 * questions). "Earlier" is strict: a task accepted after this one is
 * never marked by it, since its own questions were written about the
 * project as this change had already left it.
 *
 * A task with nothing live to mark - no quiz, every question already
 * outdated, every question retired - is skipped, so a run of accepts on
 * one shared file does not pile up identical marks. And a trigger that
 * was not itself accepted marks nothing: the whole rule is about
 * accepted work.
 */
export function markQuestionsOutdatedBy(
  recordHome: string,
  acceptedTaskId: string,
  events: FabricaEvent[],
  now: number = Date.now()
): string[] {
  const { byTask, acceptedAt } = readRecord(events);
  const triggerAt = acceptedAt.get(acceptedTaskId);
  if (triggerAt === undefined) return [];
  const touched = new Set(deliveredFilesOf(byTask.get(acceptedTaskId) ?? []));
  if (touched.size === 0) return [];

  const marked: string[] = [];
  for (const [taskId, taskEvents] of byTask) {
    if (taskId === acceptedTaskId) continue;
    const at = acceptedAt.get(taskId);
    if (at === undefined || at > triggerAt) continue;
    // Only questions that are still being asked can stop being asked.
    const live = quizQuestionsForTask(taskId, taskEvents, now).filter((question) => question.status === "live");
    if (live.length === 0) continue;
    const common = overlap(deliveredFilesOf(taskEvents), touched);
    if (common.length === 0) continue;
    appendQuizStale(recordHome, taskId, { touchedBy: acceptedTaskId, files: common });
    marked.push(taskId);
  }
  return marked;
}
