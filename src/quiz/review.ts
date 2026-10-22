// The record-wide readers and the two writes the quiz makes: every
// question there is, the Client's own right/wrong mark, and the
// bookkeeping an accept triggers.
//
// Separate from questions.ts because that file works on one task's
// events (which is what the live view, holding one tail reader per task,
// can hand it) while these read the whole record at once - the shape
// `fabrica verdict` and the detached re-check runner need.

import { eventsByTask, stateOf } from "../foreman/index.ts";
import { readEvents, readEventsForTask } from "../record/index.ts";
import { QuizError } from "./errors.ts";
import { appendQuizAnswer } from "./events.ts";
import { outstandingRechecks, quizQuestionsForTask } from "./questions.ts";
import type { QuizQuestion } from "./questions.ts";
import { markQuestionsOutdatedBy } from "./staleness.ts";

/** Every quiz question on the record, newest acceptance first and, within
 * one task, in the order its worker wrote them. Every accepted task's -
 * none is ever dropped for age (the Client's own ruling on this: the
 * questions are already on the record, so the page keeps all of them).
 *
 * Built one task at a time, in reverse record order, then sorted by
 * acceptance alone. Both halves of that matter: `Array.prototype.sort` is
 * stable, so a task's own three questions stay in the order its worker
 * wrote them, and two acceptances that share a millisecond - which
 * `occurredAt` cannot tell apart - still come out newest-first rather
 * than in whichever order the record happened to list them. Adding an
 * index tiebreak to the comparator would be the obvious-looking mistake:
 * it would interleave two same-millisecond tasks' questions by position
 * instead of keeping each task's together. */
export function allQuizQuestions(recordHome: string, now: number = Date.now()): QuizQuestion[] {
  const questions = Array.from(eventsByTask(recordHome))
    .reverse()
    .map(([taskId, events]) => quizQuestionsForTask(taskId, events, now))
    .flat();
  questions.sort((a, b) => b.acceptedAtMs - a.acceptedAtMs);
  return questions;
}

/** How many tasks still owe a re-check. What a caller checks before
 * bothering to spawn the detached runner. */
export function pendingRecheckCount(recordHome: string, now: number = Date.now()): number {
  const byTask = new Map(
    Array.from(eventsByTask(recordHome), ([taskId, events]) => [taskId, quizQuestionsForTask(taskId, events, now)] as const)
  );
  return outstandingRechecks(byTask).length;
}

/**
 * Everything the quiz does when a task is accepted: mark every earlier
 * accepted task's questions that may now be out of date, then report how
 * many tasks are waiting on a re-check so the caller can decide whether
 * to spawn one.
 *
 * Called from the surfaces that record a verdict (`fabrica verdict`, the
 * live view's verdict route) rather than from `recordVerdictDecision`
 * itself - the same layering `src/foreman` already keeps: the Foreman
 * records the ruling, and the quiz, which sits above it and reads its
 * deliveries, keeps its own books. A library caller using
 * `Foreman.verdict` directly therefore marks nothing, exactly as it
 * starts no detached round.
 */
export function onTaskAccepted(
  recordHome: string,
  acceptedTaskId: string,
  now: number = Date.now()
): { marked: string[]; pending: number } {
  const marked = markQuestionsOutdatedBy(recordHome, acceptedTaskId, readEvents(recordHome), now);
  // Re-read: the marks just appended are what makes a task outstanding.
  return { marked, pending: pendingRecheckCount(recordHome, now) };
}

/**
 * Records one right/wrong mark. Refuses a question this record has never
 * held - that is the whole validation, and it is what keeps a phantom
 * mark off an append-only log. A question that went outdated while the
 * Client was looking at it is still marked: he answered the question he
 * was shown, and the mark is about him, not about the question's
 * standing.
 */
export function recordQuizAnswer(recordHome: string, taskId: string, index: number, right: boolean): QuizQuestion {
  if (!Number.isInteger(index) || index < 0) {
    throw new QuizError("no-such-question", `fabrica quiz: "${index}" is not a question number.`);
  }
  const events = readEventsForTask(recordHome, taskId);
  if (events.length === 0) {
    throw new QuizError("no-such-question", `fabrica quiz: no task "${taskId}" in this record.`);
  }
  const question = quizQuestionsForTask(taskId, events, Date.now()).find((candidate) => candidate.index === index);
  if (question === undefined) {
    throw new QuizError(
      "no-such-question",
      `fabrica quiz: task "${taskId}" has no quiz question ${index} to mark - its state is "${stateOf(events)}".`
    );
  }
  if (question.status === "retired") {
    throw new QuizError(
      "retired-question",
      `fabrica quiz: question ${index} of task "${taskId}" was retired by a re-check and is no longer asked.`
    );
  }
  appendQuizAnswer(recordHome, taskId, { index, right });
  // Re-derived so the caller gets the question as it now stands - its new
  // streak and when it comes back - rather than the pre-mark copy.
  return quizQuestionsForTask(taskId, readEventsForTask(recordHome, taskId), Date.now()).find(
    (candidate) => candidate.index === index
  )!;
}
